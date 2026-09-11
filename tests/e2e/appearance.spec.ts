import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
async function login(page: Page) {
  await page.goto('/');
  await page
    .getByLabel('Local access token')
    .fill(readFileSync('.daddyloop/e2e/access-token', 'utf8'));
  await page.getByRole('button', { name: 'Connect to workspace' }).click();
  await expect(page.locator('.daddy-app')).toBeVisible();
}
test('offers eight readable themes, preserves drafts and remembers a browser choice', async ({
  page,
}) => {
  await login(page);
  await page.getByRole('button', { name: 'New session', exact: true }).click();
  await page.getByLabel('Session name (optional)').fill('Theme draft');
  await page.getByLabel('What should daddy do?').fill('Keep this conversation open');
  await page.getByRole('button', { name: 'Start session', exact: true }).click();
  await page.getByLabel('Message daddy').fill('Keep this draft while changing colors');
  const writes: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST') writes.push(request.url());
  });
  for (const name of [
    'Glacier',
    'Pearl',
    'Mint',
    'Lilac',
    'Graphite',
    'Midnight',
    'Forest',
    'Plum',
  ]) {
    await page.getByRole('button', { name: 'Change theme' }).click();
    await expect(page.getByRole('radio')).toHaveCount(9);
    await page.getByRole('radio', { name, exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', name.toLowerCase());
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    const ratios = await page.evaluate(() => {
      const lum = (color: string) => {
        const v = color
          .match(/[\d.]+/g)!
          .slice(0, 3)
          .map(Number)
          .map((x) => x / 255)
          .map((x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
        return v[0] * 0.2126 + v[1] * 0.7152 + v[2] * 0.0722;
      };
      const ratio = (a: string, b: string) => {
        const x = lum(a),
          y = lum(b);
        return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
      };
      const element = document.querySelector('.daddy-app')!,
        body = getComputedStyle(element);
      const helper = document.createElement('span');
      helper.style.color = 'var(--muted)';
      element.append(helper);
      const muted = getComputedStyle(helper).color;
      helper.remove();
      return [ratio(body.color, body.backgroundColor), ratio(muted, body.backgroundColor)];
    });
    expect(ratios[0], name).toBeGreaterThanOrEqual(4.5);
    expect(ratios[1], name + ' muted').toBeGreaterThanOrEqual(4.5);
  }
  expect(writes).toEqual([]);
  await expect(page.getByLabel('Message daddy')).toHaveValue(
    'Keep this draft while changing colors',
  );
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'plum');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('region', { name: 'Current usage' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test('follows system appearance and allows selecting a theme before login', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'graphite');
  await page.getByRole('button', { name: 'Change theme' }).click();
  await page.getByRole('radio', { name: 'Mint', exact: true }).click();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'mint');
  await page.getByRole('button', { name: 'Change theme' }).click();
  await page.getByRole('radio', { name: /Follow system/ }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'graphite');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'glacier');
});
test('shows all quota windows without a click and marks last-known readings after disconnect', async ({
  page,
}) => {
  await login(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const strip = page.getByRole('region', { name: 'Current usage' });
  await expect(strip.getByRole('progressbar')).toHaveCount(2);
  await expect(strip.getByText('68%', { exact: true })).toBeVisible();
  await expect(strip.getByText('27%', { exact: true })).toBeVisible();
  await expect(strip.getByText('Resets available: 3')).toBeVisible();
  await page.route('**/api/usage', (route) => route.abort());
  await expect(strip.getByText('Last known usage')).toBeVisible({ timeout: 10000 });
  await expect(strip.getByText('27%', { exact: true })).toBeVisible();
});
