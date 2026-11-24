import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import type { DaddyBoard } from '../../src/client/daddy.js';

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
    'Workers',
    'Queue task',
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
