import { join } from 'node:path';
import { it, expect, vi } from 'vitest';
import { Store } from '../src/core/store.js';
import { TelegramDelivery, dialogKey } from '../src/integrations/telegram-delivery.js';
import { TelegramText } from '../src/integrations/telegram-text.js';
import { daddyFixture } from './daddy-fixture.js';
import { TelegramApi } from '../src/integrations/telegram.js';

function fixture() {
  const store = new Store(':memory:');
  store.setSetting('telegram.pairing', { chatId: 7, userId: 7 });
  store.setSetting('telegram.group', { chatId: -10042, ownerId: 7 });
  let now = 1000,
    id = 0;
  const call = vi.fn(async (_method: string, _body?: any) => ({ message_id: ++id }));
  const transport = { call } as unknown as TelegramApi;
  const queue = new TelegramDelivery(store, transport, 'test_bot', () => now);
  return {
    store,
    queue,
    call,
    transport,
    advance: (ms: number) => {
      now += ms;
    },
    clock: () => now,
    async close() {
      await queue.stop();
      store.close();
    },
  };
}
it('resolves a private reply only against a matching bot, owner, chat and native message', async () => {
  const f = fixture();
  try {
    await f.queue.send({ chatId: 7 }, new TelegramText().add('Question'), {
      groupId: 'original-session',
      key: 'question',
    });
    expect(f.queue.replySession(7, 1, 7)).toBe('original-session');
    expect(f.queue.replySession(-10042, 1, 7)).toBeUndefined();
    expect(f.queue.replySession(7, 1, 12)).toBeUndefined();
    expect(f.queue.replySession(7, 99, 7)).toBeUndefined();
  } finally {
    await f.close();
  }
});
const text = (value: string) => new TelegramText().add(value);

it('keeps status edits delivering while a durable pin retries', async () => {
  const f = fixture();
  const target = { chatId: -10042, threadId: 4 };
  const options = { key: 'status', replace: true, pin: true };
  f.store.db
    .prepare('INSERT INTO telegram_topics VALUES(?,?,?)')
    .run('7:-10042:session', 'session', JSON.stringify(target));
  f.store.saveGroup({ id: 'session' } as Parameters<Store['saveGroup']>[0]);
  let restored: TelegramDelivery | undefined;
  try {
    await f.queue.send(target, text('Waiting'), options);
    f.call.mockRejectedValueOnce(new Error('Network unavailable'));
    await f.queue.flush();
    expect(f.queue.status().pending).toBe(1);
    await f.queue.send(target, text('Working'), options);
    expect(f.call.mock.calls.at(-1)).toMatchObject([
      'editMessageText',
      { message_id: 1, text: 'Working' },
      expect.anything(),
    ]);
    await f.queue.stop();
    restored = new TelegramDelivery(f.store, f.transport, 'test_bot', f.clock);
    f.advance(1000);
    await restored.flush();
    expect(f.call.mock.calls.map(([method]) => method)).toEqual([
      'sendMessage',
      'pinChatMessage',
      'editMessageText',
      'pinChatMessage',
    ]);
    expect(restored.status().pending).toBe(0);
  } finally {
    await restored?.stop();
    await f.close();
  }
});

it('retries a rate-limited receipt reaction after restart and deduplicates repeated updates', async () => {
  const f = fixture();
  let restored: TelegramDelivery | undefined;
  const target = { chatId: -10042, threadId: 4 };
  try {
    f.call.mockRejectedValueOnce(
      Object.assign(new Error('Too many requests'), { retryAfter: 10, telegramStatus: 429 }),
    );
    f.queue.enqueueReaction(target, 116);
    expect(f.call).not.toHaveBeenCalled();
    await f.queue.flush();
    expect(f.queue.status().pending).toBe(1);
    await f.queue.stop();
    restored = new TelegramDelivery(f.store, f.transport, 'test_bot', f.clock);
    f.advance(9999);
    await restored.flush();
    expect(f.call).toHaveBeenCalledOnce();
    f.advance(1);
    await restored.flush();
    expect(f.call.mock.calls.map(([method, body]) => [method, body])).toEqual(
      [1, 2].map(() => [
        'setMessageReaction',
        { chat_id: -10042, message_id: 116, reaction: [{ type: 'emoji', emoji: '👀' }] },
      ]),
    );
    expect(restored.status().pending).toBe(0);
    restored.enqueueReaction(target, 116);
    await restored.flush();
    expect(f.call).toHaveBeenCalledTimes(2);
  } finally {
    await restored?.stop();
    await f.close();
  }
});

it('replaces a confirmed deleted card, but keeps editing after a transient failure', async () => {
  const f = fixture();
  try {
    const options = { key: 'session', replace: true };
    await f.queue.send({ chatId: 7 }, text('Preparing'), options);
    f.call.mockRejectedValueOnce(new Error('connection reset'));
    await f.queue.send({ chatId: 7 }, text('Ready'), options);
    expect(f.call.mock.calls.map(([method]) => method)).toEqual(['sendMessage', 'editMessageText']);
    f.call.mockRejectedValueOnce(new Error('Bad Request: message to edit not found'));
    f.advance(1000);
    await f.queue.flush();
    expect(f.call.mock.calls.map(([method]) => method)).toEqual([
      'sendMessage',
      'editMessageText',
      'editMessageText',
      'sendMessage',
    ]);
    expect(f.queue.status().pending).toBe(0);
    await f.queue.send({ chatId: 7 }, text('Ready'), options);
    expect(f.call).toHaveBeenCalledTimes(4);
    await f.queue.send({ chatId: 7 }, text('Working'), options);
    expect(f.call.mock.calls.at(-1)).toEqual([
      'editMessageText',
      expect.objectContaining({ message_id: 2, text: 'Working' }),
      expect.anything(),
    ]);
  } finally {
    await f.close();
  }
});

it('persists refused messages and retries with exponential backoff after restart', async () => {
  const f = fixture();
  let restored: TelegramDelivery | undefined;
  try {
    f.call
      .mockRejectedValueOnce(new Error('unavailable'))
      .mockRejectedValueOnce(new Error('still unavailable'));
    expect(
      await f.queue.send({ chatId: 7 }, text('Keep this message'), { key: 'message' }),
    ).toMatchObject({ status: 'queued' });
    expect(f.queue.status().pending).toBe(1);
    await f.queue.stop();
    restored = new TelegramDelivery(f.store, f.transport, 'test_bot', f.clock);
    f.advance(999);
    await restored.flush();
    expect(f.call).toHaveBeenCalledTimes(1);
    f.advance(1);
    await restored.flush();
    expect(f.call).toHaveBeenCalledTimes(2);
    f.advance(1999);
    await restored.flush();
    expect(f.call).toHaveBeenCalledTimes(2);
    f.advance(1);
    await restored.flush();
    expect(f.call).toHaveBeenCalledTimes(3);
    expect(restored.status().pending).toBe(0);
    await restored.send({ chatId: 7 }, text('Keep this message'), { key: 'message' });
    expect(f.call).toHaveBeenCalledTimes(3);
  } finally {
    await restored?.stop();
    await f.close();
  }
});

it('wakes buffered delivery on a new reply and keeps messages in conversation order', async () => {
  const f = fixture();
  try {
    f.call.mockRejectedValueOnce(new Error('offline'));
    await f.queue.send({ chatId: 7 }, text('User question'), { key: 'question' });
    await f.queue.send({ chatId: 7 }, text('Agent answer'), { key: 'answer' });
    await f.queue.flush();
    expect(f.call.mock.calls.map(([, body]) => body.text)).toEqual([
      'User question',
      'User question',
      'Agent answer',
    ]);
    expect(f.queue.status().pending).toBe(0);
  } finally {
    await f.close();
  }
});

it('honors Telegram retry_after even when new agent messages arrive', async () => {
  const f = fixture();
  try {
    f.call.mockRejectedValueOnce(Object.assign(new Error('Too many requests'), { retryAfter: 30 }));
    await f.queue.send({ chatId: 7 }, text('Progress'), { key: 'turn', replace: true, order: '1' });
    await f.queue.send({ chatId: 7 }, text('Final'), {
      key: 'turn',
      replace: true,
      final: true,
      order: '2',
    });
    expect(f.call).toHaveBeenCalledTimes(1);
    f.advance(29999);
    await f.queue.flush();
    expect(f.call).toHaveBeenCalledTimes(1);
    f.advance(1);
    await f.queue.flush();
    expect(f.call).toHaveBeenCalledTimes(2);
    expect(f.call.mock.calls[1][1].text).toBe('Final');
  } finally {
    await f.close();
  }
});

it('updates one turn card and never replaces a final answer with replayed progress', async () => {
  const f = fixture();
  try {
    await f.queue.send({ chatId: -10042, threadId: 4 }, text('Checking'), {
      key: 'turn',
      replace: true,
      order: '1',
    });
    await f.queue.send({ chatId: -10042, threadId: 4 }, text('Found the cause'), {
      key: 'turn',
      replace: true,
      order: '2',
    });
    await f.queue.send({ chatId: -10042, threadId: 4 }, text('Done'), {
      key: 'turn',
      replace: true,
      order: '3',
      final: true,
    });
    await f.queue.send({ chatId: -10042, threadId: 4 }, text('Checking'), {
      key: 'turn',
      replace: true,
      order: '1',
    });
    expect(f.call.mock.calls.map(([method]) => method)).toEqual([
      'sendMessage',
      'editMessageText',
      'editMessageText',
    ]);
    expect(f.call.mock.calls[2][1]).toMatchObject({ message_id: 1, text: 'Done' });
  } finally {
    await f.close();
  }
});

it('does not resend acknowledged chunks of a long message after a failure', async () => {
  const f = fixture();
  try {
    f.call.mockResolvedValueOnce({ message_id: 11 }).mockRejectedValueOnce(new Error('refused'));
    await f.queue.send({ chatId: 7 }, text('x'.repeat(9000)), { key: 'long' });
    expect(f.call).toHaveBeenCalledTimes(2);
    f.advance(1000);
    await f.queue.flush();
    expect(f.call).toHaveBeenCalledTimes(4);
    expect(f.call.mock.calls.every(([method]) => method === 'sendMessage')).toBe(true);
    expect(f.queue.status().pending).toBe(0);
  } finally {
    await f.close();
  }
});

it('cancels stale recipients and buffers topic renames using the same retry mechanism', async () => {
  const f = fixture();
  try {
    f.call.mockRejectedValueOnce(new Error('offline'));
    await f.queue.send({ chatId: -10042, threadId: 4 }, text('Renamed task'), {
      key: 'name',
      operation: 'renameTopic',
      replace: true,
    });
    f.advance(1000);
    await f.queue.flush();
    expect(f.call.mock.calls[1]).toEqual([
      'editForumTopic',
      { chat_id: -10042, message_thread_id: 4, name: 'Renamed task' },
      expect.anything(),
    ]);
    f.call.mockRejectedValueOnce(new Error('offline'));
    await f.queue.send({ chatId: 7 }, text('Private pending message'), { key: 'private' });
    f.store.setSetting('telegram.pairing', { chatId: 99, userId: 99 });
    const before = f.call.mock.calls.length;
    f.advance(2000);
    await f.queue.flush();
    expect(f.call).toHaveBeenCalledTimes(before);
    expect(f.queue.status().pending).toBe(0);
  } finally {
    await f.close();
  }
});

it('preserves Telegram retry_after in the transport error', async () => {
  const api = new TelegramApi(
    '123456:abcdefghijklmnopqrstuvwxyz123456',
    async () =>
      new Response(
        JSON.stringify({
          ok: false,
          error_code: 429,
          description: 'Too Many Requests',
          parameters: { retry_after: 12 },
        }),
        { status: 429 },
      ),
  );
  await expect(api.call('sendMessage', {})).rejects.toMatchObject({
    code: 'telegram_error',
    retryAfter: 12,
  });
});

it('does not shorten a Telegram flood wait longer than one day', async () => {
  const f = fixture();
  try {
    f.call.mockRejectedValueOnce(Object.assign(new Error('flood wait'), { retryAfter: 90000 }));
    await f.queue.send({ chatId: 7 }, text('Delayed reply'), { key: 'long-wait' });
    f.advance(86400000);
    await f.queue.flush();
    expect(f.call).toHaveBeenCalledTimes(1);
    f.advance(3600000);
    await f.queue.flush();
    expect(f.call).toHaveBeenCalledTimes(2);
  } finally {
    await f.close();
  }
});

it('adopts sent and partially delivered turn receipts from the released format', async () => {
  const f = daddyFixture();
  f.store.setSetting('telegram.pairing', { chatId: 7, userId: 7 });
  f.store.setSetting('notifications.telegram', { enabled: true, mode: 'all' });
  const group = f.daddy.create({ workspaceId: f.workspace.id });
  const target = { chatId: 7 };
  let clock = 1000;
  const call = vi.fn(async (_method: string, _body: unknown) => ({ message_id: 100 }));
  const connect = () =>
    new TelegramDelivery(
      f.store,
      { call: call as unknown as TelegramApi['call'] },
      'test_bot',
      () => clock,
    );
  let queue = connect();
  try {
    const sent = f.store.finishDaddyReply(group.id, 'Already delivered', 'first');
    const partial = f.store.finishDaddyReply(group.id, 'x'.repeat(9000), 'second');
    const legacy = (message: typeof sent) => ({
      key: 'turn:' + message.runId,
      groupId: group.id,
      notificationId: `telegram:dialog:7:0:${message.id}:final`,
      replace: true,
      final: true,
    });
    await queue.send(target, text(sent.text), legacy(sent));
    call
      .mockResolvedValueOnce({ message_id: 101 })
      .mockRejectedValueOnce(
        Object.assign(new Error('Too many requests'), { retryAfter: 10, telegramStatus: 429 }),
      );
    await queue.send(target, text(partial.text), legacy(partial));
    await queue.stop();
    expect(call).toHaveBeenCalledTimes(3);

    queue = connect();
    const deliver = (message: typeof sent) =>
      queue.send(target, text(message.text), {
        ...legacy(message),
        key: dialogKey(message.id),
        sessionRoute: true,
      });
    expect(await deliver(sent)).toMatchObject({ status: 'sent' });
    expect(await deliver(partial)).toMatchObject({ status: 'queued' });
    await queue.flush();
    expect(call).toHaveBeenCalledTimes(3);
    clock += 10000;
    call.mockResolvedValueOnce({ message_id: 102 }).mockResolvedValueOnce({ message_id: 103 });
    await queue.flush();
    expect(call.mock.calls.slice(3).map(([method]) => method)).toEqual([
      'sendMessage',
      'sendMessage',
    ]);
    expect(queue.replySession(7, 100, 7)).toBe(group.id);
    expect(queue.replySession(7, 101, 7)).toBe(group.id);
    expect(queue.replySession(7, 103, 7)).toBe(group.id);
    expect(await deliver(partial)).toMatchObject({ status: 'sent' });
    expect(call).toHaveBeenCalledTimes(5);
  } finally {
    await queue.stop();
    await f.close();
  }
});

it('drops stale routes and old pings while delivering the public question on the current route', async () => {
  const f = daddyFixture();
  f.store.setSetting('telegram.pairing', { chatId: 7, userId: 7 });
  f.store.setSetting('telegram.group', { chatId: -10042, ownerId: 7 });
  f.store.setSetting('notifications.telegram', { enabled: true, mode: 'all' });
  const group = f.daddy.create({ workspaceId: f.workspace.id });
  f.store.saveGroup({ ...group, daddyState: 'needs_input' });
  const message = f.store.finishDaddyReply(group.id, 'Choose a branch?', 'turn', true);
  const route = (threadId: number) => ({ chatId: -10042, threadId });
  const bind = (threadId: number) =>
    f.store.db
      .prepare('INSERT OR REPLACE INTO telegram_topics VALUES(?,?,?)')
      .run(`7:-10042:${group.id}`, group.id, JSON.stringify(route(threadId)));
  let clock = 1000;
  const call = vi.fn(async (_method: string, _body: unknown) => ({ message_id: 100 }));
  const queue = new TelegramDelivery(
    f.store,
    { call: call as unknown as TelegramApi['call'] },
    'test_bot',
    () => clock,
  );
  const question = { groupId: group.id, messageId: message.id };
  const options = {
    key: dialogKey(message.id),
    groupId: group.id,
    sessionRoute: true,
    final: true,
    mention: { question, text: text('Your reply is needed. ') },
  };
  try {
    bind(12);
    call.mockRejectedValueOnce(
      Object.assign(new Error('Too many requests'), { retryAfter: 10, telegramStatus: 429 }),
    );
    await queue.send(route(12), text(message.text), options);
    await queue.send(route(12), text('Reminder'), {
      ...options,
      key: 'reminder',
      reminder: question,
    });
    bind(13);
    await queue.send(route(13), text(message.text), options);
    f.store.daddyMessage(group.id, 'user', 'Use main');
    clock += 10000;
    await queue.flush();
    expect(call.mock.calls.slice(1)).toEqual([
      [
        'sendMessage',
        expect.objectContaining({ message_thread_id: 13, text: 'Choose a branch?' }),
        expect.anything(),
      ],
    ]);
    expect(queue.status().pending).toBe(0);
  } finally {
    await queue.stop();
    await f.close();
  }
});

it('mentions a new decision by replying to the already delivered public message', async () => {
  const f = daddyFixture();
  const call = vi.fn(async () => ({ message_id: 77 }));
  const queue = new TelegramDelivery(
    f.store,
    { call: call as unknown as TelegramApi['call'] },
    'test_bot',
  );
  const target = { chatId: 7 };
  f.store.setSetting('telegram.pairing', { ...target, userId: 7 });
  f.store.setSetting('notifications.telegram', { enabled: true, mode: 'all' });
  try {
    const group = f.daddy.create({ workspaceId: f.workspace.id });
    const message = f.store.daddyMessage(group.id, 'agent', 'Choose a branch?', 'turn', undefined, {
      phase: 'progress',
    });
    const options = {
      key: dialogKey(message.id),
      groupId: group.id,
      sessionRoute: true,
      replace: true,
    };
    await queue.send(target, text(message.text), options);
    f.store.saveGroup({ ...group, daddyState: 'needs_input' });
    f.store.finishDaddyReply(group.id, message.text, 'turn', true);
    const final = {
      ...options,
      final: true,
      mention: {
        question: { groupId: group.id, messageId: message.id },
        text: text('Your reply is needed.'),
      },
    };
    await queue.send(target, text(message.text), final);
    call.mockResolvedValueOnce({ message_id: 78 });
    await queue.flush();
    expect(call.mock.calls).toEqual([
      ['sendMessage', expect.objectContaining({ text: 'Choose a branch?' }), expect.anything()],
      [
        'sendMessage',
        expect.objectContaining({
          text: 'Your reply is needed.',
          reply_parameters: expect.objectContaining({ message_id: 77 }),
        }),
        expect.anything(),
      ],
    ]);
    await queue.send(target, text(message.text), final);
    expect(call).toHaveBeenCalledTimes(2);
  } finally {
    await queue.stop();
    await f.close();
  }
});

it.each(['new reply', 'final mention'] as const)(
  'reopens confirmed legacy parts through a throttled %s',
  async (variant) => {
    const f = daddyFixture(true);
    const reopened = () => new Store(join(f.dir, 'state.sqlite'));
    f.store.setSetting('telegram.pairing', { chatId: 7, userId: 7 });
    f.store.setSetting('notifications.telegram', { enabled: true, mode: 'all' });
    const group = f.daddy.create({ workspaceId: f.workspace.id });
    f.store.saveGroup({ ...group, daddyState: 'needs_input' });
    const target = { chatId: 7 };
    const chatText = (value: string) =>
      new TelegramText().add('👨‍💻 [daddy]', 'bold').add('\n\n').markdown(value);
    const call = vi.fn(async (_method: string, _body: unknown) => ({ message_id: 51 }));
    let clock = 1000;
    const connect = (store: Store) =>
      new TelegramDelivery(
        store,
        { call: call as unknown as TelegramApi['call'] },
        'test_bot',
        () => clock,
      );
    let queue = connect(f.store);
    let disk: Store | undefined;
    try {
      const first = f.store.daddyMessage(
        group.id,
        'agent',
        'Original reply',
        'legacy-run',
        undefined,
        { phase: 'progress' },
      );
      const notification = (id: string, phase: string) => `telegram:dialog:7:0:${id}:${phase}`;
      const legacyOptions = {
        groupId: group.id,
        key: 'turn:legacy-run',
        replace: true,
        notificationId: notification(first.id, 'progress'),
      };
      await queue.send(target, chatText(first.text), legacyOptions);
      const second = f.store.finishDaddyReply(
        group.id,
        variant === 'new reply' ? 'Independent reply' : first.text,
        'legacy-run',
        variant === 'final mention',
      );
      expect(second.id === first.id).toBe(variant === 'final mention');
      const newId = notification(second.id, 'final');
      call.mockRejectedValueOnce(
        Object.assign(new Error('Too Many Requests'), { retryAfter: 10, telegramStatus: 429 }),
      );
      if (variant === 'new reply') {
        await queue.send(target, chatText(second.text), {
          ...legacyOptions,
          notificationId: newId,
          final: true,
        });
      } else {
        const ping = new TelegramText()
          .add('Your reply is needed.\n\n')
          .append(chatText(second.text));
        await queue.send(target, ping, {
          key: newId,
          groupId: group.id,
          notificationId: newId,
          final: true,
        });
      }
      await queue.stop();
      expect(call).toHaveBeenCalledTimes(2);
      disk = reopened();
      queue = connect(disk);
      await queue.flush();
      expect(call).toHaveBeenCalledTimes(2);
      clock += 10000;
      call.mockResolvedValueOnce({ message_id: 52 });
      await queue.flush();
      expect(call.mock.calls.slice(2)).toEqual([
        [
          'sendMessage',
          variant === 'new reply'
            ? expect.objectContaining({ text: '👨‍💻 [daddy]\n\nIndependent reply' })
            : expect.objectContaining({
                text: 'Your reply is needed.\n\n',
                reply_parameters: expect.objectContaining({ message_id: 51 }),
              }),
          expect.anything(),
        ],
      ]);
      expect(queue.replySession(7, 51, 7)).toBe(group.id);
      expect(queue.replySession(7, 52, 7)).toBe(group.id);
    } finally {
      await queue.stop();
      disk?.close();
      await f.close();
    }
  },
);

it.each(['legacy', 'current'] as const)(
  'cancels all deferred session writes to a replaced %s topic',
  async (format) => {
    const f = daddyFixture();
    f.store.setSetting('telegram.pairing', { chatId: 7, userId: 7 });
    f.store.setSetting('telegram.group', { chatId: -10042, ownerId: 7 });
    f.store.setSetting('notifications.telegram', { enabled: true, mode: 'all' });
    const group = f.daddy.create({ workspaceId: f.workspace.id });
    f.store.saveGroup({ ...group, daddyState: 'needs_input' });
    const question = f.store.finishDaddyReply(group.id, 'Still open?', 'turn', true);
    const route = (threadId: number) => ({ chatId: -10042, threadId });
    const bind = (threadId: number) =>
      f.store.db
        .prepare('INSERT OR REPLACE INTO telegram_topics VALUES(?,?,?)')
        .run(`7:-10042:${group.id}`, group.id, JSON.stringify(route(threadId)));
    const call = vi.fn(async (_method: string, _body: unknown) => ({ message_id: 51 }));
    let clock = 0;
    const connect = () =>
      new TelegramDelivery(
        f.store,
        { call: call as unknown as TelegramApi['call'] },
        'test_bot',
        () => clock,
      );
    let queue = connect();
    const scope = { groupId: group.id, sessionRoute: true };
    const oldScope = format === 'legacy' ? {} : scope;
    try {
      bind(17);
      f.store.setSetting(`telegram.progress:test_bot:${group.id}`, {
        id: 'status-card',
        route: { ...route(17), ownerId: 7 },
      });
      await queue.send(route(17), text('Original status'), {
        ...oldScope,
        key: 'progress:status-card',
        replace: true,
        pin: true,
      });
      call.mockRejectedValueOnce(
        Object.assign(new Error('Flood wait'), { retryAfter: 10, telegramStatus: 429 }),
      );
      await queue.flush();
      await queue.send(route(17), text('Delayed status'), {
        ...oldScope,
        key: 'progress:status-card',
        replace: true,
        pin: true,
      });
      await queue.send(route(17), text('Delayed menu'), {
        ...oldScope,
        key: `telegram:daddy-intro:-10042:${group.id}`,
      });
      await queue.send(route(17), text('Waiting for resources'), {
        ...oldScope,
        key: `resources:${group.id}`,
      });
      await queue.send(route(17), text('Renamed topic'), {
        ...oldScope,
        key: 'topic-name:17',
        operation: 'renameTopic',
      });
      await queue.send(route(17), text('Reminder'), {
        ...oldScope,
        reminder: { groupId: group.id, messageId: question.id },
      });
      bind(18);
      if (format === 'legacy') {
        await queue.stop();
        queue = connect();
      }
      await queue.send(route(18), text('Current status'), {
        ...scope,
        key: 'progress:current',
        pin: true,
      });
      await queue.send(route(18), text('Current menu'), { ...scope, key: 'menu' });
      await queue.send(route(18), text('Still open?'), { ...scope, key: dialogKey(question.id) });
      expect(call).toHaveBeenCalledTimes(2);
      clock += 10000;
      call.mockResolvedValueOnce({ message_id: 52 });
      await queue.flush();
      expect(call.mock.calls.slice(2)).toEqual([
        [
          'sendMessage',
          expect.objectContaining({ message_thread_id: 18, text: 'Current status' }),
          expect.anything(),
        ],
        [
          'sendMessage',
          expect.objectContaining({ message_thread_id: 18, text: 'Current menu' }),
          expect.anything(),
        ],
        [
          'sendMessage',
          expect.objectContaining({ message_thread_id: 18, text: 'Still open?' }),
          expect.anything(),
        ],
        ['pinChatMessage', expect.objectContaining({ message_id: 52 }), expect.anything()],
      ]);
    } finally {
      await queue.stop();
      await f.close();
    }
  },
);

it.each(['same topic', 'changed topic'] as const)(
  'revalidates a deleted-message replacement in the %s',
  async (variant) => {
    const f = daddyFixture();
    f.store.setSetting('telegram.pairing', { chatId: 7, userId: 7 });
    f.store.setSetting('telegram.group', { chatId: -10042, ownerId: 7 });
    f.store.setSetting('notifications.telegram', { enabled: true, mode: 'all' });
    const group = f.daddy.create({ workspaceId: f.workspace.id });
    f.store.saveGroup({ ...group, daddyState: 'needs_input' });
    const message = f.store.finishDaddyReply(group.id, 'Choose one?', 'turn', true);
    const target = { chatId: -10042, threadId: 17 };
    const bind = (threadId: number) =>
      f.store.db
        .prepare('INSERT OR REPLACE INTO telegram_topics VALUES(?,?,?)')
        .run(`7:-10042:${group.id}`, group.id, JSON.stringify({ ...target, threadId }));
    const call = vi.fn(async (_method: string, _body: unknown) => ({ message_id: 51 }));
    const queue = new TelegramDelivery(
      f.store,
      { call: call as unknown as TelegramApi['call'] },
      'test_bot',
    );
    const options = {
      key: dialogKey(message.id),
      groupId: group.id,
      sessionRoute: true,
      replace: true,
      final: true,
    };
    let rejectEdit: ((error: Error) => void) | undefined;
    try {
      bind(17);
      await queue.send(target, text(message.text), options);
      call.mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectEdit = reject;
          }),
      );
      const update = queue.send(target, text(message.text), {
        ...options,
        mention: {
          question: { groupId: group.id, messageId: message.id },
          text: text('Please answer. '),
        },
      });
      await vi.waitFor(() => expect(call.mock.calls[1]?.[0]).toBe('editMessageText'));
      f.store.daddyMessage(group.id, 'user', 'Answered');
      if (variant === 'changed topic') bind(18);
      rejectEdit!(new Error('Bad Request: message to edit not found'));
      await update;
      await queue.flush();
      expect(call.mock.calls.slice(2)).toEqual(
        variant === 'changed topic'
          ? []
          : [
              [
                'sendMessage',
                expect.objectContaining({ message_thread_id: 17, text: 'Choose one?' }),
                expect.anything(),
              ],
            ],
      );
      expect(queue.status().pending).toBe(0);
    } finally {
      rejectEdit?.(new Error('Released test request'));
      await queue.stop();
      await f.close();
    }
  },
);

it.each(['off', 'attention'] as const)(
  'checks private notification mode %s and an older closed task after replay',
  async (mode) => {
    const f = daddyFixture();
    f.store.setSetting('telegram.pairing', { chatId: 7, userId: 7 });
    f.store.setSetting('notifications.telegram', { enabled: true, mode: 'all' });
    const group = f.daddy.create({ workspaceId: f.workspace.id });
    f.daddy.chat(group.id, 'Please reply.', 'cli-test');
    const run = f.store.daddyJobs(group.id).find((job) => job.trigger === 'user')!;
    const direct = f.store.finishDaddyReply(group.id, 'Direct answer', run.id);
    const background = f.store.finishDaddyReply(group.id, 'Background update', 'worker-run');
    const task = await f.daddy.createTask(group.id, {
      requirements: 'Task for old ping',
      requestId: 'old-ping',
    });
    const call = vi.fn(async (_method: string, _body: unknown) => ({ message_id: 51 }));
    let clock = 0;
    const connect = () =>
      new TelegramDelivery(
        f.store,
        { call: call as unknown as TelegramApi['call'] },
        'test_bot',
        () => clock,
      );
    let queue = connect();
    const recipient = { chatId: 7 };
    try {
      call.mockRejectedValueOnce(
        Object.assign(new Error('Flood wait'), { retryAfter: 10, telegramStatus: 429 }),
      );
      for (const reply of [background, direct])
        await queue.send(recipient, text(reply.text), {
          groupId: group.id,
          sessionRoute: true,
          key: dialogKey(reply.id),
        });
      const id = `telegram:question:7:${task.id}:closed-request`;
      await queue.send(recipient, text('Old ping'), { notificationId: id, key: id });
      await queue.stop();
      f.store.setSetting('notifications.telegram', { enabled: mode !== 'off', mode: 'attention' });
      queue = connect();
      clock += 10000;
      await queue.flush();
      expect(call.mock.calls.slice(1)).toEqual([
        [
          'sendMessage',
          expect.objectContaining({ chat_id: 7, text: 'Direct answer' }),
          expect.anything(),
        ],
      ]);
    } finally {
      await queue.stop();
      await f.close();
    }
  },
);
