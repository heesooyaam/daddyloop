import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import type { ReviewGroup } from '../../src/core/types.js';

async function login(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page
    .getByLabel('Local access token')
    .fill(readFileSync('.daddyloop/e2e/access-token', 'utf8'));
  await page.getByRole('button', { name: 'Connect to workspace' }).click();
  await expect(page.locator('.daddy-app')).toBeVisible();
}
test('offers automatic Arc session copies and sends the selected mode', async ({ page }) => {
  await page.route('**/api/workspaces', async (route) => {
    const response = await route.fetch();
    const [workspace] = await response.json();
    await route.fulfill({
      json: [
        { ...workspace, name: 'Work', vcs: 'arcadia', provider: 'arcadia', copyMode: 'session' },
      ],
    });
  });
  let creation: Record<string, any> | undefined;
  await page.route('**/api/daddy/sessions', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    creation = route.request().postDataJSON();
    await route.fulfill({
      status: 422,
      json: { message: 'Fixture: no native Arc calls in browser tests' },
    });
  });
  await login(page);
  await page.getByRole('button', { name: 'New session', exact: true }).click();
  const checkbox = page.getByRole('checkbox', {
    name: 'Create copies for this session automatically',
  });
  await expect(checkbox).toBeChecked();
  await checkbox.uncheck();
  await page.getByLabel('What should daddy do?').fill('Fixture task');
  await page.getByRole('button', { name: 'Start session', exact: true }).click();
  await expect.poll(() => creation?.repository?.copyMode).toBe('pool');
});
test('keeps copy preparation and retry visible and shows the ready path in session settings', async ({
  page,
}) => {
  const title = 'Session copy status fixture';
  const copyPath = '/fixture/session-copies/' + 'a'.repeat(100);
  const error = 'Fixture: copy preparation failed';
  let preparation: ReviewGroup['workspacePreparation'] = { state: 'preparing' };
  await page.route('**/api/daddy/sessions/*', async (route) => {
    const response = await route.fetch();
    const board = await response.json();
    if (board.group?.title === title) board.group.workspacePreparation = preparation;
    await route.fulfill({ response, json: board });
  });
  await login(page);
  await page.getByRole('button', { name: 'New session', exact: true }).click();
  await page.getByLabel('Session name (optional)').fill(title);
  await page.getByRole('button', { name: 'Start session', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  const progress = page.getByRole('status').filter({ hasText: 'Preparing the session copy' });
  await expect(progress).toBeVisible();

  preparation = { state: 'error', error };
  const failure = page
    .getByRole('status')
    .filter({ hasText: 'Could not prepare the session copy' });
  await expect(failure.getByText(error, { exact: true })).toBeVisible();
  const retried = page.waitForResponse(
    (response) => response.url().endsWith('/resume') && response.request().method() === 'POST',
  );
  await failure.getByRole('button', { name: 'Retry', exact: true }).click();
  expect((await retried).ok()).toBe(true);

  preparation = { state: 'ready', path: copyPath };
  await expect(failure).toHaveCount(0);
  await expect(progress).toHaveCount(0);
  await expect(page.getByText('Session copy ready', { exact: true })).toHaveCount(0);
  await expect(page.getByText(copyPath, { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Session settings' }).click();
  const settings = page.getByRole('dialog', { name: 'Session settings' });
  await expect(settings.getByText('Session copy ready', { exact: true })).toBeVisible();
  await expect(settings.getByText(copyPath, { exact: true })).toBeVisible();
  expect(await settings.evaluate((dialog) => dialog.scrollWidth <= dialog.clientWidth)).toBe(true);
});

test('confirms session deletion, sends its generation and clears the deleted selection', async ({
  page,
}) => {
  let sessionId = '',
    generation = 0,
    deleted = false;
  const removals: unknown[] = [];
  await page.route('**/api/daddy/sessions', async (route) => {
    if (route.request().method() === 'POST') {
      const input = route.request().postDataJSON();
      const response = await route.fetch({ postData: { ...input, message: undefined } });
      const board = await response.json();
      sessionId = board.group.id;
      generation = board.group.generation;
      await route.fulfill({ json: { ...board, canDelete: true } });
    } else {
      const response = await route.fetch();
      const sessions = await response.json();
      await route.fulfill({
        json: deleted ? sessions.filter((session: any) => session.id !== sessionId) : sessions,
      });
    }
  });
  await page.route('**/api/daddy/sessions/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/delete')) {
      removals.push(route.request().postDataJSON());
      deleted = true;
      return route.fulfill({ status: 202, json: { accepted: true } });
    }
    const response = await route.fetch();
    const board = await response.json();
    await route.fulfill({
      json: board.group?.id === sessionId ? { ...board, canDelete: true } : board,
    });
  });
  await login(page);
  await page.getByRole('button', { name: 'New session', exact: true }).click();
  await page.getByLabel('What should daddy do?').fill('No model calls');
  await page.getByLabel('Session name (optional)').fill('Deletion UI fixture');
  await page.getByRole('button', { name: 'Start session', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Deletion UI fixture', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Delete session', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(removals).toHaveLength(0);
  await page.getByRole('button', { name: 'Delete session', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Delete session', exact: true })
    .click();
  await expect.poll(() => removals).toEqual([{ expectedGeneration: generation }]);
  await expect(page.getByRole('heading', { name: 'Deletion UI fixture', exact: true })).toHaveCount(
    0,
  );
});

test('explains resource waits on a phone instead of leaving the conversation silently pending', async ({
  page,
}) => {
  await page.route('**/api/daddy/sessions/**', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    if (!body.group) return route.fulfill({ json: body });
    await route.fulfill({
      json: {
        ...body,
        group: {
          ...body.group,
          resourceWait: {
            state: 'repairing',
            since: new Date().toISOString(),
            reasons: ['Disk-space threshold reached'],
          },
        },
      },
    });
  });
  await login(page);
  await page.getByRole('button', { name: 'New session', exact: true }).click();
  await page.getByLabel('Session name (optional)').fill('Resource status fixture');
  await page.getByRole('button', { name: 'Start session', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByText('Waiting for server resources', { exact: true })).toBeVisible();
  await expect(
    page.getByText(
      'The monitor has asked daddy to recover resources. Your messages and working files are saved.',
      { exact: true },
    ),
  ).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
