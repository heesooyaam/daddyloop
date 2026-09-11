import { expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Telegram, TelegramApi, type Update } from '../src/integrations/telegram.js';
import { CodexUpdater } from '../src/core/codex-updater.js';
import { UpdateMonitor } from '../src/core/updates.js';
import { fixture } from './helpers.js';
it('runs a paired one-use update without blocking bot navigation, reports completion once and offers rollback', async () => {
  const f = await fixture(),
    dir = mkdtempSync(join(tmpdir(), 'daddyloop-telegram-updater-test-'));
  const sent: {
    text: string;
    reply_markup?: { inline_keyboard: { text: string; callback_data?: string }[][] };
  }[] = [];
  const api = new TelegramApi('123456:abcdefghijklmnopqrstuvwxyz123456', async (url, options) => {
    if (String(url).endsWith('/getUpdates'))
      return new Promise((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => reject(new Error('stopped')), {
          once: true,
        });
      });
    const body = JSON.parse(String(options?.body));
    if (body.text) sent.push(body);
    return new Response(JSON.stringify({ ok: true, result: {} }));
  });
  let selected = '/old/codex',
    finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const install = vi.fn(async () => {
    await gate;
    return '/new/codex';
  });
  const updater = new CodexUpdater(f.store, {
    dataDir: dir,
    executable: () => selected,
    activate: (_previous, next) => {
      selected = next;
    },
    resourceCheck: () => {},
    latest: async () => ({
      version: '2.0.0',
      platform: 'linux-x64',
      url: 'fixture',
      integrity: 'fixture',
    }),
    probe: async (executable) => ({
      executable,
      version: executable === '/old/codex' ? '1.0.0' : '2.0.0',
    }),
    install,
    validate: async () => ({
      version: '2.0.0',
      models: [{ id: 'fixture', name: 'Test', efforts: [], defaultEffort: 'max', isDefault: true }],
    }),
  });
  const updates = new UpdateMonitor(f.store, {
    codex: () => selected,
    fetcher: async () => new Response('{"version":"2.0.0"}'),
    probe: async (path) =>
      path === 'claude'
        ? { source: 'missing' }
        : { path, version: path === '/old/codex' ? '1.0.0' : '2.0.0', source: 'managed' },
  });
  const bot = new Telegram(f.engine, api, 'fixture_bot');
  bot.configure({
    updater,
    updates,
    catalogue: { list: async () => [], validate: async () => {} },
  });
  let id = 1;
  const message = (text: string): Update => ({
    update_id: id++,
    message: { text, chat: { id: 7, type: 'private' }, from: { id: 7 } },
  });
  const click = (data: string, user = 7): Update => ({
    update_id: id++,
    callback_query: {
      id: String(id),
      data,
      from: { id: user },
      message: { chat: { id: 7, type: 'private' } },
    },
  });
  try {
    await bot.handle(message('/start ' + new URL(bot.pair().url).searchParams.get('start')));
    await bot.handle(message('/language ru'));
    await updates.check(true);
    bot.start();
    await bot.handle(click('codex:install'));
    const confirmation = sent
      .at(-1)!
      .reply_markup!.inline_keyboard.flat()
      .find((button) => button.callback_data?.startsWith('codex:confirm:'))!;
    expect(sent.at(-1)!.text).toContain('1.0.0 → 2.0.0');
    expect(install).not.toHaveBeenCalled();
    await bot.handle(click(confirmation.callback_data!, 99));
    expect(install).not.toHaveBeenCalled();
    await bot.handle(click(confirmation.callback_data!));
    expect(sent.at(-1)!.text).toContain('Обновление Codex началось');
    expect(updater.status().busy).toBe(true);
    await bot.handle(message('/tasks'));
    expect(sent.at(-1)!.text).toContain('daddy');
    await bot.handle(click(confirmation.callback_data!));
    expect(install).toHaveBeenCalledOnce();
    finish();
    await vi.waitFor(() =>
      expect(sent.some((card) => card.text.includes('Версия Codex переключена'))).toBe(true),
    );
    expect(selected).toBe('/new/codex');
    f.store.event('_system', 'runtime.update_finished', updater.status().operation);
    await new Promise((resolve) => setImmediate(resolve));
    expect(sent.filter((card) => card.text.includes('Версия Codex переключена'))).toHaveLength(1);
    await bot.handle(message('/updates'));
    expect(
      sent
        .at(-1)!
        .reply_markup!.inline_keyboard.flat()
        .some((button) => button.callback_data === 'codex:rollback'),
    ).toBe(true);
  } finally {
    finish();
    await updater.stop();
    await updates.stop();
    await bot.stop();
    f.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
