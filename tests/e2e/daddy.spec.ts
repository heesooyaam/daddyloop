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
  await fields.locator('summary').click();
  const alternate = resolve('.daddyloop/e2e/fixture-repository-alternate');
  await fields.getByLabel('Repository on this server').fill(alternate);
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
  await expect(fields.getByLabel('Repository on this server')).toHaveValue(
    board.workspace.repoPath,
  );
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
  await page
    .getByText('Detected repositories', { exact: true })
    .click()
    .catch(() => {});
  const repoButton = page
    .getByRole('dialog')
    .getByRole('button', { name: 'fixture-repository', exact: true });
  if (await repoButton.isVisible()) await repoButton.click();
  await expect(page.getByLabel('Server directory')).toBeVisible();
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
