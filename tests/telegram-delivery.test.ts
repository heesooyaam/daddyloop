import { it, expect, vi } from 'vitest';
import { Store } from '../src/core/store.js';
import { TelegramDelivery } from '../src/integrations/telegram-delivery.js';
import { TelegramText } from '../src/integrations/telegram-text.js';
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
const text = (value: string) => new TelegramText().add(value);

it('keeps status edits delivering while a durable pin retries', async () => {
  const f = fixture();
  const target = { chatId: -10042, threadId: 4 };
  const options = { key: 'status', replace: true, pin: true };
  let restored: TelegramDelivery | undefined;
  try {
    await f.queue.send(target, text('Waiting'), options);
    f.call.mockRejectedValueOnce(new Error('Bad Request: not enough rights'));
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
    f.advance(60 * 60 * 1000);
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

it('migrates a queued legacy turn delivery with its acknowledged chunks', async () => {
  const f = fixture();
  let restored: TelegramDelivery | undefined;
  try {
    const destination = { chatId: -10042, threadId: 4 };
    const content = 'A'.repeat(4096) + 'B'.repeat(4096) + 'C'.repeat(808);
    const notificationId = 'telegram:dialog:-10042:4:message-id:progress';
    const finalNotificationId = 'telegram:dialog:-10042:4:message-id:final';
    f.call.mockResolvedValueOnce({ message_id: 41 }).mockRejectedValueOnce(new Error('offline'));
    await f.queue.send(destination, text(content), {
      key: 'turn:legacy-run',
      replace: true,
      final: false,
      notificationId,
    });
    expect(f.call).toHaveBeenCalledTimes(2);
    await f.queue.stop();
    restored = new TelegramDelivery(f.store, f.transport, 'test_bot', f.clock);
    f.advance(1000);
    await restored.send(destination, text(content), {
      key: 'message:message-id',
      replace: true,
      final: true,
      notificationId: finalNotificationId,
    });
    await restored.flush();
    expect(f.call).toHaveBeenCalledTimes(4);
    expect(f.call.mock.calls[2][1].text).toBe(f.call.mock.calls[1][1].text);
    expect(f.call.mock.calls.slice(2).map(([, body]) => body.text)).not.toContain(
      f.call.mock.calls[0][1].text,
    );
    const deliveries = f.store.db
      .prepare("SELECT value FROM settings WHERE key LIKE 'telegram.delivery:%'")
      .all()
      .map((row) => JSON.parse(String(row.value)))
      .filter((value) => value.options.notificationId?.includes('message-id'));
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].messages).toHaveLength(3);
    expect(deliveries[0].status).toBe('sent');
    expect(deliveries[0].options.key).toBe('message:message-id');
    expect(deliveries[0].options.notificationId).toBe(finalNotificationId);
  } finally {
    await restored?.stop();
    await f.close();
  }
});

it('redirects an in-flight legacy attempt to the migrated delivery', async () => {
  const f = fixture();
  let active: TelegramDelivery | undefined;
  let restored: TelegramDelivery | undefined;
  let finishSend = () => {};
  try {
    const destination = { chatId: -10042, threadId: 4 };
    const notificationId = 'telegram:dialog:-10042:4:message-id:final';
    const oldOptions = {
      key: 'turn:legacy-run',
      replace: true,
      final: true,
      notificationId,
    };
    await f.queue.stop();
    await f.queue.send(destination, text('Saved answer'), oldOptions);
    const send = new Promise<void>((resolve) => {
      finishSend = resolve;
    });
    f.call.mockImplementation(async (method: string) => {
      if (method === 'sendMessage') await send;
      return { message_id: 73 };
    });
    active = new TelegramDelivery(f.store, f.transport, 'test_bot', f.clock);
    const flushing = active.flush(1);
    await vi.waitFor(() => expect(f.call).toHaveBeenCalledTimes(1));
    await active.send(destination, text('Saved answer'), {
      ...oldOptions,
      key: 'message:message-id',
    });
    finishSend();
    await flushing;
    const deliveries = f.store.db
      .prepare("SELECT value FROM settings WHERE key LIKE 'telegram.delivery:%'")
      .all()
      .map((row) => JSON.parse(String(row.value)))
      .filter((value) => value.options.notificationId === notificationId);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({
      status: 'sent',
      options: { key: 'message:message-id' },
      messages: [{ id: 73 }],
    });
    await active.stop();
    restored = new TelegramDelivery(f.store, f.transport, 'test_bot', f.clock);
    await restored.flush();
    expect(f.call).toHaveBeenCalledTimes(1);
  } finally {
    finishSend();
    await active?.stop();
    await restored?.stop();
    await f.close();
  }
});

it.each([
  ['answered elsewhere', true, false],
  ['notifications enabled', false, true],
  ['notifications disabled', true, false],
])(
  'reuses one pending question when %s changes its owner mention',
  async (_name, before, after) => {
    const f = fixture();
    let restored: TelegramDelivery | undefined;
    try {
      const destination = { chatId: -10042, threadId: 4 };
      const notificationId = 'telegram:dialog:-10042:4:question-id:final';
      const content = (mention: boolean) => text((mention ? '@Owner · ' : '') + 'Choose a branch?');
      const options = (mention: boolean) => ({
        key: mention ? notificationId : 'message:question-id',
        replace: !mention,
        replacePending: true,
        final: true,
        notificationId,
      });
      await f.queue.stop();
      await f.queue.send(destination, content(before), options(before));
      restored = new TelegramDelivery(f.store, f.transport, 'test_bot', f.clock);
      await restored.send(destination, content(after), options(after));
      await restored.flush();
      expect(f.call.mock.calls.map(([method, body]) => [method, body.text])).toEqual([
        ['sendMessage', (after ? '@Owner · ' : '') + 'Choose a branch?'],
      ]);
      const saved = f.store.db
        .prepare("SELECT value FROM settings WHERE key LIKE 'telegram.delivery:%'")
        .all()
        .map((row) => JSON.parse(String(row.value)))
        .filter((value) => value.options.notificationId === notificationId);
      expect(saved).toHaveLength(1);
    } finally {
      await restored?.stop();
      await f.close();
    }
  },
);

it('keeps one canonical delivery across repeated owner-mention changes', async () => {
  const f = fixture();
  let restored: TelegramDelivery | undefined;
  try {
    const destination = { chatId: -10042, threadId: 4 };
    const notificationId = 'telegram:dialog:-10042:4:question-id:final';
    const options = (mention: boolean) => ({
      key: mention ? notificationId : 'message:question-id',
      replace: !mention,
      replacePending: true,
      final: true,
      notificationId,
    });
    await f.queue.stop();
    await f.queue.send(destination, text('@Owner · Choose?'), options(true));
    restored = new TelegramDelivery(f.store, f.transport, 'test_bot', f.clock);
    await restored.stop();
    await restored.send(destination, text('Choose?'), options(false));
    await restored.send(destination, text('@Owner · Choose?'), options(true));
    restored = new TelegramDelivery(f.store, f.transport, 'test_bot', f.clock);
    await restored.flush();
    expect(f.call.mock.calls.map(([method, body]) => [method, body.text])).toEqual([
      ['sendMessage', '@Owner · Choose?'],
    ]);
    const saved = f.store.db
      .prepare("SELECT value FROM settings WHERE key LIKE 'telegram.delivery:%'")
      .all()
      .map((row) => JSON.parse(String(row.value)))
      .filter((value) => value.options.notificationId === notificationId);
    expect(saved).toHaveLength(1);
  } finally {
    await restored?.stop();
    await f.close();
  }
});

it.each([
  ['different text', 'Second reply'],
  ['the same text', 'First reply'],
])('does not reuse a previous reply message ID for %s', async (_case, secondReply) => {
  const f = fixture();
  let restored: TelegramDelivery | undefined;
  try {
    const destination = { chatId: -10042, threadId: 4 };
    const first = f.store.daddyMessage('group', 'agent', 'First reply', 'legacy-run', undefined, {
      phase: 'progress',
    });
    const second = f.store.daddyMessage('group', 'agent', secondReply, 'legacy-run', undefined, {
      phase: 'final',
    });
    const firstNotification = `telegram:dialog:-10042:4:${first.id}:progress`;
    const secondNotification = `telegram:dialog:-10042:4:${second.id}:final`;
    f.store.db
      .prepare('INSERT INTO notifications VALUES(?,?,?)')
      .run(firstNotification, 'pending', first.at);
    await f.queue.send(destination, text('First reply'), {
      key: 'turn:legacy-run',
      replace: true,
      final: false,
      notificationId: firstNotification,
    });
    await f.queue.stop();
    await f.queue.send(destination, text(secondReply), {
      key: 'turn:legacy-run',
      replace: true,
      final: true,
      notificationId: secondNotification,
    });
    restored = new TelegramDelivery(f.store, f.transport, 'test_bot', f.clock);
    await restored.flush();
    expect(f.call).toHaveBeenCalledTimes(1);
    await restored.send(destination, text(secondReply), {
      key: `message:${second.id}`,
      replace: true,
      final: true,
      notificationId: secondNotification,
    });
    await restored.flush();
    expect(f.call.mock.calls.map(([method, body]) => [method, body.text, body.message_id])).toEqual(
      [
        ['sendMessage', 'First reply', undefined],
        ['sendMessage', secondReply, undefined],
      ],
    );
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

it('keeps buffered conversation order after a restart with an unchanged clock', async () => {
  const f = fixture();
  let restored: TelegramDelivery | undefined;
  try {
    f.call
      .mockRejectedValueOnce(new Error('offline'))
      .mockRejectedValueOnce(new Error('still offline'));
    await f.queue.send({ chatId: 7 }, text('First message'), { key: 'first' });
    await f.queue.send({ chatId: 7 }, text('Second message'), { key: 'second' });
    await f.queue.stop();
    restored = new TelegramDelivery(f.store, f.transport, 'test_bot', f.clock);
    f.advance(1999);
    await restored.flush();
    expect(f.call).toHaveBeenCalledTimes(2);
    f.advance(1);
    await restored.flush();
    expect(f.call.mock.calls.map(([, body]) => body.text)).toEqual([
      'First message',
      'First message',
      'First message',
      'Second message',
    ]);
    expect(restored.status().pending).toBe(0);
  } finally {
    await restored?.stop();
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

it('updates one replaceable card and never replaces final content with replayed progress', async () => {
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

it('pins an existing replaceable status card once and keeps editing that message', async () => {
  const f = fixture();
  try {
    const destination = { chatId: -10042, threadId: 4 };
    await f.queue.send(destination, text('Preparing'), {
      key: 'status',
      replace: true,
      final: true,
    });
    await f.queue.send(destination, text('Preparing'), {
      key: 'status',
      replace: true,
      pin: true,
      final: true,
    });
    await f.queue.send(destination, text('Working'), {
      key: 'status',
      replace: true,
      pin: true,
      final: true,
    });
    await f.queue.flush();
    expect(f.call.mock.calls.map(([method]) => method)).toEqual([
      'sendMessage',
      'editMessageText',
      'pinChatMessage',
    ]);
    expect(f.call.mock.calls[2][1]).toEqual({
      chat_id: -10042,
      message_id: 1,
      disable_notification: true,
    });
    expect(f.call.mock.calls[1][1]).toMatchObject({ message_id: 1, text: 'Working' });
    expect(f.call.mock.calls.some(([method]) => method.startsWith('unpin'))).toBe(false);
  } finally {
    await f.close();
  }
});

it('keeps a status update queued while the initial pin request is in flight', async () => {
  const f = fixture();
  try {
    let finishPin!: () => void;
    const pin = new Promise<void>((resolve) => {
      finishPin = resolve;
    });
    f.call.mockImplementation(async (method: string) => {
      if (method === 'pinChatMessage') await pin;
      return { message_id: 23 };
    });
    const destination = { chatId: -10042, threadId: 4 };
    const options = { key: 'status', replace: true, pin: true, final: true };
    await f.queue.send(destination, text('Preparing'), options);
    const pinning = f.queue.flush(1);
    await vi.waitFor(() =>
      expect(f.call.mock.calls.some(([method]) => method === 'pinChatMessage')).toBe(true),
    );
    await expect(f.queue.send(destination, text('Working'), options)).resolves.toMatchObject({
      status: 'queued',
    });
    finishPin();
    await pinning;
    await f.queue.flush();
    expect(f.call.mock.calls.map(([method]) => method)).toEqual([
      'sendMessage',
      'pinChatMessage',
      'editMessageText',
    ]);
    expect(f.call.mock.calls.at(-1)?.[1]).toMatchObject({ message_id: 23, text: 'Working' });
    expect(f.queue.status().pending).toBe(0);
  } finally {
    await f.close();
  }
});

it('retries a denied idle status pin without another send or edit', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const f = fixture();
  try {
    let canPin = false;
    f.call.mockImplementation(async (method: string) => {
      if (method === 'pinChatMessage' && !canPin)
        throw new Error('Bad Request: not enough rights to pin a message');
      return { message_id: 17 };
    });
    const options = { key: 'status', replace: true, pin: true, final: true };
    await expect(
      f.queue.send({ chatId: -10042, threadId: 4 }, text('Working'), options),
    ).resolves.toMatchObject({ status: 'sent' });
    await f.queue.flush();
    expect(f.queue.status().pending).toBe(1);
    expect(f.store.setting<string>('telegram.error')).toContain(
      'Give the bot permission to pin messages',
    );
    f.queue.start();
    canPin = true;
    f.advance(60 * 60 * 1000 - 1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.call).toHaveBeenCalledTimes(2);
    f.advance(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.call.mock.calls.map(([method]) => method)).toEqual([
      'sendMessage',
      'pinChatMessage',
      'pinChatMessage',
    ]);
    expect(f.store.setting('telegram.error')).toBeNull();
  } finally {
    await f.close();
    vi.useRealTimers();
  }
});

it('applies pin retry_after to all delivery traffic without reporting a permissions error', async () => {
  const f = fixture();
  try {
    let pinAttempts = 0;
    f.call.mockImplementation(async (method: string) => {
      if (method === 'pinChatMessage' && pinAttempts++ === 0)
        throw Object.assign(new Error('Too many requests'), {
          code: 'telegram_error',
          retryAfter: 60,
        });
      return { message_id: f.call.mock.calls.length };
    });
    const destination = { chatId: -10042, threadId: 4 };
    await expect(
      f.queue.send(destination, text('Idle status'), {
        key: 'status',
        replace: true,
        pin: true,
        final: true,
      }),
    ).resolves.toMatchObject({ status: 'sent' });
    await f.queue.flush();
    expect(f.store.setting('telegram.deliveryLimit:test_bot')).toBe(f.clock() + 60000);
    expect(f.store.setting('telegram.error')).toBeUndefined();
    await f.queue.send(destination, text('Agent answer'), { key: 'answer' });
    expect(f.call.mock.calls.map(([method]) => method)).toEqual(['sendMessage', 'pinChatMessage']);
    f.advance(59999);
    await f.queue.flush();
    expect(f.call).toHaveBeenCalledTimes(2);
    f.advance(1);
    await f.queue.flush();
    expect(f.call.mock.calls.map(([method]) => method)).toEqual([
      'sendMessage',
      'pinChatMessage',
      'sendMessage',
      'pinChatMessage',
    ]);
  } finally {
    await f.close();
  }
});

it('retries a transient pin failure without reporting a permissions error', async () => {
  const f = fixture();
  try {
    let pinAttempts = 0;
    f.call.mockImplementation(async (method: string) => {
      if (method === 'pinChatMessage' && pinAttempts++ === 0)
        throw Object.assign(new Error('connection reset'), { code: 'telegram_unreachable' });
      return { message_id: 51 };
    });
    await expect(
      f.queue.send({ chatId: -10042, threadId: 4 }, text('Idle status'), {
        key: 'status',
        replace: true,
        pin: true,
        final: true,
      }),
    ).resolves.toMatchObject({ status: 'sent' });
    await f.queue.flush();
    expect(f.store.setting('telegram.error')).toBeUndefined();
    f.advance(999);
    await f.queue.flush();
    expect(f.call).toHaveBeenCalledTimes(2);
    f.advance(1);
    await f.queue.flush();
    expect(f.call.mock.calls.map(([method]) => method)).toEqual([
      'sendMessage',
      'pinChatMessage',
      'pinChatMessage',
    ]);
  } finally {
    await f.close();
  }
});

it('does not hold conversation messages behind a delayed status pin', async () => {
  const f = fixture();
  try {
    f.call.mockImplementation(async (method: string) => {
      if (method === 'pinChatMessage') throw new Error('not enough rights to pin a message');
      return { message_id: f.call.mock.calls.length };
    });
    const destination = { chatId: -10042, threadId: 4 };
    await f.queue.send(destination, text('Idle status'), {
      key: 'status',
      replace: true,
      pin: true,
      final: true,
    });
    await f.queue.flush();
    await f.queue.send(destination, text('Agent answer'), { key: 'answer' });
    expect(f.call.mock.calls.map(([method, body]) => [method, body.text])).toEqual([
      ['sendMessage', 'Idle status'],
      ['pinChatMessage', undefined],
      ['sendMessage', 'Agent answer'],
    ]);
    expect(f.queue.status().pending).toBe(1);
  } finally {
    await f.close();
  }
});

it('restores an idle status pin retry after restart', async () => {
  const f = fixture();
  let restored: TelegramDelivery | undefined;
  try {
    let canPin = false;
    f.call.mockImplementation(async (method: string) => {
      if (method === 'pinChatMessage' && !canPin)
        throw new Error('not enough rights to pin a message');
      return { message_id: 31 };
    });
    await f.queue.send({ chatId: -10042, threadId: 4 }, text('Idle status'), {
      key: 'status',
      replace: true,
      pin: true,
      final: true,
    });
    await f.queue.flush();
    await f.queue.stop();
    restored = new TelegramDelivery(f.store, f.transport, 'test_bot', f.clock);
    canPin = true;
    f.advance(60 * 60 * 1000);
    await restored.flush();
    expect(f.call.mock.calls.map(([method]) => method)).toEqual([
      'sendMessage',
      'pinChatMessage',
      'pinChatMessage',
    ]);
    expect(f.store.setting('telegram.error')).toBeNull();
    expect(restored.status().pending).toBe(0);
  } finally {
    await restored?.stop();
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
