import { it, expect, vi } from 'vitest';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  TelegramApi,
  Telegram,
  connectTelegram,
  type Update,
} from '../src/integrations/telegram.js';
import { AppError } from '../src/core/types.js';
import { UpdateMonitor } from '../src/core/updates.js';
import { daddyFixture } from './daddy-fixture.js';
import { fixture } from './helpers.js';
import { catalogue } from './planning-fixture.js';
const token = '123456:abcdefghijklmnopqrstuvwxyz123456';
const transient = () =>
  new TypeError('fetch failed', {
    cause: Object.assign(new Error('socket reset'), { code: 'ECONNRESET' }),
  });
it('retries safe Telegram reads after temporary transport errors', async () => {
  const fetcher = vi
    .fn()
    .mockRejectedValueOnce(transient())
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, result: { username: 'fixture_bot' } })),
    );
  const api = new TelegramApi(token, fetcher);
  await expect(api.call('getMe')).resolves.toEqual({ username: 'fixture_bot' });
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it('does not repeat a sendMessage whose successful response might have been lost', async () => {
  const fetcher = vi.fn().mockRejectedValue(transient()),
    api = new TelegramApi(token, fetcher);
  await expect(api.send(7, 'Fixture')).rejects.toMatchObject({
    code: 'telegram_unreachable',
    message: expect.stringContaining('ECONNRESET'),
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('downloads bounded documents and uploads exports without putting the bot token in form fields', async () => {
  const requests: { url: string; body?: BodyInit | null }[] = [];
  const fetcher = vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
    requests.push({ url: String(url), body: options?.body });
    if (String(url).endsWith('/getFile'))
      return Response.json({
        ok: true,
        result: { file_path: 'documents/instructions.json', file_size: 18 },
      });
    if (String(url).includes('/file/bot')) return new Response('{"daddy":{},"worker":{}}');
    return Response.json({ ok: true, result: { message_id: 7 } });
  });
  const api = new TelegramApi(token, fetcher as typeof fetch);
  await expect(api.downloadDocument('document-id')).resolves.toEqual(
    Buffer.from('{"daddy":{},"worker":{}}'),
  );
  await api.sendDocument({ chatId: 7, threadId: 11 }, 'instructions.json', Buffer.from('{}'));
  const upload = requests.find((request) => request.url.endsWith('/sendDocument'))!;
  expect(upload.body).toBeInstanceOf(FormData);
  const form = upload.body as FormData;
  expect(form.get('chat_id')).toBe('7');
  expect(form.get('message_thread_id')).toBe('11');
  expect(form.get('document')).toBeInstanceOf(Blob);
  expect([...form.keys()]).not.toContain('token');
});
it('reports safe network diagnostics after bounded read retries without disclosing tokens', async () => {
  const error = new TypeError('fetch failed', {
    cause: Object.assign(new Error(`https://api.telegram.org/bot${token}/getMe`), {
      code: 'EAI_AGAIN',
    }),
  });
  const fetcher = vi.fn().mockRejectedValue(error),
    api = new TelegramApi(token, fetcher);
  const failure = await api.call('getMe').catch((error) => error);
  expect(failure).toBeInstanceOf(AppError);
  if (!(failure instanceof AppError)) throw new Error('Expected a transport error');
  expect(failure.message).toContain('EAI_AGAIN');
  expect(failure.message).toContain('api.telegram.org:443');
  expect(failure.message).not.toContain(token);
  expect(fetcher).toHaveBeenCalledTimes(3);
});
it('rejects redirect, malformed and authorization responses without retrying', async () => {
  for (const response of [
    new Response('', { status: 302, headers: { Location: 'https://unrelated.example' } }),
    new Response('null'),
    new Response(JSON.stringify({ ok: false, description: 'Unauthorized' }), { status: 401 }),
  ]) {
    const fetcher = vi.fn().mockResolvedValue(response),
      api = new TelegramApi(token, fetcher);
    await expect(api.call('getMe')).rejects.toBeInstanceOf(AppError);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][1].redirect).toBe('manual');
  }
});
it('cancels a read retry promptly when its caller shuts down', async () => {
  const abort = new AbortController(),
    fetcher = vi.fn().mockRejectedValue(transient()),
    api = new TelegramApi(token, fetcher);
  const request = api.call('getMe', {}, abort.signal);
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  abort.abort(new Error('shutdown'));
  await expect(request).rejects.toThrow('shutdown');
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('reconnects startup after a temporary failure and stops retrying on cancellation or invalid credentials', async () => {
  const f = await fixture(),
    bot = new Telegram(f.engine, new TelegramApi(token), 'fixture_bot');
  try {
    const error = new AppError('telegram_unreachable', 'Temporary outage'),
      notice = vi.fn();
    const factory = vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce(bot);
    await expect(connectTelegram(factory, new AbortController().signal, notice, 1)).resolves.toBe(
      bot,
    );
    expect(factory).toHaveBeenCalledTimes(2);
    expect(notice).toHaveBeenCalledWith(error);
    const bad = vi.fn().mockRejectedValue(new AppError('telegram_error', 'Unauthorized'));
    await expect(
      connectTelegram(bad, new AbortController().signal, notice, 1),
    ).resolves.toBeUndefined();
    expect(bad).toHaveBeenCalledTimes(1);
    const abort = new AbortController(),
      waiting = vi.fn().mockRejectedValue(error);
    const pending = connectTelegram(waiting, abort.signal, () => abort.abort(), 60000);
    await expect(pending).resolves.toBeUndefined();
    expect(waiting).toHaveBeenCalledTimes(1);
  } finally {
    f.store.close();
  }
});

function incoming(id: number, text: string): Update {
  return {
    update_id: id,
    message: {
      message_id: id,
      text,
      chat: { id: 7, type: 'private' },
      from: { id: 7 },
    },
  };
}

function polling(updates: Update[]) {
  const offsets: number[] = [];
  const api = new TelegramApi(token, async (url, options) => {
    if (!String(url).endsWith('/getUpdates'))
      return Response.json({ ok: true, result: { message_id: 1 } });
    const { offset } = JSON.parse(String(options?.body)) as { offset: number };
    offsets.push(offset);
    updates = updates.filter((update) => update.update_id >= offset);
    if (updates.length) return Response.json({ ok: true, result: updates });
    return new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(options.signal!.reason), {
        once: true,
      });
    });
  });
  return { api, offsets };
}

it('retries an unconfirmed message after SQLite is locked and preserves order', async () => {
  const f = daddyFixture(true);
  const locker = new DatabaseSync(join(f.dir, 'state.sqlite'));
  const { api, offsets } = polling([incoming(20, 'First message'), incoming(21, 'Second message')]);
  const bot = new Telegram(f.engine, api, 'fixture_bot');
  const updates = new UpdateMonitor(f.store, { agents: [] });
  try {
    bot.configure({ daddy: f.daddy, catalogue, updates });
    const group = f.daddy.create({ workspaceId: f.workspace.id });
    f.store.setSetting('telegram.pairing', { chatId: 7, userId: 7 });
    f.store.setSetting('telegram.currentDaddy', group.id);
    f.store.setSetting('telegram.offset', 20);
    f.store.setSetting('telegram.offsetAt', Date.now());
    f.store.db.exec('PRAGMA busy_timeout=0');
    const chat = f.daddy.chat.bind(f.daddy);
    vi.spyOn(f.daddy, 'chat').mockImplementationOnce((...args) => {
      locker.exec('BEGIN IMMEDIATE');
      return chat(...args);
    });

    bot.start();
    await vi.waitFor(() => expect(bot.status().error).toContain('database is locked'));
    expect(f.store.setting('telegram.offset')).toBe(20);
    expect(f.store.messages(group.id)).toHaveLength(0);
    locker.exec('ROLLBACK');
    await vi.waitFor(() => expect(offsets.at(-1)).toBe(22), { timeout: 6000 });
    expect(offsets).toEqual([20, 20, 22]);
    expect(f.store.messages(group.id).map((message) => message.text)).toEqual([
      'First message',
      'Second message',
    ]);
    expect(bot.status().error).toBeNull();
  } finally {
    await bot.stop();
    await updates.stop();
    locker.close();
    await f.close();
  }
});

it.each(['legacy', 'expired'])(
  'accepts a lower update ID with a %s polling offset',
  async (cursor) => {
    const f = await fixture();
    const { api, offsets } = polling([incoming(20, '/language en')]);
    const bot = new Telegram(f.engine, api, 'fixture_bot');
    try {
      f.store.setSetting('telegram.pairing', { chatId: 7, userId: 7 });
      f.store.setSetting('telegram.offset', 9000);
      if (cursor === 'expired')
        f.store.setSetting('telegram.offsetAt', Date.now() - 8 * 24 * 60 * 60 * 1000);
      bot.start();
      await vi.waitFor(() => expect(offsets.at(-1)).toBe(21));
      expect(offsets).toEqual([0, 21]);
      expect(f.store.setting('preferences')).toMatchObject({ locale: 'en' });
    } finally {
      await bot.stop();
      f.store.close();
    }
  },
);
