import { test, expect, type Locator, type Page } from '@playwright/test';
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
  const workers = page.getByRole('heading', { name: 'Worker pool' });
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
  const openTaskReport = async (number: number) => {
    const title = `Ticket fixture ${number}`;
    await page.getByRole('button', { name: new RegExp(title) }).click({ timeout: 5000 });
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
  await openTaskReport(issue + 1);
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
  await openTaskReport(issue);
  await expect(chat).toBeHidden();
  await tabs.getByRole('button', { name: 'daddy' }).click();
  await checkConversation();
  await openLimits();
  await openSessions.press('Enter');
  await expect(sessions).toBeVisible();
  await page.keyboard.press('Escape');
  await returnToChat();
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
          ? 'Queue task'
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
