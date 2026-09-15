import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

test('registers a GitLab URL from the phone UI and preserves its source, subfolder and module when editing', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page
    .getByLabel('Local access token')
    .fill(readFileSync('.daddyloop/e2e/access-token', 'utf8'));
  await page.getByRole('button', { name: 'Connect to workspace' }).click();
  await page.getByRole('button', { name: 'Sessions', exact: true }).click();
  await page.getByRole('button', { name: 'New session', exact: true }).click();
  await page.getByRole('button', { name: 'Add another workspace', exact: true }).click();
  await page.getByRole('button', { name: 'Add workspace', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Workspace name').fill('Remote GitLab fixture');
  await dialog
    .getByLabel('Repository URL or server folder')
    .fill('https://code.example.test/team/sub/app.git');
  await dialog.getByText('Repository settings (advanced)', { exact: true }).click();
  await dialog.getByLabel('Repository service').selectOption('gitlab');
  await dialog.getByLabel('Subfolder (optional)').fill('src');
  const saved = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/workspaces') && response.request().method() === 'POST',
  );
  await dialog.getByRole('button', { name: 'Save workspace', exact: true }).click();
  const result = await saved;
  expect(result.status()).toBe(201);
  expect(await result.json()).toMatchObject({
    repoPath: 'https://code.example.test/team/sub/app.git',
    scope: 'src',
    provider: 'gitlab',
    copyMode: 'session',
  });
  await expect(page.getByRole('dialog', { name: 'New daddy session' })).toBeVisible();
  await expect(
    page.getByRole('checkbox', { name: 'Create copies for this session automatically' }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Add another workspace', exact: true }).click();
  await page.getByRole('button', { name: 'Edit workspace Remote GitLab fixture' }).click();
  await expect(page.getByLabel('Repository URL or server folder')).toHaveValue(
    'https://code.example.test/team/sub/app.git',
  );
  await page.getByText('Repository settings (advanced)', { exact: true }).click();
  await expect(page.getByLabel('Repository service')).toHaveValue('gitlab');
  await expect(page.getByLabel('Subfolder (optional)')).toHaveValue('src');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
