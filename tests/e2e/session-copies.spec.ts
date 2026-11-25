import { test, expect, type Locator, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import type { DaddyBoard } from '../../src/client/daddy.js';
import { mockTwoProviders } from './usage-helpers.js';
import type { ReviewGroup } from '../../src/core/types.js';
import { translator } from '../../src/i18n/index.js';

async function login(page: Page) {
  await page.goto('/');
  await page
    .getByLabel('Local access token')
    .fill(readFileSync('.daddyloop/e2e/access-token', 'utf8'));
  await page.getByRole('button', { name: 'Connect to workspace' }).click();
  await expect(page.locator('.daddy-app')).toBeVisible();
}
async function createFixtureSession(page: Page, title: string) {
  const [workspace] = await (await page.request.get('/api/workspaces')).json();
  const response = await page.request.post('/api/daddy/sessions', {
    headers: { 'X-daddyloop-Request': '1' },
    data: { workspaceId: workspace.id, title },
  });
  await expect(response).toBeOK();
  return ((await response.json()) as DaddyBoard).group;
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
  const failure = page.getByRole('alert').filter({ hasText: 'Could not prepare the session copy' });
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
  const limits = page.getByRole('button', { name: 'Agent limits', exact: true });
  await limits.hover();
  await expect(page.getByRole('tooltip')).toBeVisible();
  await limits.click();
  await page.getByRole('link', { name: 'Open limits page', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Agent limits', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Back to workspace', exact: true }).click();
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
    };
    const expectFullReason = async (notice: Locator, reason: string) => {
      await notice.getByRole('button', { name: t('View details'), exact: true }).click();
      const dialog = page.getByRole('dialog');
      await expect(dialog.locator('.daddy-notice-detail-text')).toHaveText(reason);
      await page.keyboard.press('Escape');
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
      const indicator = page.getByRole('button', { name: t('Agent limits'), exact: true });
      await expect(indicator).toBeVisible();
      const notice = page
        .getByRole(example.retry ? 'alert' : 'status')
        .filter({ hasText: t(example.notice) });
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
      if (example.retry) {
        await indicator.click();
        const details = page.getByRole('region', { name: t('Agent limit details') });
        await expect(details.getByRole('heading', { name: 'Codex', exact: true })).toBeVisible();
        await expect(details.getByRole('heading', { name: 'Claude', exact: true })).toBeVisible();
        await indicator.click();
      }
    }

    status = { workspacePreparation: copyFailure };
    await page.setViewportSize({ width: 1024, height: 900 });
    await page.reload();
    await expect(resource).toBeVisible();
    await page.route('**/api/daddy/sessions/*/chat', (route) => route.fulfill(failure));
    await page.getByLabel(t('Message daddy')).fill('Fixture message');
    await page.getByRole('button', { name: t('Send message'), exact: true }).click();
    const alert = page.getByRole('alert').filter({ hasText: t('Request failed') });
    const copy = page
      .getByRole('alert')
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

test('closes session dialogs and task reports when history switches the selected session', async ({
  page,
}) => {
  await login(page);
  const a = await createFixtureSession(page, 'History limits session');
  const b = await createFixtureSession(page, 'History chat session');
  const task = await page.request.post(`/api/daddy/sessions/${b.id}/tasks`, {
    headers: { 'X-daddyloop-Request': '1' },
    data: { requirements: 'History task fixture', requestId: crypto.randomUUID() },
  });
  await expect(task).toBeOK();
  const removals: string[] = [];
  await page.route('**/api/daddy/sessions/*/delete', (route) => {
    removals.push(new URL(route.request().url()).pathname);
    return route.fulfill({ status: 202, json: { accepted: true } });
  });
  await page.route(`**/api/daddy/sessions/${b.id}`, async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...(await response.json()), canDelete: true } });
  });
  await page.goto(`/limits#session/${a.id}`);
  const dialog = page.getByRole('dialog');
  await page
    .getByRole('navigation', { name: 'Sessions' })
    .getByRole('button', { name: /History chat session/ })
    .click();
  const title = page.getByRole('heading', { name: b.title, exact: true });
  for (const control of [
    'Delete session',
    'Session settings',
    /^Workers \d/,
    'Queue a task',
    'History task fixture',
  ]) {
    await expect(title).toBeVisible();
    if (control === 'History task fixture') {
      await page.locator('.daddy-work-item').getByText(control, { exact: true }).click();
    } else {
      await page.getByRole('button', { name: control, exact: true }).click();
    }
    await expect(dialog).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(
      (url) => url.pathname === '/limits' && url.hash === `#session/${a.id}`,
    );
    await expect(dialog).toHaveCount(0);
    await page.goForward();
    await expect(title).toBeVisible();
    await expect(dialog).toHaveCount(0);
  }
  expect(removals).toEqual([]);
});

for (const width of [390, 1280]) {
  test(`scrolls to newly loaded messages on return from limits at ${width}px and preserves an unchanged position`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 540 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await login(page);
    const session = await createFixtureSession(page, `Long chat at ${width}px`);
    let count = 45;
    await page.route(`**/api/daddy/sessions/${session.id}`, async (route) => {
      const response = await route.fetch();
      await route.fulfill({
        response,
        json: {
          ...(await response.json()),
          messages: Array.from({ length: count }, (_, index) => ({
            id: String(index),
            sender: 'agent',
            text: `Fixture message ${index + 1}`,
            at: new Date(0).toISOString(),
          })),
        },
      });
    });
    await page.goto(`/limits#session/${session.id}`);
    const chat = page.locator('.daddy-chat-scroll');
    const back = page.getByRole('link', { name: 'Back to workspace' });
    const scrollTop = () => chat.evaluate((node) => node.scrollTop);
    const distanceFromEnd = () =>
      chat.evaluate((node) => node.scrollHeight - node.clientHeight - node.scrollTop);
    const openLimits = async () => {
      if (width === 390) await page.getByRole('button', { name: 'Sessions', exact: true }).click();
      await page.getByRole('link', { name: 'Limits', exact: true }).click();
    };
    await expect(chat.getByText('Fixture message 45', { exact: true })).toHaveCount(1);
    await back.click();
    await expect.poll(distanceFromEnd).toBeLessThan(2);
    expect(await scrollTop()).toBeGreaterThan(0);
    const previous = await chat.evaluate((node) => {
      node.scrollTop = Math.floor(node.scrollTop / 2);
      return node.scrollTop;
    });
    await openLimits();
    await back.click();
    await expect.poll(scrollTop).toBe(previous);
    await openLimits();
    count++;
    await expect(chat.getByText('Fixture message 46', { exact: true })).toHaveCount(1);
    await back.click();
    await expect.poll(distanceFromEnd).toBeLessThan(2);
  });
}

for (const route of ['Forward', 'workspace link'] as const) {
  test(`a deleted session reached through the ${route} stays selected until the user chooses another`, async ({
    page,
  }) => {
    await login(page);
    const a = await createFixtureSession(page, 'First session for ' + route);
    const b = await createFixtureSession(page, 'Second session for ' + route);
    const removed = route === 'Forward' ? b : a;
    const survivor = route === 'Forward' ? a : b;
    let gone = false;
    let hideFromList = false;
    await page.route('**/api/daddy/sessions', async (request) => {
      if (!hideFromList || request.request().method() !== 'GET') return request.continue();
      const response = await request.fetch();
      const sessions = (await response.json()) as { id: string }[];
      return request.fulfill({ response, json: sessions.filter(({ id }) => id !== removed.id) });
    });
    await page.route(`**/api/daddy/sessions/${removed.id}`, (request) =>
      gone
        ? request.fulfill({ status: 404, json: { error: { message: 'Session not found' } } })
        : request.continue(),
    );
    const sessions = page.getByRole('navigation', { name: 'Sessions' });
    await page.goto(`/limits#session/${a.id}`);
    await expect(sessions.getByRole('button', { name: new RegExp(a.title) })).toBeVisible();
    if (route === 'Forward') {
      await sessions.getByRole('button', { name: new RegExp(b.title) }).click();
      await expect(page.getByRole('heading', { name: b.title, exact: true })).toBeVisible();
      await page.goBack();
      await expect(page).toHaveURL(`/limits#session/${a.id}`);
      gone = true;
      await page.goForward();
    } else {
      gone = hideFromList = true;
      await expect(sessions.getByRole('button', { name: new RegExp(a.title) })).toHaveCount(0);
      await page.getByRole('link', { name: 'Back to workspace', exact: true }).click();
    }
    const warning = page.getByRole('alert').filter({ hasText: removed.id });
    await expect(warning).toContainText('Choose a session from the list.');
    hideFromList = true;
    await expect(sessions.getByRole('button', { name: new RegExp(removed.title) })).toHaveCount(0);
    await expect(page).toHaveURL(`/#session/${removed.id}`);
    await expect(warning).toBeVisible();
    await expect(page.getByLabel('Message daddy')).toHaveCount(0);
    await sessions.getByRole('button', { name: new RegExp(survivor.title) }).click();
    await expect(page.getByRole('heading', { name: survivor.title, exact: true })).toBeVisible();
    await expect(page.getByLabel('Message daddy')).toBeEditable();
  });
}

for (const removeOriginal of [false, true]) {
  test(`pins the short limits link before an ID collision (original removed: ${removeOriginal})`, async ({
    page,
  }) => {
    await login(page);
    const a = await createFixtureSession(page, 'Pinned short chat');
    const b = await createFixtureSession(page, 'Other chat with matching prefix');
    const prefix = a.id.slice(0, 8);
    let collide = false;
    await page.route('**/api/daddy/sessions', async (route) => {
      const response = await route.fetch();
      const sessions = (await response.json()) as { id: string }[];
      const visible =
        collide && removeOriginal ? sessions.filter(({ id }) => id !== a.id) : sessions;
      await route.fulfill({
        response,
        json: visible.map((entry) =>
          entry.id === b.id && collide ? { ...entry, id: prefix + b.id.slice(8) } : entry,
        ),
      });
    });
    await page.goto(`/limits#session/${prefix}`);
    const back = page.getByRole('link', { name: 'Back to workspace', exact: true });
    await expect(back).toHaveAttribute('href', `/#session/${a.id}`);
    collide = true;
    const updated = await page.waitForResponse(
      async (response) =>
        response.url().endsWith('/api/daddy/sessions') &&
        ((await response.json()) as { id: string }[]).some(
          ({ id }) => id === prefix + b.id.slice(8),
        ),
    );
    await updated.finished();
    await back.click();
    await expect(page).toHaveURL(`/#session/${a.id}`);
    if (removeOriginal) {
      await expect(page.getByRole('alert').filter({ hasText: a.id })).toBeVisible();
      await expect(page.getByLabel('Message daddy')).toHaveCount(0);
    } else {
      await expect(page.getByRole('heading', { name: a.title, exact: true })).toBeVisible();
      await expect(page.getByLabel('Message daddy')).toBeEditable();
    }
  });
}

test('shows copy preparation and deletion progress without scrolling on short screens', async ({
  page,
}) => {
  await mockTwoProviders(page);
  await login(page);
  await page.getByRole('button', { name: 'New session', exact: true }).click();
  await page
    .getByLabel('What should daddy do?')
    .fill(`https://github.com/fixture/planning/issues/${Date.now()}`);
  await page.getByLabel('Session name (optional)').fill('Maintenance progress fixture');
  await page.getByRole('button', { name: 'Start session', exact: true }).click();
  const firstTask = page.locator('.daddy-work-items .daddy-work-item').first();
  await expect(firstTask).toHaveCount(1);
  const sessionId = new URL(page.url()).hash.slice('#session/'.length);
  let groupPatch: Partial<DaddyBoard['group']>;
  await page.route(`**/api/daddy/sessions/${sessionId}`, async (route) => {
    const response = await route.fetch();
    const board: DaddyBoard = await response.json();
    await route.fulfill({ response, json: { ...board, group: { ...board.group, ...groupPatch } } });
  });

  for (const { group, heading } of [
    {
      group: { workspacePreparation: { state: 'preparing' } },
      heading: 'Preparing the session copy',
    },
    {
      group: { daddyState: 'paused', deletion: { state: 'running' } },
      heading: 'Saving results and removing session copies',
    },
  ] satisfies { group: Partial<DaddyBoard['group']>; heading: string }[]) {
    groupPatch = group;
    await page.reload();
    await expect(page.getByRole('button', { name: 'Agent limits', exact: true })).toBeVisible();

    const notice = page.getByRole('status').filter({ hasText: heading });
    const composer = page.getByLabel('Message daddy');
    const main = page.getByRole('main');
    for (const viewport of [
      { width: 390, height: 540 },
      { width: 1024, height: 480 },
    ]) {
      await page.setViewportSize(viewport);
      await expect(notice).toBeInViewport({ ratio: 1 });
      if (group.deletion) {
        await expect(composer).toBeDisabled();
        await expect(composer).not.toHaveAttribute('placeholder', 'Resume daddy to continue');
      } else {
        await expect(composer).toBeEnabled();
      }
      if (viewport.width === 390) {
        await page.locator('.daddy-mobile-tabs').getByRole('button', { name: /Tasks/ }).click();
      }
      await expect(notice).toBeInViewport({ ratio: 1 });
      await expect(firstTask).toBeInViewport({ ratio: 1 });
      expect(await main.evaluate((element) => element.scrollTop)).toBe(0);
    }
  }
});
