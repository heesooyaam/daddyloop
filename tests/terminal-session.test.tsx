import { render } from 'ink';
import { PassThrough } from 'node:stream';
import { expect, it, vi } from 'vitest';
import { DaddyClient, type DaddyApi } from '../src/client/daddy.js';
import { DaddyTerminal } from '../src/terminal/daddy.js';
import { translator } from '../src/i18n/index.js';

it.each(['en', 'ru'] as const)(
  'shows a missing console session and keeps its draft (%s)',
  async (locale) => {
    const id = 'ac380b76-0f6b-48b0-8c18-8067bfdc44d8';
    const calls: string[] = [];
    const api: DaddyApi = async <T,>(path: string) => {
      calls.push(path);
      return (
        path === '/daddy/sessions'
          ? [
              {
                id: '4e69082d-ce0f-43a7-bfd7-aca7ca18355f',
                title: 'Available chat',
                complete: 0,
                total: 0,
              },
            ]
          : path === '/usage'
            ? { agents: [] }
            : {}
      ) as T;
    };
    const model = new DaddyClient(api, id);
    await model.refresh();
    model.draft('Keep this draft');
    const stdout = Object.assign(new PassThrough(), { columns: 100, rows: 38 });
    const stdin = Object.assign(new PassThrough(), {
      isTTY: true,
      setRawMode: () => stdin,
      ref: () => stdin,
      unref: () => stdin,
    });
    let frame = '';
    stdout.on('data', (chunk) => {
      frame = String(chunk);
    });
    const terminal = render(<DaddyTerminal model={model} preferred={locale} />, {
      stdin: stdin as unknown as typeof process.stdin,
      stdout: stdout as unknown as typeof process.stdout,
      debug: true,
      interactive: true,
      patchConsole: false,
      exitOnCtrlC: false,
    });
    try {
      await vi.waitFor(() => {
        expect(frame).toContain(id);
        expect(frame).toContain('Ctrl+T');
        expect(frame).not.toContain('Available chat');
        expect(frame).not.toContain(translator(locale)('Start a daddy session first.'));
      });
      stdin.write('\r');
      await vi.waitFor(() => expect(frame).toContain('Available chat'));
      expect(model.snapshot().selected).toBe(id);
      expect(model.snapshot().drafts[id]).toBe('Keep this draft');
      expect(calls.some((path) => path.endsWith('/chat'))).toBe(false);
    } finally {
      terminal.unmount();
      terminal.cleanup();
      model.stop();
    }
  },
);
