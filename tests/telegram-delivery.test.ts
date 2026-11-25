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
  ['short private reply', { chatId: 7 }, 100],
  ['long topic reply', { chatId: -10042, threadId: 4 }, 5000],
])(
  'keeps an in-flight progress message separate from its owner question: %s',
  async (_case, destination, size) => {
    const f = fixture();
    let finishFirst = () => {};
    try {
      const body = 'A'.repeat(size);
      const message = f.store.daddyMessage('group', 'agent', body, 'run', undefined, {
        phase: 'progress',
      });
      const progressNotification = `telegram:dialog:${destination.chatId}:${
        'threadId' in destination ? destination.threadId : 0
      }:${message.id}:progress`;
      const first = new Promise<void>((resolve) => {
        finishFirst = resolve;
      });
      f.call.mockImplementationOnce(async () => {
        await first;
        return { message_id: 41 };
      });
      const progress = f.queue.send(destination, text(body), {
        groupId: 'group',
        key: `message:${message.id}`,
        replace: true,
        notificationId: progressNotification,
      });
      await vi.waitFor(() => expect(f.call).toHaveBeenCalledOnce());
      f.store.finishDaddyReply('group', body, 'run', true);
      const finalNotification = progressNotification.replace(/:progress$/, ':final');
      await f.queue.send(destination, text('@Owner · ' + body), {
        groupId: 'group',
        key: finalNotification,
        replacePending: true,
        final: true,
        notificationId: finalNotification,
      });
      finishFirst();
      await progress;
      await new Promise((resolve) => setImmediate(resolve));
      await f.queue.flush(10);
      expect(f.call.mock.calls.every(([method]) => method === 'sendMessage')).toBe(true);
      expect(
        f.call.mock.calls.filter(([, request]) => request.text?.includes('@Owner')),
      ).toHaveLength(1);
      expect(f.call.mock.calls[0][1].text).not.toContain('@Owner');
    } finally {
      finishFirst();
      await f.close();
    }
  },
);

it.each([
  ['short private reply after owner rename', { chatId: 7 }, 100, false],
  [
    'long topic reply restored without source metadata',
    { chatId: -10042, threadId: 4 },
    5000,
    true,
  ],
])(
  'reuses an in-flight progress receipt after its owner question closes: %s',
  async (_case, destination, size, restart) => {
    const f = fixture();
    let restored: TelegramDelivery | undefined;
    let finishFirst = () => {};
    try {
      const body = 'A'.repeat(size);
      const message = f.store.daddyMessage('group', 'agent', body, 'run', undefined, {
        phase: 'progress',
      });
      const progressNotification = `telegram:dialog:${destination.chatId}:${
        'threadId' in destination ? destination.threadId : 0
      }:${message.id}:progress`;
      const agentText = new TelegramText().add('👨‍💻 [daddy]', 'bold').add('\n\n').markdown(body);
      const first = new Promise<void>((resolve) => {
        finishFirst = resolve;
      });
      f.call.mockImplementationOnce(async () => {
        await first;
        return { message_id: 41 };
      });
      const progress = f.queue.send(destination, agentText, {
        groupId: 'group',
        key: `message:${message.id}`,
        replace: true,
        notificationId: progressNotification,
      });
      await vi.waitFor(() => expect(f.call).toHaveBeenCalledOnce());
      f.store.finishDaddyReply('group', body, 'run', true);
      const finalNotification = progressNotification.replace(/:progress$/, ':final');
      const sendQuestion = (owner: string) =>
        f.queue.send(destination, new TelegramText().add(`@${owner} · `).append(agentText), {
          groupId: 'group',
          key: finalNotification,
          replacePending: true,
          final: true,
          notificationId: finalNotification,
          mention: { groupId: 'group', messageId: message.id },
        });
      await sendQuestion('Owner');
      if (!restart) await sendQuestion('RenamedOwner');
      if (restart) {
        const stopping = f.queue.stop();
        finishFirst();
        await progress;
        await stopping;
        const row = f.store.db
          .prepare(
            `SELECT key,value FROM settings WHERE key LIKE 'telegram.delivery:%'
             AND json_extract(value,'$.options.notificationId')=?`,
          )
          .get(finalNotification)!;
        const saved = JSON.parse(String(row.value));
        saved.options.questionSourceKey = undefined;
        f.store.setSetting(String(row.key), saved);
        restored = new TelegramDelivery(f.store, f.transport, 'test_bot', f.clock);
        await restored.send(destination, new TelegramText().add('@Owner · ').append(agentText), {
          groupId: 'group',
          key: finalNotification,
          replacePending: true,
          final: true,
          notificationId: finalNotification,
          mention: { groupId: 'group', messageId: message.id },
        });
        await restored.finishRecovery();
      } else {
        finishFirst();
        await progress;
      }
      await new Promise((resolve) => setImmediate(resolve));
      await (restored ?? f.queue).flush(10);
      expect(f.call.mock.calls.every(([method]) => method === 'sendMessage')).toBe(true);
      expect(f.call.mock.calls.some(([, request]) => request.text?.includes('@'))).toBe(false);
      expect(f.call).toHaveBeenCalledTimes(size > 3800 ? 2 : 1);
    } finally {
      finishFirst();
      await restored?.stop();
      await f.close();
    }
  },
);

it.each([
  ['current message receipt', 'message', { chatId: 7 }, 100, false],
  ['legacy turn receipt', 'turn', { chatId: -10042, threadId: 4 }, 5000, false],
  ['closed before replay, current', 'message', { chatId: 7 }, 100, true],
  ['closed before replay, legacy', 'turn', { chatId: -10042, threadId: 4 }, 5000, true],
] as const)(
  'reuses a fully sent progress receipt after its owner question closes: %s',
  async (_case, sourceFormat, destination, size, closedBeforeReplay) => {
    const f = fixture();
    let restored: TelegramDelivery | undefined;
    try {
      const body = 'A'.repeat(size);
      const message = f.store.daddyMessage('group', 'agent', body, 'run', undefined, {
        phase: 'progress',
      });
      const progressNotification = `telegram:dialog:${destination.chatId}:${
        'threadId' in destination ? destination.threadId : 0
      }:${message.id}:progress`;
      const agentText = new TelegramText().add('👨‍💻 [daddy]', 'bold').add('\n\n').markdown(body);
      await f.queue.send(destination, agentText, {
        groupId: 'group',
        key: sourceFormat === 'turn' ? 'turn:run' : `message:${message.id}`,
        replace: true,
        notificationId: progressNotification,
      });
      const progressCalls = f.call.mock.calls.length;
      await f.queue.stop();
      f.store.finishDaddyReply('group', body, 'run', true);
      const finalNotification = progressNotification.replace(/:progress$/, ':final');
      await f.queue.send(destination, new TelegramText().add('@Owner · ').append(agentText), {
        groupId: 'group',
        key: finalNotification,
        replacePending: true,
        final: true,
        notificationId: finalNotification,
        mention: { groupId: 'group', messageId: message.id },
      });
      if (sourceFormat === 'turn') {
        const row = f.store.db
          .prepare(
            `SELECT key,value FROM settings WHERE key LIKE 'telegram.delivery:%'
             AND json_extract(value,'$.options.notificationId')=?`,
          )
          .get(finalNotification)!;
        const saved = JSON.parse(String(row.value));
        saved.options.questionSourceKey = undefined;
        saved.options.mention = undefined;
        saved.options.replacePending = undefined;
        saved.options.final = undefined;
        f.store.setSetting(String(row.key), saved);
      }
      restored = new TelegramDelivery(f.store, f.transport, 'test_bot', f.clock);
      if (closedBeforeReplay) {
        await restored.send(destination, agentText, {
          groupId: 'group',
          key: `message:${message.id}`,
          replace: true,
          replacePending: true,
          final: true,
          notificationId: finalNotification,
        });
      } else {
        await restored.send(destination, new TelegramText().add('@Owner · ').append(agentText), {
          groupId: 'group',
          key: finalNotification,
          replacePending: true,
          final: true,
          notificationId: finalNotification,
          mention: { groupId: 'group', messageId: message.id },
        });
      }
      await restored.finishRecovery();
      await restored.flush(10);
      expect(f.call).toHaveBeenCalledTimes(progressCalls);
      await restored.send(destination, new TelegramText().add('Menu'), { key: 'next-menu' });
      await restored.flush(10);
      expect(f.call.mock.calls.filter(([, request]) => request.text === 'Menu')).toHaveLength(1);

      expect(f.call.mock.calls.some(([, request]) => request.text?.includes('@Owner'))).toBe(false);
    } finally {
      await restored?.stop();
      await f.close();
    }
  },
);

it('keeps the confirmed prefix of a mixed legacy turn and sends only its missing tail', async () => {
  const f = fixture();
  let restored: TelegramDelivery | undefined;
  try {
    const destination = { chatId: 7 };
    const first = f.store.daddyMessage('group', 'agent', 'A'.repeat(5000), 'run', undefined, {
      phase: 'progress',
    });
    const firstNotification = `telegram:dialog:7:0:${first.id}:progress`;
    f.store.db
      .prepare('INSERT INTO notifications VALUES(?,?,?)')
      .run(firstNotification, 'pending', first.at);
    await f.queue.send(destination, text(first.text), {
      groupId: 'group',
      key: 'turn:run',
      replace: true,
      notificationId: firstNotification,
    });
    const finalText = 'B'.repeat(3800) + 'C'.repeat(1200);
    const final = f.store.finishDaddyReply('group', finalText, 'run', true);
    const finalNotification = `telegram:dialog:7:0:${final.id}:final`;
    f.call
      .mockResolvedValueOnce({ message_id: 1 })
      .mockRejectedValueOnce(
        Object.assign(new Error('Too many requests'), { retryAfter: 60, telegramStatus: 429 }),
      );
    await f.queue.send(destination, text(finalText), {
      groupId: 'group',
      key: 'turn:run',
      replace: true,
      final: true,
      notificationId: finalNotification,
    });
    const beforeRecovery = f.call.mock.calls.length;
    await f.queue.stop();
    const turn = f.store.db
      .prepare(
        `SELECT value FROM settings WHERE key LIKE 'telegram.delivery:%'
         AND json_extract(value,'$.options.key')='turn:run'`,
      )
      .get()!;
    const question = JSON.parse(String(turn.value));
    question.id = 'mixed-question';
    question.createdAt++;
    question.messages = [];
    question.content = text('@Owner · ' + finalText);
    question.options = {
      groupId: 'group',
      key: finalNotification,
      notificationId: finalNotification,
      mention: { groupId: 'group', messageId: final.id },
    };
    f.store.setSetting('telegram.delivery:mixed-question', question);
    restored = new TelegramDelivery(f.store, f.transport, 'test_bot', f.clock);
    await restored.send(destination, text(finalText), {
      groupId: 'group',
      key: `message:${final.id}`,
      replace: true,
      final: true,
      notificationId: finalNotification,
    });
    await restored.finishRecovery();
    f.advance(60000);
    await restored.flush(10);
    const recoveryCalls = f.call.mock.calls.slice(beforeRecovery);
    expect(recoveryCalls.map(([method]) => method)).toEqual(['sendMessage']);
    expect(recoveryCalls[0][1].text).toBe('C'.repeat(1200));
  } finally {
    await restored?.stop();
    await f.close();
  }
});

it('keeps a fully confirmed short turn that matches an older reply prefix', async () => {
  const f = fixture();
  let restored: TelegramDelivery | undefined;
  try {
    const destination = { chatId: 7 };
    const prefix = 'A'.repeat(3800);
    const first = f.store.daddyMessage('group', 'agent', prefix + 'TAIL', 'run', undefined, {
      phase: 'progress',
    });
    const firstNotification = `telegram:dialog:7:0:${first.id}:progress`;
    f.store.db
      .prepare('INSERT INTO notifications VALUES(?,?,?)')
      .run(firstNotification, 'pending', first.at);
    await f.queue.send(destination, text(first.text), {
      groupId: 'group',
      key: 'turn:run',
      replace: true,
      notificationId: firstNotification,
    });
    const final = f.store.finishDaddyReply('group', prefix, 'run', true);
    const finalNotification = `telegram:dialog:7:0:${final.id}:final`;
    await f.queue.send(destination, text(prefix), {
      groupId: 'group',
      key: 'turn:run',
      replace: true,
      final: true,
      notificationId: finalNotification,
    });
    const beforeRecovery = f.call.mock.calls.length;
    await f.queue.stop();
    const turn = f.store.db
      .prepare(
        `SELECT value FROM settings WHERE key LIKE 'telegram.delivery:%'
         AND json_extract(value,'$.options.key')='turn:run'`,
      )
      .get()!;
    const question = JSON.parse(String(turn.value));
    question.id = 'short-question';
    question.createdAt++;
    question.status = 'queued';
    question.messages = [];
    question.content = text('@Owner · ' + prefix);
    question.options = {
      groupId: 'group',
      key: finalNotification,
      notificationId: finalNotification,
      mention: { groupId: 'group', messageId: final.id },
    };
    f.store.setSetting('telegram.delivery:short-question', question);
    restored = new TelegramDelivery(f.store, f.transport, 'test_bot', f.clock);
    await restored.send(destination, text(prefix), {
      groupId: 'group',
      key: `message:${final.id}`,
      replace: true,
      final: true,
      notificationId: finalNotification,
    });
    await restored.finishRecovery();
    await restored.flush(10);
    expect(f.call).toHaveBeenCalledTimes(beforeRecovery);
  } finally {
    await restored?.stop();
    await f.close();
  }
});

it('finishes a visible owner question without cancelling its acknowledged part', async () => {
  const f = fixture();
  let restored: TelegramDelivery | undefined;
  try {
    const destination = { chatId: 7 };
    const body = 'A'.repeat(5000);
    const message = f.store.daddyMessage('group', 'agent', body, 'run', undefined, {
      phase: 'progress',
    });
    const progressNotification = `telegram:dialog:7:0:${message.id}:progress`;
    await f.queue.send(destination, text(body), {
      groupId: 'group',
      key: `message:${message.id}`,
      replace: true,
      notificationId: progressNotification,
    });
    f.store.finishDaddyReply('group', body, 'run', true);
    const finalNotification = progressNotification.replace(/:progress$/, ':final');
    f.call
      .mockResolvedValueOnce({ message_id: 50 })
      .mockRejectedValueOnce(
        Object.assign(new Error('Too many requests'), { retryAfter: 60, telegramStatus: 429 }),
      );
    await f.queue.send(destination, text('@Owner · ' + body), {
      groupId: 'group',
      key: finalNotification,
      replacePending: true,
      final: true,
      notificationId: finalNotification,
      mention: { groupId: 'group', messageId: message.id },
    });
    await f.queue.send(destination, text('Menu'), { key: 'menu' });
    const beforeRecovery = f.call.mock.calls.length;
    await f.queue.stop();
    restored = new TelegramDelivery(f.store, f.transport, 'test_bot', f.clock);
    await restored.send(destination, text(body), {
      groupId: 'group',
      key: `message:${message.id}`,
      replace: true,
      final: true,
      notificationId: finalNotification,
    });
    await restored.finishRecovery();
    f.advance(60000);
    await restored.flush(20);
    const recoveryCalls = f.call.mock.calls.slice(beforeRecovery);
    expect(recoveryCalls.map(([method]) => method)).toEqual([
      'editMessageText',
      'sendMessage',
      'sendMessage',
    ]);
    expect(recoveryCalls[0][1]).toMatchObject({ message_id: 50 });
    expect(recoveryCalls[0][1].text).not.toContain('@Owner');
    expect(recoveryCalls.at(-1)![1].text).toBe('Menu');
  } finally {
    await restored?.stop();
    await f.close();
  }
});

it.each([
  ['open question', false],
  ['closed question', true],
])(
  'releases duplicate legacy question deliveries and the following menu: %s',
  async (_case, closed) => {
    const f = fixture();
    let restored: TelegramDelivery | undefined;
    try {
      await f.queue.stop();
      const destination = { chatId: 7 };
      const message = f.store.daddyMessage('group', 'agent', 'Saved question', 'run', undefined, {
        phase: 'final',
        ...(closed ? { needsReply: true } : {}),
      });
      const notificationId = `telegram:dialog:7:0:${message.id}:final`;
      await f.queue.send(destination, text('Saved question'), {
        groupId: 'group',
        key: 'turn:run',
        replace: true,
        final: true,
        notificationId,
      });
      const legacy = f.store.db
        .prepare(
          `SELECT key,value FROM settings WHERE key LIKE 'telegram.delivery:%'
         AND json_extract(value,'$.options.key')='turn:run'`,
        )
        .get()!;
      const question = JSON.parse(String(legacy.value));
      if (closed) {
        const source = JSON.parse(String(legacy.value));
        source.options.mention = { groupId: 'group', messageId: message.id };
        f.store.setSetting(String(legacy.key), source);
      }
      question.id = 'separate-question';
      question.createdAt++;
      question.content = text('@Owner · Saved question');
      question.options = {
        groupId: 'group',
        key: notificationId,
        notificationId,
        ...(closed ? { mention: { groupId: 'group', messageId: message.id } } : {}),
        ...(closed ? {} : { final: true }),
      };
      f.store.setSetting('telegram.delivery:separate-question', question);
      await f.queue.send(destination, text('Menu'), { key: 'menu' });
      f.store.setSetting('telegram.deliveryLimit:test_bot', f.clock() + 60000);
      restored = new TelegramDelivery(f.store, f.transport, 'test_bot', f.clock);
      await restored.send(destination, question.content, question.options);
      await restored.finishRecovery();
      f.advance(60000);
      await restored.flush(20);
      expect(f.call.mock.calls.map(([, request]) => request.text)).toEqual([
        closed ? '👨‍💻 [daddy]\n\nSaved question' : '@Owner · Saved question',
        'Menu',
      ]);
    } finally {
      await restored?.stop();
      await f.close();
    }
  },
);

it('reuses a sent legacy progress receipt when the same message becomes final', async () => {
  const f = fixture();
  let restored: TelegramDelivery | undefined;
  try {
    const message = f.store.daddyMessage('group', 'agent', 'Same reply', 'legacy-run', undefined, {
      phase: 'progress',
    });
    const progressNotification = `telegram:dialog:7:0:${message.id}:progress`;
    f.store.db
      .prepare('INSERT INTO notifications VALUES(?,?,?)')
      .run(progressNotification, 'pending', message.at);
    await f.queue.send({ chatId: 7 }, text(message.text), {
      key: 'turn:legacy-run',
      replace: true,
      final: false,
      notificationId: progressNotification,
    });
    f.store.finishDaddyReply('group', message.text, 'legacy-run');
    await f.queue.stop();
    restored = new TelegramDelivery(f.store, f.transport, 'test_bot', f.clock);
    await restored.send({ chatId: 7 }, text(message.text), {
      groupId: 'group',
      key: `message:${message.id}`,
      replace: true,
      final: true,
      notificationId: `telegram:dialog:7:0:${message.id}:final`,
    });
    await restored.flush();
    expect(f.call.mock.calls.map(([method]) => method)).toEqual(['sendMessage']);
    expect(restored.replySession(7, 1, 7)).toBe('group');
  } finally {
    await restored?.stop();
    await f.close();
  }
});

it('sends one fresh owner mention after a progress message becomes a question', async () => {
  const f = fixture();
  try {
    const destination = { chatId: 7 };
    const notificationId = 'telegram:dialog:7:0:message-id:final';
    await f.queue.send(destination, text('Choose a branch?'), {
      groupId: 'group',
      key: 'message:message-id',
      replace: true,
      final: false,
      notificationId: 'telegram:dialog:7:0:message-id:progress',
    });
    const question = {
      groupId: 'group',
      key: notificationId,
      replace: false,
      replacePending: true,
      final: true,
      notificationId,
    };
    await f.queue.send(destination, text('@Owner · Choose a branch?'), question);
    await f.queue.send(destination, text('@Owner · Choose a branch?'), question);
    expect(f.call.mock.calls.map(([method, body]) => [method, body.text])).toEqual([
      ['sendMessage', 'Choose a branch?'],
      ['sendMessage', '@Owner · Choose a branch?'],
    ]);
  } finally {
    await f.close();
  }
});

it('does not edit acknowledged progress chunks into the first owner mention', async () => {
  const f = fixture();
  let restored: TelegramDelivery | undefined;
  let sending: TelegramDelivery | undefined;
  try {
    const destination = { chatId: 7 };
    const progress = 'A'.repeat(5000);
    f.call.mockResolvedValueOnce({ message_id: 41 }).mockRejectedValueOnce(new Error('offline'));
    await f.queue.send(destination, text(progress), {
      groupId: 'group',
      key: 'message:message-id',
      replace: true,
      final: false,
      notificationId: 'telegram:dialog:7:0:message-id:progress',
    });
    await f.queue.stop();
    restored = new TelegramDelivery(f.store, f.transport, 'test_bot', f.clock);
    await restored.stop();
    const notificationId = 'telegram:dialog:7:0:message-id:final';
    await restored.send(destination, text('@Owner · Choose a branch?'), {
      groupId: 'group',
      key: notificationId,
      replace: false,
      replacePending: true,
      final: true,
      notificationId,
    });
    sending = new TelegramDelivery(f.store, f.transport, 'test_bot', f.clock);
    f.advance(1000);
    await sending.flush(10);
    const mentions = f.call.mock.calls.filter(([, body]) => body.text?.includes('@Owner'));
    expect(mentions).toHaveLength(1);
    expect(mentions[0][0]).toBe('sendMessage');
  } finally {
    await sending?.stop();
    await restored?.stop();
    await f.close();
  }
});

it('looks up a sent phase receipt without scanning unrelated delivery texts', async () => {
  const f = fixture();
  try {
    for (let i = 0; i < 100; i++)
      await f.queue.send({ chatId: 7 }, text('x'.repeat(16000)), { key: `sent:${i}` });
    const message = f.store.daddyMessage('group', 'agent', 'New reply', 'new-run', undefined, {
      phase: 'final',
    });
    await f.queue.stop();
    const prepare = vi.spyOn(f.store.db, 'prepare');
    await f.queue.send({ chatId: 7 }, text(message.text), {
      key: `message:${message.id}`,
      replace: true,
      final: true,
      notificationId: `telegram:dialog:7:0:${message.id}:final`,
    });
    expect(prepare.mock.calls.length).toBeLessThan(10);
  } finally {
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

it('indexes legacy recovery with a constant number of SQLite queries', async () => {
  const f = fixture();
  let restored: TelegramDelivery | undefined;
  try {
    await f.queue.stop();
    for (let i = 0; i < 100; i++) {
      const runId = `legacy-${i}`;
      const message = f.store.daddyMessage('group', 'agent', `Answer ${i}`, runId, undefined, {
        phase: 'final',
      });
      await f.queue.send({ chatId: 7 }, text(message.text), {
        key: `turn:${runId}`,
        replace: true,
        final: true,
        notificationId: `telegram:dialog:7:0:${message.id}:final`,
      });
    }
    const prepare = vi.spyOn(f.store.db, 'prepare');
    restored = new TelegramDelivery(f.store, f.transport, 'test_bot', f.clock);
    expect(prepare.mock.calls.length).toBeLessThan(10);
  } finally {
    await restored?.stop();
    await f.close();
  }
});

it('recovers task questions by primary key without reading unrelated task JSON', async () => {
  const f = fixture();
  let restored: TelegramDelivery | undefined;
  try {
    await f.queue.stop();
    const insert = f.store.db.prepare('INSERT INTO tasks VALUES(?,?)');
    f.store.transaction(() => {
      for (let i = 0; i < 4096; i++)
        insert.run(
          `unrelated-${i}`,
          JSON.stringify({
            id: `unrelated-${i}`,
            groupId: 'elsewhere',
            state: 'complete',
            requirements: 'x'.repeat(128),
          }),
        );
      insert.run(
        'target-task',
        JSON.stringify({ id: 'target-task', groupId: 'group', state: 'needs_input' }),
      );
    });
    const notificationId = 'telegram:question:7:target-task:request';
    await f.queue.send({ chatId: 7 }, text('Old question'), {
      key: notificationId,
      notificationId,
    });
    await f.queue.send({ chatId: 7 }, text('Current question'), {
      groupId: 'group',
      key: 'telegram:question:7:ready-task:request',
      notificationId: 'telegram:question:7:ready-task:request',
      reminder: { groupId: 'group', taskId: 'ready-task', request: 'request' },
    });
    const prepare = vi.spyOn(f.store.db, 'prepare');
    restored = new TelegramDelivery(f.store, f.transport, 'test_bot', f.clock);
    const taskQueries = prepare.mock.calls
      .map(([sql]) => String(sql))
      .filter((sql) => /FROM tasks/i.test(sql));
    expect(taskQueries).toHaveLength(1);
    expect(taskQueries[0]).toMatch(/WHERE id=\?/i);
  } finally {
    await restored?.stop();
    await f.close();
  }
});

it('persists a ready retry_after backlog with one write per new reply', async () => {
  const f = fixture();
  let queue: TelegramDelivery | undefined;
  try {
    await f.queue.stop();
    f.store.setSetting('telegram.deliveryLimit:test_bot', f.clock() + 60000);
    queue = new TelegramDelivery(f.store, f.transport, 'test_bot', f.clock);
    const save = vi.spyOn(f.store, 'setSetting');
    for (let i = 0; i < 512; i++)
      await queue.send({ chatId: 7 }, text(`Reply ${i}`), {
        key: `message:${i}`,
        notificationId: `telegram:dialog:7:0:message-${i}`,
      });
    expect(save).toHaveBeenCalledTimes(512);
    expect(f.call).not.toHaveBeenCalled();
    f.advance(60000);
    await queue.flush(10);
    expect(f.call.mock.calls.map(([, request]) => request.text)).toEqual(
      Array.from({ length: 10 }, (_, i) => `Reply ${i}`),
    );
  } finally {
    await queue?.stop();
    await f.close();
  }
});

it('does not retain sent reply sources when no question needs recovery', async () => {
  const f = fixture();
  let restored: TelegramDelivery | undefined;
  try {
    await f.queue.stop();
    const insert = f.store.db.prepare('INSERT INTO settings VALUES(?,?)');
    f.store.transaction(() => {
      for (let i = 0; i < 5000; i++)
        insert.run(
          `telegram.delivery:sent-${i}`,
          JSON.stringify({
            id: `sent-${i}`,
            bot: 'test_bot',
            ownerId: 7,
            destination: { chatId: 7 },
            content: text(`Reply ${i}`),
            options: {
              key: `message:${i}`,
              notificationId: `telegram:dialog:7:0:message-${i}`,
            },
            revision: 1,
            createdAt: i,
            status: 'sent',
            attempts: 0,
            nextAttemptAt: 0,
            messages: [{ id: i + 1, fingerprint: `fingerprint-${i}` }],
          }),
        );
    });
    restored = new TelegramDelivery(f.store, f.transport, 'test_bot', f.clock);
    expect((restored as any).storedQuestionSources.size).toBe(0);
  } finally {
    await restored?.stop();
    await f.close();
  }
});

it('keeps a deferred reply queued when its replay is temporarily skipped', async () => {
  const f = fixture();
  let restored: TelegramDelivery | undefined;
  try {
    await f.queue.stop();
    const message = f.store.daddyMessage('group', 'agent', 'Saved reply');
    const options = {
      groupId: 'group',
      key: `message:${message.id}`,
      replace: true,
      final: true,
      notificationId: `telegram:dialog:7:0:${message.id}`,
    };
    await f.queue.send({ chatId: 7 }, text(message.text), options);
    restored = new TelegramDelivery(f.store, f.transport, 'test_bot', f.clock);
    restored.retainDeferred({ chatId: 7 }, options.notificationId);
    await restored.finishRecovery();
    expect(f.call).not.toHaveBeenCalled();
    await restored.send({ chatId: 7 }, text(message.text), options);
    await restored.flush();
    expect(f.call.mock.calls.map(([method, body]) => [method, body.text])).toEqual([
      ['sendMessage', 'Saved reply'],
    ]);
  } finally {
    await restored?.stop();
    await f.close();
  }
});

it('preserves acknowledged final chunks despite an older delivered sibling', async () => {
  const f = fixture();
  let restored: TelegramDelivery | undefined;
  try {
    const destination = { chatId: -10042, threadId: 4 };
    const progress = f.store.daddyMessage('group', 'agent', 'Progress.', 'legacy-run', undefined, {
      phase: 'progress',
    });
    const content = 'A'.repeat(4096) + 'B'.repeat(4096) + 'C'.repeat(808);
    const final = f.store.daddyMessage('group', 'agent', content, 'legacy-run', undefined, {
      phase: 'final',
    });
    f.store.db
      .prepare('INSERT INTO notifications VALUES(?,?,?)')
      .run(`telegram:dialog:-10042:4:${progress.id}:progress`, 'sent', progress.at);
    f.call.mockResolvedValueOnce({ message_id: 41 }).mockRejectedValueOnce(new Error('offline'));
    await f.queue.send(destination, text(content), {
      key: 'turn:legacy-run',
      replace: true,
      final: true,
      notificationId: `telegram:dialog:-10042:4:${final.id}:final`,
    });
    await f.queue.stop();
    restored = new TelegramDelivery(f.store, f.transport, 'test_bot', f.clock);
    f.advance(1000);
    await restored.send(destination, text(content), {
      key: `message:${final.id}`,
      replace: true,
      final: true,
      notificationId: `telegram:dialog:-10042:4:${final.id}:final`,
    });
    await restored.flush();
    expect(f.call).toHaveBeenCalledTimes(4);
    expect(f.call.mock.calls.slice(2).map(([, body]) => body.text)).not.toContain(
      f.call.mock.calls[0][1].text,
    );
  } finally {
    await restored?.stop();
    await f.close();
  }
});

it('does not treat a failed legacy sibling edit as an acknowledged final chunk', async () => {
  const f = fixture();
  let restored: TelegramDelivery | undefined;
  try {
    const destination = { chatId: -10042, threadId: 4 };
    const prefix = 'A'.repeat(3800);
    const first = f.store.daddyMessage('group', 'agent', prefix, 'legacy-run', undefined, {
      phase: 'progress',
    });
    const middle = f.store.daddyMessage('group', 'agent', 'MID', 'legacy-run', undefined, {
      phase: 'progress',
    });
    const final = f.store.daddyMessage('group', 'agent', prefix + 'XYZ', 'legacy-run', undefined, {
      phase: 'final',
    });
    f.store.db
      .prepare('INSERT INTO daddy_jobs VALUES(?,?,?,?)')
      .run('legacy-run', 'group', 'completed', '{}');
    const notification = (id: string, phase: string) => `telegram:dialog:-10042:4:${id}:${phase}`;
    for (const [message, phase] of [
      [first, 'progress'],
      [middle, 'progress'],
      [final, 'final'],
    ] as const)
      f.store.db
        .prepare('INSERT INTO notifications VALUES(?,?,?)')
        .run(notification(message.id, phase), 'pending', message.at);
    await f.queue.send(destination, text(first.text), {
      key: 'turn:legacy-run',
      replace: true,
      notificationId: notification(first.id, 'progress'),
    });
    f.call.mockRejectedValueOnce(new Error('offline'));
    await f.queue.send(destination, text(middle.text), {
      key: 'turn:legacy-run',
      replace: true,
      notificationId: notification(middle.id, 'progress'),
    });
    await f.queue.stop();
    await f.queue.send(destination, text(final.text), {
      key: 'turn:legacy-run',
      replace: true,
      final: true,
      notificationId: notification(final.id, 'final'),
    });
    restored = new TelegramDelivery(f.store, f.transport, 'test_bot', f.clock);
    await restored.send(destination, text(middle.text), {
      groupId: 'group',
      key: `message:${middle.id}`,
      replace: true,
      notificationId: notification(middle.id, 'progress'),
    });
    await restored.send(destination, text(final.text), {
      groupId: 'group',
      key: `message:${final.id}`,
      replace: true,
      final: true,
      notificationId: notification(final.id, 'final'),
    });
    await restored.finishRecovery();
    expect(f.call.mock.calls.map(([method, body]) => [method, body.text])).toEqual([
      ['sendMessage', prefix],
      ['editMessageText', 'MID'],
      ['sendMessage', 'MID'],
      ['sendMessage', prefix],
      ['sendMessage', 'XYZ'],
    ]);
  } finally {
    await restored?.stop();
    await f.close();
  }
});

it('keeps a legacy final chunk acknowledged after editing the latest sibling', async () => {
  const f = fixture();
  let restored: TelegramDelivery | undefined;
  try {
    const destination = { chatId: -10042, threadId: 4 };
    const prefix = 'A'.repeat(3800);
    const first = f.store.daddyMessage('group', 'agent', prefix, 'legacy-run', undefined, {
      phase: 'progress',
    });
    const middle = f.store.daddyMessage('group', 'agent', 'MID', 'legacy-run', undefined, {
      phase: 'progress',
    });
    const final = f.store.daddyMessage('group', 'agent', prefix + 'XYZ', 'legacy-run', undefined, {
      phase: 'final',
    });
    const notification = (id: string, phase: string) => `telegram:dialog:-10042:4:${id}:${phase}`;
    for (const [message, phase] of [
      [first, 'progress'],
      [middle, 'progress'],
      [final, 'final'],
    ] as const)
      f.store.db
        .prepare('INSERT INTO notifications VALUES(?,?,?)')
        .run(notification(message.id, phase), 'pending', message.at);
    await f.queue.send(destination, text(first.text), {
      key: 'turn:legacy-run',
      replace: true,
      notificationId: notification(first.id, 'progress'),
    });
    await f.queue.send(destination, text(middle.text), {
      key: 'turn:legacy-run',
      replace: true,
      notificationId: notification(middle.id, 'progress'),
    });
    f.call.mockResolvedValueOnce({ message_id: 41 }).mockRejectedValueOnce(new Error('offline'));
    await f.queue.send(destination, text(final.text), {
      key: 'turn:legacy-run',
      replace: true,
      final: true,
      notificationId: notification(final.id, 'final'),
    });
    await f.queue.stop();
    restored = new TelegramDelivery(f.store, f.transport, 'test_bot', f.clock);
    f.advance(1000);
    await restored.send(destination, text(final.text), {
      groupId: 'group',
      key: `message:${final.id}`,
      replace: true,
      final: true,
      notificationId: notification(final.id, 'final'),
    });
    await restored.finishRecovery();
    expect(f.call.mock.calls.map(([method, body]) => [method, body.text])).toEqual([
      ['sendMessage', prefix],
      ['editMessageText', 'MID'],
      ['editMessageText', prefix],
      ['sendMessage', 'XYZ'],
      ['sendMessage', 'XYZ'],
    ]);
  } finally {
    await restored?.stop();
    await f.close();
  }
});

it('restores one private-chat queue by saved order across sessions', async () => {
  const f = fixture();
  let restored: TelegramDelivery | undefined;
  try {
    await f.queue.stop();
    const a1 = f.store.daddyMessage('group-a', 'agent', 'A1');
    const b1 = f.store.daddyMessage('group-b', 'agent', 'B1');
    const a2 = f.store.daddyMessage('group-a', 'agent', 'A2');
    const enqueue = (message: typeof a1, groupId: string, order: string) =>
      f.queue.send({ chatId: 7 }, text(message.text), {
        groupId,
        key: `message:${message.id}`,
        replace: true,
        order,
        final: true,
        notificationId: `telegram:dialog:7:0:${message.id}`,
      });
    const sameTime = '2026-01-01T00:00:01.000Z';
    await enqueue(a1, 'group-a', sameTime);
    await enqueue(b1, 'group-b', sameTime);
    await enqueue(a2, 'group-a', sameTime);
    restored = new TelegramDelivery(f.store, f.transport, 'test_bot', f.clock);
    await restored.send({ chatId: 7 }, text(a1.text), {
      groupId: 'group-a',
      key: `message:${a1.id}`,
      replace: true,
      order: sameTime,
      final: true,
      notificationId: `telegram:dialog:7:0:${a1.id}`,
    });
    await restored.send({ chatId: 7 }, text(a2.text), {
      groupId: 'group-a',
      key: `message:${a2.id}`,
      replace: true,
      order: sameTime,
      final: true,
      notificationId: `telegram:dialog:7:0:${a2.id}`,
    });
    await restored.send({ chatId: 7 }, text(b1.text), {
      groupId: 'group-b',
      key: `message:${b1.id}`,
      replace: true,
      order: sameTime,
      final: true,
      notificationId: `telegram:dialog:7:0:${b1.id}`,
    });
    await restored.finishRecovery();
    expect(f.call.mock.calls.map(([, body]) => body.text)).toEqual(['A1', 'B1', 'A2']);
  } finally {
    await restored?.stop();
    await f.close();
  }
});

it('keeps an older dialog reply ahead of a queued resource notice', async () => {
  const f = fixture();
  let restored: TelegramDelivery | undefined;
  try {
    await f.queue.stop();
    const reply = f.store.daddyMessage('group', 'agent', 'Agent reply');
    const destination = { chatId: -10042, threadId: 4 };
    await f.queue.send(destination, text(reply.text), {
      groupId: 'group',
      key: `message:${reply.id}`,
      replace: true,
      order: '2026-01-01T00:00:01.000Z',
      final: true,
      notificationId: `telegram:dialog:-10042:4:${reply.id}`,
    });
    await f.queue.send(destination, text('Resources restored'), {
      key: 'resources:group',
      replace: true,
      order: '2026-01-01T00:00:02.000Z',
    });
    restored = new TelegramDelivery(f.store, f.transport, 'test_bot', f.clock);
    await restored.send(destination, text(reply.text), {
      groupId: 'group',
      key: `message:${reply.id}`,
      replace: true,
      order: '2026-01-01T00:00:01.000Z',
      final: true,
      notificationId: `telegram:dialog:-10042:4:${reply.id}`,
    });
    await restored.finishRecovery();
    expect(f.call.mock.calls.map(([, body]) => body.text)).toEqual([
      'Agent reply',
      'Resources restored',
    ]);
  } finally {
    await restored?.stop();
    await f.close();
  }
});

it('releases private navigation after a saved reply moves to a topic', async () => {
  const f = fixture();
  let restored: TelegramDelivery | undefined;
  try {
    await f.queue.stop();
    const reply = f.store.daddyMessage('group', 'agent', 'A1');
    const privateDestination = { chatId: 7 };
    const privateNotification = `telegram:dialog:7:0:${reply.id}`;
    await f.queue.send(privateDestination, text(reply.text), {
      groupId: 'group',
      key: `message:${reply.id}`,
      replace: true,
      notificationId: privateNotification,
    });
    await f.queue.send(privateDestination, text('First menu'), { key: 'menu:first' });
    restored = new TelegramDelivery(f.store, f.transport, 'test_bot', f.clock);
    const topic = { chatId: -10042, threadId: 4 };
    restored.reconcileGroupRoute('group', topic);
    await restored.send(privateDestination, text('Second menu'), { key: 'menu:second' });
    await restored.send(topic, text(reply.text), {
      groupId: 'group',
      key: `message:${reply.id}`,
      replace: true,
      notificationId: `telegram:dialog:-10042:4:${reply.id}`,
    });
    await restored.finishRecovery();
    await restored.flush(10);
    expect(
      f.call.mock.calls.map(([method, body]) => [method, body.text, body.message_thread_id]),
    ).toEqual([
      ['sendMessage', 'First menu', undefined],
      ['sendMessage', 'Second menu', undefined],
      ['sendMessage', 'A1', 4],
    ]);
  } finally {
    await restored?.stop();
    await f.close();
  }
});

it('reactivates an undelivered reply when its previous route becomes current again', async () => {
  const f = fixture();
  let restored: TelegramDelivery | undefined;
  let restarted: TelegramDelivery | undefined;
  try {
    await f.queue.stop();
    const reply = f.store.daddyMessage('group', 'agent', 'A1');
    const privateDestination = { chatId: 7 };
    const privateNotification = `telegram:dialog:7:0:${reply.id}`;
    await f.queue.send(privateDestination, text(reply.text), {
      groupId: 'group',
      key: `message:${reply.id}`,
      replace: true,
      notificationId: privateNotification,
    });
    f.store.setSetting('telegram.deliveryLimit:test_bot', f.clock() + 60000);
    restored = new TelegramDelivery(f.store, f.transport, 'test_bot', f.clock);
    const topic = { chatId: -10042, threadId: 4 };
    restored.reconcileGroupRoute('group', topic);
    const cancelled = f.store.db
      .prepare(
        "SELECT key,value FROM settings WHERE key LIKE 'telegram.delivery:%' AND json_extract(value,'$.options.notificationId')=?",
      )
      .get(privateNotification)!;
    const legacyCancelled = JSON.parse(String(cancelled.value));
    delete legacyCancelled.cancelledForRoute;
    f.store.setSetting(String(cancelled.key), legacyCancelled);
    await restored.send(topic, text(reply.text), {
      groupId: 'group',
      key: `message:${reply.id}`,
      replace: true,
      notificationId: `telegram:dialog:-10042:4:${reply.id}`,
    });
    restored.reconcileGroupRoute('group', privateDestination);
    await restored.send(privateDestination, text(reply.text), {
      groupId: 'group',
      key: `message:${reply.id}`,
      replace: true,
      notificationId: privateNotification,
    });
    await restored.finishRecovery();
    f.advance(60000);
    await restored.flush(10);
    expect(f.call.mock.calls.map(([method, body]) => [method, body.text, body.chat_id])).toEqual([
      ['sendMessage', 'A1', 7],
    ]);
    await restored.stop();
    restarted = new TelegramDelivery(f.store, f.transport, 'test_bot', f.clock);
    await restarted.flush(10);
    expect(f.call).toHaveBeenCalledOnce();
  } finally {
    await restarted?.stop();
    await restored?.stop();
    await f.close();
  }
});

it.each([
  ['private chat', { chatId: 7 }],
  ['topic', { chatId: -10042, threadId: 4 }],
])(
  'reconciles a sent notification with its %s delivery after restart',
  async (_route, destination) => {
    const f = fixture();
    let restored: TelegramDelivery | undefined;
    let restarted: TelegramDelivery | undefined;
    try {
      const reply = f.store.daddyMessage('group', 'agent', 'A1');
      const notificationId = `telegram:dialog:${destination.chatId}:${
        'threadId' in destination ? destination.threadId : 0
      }:${reply.id}`;
      f.store.db
        .prepare('INSERT INTO notifications VALUES(?,?,?)')
        .run(notificationId, 'pending', reply.at);
      await f.queue.send(destination, text(reply.text), {
        groupId: 'group',
        key: `message:${reply.id}`,
        replace: true,
        notificationId,
      });
      await f.queue.stop();
      const row = f.store.db
        .prepare(
          "SELECT key,value FROM settings WHERE key LIKE 'telegram.delivery:%' AND json_extract(value,'$.options.notificationId')=?",
        )
        .get(notificationId)!;
      const interrupted = JSON.parse(String(row.value));
      interrupted.status = 'sending';
      f.store.setSetting(String(row.key), interrupted);
      await f.queue.send(destination, text('Menu'), { key: `menu:${destination.chatId}` });
      restored = new TelegramDelivery(f.store, f.transport, 'test_bot', f.clock);
      await restored.finishRecovery();
      expect(f.call.mock.calls.map(([method, body]) => [method, body.text])).toEqual([
        ['sendMessage', 'A1'],
        ['sendMessage', 'Menu'],
      ]);
      await restored.stop();
      restarted = new TelegramDelivery(f.store, f.transport, 'test_bot', f.clock);
      await restarted.flush(10);
      expect(f.call).toHaveBeenCalledTimes(2);
    } finally {
      await restarted?.stop();
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
  ['private chat', 'owner answered elsewhere', { chatId: 7 }, false],
  ['private chat', 'notifications were disabled', { chatId: 7 }, true],
  ['topic', 'owner answered elsewhere', { chatId: -10042, threadId: 4 }, false],
  ['topic', 'notifications were disabled', { chatId: -10042, threadId: 4 }, true],
])(
  'finishes acknowledged progress in a %s after %s',
  async (_route, _change, destination, discardMention) => {
    const f = fixture();
    let restored: TelegramDelivery | undefined;
    let sending: TelegramDelivery | undefined;
    try {
      const message = f.store.daddyMessage('group', 'agent', 'A'.repeat(5000), 'run', undefined, {
        phase: 'progress',
      });
      const notification = (phase: string) =>
        `telegram:dialog:${destination.chatId}:${'threadId' in destination ? destination.threadId : 0}:${message.id}:${phase}`;
      const progressNotification = notification('progress');
      f.call.mockResolvedValueOnce({ message_id: 41 }).mockRejectedValueOnce(new Error('offline'));
      await f.queue.send(destination, text(message.text), {
        groupId: 'group',
        key: `message:${message.id}`,
        replace: true,
        notificationId: progressNotification,
      });
      f.store.finishDaddyReply('group', message.text, 'run', true);
      const finalNotification = notification('final');
      await f.queue.stop();
      restored = new TelegramDelivery(f.store, f.transport, 'test_bot', f.clock);
      await restored.stop();
      await restored.send(destination, text('@Owner · ' + message.text), {
        groupId: 'group',
        key: finalNotification,
        replacePending: true,
        final: true,
        notificationId: finalNotification,
      });
      sending = new TelegramDelivery(f.store, f.transport, 'test_bot', f.clock);
      if (discardMention) {
        expect(sending.hasAcknowledgedMessage(destination, finalNotification)).toBe(true);
        sending.discardDeferred(destination, finalNotification, false);
      }
      await sending.send(destination, text(message.text), {
        groupId: 'group',
        key: `message:${message.id}`,
        replace: true,
        replacePending: true,
        final: true,
        notificationId: finalNotification,
      });
      await sending.send(destination, text('Menu'), { key: 'menu' });
      f.advance(1000);
      await sending.finishRecovery();
      await sending.flush(10);
      expect(f.call.mock.calls.map(([method, body]) => [method, body.text])).toEqual([
        ['sendMessage', 'A'.repeat(3800)],
        ['sendMessage', 'A'.repeat(1200)],
        ['sendMessage', 'A'.repeat(1200)],
        ['sendMessage', 'Menu'],
      ]);
    } finally {
      await sending?.stop();
      await restored?.stop();
      await f.close();
    }
  },
);

it('does not revive a cancelled progress tail after its late failure', async () => {
  const f = fixture();
  let rejectTail = (_error: Error) => {};
  try {
    const destination = { chatId: -10042, threadId: 4 };
    const message = f.store.daddyMessage('group', 'agent', 'A'.repeat(5000), 'run', undefined, {
      phase: 'progress',
    });
    const progressNotification = `telegram:dialog:-10042:4:${message.id}:progress`;
    const tail = new Promise<never>((_resolve, reject) => {
      rejectTail = reject;
    });
    f.call.mockResolvedValueOnce({ message_id: 41 }).mockImplementationOnce(() => tail);
    const progress = f.queue.send(destination, text(message.text), {
      groupId: 'group',
      key: `message:${message.id}`,
      replace: true,
      notificationId: progressNotification,
    });
    await vi.waitFor(() => expect(f.call).toHaveBeenCalledTimes(2));
    f.store.finishDaddyReply('group', message.text, 'run', true);
    const finalNotification = `telegram:dialog:-10042:4:${message.id}:final`;
    await f.queue.send(destination, text('@Owner · ' + message.text), {
      groupId: 'group',
      key: finalNotification,
      replacePending: true,
      final: true,
      notificationId: finalNotification,
    });
    rejectTail(new Error('late failure'));
    await progress;
    await f.queue.flush(10);
    expect(f.call.mock.calls.map(([method, body]) => [method, body.text])).toEqual([
      ['sendMessage', 'A'.repeat(3800)],
      ['sendMessage', 'A'.repeat(1200)],
      ['sendMessage', '@Owner · ' + 'A'.repeat(3791)],
      ['sendMessage', 'A'.repeat(1209)],
    ]);
    f.advance(10000);
    await f.queue.flush(10);
    expect(f.call).toHaveBeenCalledTimes(4);
  } finally {
    rejectTail(new Error('cleanup'));
    await f.close();
  }
});

it('persists retry_after from an obsolete request before sending its replacement', async () => {
  const f = fixture();
  let restored: TelegramDelivery | undefined;
  let rejectProgress = (_error: Error) => {};
  try {
    const delayed = new Promise<never>((_resolve, reject) => {
      rejectProgress = reject;
    });
    f.call.mockImplementationOnce(() => delayed);
    const progress = f.queue.send({ chatId: 7 }, text('Progress'), {
      key: 'message:reply',
      replace: true,
    });
    await vi.waitFor(() => expect(f.call).toHaveBeenCalledOnce());
    await f.queue.send({ chatId: 7 }, text('Final'), {
      key: 'message:reply',
      replace: true,
      final: true,
    });
    await f.queue.send({ chatId: 7 }, text('Menu'), { key: 'menu' });
    rejectProgress(
      Object.assign(new Error('Too many requests'), { retryAfter: 60, telegramStatus: 429 }),
    );
    await progress;
    await new Promise((resolve) => setImmediate(resolve));
    expect(f.store.setting('telegram.deliveryLimit:test_bot')).toBe(f.clock() + 60000);
    expect(f.call).toHaveBeenCalledOnce();
    await f.queue.stop();
    restored = new TelegramDelivery(f.store, f.transport, 'test_bot', f.clock);
    f.advance(59999);
    await restored.flush(10);
    expect(f.call).toHaveBeenCalledOnce();
    f.advance(1);
    await restored.flush(10);
    expect(f.call.mock.calls.map(([method, body]) => [method, body.text])).toEqual([
      ['sendMessage', 'Progress'],
      ['sendMessage', 'Final'],
      ['sendMessage', 'Menu'],
    ]);
  } finally {
    rejectProgress(new Error('cleanup'));
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
      .prepare('INSERT INTO daddy_jobs VALUES(?,?,?,?)')
      .run('legacy-run', 'group-a', 'completed', '{}');
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
      groupId: 'group-a',
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
    expect(restored.replySession(-10042, 1, 7)).toBe('group-a');
    expect(restored.replySession(-10042, 2, 7)).toBe('group-a');
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

it.each([
  ['before the first pin and restart with changed text', false, false],
  ['before the first pin and restart with identical text', false, true],
  ['after the first pin', true, false],
])('keeps one pin when the topic is disconnected %s', async (_case, pinBeforeSwitch, identical) => {
  const f = fixture();
  let restored: TelegramDelivery | undefined;
  try {
    const destination = { chatId: -10042, threadId: 4 };
    const options = { key: 'status', replace: true, pin: true, final: true };
    await f.queue.send(destination, text('Preparing'), options);
    if (pinBeforeSwitch) await f.queue.flush(10);
    f.store.setSetting('telegram.group', null);
    await f.queue.flush(10);
    let delivery = f.queue;
    if (!pinBeforeSwitch) {
      await f.queue.stop();
      restored = new TelegramDelivery(f.store, f.transport, 'test_bot', f.clock);
      delivery = restored;
    }
    f.store.setSetting('telegram.group', { chatId: -10042, ownerId: 7 });
    await delivery.send(destination, text(identical ? 'Preparing' : 'Working'), options);
    await delivery.flush(10);
    expect(f.call.mock.calls.map(([method]) => method)).toEqual(
      pinBeforeSwitch
        ? ['sendMessage', 'pinChatMessage', 'editMessageText']
        : identical
          ? ['sendMessage', 'pinChatMessage']
          : ['sendMessage', 'editMessageText', 'pinChatMessage'],
    );
    expect(f.call.mock.calls.filter(([method]) => method === 'pinChatMessage')).toHaveLength(1);
    expect(f.call.mock.calls.some(([method]) => method.startsWith('unpin'))).toBe(false);
  } finally {
    await restored?.stop();
    await f.close();
  }
});

it.each([false, true])(
  'reactivates every current topic message after an invalid-route flush, restart=%s',
  async (restart) => {
    const f = fixture();
    let invalid: TelegramDelivery | undefined;
    let restored: TelegramDelivery | undefined;
    try {
      await f.queue.stop();
      const destination = { chatId: -10042, threadId: 4 };
      const deliveries = [
        {
          content: 'Clarification',
          options: {
            groupId: 'group',
            key: 'task-question',
            notificationId: 'telegram:question:7:task:question',
          },
        },
        {
          content: 'Plan approval',
          options: {
            groupId: 'group',
            key: 'plan-question',
            notificationId: 'telegram:question:7:plan:approval',
          },
        },
        {
          content: 'Message from web',
          options: {
            groupId: 'group',
            key: 'web-message',
            notificationId: 'telegram:dialog:-10042:4:web-message',
          },
        },
        {
          content: 'Agent answer',
          options: {
            groupId: 'group',
            key: 'message:agent-answer',
            replace: true,
            notificationId: 'telegram:dialog:-10042:4:agent-answer',
          },
        },
      ];
      for (const delivery of deliveries)
        await f.queue.send(destination, text(delivery.content), delivery.options);
      f.store.setSetting('telegram.group', null);
      invalid = new TelegramDelivery(f.store, f.transport, 'test_bot', f.clock);
      await invalid.flush(20);
      expect(f.call).not.toHaveBeenCalled();
      f.store.setSetting('telegram.group', { chatId: -10042, ownerId: 7 });
      let currentDelivery = invalid;
      if (restart) {
        await invalid.stop();
        restored = new TelegramDelivery(f.store, f.transport, 'test_bot', f.clock);
        currentDelivery = restored;
      }
      for (const delivery of deliveries)
        await (restart ? restored! : invalid).send(
          destination,
          text(delivery.content),
          delivery.options,
        );
      await currentDelivery.flush(20);
      expect(f.call.mock.calls.map(([, body]) => body.text)).toEqual(
        deliveries.map(({ content }) => content),
      );
    } finally {
      await restored?.stop();
      await invalid?.stop();
      await f.close();
    }
  },
);

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
