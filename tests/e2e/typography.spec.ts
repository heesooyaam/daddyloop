import { test, expect, type Locator, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { DaddyBoard } from '../../src/client/daddy.js';
import { translator, type Locale } from '../../src/i18n/index.js';

test.use({ reducedMotion: 'reduce' });

async function loginInLocale(page: Page, locale: Locale) {
  await page.goto('/');
  await page
    .getByLabel('Local access token')
    .fill(readFileSync('.daddyloop/e2e/access-token', 'utf8'));
  await page.getByRole('button', { name: 'Connect to workspace' }).click();
  await expect(page.locator('.daddy-app')).toBeVisible();
  // Apply the language only in this browser context, since the fixture server is shared.
  await page.route('**/api/preferences', async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...(await response.json()), locale } });
  });
}

async function createFixtureSession(page: Page, title: string, message?: string) {
  const workspaces = await page.request.get('/api/workspaces');
  await expect(workspaces).toBeOK();
  const workspace = ((await workspaces.json()) as { id: string; name: string }[]).find(
    ({ name }) => name === 'Fixture workspace',
  );
  const response = await page.request.post('/api/daddy/sessions', {
    headers: { 'X-daddyloop-Request': '1' },
    data: { workspaceId: workspace?.id, title, message },
  });
  await expect(response).toBeOK();
  const { group } = (await response.json()) as DaddyBoard;
  return group.id;
}

async function expectType(element: Locator, size: number, weight: number, lineHeight: number) {
  await expect(element).toBeVisible();
  await expect(element).toHaveCSS('font-size', `${size}px`);
  await expect(element).toHaveCSS('font-weight', `${weight}`);
  await expect(element).toHaveCSS('line-height', `${lineHeight}px`);
}

async function expectTextToFit(element: Locator) {
  await expect(element).toBeVisible();
  expect(await element.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
}

for (const locale of ['en', 'ru'] as const) {
  test(`keeps ${locale} text readable on phone and desktop`, async ({ page }, testInfo) => {
    const t = translator(locale);
    const longName =
      locale === 'ru'
        ? 'Проверка истории статусов всех задач в общем воркспейсе перед следующим релизом'
        : 'Review the status history for every task in the shared workspace before the next release';
    const title = `${longName} #${testInfo.repeatEachIndex + 1}`;
    const taskTitle =
      locale === 'ru'
        ? 'СинхронизацияНастроекВоркспейсовПослеВосстановленияСохранённойСессии'
        : 'SynchronizeWorkspaceSettingsAfterRestoringTheSharedConversation';
    const message =
      locale === 'ru'
        ? 'Собери список изменений и добавь пояснения к решениям, которые пригодятся следующей команде.'
        : 'Collect the changes and explain the decisions that will help the next team continue the work.';

    await loginInLocale(page, locale);
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('lang', locale);

    await page.getByRole('button', { name: t('New session'), exact: true }).click();
    await page.getByLabel(t('Session name (optional)')).fill(title);
    await page.getByLabel(t('What should daddy do?')).fill(message);
    await page
      .getByRole('dialog')
      .getByRole('button', { name: t('Start session'), exact: true })
      .click();
    const heading = page.getByRole('heading', { name: title, exact: true });
    await expect(heading).toBeVisible();

    await page.getByRole('button', { name: t('Queue a task'), exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel(t('Task description')).fill(taskTitle);
    await dialog.getByRole('button', { name: t('Queue task'), exact: true }).click();
    await expect(dialog.getByRole('heading', { name: taskTitle, exact: true })).toBeVisible();
    const close = dialog.getByRole('button', { name: t('Close'), exact: true });
    await close.click();

    for (const width of [1440, 320]) {
      const phone = width === 320;
      await test.step(`${width}px viewport`, async () => {
        await page.setViewportSize({ width, height: phone ? 740 : 960 });
        await expectType(heading, 20, 600, 26);
        await expectTextToFit(heading);
        if (phone) {
          await expect(heading).toHaveAttribute('title', title);
          expect(await heading.evaluate((node) => node.clientHeight)).toBe(52);
          await page.getByRole('button', { name: t('Sessions'), exact: true }).click();
        }
        const session = page.locator('.daddy-session').filter({ hasText: title });
        await expectType(session.locator('strong'), 14, 600, 19.6);
        await expectTextToFit(session.locator('strong'));
        await expectType(session.locator('small'), 12, 400, 18);
        if (phone) {
          await page
            .getByRole('button', { name: t('Close menu') })
            .click({ position: { x: width - 10, y: 20 } });
        }

        const chat = page.locator('.daddy-message.user');
        const chatText = chat.getByText(message, { exact: true });
        await expectType(chatText, 16, 400, 25.6);
        await page.locator('.daddy-chat-scroll').scrollIntoViewIfNeeded();
        // A fixture reply can scroll the conversation between the scroll and the measurement.
        await expect(async () => {
          await chatText.scrollIntoViewIfNeeded();
          await expect(chatText).toBeInViewport({ ratio: 0.99, timeout: 500 });
        }).toPass({ timeout: 5000 });
        await expectType(chat.locator('time'), 12, 400, 18);
        await expectType(page.getByRole('textbox', { name: t('Message daddy') }), 16, 400, 25.6);
        const composerHint = page.locator('.daddy-composer-note');
        await expectType(composerHint, 12, 400, 18);
        await expectTextToFit(composerHint);
        if (phone)
          expect(await composerHint.evaluate((node) => node.clientHeight)).toBeGreaterThan(18);

        await page.getByRole('button', { name: t('Session settings') }).click();
        await expectType(dialog.getByRole('heading'), 20, 600, 26);
        const settingsHint = dialog.getByText(
          t(
            'Worker defaults apply to new tasks. Changing daddy’s model requires his session to be idle.',
          ),
          { exact: true },
        );
        await expectType(settingsHint, 13, 400, 19.5);
        await expectTextToFit(settingsHint);
        await settingsHint.scrollIntoViewIfNeeded();
        await expect(settingsHint).toBeInViewport({ ratio: 0.99 });
        await expectType(dialog.getByRole('button', { name: t('Save settings') }), 13, 600, 19.5);
        await expectTextToFit(dialog);
        await close.click();

        if (phone) {
          await page
            .locator('.daddy-mobile-tabs button')
            .filter({ hasText: t('Tasks') })
            .click();
        }
        const task = page.locator('.daddy-work-item').filter({ hasText: taskTitle });
        await expectType(task.getByText(taskTitle, { exact: true }), 14, 600, 19.6);
        await expectType(task.locator('.daddy-work-state'), 12, 600, 18);
        await expectTextToFit(task);
        await task.click();
        const reportTitle = dialog.getByRole('heading', { name: taskTitle, exact: true });
        await expectType(reportTitle, 20, 600, 26);
        await expectTextToFit(reportTitle);
        await expectTextToFit(dialog);
        await close.click();
        await expectTextToFit(page.locator('.daddy-main'));
        await expectTextToFit(page.locator('html'));
      });
    }
  });

  test(`can switch ${locale} sessions in short phone and desktop windows`, async ({ page }) => {
    const t = translator(locale);
    const suffix = randomUUID();
    const first = `${locale === 'ru' ? 'Первый разговор' : 'First conversation'} ${suffix}`;
    const second = `${locale === 'ru' ? 'Второй разговор' : 'Second conversation'} ${suffix}`;
    await loginInLocale(page, locale);
    await createFixtureSession(page, second);
    const active = await createFixtureSession(page, first);

    for (const width of [390, 1024]) {
      await test.step(`${width} × 540`, async () => {
        await page.setViewportSize({ width, height: 540 });
        await page.goto(`/#session/${active}`);
        await page.reload();
        await expect(page.locator('html')).toHaveAttribute('lang', locale);
        await expect(page.getByRole('heading', { name: first, exact: true })).toBeVisible();
        const openSessions = page.getByRole('button', { name: t('Sessions'), exact: true });
        if (width === 390) await openSessions.click();
        const sessions = page.getByRole('navigation', { name: t('Sessions'), exact: true });
        await sessions.getByRole('button', { name: second }).click({ timeout: 3000 });
        await expect(page.getByRole('heading', { name: second, exact: true })).toBeVisible();

        if (width === 390) await openSessions.click();
        const language = page.getByRole('combobox', { name: t('Language'), exact: true });
        await language.scrollIntoViewIfNeeded();
        await expect(language).toBeInViewport({ ratio: 0.99 });
      });
    }
  });

  test(`can open the last ${locale} task in a short desktop window`, async ({ page }) => {
    const t = translator(locale);
    const sessionTitle =
      locale === 'ru'
        ? 'Проверка истории статусов всех задач, настроек воркеров и сохранённых отчётов по рабочим копиям в общем воркспейсе перед публикацией следующего релиза'
        : 'Review the status history, worker settings and saved reports for every task in the shared workspace before publishing the next release';
    await loginInLocale(page, locale);
    const id = await createFixtureSession(page, sessionTitle, sessionTitle);
    for (const title of locale === 'ru'
      ? ['Проверить настройки', 'Сверить статусы', 'Прочитать отчёт']
      : ['Check settings', 'Compare statuses', 'Read the report']) {
      const task = await page.request.post(`/api/daddy/sessions/${id}/tasks`, {
        headers: { 'X-daddyloop-Request': '1' },
        data: { requirements: title, requestId: randomUUID() },
      });
      await expect(task).toBeOK();
    }

    await page.setViewportSize({ width: 1024, height: 600 });
    await page.goto(`/#session/${id}`);
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('lang', locale);
    await expect(page.getByRole('heading', { name: sessionTitle, exact: true })).toBeVisible();
    await expect(page.locator('.daddy-session-progress')).toContainText(t('Session copy ready'));
    await expect(page.getByRole('region', { name: t('Current usage') })).toHaveCount(1);
    const tasks = page.locator('.daddy-work-item');
    await expect(tasks).toHaveCount(3);
    const lastTitle = await tasks.last().locator('strong').innerText();
    await tasks.filter({ hasText: lastTitle }).click({ timeout: 3000 });
    await expect(page.getByRole('dialog').getByRole('heading', { name: lastTitle })).toBeVisible();
  });
}
