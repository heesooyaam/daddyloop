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
  await expect(page.getByRole('button', { name: 'Agent limits' })).toBeVisible();
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
test('summarizes limits on hover and focus and keeps last-known readings after disconnect', async ({
  page,
}) => {
  await login(page);
  const indicator = page.getByRole('button', { name: 'Agent limits' });
  const tooltip = page.getByRole('tooltip');
  const details = page.getByRole('region', { name: 'Agent limit details' });
  await expect(indicator).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('progressbar')).toHaveCount(0);
  await indicator.hover();
  await expect(tooltip).toHaveText('Codex · 7 days: 27% remaining');
  await page.keyboard.press('Escape');
  await expect(tooltip).toBeHidden();
  await page.mouse.move(0, 0);

  await indicator.focus();
  await expect(tooltip).toBeVisible();
  await indicator.press('Enter');
  await expect(tooltip).toBeHidden();
  await expect(details.getByRole('progressbar')).toHaveCount(2);
  await expect(details.getByText('5 hours: 68% remaining', { exact: true })).toBeVisible();
  await expect(details.getByText('Available resets: 3')).toBeVisible();
  await page.keyboard.press('Tab');
  const link = details.getByRole('link', { name: 'Open limits page' });
  await expect(link).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(details).toBeHidden();
  await expect(indicator).toBeFocused();
  await expect(tooltip).toBeHidden();

  await indicator.click();
  await page.locator('.daddy-topbar h1').click();
  await expect(details).toBeHidden();
  await page.route('**/api/usage', (route) => route.abort());
  await indicator.hover();
  await expect(tooltip).toContainText('Last known usage', { timeout: 10000 });
  await indicator.click();
  await expect(details.getByText('7 days: 27% remaining', { exact: true })).toBeVisible();
  await link.click();
  await expect(page).toHaveURL(/\/limits(?:#|$)/);
  const main = page.getByRole('main');
  await expect(main.getByRole('heading', { name: 'Agent limits' })).toBeFocused();
  await expect(main.getByText('These readings are outdated.', { exact: false })).toBeVisible();
  await expect(main.getByRole('button', { name: 'Use a reset', exact: true })).toBeDisabled();
});
test.describe('limits on a touch screen', () => {
  test.use({ hasTouch: true, viewport: { width: 320, height: 700 } });
  test('shows exhausted periods, credit-only buckets and providers without quota data', async ({
    page,
  }) => {
    await page.route('**/api/usage', async (route) => {
      await route.fulfill({
        json: {
          agents: [
            {
              engine: 'codex',
              name: 'Codex',
              source: 'fixture',
              available: true,
              stale: false,
              retrievedAt: new Date().toISOString(),
              buckets: [
                {
                  id: 'weekly',
                  name: 'Account weekly',
                  windows: [{ durationMinutes: 10080, remainingPercent: 0 }],
                },
                {
                  id: 'spark',
                  name: 'GPT-5.3-Codex-Spark',
                  windows: [
                    { durationMinutes: 300, remainingPercent: 100 },
                    { durationMinutes: 10080, remainingPercent: 71 },
                  ],
                },
                {
                  id: 'credits',
                  name: 'Workspace credits',
                  windows: [],
                  credits: { hasCredits: true, unlimited: false, balance: '42' },
                },
              ],
              resets: { availableCount: 2, canUse: true, credits: [] },
            },
            {
              engine: 'claude',
              name: 'Claude',
              source: 'events',
              available: false,
              stale: false,
              buckets: [],
              resets: { availableCount: null, canUse: false, credits: [] },
            },
          ],
        },
      });
    });
    await login(page);
    const indicator = page.getByRole('button', { name: 'Agent limits' });
    await indicator.tap();
    const details = page.getByRole('region', { name: 'Agent limit details' });
    await expect(details.getByRole('progressbar')).toHaveCount(3);
    await expect(details.getByText('7 days: 0% remaining', { exact: true })).toBeVisible();
    await expect(details.getByText('Credit balance: 42', { exact: true })).toBeVisible();
    await expect(details.getByRole('heading', { name: 'Claude' })).toBeVisible();
    await expect(details.getByText('This provider has no current quota readings.')).toBeVisible();
    const panel = await details.boundingBox();
    expect(panel!.x).toBeGreaterThanOrEqual(0);
    expect(panel!.x + panel!.width).toBeLessThanOrEqual(320);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await details.getByRole('link', { name: 'Open limits page' }).tap();
    await page.reload();
    const main = page.getByRole('main');
    await expect(main.getByText('7 days: 0% remaining', { exact: true })).toBeVisible();
    await main.getByLabel('Agent usage').selectOption('claude');
    await expect(main.getByText('This provider has no current quota readings.')).toBeVisible();
    await expect(main.getByRole('button', { name: 'Use a reset', exact: true })).toBeDisabled();
    await main.getByRole('link', { name: 'Back to workspace' }).tap();
    await expect(indicator).toHaveAttribute('aria-expanded', 'false');
  });
});
test('offers access to limits when the server has never returned readings', async ({ page }) => {
  await page.route('**/api/usage', (route) => route.abort());
  await login(page);
  const indicator = page.getByRole('button', { name: 'Agent limits' });
  await indicator.hover();
  await expect(page.getByRole('tooltip')).toHaveText('No quota readings yet');
  await indicator.click();
  const details = page.getByRole('region', { name: 'Agent limit details' });
  await expect(details.getByText('No quota readings yet')).toBeVisible();
  await details.getByRole('link', { name: 'Open limits page' }).click();
  await expect(page.getByRole('main').getByText('No quota readings yet')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Refresh limits' })).toBeEnabled();
});
