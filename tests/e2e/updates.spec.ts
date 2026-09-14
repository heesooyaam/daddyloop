import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
test('selects and confirms updates for Claude and a third agent, with rollback and no cross-engine change', async ({
  page,
}) => {
  await page.goto('/');
  await page
    .getByLabel('Local access token')
    .fill(readFileSync('.daddyloop/e2e/access-token', 'utf8'));
  await page.getByRole('button', { name: 'Connect to workspace' }).click();
  await page.getByRole('button', { name: 'CLI updates', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'CLI updates' });
  for (const name of ['Claude Code', 'Atlas']) {
    const card = dialog
      .locator('.runtime-card')
      .filter({ has: page.locator('strong').filter({ hasText: new RegExp('^' + name + '$') }) });
    await card.getByRole('button', { name: 'Update ' + name, exact: true }).click();
    const confirm = dialog.getByRole('region', { name: 'Confirm CLI change' });
    await expect(confirm).toContainText('1.0.0');
    await expect(confirm).toContainText('2.0.0');
    await expect(confirm.getByText('Update ' + name, { exact: true })).toBeVisible();
    await confirm.getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect(card.getByRole('status')).toContainText(name + ' version selected');
  }
  await dialog.getByRole('button', { name: 'Check for CLI updates' }).click();
  const statuses = await (await page.request.get('/api/runtimes')).json();
  expect(statuses.find((item: any) => item.engine === 'codex').operation).toBeUndefined();
  expect(statuses.find((item: any) => item.engine === 'claude').operation.target.version).toBe(
    '2.0.0',
  );
  const claude = dialog
    .locator('.runtime-card')
    .filter({ has: page.locator('strong').filter({ hasText: /^Claude Code$/ }) });
  await claude.getByRole('button', { name: 'Roll back to 1.0.0' }).click();
  await dialog
    .getByRole('region', { name: 'Confirm CLI change' })
    .getByRole('button', { name: 'Confirm', exact: true })
    .click();
  await expect(claude.getByRole('button', { name: 'Roll back to 2.0.0' })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
