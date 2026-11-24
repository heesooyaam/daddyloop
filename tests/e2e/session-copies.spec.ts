import { test, expect, type Locator } from '@playwright/test';
import { readFileSync } from 'node:fs';
import type { ReviewGroup } from '../../src/core/types.js';
import { translator } from '../../src/i18n/index.js';

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

for (const locale of ['en', 'ru'] as const) {
  test(`keeps ${locale} session notices visible with resource waits and two usage providers`, async ({
    page,
  }) => {
    const t = translator(locale);
    const title = `Resource status fixture (${locale})`;
    const path = `/fixtures/${'unavailable-repository-'.repeat(10)}removed`;
    const error = `git -C ${path} rev-parse --show-toplevel\nfatal: cannot change to '${path}': No such file or directory`;
    const sendError = `ENOENT: no such file or directory, chdir '/fixtures' -> '${path}'`;
    const failure = { status: 503, json: { error: { message: sendError } } };
    const copyFailure = { state: 'error', error } as const;
    type StatusFields = Pick<ReviewGroup, 'workspacePreparation' | 'deletion' | 'daddyState'>;
    let status: StatusFields = {};
    let failLoad = false;
    await login(page);
    await page.route('**/api/preferences', async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, json: { ...(await response.json()), locale } });
    });
    await page.route('**/api/status', async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      await route.fulfill({
        response,
        json: { ...body, preferences: { ...body.preferences, locale } },
      });
    });
    await page.route('**/api/usage', async (route) => {
      const response = await route.fetch();
      const {
        agents: [codex],
      } = await response.json();
      await route.fulfill({
        response,
        json: { agents: [codex, { ...codex, engine: 'claude', name: 'Claude' }] },
      });
    });
    await page.route('**/api/daddy/sessions/*', async (route) => {
      const response = await route.fetch();
      const board = await response.json();
      if (board.group?.title !== title) return route.fulfill({ response, json: board });
      if (failLoad) return route.fulfill(failure);
      await route.fulfill({
        response,
        json: {
          ...board,
          group: {
            ...board.group,
            workspacePreparation: { state: 'ready' },
            ...status,
            resourceWait: {
              state: 'repairing',
              since: new Date().toISOString(),
              reasons: ['Disk-space threshold reached'],
            },
          },
        },
      });
    });
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('lang', locale);
    await page.getByRole('button', { name: t('New session'), exact: true }).click();
    await page.getByLabel(t('Session name (optional)')).fill(title);
    await page.getByRole('button', { name: t('Start session'), exact: true }).click();
    await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();

    const resource = page.getByText(t('Waiting for server resources'), { exact: true });
    const expectRetry = async (notice: Locator, label: string) => {
      const button = notice.getByRole('button', { name: t(label), exact: true });
      await expect(button).toBeInViewport({ ratio: 0.99 });
      expect(
        await button.evaluate((element) => {
          const text = document.createRange();
          text.selectNodeContents(element);
          return text.getClientRects().length;
        }),
      ).toBe(1);
    };
    const expectFullReason = async (notice: Locator, reason: string) => {
      const details = notice.getByText(t('Error details'), { exact: true });
      const diagnosis = notice.locator('pre');
      await expect(diagnosis).toBeHidden();
      await details.click();
      await expect(diagnosis).toBeVisible();
      expect(await diagnosis.textContent()).toBe(reason);
      expect(
        await diagnosis.evaluate((element) => element.scrollWidth <= element.clientWidth),
      ).toBe(true);
      await details.click();
    };
    const cases: { status: StatusFields; notice: string; retry?: string }[] = [
      {
        status: { workspacePreparation: { state: 'pending' } },
        notice: 'Preparing the session copy',
      },
      {
        status: { workspacePreparation: { state: 'preparing' } },
        notice: 'Preparing the session copy',
      },
      {
        status: { workspacePreparation: copyFailure },
        notice: 'Could not prepare the session copy',
        retry: 'Retry',
      },
      {
        status: { daddyState: 'paused', workspacePreparation: copyFailure },
        notice: 'Could not prepare the session copy',
        retry: 'Retry',
      },
      {
        status: { deletion: { state: 'pending' } },
        notice: 'Saving results and removing session copies',
      },
      {
        status: { deletion: { state: 'running' } },
        notice: 'Saving results and removing session copies',
      },
      {
        status: { deletion: { state: 'error', error } },
        notice: 'Session deletion stopped; working copies were preserved',
        retry: 'Retry deletion',
      },
    ];
    const viewports = [
      [667, 375],
      [390, 540],
      [844, 390],
      [320, 540],
    ];
    for (const example of cases) {
      status = example.status;
      await page.reload();
      await expect(page.getByRole('region', { name: t('Current usage') })).toHaveCount(2);
      const notice = page.getByRole('status').filter({ hasText: t(example.notice) });
      for (const [width, height] of viewports) {
        await test.step(`${example.notice} at ${width} × ${height}`, async () => {
          await page.setViewportSize({ width, height });
          await expect(notice).toBeInViewport({ ratio: 0.99 });
          await expect(resource).toBeInViewport({ ratio: 0.99 });
          if (example.retry) await expectRetry(notice, example.retry);
          expect(
            await page.evaluate(
              () => !window.scrollY && !document.querySelector('main')?.scrollTop,
            ),
          ).toBe(true);
        });
      }
      if (example.retry) await expectFullReason(notice, error);
    }

    status = { workspacePreparation: copyFailure };
    await page.setViewportSize({ width: 1024, height: 900 });
    await page.reload();
    await expect(
      page.getByText(
        t(
          'The monitor has asked daddy to recover resources. Your messages and working files are saved.',
        ),
        { exact: true },
      ),
    ).toBeVisible();
    await page.route('**/api/daddy/sessions/*/chat', (route) => route.fulfill(failure));
    await page.getByLabel(t('Message daddy')).fill('Fixture message');
    await page.getByRole('button', { name: t('Send message'), exact: true }).click();
    const alert = page.getByRole('alert').filter({ hasText: t('Request failed') });
    const copy = page
      .getByRole('status')
      .filter({ hasText: t('Could not prepare the session copy') });
    for (const [width, height] of viewports) {
      await page.setViewportSize({ width, height });
      await expectRetry(alert, 'Retry');
      await expectRetry(copy, 'Retry');
      await expect(resource).toBeInViewport({ ratio: 0.99 });
      expect(
        await page.evaluate(() => !window.scrollY && !document.querySelector('main')?.scrollTop),
      ).toBe(true);
    }
    await expectFullReason(alert, sendError);

    failLoad = true;
    await page.reload();
    await expectRetry(alert, 'Retry');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });
}
