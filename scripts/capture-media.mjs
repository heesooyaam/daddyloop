// Reproduce README media from the real UI and CLI against an isolated demo server.
import { chromium, expect } from '@playwright/test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, cpSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { buildApp } from '../dist/server/server/app.js';
import { configSchema } from '../dist/server/ops/config.js';
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
const config = configSchema.parse({ dataDir: state, demo: true });
const { app } = await buildApp({ dataDir: state, config, token, demo: true });
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
const escape = (text) =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
try {
  await app.listen({ host: '127.0.0.1', port: 0 });
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  writeFileSync(configFile, JSON.stringify({ ...config, serverUrl: origin }), { mode: 0o600 });
  browser = await chromium.launch({ args: ['--disable-dev-shm-usage'] });
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
  expect((await mobile.request.post(`${origin}/api/session`, { data: { token } })).ok()).toBe(true);
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

  const transcriptPath = join(scratch, 'cli.txt');
  const cliContext = await browser.newContext({
    extraHTTPHeaders: { 'X-Reviewloop-Request': '1' },
  });
  await cliContext.request.post(`${origin}/api/session`, { data: { token } });
  await command('python3', [
    join(root, 'scripts/capture-cli.py'),
    process.execPath,
    join(root, 'dist/server/cli.js'),
    configFile,
    transcriptPath,
  ]);
  const created = await cliContext.request.post(`${origin}/api/demo`, { data: {} });
  expect(created.ok()).toBe(true);
  const cliTask = await created.json();
  await expect
    .poll(
      async () =>
        (await (await cliContext.request.get(`${origin}/api/tasks/${cliTask.id}`)).json()).task
          .state,
    )
    .toBe('awaiting_publication');
  await command('python3', [
    join(root, 'scripts/capture-cli.py'),
    process.execPath,
    join(root, 'dist/server/cli.js'),
    configFile,
    join(scratch, 'cli-chat.txt'),
    cliTask.id,
  ]);
  await cliContext.close();
  for (const filename of ['cli', 'cli-chat']) {
    const transcript = readFileSync(join(scratch, filename + '.txt'), 'utf8')
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
      .replaceAll('\r', '')
      .trim();
    const terminal = await browser.newPage({
      viewport: { width: 1280, height: 840 },
      deviceScaleFactor: 1,
    });
    await terminal.setContent(
      `<!doctype html><meta charset="utf-8"><style>*{box-sizing:border-box}body{margin:0;padding:24px;background:#eaf1ed;color:#dbe8e1;font:16px/1.65 'JetBrains Mono',monospace}.terminal{border-radius:16px;overflow:hidden;background:#102a22;box-shadow:0 12px 28px #183d2322}.bar{height:50px;background:#18372d;display:flex;align-items:center;padding:0 22px;gap:8px}.dot{width:10px;height:10px;border-radius:100%;background:#bd927a}.dot:nth-child(2){background:#d6bb7c}.dot:nth-child(3){background:#8bb39a}.title{margin:auto;color:#91b1a0;font-size:12px;padding-right:54px}pre{white-space:pre-wrap;overflow-wrap:anywhere;margin:0;padding:22px 28px;font:inherit}.lead{color:#91d6a6}</style><div class="terminal"><div class="bar"><i class="dot"></i><i class="dot"></i><i class="dot"></i><span class="title">reviewctl · live terminal capture · demo workspace</span></div><pre>${escape(transcript).replace('reviewloop 0.2.0', '<span class="lead">reviewloop 0.2.0</span>')}</pre></div>`,
    );
    await terminal.setViewportSize({
      width: 1280,
      height:
        Math.ceil(
          await terminal
            .locator('.terminal')
            .evaluate((element) => element.getBoundingClientRect().height),
        ) + 48,
    });
    await terminal.screenshot({
      path: join(output, filename + '.png'),
      fullPage: true,
      animations: 'disabled',
    });
    await terminal.close();
  }
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
  cpSync(transcriptPath, join(scratchRoot, 'last-cli.txt'));
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
  console.log('Media complete: docs/media');
} finally {
  await browser?.close();
  await app.close();
  rmSync(scratch, { recursive: true, force: true });
}
