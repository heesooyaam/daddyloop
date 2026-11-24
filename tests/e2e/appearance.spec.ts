import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { translator } from '../../src/i18n/index.js';
import type { UsageView } from '../../src/core/usage.js';
async function login(page: Page) {
  await page.goto('/');
  await page
    .getByLabel('Local access token')
    .fill(readFileSync('.daddyloop/e2e/access-token', 'utf8'));
  await page.getByRole('button', { name: 'Connect to workspace' }).click();
  await expect(page.locator('.daddy-app')).toBeVisible();
}
async function createSession(page: Page, name: string) {
  await page.getByRole('button', { name: 'New session', exact: true }).click();
  await page.getByLabel('Session name (optional)').fill(name);
  await page.getByLabel('What should daddy do?').fill('Keep this conversation open');
  await page.getByRole('button', { name: 'Start session', exact: true }).click();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
}
test('offers eight readable themes in general settings and preserves drafts', async ({ page }) => {
  await login(page);
  await createSession(page, 'Theme draft');
  await page.getByLabel('Message daddy').fill('Keep this draft while changing colors');
  const themeButton = page
    .locator('.daddy-sidebar-bottom')
    .getByRole('button', { name: 'Change theme', exact: true });
  await expect(
    page.locator('.daddy-topbar').getByRole('button', { name: 'Change theme', exact: true }),
  ).toHaveCount(0);
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
    await themeButton.click();
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
});
test('opens the palette and switches sessions in a short desktop window', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 540 });
  await login(page);
  await createSession(page, 'First desktop theme session');
  await createSession(page, 'Second desktop theme session');

  await page
    .locator('.daddy-sidebar-bottom')
    .getByRole('button', { name: 'Change theme', exact: true })
    .click();
  const palette = page.getByRole('dialog', { name: 'Make yourself at home' });
  await expect(palette).toBeVisible();
  await palette.getByRole('button', { name: 'Close', exact: true }).click();

  await page
    .getByRole('navigation', { name: 'Sessions' })
    .getByRole('button', { name: /First desktop theme session/ })
    .click();
  await expect(
    page.getByRole('heading', { name: 'First desktop theme session', exact: true }),
  ).toBeVisible();
});
test('opens the palette from the mobile sidebar and keeps the choice across sessions and reloads', async ({
  page,
}) => {
  await login(page);
  await createSession(page, 'First theme session');
  await createSession(page, 'Second theme session');
  await page.setViewportSize({ width: 390, height: 500 });

  const menu = page.getByRole('button', { name: 'Sessions', exact: true });
  const sidebar = page.locator('#daddy-sidebar');
  const firstItem = sidebar.getByRole('button', { name: 'New session', exact: true });
  const lastItem = sidebar.getByRole('combobox', { name: 'Language' });
  const themeButton = sidebar
    .locator('.daddy-sidebar-bottom')
    .getByRole('button', { name: 'Change theme', exact: true });
  const palette = page.getByRole('dialog', { name: 'Make yourself at home' });
  const theme = palette.getByRole('radio', { name: 'Plum', exact: true });
  const html = page.locator('html');

  await expect(themeButton).toBeHidden();
  await menu.press('Enter');
  await expect(firstItem).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(lastItem).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(firstItem).toBeFocused();
  const controls = await sidebar.locator('button, a[href], select').count();
  for (let step = 0; step < controls; step++) {
    await page.keyboard.press('Tab');
    await expect(sidebar.locator(':focus')).toHaveCount(1);
    if (await themeButton.evaluate((button) => button.matches(':focus'))) break;
  }
  await expect(themeButton).toBeFocused();
  await page.keyboard.press('Enter');
  await theme.click();
  await expect(html).toHaveAttribute('data-theme', 'plum');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(palette).toBeHidden();
  await expect(themeButton).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toBeFocused();
  await expect(menu).toHaveAttribute('aria-expanded', 'false');

  await page.keyboard.press('Enter');
  await page
    .getByRole('navigation', { name: 'Sessions' })
    .getByRole('button', { name: /First theme session/ })
    .click();
  const activeSession = page.getByRole('heading', { name: 'First theme session', exact: true });
  await expect(activeSession).toBeVisible();
  await expect(html).toHaveAttribute('data-theme', 'plum');
  await page.reload();
  await expect(activeSession).toBeVisible();
  await expect(html).toHaveAttribute('data-theme', 'plum');
  await expect(page.getByRole('button', { name: 'Agent limits' })).toBeVisible();
  await menu.click();
  await sidebar.getByRole('link', { name: 'Limits', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Agent limits' })).toBeFocused();
  await menu.press('Enter');
  await expect(firstItem).toBeFocused();
  await themeButton.click();
  await expect(theme).toHaveAttribute('aria-checked', 'true');
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
test('distinguishes the first limits read, an error and a successful empty response', async ({
  page,
}) => {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  let recovered = false;
  await page.route('**/api/usage*', async (route) => {
    if (new URL(route.request().url()).searchParams.has('refresh')) recovered = true;
    if (recovered) return route.fulfill({ json: { agents: [] } });
    await hold;
    return route.fulfill({
      status: 503,
      json: { error: { message: 'Quota service unavailable' } },
    });
  });
  await login(page);
  const indicator = page.getByRole('button', { name: 'Agent limits' });
  const details = page.getByRole('region', { name: 'Agent limit details' });
  const main = page.getByRole('main');
  try {
    await indicator.hover();
    await expect(page.getByRole('tooltip')).toHaveText('Reading agent limits…');
    await indicator.click();
    await expect(details.getByText('Reading agent limits…')).toBeVisible();
    await details.getByRole('link', { name: 'Open limits page' }).click();
    await expect(main.getByText('Reading agent limits…')).toBeVisible();
  } finally {
    release();
  }
  const reason = 'Could not read agent limits: Quota service unavailable';
  await expect(main.getByRole('alert')).toHaveText(reason);
  await main.getByRole('link', { name: 'Back to workspace' }).click();
  await indicator.hover();
  await expect(page.getByRole('tooltip')).toHaveText(reason);
  await indicator.click();
  await expect(details.getByRole('alert')).toHaveText(reason);
  await details.getByRole('link', { name: 'Open limits page' }).click();
  await main.getByRole('button', { name: 'Refresh limits' }).click();
  await expect(main.getByText('No quota readings yet')).toBeVisible();
  await expect(main.getByRole('alert')).toHaveCount(0);
});

for (const locale of ['en', 'ru'] as const) {
  test(`shows fresh ${locale} quotas and enables reset even when workspace loading fails`, async ({
    page,
  }) => {
    const t = translator(locale);
    await login(page);
    const usage = (await (await page.request.get('/api/usage')).json()) as UsageView;
    let usageFails = false;
    await page.route('**/api/preferences', (route) =>
      route.fulfill({ json: { locale, version: 1 } }),
    );
    await page.route('**/api/status', (route) =>
      route.fulfill({ status: 503, json: { error: { message: 'Server status unavailable' } } }),
    );
    await page.route('**/api/usage*', (route) => {
      if (new URL(route.request().url()).searchParams.has('refresh')) usageFails = false;
      return usageFails
        ? route.fulfill({ status: 503, json: { error: { message: 'Quota service unavailable' } } })
        : route.fulfill({ json: usage });
    });
    await page.reload();
    await expect(page.getByRole('alert')).toHaveText(/Server status unavailable/);
    await page.getByRole('link', { name: t('Limits'), exact: true }).click();
    const main = page.getByRole('main');
    const reset = main.getByRole('button', { name: t('Use a reset'), exact: true });
    const stale = main.getByText(t('These readings are outdated. Refresh before using a reset.'));
    await expect(reset).toBeEnabled();
    usageFails = true;
    await expect(stale).toBeVisible();
    await expect(reset).toBeDisabled();
    await main.getByRole('button', { name: t('Refresh limits'), exact: true }).click();
    await expect(stale).toBeHidden();
    await expect(reset).toBeEnabled();
  });
}

for (const latest of ['refresh', 'reset'] as const) {
  test(`keeps the latest quota ${latest} after an earlier manual refresh returns`, async ({
    page,
  }) => {
    const usage = (remainingPercent: number, resets: number): UsageView => ({
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
              windows: [{ remainingPercent, durationMinutes: 10080 }],
            },
          ],
          resets: { availableCount: resets, canUse: true, credits: [] },
        },
      ],
    });
    const before = usage(0, 3);
    const after = usage(100, latest === 'reset' ? 2 : 3);
    let current = before;
    let calls = 0;
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const plan = {
      id: 'cf78e04c-8d78-45b6-9e65-dde614e9f871',
      title: 'Full reset',
      availableCount: 3,
      expiresAt: new Date(Date.now() + 300000).toISOString(),
      status: 'ready',
    };
    await page.route('**/api/usage/reset/prepare', (route) => route.fulfill({ json: plan }));
    await page.route('**/api/usage/reset/' + plan.id, (route) => {
      current = after;
      return route.fulfill({
        json: { plan: { ...plan, status: 'done', outcome: 'reset' }, usage: after },
      });
    });
    await page.route('**/api/usage?refresh=1', async (route) => {
      if (++calls === 1) {
        await hold;
        return route.fulfill({ json: before, headers: { 'x-earlier-refresh': 'true' } });
      }
      current = after;
      return route.fulfill({ json: after });
    });
    await page.route('**/api/usage', (route) => route.fulfill({ json: current }));
    await login(page);
    const link = page.getByRole('link', { name: 'Limits', exact: true });
    const main = page.getByRole('main');
    const refresh = main.getByRole('button', { name: 'Refresh limits' });
    try {
      await link.click();
      await expect(main.getByText('7 days: 0% remaining')).toBeVisible();
      await refresh.click();
      await expect.poll(() => calls).toBe(1);
      await main.getByRole('link', { name: 'Back to workspace' }).click();
      await link.click();
      if (latest === 'reset') {
        await main.getByRole('button', { name: 'Use a reset', exact: true }).click();
        await main.getByRole('button', { name: 'Confirm: use one reset' }).click();
      } else {
        await refresh.click();
      }
      await expect(main.getByText('7 days: 100% remaining')).toBeVisible();
      const stale = page.waitForResponse(
        (response) => response.headers()['x-earlier-refresh'] === 'true',
      );
      release();
      await (await stale).finished();
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      expect(await main.getByText('7 days: 100% remaining').isVisible()).toBe(true);
      expect(
        await main
          .getByText(`Available resets: ${after.agents[0].resets.availableCount}`)
          .isVisible(),
      ).toBe(true);
    } finally {
      release();
    }
  });
}
