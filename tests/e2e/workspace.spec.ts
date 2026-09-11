import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
test('a paired phone uses HTTPS and remains connected after the laptop browser closes', async ({
  browser,
}) => {
  const laptop = await browser.newContext();
  const token = readFileSync('.daddyloop/e2e/access-token', 'utf8').trim();
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
    expect((await phone.cookies()).find((c) => c.name === 'daddyloop_session')?.secure).toBe(true);
    await laptop.close();
    await page.reload();
    await expect(page.locator('.daddy-app')).toBeVisible();
    await page.getByRole('button', { name: 'Sessions', exact: true }).click();
    await page.getByRole('button', { name: /Workspaces/ }).click();
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

test('keeps the language chosen before login after connection and reload', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Interface language').selectOption('ru');
  await page
    .getByLabel('Локальный токен доступа')
    .fill(readFileSync('.daddyloop/e2e/access-token', 'utf8'));
  await page.getByRole('button', { name: 'Подключиться', exact: true }).click();
  await expect(page.locator('.daddy-app')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Новая сессия', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Новая сессия', exact: true })).toBeVisible();
  await page.getByLabel('Язык', { exact: true }).selectOption('en');
  await expect(page.locator('.daddy-app')).toBeVisible();
});
