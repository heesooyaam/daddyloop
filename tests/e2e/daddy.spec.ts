import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DaddyBoard } from '../../src/client/daddy.js';
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

  const sent = page.waitForResponse(
    (response) => response.url().endsWith('/chat') && response.request().method() === 'POST',
  );
  const message = page.getByLabel('Message daddy');
  await message.fill(`https://github.com/fixture/planning/issues/${Date.now() + 1}`);
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
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
  await message.press('Enter');
  const defaultResponse = await sentWithDefault;
  expect(defaultResponse.status()).toBe(200);
  expect(defaultResponse.request().postDataJSON()).not.toHaveProperty('repository');
  const defaultBoard = await defaultResponse.json();
  expect(defaultBoard.messages.at(-1).workspace.repoPath).toBe(source);
  expect(defaultBoard.workspace.repoPath).toBe(source);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('.daddy-mobile-tabs').getByRole('button', { name: /Tasks/ }).click();
  await expect(page.locator('.daddy-work-item')).toHaveCount(3);
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
  await openSessions.click();
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
  await openSessions.click();
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
  await page.route(`**/api/daddy/sessions/${sessionId}`, async (route) => {
    const response = await route.fetch();
    const board: DaddyBoard = await response.json();
    const prerequisite = board.tasks.find((task) => !taskIds.includes(task.id))!;
    const tasks = taskIds.map((id) => ({
      ...board.tasks.find((task) => task.id === id)!,
      dependsOn: [prerequisite.id],
    }));
    await route.fulfill({
      response,
      json: {
        ...board,
        group: { ...board.group, workspacePreparation: { state: 'ready', path } },
        tasks: [...tasks.slice(0, -1), prerequisite, tasks.at(-1)!],
        taskQueue: [],
      } satisfies DaddyBoard,
    });
  });
  await mockTwoProviders(page);

  const list = page.locator('.daddy-work-items');
  const cards = list.getByRole('button');
  const fullTitle = `1. ${longTitle}`;
  const queue = page.getByRole('button', { name: 'Queue a task', exact: true });
  const copyPath = page
    .getByRole('status')
    .filter({ hasText: 'Session copy ready' })
    .locator('code');
  await expect(page.getByRole('region', { name: 'Current usage' })).toHaveCount(2);
  await expect(copyPath).toHaveText(path);
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
    expect(
      await copyPath.evaluate((element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        return range.getClientRects().length;
      }),
    ).toBeGreaterThan(1);
    await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBe(0);
    await expect(cards.first()).toBeInViewport({ ratio: 1 });
    await expect(cards.first().locator('.daddy-work-state')).not.toBeEmpty();
    await expect(cards.last()).not.toBeInViewport();

    await page.getByRole('region', { name: 'Session overview' }).focus();
    await page.keyboard.press('End');
    await expect(copyPath).toBeInViewport({ ratio: 1 });
    await expect(cards.first()).toBeInViewport({ ratio: 1 });

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

  await page.addStyleTag({ content: ':root { font-size: 20px; }' });
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
});
test('shows message send errors without scrolling on short screens', async ({ page }) => {
  const message = 'The server is temporarily unavailable';
  await mockTwoProviders(page);
  await page.route('**/api/daddy/sessions/*/chat', (route) =>
    route.fulfill({ status: 503, json: { error: { code: 'unavailable', message } } }),
  );
  await login(page);
  await create(page, 'Send failure on a short screen', Date.now());
  await expect(page.getByRole('region', { name: 'Current usage' })).toHaveCount(2);

  const overview = page.getByRole('region', { name: 'Session overview' });
  const composer = page.getByLabel('Message daddy');
  const alert = page.getByRole('alert').filter({ hasText: message });
  for (const viewport of [
    { width: 390, height: 540 },
    { width: 1024, height: 480 },
  ]) {
    await page.setViewportSize(viewport);
    expect(await overview.evaluate((element) => element.scrollTop)).toBe(0);
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
    expect(await overview.evaluate((element) => element.scrollTop)).toBe(0);

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
    await expect(page.getByRole('region', { name: 'Current usage' })).toHaveCount(2);
    const overview = page.getByRole('region', { name: 'Session overview' });
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
      expect(await overview.evaluate((element) => element.scrollTop)).toBe(0);
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
