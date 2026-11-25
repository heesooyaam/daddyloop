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

declare global {
  interface Window {
    limitsVoice: {
      tracks: MediaStreamTrack[];
      recordings: number;
      releasePermission: () => void;
      fireRecordingTimers: () => number;
    };
  }
}

for (const exit of ['indicator', 'mobile sidebar', 'browser history'] as const) {
  test(`cancels microphone input when leaving for limits through ${exit}`, async ({ page }) => {
    const delayPermission = exit === 'mobile sidebar';
    if (delayPermission) await page.setViewportSize({ width: 390, height: 540 });
    await page.addInitScript((delay) => {
      const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      const start = MediaRecorder.prototype.start;
      const browser: Window = window;
      const schedule = browser.setTimeout.bind(browser);
      const cancel = browser.clearTimeout.bind(browser);
      const recordingTimers = new Map<number, () => void>();
      let releasePermission!: () => void;
      const permission = new Promise<void>((resolve) => {
        releasePermission = resolve;
      });
      const fixture: Window['limitsVoice'] = {
        tracks: [],
        recordings: 0,
        releasePermission,
        fireRecordingTimers: () => {
          const callbacks = [...recordingTimers.values()];
          for (const run of callbacks) run();
          return callbacks.length;
        },
      };
      window.limitsVoice = fixture;
      navigator.mediaDevices.getUserMedia = async (constraints) => {
        const stream = await getUserMedia(constraints);
        fixture.tracks.push(...stream.getAudioTracks());
        if (delay) await permission;
        return stream;
      };
      MediaRecorder.prototype.start = function (timeslice) {
        fixture.recordings++;
        start.call(this, timeslice);
      };
      browser.setTimeout = (handler, timeout, ...args) => {
        const id = schedule(handler, timeout, ...args);
        if (timeout === 300000 && typeof handler === 'function')
          recordingTimers.set(id, () => handler(...args));
        return id;
      };
      browser.clearTimeout = (id) => {
        if (id !== undefined) recordingTimers.delete(id);
        cancel(id);
      };
    }, delayPermission);
    await page.goto('/');
    await page
      .getByLabel('Local access token')
      .fill(readFileSync('.daddyloop/e2e/access-token', 'utf8'));
    await page.getByRole('button', { name: 'Connect to workspace' }).click();
    if (delayPermission) await page.getByRole('button', { name: 'Sessions', exact: true }).click();
    await page.getByRole('button', { name: 'New session', exact: true }).click();
    const title = `Voice before limits through ${exit}`;
    await page.getByLabel('Session name (optional)').fill(title);
    await page.getByRole('button', { name: 'Start session', exact: true }).click();
    await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
    const message = page.getByLabel('Message daddy');
    const back = page.getByRole('link', { name: 'Back to workspace', exact: true });
    const visitLimitsFromHeader = async () => {
      await page.getByRole('button', { name: 'Agent limits', exact: true }).click();
      await page.getByRole('link', { name: 'Open limits page', exact: true }).click();
    };
    await message.fill('Preserved text');
    if (exit === 'browser history') {
      await visitLimitsFromHeader();
      await back.click();
    }

    let transcriptions = 0;
    await page.route('**/api/voice/transcribe', (route) => {
      transcriptions++;
      return route.fulfill({ json: { text: 'Unexpected transcript' } });
    });
    await page.getByRole('button', { name: 'Dictate message', exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => window.limitsVoice.tracks.map((track) => track.readyState)))
      .toEqual(['live']);
    if (delayPermission) {
      await expect(
        page.getByRole('button', { name: 'Waiting for microphone permission', exact: true }),
      ).toBeVisible();
      await page.getByRole('button', { name: 'Sessions', exact: true }).click();
      await page.getByRole('link', { name: 'Limits', exact: true }).click();
    } else {
      await expect(
        page.getByRole('button', { name: 'Stop recording and transcribe', exact: true }),
      ).toBeVisible();
      if (exit === 'indicator') await visitLimitsFromHeader();
      else await page.goBack();
    }
    await expect(page.getByRole('heading', { name: 'Agent limits', exact: true })).toBeVisible();
    await page.evaluate(() => window.limitsVoice.releasePermission());
    await expect
      .poll(() => page.evaluate(() => window.limitsVoice.tracks.map((track) => track.readyState)))
      .toEqual(['ended']);
    expect(await page.evaluate(() => window.limitsVoice.recordings)).toBe(delayPermission ? 0 : 1);
    expect(await page.evaluate(() => window.limitsVoice.fireRecordingTimers())).toBe(0);

    await back.click();
    await expect(message).toHaveValue('Preserved text');
    await expect(page.getByRole('button', { name: 'Dictate message', exact: true })).toBeEnabled();
    expect(transcriptions).toBe(0);
  });
}
