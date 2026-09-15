import { expect, it, vi } from 'vitest';
import { TelegramApi, type Update } from '../src/integrations/telegram.js';

const token = '123456:abcdefghijklmnopqrstuvwxyz123456';
const callback = (
  chatId = 7,
  messageId = 10,
  threadId?: number,
): NonNullable<Update['callback_query']> => ({
  id: `callback-${chatId}-${messageId}`,
  from: { id: 42 },
  data: 'dad:home',
  message: {
    message_id: messageId,
    chat: { id: chatId, type: threadId ? 'supergroup' : 'private' },
    ...(threadId ? { message_thread_id: threadId } : {}),
  },
});
function fixture() {
  const requests: { method: string; body: Record<string, unknown> }[] = [];
  const fetcher = vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
    const method = String(url).split('/').at(-1)!;
    requests.push({ method, body: JSON.parse(String(options?.body ?? '{}')) });
    return new Response(
      JSON.stringify({
        ok: true,
        result: method === 'sendMessage' ? { message_id: 100 + requests.length } : true,
      }),
    );
  });
  return { api: new TelegramApi(token, fetcher as typeof fetch), requests, fetcher };
}
it('deletes the clicked card only after its replacement has been delivered', async () => {
  const { api, requests } = fixture();
  await api.replaceCard(callback(), async () => {
    await api.call('answerCallbackQuery', { callback_query_id: 'callback' });
    await api.send(7, 'New menu');
  });
  expect(requests.map((request) => request.method)).toEqual([
    'answerCallbackQuery',
    'sendMessage',
    'deleteMessage',
  ]);
  expect(requests.at(-1)?.body).toEqual({ chat_id: 7, message_id: 10 });
});
it('keeps the old card after a failed action, even if part of its reply arrived', async () => {
  const { api, requests } = fixture();
  await expect(
    api.replaceCard(callback(), async () => {
      await api.send(7, 'Partial reply');
      throw new Error('Action failed');
    }),
  ).rejects.toThrow('Action failed');
  await api.send(7, 'Error card');
  expect(requests.some((request) => request.method === 'deleteMessage')).toBe(false);
});
it('keeps the clicked card when only a different chat or topic received a message', async () => {
  const { api, requests } = fixture();
  await api.replaceCard(callback(7, 10, 30), async () => {
    await api.send({ chatId: 8, threadId: 30 }, 'Another chat');
    await api.send({ chatId: 7, threadId: 31 }, 'Another topic');
  });
  expect(requests.some((request) => request.method === 'deleteMessage')).toBe(false);
});
it('does not turn cleanup errors into a failed or repeated action', async () => {
  const { api, requests, fetcher } = fixture();
  const original = fetcher.getMockImplementation()!;
  fetcher.mockImplementation(async (url, options) => {
    if (String(url).endsWith('/deleteMessage')) throw new Error('Cannot delete old message');
    return original(url, options);
  });
  const warning = vi.fn(() => {
    throw new Error('Logger is also unavailable');
  });
  api.onCleanupError = warning;
  const action = vi.fn(async () => {
    await api.send(7, 'Done');
    return 42;
  });
  await expect(api.replaceCard(callback(), action)).resolves.toBe(42);
  expect(action).toHaveBeenCalledTimes(1);
  expect(requests.filter((request) => request.method === 'sendMessage')).toHaveLength(1);
  expect(warning).toHaveBeenCalledOnce();
});
it('isolates simultaneous callbacks and ignores unrelated later notifications', async () => {
  const { api, requests } = fixture();
  let later!: () => Promise<void>;
  await Promise.all([
    api.replaceCard(callback(7, 10), async () => {
      await Promise.resolve();
      await api.send(7, 'Menu A');
    }),
    api.replaceCard(callback(8, 20), async () => {
      await api.send(8, 'Menu B');
    }),
    api.replaceCard(callback(9, 30), async () => {
      later = () => api.send(9, 'Late notification').then(() => {});
    }),
  ]);
  await later();
  expect(
    requests
      .filter((request) => request.method === 'deleteMessage')
      .map((request) => request.body)
      .sort((a, b) => Number(a.chat_id) - Number(b.chat_id)),
  ).toEqual([
    { chat_id: 7, message_id: 10 },
    { chat_id: 8, message_id: 20 },
  ]);
});
