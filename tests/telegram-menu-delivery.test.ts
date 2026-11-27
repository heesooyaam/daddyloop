import { expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { daddyFixture } from './daddy-fixture.js';
import { catalogue } from './planning-fixture.js';
import { Store } from '../src/core/store.js';
import { UpdateMonitor } from '../src/core/updates.js';
import { setLocale } from '../src/core/preferences.js';
import { Telegram, TelegramApi, type Update } from '../src/integrations/telegram.js';
import { TelegramDelivery } from '../src/integrations/telegram-delivery.js';
import { TelegramText } from '../src/integrations/telegram-text.js';

function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, promise };
}
const text = (v: string) => new TelegramText().add(v);

it.each(['topic', 'private'] as const)(
  'delivers /queue and the status button in a %s while an earlier agent send is in flight',
  async (kind) => {
    const f = daddyFixture(true),
      started = gate(),
      release = gate(),
      confirmed: string[] = [];
    let sequence = 100;
    const api = new TelegramApi('123456:abcdefghijklmnopqrstuvwxyz123456', async (url, options) => {
      const body = JSON.parse(String(options?.body));
      const method = String(url).split('/').at(-1)!;
      if (method === 'sendMessage') {
        if (body.text === 'Agent A') {
          started.open();
          await release.promise;
        }
        confirmed.push(body.text);
      }
      return Response.json({
        ok: true,
        result: method === 'sendMessage' ? { message_id: ++sequence } : true,
      });
    });
    const bot = new Telegram(f.engine, api, 'fixture_bot');
    const group = f.daddy.create({ workspaceId: f.workspace.id });
    const dest = kind === 'topic' ? { chatId: -10042, threadId: 17 } : { chatId: 7 };
    const chat = { id: dest.chatId, type: kind === 'topic' ? 'supergroup' : 'private' };
    const msg = (id: number, value: string): Update => ({
      update_id: id,
      message: {
        message_id: id,
        chat,
        from: { id: 7 },
        message_thread_id: dest.threadId,
        text: value,
      },
    });
    const cb: Update = {
      update_id: 3,
      callback_query: {
        id: 'c3',
        data: 'dad:status:' + group.id,
        from: { id: 7 },
        message: { message_id: 44, chat, message_thread_id: dest.threadId },
      },
    };
    const outgoingMenus = () =>
      f.store.db
        .prepare(
          "SELECT value FROM settings WHERE key GLOB 'telegram.delivery:*' AND json_extract(value,'$.options.requestedMenu')=1",
        )
        .all()
        .map(({ value }) => JSON.parse(String(value)));
    setLocale(f.store, 'en');
    bot.configure({
      catalogue,
      updates: new UpdateMonitor(f.store, { agents: [] }),
      daddy: f.daddy,
    });
    f.store.setSetting('telegram.pairing', { chatId: 7, userId: 7 });
    f.store.setSetting('telegram.group', { chatId: -10042, ownerId: 7 });
    f.store.setSetting('telegram.currentDaddy', group.id);
    f.store.db.prepare('INSERT INTO telegram_topics VALUES(?,?,?)').run(
      '7:-10042:' + group.id,
      group.id,
      JSON.stringify({
        chatId: -10042,
        threadId: 17,
        ownerId: 7,
        groupId: group.id,
        title: group.title,
      }),
    );
    const before = f.store.jobs().length + f.store.daddyJobs().length;
    const first = api.delivery!.send(dest, text('Agent A'), { key: 'first', groupId: group.id });
    try {
      await started.promise;
      await api.delivery!.send(dest, text('Agent B'), { key: 'second', groupId: group.id });
      const command = msg(2, kind === 'topic' ? '/queue@fixture_bot' : '/queue');
      await bot.handle(command);
      await bot.handle(cb);
      await vi.waitFor(() =>
        expect(outgoingMenus().map((x) => x.status)).toEqual(['sent', 'sent']),
      );
      expect(confirmed).toHaveLength(2);
      expect(confirmed[0]).toContain('Task queue');
      expect(
        outgoingMenus().every(
          (x) => x.firstAttemptAt >= x.createdAt && x.sentAt >= x.firstAttemptAt,
        ),
      ).toBe(true);
      expect(f.store.jobs().length + f.store.daddyJobs().length).toBe(before);
      // An accepted menu survives a lost incoming receipt. The same native input has one delivery.
      f.store.db.prepare('DELETE FROM bot_receipts WHERE id IN (2,3)').run();
      await bot.handle(command);
      await bot.handle(cb);
      expect(outgoingMenus()).toHaveLength(2);
      await bot.handle(msg(4, '/queue@other_bot'));
      expect(confirmed).toHaveLength(2);
      release.open();
      await first;
      await api.delivery!.flush();
      expect(confirmed.filter((t) => t === 'Agent A' || t === 'Agent B')).toEqual([
        'Agent A',
        'Agent B',
      ]);
    } finally {
      release.open();
      await first;
      await bot.stop();
      await f.close();
    }
  },
);

it('shares a Telegram flood wait across both sends and resumes a partially confirmed reply after restart', async () => {
  const f = daddyFixture(true),
    sent: string[] = [],
    ack: string[] = [],
    started = gate(),
    release = gate();
  const target = { chatId: 7 };
  let clock = 1000,
    failMenu = true,
    id = 0;
  f.store.setSetting('telegram.pairing', { chatId: 7, userId: 7 });
  const api = {
    call: async (_method: string, body: { text: string }) => {
      sent.push(body.text);
      if (sent.length === 1) {
        started.open();
        await release.promise;
      }
      if (body.text === 'Queue' && failMenu) {
        failMenu = false;
        throw Object.assign(new Error('Flood wait'), { telegramStatus: 429, retryAfter: 10 });
      }
      ack.push(body.text);
      return { message_id: ++id };
    },
  } as unknown as TelegramApi;
  const old = new TelegramDelivery(f.store, api, 'fixture', () => clock);
  let opened: Store | undefined, restored: TelegramDelivery | undefined;
  const first = old.send(target, text('A'.repeat(4500)), { key: 'a' });
  try {
    await started.promise;
    await old.send(target, text('Queue'), { key: 'menu', requestedMenu: true });
    await vi.waitFor(() => expect(f.store.setting('telegram.deliveryLimit:fixture')).toBe(11000));
    release.open();
    await first;
    await old.stop();
    expect(sent).toHaveLength(2);
    expect(ack).toHaveLength(1);
    opened = new Store(join(f.dir, 'state.sqlite'));
    restored = new TelegramDelivery(opened, api, 'fixture', () => clock);
    await restored.send(target, text('Agent B'), { key: 'b' });
    await restored.flush();
    clock = 10999;
    await restored.flush();
    expect(sent).toHaveLength(2);
    clock = 11000;
    await restored.flush();
    expect(ack.filter((v) => v === 'Queue')).toEqual(['Queue']);
    expect(ack.filter((v) => v !== 'Queue').join('')).toBe('A'.repeat(4500) + 'Agent B');
    expect(restored.status().pending).toBe(0);
  } finally {
    release.open();
    await first;
    await old.stop();
    await restored?.stop();
    opened?.close();
    await f.close();
  }
});

it('keeps a menu durable during a flood wait from agent delivery and suppresses it after a topic moves', async () => {
  const f = daddyFixture(true);
  const group = f.daddy.create({ workspaceId: f.workspace.id });
  f.store.setSetting('telegram.pairing', { chatId: 7, userId: 7 });
  f.store.setSetting('telegram.group', { chatId: -10042, ownerId: 7 });
  const target = { chatId: -10042, threadId: 17 },
    tk = '7:-10042:' + group.id;
  const bind = (threadId: number) =>
    f.store.db
      .prepare('INSERT OR REPLACE INTO telegram_topics VALUES(?,?,?)')
      .run(tk, group.id, JSON.stringify({ ...target, threadId, ownerId: 7, groupId: group.id }));
  bind(17);
  let now = 1000;
  const call = vi.fn(async () => ({ message_id: 1 }));
  call.mockRejectedValueOnce(
    Object.assign(new Error('Flood wait'), { retryAfter: 30, telegramStatus: 429 }),
  );
  const api = { call } as unknown as TelegramApi;
  const old = new TelegramDelivery(f.store, api, 'fixture', () => now);
  let next: TelegramDelivery | undefined;
  try {
    await old.send(target, text('agent'), { key: 'agent' });
    await old.send(target, text('Queue'), {
      key: 'menu',
      requestedMenu: true,
      menuTopicGroupId: group.id,
    });
    await old.flush();
    expect(call).toHaveBeenCalledTimes(1);
    await old.stop();
    bind(18);
    now = 31000;
    next = new TelegramDelivery(f.store, api, 'fixture', () => now);
    await next.flush();
    expect(call).toHaveBeenCalledTimes(2);
    const status = f.store.db
      .prepare(
        "SELECT json_extract(value,'$.status') AS state FROM settings WHERE key GLOB 'telegram.delivery:*' AND json_extract(value,'$.options.key')='menu'",
      )
      .get();
    expect(status?.state).toBe('cancelled');
  } finally {
    await old.stop();
    await next?.stop();
    await f.close();
  }
});

it('keeps the longest global flood wait and aborts both in-flight dispatches on stop', async () => {
  const f = daddyFixture(),
    a = gate(),
    b = gate(),
    calls: string[] = [];
  let time = 100,
    shutdown = false,
    aborted = 0;
  const call = async (_method: string, body: { text: string }, signal: AbortSignal) => {
    calls.push(body.text);
    if (shutdown)
      return new Promise((_resolve, reject) =>
        signal.addEventListener(
          'abort',
          () => {
            aborted++;
            reject(new Error('Stopped'));
          },
          { once: true },
        ),
      );
    if (body.text === 'long') {
      await a.promise;
      throw Object.assign(new Error('wait 30'), { retryAfter: 30 });
    }
    await b.promise;
    throw Object.assign(new Error('wait 5'), { retryAfter: 5 });
  };
  f.store.setSetting('telegram.pairing', { chatId: 7, userId: 7 });
  const q = new TelegramDelivery(
    f.store,
    { call } as unknown as TelegramApi,
    'fixture',
    () => time,
  );
  try {
    const old = q.send({ chatId: 7 }, text('long'), { key: 'long' });
    await q.send({ chatId: 7 }, text('short'), { key: 'short', requestedMenu: true });
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    a.open();
    await old;
    time = 200;
    b.open();
    await q.flush();
    expect(f.store.setting('telegram.deliveryLimit:fixture')).toBe(30100);
    time = 30099;
    await q.flush();
    expect(calls).toHaveLength(2);
    time = 30100;
    shutdown = true;
    const pending = q.flush();
    await vi.waitFor(() => expect(calls).toHaveLength(4));
    await q.stop();
    await pending;
    expect(aborted).toBe(2);
    expect(q.status().pending).toBe(2);
  } finally {
    a.open();
    b.open();
    await q.stop();
    await f.close();
  }
});
