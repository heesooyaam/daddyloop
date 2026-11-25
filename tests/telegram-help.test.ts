import { expect, it, vi } from 'vitest';
import { daddyFixture } from './daddy-fixture.js';
import { catalogue } from './planning-fixture.js';
import { Telegram, TelegramApi, type Update } from '../src/integrations/telegram.js';
import { UpdateMonitor } from '../src/core/updates.js';
import { setLocale } from '../src/core/preferences.js';

it('serves scoped Russian help and installs localized suggestions without consuming a worker', async () => {
  const f = daddyFixture();
  const sent: { method: string; body: Record<string, any> }[] = [];
  const api = new TelegramApi('123456:abcdefghijklmnopqrstuvwxyz123456', async (url, req) => {
    const method = String(url).split('/').at(-1)!;
    if (method === 'getUpdates')
      return new Promise<Response>((_, reject) =>
        req?.signal?.addEventListener('abort', () => reject(req.signal!.reason), { once: true }),
      );
    const body = JSON.parse(String(req?.body));
    sent.push({ method, body });
    return Response.json({
      ok: true,
      result: method === 'setMyCommands' ? true : { message_id: sent.length },
    });
  });
  const bot = new Telegram(f.engine, api, 'fixture_bot');
  bot.configure({ daddy: f.daddy, catalogue, updates: new UpdateMonitor(f.store, { agents: [] }) });
  setLocale(f.store, 'ru');
  f.store.setSetting('telegram.pairing', { chatId: 7, userId: 7 });
  f.store.setSetting('telegram.group', { chatId: -10042, title: 'Fixture', ownerId: 7 });
  let id = 0;
  const msg = (text: string, group = false): Update => ({
    update_id: ++id,
    message: {
      message_id: id,
      chat: { id: group ? -10042 : 7, type: group ? 'supergroup' : 'private' },
      from: { id: 7 },
      ...(group ? { message_thread_id: 17 } : {}),
      text,
    },
  });
  const messages = () => sent.filter((x) => x.method === 'sendMessage');
  try {
    bot.start();
    await vi.waitFor(() =>
      expect(sent.filter((x) => x.method === 'setMyCommands')).toHaveLength(6),
    );
    for (const { body } of sent.filter((x) => x.method === 'setMyCommands')) {
      expect(body.commands.some((x: { command: string }) => x.command === 'cleanup')).toBe(
        body.scope.type === 'all_private_chats',
      );
      expect(body.commands.some((x: { command: string }) => x.command === 'help')).toBe(true);
    }
    await bot.handle(msg('/help'));
    expect(messages().at(-1)?.body.text).toContain('/cleanup');
    await bot.handle(msg('/help@fixture_bot', true));
    expect(messages().at(-1)?.body.text).toContain('/attach');
    expect(messages().at(-1)?.body.text).not.toContain('/cleanup');
    await bot.handle(msg('/help@fixture_bot /task', true));
    expect(messages().at(-1)?.body).toMatchObject({
      message_thread_id: 17,
      text: expect.stringContaining('--worker 2 -- Почини поиск'),
    });
    await bot.handle(msg('/help nonsense'));
    expect(messages().at(-1)?.body.text).toContain('Неизвестная команда');
    const count = messages().length;
    await bot.handle(msg('/help@other_bot task', true));
    expect(messages()).toHaveLength(count);
    expect(f.store.jobs()).toHaveLength(0);
  } finally {
    await bot.stop();
    await f.close();
  }
});
