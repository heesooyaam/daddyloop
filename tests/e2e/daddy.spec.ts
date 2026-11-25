import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
  await expect(page.getByText('Exact revision', { exact: true })).toBeVisible();
  await expect(page.locator('.daddy-task-version code')).toHaveText(/^[a-f0-9]{40}$/);
  await expect(page.getByText('Generation', { exact: true })).toBeVisible();
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
test('shows quota remaining on a phone and requires confirmation before spending one reset', async ({
  page,
}) => {
  await login(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Sessions', exact: true }).click();
  await page.getByRole('button', { name: /Limits/ }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('7 days: 27% remaining')).toBeVisible();
  await expect(dialog.getByText('Available resets: 3')).toBeVisible();
  const writes: string[] = [];
  page.on('request', (request) => {
    if (/\/api\/usage\/reset\/[a-f0-9-]{36}$/.test(request.url())) writes.push(request.url());
  });
  await dialog.getByRole('button', { name: 'Use a reset', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Confirm: use one reset' })).toBeVisible();
  expect(writes).toHaveLength(0);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(writes).toHaveLength(0);
  await dialog.getByRole('button', { name: 'Use a reset', exact: true }).click();
  await dialog.getByRole('button', { name: 'Confirm: use one reset' }).click();
  await expect(dialog.getByText('Available resets: 2')).toBeVisible();
  await expect(dialog.getByText('7 days: 100% remaining')).toBeVisible();
  expect(writes).toHaveLength(1);
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

test('offers retry submit only for a saved ticket across locales and layouts', async ({ page }) => {
  await login(page);
  await create(page, 'Retry submission states', Date.now());
  const { sessionId, taskId } = await page.evaluate(async () => {
    const sessionId = location.hash.slice('#session/'.length);
    const board = await fetch(`/api/daddy/sessions/${sessionId}`).then((response) =>
      response.json(),
    );
    return { sessionId, taskId: board.tasks[0].id as string };
  });
  let state = 'ready_for_review';
  let pending = true;
  let pullRequest = false;
  let boardSeen: (() => void) | undefined;
  const pullRequestRef = () => ({
    kind: 'pull_request',
    provider: 'github',
    host: 'github.com',
    repo: 'fixture/planning',
    number: 77,
    url: 'https://github.com/fixture/planning/pull/77',
  });
  await page.route(`**/api/daddy/sessions/${sessionId}`, async (route) => {
    const response = await route.fetch(),
      board = await response.json(),
      task = board.tasks.find((item: { id: string }) => item.id === taskId);
    task.state = state;
    task.reason = `Fixture ${state}`;
    task.policy = { ...task.policy, autoPush: false };
    task.pendingAuthorHead = pending ? 'd'.repeat(40) : undefined;
    if (pullRequest) task.ref = pullRequestRef();
    await route.fulfill({ response, json: board });
    boardSeen?.();
    boardSeen = undefined;
  });
  await page.route(`**/api/tasks/${taskId}`, async (route) => {
    const response = await route.fetch();
    const detail = await response.json();
    detail.task.state = state;
    detail.task.reason = `Fixture ${state}`;
    detail.task.policy = { ...detail.task.policy, autoPush: false };
    detail.task.pendingAuthorHead = pending ? 'd'.repeat(40) : undefined;
    if (pullRequest) detail.task.ref = pullRequestRef();
    await route.fulfill({ response, json: detail });
  });
  const cases = [
    ['en', 1366, 'ready_for_review', true, false],
    ['en', 390, 'needs_input', true, false],
    ['en', 1366, 'submitting', true, false],
    ['en', 390, 'awaiting_push', true, true],
    ['ru', 390, 'ready_for_review', true, false],
    ['ru', 1366, 'needs_input', true, false],
    ['ru', 390, 'submitting', true, false],
    ['ru', 1366, 'awaiting_push', true, true],
    ['en', 1366, 'needs_input', false, false],
    ['ru', 390, 'needs_input', false, false],
  ] as const;
  for (const [locale, width, nextState, hasPending, existingPr] of cases) {
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.getByLabel(/^(Language|Язык)$/).selectOption(locale);
    await page.setViewportSize({ width, height: 844 });
    state = nextState;
    pending = hasPending;
    pullRequest = existingPr;
    const refreshed = new Promise<void>((resolve) => {
      boardSeen = resolve;
    });
    await refreshed;
    if (width < 700)
      await page
        .locator('.daddy-mobile-tabs')
        .getByRole('button', { name: locale === 'ru' ? /Задачи/ : /Tasks/ })
        .click();
    await page.locator('.daddy-work-item').first().click();
    const dialog = page.getByRole('dialog');
    const submit = dialog.getByRole('button', {
      name: locale === 'ru' ? 'Отправить на ревью' : 'Submit for review',
    });
    if (hasPending) await expect(submit).toBeVisible();
    else await expect(submit).toHaveCount(0);
    await dialog.getByRole('button', { name: locale === 'ru' ? 'Закрыть' : 'Close' }).click();
  }
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
    state: 'ready_for_review',
    generation: 10,
    head: '1'.repeat(40),
    pendingAuthorHead: '1'.repeat(40) as string | undefined,
    reason: 'Ready on the first revision',
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
      policy: { ...task.policy, autoPush: false },
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
      policy: { ...detail.task.policy, autoPush: false },
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
  const submit = report.getByRole('button', { name: 'Submit for review' });
  await expect(submit).toBeEnabled();

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
  await expect(submit).toBeDisabled();
  hold = false;
  releaseDetail?.();
  await expect(report.getByText(snapshot.head, { exact: true })).toBeVisible({ timeout: 10000 });
  await expect(report.getByText(snapshot.statusLabel, { exact: true })).toBeVisible();
  responseDelay = 0;
  await expect(submit).toHaveCount(0);
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
  Object.assign(snapshot, detailOverride);
  await expect(report.getByText('5'.repeat(40), { exact: true })).toBeVisible({ timeout: 5000 });
  detailOverride = undefined;

  missing = true;
  await expect(page.locator('.daddy-work-item')).toHaveCount(0, { timeout: 5000 });
  await expect(waive).toBeDisabled();
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
