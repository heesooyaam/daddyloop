// Reproduce README media from the real UI and CLI against an isolated demo server.
import { chromium, expect } from '@playwright/test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { buildApp } from '../dist/server/server/app.js';
import { configSchema } from '../dist/server/ops/config.js';
import { captureTerminal } from './terminal-media.mjs';
const root = resolve(import.meta.dirname, '..');
const output = join(root, 'docs/media');
const scratchRoot = join(root, '.reviewloop/media-build');
mkdirSync(output, { recursive: true });
mkdirSync(scratchRoot, { recursive: true, mode: 0o700 });
const scratch = mkdtempSync(join(scratchRoot, 'capture-'));
const state = join(scratch, 'state');
mkdirSync(state, { mode: 0o700 });
const configFile = join(scratch, 'config.json');
const token = randomBytes(32).toString('hex');
writeFileSync(join(state, 'access-token'), token, { mode: 0o600 });
const profiles = {
  author: { engine: 'codex', model: 'gpt-5.6-sol', effort: 'max' },
  reviewer: { engine: 'codex', model: 'gpt-6-astra', effort: 'max' },
};
const config = configSchema.parse({ dataDir: state, demo: true, agents: profiles });
// The media demo remains offline, including its illustrative model catalogue.
const catalogue = {
  list: async () =>
    Object.values(profiles).map((profile) => ({
      id: profile.model,
      name: profile.model,
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      defaultEffort: 'medium',
      isDefault: profile === profiles.reviewer,
    })),
  validate: async () => {},
};
const { app } = await buildApp({ dataDir: state, config, token, demo: true, catalogue });
let browser;
async function command(executable, args) {
  await new Promise((resolveValue, reject) => {
    const child = spawn(executable, args, { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] });
    let error = '';
    child.stderr.on('data', (bytes) => {
      if (error.length < 16000) error += bytes;
    });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolveValue() : reject(new Error(`${executable}: ${error}`)),
    );
  });
}
try {
  await app.listen({ host: '127.0.0.1', port: 0 });
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  writeFileSync(configFile, JSON.stringify({ ...config, serverUrl: origin }), { mode: 0o600 });
  browser = await chromium.launch({ args: ['--disable-dev-shm-usage'] });
  {
    const settings = await browser.newContext({ viewport: { width: 1440, height: 1080 } });
    await settings.request.post(`${origin}/api/session`, { data: { token } });
    const page = await settings.newPage();
    await page.goto(origin);
    await page.getByRole('button', { name: 'New from ticket', exact: true }).first().click();
    await expect(page.getByLabel('Author for this ticket model')).toHaveValue('gpt-5.6-sol');
    await page
      .getByLabel('GitHub issue or Tracker ticket')
      .fill('https://github.com/your-team/project/issues/42');
    await page.getByLabel('Repository path on the service host').fill('/home/you/projects/project');
    await page.screenshot({ path: join(output, 'ticket-start.png'), fullPage: true });
    await page.getByRole('button', { name: 'Close dialog' }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: 'Notification settings', exact: true }).click();
    await page.getByLabel('Enable Telegram notifications').check();
    await page.screenshot({ path: join(output, 'notifications-phone.png'), fullPage: false });
    await settings.close();
  }
  if (process.argv.includes('--terminal-only')) {
    await captureTerminal({ root, origin, token, configFile, scratch, output, browser, command });
  } else {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1080 },
      deviceScaleFactor: 1,
      reducedMotion: 'reduce',
      recordVideo: { dir: scratch, size: { width: 1440, height: 1080 } },
    });
    expect((await context.request.post(`${origin}/api/session`, { data: { token } })).ok()).toBe(
      true,
    );
    const recordingStarted = performance.now();
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.goto(origin);
    await expect(page.getByRole('heading', { name: 'Review workspace' })).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await page.getByRole('button', { name: 'Try a demo loop' }).click();
    const publish = page.getByRole('button', { name: 'Publish demo review' });
    await expect(publish).toBeEnabled({ timeout: 20000 });
    const videoStart = ((performance.now() - recordingStarted) / 1000 + 0.15).toFixed(3);
    const taskId = page.url().split('#task/')[1];
    await delay(1800);
    await page.screenshot({
      path: join(output, 'workspace.png'),
      fullPage: true,
      animations: 'disabled',
    });
    console.log('Captured review workspace');

    await page.getByRole('button', { name: 'Discuss with reviewer' }).click();
    await page.getByLabel('Message reviewer').fill('Can this happen on a single event loop?');
    await delay(1500);
    await page.getByRole('button', { name: 'Send message' }).click();
    await expect(page.getByText(/Demo session: the issue is about callback ordering/)).toBeVisible({
      timeout: 15000,
    });
    await page.evaluate(() => scrollTo(0, 0));
    await delay(2500);
    await page
      .locator('.task-detail')
      .screenshot({ path: join(output, 'reviewer.png'), animations: 'disabled' });
    console.log('Captured reviewer discussion');

    await publish.click();
    await page.getByRole('tab', { name: 'Author', exact: true }).click();
    await expect(page.getByText(/Demo fixture: added a generation check/)).toBeVisible({
      timeout: 25000,
    });
    await expect(page.getByText('Round 2 of 3', { exact: true })).toBeVisible({ timeout: 25000 });
    await delay(2500);
    await page
      .locator('.task-detail')
      .screenshot({ path: join(output, 'author.png'), animations: 'disabled' });
    await page.getByRole('tab', { name: 'Reviewer', exact: true }).click();
    await expect(publish).toBeEnabled({ timeout: 20000 });
    await delay(2000);
    await publish.click();
    await expect(page.getByRole('button', { name: 'Reopen', exact: true })).toBeVisible();
    await delay(1500);
    await page.getByRole('tab', { name: 'Decisions' }).click();
    await expect(page.getByText('verified', { exact: true }).first()).toBeVisible();
    await delay(2000);
    await page
      .locator('.task-detail')
      .screenshot({ path: join(output, 'decisions.png'), animations: 'disabled' });
    await page.getByRole('tab', { name: 'Activity' }).click();
    await delay(1500);
    await page
      .locator('.task-detail')
      .screenshot({ path: join(output, 'activity.png'), animations: 'disabled' });
    await page.getByRole('tab', { name: 'Reviewer', exact: true }).click();
    await delay(1000);
    const video = page.video();
    await context.close();
    const rawVideo = await video.path();

    const mobile = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
      reducedMotion: 'reduce',
    });
    expect((await mobile.request.post(`${origin}/api/session`, { data: { token } })).ok()).toBe(
      true,
    );
    const phone = await mobile.newPage();
    await phone.goto(`${origin}/#task/${taskId}`);
    await expect(phone.getByRole('button', { name: 'Reopen', exact: true })).toBeVisible();
    await phone.locator('.task-detail').scrollIntoViewIfNeeded();
    await phone.screenshot({ path: join(output, 'mobile.png'), animations: 'disabled' });
    await phone.getByRole('button', { name: 'Devices and connections', exact: true }).click();
    await expect(phone.getByRole('dialog')).toBeVisible();
    await phone.screenshot({ path: join(output, 'connections.png'), animations: 'disabled' });
    await mobile.close();
    console.log('Captured mobile task and device settings');

    await captureTerminal({ root, origin, token, configFile, scratch, output, browser, command });
    expect(pageErrors).toEqual([]);
    console.log('Captured the real interactive CLI; encoding video');

    await command('ffmpeg', [
      '-y',
      '-ss',
      videoStart,
      '-i',
      rawVideo,
      '-an',
      '-c:v',
      'libx264',
      '-threads',
      '2',
      '-preset',
      'slow',
      '-crf',
      '24',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      join(output, 'reviewloop-demo.mp4'),
    ]);
    await command('ffmpeg', [
      '-y',
      '-ss',
      videoStart,
      '-i',
      rawVideo,
      '-filter_complex',
      '[0:v]fps=6,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=80:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5',
      '-threads',
      '2',
      '-filter_complex_threads',
      '1',
      '-loop',
      '0',
      join(output, 'reviewloop-demo.gif'),
    ]);
    writeFileSync(
      join(scratchRoot, 'last-capture.json'),
      JSON.stringify(
        {
          source: 'isolated demo UI and CLI',
          pageErrors,
          taskId,
          generatedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
  }
  console.log('Media complete: docs/media');
} finally {
  await browser?.close();
  await app.close();
  rmSync(scratch, { recursive: true, force: true });
}
