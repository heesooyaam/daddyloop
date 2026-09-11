import { it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Telegram, TelegramApi, type Update } from '../src/integrations/telegram.js';
import { fixture } from './helpers.js';
function transport() {
  const sent: { method: string; body: Record<string, unknown> }[] = [];
  const api = new TelegramApi('123456:abcdefghijklmnopqrstuvwxyz123456', async (url, options) => {
    sent.push({ method: String(url).split('/').at(-1)!, body: JSON.parse(String(options?.body)) });
    return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
  });
  return { api, sent };
}
function update(id: number, text: string, user = 7): Update {
  return {
    update_id: id,
    message: { text, chat: { id: user, type: 'private' }, from: { id: user } },
  };
}
it('replaces a chat only with a fresh pairing link and supports explicit revocation', async () => {
  const f = await fixture(),
    t = transport(),
    bot = new Telegram(f.engine, t.api, 'test_bot');
  try {
    const first = new URL(bot.pair().url).searchParams.get('start');
    await bot.handle(update(1, '/start ' + first));
    await bot.handle(update(2, '/start ' + first, 99));
    expect(f.store.setting<{ userId: number }>('telegram.pairing')?.userId).toBe(7);
    const second = new URL(bot.pair().url).searchParams.get('start');
    await bot.handle(update(3, '/start ' + second, 99));
    expect(f.store.setting<{ userId: number }>('telegram.pairing')?.userId).toBe(99);
    const count = t.sent.length;
    await bot.handle(update(4, '/tasks'));
    expect(t.sent).toHaveLength(count);
    bot.unpair();
    await bot.handle(update(5, '/tasks', 99));
    expect(t.sent).toHaveLength(count);
  } finally {
    f.store.close();
  }
});
it('resets polling receipts and chat binding when the configured bot changes', async () => {
  const f = await fixture(),
    dir = mkdtempSync(join(tmpdir(), 'daddyloop-telegram-test-')),
    path = join(dir, 'token');
  writeFileSync(path, '123456:abcdefghijklmnopqrstuvwxyz123456', { mode: 0o600 });
  let identity = 12;
  vi.stubGlobal(
    'fetch',
    async (url: string) =>
      new Response(
        JSON.stringify({
          ok: true,
          result: url.endsWith('getMe') ? { id: identity, username: 'test_bot' } : { url: '' },
        }),
      ),
  );
  try {
    await Telegram.create(f.engine, path);
    f.store.setSetting('telegram.offset', 1000);
    f.store.setSetting('telegram.pairing', { userId: 7 });
    f.store.db.prepare('INSERT INTO bot_receipts VALUES(?,?)').run(999, new Date().toISOString());
    await Telegram.create(f.engine, path);
    expect(f.store.setting('telegram.offset')).toBe(1000);
    identity = 13;
    await Telegram.create(f.engine, path);
    expect(f.store.setting('telegram.offset')).toBe(0);
    expect(f.store.setting('telegram.pairing')).toBeNull();
    expect(f.store.db.prepare('SELECT COUNT(*) AS n FROM bot_receipts').get()?.n).toBe(0);
  } finally {
    vi.unstubAllGlobals();
    f.store.close();
    rmSync(dir, { recursive: true });
  }
});
it('ignores unknown chats and binds a one-use pairing to one private user', async () => {
  const f = await fixture(),
    t = transport(),
    bot = new Telegram(f.engine, t.api, 'test_bot');
  await bot.handle(update(1, '/tasks'));
  expect(t.sent).toHaveLength(0);
  const code = new URL(bot.pair().url).searchParams.get('start');
  await bot.handle(update(2, '/start ' + code));
  expect(bot.status().paired).toBe(true);
  const count = t.sent.length;
  await bot.handle(update(3, '/tasks', 99));
  expect(t.sent).toHaveLength(count);
  await bot.handle(update(4, '/tasks'));
  expect(t.sent.at(-1)?.body.text).toContain('daddy');
  const after = t.sent.length;
  await bot.handle(update(4, '/tasks'));
  expect(t.sent).toHaveLength(after);
  f.store.close();
});
it('serves formatted navigation and preference buttons only to the paired private user', async () => {
  const f = await fixture(),
    t = transport(),
    bot = new Telegram(f.engine, t.api, 'test_bot');
  try {
    await bot.handle(update(1, '/start ' + new URL(bot.pair().url).searchParams.get('start')));
    expect(t.sent.at(-1)?.body.entities).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'bold' })]),
    );
    const click = (id: number, data: string, user = 7): Update => ({
      update_id: id,
      callback_query: {
        id: 'cb' + id,
        data,
        from: { id: user },
        message: { chat: { id: user, type: 'private' } },
      },
    });
    const before = t.sent.length;
    await bot.handle(click(2, 'dad:sessions', 99));
    await bot.handle(click(3, 'notifications:off', 99));
    expect(t.sent).toHaveLength(before);
    expect(f.store.setting('notifications.telegram')).toBeUndefined();
    await bot.handle(click(4, 'tasks:0'));
    expect(t.sent.at(-1)?.body.text).toContain('Unknown action');
    await bot.handle(click(5, 'task:' + f.task.id));
    expect(t.sent.at(-1)?.body.text).toContain('Unknown action');
    await bot.handle(click(6, 'notifications:off'));
    expect(f.store.setting('notifications.telegram')).toEqual({
      enabled: false,
      mode: 'attention',
    });
    await bot.handle(click(7, 'notifications:on'));
    expect(f.store.setting('notifications.telegram')).toEqual({ enabled: true, mode: 'attention' });
  } finally {
    f.store.close();
  }
});
it('switches English/Russian only for the bound user and reads fresh model choices from the CLI catalogue', async () => {
  const { catalogue, profiles } = await import('./planning-fixture.js');
  const { UpdateMonitor } = await import('../src/core/updates.js');
  const f = await fixture(),
    t = transport(),
    bot = new Telegram(f.engine, t.api, 'test_bot');
  const list = vi.fn(catalogue.list),
    updates = new UpdateMonitor(f.store, { probe: async () => ({ source: 'missing' }) });
  bot.configure({ catalogue: { ...catalogue, list }, updates });
  try {
    f.engine.setDefaultAgents(profiles);
    await bot.handle(update(1, '/start ' + new URL(bot.pair().url).searchParams.get('start')));
    await bot.handle(update(2, '/language en'));
    expect(t.sent.at(-1)?.body.text).toContain('Language');
    expect(f.store.setting<{ locale: string }>('preferences')?.locale).toBe('en');
    await bot.handle(update(3, '/language ru', 99));
    expect(f.store.setting<{ locale: string }>('preferences')?.locale).toBe('en');
    await bot.handle(update(4, '/models'));
    expect(t.sent.at(-1)?.body.text).toContain(profiles.worker.model);
    expect(list).toHaveBeenCalledWith(false);
    await bot.handle({
      update_id: 5,
      callback_query: {
        id: 'fresh-models',
        data: 'models:refresh',
        from: { id: 7 },
        message: { chat: { id: 7, type: 'private' } },
      },
    });
    expect(list).toHaveBeenCalledWith(true);
    await bot.handle({
      update_id: 6,
      callback_query: {
        id: 'language-ru',
        data: 'language:ru',
        from: { id: 7 },
        message: { chat: { id: 7, type: 'private' } },
      },
    });
    expect(f.store.setting<{ locale: string }>('preferences')?.locale).toBe('ru');
    expect(t.sent.at(-1)?.body.text).toContain('Язык');
  } finally {
    await updates.stop();
    f.store.close();
  }
});
it('sends one CLI update notice per version and respects notification opt-out', async () => {
  const f = await fixture(),
    sent: string[] = [];
  const api = new TelegramApi('123456:abcdefghijklmnopqrstuvwxyz123456', async (url, options) => {
    if (String(url).endsWith('/getUpdates'))
      return new Promise((_resolve, reject) =>
        options?.signal?.addEventListener('abort', () => reject(new Error('stopped')), {
          once: true,
        }),
      );
    const body = JSON.parse(String(options?.body));
    if (body.text) sent.push(body.text);
    return new Response(JSON.stringify({ ok: true, result: {} }));
  });
  const bot = new Telegram(f.engine, api, 'fixture_bot');
  await bot.handle(update(1, '/start ' + new URL(bot.pair().url).searchParams.get('start')));
  await bot.handle(update(2, '/language en'));
  const baseline = sent.length;
  bot.start();
  const notice = {
    kind: 'available',
    checkedAt: new Date().toISOString(),
    tool: {
      id: 'codex',
      name: 'Codex CLI',
      supported: true,
      source: 'bundled',
      installed: '1.0.0',
      latest: '1.1.0',
      updateAvailable: true,
      releaseUrl: 'https://example.com/releases',
    },
  };
  try {
    f.store.event('_system', 'runtime.update_available', notice);
    f.store.event('_system', 'runtime.update_available', notice);
    await vi.waitFor(() => expect(sent).toHaveLength(baseline + 1));
    expect(sent.at(-1)).toContain('CLI update available');
    f.store.setSetting('updates.notifications', false);
    f.store.event('_system', 'runtime.update_available', {
      ...notice,
      tool: { ...notice.tool, latest: '1.2.0' },
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(sent).toHaveLength(baseline + 1);
  } finally {
    await bot.stop();
    f.store.close();
  }
});
