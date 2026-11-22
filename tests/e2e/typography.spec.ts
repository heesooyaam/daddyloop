import { test, expect, type Locator } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { translator } from '../../src/i18n/index.js';

test.use({ reducedMotion: 'reduce' });

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
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('lang', locale);

    await page.getByRole('button', { name: t('New session'), exact: true }).click();
    await page.getByLabel(t('Session name (optional)')).fill(title);
    await page.getByLabel(t('What should daddy do?')).fill(message);
    await page.getByRole('button', { name: t('Start session'), exact: true }).click();
    const heading = page.getByRole('heading', { name: title, exact: true });
    await expect(heading).toBeVisible();

    await page.getByRole('button', { name: t('Queue task'), exact: true }).click();
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
        await chatText.scrollIntoViewIfNeeded();
        await expect(chatText).toBeInViewport({ ratio: 0.99 });
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
}
