import { test, expect, type Locator, type Page } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DaddyBoard } from '../../src/client/daddy.js';
import type { Workspace } from '../../src/core/types.js';
import { translator } from '../../src/i18n/index.js';
import { mockTwoProviders } from './usage-helpers.js';
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
async function openWorkers(page: Page) {
  await page.getByRole('button', { name: /^Workers \d/ }).click();
  return page.getByRole('dialog', { name: 'Workers' });
}
test('starts from a registered workspace, adds N+1 tickets to daddy and exposes worker reports without a worker chat', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await login(page);
  const issue = Date.now();
  await create(page, 'One daddy, several tasks', issue);
  const workers = await openWorkers(page);
  const limit = workers.getByLabel('Maximum workers');
  await expect(limit).toHaveValue('1');
  await limit.selectOption('2');
  await expect(limit).toHaveValue('2');
  await workers.getByRole('button', { name: 'Close', exact: true }).click();
  await page
    .getByLabel('Message daddy')
    .fill(`https://github.com/fixture/planning/issues/${issue + 1}`);
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.locator('.daddy-work-item')).toHaveCount(2, { timeout: 20000 });
  await page.locator('.daddy-work-item').first().click();
  await expect(page.getByText('Read-only worker reports', { exact: true })).toBeVisible();
  await expect(page.getByText('Exact revision', { exact: true })).toBeVisible();
  await expect(page.locator('.daddy-task-version code')).toHaveText(/^[a-f0-9]{40}$/);
  await expect(page.getByText('Generation', { exact: true })).toBeVisible();
  await expect(page.getByRole('dialog').locator('textarea')).toHaveCount(0);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await openWorkers(page);
  await expect(limit).toHaveValue('2');
  await expect(workers.getByRole('status')).toContainText('Occupied by tasks: 2');
  await limit.selectOption('1');
  await expect(
    page.getByText('Pool: 2 → 1. Changes apply in the background.', { exact: true }),
  ).toBeVisible();
  await workers.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByRole('button', { name: /^Workers \d\/2 → 1$/ })).toBeVisible();
  expect(errors).toEqual([]);
});
test('sets a one-message repository in session settings and sends the next message with the default', async ({
  page,
}) => {
  // Keep one interceptor installed while the UI polls. Both sends still reach the
  // fixture; only the delivery of each response to the browser is held.
  let holdChat: Promise<void> | undefined;
  await page.route('**/api/daddy/sessions/*/chat', async (route) => {
    const hold = holdChat;
    if (!hold) return route.continue();
    const response = await route.fetch();
    await hold;
    await route.fulfill({ response });
  });
  await login(page);
  await create(page, 'Per-task workspace', Date.now());
  await page.setViewportSize({ width: 390, height: 844 });
  const source = resolve('.daddyloop/e2e/fixture-repository');
  const alternate = resolve('.daddyloop/e2e/fixture-repository-alternate');
  const settings = page.getByRole('dialog', { name: 'Session settings' });
  const changeFolder = settings.getByRole('button', { name: 'Change folder for the next message' });
  const close = settings.getByRole('button', { name: 'Close', exact: true });
  const cancel = settings.getByRole('button', { name: 'Cancel', exact: true });
  const save = settings.getByRole('button', { name: 'Save settings', exact: true });
  const override = page.getByRole('button', { name: 'Repository override for the next message' });
  await expect(page.getByText('Workspace source', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Session settings' }).click();
  await expect(settings.getByText(source, { exact: true })).toBeVisible();
  await changeFolder.click();
  await settings.getByLabel('Repository URL or server folder').fill(alternate);
  let releasePreview!: () => void;
  const pendingPreview = new Promise<void>((resolve) => {
    releasePreview = resolve;
  });
  let onChecked!: (ok: boolean) => void;
  const checkedPreview = new Promise<boolean>((resolve) => {
    onChecked = resolve;
  });
  await page.route(
    '**/api/workspaces/preview',
    async (route) => {
      const response = await route.fetch();
      onChecked(response.ok());
      await pendingPreview;
      await route.fulfill({ response });
    },
    { times: 1 },
  );
  try {
    await settings.getByRole('button', { name: 'Apply settings' }).click();
    expect(await checkedPreview).toBe(true);
    await expect(save).toBeDisabled();
    await expect(close).toBeDisabled();
    await expect(cancel).toBeEnabled();
    await page.keyboard.press('Escape');
    await expect(settings).toBeVisible();
    await page.locator('.daddy-overlay').click({ position: { x: 2, y: 2 } });
    await expect(settings).toBeVisible();
  } finally {
    releasePreview();
  }
  await expect(settings.getByText(alternate, { exact: true })).toBeVisible();
  await expect(settings.getByText(source, { exact: true })).toBeVisible();
  await expect(close).toBeEnabled();
  await expect(save).toBeEnabled();
  await changeFolder.click();
  await expect(save).toBeDisabled();
  await cancel.click();
  await expect(save).toBeEnabled();
  await save.click();
  await expect(settings).toHaveCount(0);
  await expect(override).toBeVisible();

  const headerSettings = page.getByRole('button', { name: 'Session settings', exact: true });
  const assertSettingsBlockedDuringSend = async (
    send: () => Promise<void>,
    hasOverride: boolean,
  ) => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    holdChat = pending;
    const request = page.waitForRequest('**/api/daddy/sessions/*/chat');
    try {
      await send();
      await request;
      await expect(headerSettings).toBeDisabled();
      if (hasOverride) await expect(override).toBeDisabled();
      await expect(settings).toHaveCount(0);
    } finally {
      release();
      holdChat = undefined;
    }
  };
  const sent = page.waitForResponse(
    (response) => response.url().endsWith('/chat') && response.request().method() === 'POST',
  );
  const message = page.getByLabel('Message daddy');
  await message.fill(`https://github.com/fixture/planning/issues/${Date.now() + 1}`);
  await assertSettingsBlockedDuringSend(
    () => page.getByRole('button', { name: 'Send message', exact: true }).click(),
    true,
  );
  const response = await sent;
  expect(response.status()).toBe(200);
  expect(response.request().postDataJSON()).toMatchObject({ repository: { path: alternate } });
  const board = await response.json();
  expect(board.messages.at(-1).workspace.repoPath).toBe(alternate);
  expect(board.workspace.repoPath).toBe(source);
  await expect(override).toHaveCount(0);
  await expect(message).toHaveValue('');

  await page.getByRole('button', { name: 'Session settings' }).click();
  await expect(settings.getByText(source, { exact: true })).toBeVisible();
  await expect(settings.getByText(alternate, { exact: true })).toHaveCount(0);
  await settings.getByRole('button', { name: 'Close', exact: true }).click();

  const sentWithDefault = page.waitForResponse(
    (response) => response.url().endsWith('/chat') && response.request().method() === 'POST',
  );
  await message.fill(`https://github.com/fixture/planning/issues/${Date.now() + 1}`);
  await assertSettingsBlockedDuringSend(() => message.press('Enter'), false);
  const defaultResponse = await sentWithDefault;
  expect(defaultResponse.status()).toBe(200);
  expect(defaultResponse.request().postDataJSON()).not.toHaveProperty('repository');
  const defaultBoard = await defaultResponse.json();
  expect(defaultBoard.messages.at(-1).workspace.repoPath).toBe(source);
  expect(defaultBoard.workspace.repoPath).toBe(source);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('.daddy-mobile-tabs').getByRole('button', { name: /Tasks/ }).click();
  await expect(page.locator('.daddy-work-item')).toHaveCount(3, { timeout: 20000 });
});
test('restores focus when resetting the one-message repository removes the settings opener', async ({
  page,
}) => {
  await login(page);
  await create(page, 'Repository focus fixture', Date.now());
  const headerSettings = page.getByRole('button', { name: 'Session settings', exact: true });
  const settings = page.getByRole('dialog', { name: 'Session settings' });
  const override = page.getByRole('button', { name: 'Repository override for the next message' });
  const message = page.getByLabel('Message daddy');
  for (const paused of [false, true]) {
    if (paused) {
      await page.getByRole('button', { name: 'Pause', exact: true }).click();
      await expect(message).toBeDisabled();
    }
    await headerSettings.click();
    await settings.getByRole('button', { name: 'Change folder for the next message' }).click();
    await settings
      .getByLabel('Repository URL or server folder')
      .fill(resolve('.daddyloop/e2e/fixture-repository-alternate'));
    await settings.getByRole('button', { name: 'Apply settings' }).click();
    await expect(settings.getByRole('button', { name: 'Use workspace defaults' })).toBeVisible();
    await settings.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(headerSettings).toBeFocused();

    await override.press('Enter');
    await page.keyboard.press('Escape');
    await expect(override).toBeFocused();

    await override.press('Enter');
    await settings.getByRole('button', { name: 'Use workspace defaults' }).click();
    await expect(override).toHaveCount(0);
    if (paused) await page.locator('.daddy-overlay').click({ position: { x: 2, y: 2 } });
    else await page.keyboard.press('Escape');
    await expect(settings).toHaveCount(0);
    await expect(paused ? headerSettings : message).toBeFocused();
  }
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
test('renames an existing session from web settings and keeps it after reload', async ({
  page,
}) => {
  await login(page);
  await create(page, 'Rename this session', Date.now());
  await page.getByRole('button', { name: 'Session settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'Session settings' });
  await dialog.getByLabel('Session name').fill('Renamed from the web');
  await dialog.getByRole('button', { name: 'Save settings' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Renamed from the web' })).toBeVisible();
  await expect(page.locator('.daddy-session-list').getByText('Renamed from the web')).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Renamed from the web' })).toBeVisible();
});
test('saves only fields changed in an open session settings form', async ({ page }) => {
  await login(page);
  const initialTitle = 'Concurrent session settings';
  await create(page, initialTitle, Date.now());
  const sessions = (await (await page.request.get('/api/daddy/sessions')).json()) as {
    id: string;
    title: string;
  }[];
  const id = sessions.find((session) => session.title === initialTitle)!.id;
  await page.getByRole('button', { name: 'Session settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Session settings' }),
    name = dialog.getByLabel('Session name');
  await expect(name).toHaveValue(initialTitle);
  await name.fill('Temporary local name');
  await name.fill(initialTitle);

  const renamed = await page.request.post(`/api/daddy/sessions/${id}/rename`, {
    headers: { 'X-daddyloop-Request': '1' },
    data: { title: 'Renamed by another client' },
  });
  expect(renamed.status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'Renamed by another client' })).toBeVisible({
    timeout: 5000,
  });
  await expect(name).toHaveValue(initialTitle);
  await dialog.getByRole('button', { name: 'Save settings' }).click();
  await expect(dialog).toHaveCount(0);
  let board = (await (await page.request.get(`/api/daddy/sessions/${id}`)).json()) as DaddyBoard;
  expect(board.group.title).toBe('Renamed by another client');

  await page.getByRole('button', { name: 'Session settings', exact: true }).click();
  const instructions = await page.request.post(`/api/daddy/sessions/${id}/settings`, {
    headers: { 'X-daddyloop-Request': '1' },
    data: {
      instructions: {
        daddy: { prompt: 'Instructions from another client' },
        worker: {
          skills: [
            {
              name: 'Concurrent skill',
              text: '# Concurrent skill',
              checksum: createHash('sha256').update('# Concurrent skill').digest('hex'),
              source: { kind: 'text' },
            },
          ],
        },
      },
    },
  });
  expect(instructions.status()).toBe(200);
  await page.waitForTimeout(2200);
  await dialog.getByLabel('Session name').fill('Only the local name changed');
  await dialog.getByText('Style and skills for this session').click();
  await dialog.getByRole('button', { name: 'All workers', exact: true }).click();
  await dialog
    .getByLabel('Your instructions for workers')
    .fill('Worker instructions from this form');
  await dialog.getByRole('button', { name: 'Save settings' }).click();
  await expect(dialog).toHaveCount(0);
  board = (await (await page.request.get(`/api/daddy/sessions/${id}`)).json()) as DaddyBoard;
  expect(board.group.title).toBe('Only the local name changed');
  expect(board.group.instructions?.daddy.prompt).toBe('Instructions from another client');
  expect(board.group.instructions?.worker.prompt).toBe('Worker instructions from this form');
  expect(board.group.instructions?.worker.skills?.[0].name).toBe('Concurrent skill');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Only the local name changed' })).toBeVisible();
});
test('keeps the settings draft and rejects a conflicting instruction element', async ({ page }) => {
  await login(page);
  const title = `Conflicting settings ${Date.now()}`;
  await create(page, title, Date.now());
  const sessions = (await (await page.request.get('/api/daddy/sessions')).json()) as {
    id: string;
    title: string;
  }[];
  const id = sessions.find((session) => session.title === title)!.id;
  await page.getByRole('button', { name: 'Session settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Session settings' });
  await dialog.getByText('Style and skills for this session').click();
  const prompt = dialog.getByLabel('Your instructions for daddy');
  await prompt.fill('Local conflicting prompt');
  const remote = await page.request.post(`/api/daddy/sessions/${id}/settings`, {
    headers: { 'X-daddyloop-Request': '1' },
    data: {
      instructions: {
        daddy: { prompt: 'Remote conflicting prompt' },
        worker: {},
      },
    },
  });
  expect(remote.status()).toBe(200);
  await dialog.getByRole('button', { name: 'Save settings' }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('alert')).toContainText('changed in another client');
  await expect(prompt).toHaveValue('Local conflicting prompt');
  const board = (await (await page.request.get(`/api/daddy/sessions/${id}`)).json()) as DaddyBoard;
  expect(board.group.instructions?.daddy.prompt).toBe('Remote conflicting prompt');
});
test('omits an unavailable effort and can keep engine model defaults', async ({ page }) => {
  await page.route('**/api/agents*', async (route) => {
    await route.fulfill({
      json: {
        engines: [
          { id: 'codex', name: 'Codex' },
          { id: 'claude', name: 'Claude' },
        ],
        models: [
          {
            id: 'claude-no-effort',
            engine: 'claude',
            name: 'Claude without effort',
            efforts: [],
            defaultEffort: '',
            isDefault: true,
          },
        ],
      },
    });
  });
  await login(page);
  await create(page, 'Model without effort', Date.now());
  const sessions = (await (await page.request.get('/api/daddy/sessions')).json()) as {
    id: string;
    title: string;
  }[];
  const id = sessions.find((session) => session.title === 'Model without effort')!.id;
  let board = (await (await page.request.get(`/api/daddy/sessions/${id}`)).json()) as DaddyBoard;
  const payloads: any[] = [];
  await page.route(`**/api/daddy/sessions/${id}/settings`, async (route) => {
    const payload = route.request().postDataJSON();
    payloads.push(payload);
    if (payload.profiles?.daddy) board.group.daddy = payload.profiles.daddy;
    await route.fulfill({ json: board });
  });

  const open = async () => {
    await page.getByRole('button', { name: 'Session settings', exact: true }).click();
    return page.getByRole('dialog', { name: 'Session settings' });
  };
  let dialog = await open();
  await dialog.getByLabel('daddy Agent module').selectOption('claude');
  await dialog.getByLabel('daddy Model').selectOption('claude-no-effort');
  await dialog.getByRole('button', { name: 'Save settings' }).click();
  await expect(dialog).toHaveCount(0);
  expect(payloads[0].profiles.daddy).toEqual({
    engine: 'claude',
    model: 'claude-no-effort',
  });

  dialog = await open();
  await dialog.getByLabel('daddy Agent module').selectOption('claude');
  await dialog.getByLabel('daddy Model').selectOption('claude-no-effort');
  await dialog.getByLabel('daddy Model').selectOption('');
  await dialog.getByRole('button', { name: 'Save settings' }).click();
  await expect(dialog).toHaveCount(0);
  expect(payloads[1].profiles.daddy).toEqual({ engine: 'claude' });
});
test('Escape in the folder browser returns to the session settings draft', async ({ page }) => {
  await login(page);
  await create(page, 'Folder browser keyboard fixture', Date.now());
  await page.setViewportSize({ width: 320, height: 540 });
  await page.getByRole('button', { name: 'Session settings' }).click();
  const settings = page.getByRole('dialog', { name: 'Session settings' });
  const autoMerge = settings.getByRole('checkbox', { name: /Auto-merge GitHub PRs/ });
  await autoMerge.check();
  await settings.getByRole('button', { name: 'Change folder for the next message' }).click();
  const path = settings.getByLabel('Repository URL or server folder');
  const draft = resolve('.daddyloop/e2e/fixture-repository-alternate');
  await path.fill(draft);
  const browse = settings.getByRole('button', { name: 'Browse server folders' });
  const browser = settings.getByRole('region', { name: 'Choose a folder on this server' });
  const expectSettingsDraft = async () => {
    await expect(browser).toHaveCount(0);
    await expect(settings).toBeVisible();
    await expect(path).toBeFocused();
    await expect(path).toHaveValue(draft);
    await expect(autoMerge).toBeChecked();
  };

  const cancelWhileLoading = async (trigger: Locator) => {
    const address = /\/api\/workspaces\/directories\?path=/;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(
      address,
      async (route) => {
        await pending;
        await route.continue().catch(() => {});
      },
      { times: 1 },
    );
    try {
      const requested = page.waitForRequest(address);
      await trigger.press('Enter');
      await requested;
      await expect(browser.getByRole('status')).toBeVisible();
      await page.keyboard.press('Escape');
      await expectSettingsDraft();
    } finally {
      release();
    }
  };
  await cancelWhileLoading(browse);
  await browse.press('Enter');
  await cancelWhileLoading(browser.getByRole('button', { name: 'Open folder src', exact: true }));

  for (const name of ['Open folder src', 'Parent folder', 'All server folders', 'Open folder']) {
    await test.step(name, async () => {
      await browse.press('Enter');
      await expect(browser.getByRole('button', { name: 'Select this folder' })).toBeEnabled();
      const directory = browser.getByLabel('Server directory');
      if (name === 'Open folder') await directory.fill(`${draft}/missing`);
      const read = page.waitForResponse(/\/api\/workspaces\/directories(?:\?|$)/);
      await browser.getByRole('button', { name, exact: true }).press('Enter');
      expect((await read).ok()).toBe(name !== 'Open folder');
      await expect(directory).toBeFocused();
      await page.keyboard.press('Escape');
      await expectSettingsDraft();
    });
  }
  await page.keyboard.press('Escape');
  await expect(settings).toHaveCount(0);
});
test('collapses each side panel independently and keeps the current conversation accessible on a phone', async ({
  page,
}) => {
  const desktop = { width: 1280, height: 900 };
  await page.setViewportSize(desktop);
  await login(page);
  const issue = Date.now();
  await create(page, 'Panel layout session', issue);
  await create(page, 'Another panel layout session', issue + 1);

  const sessions = page.getByRole('navigation', { name: 'Sessions' });
  const session = sessions.getByRole('button', { name: /^Panel layout session/ });
  const workers = page.locator('#daddy-tasks-panel');
  const chat = page.getByRole('region', { name: 'Conversation with daddy' });
  const composer = chat.getByLabel('Message daddy');
  await session.click();
  await expect(
    page.getByRole('heading', { name: 'Panel layout session', exact: true }),
  ).toBeVisible();
  const selectedUrl = page.url();
  const draft = 'Keep this message while switching panels';
  await composer.fill(draft);

  const checkConversation = async () => {
    await expect(page).toHaveURL(selectedUrl);
    await expect(composer).toBeVisible();
    await expect(composer).toHaveValue(draft);
  };
  const chatWidth = () => chat.evaluate((element) => element.getBoundingClientRect().width);
  const initialWidth = await chatWidth();
  const hideSessions = page.getByRole('button', { name: 'Hide sessions panel' });
  const showSessions = page.getByRole('button', { name: 'Show sessions panel' });
  const hideTasks = page.getByRole('button', { name: 'Hide workers and tasks panel' });
  const showTasks = page.getByRole('button', { name: 'Show workers and tasks panel' });
  const openSessions = page.getByRole('button', { name: 'Sessions', exact: true });
  const sidebarId = await page.locator('.daddy-sidebar').getAttribute('id');
  expect(sidebarId).toBeTruthy();
  expect(await hideSessions.getAttribute('aria-controls')).toBe(sidebarId);
  const openSessionsWithKeyboard = async () => {
    expect(await openSessions.getAttribute('aria-controls')).toBe(sidebarId);
    const first = page.getByRole('button', { name: 'New session', exact: true });
    const last = page.getByRole('combobox', { name: 'Language', exact: true });
    await openSessions.press('Enter');
    await expect(first).toBeFocused();
    await expect(page.locator('.daddy-main')).toHaveAttribute('inert', '');
    await page.keyboard.press('Shift+Tab');
    await expect(last).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(first).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(openSessions).toBeFocused();
    await page.keyboard.press('Enter');
  };
  const openLastTaskReport = async () => {
    const cards = workers.locator('.daddy-work-item');
    await expect(cards.first()).toBeVisible();
    const last = cards.last();
    const title = await last.locator('.daddy-work-heading strong').innerText();
    await last.click({ timeout: 5000 });
    const report = page.getByRole('dialog', { name: 'Work item' });
    await expect(report.getByRole('heading', { name: title, exact: true })).toBeVisible();
    await report.getByRole('button', { name: 'Close', exact: true }).click();
  };

  await hideSessions.press('Enter');
  await expect(sessions).toBeHidden();
  await expect(workers).toBeVisible();
  await expect(showSessions).toBeFocused();
  await expect(showSessions).toHaveAttribute('aria-expanded', 'false');
  await checkConversation();
  const leftCollapsedWidth = await chatWidth();
  expect(leftCollapsedWidth).toBeGreaterThan(initialWidth);

  await hideTasks.click();
  await expect(sessions).toBeHidden();
  await expect(workers).toBeHidden();
  await expect(showSessions).toBeVisible();
  await expect(showTasks).toBeVisible();
  await expect(showTasks).toHaveAttribute('aria-expanded', 'false');
  await checkConversation();
  const bothCollapsedWidth = await chatWidth();
  expect(bothCollapsedWidth).toBeGreaterThan(leftCollapsedWidth);

  const indicator = page.getByRole('button', { name: 'Agent limits', exact: true });
  const openLimits = async () => {
    await indicator.click();
    const details = page.getByRole('region', { name: 'Agent limit details' });
    await expect(details.getByRole('heading', { name: 'Codex' })).toBeVisible();
    await details.getByRole('link', { name: 'Open limits page' }).click();
    await expect(page.getByRole('heading', { name: 'Agent limits', exact: true })).toBeVisible();
  };
  const returnToChat = async () => {
    await page.getByRole('link', { name: 'Back to workspace', exact: true }).click();
    await checkConversation();
  };
  await openLimits();
  await showSessions.click();
  await expect(sessions).toBeVisible();
  await hideSessions.click();
  await returnToChat();
  await expect(sessions).toBeHidden();
  await expect(workers).toBeHidden();

  await page.setViewportSize({ width: 844, height: 390 });
  await expect(sessions).toBeHidden();
  await showTasks.click();
  await expect(workers).toBeVisible();
  await openSessionsWithKeyboard();
  await sessions
    .getByRole('button', { name: /^Another panel layout session/ })
    .click({ timeout: 5000 });
  await expect(
    page.getByRole('heading', { name: 'Another panel layout session', exact: true }),
  ).toBeVisible();
  await openLastTaskReport();
  await hideTasks.click();
  await expect(workers).toBeHidden();

  await page.setViewportSize({ width: 390, height: 540 });
  await expect(sessions).toBeHidden();
  await openSessionsWithKeyboard();
  await expect(sessions).toBeVisible();
  await session.click();
  await expect(sessions).toBeHidden();
  const tabs = page.locator('.daddy-mobile-tabs');
  await tabs.getByRole('button', { name: /Tasks/ }).click();
  await expect(workers).toBeVisible();
  await openLastTaskReport();
  await expect(chat).toBeHidden();
  await tabs.getByRole('button', { name: 'daddy' }).click();
  await checkConversation();
  await openLimits();
  await openSessions.press('Enter');
  await expect(sessions).toBeVisible();
  await page.keyboard.press('Escape');
  await returnToChat();
  const mainWidth = () => page.locator('.daddy-main').evaluate((element) => element.clientWidth);
  await page.setViewportSize({ width: 568, height: 320 });
  await expect.poll(chatWidth).toBe(await mainWidth());
  await tabs.getByRole('button', { name: /Tasks/ }).click();
  await expect(workers.locator('.daddy-work-item').first()).toBeInViewport({ ratio: 1 });

  await page.setViewportSize({ width: 1024, height: 480 });
  await expect(workers).toBeHidden();
  await expect.poll(chatWidth).toBe(await mainWidth());
  await checkConversation();

  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  await page.setViewportSize(desktop);
  await expect(sessions).toBeHidden();
  await expect(workers).toBeHidden();
  await showSessions.click();
  await expect(sessions).toBeVisible();
  await expect(workers).toBeHidden();
  await expect(hideSessions).toHaveAttribute('aria-expanded', 'true');
  await checkConversation();
  const rightCollapsedWidth = await chatWidth();
  expect(rightCollapsedWidth).toBeGreaterThan(initialWidth);
  expect(rightCollapsedWidth).toBeLessThan(bothCollapsedWidth);

  await showTasks.click();
  await expect(workers).toBeVisible();
  await expect(hideTasks).toHaveAttribute('aria-expanded', 'true');
  await checkConversation();
  expect(await chatWidth()).toBe(initialWidth);

  await page.getByRole('combobox', { name: 'Language' }).selectOption('ru');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
  const t = translator('ru');
  await page.addStyleTag({ content: ':root { font-size: 20px; }' });
  await page.setViewportSize({ width: 851, height: 480 });
  await page.getByRole('button', { name: t('Pause'), exact: true }).click();
  await expect(page.getByRole('button', { name: t('Resume'), exact: true })).toBeInViewport();
  const title = page.getByRole('heading', { name: 'Panel layout session', exact: true });
  await expect.poll(() => title.evaluate((element) => element.clientWidth)).toBeGreaterThan(120);
  await expect(
    page.getByRole('button', { name: t('Session settings'), exact: true }),
  ).toBeInViewport();
  await expect(
    page.getByRole('button', { name: t('Hide workers and tasks panel') }),
  ).toBeInViewport();
  await expect(page.getByRole('button', { name: t('Hide sessions panel') })).toBeInViewport();
  await page.locator('.daddy-language select').selectOption('en');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
});
test('supports the phone task board, pool controls and workspace directory chooser without horizontal overflow', async ({
  page,
}) => {
  await login(page);
  await create(page, 'Phone session', Date.now());
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.daddy-mobile-tabs').getByRole('button', { name: /Tasks/ }).click();
  const workers = await openWorkers(page);
  const limit = workers.getByLabel('Maximum workers');
  await limit.selectOption('3');
  await expect(limit).toHaveValue('3');
  await workers.getByRole('button', { name: 'Close', exact: true }).click();
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
  const workers = await openWorkers(page);
  const limit = workers.getByLabel('Maximum workers');
  await limit.selectOption('2');
  await expect(limit).toHaveValue('2');
  await workers.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Queue a task', exact: true }).click();
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

  await openWorkers(page);
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
test('shows a full card on short screens and keeps actions available in a dense task list', async ({
  page,
}) => {
  await login(page);
  await create(page, 'Dense task board', Date.now());
  const sessionId = new URL(page.url()).hash.slice('#session/'.length);
  const longTitle =
    'Rebuild the response cache for imported records with missing workspace metadata';
  const taskIds: string[] = [];
  for (let index = 1; index <= 10; index++) {
    const response = await page.request.post(`/api/daddy/sessions/${sessionId}/tasks`, {
      headers: { 'X-daddyloop-Request': '1' },
      data: { requirements: `${index}. ${longTitle}`, requestId: randomUUID() },
    });
    expect(response.status()).toBe(201);
    const { id } = await response.json();
    taskIds.push(id);
  }
  const path = `/test-workspaces${'/long-working-copy-directory'.repeat(9)}/session`;
  let constrained = false;
  let copyFailed = false;
  let deletionFailed = false;
  let visibleTaskCount: number | undefined;
  const copyFailure = 'The session copy could not be written';
  const longStatus = 'Waiting for GitHub to confirm the previous merge request';
  await page.route(`**/api/daddy/sessions/${sessionId}`, async (route) => {
    const response = await route.fetch();
    const board: DaddyBoard = await response.json();
    const prerequisite = board.tasks.find((task) => !taskIds.includes(task.id))!;
    const tasks = taskIds.map((id) => ({
      ...board.tasks.find((task) => task.id === id)!,
      dependsOn: [prerequisite.id],
      ...(constrained || deletionFailed ? { statusLabel: longStatus } : {}),
    }));
    const ordered = [...tasks.slice(0, -1), prerequisite, tasks.at(-1)!];
    const visibleTasks =
      visibleTaskCount === undefined
        ? ordered
        : Array.from({ length: visibleTaskCount }, (_, index) => {
            const task = ordered[index % ordered.length]!;
            return index < ordered.length ? task : { ...task, id: task.id + '-extra-' + index };
          });
    await route.fulfill({
      response,
      json: {
        ...board,
        workers: copyFailed
          ? { ...board.workers, active: 7, limit: 8, target: 3, pending: true }
          : board.workers,
        group: {
          ...board.group,
          ...(deletionFailed ? { deletion: { state: 'error', error: copyFailure } } : {}),
          workspacePreparation: copyFailed
            ? { state: 'error', error: copyFailure }
            : { state: 'ready', path },
          ...(constrained
            ? {
                resourceWait: {
                  state: 'waiting',
                  since: new Date().toISOString(),
                  reasons: ['Not enough available RAM', 'Disk-space threshold reached'],
                },
              }
            : {}),
        },
        tasks: visibleTasks,
        taskQueue: [],
      } satisfies DaddyBoard,
    });
  });
  await mockTwoProviders(page);

  const list = page.locator('.daddy-work-items');
  const cards = list.getByRole('button');
  const fullTitle = `1. ${longTitle}`;
  const queue = page.getByRole('button', { name: 'Queue a task', exact: true });
  await expect(page.getByRole('button', { name: 'Agent limits', exact: true })).toBeVisible();
  for (const viewport of [
    { width: 1024, height: 480 },
    { width: 390, height: 540 },
  ]) {
    await page.setViewportSize(viewport);
    if (viewport.width === 390) {
      await page.locator('.daddy-mobile-tabs').getByRole('button', { name: /Tasks/ }).click();
    }
    await expect(cards).toHaveCount(11);
    await expect(cards.first()).toHaveAttribute('title', fullTitle);
    await expect(cards.first()).toContainText('Prerequisites: 1');
    await expect(cards.last()).toHaveAttribute('title', `10. ${longTitle}`);
    await expect(cards.last()).toContainText('Prerequisites: 1');
    await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBe(0);
    await expect(cards.first()).toBeInViewport({ ratio: 1 });
    await expect(cards.first().locator('.daddy-work-state')).not.toBeEmpty();
    await expect(cards.last()).not.toBeInViewport();

    await list.hover();
    await page.mouse.wheel(0, 1400);
    await expect(cards.last()).toBeInViewport({ ratio: 1 });
    await expect(queue).toBeInViewport({ ratio: 1 });
    expect(await list.evaluate((element) => element.scrollWidth === element.clientWidth)).toBe(
      true,
    );
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );

    await queue.click();
    const dialog = page.getByRole('dialog', { name: 'Queue task' });
    await expect(dialog.getByLabel('Task description')).toBeFocused();
    await page.keyboard.press('Escape');

    const longCard = cards.first();
    await longCard.scrollIntoViewIfNeeded();
    await expect(longCard.locator('strong')).toBeInViewport({ ratio: 1 });
    await expect(longCard.locator('.daddy-work-state')).toBeInViewport({ ratio: 1 });
    await longCard.locator('.daddy-work-heading svg').click();
    const report = page.getByRole('dialog', { name: 'Work item' });
    await expect(report.getByRole('heading', { name: fullTitle, exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await list.evaluate((element) => (element.scrollTop = 0));
  }

  const zoom = await page.addStyleTag({ content: ':root { font-size: 20px; }' });
  const first = cards.first();
  const title = first.locator('.daddy-work-heading strong');
  await expect(title).toHaveCSS('font-size', '17.5px');
  await expect(title).toHaveCSS('line-height', '24.5px');
  await expect(title).toHaveCSS('-webkit-line-clamp', '2');
  await expect(first.locator('.daddy-work-state')).toHaveCSS('font-size', '15px');
  await expect(first).toBeInViewport({ ratio: 1 });

  await list.hover();
  await page.mouse.wheel(0, 1800);
  await expect(cards.last()).toBeInViewport({ ratio: 1 });
  await zoom.evaluate((node) => {
    node.parentNode?.removeChild(node);
  });
  constrained = true;
  await expect(first.locator('.daddy-work-state')).toHaveText(longStatus);
  const indicator = page.getByRole('button', { name: 'Agent limits', exact: true });
  for (const viewport of [
    { width: 568, height: 320 },
    { width: 640, height: 360 },
    { width: 667, height: 375 },
    { width: 700, height: 375 },
    { width: 844, height: 390 },
    { width: 1024, height: 480 },
    { width: 320, height: 540 },
  ]) {
    await page.setViewportSize(viewport);
    await list.evaluate((element) => (element.scrollTop = 0));
    await page.locator('.daddy-main').evaluate((element) => (element.scrollTop = 0));
    await expect(first).toBeInViewport({ ratio: 1 });
    await expect(indicator).toBeInViewport({ ratio: 1 });
  }
  await indicator.click();
  await expect(
    page
      .getByRole('region', { name: 'Agent limit details' })
      .getByRole('heading', { name: 'Claude', exact: true }),
  ).toBeVisible();
  await page.getByRole('link', { name: 'Open limits page', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Agent limits', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Back to workspace', exact: true }).click();
  await page.locator('.daddy-mobile-tabs').getByRole('button', { name: 'daddy' }).click();
  await indicator.click();
  await expect(
    page
      .getByRole('region', { name: 'Agent limit details' })
      .getByRole('heading', { name: 'Claude', exact: true }),
  ).toBeVisible();
  await page.getByRole('link', { name: 'Open limits page', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Agent limits', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Back to workspace', exact: true }).click();

  copyFailed = true;
  const sendDiagnostic =
    'ENOENT: no such file or directory, chdir /' + 'unavailable-folder/'.repeat(12);
  await page.route('**/api/daddy/sessions/*/chat', (route) =>
    route.fulfill({
      status: 503,
      json: { error: { code: 'unavailable', message: sendDiagnostic } },
    }),
  );
  const composer = page.getByLabel('Message daddy');
  await composer.fill('Keep this draft');
  await composer.press('Enter');
  const notices = page.getByRole('region', { name: 'Session status' });
  const failedCopy = notices
    .getByRole('alert')
    .filter({ hasText: 'Could not prepare the session copy' });
  await expect(failedCopy).toBeVisible();
  await expect(notices.getByText('Request failed', { exact: true })).toBeVisible();
  await page.addStyleTag({ content: ':root { font-size: 20px; }' });
  await page.locator('.daddy-mobile-tabs').getByRole('button', { name: /Tasks/ }).click();
  await page.locator('.daddy-main').evaluate((element) => (element.scrollTop = 0));
  await expect(first).toBeInViewport({ ratio: 1 });
  await expect(notices.getByText('Waiting for server resources')).toBeInViewport({ ratio: 1 });
  for (const retry of await notices.getByRole('button', { name: 'Retry', exact: true }).all()) {
    await expect(retry).toBeInViewport({ ratio: 1 });
    await expect(retry).toBeEnabled();
  }
  await failedCopy.getByRole('button', { name: 'View details' }).click();
  await expect(page.getByRole('dialog').getByText(copyFailure)).toBeInViewport({ ratio: 1 });
  await page.keyboard.press('Escape');
  for (const viewport of [
    { width: 375, height: 320 },
    { width: 360, height: 360 },
    { width: 375, height: 375 },
    { width: 375, height: 376 },
    { width: 359, height: 320 },
    { width: 320, height: 320 },
    { width: 389, height: 375 },
    { width: 480, height: 320 },
    { width: 500, height: 320 },
    { width: 390, height: 390 },
    { width: 320, height: 480 },
    { width: 650, height: 426 },
    { width: 360, height: 640 },
    { width: 390, height: 626 },
    { width: 375, height: 667 },
    { width: 1024, height: 626 },
  ]) {
    await page.setViewportSize(viewport);
    await list.evaluate((element) => (element.scrollTop = 0));
    await page.locator('.daddy-main').evaluate((element) => (element.scrollTop = 0));
    await expect(first).toBeInViewport({ ratio: 1 });
    if ((await page.locator('.daddy-main').getAttribute('data-task-side')) !== null) {
      for (const label of ['Copy failed', 'Awaiting resources', 'Low memory', 'Low disk space']) {
        await expect(notices.getByText(label, { exact: true })).toBeInViewport({ ratio: 1 });
      }
    } else {
      await expect(notices.getByText('Waiting for server resources')).toBeInViewport({ ratio: 1 });
    }
    await expect(failedCopy.getByRole('button', { name: 'Retry', exact: true })).toBeInViewport({
      ratio: 1,
    });
    if (viewport.width === 375 && viewport.height === 320) {
      await list.hover();
      await page.mouse.wheel(0, 2200);
      await expect(cards.last()).toBeInViewport();
      await cards.last().click();
      await expect(page.getByRole('dialog', { name: 'Work item' })).toBeVisible();
      await page.keyboard.press('Escape');
      await queue.click();
      await expect(page.getByRole('dialog', { name: 'Queue task' })).toBeVisible();
      await page.keyboard.press('Escape');
      await failedCopy.getByRole('button', { name: 'View details' }).click();
      await expect(page.getByRole('dialog').getByText(copyFailure)).toBeVisible();
      await page.keyboard.press('Escape');
    }
  }
  await notices
    .getByRole('alert')
    .filter({ hasText: 'Request failed' })
    .getByRole('button', { name: 'View details' })
    .click();
  await expect(page.getByRole('dialog').getByText(sendDiagnostic)).toBeVisible();
  await page.keyboard.press('Escape');

  await page.route('**/api/preferences', (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    const { locale } = route.request().postDataJSON();
    return route.fulfill({ json: { locale, version: Number.MAX_SAFE_INTEGER } });
  });
  for (const locale of ['en', 'ru'] as const) {
    const t = translator(locale);
    await page.setViewportSize({ width: 375, height: 376 });
    const menu = page.getByRole('button', { name: 'Sessions', exact: true });
    await menu.click();
    await page.getByLabel('Language', { exact: true }).selectOption(locale);
    await page.keyboard.press('Escape');
    await page
      .locator('.daddy-mobile-tabs')
      .getByRole('button', { name: t('Tasks'), exact: false })
      .click();
    await list.evaluate((element) => (element.scrollTop = 0));
    await page.getByRole('main').evaluate((element) => (element.scrollTop = 0));
    await expect(first).toBeInViewport({ ratio: 1 });
    await list.hover();
    await page.mouse.wheel(0, 2200);
    await expect(cards.last()).toBeInViewport({ ratio: 1 });
    await cards.last().click();
    await expect(page.getByRole('dialog', { name: t('Work item') })).toBeVisible();
    await page.keyboard.press('Escape');
    const localNotices = page.getByRole('region', { name: t('Session status') });
    await localNotices
      .getByRole('alert')
      .filter({ hasText: t('Could not prepare the session copy') })
      .getByRole('button', { name: t('View details') })
      .click();
    await expect(page.getByRole('dialog').getByText(copyFailure)).toBeVisible();
    await page.keyboard.press('Escape');
    await localNotices
      .getByRole('alert')
      .filter({ hasText: t('Request failed') })
      .getByRole('button', { name: t('View details') })
      .click();
    await expect(page.getByRole('dialog').getByText(sendDiagnostic)).toBeVisible();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: t('Agent limits'), exact: true }).click();
    await expect(
      page
        .getByRole('region', { name: t('Agent limit details') })
        .getByRole('heading', { name: 'Claude', exact: true }),
    ).toBeVisible();
    await page.getByRole('link', { name: t('Open limits page'), exact: true }).click();
    await expect(page.getByRole('heading', { name: t('Agent limits'), exact: true })).toBeVisible();
    await page.getByRole('link', { name: t('Back to workspace'), exact: true }).click();
  }
  await page.getByRole('button', { name: translator('ru')('Sessions'), exact: true }).click();
  await page.getByLabel(translator('ru')('Language'), { exact: true }).selectOption('en');
  await page.keyboard.press('Escape');

  deletionFailed = true;
  constrained = false;
  await page.setViewportSize({ width: 320, height: 540 });
  await page.locator('.daddy-mobile-tabs').getByRole('button', { name: /Tasks/ }).click();
  const retryDeletion = notices.getByRole('button', { name: 'Retry deletion' });
  await retryDeletion.waitFor();
  await list.evaluate((element) => (element.scrollTop = 0));
  await page.locator('.daddy-main').evaluate((element) => (element.scrollTop = 0));
  await expect(first).toBeInViewport({ ratio: 1 });
  await expect(retryDeletion).toBeInViewport({ ratio: 1 });

  deletionFailed = false;
  constrained = true;
  const tasksTab = page.locator('.daddy-mobile-tabs').getByRole('button', { name: /Tasks/ });
  const counter = tasksTab.locator('span');
  for (const count of [1, 12, 128]) {
    visibleTaskCount = count;
    await expect(counter).toHaveText(String(count));
    for (const viewport of [
      { width: 375, height: 320 },
      { width: 390, height: 425 },
    ]) {
      await page.setViewportSize(viewport);
      await page.locator('.daddy-main').evaluate((element) => (element.scrollTop = 0));
      await expect(counter).toBeInViewport({ ratio: 1 });
      const hits = await counter.evaluate((element) => {
        const tab = element.closest('button')!;
        const text = element.firstChild!;
        return Array.from(element.textContent!).map((_, index) => {
          const range = document.createRange();
          range.setStart(text, index);
          range.setEnd(text, index + 1);
          const rect = range.getBoundingClientRect();
          const x = rect.left + rect.width / 2;
          const y = rect.top + rect.height / 2;
          return { x, y, hitsTab: tab.contains(document.elementFromPoint(x, y)) };
        });
      });
      expect(hits.every((hit) => hit.hitsTab)).toBe(true);
      const lastDigit = hits.at(-1)!;
      await page.mouse.click(lastDigit.x, lastDigit.y);
      await expect(tasksTab).toHaveAttribute('aria-pressed', 'true');
      await expect(page.getByRole('dialog')).toHaveCount(0);
    }
  }
});
test('shows message send errors without scrolling on short screens', async ({ page }) => {
  const message = 'The server is temporarily unavailable';
  await mockTwoProviders(page);
  await page.route('**/api/daddy/sessions/*/chat', (route) =>
    route.fulfill({ status: 503, json: { error: { code: 'unavailable', message } } }),
  );
  await login(page);
  await create(page, 'Send failure on a short screen', Date.now());
  await expect(page.getByRole('button', { name: 'Agent limits', exact: true })).toBeVisible();

  const main = page.getByRole('main');
  const composer = page.getByLabel('Message daddy');
  const alert = page.getByRole('alert').filter({ hasText: message });
  for (const viewport of [
    { width: 390, height: 540 },
    { width: 1024, height: 480 },
  ]) {
    await page.setViewportSize(viewport);
    expect(await main.evaluate((element) => element.scrollTop)).toBe(0);
    const draft = `Keep this draft at ${viewport.width} pixels`;
    await composer.fill(draft);
    const rejected = page.waitForResponse(
      (response) => response.url().endsWith('/chat') && response.status() === 503,
    );
    await composer.press('Enter');
    await rejected;

    await expect(alert).toBeInViewport({ ratio: 1 });
    await expect(alert.getByRole('button', { name: 'Retry' })).toBeInViewport({ ratio: 1 });
    await expect(composer).toHaveValue(draft);
    expect(await main.evaluate((element) => element.scrollTop)).toBe(0);

    if (viewport.width === 390) {
      await page.locator('.daddy-mobile-tabs').getByRole('button', { name: /Tasks/ }).click();
    }
    await expect(page.locator('.daddy-work-items .daddy-work-item').first()).toBeInViewport({
      ratio: 1,
    });
  }
});
test('shows copy and deletion failures with the task board without scrolling', async ({ page }) => {
  await mockTwoProviders(page);
  await login(page);
  await create(page, 'Session maintenance failure', Date.now());
  const sessionId = new URL(page.url()).hash.slice('#session/'.length);
  let groupPatch: Partial<DaddyBoard['group']>;
  await page.route(`**/api/daddy/sessions/${sessionId}`, async (route) => {
    const response = await route.fetch();
    const board: DaddyBoard = await response.json();
    await route.fulfill({ response, json: { ...board, group: { ...board.group, ...groupPatch } } });
  });

  for (const { group, heading, reason, retry } of [
    {
      group: {
        daddyState: 'needs_input',
        workspacePreparation: { state: 'error', error: 'The session copy could not be written' },
      },
      heading: 'Could not prepare the session copy',
      reason: 'The session copy could not be written',
      retry: 'Retry',
    },
    {
      group: {
        daddyState: 'paused',
        deletion: { state: 'error', error: 'The session archive could not be written' },
      },
      heading: 'Session deletion stopped; working copies were preserved',
      reason: 'The session archive could not be written',
      retry: 'Retry deletion',
    },
  ] satisfies {
    group: Partial<DaddyBoard['group']>;
    heading: string;
    reason: string;
    retry: string;
  }[]) {
    groupPatch = group;
    await page.reload();
    await expect(page.getByRole('button', { name: 'Agent limits', exact: true })).toBeVisible();
    const main = page.getByRole('main');
    const tasks = page.locator('.daddy-work-items .daddy-work-item');
    for (const viewport of [
      { width: 390, height: 540 },
      { width: 1024, height: 480 },
    ]) {
      await page.setViewportSize(viewport);
      if (viewport.width === 390) {
        await page.locator('.daddy-mobile-tabs').getByRole('button', { name: /Tasks/ }).click();
      }
      await expect(page.getByText(reason, { exact: true })).toBeInViewport({ ratio: 1 });
      await expect(page.getByText(heading, { exact: true })).toBeInViewport({ ratio: 1 });
      await expect(page.getByRole('button', { name: retry, exact: true })).toBeInViewport({
        ratio: 1,
      });
      await expect(tasks.first()).toBeInViewport({ ratio: 1 });
      expect(await main.evaluate((element) => element.scrollTop)).toBe(0);
    }
  }
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
  await page.setViewportSize({ width: 1024, height: 480 });
  await expect(page.getByRole('button', { name: 'В очередь', exact: true })).toBeInViewport({
    ratio: 1,
  });
  await expect(page.locator('.daddy-work-items .daddy-work-item').first()).toBeInViewport({
    ratio: 1,
  });
  await expect(page.getByRole('button', { name: /Воркспейсы/ })).toBeVisible();
  await page.getByRole('button', { name: 'Настройки сессии' }).click();
  await expect(page.getByLabel('daddy Модель')).toHaveValue('gpt-6-astra');
  await expect(page.getByLabel('Все воркеры Модель')).toHaveValue('gpt-5.6-sol');
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

for (const failed of ['/api/daddy/sessions', '/api/workspaces', '/api/status']) {
  test(`restores the confirmed new chat on Forward while ${failed} is unavailable`, async ({
    page,
  }) => {
    await login(page);
    const a = await sessionFixture(page, 'Before failed refresh');
    await page.goto(`/?fixture=failed-refresh#session/${a.id}`);
    await expect(page.getByRole('heading', { name: a.title, exact: true })).toBeVisible();
    let fail = false;
    await page.route(`**${failed}`, (route) =>
      fail && route.request().method() === 'GET'
        ? route.fulfill({ status: 503, json: { error: { message: 'Fixture read failed' } } })
        : route.continue(),
    );
    await page.getByRole('link', { name: 'Limits', exact: true }).click();
    await page.getByRole('button', { name: 'New session', exact: true }).click();
    const title = `Created before failed refresh ${failed}`;
    await page.getByLabel('Session name (optional)').fill(title);
    const created = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' && response.url().endsWith('/api/daddy/sessions'),
    );
    fail = true;
    await page.getByRole('button', { name: 'Start session', exact: true }).click();
    const response = await created;
    expect(response.status()).toBe(201);
    const { group } = (await response.json()) as DaddyBoard;
    const newUrl = `/#session/${group.id}`;
    const heading = page.getByRole('heading', { name: title, exact: true });
    await expect(page).toHaveURL(newUrl);
    await expect(heading).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(`/limits#session/${a.id}`);
    await page.goForward();
    await expect(page).toHaveURL(newUrl);
    await expect(heading).toBeVisible();
    fail = false;
    await expect(
      page.getByRole('navigation', { name: 'Sessions' }).getByRole('button', { name: title }),
    ).toBeVisible();
    await page.getByLabel('Message daddy').fill('Continue in the new chat');
    const sent = page.waitForRequest(
      (request) => request.method() === 'POST' && request.url().endsWith('/chat'),
    );
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    expect(new URL((await sent).url()).pathname).toBe(`/api/daddy/sessions/${group.id}/chat`);
  });
}

for (const exit of ['Back', 'link'] as const) {
  for (const save of ['session', 'workspace', 'workspace defaults'] as const) {
    test(`a late ${save} save leaves the conversation and its new dialog open after ${exit}`, async ({
      page,
    }) => {
      await login(page);
      const a = await sessionFixture(page, 'Chat restored while saving');
      const aUrl = `/?fixture=late-save#session/${a.id}`;
      const alternate = resolve('.daddyloop/e2e/fixture-repository-alternate');
      let endpoint = save === 'session' ? '/api/daddy/sessions' : '/api/workspaces';
      const newName = `Saved after ${exit} ${save}`;
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
        await page.getByLabel('What should daddy do?').fill('A submitted goal');
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
      const nextDialog = page.getByRole('dialog', {
        name: save === 'session' ? 'Workspaces on this server' : 'Session settings',
        exact: true,
      });
      try {
        await page
          .getByRole('button', {
            name: save === 'session' ? 'Start session' : 'Save workspace',
            exact: true,
          })
          .click();
        await responseReady;
        if (exit === 'Back') {
          await page.goBack();
        } else {
          await page
            .getByRole('dialog')
            .getByRole('button', { name: 'Close', exact: true })
            .click();
          if (save !== 'session') {
            await page
              .getByRole('dialog')
              .getByRole('button', { name: 'Close', exact: true })
              .click();
          }
          await page.getByRole('link', { name: 'Back to workspace', exact: true }).click();
        }
        const restoredUrl = exit === 'Back' ? aUrl : `/#session/${a.id}`;
        await expect(page).toHaveURL(restoredUrl);
        await expect(draft).toHaveValue('Draft in the restored chat');
        await page
          .getByRole('button', { name: save === 'session' ? /^Workspaces/ : /^Session settings$/ })
          .click();
        await expect(nextDialog).toBeVisible();

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
        expect(await nextDialog.isVisible()).toBe(true);
        await expect(page).toHaveURL(restoredUrl);
        await nextDialog.getByRole('button', { name: 'Close', exact: true }).click();
        await expect(draft).toHaveValue('Draft in the restored chat');
        if (save === 'session') {
          await expect(
            page
              .getByRole('navigation', { name: 'Sessions' })
              .getByRole('button', { name: newName }),
          ).toBeVisible();
          await page.getByRole('button', { name: 'New session', exact: true }).click();
          await expect(page.getByLabel('What should daddy do?')).toHaveValue('');
          await expect(page.getByLabel('Session name (optional)')).toHaveValue('');
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
}

for (const action of ['settings', 'tasks', 'session'] as const) {
  test(`a late ${action} response preserves input in a reopened form`, async ({ page }) => {
    await login(page);
    const a = await sessionFixture(page, 'Chat with pending form');
    const url = `/?fixture=late-form#session/${a.id}`;
    await page.goto(url);
    await expect(page.getByRole('heading', { name: a.title, exact: true })).toBeVisible();
    const endpoint =
      action === 'session' ? '/api/daddy/sessions' : `/api/daddy/sessions/${a.id}/${action}`;
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
    const dialog = page.getByRole('dialog');
    const goal = page.getByLabel('What should daddy do?');
    const open =
      action === 'settings'
        ? 'Session settings'
        : action === 'tasks'
          ? 'Queue a task'
          : 'New session';
    const submit =
      action === 'settings' ? 'Save settings' : action === 'tasks' ? 'Queue task' : 'Start session';
    try {
      await page.getByRole('button', { name: open, exact: true }).click();
      if (action === 'tasks') await dialog.getByLabel('Task description').fill('Earlier task');
      if (action === 'session') await goal.fill('Earlier goal');
      await dialog.getByRole('button', { name: submit, exact: true }).click();
      await responseReady;
      await dialog.getByRole('button', { name: 'Close', exact: true }).click();
      await page.getByRole('button', { name: 'New session', exact: true }).click();
      await goal.fill('New input after closing the first form');
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
      await expect(page).toHaveURL(url);
      await expect(goal).toHaveValue('New input after closing the first form');
    } finally {
      release();
    }
  });
}

for (const fromNewSession of [true, false]) {
  test(`a pending workspace save preserves a different editor (from new session: ${fromNewSession})`, async ({
    page,
  }) => {
    await login(page);
    const name = `Workspace saved in background ${fromNewSession}`;
    if (fromNewSession) {
      await page.getByRole('link', { name: 'Limits', exact: true }).click();
      await page.getByRole('button', { name: 'New session', exact: true }).click();
      await page.getByRole('button', { name: 'Add another workspace', exact: true }).click();
    } else {
      await page.getByRole('button', { name: /^Workspaces/ }).click();
    }
    await page.getByRole('button', { name: 'Add workspace', exact: true }).click();
    const workspaceName = page.getByLabel('Workspace name', { exact: true });
    await workspaceName.fill(name);
    await page
      .getByLabel('Repository URL or server folder', { exact: true })
      .fill(resolve('.daddyloop/e2e/fixture-repository-alternate'));
    let release!: () => void, saved!: () => void;
    const hold = new Promise<void>((done) => {
      release = done;
    });
    const savedOnServer = new Promise<void>((done) => {
      saved = done;
    });
    await page.route('**/api/workspaces', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      const response = await route.fetch();
      saved();
      await hold;
      await route.fulfill({ response });
    });
    try {
      await page.getByRole('button', { name: 'Save workspace', exact: true }).click();
      await savedOnServer;
      if (fromNewSession) {
        await page.getByRole('button', { name: 'Back to workspaces', exact: true }).click();
        await page.getByRole('button', { name: 'Add workspace', exact: true }).click();
      } else {
        await page
          .getByRole('button', { name: 'Edit workspace Fixture workspace', exact: true })
          .click();
      }
      await workspaceName.fill('Unsaved name in the second editor');
      const response = page.waitForResponse(
        (response) =>
          response.request().method() === 'POST' && response.url().endsWith('/api/workspaces'),
      );
      release();
      expect((await response).status()).toBe(201);
      await expect(
        page.getByRole('button', { name: `Edit workspace ${name}`, exact: true }),
      ).toBeVisible();
      await expect(workspaceName).toHaveValue('Unsaved name in the second editor');
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
test('shows the same enabled module summary available from Telegram', async ({ page }) => {
  await login(page);
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/modules', async (route) => {
    await wait;
    const response = await route.fetch();
    const modules = await response.json();
    modules[0].enabled = true;
    modules[1].enabled = false;
    await route.fulfill({ response, json: modules });
  });
  await page.getByRole('button', { name: 'Modules', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Modules on this server' })).toBeVisible();
  await expect(dialog.getByText(/Enabled|Disabled/)).toHaveCount(0);
  release();
  await expect(dialog.locator('.daddy-module-item').nth(0)).toContainText('Agent · Enabled');
  await expect(dialog.locator('.daddy-module-item').nth(1)).toContainText('Agent · Disabled');
  await dialog.getByRole('button', { name: 'Close' }).click();

  await page.getByLabel('Language', { exact: true }).selectOption('ru');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Сессии', exact: true }).click();
  await page.getByRole('button', { name: 'Модули', exact: true }).click();
  await expect(dialog.locator('.daddy-module-item').nth(0)).toContainText('Агент · Включён');
  await expect(dialog.locator('.daddy-module-item').nth(1)).toContainText('Агент · Выключен');
  await dialog.getByRole('button', { name: 'Закрыть' }).click();

  await page.unroute('**/api/modules');
  await page.route('**/api/modules', (route) => route.abort());
  await page.getByRole('button', { name: 'Модули', exact: true }).click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  await expect(dialog.getByText(/Включён|Выключен/)).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Закрыть' }).click();
  await page.setViewportSize({ width: 1366, height: 900 });
  await page.getByLabel('Язык', { exact: true }).selectOption('en');
});

test('keeps an open task report on one revision while board state changes', async ({ page }) => {
  await login(page);
  await create(page, 'Live task report', Date.now());
  const { sessionId, taskId } = await page.evaluate(async () => {
    const sessionId = location.hash.slice('#session/'.length);
    const board = await fetch(`/api/daddy/sessions/${sessionId}`).then((response) =>
      response.json(),
    );
    return { sessionId, taskId: board.tasks[0].id as string };
  });
  const snapshot = {
    state: 'awaiting_plan_approval',
    generation: 10,
    head: '1'.repeat(40),
    pendingAuthorHead: undefined as string | undefined,
    reason: 'Plan ready on the first revision',
    checks: 'passing',
    checkName: 'Check on the first revision',
    statusLabel: 'Ready for review',
  };
  let hold = false,
    fail = false,
    missing = false,
    responseDelay = 3200,
    detailRequests = 0,
    detailOverride: Partial<typeof snapshot> | undefined,
    releaseDetail: (() => void) | undefined,
    detailStarted: (() => void) | undefined;
  await page.route(`**/api/daddy/sessions/${sessionId}`, async (route) => {
    const response = await route.fetch(),
      board = await response.json();
    if (missing) board.tasks = board.tasks.filter((item: { id: string }) => item.id !== taskId);
    const task = board.tasks.find((item: { id: string }) => item.id === taskId);
    if (!task) {
      await route.fulfill({ response, json: board });
      return;
    }
    Object.assign(task, {
      state: snapshot.state,
      generation: snapshot.generation,
      head: snapshot.head,
      pendingAuthorHead: snapshot.pendingAuthorHead,
      reason: snapshot.reason,
      statusLabel: snapshot.statusLabel,
    });
    await route.fulfill({ response, json: board });
  });
  await page.route(`**/api/tasks/${taskId}`, async (route) => {
    detailRequests++;
    detailStarted?.();
    detailStarted = undefined;
    if (hold)
      await new Promise<void>((resolve) => {
        releaseDetail = resolve;
      });
    if (responseDelay) await new Promise((resolve) => setTimeout(resolve, responseDelay));
    if (fail) {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'Fixture detail refresh failed' }),
      });
      return;
    }
    const response = await route.fetch(),
      detail = await response.json(),
      shown = { ...snapshot, ...detailOverride };
    Object.assign(detail.task, {
      state: shown.state,
      generation: shown.generation,
      pendingAuthorHead: shown.pendingAuthorHead,
      reason: shown.reason,
      revision: { ...detail.task.revision, head: shown.head },
      kind: shown.state === 'awaiting_plan_approval' ? 'plan' : 'code',
      pr: {
        checks: shown.checks,
        checkDetails: [
          {
            name: shown.checkName,
            status: shown.checks === 'passing' ? 'success' : 'failed',
          },
        ],
      },
    });
    await route.fulfill({ response, json: detail });
  });

  await page.locator('.daddy-work-item').first().click();
  const report = page.getByRole('dialog', { name: 'Work item' });
  await expect(report.getByText(snapshot.head, { exact: true })).toBeVisible();
  await expect(report.getByText(snapshot.statusLabel, { exact: true })).toBeVisible();
  const approve = report.getByRole('button', { name: 'Approve plan' });
  await expect(approve).toBeEnabled();

  let started = new Promise<void>((resolve) => {
    detailStarted = resolve;
  });
  hold = true;
  Object.assign(snapshot, {
    state: 'awaiting_checks',
    generation: 11,
    head: '2'.repeat(40),
    pendingAuthorHead: undefined,
    reason: 'Waiting for checks on the second revision',
    checks: 'failing',
    checkName: 'Check A',
    statusLabel: 'Waiting for checks',
  });
  await started;
  await expect(approve).toBeDisabled();
  hold = false;
  releaseDetail?.();
  await expect(report.getByText(snapshot.head, { exact: true })).toBeVisible({ timeout: 10000 });
  await expect(report.getByText(snapshot.statusLabel, { exact: true })).toBeVisible();
  responseDelay = 0;
  await expect(approve).toHaveCount(0);
  await expect(report.getByText('Check A')).toBeVisible();
  const reason = report.getByLabel('Reason for allowing this revision without passing CI');
  await reason.fill('Verified offline');
  const waive = report.getByRole('button', { name: 'Allow without passing CI' });
  await expect(waive).toBeEnabled();

  started = new Promise<void>((resolve) => {
    detailStarted = resolve;
  });
  snapshot.checkName = 'Check B';
  await started;
  await expect(report.getByText('Check B')).toBeVisible();
  await expect(report.getByText('Check A')).toHaveCount(0);

  started = new Promise<void>((resolve) => {
    detailStarted = resolve;
  });
  Object.assign(snapshot, {
    generation: 12,
    head: '3'.repeat(40),
    reason: 'Waiting for checks on the third revision',
    checkName: 'Check C',
  });
  await started;
  await expect(report.getByText('3'.repeat(40), { exact: true })).toBeVisible();
  await expect(reason).toHaveValue('');
  await expect(waive).toBeDisabled();

  started = new Promise<void>((resolve) => {
    detailStarted = resolve;
  });
  fail = true;
  await started;
  await expect(report.getByRole('alert')).toContainText('Request failed');
  await expect(waive).toBeDisabled();

  started = new Promise<void>((resolve) => {
    detailStarted = resolve;
  });
  fail = false;
  await started;
  await expect(report.getByRole('alert')).toHaveCount(0);
  await expect(report.getByText('Check C')).toBeVisible();
  await reason.fill('New revision verified offline');
  await expect(waive).toBeEnabled();

  detailOverride = {
    generation: 11,
    head: '2'.repeat(40),
    reason: 'Stale details behind the board',
    checkName: 'Stale check',
  };
  responseDelay = 70;
  const behindStart = detailRequests;
  started = new Promise<void>((resolve) => {
    detailStarted = resolve;
  });
  await started;
  Object.assign(snapshot, {
    generation: 13,
    head: '4'.repeat(40),
    reason: 'Board ahead of details',
    checkName: 'Check D',
  });
  await page.waitForTimeout(500);
  expect(detailRequests - behindStart).toBeLessThanOrEqual(2);
  detailOverride = undefined;
  await expect(report.getByText('4'.repeat(40), { exact: true })).toBeVisible({ timeout: 5000 });
  await reason.fill('Verified fourth revision');
  await expect(waive).toBeEnabled();

  detailOverride = {
    generation: 14,
    head: '5'.repeat(40),
    reason: 'Details ahead of board',
    checkName: 'Check E',
  };
  const aheadStart = detailRequests;
  started = new Promise<void>((resolve) => {
    detailStarted = resolve;
  });
  await started;
  await page.waitForTimeout(500);
  expect(detailRequests - aheadStart).toBeLessThanOrEqual(2);
  await expect(waive).toBeDisabled();
  Object.assign(snapshot, detailOverride);
  await expect(report.getByText('5'.repeat(40), { exact: true })).toBeVisible({ timeout: 5000 });
  await expect(reason).toHaveValue('');
  await reason.fill('Verified fifth revision');
  await expect(waive).toBeEnabled();
  detailOverride = undefined;

  missing = true;
  await expect(page.locator('.daddy-work-item')).toHaveCount(0, { timeout: 5000 });
  await expect(report.getByText('This task is no longer available in this session.')).toBeVisible();
  await expect(waive).toHaveCount(0);
  const missingRequests = detailRequests;
  await page.waitForTimeout(2200);
  expect(detailRequests).toBe(missingRequests);
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

test('keeps a newly created chat selected when another client deletes it', async ({ page }) => {
  await login(page);
  const a = await sessionFixture(page, 'Before creating the removed chat');
  await page.goto(`/limits#session/${a.id}`);
  await page.getByRole('button', { name: 'New session', exact: true }).click();
  await page.getByLabel('Session name (optional)').fill('New chat removed externally');
  const created = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' && response.url().endsWith('/api/daddy/sessions'),
  );
  await page.getByRole('button', { name: 'Start session', exact: true }).click();
  const { group } = (await (await created).json()) as DaddyBoard;
  await expect(page.getByRole('heading', { name: group.title, exact: true })).toBeVisible();
  await page.route('**/api/daddy/sessions', async (route) => {
    const response = await route.fetch();
    const sessions = (await response.json()) as { id: string }[];
    await route.fulfill({ response, json: sessions.filter(({ id }) => id !== group.id) });
  });
  await expect(page.getByRole('alert').filter({ hasText: group.id })).toBeVisible();
  await expect(page).toHaveURL(`/#session/${group.id}`);
  await expect(page.getByLabel('Message daddy')).toHaveCount(0);
  await page.getByRole('button', { name: new RegExp(a.title) }).click();
  await expect(page.getByRole('heading', { name: a.title, exact: true })).toBeVisible();
});

for (const locale of ['en', 'ru'] as const) {
  test(`limits keep the chat hidden across compact layout boundaries (${locale})`, async ({
    page,
  }) => {
    const t = translator(locale);
    await login(page);
    const session = await sessionFixture(page, 'Session with visible task board');
    await page.route('**/api/preferences', async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, json: { ...(await response.json()), locale } });
    });
    await page.route('**/api/status', async (route) => {
      const response = await route.fetch();
      const status = await response.json();
      await route.fulfill({
        response,
        json: { ...status, preferences: { ...status.preferences, locale } },
      });
    });
    await page.goto(`/limits#session/${session.id}`);
    const limits = page.getByRole('heading', { name: t('Agent limits'), exact: true });
    await expect(limits).toBeVisible();
    // The loaded task panel activates the compact desktop grid rules even when there are no tasks.
    const hiddenChat = page.locator('.daddy-main[hidden]');
    await expect(hiddenChat.locator('.daddy-board')).toHaveCount(1);
    await page.addStyleTag({ content: ':root { font-size: 20px; }' });
    for (const [width, height] of [
      [650, 425],
      [651, 425],
      [851, 480],
      [1024, 480],
      [1280, 625],
      [1280, 626],
    ]) {
      await page.setViewportSize({ width, height });
      await expect(page.getByRole('main')).toHaveCount(1);
      await expect(limits).toBeVisible();
      await expect(hiddenChat).toHaveCSS('display', 'none');
      await expect(page.getByLabel(t('Message daddy'))).toBeHidden();
    }
    await page.getByRole('link', { name: t('Back to workspace'), exact: true }).click();
    await expect(page.getByRole('heading', { name: session.title, exact: true })).toBeVisible();
    await expect(page.getByLabel(t('Message daddy'))).toBeEditable();
  });
}
