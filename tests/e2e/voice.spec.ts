import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

test.use({
  permissions: ['microphone'],
  launchOptions: {
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--disable-dev-shm-usage',
    ],
  },
});
test('records a microphone phrase and leaves the transcript in the editable chat draft', async ({
  page,
}) => {
  await page.goto('/');
  await page
    .getByLabel('Local access token')
    .fill(readFileSync('.daddyloop/e2e/access-token', 'utf8'));
  await page.getByRole('button', { name: 'Connect to workspace' }).click();
  await page.getByRole('button', { name: 'New session', exact: true }).click();
  await page.getByLabel('What should daddy do?').fill('Test dictation');
  await page.getByLabel('Session name (optional)').fill('Voice session');
  await page.getByRole('button', { name: 'Start session', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Voice session', exact: true })).toBeVisible();
  const input = page.getByLabel('Message daddy');
  await input.fill('My draft:');
  let bytes = 0;
  await page.route('**/api/voice/transcribe', (route) => {
    const body = route.request().postDataBuffer()!;
    expect(body.toString('ascii', 0, 4)).toBe('RIFF');
    expect(body.readUInt32LE(24)).toBe(16000);
    bytes = body.length;
    return route.fulfill({ json: { text: 'Dictated phrase' } });
  });
  await page.getByRole('button', { name: 'Dictate message' }).click();
  const stop = page.getByRole('button', { name: 'Stop recording and transcribe' });
  await expect(stop).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled();
  // MediaRecorder needs actual samples from the synthetic microphone.
  await page.waitForTimeout(1200);
  await stop.click();
  await expect(input).toHaveValue('My draft: Dictated phrase');
  expect(bytes).toBeGreaterThan(44);
  await input.fill('Edited before sending');
  await expect(input).toHaveValue('Edited before sending');
});

test('keeps dictation scoped to the current session and records a task after visiting limits', async ({
  page,
}) => {
  await page.goto('/');
  await page
    .getByLabel('Local access token')
    .fill(readFileSync('.daddyloop/e2e/access-token', 'utf8'));
  await page.getByRole('button', { name: 'Connect to workspace' }).click();
  for (const title of ['Earlier voice chat', 'Current voice chat']) {
    await page.getByRole('button', { name: 'New session', exact: true }).click();
    await page.getByLabel('Session name (optional)').fill(title);
    await page.getByRole('button', { name: 'Start session', exact: true }).click();
    await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  }
  const sessions = page.getByRole('navigation', { name: 'Sessions' });
  await sessions.getByRole('button', { name: /Earlier voice chat/ }).click();
  const message = page.getByLabel('Message daddy');
  await message.fill('Earlier draft');
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requests = 0;
  await page.route('**/api/voice/transcribe', async (route) => {
    if (++requests === 1) {
      await hold;
      await route.fulfill({ json: { text: 'Late phrase from earlier chat' } }).catch(() => {});
    } else {
      await route.fulfill({ json: { text: 'Dictated task' } });
    }
  });
  const record = async (scope = page.getByRole('main')) => {
    await scope.getByRole('button', { name: 'Dictate message', exact: true }).click();
    const stop = scope.getByRole('button', { name: 'Stop recording and transcribe' });
    await expect(stop).toBeVisible();
    // MediaRecorder must collect samples from the synthetic microphone before stopping.
    await page.waitForTimeout(1200);
    await stop.click();
  };
  try {
    await record();
    await expect.poll(() => requests).toBe(1);
    await sessions.getByRole('button', { name: /Current voice chat/ }).click();
    await expect(
      page.getByRole('heading', { name: 'Current voice chat', exact: true }),
    ).toBeVisible();
    await message.fill('Current draft');
    release();
    await page.getByRole('button', { name: 'Agent limits', exact: true }).click();
    await page.getByRole('link', { name: 'Open limits page', exact: true }).click();
    await page.getByRole('link', { name: 'Back to workspace', exact: true }).click();
    await expect(message).toHaveValue('Current draft');
    await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Queue task', exact: true }).click();
    const queue = page.getByRole('dialog', { name: 'Queue task' });
    await record(queue);
    await expect(queue.getByLabel('Task description')).toHaveValue('Dictated task');
    await expect.poll(() => requests).toBe(2);
    await queue.getByRole('button', { name: 'Close', exact: true }).click();
    await sessions.getByRole('button', { name: /Earlier voice chat/ }).click();
    await expect(message).toHaveValue('Earlier draft');
  } finally {
    release();
  }
});
