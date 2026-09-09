import { it, expect, vi } from 'vitest';
import { TelegramApi, Telegram, connectTelegram } from '../src/integrations/telegram.js';
import { AppError } from '../src/core/types.js';
import { fixture } from './helpers.js';
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
