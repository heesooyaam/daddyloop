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
