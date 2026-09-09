import { prRef } from '../src/core/types.js';
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
    dir = mkdtempSync(join(tmpdir(), 'reviewloop-telegram-test-')),
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
  expect(t.sent.at(-1)?.body.text).toContain(f.task.title);
  const after = t.sent.length;
  await bot.handle(update(4, '/tasks'));
  expect(t.sent).toHaveLength(after);
  f.store.close();
});
it('publishes only after a fresh human callback, with duplicate callbacks unable to repeat it', async () => {
  const f = await fixture(),
    t = transport(),
    bot = new Telegram(f.engine, t.api, 'test_bot');
  await f.engine.review(f.task.id);
  await f.engine.broker.call(f.job(), 'add_comment', { key: 'R1', body: 'Fix me' });
  await f.run();
  const code = new URL(bot.pair().url).searchParams.get('start');
  await bot.handle(update(1, '/start ' + code));
  await bot.handle(update(2, '/publish ' + f.task.id));
  expect(f.store.getTask(f.task.id).state).toBe('awaiting_publication');
  const buttons = t.sent.at(-1)?.body.reply_markup as {
    inline_keyboard: { callback_data: string }[][];
  };
  const callback = {
    id: 'cb1',
    from: { id: 7 },
    message: { chat: { id: 7, type: 'private' } },
    data: buttons.inline_keyboard[0][0].callback_data,
  };
  await bot.handle({ update_id: 3, callback_query: callback });
  expect(f.store.getTask(f.task.id).state).toBe('fixing');
  await bot.handle({ update_id: 4, callback_query: callback });
  expect(f.store.jobs().filter((j) => j.kind === 'fix')).toHaveLength(1);
  f.store.close();
});
it('rejects a Telegram publication confirmation if the review text changed', async () => {
  const f = await fixture(),
    t = transport(),
    bot = new Telegram(f.engine, t.api, 'test_bot');
  await f.engine.review(f.task.id);
  await f.run();
  const code = new URL(bot.pair().url).searchParams.get('start');
  await bot.handle(update(1, '/start ' + code));
  await bot.handle(update(2, '/publish ' + f.task.id));
  const buttons = t.sent.at(-1)?.body.reply_markup as {
    inline_keyboard: { callback_data: string }[][];
  };
  const task = f.store.getTask(f.task.id);
  await f.provider.updateSummary(prRef(task), task.review!, 'Changed after confirmation');
  await bot.handle({
    update_id: 3,
    callback_query: {
      id: 'cb1',
      from: { id: 7 },
      message: { chat: { id: 7, type: 'private' } },
      data: buttons.inline_keyboard[0][0].callback_data,
    },
  });
  expect(f.store.getTask(task.id).state).toBe('awaiting_publication');
  expect(t.sent.at(-1)?.body.text).toContain('changed');
  f.store.close();
});
it('routes author and reviewer chats separately and keeps long responses complete', async () => {
  const f = await fixture(),
    t = transport(),
    bot = new Telegram(f.engine, t.api, 'test_bot');
  await f.engine.review(f.task.id);
  await f.run();
  const code = new URL(bot.pair().url).searchParams.get('start');
  await bot.handle(update(1, '/start ' + code));
  await bot.handle(update(2, `/reviewer ${f.task.id} Explain the race`));
  expect(f.store.messages(f.task.id).at(-1)).toMatchObject({
    role: 'reviewer',
    text: 'Explain the race',
  });
  const text = 'x'.repeat(5000);
  await t.api.send(7, text);
  const chunks = t.sent.filter((s) => String(s.body.text).startsWith('xxx'));
  expect(chunks).toHaveLength(2);
  expect(
    chunks
      .map((c) => String(c.body.text).replace('\n[continued in the next message]', ''))
      .join(''),
  ).toBe(text);
  f.store.close();
});

it('sends quiet completion notices once, supports all replies and can be disabled from the bot', async () => {
  const f = await fixture(),
    sent: Record<string, unknown>[] = [];
  const api = new TelegramApi('123456:abcdefghijklmnopqrstuvwxyz123456', async (url, options) => {
    if (String(url).endsWith('/getUpdates'))
      return new Promise((_resolve, reject) =>
        options?.signal?.addEventListener('abort', () => reject(new Error('stopped')), {
          once: true,
        }),
      );
    sent.push(JSON.parse(String(options?.body)));
    return new Response(JSON.stringify({ ok: true, result: {} }));
  });
  const bot = new Telegram(f.engine, api, 'test_bot');
  await bot.handle(update(1, '/start ' + new URL(bot.pair().url).searchParams.get('start')));
  const baseline = sent.length;
  bot.start();
  try {
    f.store.message(f.task.id, 'reviewer', 'agent', 'Intermediate reply');
    await new Promise((resolve) => setImmediate(resolve));
    expect(sent).toHaveLength(baseline);
    const task = f.store.getTask(f.task.id);
    task.state = 'complete';
    task.reason = 'All checks passed';
    f.store.saveTask(task);
    f.store.event(task.id, 'task.state', { state: 'complete' });
    f.store.event(task.id, 'task.state', { state: 'complete' });
    await vi.waitFor(() => expect(sent).toHaveLength(baseline + 1));
    expect(sent.at(-1)?.text).toContain('✅ Задача завершена');
    expect(sent.at(-1)?.text).toContain('CI: пройдены');
    await bot.handle(update(2, '/notifications all'));
    f.store.message(task.id, 'author', 'agent', 'Detailed author reply');
    await vi.waitFor(() => expect(sent.at(-1)?.text).toContain('Detailed author reply'));
    await bot.handle(update(3, '/notifications off'));
    const after = sent.length;
    f.store.message(task.id, 'reviewer', 'agent', 'Silenced reply');
    await new Promise((resolve) => setImmediate(resolve));
    expect(sent).toHaveLength(after);
  } finally {
    await bot.stop();
    f.store.close();
  }
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
    await bot.handle(click(2, 'tasks:0', 99));
    await bot.handle(click(3, 'notifications:off', 99));
    expect(t.sent).toHaveLength(before);
    expect(f.store.setting('notifications.telegram')).toBeUndefined();
    await bot.handle(click(4, 'tasks:0'));
    expect(t.sent.at(-1)?.body.text).toContain(f.task.title);
    await bot.handle(click(5, 'task:' + f.task.id));
    expect(t.sent.at(-1)?.body.text).toContain('Задача ' + f.task.id.slice(0, 8));
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
it('opens a fresh confirmation from the task button before any publication occurs', async () => {
  const f = await fixture(),
    t = transport(),
    bot = new Telegram(f.engine, t.api, 'test_bot');
  try {
    await f.engine.review(f.task.id);
    await f.run();
    await bot.handle(update(1, '/start ' + new URL(bot.pair().url).searchParams.get('start')));
    const callback = (id: number, data: string): Update => ({
      update_id: id,
      callback_query: {
        id: 'cb' + id,
        data,
        from: { id: 7 },
        message: { chat: { id: 7, type: 'private' } },
      },
    });
    await bot.handle(callback(2, 'publish:' + f.task.id));
    expect(f.store.getTask(f.task.id).state).toBe('awaiting_publication');
    const review = f.store.getTask(f.task.id).review!;
    expect((await f.provider.getReview(prRef(f.task), review)).status).toBe('draft');
    const buttons = t.sent.at(-1)!.body.reply_markup as {
      inline_keyboard: { callback_data: string }[][];
    };
    const confirmation = buttons.inline_keyboard[0][0].callback_data;
    expect(confirmation).not.toContain('publish:');
    await bot.handle(callback(3, confirmation));
    expect((await f.provider.getReview(prRef(f.task), review)).status).toBe('published');
  } finally {
    f.store.close();
  }
});
