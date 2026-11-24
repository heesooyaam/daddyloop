import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DaddyBoard } from '../../src/client/daddy.js';
import type { Workspace } from '../../src/core/types.js';
async function login(page: Page) {
  await page.goto('/');
  await page
    .getByLabel('Local access token')
    .fill(readFileSync('.daddyloop/e2e/access-token', 'utf8'));
  await page.getByRole('button', { name: 'Connect to workspace' }).click();
  await expect(page.locator('.daddy-app')).toBeVisible();
}
async function create(page: Page, title: string, issue: number) {
  await page.getByRole('button', { name: 'New session', exact: true }).click();
  await page
    .getByLabel('What should daddy do?')
    .fill(`https://github.com/fixture/planning/issues/${issue}`);
  await page.getByLabel('Session name (optional)').fill(title);
  await page.getByRole('button', { name: 'Start session', exact: true }).click();
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  await expect(page.getByText('Your workers share one daddy.', { exact: false })).toBeVisible({
    timeout: 20000,
  });
}
async function sessionFixture(page: Page, title: string) {
  const workspaces = (await (await page.request.get('/api/workspaces')).json()) as Workspace[];
  const workspace = workspaces.find(({ name }) => name === 'Fixture workspace');
  const response = await page.request.post('/api/daddy/sessions', {
    headers: { 'X-daddyloop-Request': '1' },
    data: { workspaceId: workspace?.id, title },
  });
  expect(response.status()).toBe(201);
  return ((await response.json()) as DaddyBoard).group;
}
test('starts from a registered workspace, adds N+1 tickets to daddy and exposes worker reports without a worker chat', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await login(page);
  const issue = Date.now();
  await create(page, 'One daddy, several tasks', issue);
  await expect(page.getByLabel('Maximum workers')).toHaveValue('1');
  await page.getByLabel('Maximum workers').selectOption('2');
  await page
    .getByLabel('Message daddy')
    .fill(`https://github.com/fixture/planning/issues/${issue + 1}`);
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.locator('.daddy-work-item')).toHaveCount(2, { timeout: 20000 });
  await page.locator('.daddy-work-item').first().click();
  await expect(page.getByText('Read-only worker reports', { exact: true })).toBeVisible();
  await expect(page.getByRole('dialog').locator('textarea')).toHaveCount(0);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByLabel('Maximum workers')).toHaveValue('2');
  await expect(
    page.locator('.daddy-pool-hint').filter({ hasText: 'Occupied by tasks: 2' }),
  ).toBeVisible();
  await page.getByLabel('Maximum workers').selectOption('1');
  await expect(
    page.getByText('Pool: 2 → 1. Changes apply in the background.', { exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});
test('uses a one-request repository from a phone and resets the composer without changing workspace defaults', async ({
  page,
}) => {
  await login(page);
  await create(page, 'Per-task workspace', Date.now());
  await page.setViewportSize({ width: 390, height: 844 });
  const fields = page.locator('.daddy-composer .daddy-workspace-fields');
  await fields.getByRole('button', { name: 'Change folder for the next message' }).click();
  const alternate = resolve('.daddyloop/e2e/fixture-repository-alternate');
  await fields.getByLabel('Repository URL or server folder').fill(alternate);
  await fields.getByRole('button', { name: 'Apply settings' }).click();
  await expect(
    fields.getByRole('button', { name: 'Change folder for the next message' }),
  ).toBeVisible();
  const sent = page.waitForResponse(
    (response) => response.url().endsWith('/chat') && response.request().method() === 'POST',
  );
  await page
    .getByLabel('Message daddy')
    .fill(`https://github.com/fixture/planning/issues/${Date.now() + 1}`);
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const response = await sent;
  expect(response.status()).toBe(200);
  const board = await response.json();
  expect(board.messages.at(-1).workspace.repoPath).toBe(alternate);
  expect(board.workspace.repoPath).toBe(resolve('.daddyloop/e2e/fixture-repository'));
  await expect(fields.locator('.daddy-repository-summary code')).toHaveText(
    board.workspace.repoPath,
  );
  await expect(fields.getByText('Only the next message uses this folder.')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('.daddy-mobile-tabs').getByRole('button', { name: /Tasks/ }).click();
  await expect(page.locator('.daddy-work-item')).toHaveCount(2);
});
test('keeps separate conversation drafts when changing daddy sessions', async ({ page }) => {
  await login(page);
  const issue = Date.now();
  await create(page, 'First draft session', issue);
  await page.getByLabel('Message daddy').fill('Keep this unsent idea');
  await create(page, 'Second draft session', issue + 1);
  await page.getByLabel('Message daddy').fill('Another unsent idea');
  await page.locator('.daddy-session').filter({ hasText: 'First draft session' }).click();
  await expect(page.getByLabel('Message daddy')).toHaveValue('Keep this unsent idea');
  await page.locator('.daddy-session').filter({ hasText: 'Second draft session' }).click();
  await expect(page.getByLabel('Message daddy')).toHaveValue('Another unsent idea');
});
test('supports the phone task board, pool controls and workspace directory chooser without horizontal overflow', async ({
  page,
}) => {
  await login(page);
  await create(page, 'Phone session', Date.now());
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.daddy-mobile-tabs').getByRole('button', { name: /Tasks/ }).click();
  await expect(page.getByLabel('Maximum workers')).toBeVisible();
  await page.getByLabel('Maximum workers').selectOption('3');
  await expect(page.getByLabel('Maximum workers')).toHaveValue('3');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Sessions', exact: true }).click();
  await page.getByRole('button', { name: /Workspaces/ }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Edit workspace Fixture workspace' }).click();
  await page.getByRole('button', { name: 'Browse server folders' }).click();
  await expect(page.getByLabel('Server directory')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test('queues a task for a numbered worker and updates that worker’s model from the phone', async ({
  page,
}) => {
  await login(page);
  await create(page, 'Shared task controls', Date.now());
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.daddy-mobile-tabs').getByRole('button', { name: /Tasks/ }).click();
  await page.getByLabel('Maximum workers').selectOption('2');
  await page.getByRole('button', { name: 'Queue task', exact: true }).click();
  const queue = page.getByRole('dialog', { name: 'Queue task' });
  await queue.getByLabel('Task description').fill('Repair the filter cache');
  await queue.getByLabel('Assign to worker').selectOption('2');
  await queue.getByText('Choose a model', { exact: true }).click();
  await queue.getByLabel('Model', { exact: true }).selectOption('gpt-6-astra');
  await queue.getByLabel('Reasoning effort', { exact: true }).selectOption('medium');
  const submitted = page.waitForResponse(
    (response) => response.url().endsWith('/tasks') && response.request().method() === 'POST',
  );
  await queue.getByRole('button', { name: 'Queue task', exact: true }).click();
  const task = await (await submitted).json();
  const report = page.getByRole('dialog', { name: 'Work item' });
  await expect(report.getByRole('heading', { name: 'Repair the filter cache' })).toBeVisible();
  await expect(report.getByText(`DADDY-${task.id.slice(0, 8)}`, { exact: true })).toBeVisible();
  await report.getByRole('button', { name: 'Close', exact: true }).click();

  await page.getByRole('button', { name: 'Workers', exact: true }).click();
  const workers = page.getByRole('dialog', { name: 'Workers' });
  const worker = workers.getByRole('button', { name: 'Configure worker 2' });
  await expect(worker).toContainText('Repair the filter cache');
  await expect(worker).toContainText('gpt-6-astra · medium');
  await worker.click();
  await workers.getByLabel('Model', { exact: true }).selectOption('gpt-5.6-sol');
  await workers.getByLabel('Reasoning effort', { exact: true }).selectOption('max');
  await workers.getByRole('checkbox', { name: /Apply to current task/ }).check();
  const saved = page.waitForRequest(
    (request) => request.url().endsWith('/workers/2') && request.method() === 'POST',
  );
  await workers.getByRole('button', { name: 'Save model', exact: true }).click();
  expect((await saved).postDataJSON()).toMatchObject({ forceTaskId: task.id });
  await expect(worker).toContainText('gpt-5.6-sol · max');
  await expect(worker).toContainText('Repair the filter cache');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test('switches English and Russian in the daddy UI, refreshes model choices and preserves original task text', async ({
  page,
}) => {
  await login(page);
  const issue = Date.now();
  await create(page, 'Language session', issue);
  await page.getByLabel('Language', { exact: true }).selectOption('ru');
  await expect(page.getByRole('button', { name: 'Новая сессия', exact: true })).toBeVisible();
  await expect(page.getByText(`Ticket fixture ${issue}`, { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /Воркспейсы/ })).toBeVisible();
  await page.getByRole('button', { name: 'Настройки сессии' }).click();
  await expect(page.getByLabel('daddy Модель')).toHaveValue('gpt-6-astra');
  await expect(page.getByLabel('Новые воркеры Модель')).toHaveValue('gpt-5.6-sol');
  const refreshed = page.waitForRequest((request) =>
    request.url().includes('/api/agents?refresh=1'),
  );
  await page.getByRole('button', { name: 'Обновить список моделей' }).click();
  await refreshed;
  await page.getByRole('button', { name: 'Закрыть', exact: true }).click();
  await page.getByLabel('Язык', { exact: true }).selectOption('en');
  await expect(page.getByRole('button', { name: 'New session', exact: true })).toBeVisible();
});
test('opens the new chat from the limits page even when a session list is out of date', async ({
  page,
}) => {
  await login(page);
  await create(page, 'Previous session', Date.now());
  const previousUrl = page.url();
  const previousId = new URL(previousUrl).hash.slice(9);
  await page.getByLabel('Message daddy').fill('Keep this draft in the previous session');
  await page.getByRole('link', { name: 'Limits', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Agent limits', exact: true })).toBeVisible();
  const limitsUrl = page.url();
  let listRead!: () => void, releaseList!: () => void;
  const snapshotReady = new Promise<void>((resolve) => {
    listRead = resolve;
  });
  const release = new Promise<void>((resolve) => {
    releaseList = resolve;
  });
  let holdNextList = true;
  await page.route('**/api/daddy/sessions', async (route) => {
    if (!holdNextList || route.request().method() !== 'GET') return route.continue();
    holdNextList = false;
    const response = await route.fetch();
    listRead();
    await release;
    await route.fulfill({ response, headers: { ...response.headers(), 'x-fixture-stale': '1' } });
  });
  await page.getByRole('button', { name: 'New session', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New daddy session' });
  await dialog.getByLabel('Session name (optional)').fill('Created from limits');
  await snapshotReady;
  const created = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/daddy/sessions') && response.request().method() === 'POST',
  );
  const detail = page.waitForRequest(
    (request) =>
      request.method() === 'GET' &&
      new URL(request.url()).pathname.startsWith('/api/daddy/sessions/') &&
      !request.url().endsWith('/' + previousId),
  );
  let id: string;
  try {
    await dialog.getByRole('button', { name: 'Start session', exact: true }).click();
    const response = await created;
    expect(response.status()).toBe(201);
    id = (await response.json()).group.id;
    expect(new URL((await detail).url()).pathname).toBe(`/api/daddy/sessions/${id}`);
    const stale = page.waitForResponse((response) => response.headers()['x-fixture-stale'] === '1');
    releaseList();
    expect((await (await stale).json()).some((session: { id: string }) => session.id === id)).toBe(
      false,
    );
  } finally {
    releaseList();
  }
  await expect(page).toHaveURL((url) => url.pathname === '/' && url.hash === `#session/${id}`);
  await expect(dialog).toBeHidden();
  const newHeading = page.getByRole('heading', { name: 'Created from limits', exact: true });
  await expect(newHeading).toBeVisible();
  const newUrl = page.url();
  await page.getByLabel('Message daddy').fill('Continue the conversation');
  const sent = page.waitForRequest(
    (request) => request.method() === 'POST' && request.url().endsWith('/chat'),
  );
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  expect(new URL((await sent).url()).pathname).toBe(`/api/daddy/sessions/${id}/chat`);
  await page.goBack();
  await expect(page).toHaveURL(limitsUrl);
  await page.goForward();
  await expect(page).toHaveURL(newUrl);
  await expect(newHeading).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(limitsUrl);
  await page.getByRole('link', { name: 'Back to workspace', exact: true }).click();
  await expect(page).toHaveURL(previousUrl);
  await expect(page.getByRole('heading', { name: 'Previous session', exact: true })).toBeVisible();
  await expect(page.getByLabel('Message daddy')).toHaveValue(
    'Keep this draft in the previous session',
  );
});
test('keeps the limits history entry without a session ID when creating the first chat', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 540 });
  let hasSession = false;
  await page.route('**/api/daddy/sessions', async (route) => {
    if (route.request().method() === 'POST') {
      const response = await route.fetch();
      hasSession = response.ok();
      return route.fulfill({ response });
    }
    return hasSession ? route.continue() : route.fulfill({ json: [] });
  });
  await login(page);
  await page.goto('/limits');
  await page.getByRole('button', { name: 'Sessions', exact: true }).click();
  await page.getByRole('button', { name: 'New session', exact: true }).click();
  await page.getByLabel('Session name (optional)').fill('First chat from limits');
  await page.getByRole('button', { name: 'Start session', exact: true }).click();
  const title = page.getByRole('heading', { name: 'First chat from limits', exact: true });
  await expect(title).toBeVisible();
  const chatUrl = page.url();
  await expect(page).toHaveURL(/\/#session\/[a-f0-9-]+$/);
  await page.goBack();
  await expect(page).toHaveURL((url) => url.pathname === '/limits' && !url.hash);
  await page.goForward();
  await expect(page).toHaveURL(chatUrl);
  await expect(title).toBeVisible();
});
for (const open of ['select', 'create'] as const) {
  test(`resolves the original chat from its short limits link after ${open}`, async ({ page }) => {
    await login(page);
    const a = await sessionFixture(page, 'Short limits origin');
    const nextTitle = 'Chat opened from short limits';
    if (open === 'select') await sessionFixture(page, nextTitle);
    const shortLimits = `/limits#session/${a.id.slice(0, 8)}`;
    const aUrl = `/#session/${a.id}`;
    const back = page.getByRole('link', { name: 'Back to workspace', exact: true });
    const message = page.getByLabel('Message daddy');
    await page.goto(shortLimits);
    await back.click();
    await expect(page.getByRole('heading', { name: a.title, exact: true })).toBeVisible();
    await message.fill('Keep my original draft');
    await page.goBack();
    await expect(page).toHaveURL(shortLimits);
    if (open === 'select') {
      await page
        .getByRole('navigation', { name: 'Sessions' })
        .getByRole('button', { name: nextTitle })
        .click();
    } else {
      await page.getByRole('button', { name: 'New session', exact: true }).click();
      await page.getByLabel('Session name (optional)').fill(nextTitle);
      await page.getByRole('button', { name: 'Start session', exact: true }).click();
    }
    await expect(page.getByRole('heading', { name: nextTitle, exact: true })).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(shortLimits);
    await back.click();
    await expect(page).toHaveURL(aUrl);
    await expect(page.getByRole('heading', { name: a.title, exact: true })).toBeVisible();
    await expect(message).toHaveValue('Keep my original draft');
    const sent = page.waitForRequest(
      (request) => request.method() === 'POST' && request.url().endsWith('/chat'),
    );
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    expect(new URL((await sent).url()).pathname).toBe(`/api/daddy/sessions/${a.id}/chat`);
  });
}

for (const save of ['session', 'workspace', 'workspace defaults'] as const) {
  test(`a late ${save} save leaves the conversation and its settings open after Back`, async ({
    page,
  }) => {
    await login(page);
    const a = await sessionFixture(page, 'Chat restored while saving');
    const aUrl = `/?fixture=late-save#session/${a.id}`;
    const alternate = resolve('.daddyloop/e2e/fixture-repository-alternate');
    let endpoint = save === 'session' ? '/api/daddy/sessions' : '/api/workspaces';
    const newName = 'Saved after going back ' + save;
    if (save === 'workspace defaults') {
      const workspace = await page.request.post(endpoint, {
        headers: { 'X-daddyloop-Request': '1' },
        data: { name: 'Workspace to edit', path: alternate },
      });
      expect(workspace.status()).toBe(201);
      endpoint += `/${((await workspace.json()) as Workspace).id}/defaults`;
    }
    await page.goto(aUrl);
    const draft = page.getByLabel('Message daddy');
    await expect(page.getByRole('heading', { name: a.title, exact: true })).toBeVisible();
    await draft.fill('Draft in the restored chat');
    await page.getByRole('link', { name: 'Limits', exact: true }).click();
    await page.getByRole('button', { name: 'New session', exact: true }).click();
    if (save === 'session') {
      await page.getByLabel('Session name (optional)').fill(newName);
    } else {
      await page.getByRole('button', { name: 'Add another workspace', exact: true }).click();
      if (save === 'workspace') {
        await page.getByRole('button', { name: 'Add workspace', exact: true }).click();
        await page.getByLabel('Repository URL or server folder', { exact: true }).fill(alternate);
      } else {
        await page
          .getByRole('button', { name: 'Edit workspace Workspace to edit', exact: true })
          .click();
      }
      await page.getByLabel('Workspace name', { exact: true }).fill(newName);
    }
    let release!: () => void, saved!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const responseReady = new Promise<void>((resolve) => {
      saved = resolve;
    });
    await page.route(`**${endpoint}`, async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      const response = await route.fetch();
      saved();
      await hold;
      await route.fulfill({ response });
    });
    const settings = page.getByRole('dialog', { name: 'Session settings', exact: true });
    try {
      await page
        .getByRole('button', {
          name: save === 'session' ? 'Start session' : 'Save workspace',
          exact: true,
        })
        .click();
      await responseReady;
      await page.goBack();
      await expect(page).toHaveURL(aUrl);
      await expect(draft).toHaveValue('Draft in the restored chat');
      await page.getByRole('button', { name: 'Session settings', exact: true }).click();
      await expect(settings).toBeVisible();

      const detail = page.waitForResponse(
        (response) =>
          response.request().method() === 'GET' &&
          /\/api\/daddy\/sessions\/[a-f0-9-]+$/.test(response.url()),
      );
      const response = page.waitForResponse(
        (response) =>
          response.request().method() === 'POST' && new URL(response.url()).pathname === endpoint,
      );
      release();
      expect((await response).ok()).toBe(true);
      await (await detail).finished();
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      expect(await settings.isVisible()).toBe(true);
      await expect(page).toHaveURL(aUrl);
      await settings.getByRole('button', { name: 'Close', exact: true }).click();
      await expect(draft).toHaveValue('Draft in the restored chat');
      if (save === 'session') {
        await expect(
          page.getByRole('navigation', { name: 'Sessions' }).getByRole('button', { name: newName }),
        ).toBeVisible();
      } else {
        await page.getByRole('button', { name: /^Workspaces/ }).click();
        await expect(
          page.getByRole('button', { name: `Edit workspace ${newName}`, exact: true }),
        ).toBeVisible();
      }
    } finally {
      release();
    }
  });
}

test('shows quota remaining on a phone and requires confirmation before spending one reset', async ({
  page,
}) => {
  await login(page);
  await create(page, 'Limits navigation session', Date.now());
  await page.getByLabel('Message daddy').fill('Keep this draft while checking limits');
  const sessionUrl = page.url();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Sessions', exact: true }).click();
  await page.getByRole('link', { name: 'Limits', exact: true }).click();
  await expect(page).toHaveURL(/\/limits#session\//);
  const main = page.getByRole('main');
  const refreshed = page.waitForResponse('**/api/usage?refresh=1');
  await main.getByRole('button', { name: 'Refresh limits' }).click();
  expect((await refreshed).ok()).toBe(true);
  await expect(main.getByText('7 days: 27% remaining')).toBeVisible();
  await expect(main.getByText('Available resets: 3')).toBeVisible();
  const writes: string[] = [];
  page.on('request', (request) => {
    if (/\/api\/usage\/reset\/[a-f0-9-]{36}$/.test(request.url())) writes.push(request.url());
  });
  await main.getByRole('button', { name: 'Use a reset', exact: true }).click();
  await expect(main.getByRole('button', { name: 'Confirm: use one reset' })).toBeVisible();
  expect(writes).toHaveLength(0);
  await main.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(writes).toHaveLength(0);
  await main.getByRole('button', { name: 'Use a reset', exact: true }).click();
  await main.getByRole('button', { name: 'Confirm: use one reset' }).click();
  await expect(main.getByText('Available resets: 2')).toBeVisible();
  await expect(main.getByText('7 days: 100% remaining')).toBeVisible();
  expect(writes).toHaveLength(1);
  await page.goBack();
  await expect(page).toHaveURL(sessionUrl);
  await expect(page.getByLabel('Message daddy')).toHaveValue(
    'Keep this draft while checking limits',
  );
  await page.goForward();
  await expect(main.getByText('Available resets: 2')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('persists GitHub auto-merge for a session and a single task override', async ({ page }) => {
  await login(page);
  await create(page, 'GitHub auto-merge settings', Date.now());
  await page.getByRole('button', { name: 'Session settings' }).click();
  const dialog = page.getByRole('dialog');
  const sessionSwitch = dialog.getByRole('checkbox', { name: /Auto-merge GitHub PRs/ });
  await expect(sessionSwitch).not.toBeChecked();
  await sessionSwitch.check();
  await dialog.getByRole('button', { name: 'Save settings' }).click();
  await expect(dialog).toHaveCount(0);
  await page.locator('.daddy-work-item').first().click();
  const mode = dialog.getByRole('combobox', { name: 'Auto-merge GitHub PRs' });
  await expect(mode.locator('option:checked')).toHaveText('Use session setting (on)');
  await mode.selectOption('off');
  await expect(mode).toHaveValue('off');
  await page.reload();
  await page.locator('.daddy-work-item').first().click();
  await expect(mode).toHaveValue('off');
  await mode.selectOption('inherit');
  await expect(mode).toHaveValue('inherit');
});

test('changes the host cleanup schedule from the web sidebar', async ({ page }) => {
  await login(page);
  await page.getByRole('button', { name: 'Disk cleanup', exact: true }).click();
  const panel = page.getByRole('dialog');
  await panel.getByLabel('Enable scheduled cleanup').check();
  await panel.getByLabel('Cleanup threshold (%)').fill('89');
  await panel.getByLabel('Check interval (minutes)').fill('45');
  await panel.getByRole('button', { name: 'Save settings' }).click();
  await expect(panel.getByRole('status')).toHaveText('Cleanup settings saved');
  await page.reload();
  await page.getByRole('button', { name: 'Disk cleanup', exact: true }).click();
  await expect(panel.getByLabel('Enable scheduled cleanup')).toBeChecked();
  await expect(panel.getByLabel('Cleanup threshold (%)')).toHaveValue('89');
  await expect(panel.getByLabel('Check interval (minutes)')).toHaveValue('45');
  await panel.getByLabel('Enable scheduled cleanup').uncheck();
  await panel.getByRole('button', { name: 'Save settings' }).click();
  await expect(panel.getByRole('status')).toHaveText('Cleanup settings saved');
});
