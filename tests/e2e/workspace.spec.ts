import { test, expect } from '@playwright/test';
import { readFileSync, mkdirSync } from 'node:fs';
test('discusses a draft, publishes it, runs corrections, and verifies the final revision', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/?legacy=1');
  await page
    .getByLabel('Local access token')
    .fill(readFileSync('.reviewloop/e2e/access-token', 'utf8'));
  await page.getByRole('button', { name: 'Connect to workspace' }).click();
  await expect(page.getByRole('heading', { name: 'Review workspace' })).toBeVisible();
  await page.getByRole('button', { name: 'Try a demo loop' }).click();
  await expect(page.getByRole('button', { name: 'Publish demo review' })).toBeVisible({
    timeout: 20000,
  });
  await expect(
    page.getByText('A stale callback can update the replacement session.', {
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Discuss with reviewer' }).click();
  await page.getByLabel('Message reviewer').fill('Can this happen on a single event loop?');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByText(/Demo session: the issue is about callback ordering/)).toBeVisible({
    timeout: 15000,
  });
  mkdirSync('docs/screenshots', { recursive: true });
  await page.setViewportSize({ width: 1512, height: 1100 });
  await page.screenshot({
    path: 'docs/screenshots/workspace.png',
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Publish demo review' }).click();
  await expect(page.getByText('Round 2 of 3', { exact: true })).toBeVisible({
    timeout: 25000,
  });
  await expect(page.getByRole('button', { name: 'Publish demo review' })).toBeEnabled({
    timeout: 20000,
  });
  await page.getByRole('button', { name: 'Publish demo review' }).click();
  await expect(page.getByRole('button', { name: 'Reopen', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Author', exact: true }).click();
  await expect(page.getByText(/Demo fixture: added a generation check/)).toBeVisible();
  await page.getByRole('tab', { name: 'Decisions' }).click();
  await expect(page.getByText('verified', { exact: true }).first()).toBeVisible();
  expect(errors).toEqual([]);
});
test('mobile layout has no horizontal overflow and the create form validates inputs', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?legacy=1');
  await page
    .getByLabel('Local access token')
    .fill(readFileSync('.reviewloop/e2e/access-token', 'utf8'));
  await page.getByRole('button', { name: 'Connect to workspace' }).click();
  await page.getByRole('button', { name: 'Attach a PR', exact: true }).first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Attach and start review' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Close dialog' }).click();
  mkdirSync('docs/screenshots', { recursive: true });
  await page.screenshot({
    path: 'docs/screenshots/mobile.png',
    fullPage: true,
  });
});
test('a paired phone uses HTTPS and remains connected after the laptop browser closes', async ({
  browser,
}) => {
  const laptop = await browser.newContext();
  const token = readFileSync('.reviewloop/e2e/access-token', 'utf8').trim();
  const response = await laptop.request.post('http://127.0.0.1:4318/api/pairings', {
    headers: { Authorization: `Bearer ${token}` },
    data: { name: 'Phone test', kind: 'web' },
  });
  expect(response.ok()).toBe(true);
  const { url } = await response.json();
  const phone = await browser.newContext({
    viewport: { width: 390, height: 844 },
    ignoreHTTPSErrors: true,
  });
  try {
    const page = await phone.newPage();
    await page.goto(url);
    await expect(page.locator('.daddy-app')).toBeVisible();
    expect(page.url()).not.toContain('#pair/');
    expect((await phone.cookies()).find((c) => c.name === 'reviewloop_session')?.secure).toBe(true);
    await laptop.close();
    await page.reload();
    await expect(page.locator('.daddy-app')).toBeVisible();
    await page.getByRole('button', { name: 'Sessions', exact: true }).click();
    await page.getByRole('button', { name: /Projects/ }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    expect(
      (
        await phone.request.get('https://localhost:4319/api/tasks', {
          headers: { Origin: 'https://evil.example' },
        })
      ).status(),
    ).toBe(403);
  } finally {
    await phone.close();
  }
});

test('starts ticket conversations with separate models, adds a child and saves phone notifications', async ({
  page,
}) => {
  const issue = Date.now();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/?legacy=1');
  await page
    .getByLabel('Local access token')
    .fill(readFileSync('.reviewloop/e2e/access-token', 'utf8'));
  await page.getByRole('button', { name: 'Connect to workspace' }).click();
  await page.getByRole('button', { name: 'New from ticket', exact: true }).first().click();
  await page
    .getByLabel('GitHub issue or Tracker ticket')
    .fill(`https://github.com/fixture/planning/issues/${issue}`);
  await page.getByRole('button', { name: 'Preview ticket' }).click();
  await expect(page.getByText(`fixture/planning#${issue} · Ticket fixture ${issue}`)).toBeVisible();
  await page.getByLabel('Repository path on the service host').fill('/fixture/repo');
  await expect(page.getByLabel('Author for this ticket model')).toHaveValue('gpt-5.6-sol');
  await expect(page.getByLabel('Reviewer for this group model')).toHaveValue('gpt-6-astra');
  await page.getByRole('button', { name: 'Import ticket and start chat' }).click();
  await expect(page.getByText('I have read the ticket.', { exact: false })).toBeVisible({
    timeout: 15000,
  });
  await expect(page.getByRole('button', { name: 'Start implementation' })).toBeEnabled();
  await page.getByRole('button', { name: 'Add child ticket' }).click();
  await page
    .getByLabel('GitHub issue or Tracker ticket')
    .fill(`https://github.com/fixture/planning/issues/${issue + 1}`);
  await expect(page.getByLabel('Shared reviewer (inherited from parent) model')).toBeDisabled();
  await page.getByLabel('Author for this ticket effort').selectOption('medium');
  await page.getByRole('button', { name: 'Import ticket and start chat' }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.getByText('gpt-5.6-sol · medium', { exact: false })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Notification settings', exact: true }).click();
  await page.getByLabel('Enable Telegram notifications').check();
  await page.getByRole('button', { name: 'Save notifications' }).click();
  await expect(page.getByText('Notification preferences saved.')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test('switches both interface languages, preserves task text, refreshes models and checks CLI versions', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/?legacy=1');
  await page
    .getByLabel('Local access token')
    .fill(readFileSync('.reviewloop/e2e/access-token', 'utf8'));
  await page.getByRole('button', { name: 'Connect to workspace' }).click();
  await expect(page.getByRole('heading', { name: 'Review workspace', exact: true })).toBeVisible();
  await page.getByLabel('Interface language').selectOption('ru');
  await expect(
    page.getByRole('heading', { name: 'Рабочее пространство', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Новая задача из тикета', exact: true }).click();
  await page
    .getByLabel('GitHub issue или тикет Tracker')
    .fill('https://github.com/fixture/planning/issues/777');
  await page.getByRole('button', { name: 'Посмотреть тикет' }).click();
  await expect(
    page.getByText('Preserve the session generation invariant.', { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel('Модель: Автор этого тикета')).toHaveValue('gpt-5.6-sol');
  const refreshed = page.waitForRequest((request) =>
    request.url().includes('/api/agents?refresh=1'),
  );
  await page.getByRole('button', { name: 'Обновить список моделей' }).click();
  await refreshed;
  await expect(page.getByText('Codex CLI 0.153.4')).toBeVisible();
  await page.getByRole('button', { name: 'Закрыть окно' }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Обновления', exact: true }).click();
  await page.getByRole('button', { name: 'Проверить сейчас', exact: true }).click();
  await expect(page.getByText('Доступно обновление', { exact: true })).toBeVisible();
  await expect(page.getByText('Интеграция пока недоступна', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Закрыть окно' }).click();
  await page.getByLabel('Язык интерфейса').selectOption('en');
  await expect(page.getByRole('heading', { name: 'Review workspace', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('keeps the language chosen before login after connection and reload', async ({ page }) => {
  await page.goto('/?legacy=1');
  await page.getByLabel('Interface language').selectOption('ru');
  await page
    .getByLabel('Локальный токен доступа')
    .fill(readFileSync('.reviewloop/e2e/access-token', 'utf8'));
  await page.getByRole('button', { name: 'Подключиться', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Рабочее пространство', exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'Рабочее пространство', exact: true }),
  ).toBeVisible();
  await page.getByLabel('Язык интерфейса').selectOption('en');
  await expect(page.getByRole('heading', { name: 'Review workspace', exact: true })).toBeVisible();
});
