import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const root = resolve('.daddyloop/e2e/fixture-repository');
const alternate = resolve('.daddyloop/e2e/fixture-repository-alternate');
async function login(page: Page) {
  await page.goto('/');
  await page
    .getByLabel('Local access token')
    .fill(readFileSync('.daddyloop/e2e/access-token', 'utf8'));
  await page.getByRole('button', { name: 'Connect to workspace' }).click();
  await expect(page.locator('.daddy-app')).toBeVisible();
}
test('the reported weekly/Spark/zero-credit layout explains balances and opens the clicked provider', async ({
  page,
}) => {
  // Exercise the empty dashboard, independent of sessions created by earlier scenarios.
  await page.route('**/api/daddy/sessions', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/usage*', (route) =>
    route.fulfill({
      json: {
        agents: [
          {
            engine: 'codex',
            name: 'Codex',
            source: 'fixture',
            available: true,
            stale: false,
            buckets: [
              {
                id: 'codex',
                name: 'Codex',
                windows: [{ remainingPercent: 82, durationMinutes: 10080 }],
                credits: { hasCredits: false, unlimited: false, balance: '0' },
              },
              {
                id: 'spark',
                name: 'GPT-5.3-Codex-Spark',
                windows: [
                  { remainingPercent: 100, durationMinutes: 300 },
                  { remainingPercent: 100, durationMinutes: 10080 },
                ],
              },
            ],
            resets: { availableCount: 2, canUse: true, credits: [] },
          },
          {
            engine: 'claude',
            name: 'Claude',
            source: 'fixture',
            available: false,
            stale: false,
            buckets: [],
            resets: { availableCount: null, canUse: false, credits: [] },
          },
        ],
      },
    }),
  );
  await login(page);
  await expect(page.getByRole('heading', { name: 'Your dashboard' })).toBeVisible();
  await expect(page.getByText('Shared account · remaining')).toHaveCount(0);
  const codex = page.getByRole('region', { name: 'Current usage' }).first();
  await expect(codex.getByRole('progressbar')).toHaveCount(3);
  await expect(codex.getByText('82% left')).toBeVisible();
  await expect(codex.locator('.daddy-credit-summary')).toHaveCount(0);
  await codex
    .getByRole('button', { name: 'Details: GPT-5.3-Codex-Spark, 5 hours', exact: true })
    .click();
  let dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('Agent usage')).toHaveValue('codex');
  await expect(dialog.getByText('Credit balance: 0')).toBeVisible();
  await expect(
    dialog.getByText('Credits are a separate payment balance', { exact: false }),
  ).toBeVisible();
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  const unavailable = page.locator('.daddy-usage-strip.unavailable');
  expect((await unavailable.boundingBox())!.height).toBeLessThan(80);
  await unavailable.getByRole('button', { name: 'View Claude limits' }).click();
  dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('Agent usage')).toHaveValue('claude');
  await expect(dialog.getByRole('button', { name: 'Use a reset', exact: true })).toBeDisabled();
});
test('workspace cards separate names, repository types and server paths', async ({ page }) => {
  await page.route('**/api/workspaces', async (route) => {
    const response = await route.fetch();
    const [workspace] = await response.json();
    await route.fulfill({
      json: [
        {
          ...workspace,
          name: 'Work',
          vcs: 'arcadia',
          provider: 'arcadia',
          repoPath: '/home/fixture/arcadia2',
        },
        {
          ...workspace,
          id: '8c01f84f-2e92-43d6-b889-954560053555',
          name: 'daddyloop',
          provider: 'github',
        },
      ],
    });
  });
  await login(page);
  await page.getByRole('button', { name: /Workspaces/ }).click();
  const card = page.getByRole('button', { name: 'Edit workspace Work', exact: true });
  const title = (await card.locator('strong').boundingBox())!,
    kind = (await card.locator('small').boundingBox())!;
  expect(kind.y).toBeGreaterThanOrEqual(title.y + title.height + 5);
  await expect(card.getByText('Arcadia', { exact: true })).toBeVisible();
  await expect(card.getByText('/home/fixture/arcadia2')).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test('starting a session focuses on the goal, and folder edits require apply or cancel', async ({
  page,
}) => {
  await login(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Sessions', exact: true }).click();
  await page.getByRole('button', { name: 'New session', exact: true }).click();
  const dialog = page.getByRole('dialog'),
    goal = dialog.getByLabel('What should daddy do?');
  await expect(goal).toBeFocused();
  await goal.fill('Keep this goal while I inspect the folder');
  expect((await goal.boundingBox())!.y).toBeLessThan(
    (await dialog.getByLabel('Workspace', { exact: true }).boundingBox())!.y,
  );
  await expect(dialog.getByLabel('Repository on this server')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Change folder for this session' }).click();
  await expect(dialog.getByRole('button', { name: 'Start session', exact: true })).toBeDisabled();
  await expect(dialog.getByLabel('Base branch (optional)')).not.toBeVisible();
  await dialog
    .getByLabel('Repository on this server')
    .fill(resolve('.daddyloop/e2e/not-a-repository'));
  await dialog.getByRole('button', { name: 'Apply settings' }).click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  await expect(goal).toHaveValue('Keep this goal while I inspect the folder');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Start session', exact: true })).toBeEnabled();
  await expect(dialog.locator('.daddy-repository-summary code')).toHaveText(root);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test('folder navigation never submits a form and adding a workspace keeps the new task draft', async ({
  page,
}) => {
  await login(page);
  await page.getByRole('button', { name: 'New session', exact: true }).click();
  await page.getByLabel('What should daddy do?').fill('Do not lose this task draft');
  await page.getByLabel('Session name (optional)').fill('Saved draft');
  await page.getByRole('button', { name: 'Add another workspace' }).click();
  await page.getByRole('button', { name: 'Add workspace', exact: true }).click();
  await page.getByLabel('Workspace name').fill('Another workspace');
  await page.getByRole('button', { name: 'Browse server folders' }).click();
  const browser = page.getByRole('region', { name: 'Choose a folder on this server' });
  const writes: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST') writes.push(request.url());
  });
  await browser.getByLabel('Server directory').fill(alternate);
  await browser.getByLabel('Server directory').press('Enter');
  await expect(browser.getByRole('button', { name: 'Select this folder' })).toBeEnabled();
  await expect(page.getByLabel('Repository on this server')).toHaveValue('');
  expect(writes).toHaveLength(0);
  await browser.getByRole('button', { name: 'Open folder src', exact: true }).click();
  await expect(browser.getByRole('button', { name: 'Select this folder' })).toBeEnabled();
  await expect(browser.getByText('This folder has no subfolders.', { exact: false })).toBeVisible();
  await browser.getByRole('button', { name: 'Parent folder', exact: true }).click();
  await expect(browser.getByRole('button', { name: 'Select this folder' })).toBeEnabled();
  await browser.getByRole('button', { name: 'Select this folder' }).click();
  await expect(page.getByLabel('Repository on this server')).toHaveValue(alternate);
  await expect(browser).toHaveCount(0);
  expect(writes).toHaveLength(0);
  await page.getByRole('button', { name: 'Save workspace', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'New daddy session' })).toBeVisible();
  await expect(page.getByLabel('What should daddy do?')).toHaveValue('Do not lose this task draft');
  await expect(page.getByLabel('Session name (optional)')).toHaveValue('Saved draft');
  await expect(page.getByRole('dialog').locator('.daddy-repository-summary code')).toHaveText(
    alternate,
  );
  expect(writes.filter((url) => url.endsWith('/api/workspaces'))).toHaveLength(1);
});
test('cancelling a pending folder preview keeps the previous selection', async ({ page }) => {
  await login(page);
  await page.getByRole('button', { name: 'New session', exact: true }).click();
  const dialog = page.getByRole('dialog');
  const original = await dialog.locator('.daddy-repository-summary code').textContent();
  await dialog.getByLabel('What should daddy do?').fill('Keep this goal after cancellation');
  await dialog.getByRole('button', { name: 'Change folder for this session' }).click();
  await dialog.getByLabel('Repository on this server').fill(root);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/workspaces/preview', async (route) => {
    await pending;
    await route.continue().catch(() => {});
  });
  const request = page.waitForRequest('**/api/workspaces/preview');
  await dialog.getByRole('button', { name: 'Apply settings' }).click();
  await request;
  await expect(dialog.getByRole('button', { name: 'Start session', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  release();
  await expect(dialog.locator('.daddy-repository-summary code')).toHaveText(original!);
  await expect(dialog.getByRole('button', { name: 'Start session', exact: true })).toBeEnabled();
  await expect(dialog.getByLabel('What should daddy do?')).toHaveValue(
    'Keep this goal after cancellation',
  );
});
