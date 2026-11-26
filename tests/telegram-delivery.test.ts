import { daddyFixture } from './daddy-fixture.js';
import { disputedFindings } from '../src/core/task-activity.js';
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
it('drops a queued first mention from the old release when a dispute now belongs to daddy', async () => {
  const f = daddyFixture();
  const group = f.daddy.create({ workspaceId: f.workspace.id });
  const task = await f.daddy.createTask(group.id, {
    requirements: 'Restore replies',
    requestId: 'ordering',
  });
  f.store.setSetting('telegram.pairing', { chatId: 7, userId: 7 });
  let clock = Date.now();
  const call = vi.fn(async () => ({ message_id: 1 }));
  const open = () =>
    new TelegramDelivery(f.store, { call } as unknown as TelegramApi, 'test_bot', () => clock);
  let queue = open();
  try {
    const request = { runId: 'author-run', role: 'author', generation: task.generation } as const;
    f.store.saveTask({
      ...task,
      state: 'needs_input',
      reason: 'Which order?',
      inputRequest: request,
    });
    const key = `telegram:question:7:${task.id}:${request.runId}`;
    call.mockRejectedValueOnce(
      Object.assign(new Error('Slow down'), { telegramStatus: 429, retryAfter: 5 }),
    );
    await queue.send({ chatId: 7 }, new TelegramText().add('Owner, decide'), {
      key,
      groupId: group.id,
      notificationId: key,
    });
    expect(queue.status().pending).toBe(1);
    await queue.stop();
    f.store.saveTask({
      ...task,
      state: 'needs_input',
      reason: disputedFindings,
      inputRequest: request,
    });
    queue = open();
    clock += 6000;
    await queue.flush();
    expect(call).toHaveBeenCalledTimes(1);
    expect(queue.status().pending).toBe(0);
  } finally {
    await queue.stop();
    await f.close();
  }
});

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
