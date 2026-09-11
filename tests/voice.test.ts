import { afterEach, expect, it, vi } from 'vitest';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { daddyFixture } from './daddy-fixture.js';
import { healthy } from './planning-fixture.js';
import { TelegramApi, type Update } from '../src/integrations/telegram.js';
import { TelegramWorkspace } from '../src/integrations/telegram-workspace.js';
import type { Speech } from '../src/runtime/speech.js';
afterEach(() => vi.restoreAllMocks());
function fixture() {
  const f = daddyFixture(),
    group = f.daddy.create({ workspaceId: f.workspace.id });
  f.store.setSetting('telegram.pairing', { chatId: 7, userId: 7 });
  f.store.setSetting('telegram.currentDaddy', group.id);
  const sent: any[] = [];
  const downloadVoice = vi.fn(async () => new Uint8Array([1, 2, 3]));
  const api = {
    send: vi.fn(async (_d, card) => {
      sent.push(card);
      return { message_id: sent.length };
    }),
    call: vi.fn(async () => ({})),
    downloadVoice,
  } as unknown as TelegramApi;
  const botWorkspace = new TelegramWorkspace(f.daddy, api, 'test_bot', () => 'en');
  let nextId = 1;
  const voice = (owner = 7): Update => ({
    update_id: nextId++,
    message: {
      message_id: nextId,
      from: { id: owner },
      chat: { id: 7, type: 'private' },
      voice: { file_id: 'voice-1', file_unique_id: 'unique-1', duration: 3, file_size: 3 },
    },
  });
  const text = (text: string): Update => ({
    update_id: nextId++,
    message: { message_id: nextId, text, from: { id: 7 }, chat: { id: 7, type: 'private' } },
  });
  return { ...f, group, botWorkspace, api, downloadVoice, sent, voice, text };
}
it('checks the owner before downloading, preserves message ordering and cleans processed audio', async () => {
  const f = fixture();
  let finish!: (text: string) => void;
  const speech: Speech = {
    transcribe: vi.fn(
      async () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    ),
  };
  f.botWorkspace.configureVoice(f.dir, speech, healthy);
  f.botWorkspace.start();
  try {
    await f.botWorkspace.handle(f.voice(99));
    expect(f.downloadVoice).not.toHaveBeenCalled();
    const update = f.voice();
    await f.botWorkspace.handle(update);
    await vi.waitFor(() => expect(finish).toBeDefined());
    await f.botWorkspace.handle(f.text('Then add tests'));
    expect(f.store.messages(f.group.id)).toHaveLength(0);
    finish('Implement the feature');
    await vi.waitFor(() => expect(f.store.messages(f.group.id)).toHaveLength(2));
    expect(f.store.messages(f.group.id).map((m) => m.text)).toEqual([
      '🎙️ Implement the feature',
      'Then add tests',
    ]);
    await f.botWorkspace.handle(update);
    expect(speech.transcribe).toHaveBeenCalledOnce();
    expect(f.store.messages(f.group.id)).toHaveLength(2);
    await vi.waitFor(() => expect(readdirSync(join(f.dir, 'voice'))).toEqual([]));
  } finally {
    finish?.('Done');
    await f.botWorkspace.stop();
    await f.close();
  }
});
it('keeps the selected workspace and does not dispatch an old recording after a pause', async () => {
  const f = fixture();
  let finish!: (text: string) => void;
  f.botWorkspace.configureVoice(
    f.dir,
    {
      transcribe: async () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    },
    healthy,
  );
  f.botWorkspace.start();
  try {
    f.store.setSetting(`telegram.nextRepo:7:7:0:${f.group.id}`, {
      workspace: { ...f.workspace, repoPath: '/other/workspace' },
      expiresAt: '2099-01-01T00:00:00Z',
    });
    const update = f.voice();
    await f.botWorkspace.handle(update);
    await vi.waitFor(() => expect(finish).toBeDefined());
    const job = JSON.parse(f.store.db.prepare('SELECT data FROM voice_jobs').get()!.data as string);
    expect(job.route.workspace.repoPath).toBe('/other/workspace');
    f.store.setSetting(`telegram.nextRepo:7:7:0:${f.group.id}`, {
      workspace: f.workspace,
      expiresAt: '2099-01-01T00:00:00Z',
    });
    await f.botWorkspace.handle(update);
    expect(f.store.setting(`telegram.nextRepo:7:7:0:${f.group.id}`)).not.toBeNull();
    await f.botWorkspace.handle(f.text('/pause'));
    finish('Implement this');
    await vi.waitFor(() =>
      expect(f.store.db.prepare('SELECT status FROM voice_jobs').get()!.status).toBe('failed'),
    );
    expect(f.store.messages(f.group.id)).toHaveLength(0);
    expect(
      f.sent.some(
        (item) => typeof item !== 'string' && item.text?.includes('Voice message was not sent'),
      ),
    ).toBe(true);
  } finally {
    finish?.('Done');
    await f.botWorkspace.stop();
    await f.close();
  }
});
it('replays preserved voice input after interruption and honors the memory guard', async () => {
  const f = fixture();
  let available = false,
    started!: () => void;
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  f.botWorkspace.configureVoice(
    f.dir,
    {
      transcribe: async (_path, _locale, signal) => {
        started();
        return new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true }),
        );
      },
    },
    () => ({ ...healthy(), memoryAvailableGiB: available ? 8 : 3 }),
  );
  f.botWorkspace.start();
  try {
    await f.botWorkspace.handle(f.voice());
    expect(f.downloadVoice).not.toHaveBeenCalled();
    available = true;
    await began;
    await f.botWorkspace.stop();
    expect(f.store.db.prepare('SELECT status FROM voice_jobs').get()!.status).toBe('queued');
    const restarted = new TelegramWorkspace(f.daddy, f.api, 'test_bot', () => 'en');
    restarted.configureVoice(f.dir, { transcribe: async () => 'Recovered speech' }, healthy);
    restarted.start();
    await vi.waitFor(() =>
      expect(f.store.messages(f.group.id)[0]?.text).toBe('🎙️ Recovered speech'),
    );
    expect(f.downloadVoice).toHaveBeenCalledOnce();
    await restarted.stop();
  } finally {
    await f.botWorkspace.stop();
    await f.close();
  }
});
it('bounds Telegram downloads and never follows a file redirect or an escaping path', async () => {
  const token = '123456:abcdefghijklmnopqrstuvwxyz123456';
  let path = '../secret',
    mode = 'normal';
  const urls: string[] = [];
  const api = new TelegramApi(token, async (url) => {
    urls.push(String(url));
    if (String(url).endsWith('/getFile'))
      return new Response(JSON.stringify({ ok: true, result: { file_path: path } }));
    if (mode === 'redirect')
      return new Response('', { status: 302, headers: { location: 'https://attacker.invalid' } });
    return new Response('x', { headers: { 'content-length': String(11 * 1024 * 1024) } });
  });
  await expect(api.downloadVoice('id')).rejects.toThrow('invalid voice file path');
  expect(urls).toHaveLength(1);
  path = 'voice/file.oga';
  mode = 'redirect';
  await expect(api.downloadVoice('id')).rejects.toThrow('Could not download');
  mode = 'normal';
  await expect(api.downloadVoice('id')).rejects.toThrow('10 MB');
  expect(urls.every((url) => url.startsWith('https://api.telegram.org/'))).toBe(true);
});
