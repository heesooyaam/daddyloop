import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from '@playwright/test';
export async function captureTerminal({
  root,
  origin,
  token,
  configFile,
  scratch,
  output,
  browser,
  command,
}) {
  const client = await browser.newContext({
    extraHTTPHeaders: { Authorization: `Bearer ${token}` },
  });
  try {
    const response = await client.request.post(`${origin}/api/demo`, { data: {} });
    expect(response.ok()).toBe(true);
    const task = await response.json();
    await expect
      .poll(
        async () =>
          (await (await client.request.get(`${origin}/api/tasks/${task.id}`)).json()).task.state,
      )
      .toBe('awaiting_publication');
    const recordingPath = join(scratch, 'terminal.json');
    await command('python3', [
      join(root, 'scripts/capture-cli.py'),
      process.execPath,
      join(root, 'dist/server/cli.js'),
      configFile,
      recordingPath,
      task.id,
    ]);
    const capture = JSON.parse(readFileSync(recordingPath, 'utf8'));
    writeFileSync(
      join(root, '.reviewloop/media-build/last-terminal-vt.json'),
      JSON.stringify(capture),
    );
    for (const recording of capture.recordings) {
      for (const snapshot of recording.snapshots) {
        const page = await browser.newPage({
          viewport: { width: 1500, height: 1100 },
          deviceScaleFactor: 1,
        });
        try {
          await page.setContent(
            '<!doctype html><meta charset="utf-8"><style>body{margin:0;padding:12px;background:#102019}#terminal{display:inline-block}.xterm-viewport{overflow:hidden!important}</style><div id="terminal"></div>',
          );
          await page.addStyleTag({ path: join(root, 'node_modules/@xterm/xterm/css/xterm.css') });
          await page.addScriptTag({ path: join(root, 'node_modules/@xterm/xterm/lib/xterm.js') });
          const visible = await page.evaluate(
            async ({ events, columns, rows, theme }) => {
              const terminal = new window.Terminal({
                cols: columns,
                rows,
                fontFamily: 'JetBrains Mono, monospace',
                fontSize: 15,
                lineHeight: 1.15,
                cursorBlink: false,
                theme: { background: theme === 'light' ? '#f5f8f4' : '#102019' },
                allowProposedApi: true,
              });
              terminal.open(document.querySelector('#terminal'));
              for (const event of events) {
                if (event.resize) terminal.resize(...event.resize);
                else await new Promise((resolve) => terminal.write(event.data, resolve));
              }
              await new Promise((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(resolve)),
              );
              return Array.from({ length: terminal.rows }, (_, i) =>
                terminal.buffer.active.getLine(i)?.translateToString(true),
              ).join('\n');
            },
            { ...recording, events: recording.events.slice(0, snapshot.at) },
          );
          expect(visible).toContain('reviewloop');
          expect(visible).toContain('Ctrl+Q');
          if (snapshot.name === 'cli-chat') expect(visible).toContain('ordering');
          if (snapshot.name === 'cli-author') expect(visible).toContain('Unsent author draft');
          const bounds = await page.locator('#terminal').boundingBox();
          await page.setViewportSize({
            width: Math.ceil(bounds.width) + 24,
            height: Math.ceil(bounds.height) + 24,
          });
          await page.screenshot({ path: join(output, snapshot.name + '.png') });
        } finally {
          await page.close();
        }
      }
    }
    writeFileSync(
      join(root, '.reviewloop/media-build/last-terminal.json'),
      JSON.stringify(
        {
          verified: capture.verified,
          snapshots: capture.recordings.flatMap((recording) =>
            recording.snapshots.map((snapshot) => snapshot.name),
          ),
        },
        null,
        2,
      ),
    );
    console.log('Captured real terminal screens, including dark/light themes and compact layout');
  } finally {
    await client.close();
  }
}
