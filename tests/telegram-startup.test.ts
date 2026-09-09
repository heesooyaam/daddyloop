import { it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildApp } from '../src/server/app.js';
import { configSchema } from '../src/ops/config.js';
import { Telegram, TelegramApi } from '../src/integrations/telegram.js';
import { AppError } from '../src/core/types.js';
import { healthy } from './planning-fixture.js';
it('keeps the website available during a Telegram outage and connects without restarting it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'reviewloop-telegram-start-'));
  const start = vi.fn(),
    stop = vi.fn(async () => {});
  let attempts = 0;
  const factory: typeof Telegram.create = async (engine) => {
    if (++attempts === 1) throw new AppError('telegram_unreachable', 'DNS temporarily unavailable');
    const bot = new Telegram(
      engine,
      new TelegramApi('123456:abcdefghijklmnopqrstuvwxyz123456'),
      'fixture_bot',
    );
    vi.spyOn(bot, 'start').mockImplementation(start);
    vi.spyOn(bot, 'stop').mockImplementation(stop);
    return bot;
  };
  const server = await buildApp({
    dataDir: dir,
    token: 'fixture',
    telegramFactory: factory,
    config: configSchema.parse({
      telegram: { enabled: true, tokenFile: '/unused-test-credential' },
    }),
    resourceCheck: healthy,
  });
  try {
    await server.app.ready();
    expect((await server.app.inject('/api/health')).statusCode).toBe(200);
    const waiting = await server.app.inject({
      method: 'POST',
      url: '/api/telegram/pair',
      headers: { authorization: 'Bearer fixture' },
      payload: {},
    });
    expect(waiting.statusCode).toBe(503);
    expect(waiting.json().error.message).toContain('Configuration is saved');
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce(), { timeout: 5000 });
    const paired = await server.app.inject({
      method: 'POST',
      url: '/api/telegram/pair',
      headers: { authorization: 'Bearer fixture' },
      payload: {},
    });
    expect(paired.statusCode).toBe(200);
    expect(paired.json().url).toContain('https://t.me/fixture_bot?start=');
  } finally {
    await server.app.close();
    rmSync(dir, { recursive: true, force: true });
  }
  expect(stop).toHaveBeenCalledOnce();
});
it('cancels a pending startup reconnect during service shutdown', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'reviewloop-telegram-stop-'));
  const factory = vi
    .fn()
    .mockRejectedValue(new AppError('telegram_unreachable', 'Temporary outage'));
  const server = await buildApp({
    dataDir: dir,
    token: 'fixture',
    telegramFactory: factory,
    config: configSchema.parse({
      telegram: { enabled: true, tokenFile: '/unused-test-credential' },
    }),
    resourceCheck: healthy,
  });
  try {
    await server.app.ready();
    await vi.waitFor(() => expect(factory).toHaveBeenCalledOnce());
  } finally {
    await server.app.close();
    rmSync(dir, { recursive: true, force: true });
  }
  expect(factory).toHaveBeenCalledOnce();
});
