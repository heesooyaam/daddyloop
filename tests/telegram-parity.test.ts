import { expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { InstructionPresets } from '../src/core/instruction-presets.js';
import { TelegramWorkspace } from '../src/integrations/telegram-workspace.js';
import type { TelegramApi, Update } from '../src/integrations/telegram.js';
import { daddyFixture } from './daddy-fixture.js';
import { InstructionSources } from '../src/ops/instruction-sources.js';
import { rememberSecret } from '../src/core/security.js';

function apiFixture() {
  const sent: { destination: any; card: any }[] = [];
  let document = new Uint8Array();
  const send = vi.fn(async (destination, card) => {
    sent.push({ destination, card });
    return { message_id: sent.length };
  });
  const sendDocument = vi.fn(
    async (
      _destination: number | { chatId: number; threadId?: number },
      _filename: string,
      _bytes: Uint8Array,
      _caption?: string,
    ) => ({ message_id: 100 }),
  );
  const downloadDocument = vi.fn(async () => document);
  const api = {
    replaceCard: async (_callback: unknown, action: () => Promise<unknown>) => action(),
    send,
    call: vi.fn(async (method: string) =>
      method === 'createForumTopic' ? { message_thread_id: 51 } : true,
    ),
    downloadDocument,
    sendDocument,
  } as unknown as TelegramApi;
  return {
    api,
    sent,
    send,
    sendDocument,
    downloadDocument,
    document(value: string) {
      document = Buffer.from(value);
    },
  };
}

it('imports and exports instructions and phone skill files only through the paired private chat', async () => {
  const f = daddyFixture(),
    telegram = apiFixture(),
    bot = new TelegramWorkspace(f.daddy, telegram.api, 'fixture_bot', () => 'en');
  f.store.setSetting('telegram.pairing', { chatId: 7, userId: 7 });
  f.store.setSetting('telegram.group', { chatId: -10042, ownerId: 7, title: 'Work' });
  const group = f.daddy.create({
    workspaceId: f.workspace.id,
    instructions: { daddy: { prompt: 'Original' }, worker: {} },
  });
  f.store.setSetting('telegram.currentDaddy', group.id);
  const topic = await bot.ensureTopic(group);
  let id = 1;
  const message = (text: string, chat = 7, thread?: number): Update => ({
    update_id: id++,
    message: {
      message_id: id,
      text,
      from: { id: 7 },
      chat: { id: chat, type: chat === 7 ? 'private' : 'supergroup' },
      message_thread_id: thread,
    },
  });
  const file = (name: string): Update => ({
    update_id: id++,
    message: {
      message_id: id,
      from: { id: 7 },
      chat: { id: 7, type: 'private' },
      document: {
        file_id: `file-${id}`,
        file_unique_id: `unique-${id}`,
        file_name: name,
        file_size: 100,
      },
    },
  });
  try {
    await bot.handle(message('/instructions export'));
    expect(telegram.sendDocument).toHaveBeenCalledOnce();
    const exported = telegram.sendDocument.mock.calls[0];
    expect(exported[0]).toEqual({ chatId: 7, threadId: undefined });
    expect(exported[1]).toMatch(/^daddy-instructions-/);
    expect(JSON.parse(Buffer.from(exported[2]).toString('utf8'))).toMatchObject({
      daddy: { prompt: 'Original' },
    });

    telegram.document(JSON.stringify({ daddy: { prompt: 'Imported from phone' }, worker: {} }));
    await bot.handle(message('/instructions import'));
    await bot.handle(file('instructions.json'));
    expect(f.daddy.group(group.id).instructions?.daddy.prompt).toBe('Imported from phone');
    expect(telegram.sent.at(-1)?.card).toContain(group.title);

    telegram.document('# Phone skill\n\nKeep reports short.');
    await bot.handle(message('/skill worker file'));
    await bot.handle(file('phone-skill.md'));
    expect(f.daddy.group(group.id).instructions?.worker.skills?.[0]).toMatchObject({
      name: 'phone-skill.md',
      source: { kind: 'file' },
    });
    expect(telegram.sent.at(-1)?.card).toContain(group.title);

    await bot.handle(message('/instructions export', -10042, topic!.threadId));
    expect(telegram.sendDocument).toHaveBeenCalledOnce();
    expect(telegram.sent.at(-1)?.card.text).toContain('paired private chat');
    expect(telegram.sent.at(-1)?.card.text).toContain(`/session ${group.id.slice(0, 8)}`);

    await f.daddy.settings(group.id, {
      instructions: {
        daddy: { prompt: 'PRIVATE_TOKEN_MUST_NOT_BE_ECHOED' },
        worker: f.daddy.group(group.id).instructions?.worker ?? {},
      },
    });
    await bot.handle(
      message('/instructions worker Public group preference', -10042, topic!.threadId),
    );
    expect(f.daddy.group(group.id).instructions?.worker.prompt).toBe('Public group preference');
    expect(telegram.sent.at(-1)?.card).not.toContain('PRIVATE_TOKEN_MUST_NOT_BE_ECHOED');
    expect(telegram.sent.at(-1)?.card).toContain('Full text is available in the private chat');
  } finally {
    await bot.stop();
    await f.close();
  }
});

it('confirms local and pasted skills with their role, session and duplicate result', async () => {
  const f = daddyFixture(),
    telegram = apiFixture();
  let locale: 'en' | 'ru' = 'en';
  const bot = new TelegramWorkspace(f.daddy, telegram.api, 'fixture_bot', () => locale);
  f.store.setSetting('telegram.pairing', { chatId: 7, userId: 7 });
  const group = f.daddy.create({ workspaceId: f.workspace.id, title: 'Phone session' });
  f.store.setSetting('telegram.currentDaddy', group.id);
  const directory = join(f.dir, 'local-skill');
  mkdirSync(directory);
  writeFileSync(
    join(directory, 'SKILL.md'),
    '---\nname: local-phone\ndescription: Local fixture\n---\nKeep local checks.\n',
  );
  let id = 40;
  const message = (text: string): Update => ({
    update_id: id++,
    message: {
      message_id: id,
      text,
      from: { id: 7 },
      chat: { id: 7, type: 'private' },
    },
  });
  try {
    await bot.handle(message(`/skill worker local ${directory}`));
    expect(telegram.sent.at(-1)!.card).toContain('local-phone');
    expect(telegram.sent.at(-1)!.card).toContain('All workers');
    expect(telegram.sent.at(-1)!.card).toContain(group.title);
    await bot.handle(message(`/skill worker local ${directory}`));
    expect(telegram.sent.at(-1)!.card).toContain('already connected');

    locale = 'ru';
    await bot.handle(message('/skill daddy text pasted-phone :: Keep pasted checks.'));
    expect(telegram.sent.at(-1)!.card).toContain('pasted-phone');
    expect(telegram.sent.at(-1)!.card).toContain('добавлен');
    expect(telegram.sent.at(-1)!.card).toContain(group.title);
    await bot.handle(message('/skill daddy text pasted-phone :: Keep pasted checks.'));
    expect(telegram.sent.at(-1)!.card).toContain('уже подключён');
  } finally {
    await bot.stop();
    await f.close();
  }
});

it('cancels pending instruction and skill files when the selected session changes', async () => {
  const f = daddyFixture(),
    telegram = apiFixture(),
    bot = new TelegramWorkspace(f.daddy, telegram.api, 'fixture_bot', () => 'en');
  f.store.setSetting('telegram.pairing', { chatId: 7, userId: 7 });
  const first = f.daddy.create({
      workspaceId: f.workspace.id,
      title: 'Import A',
      instructions: { daddy: { prompt: 'A' }, worker: {} },
    }),
    second = f.daddy.create({
      workspaceId: f.workspace.id,
      title: 'Import B',
      instructions: { daddy: { prompt: 'B' }, worker: {} },
    });
  f.store.setSetting('telegram.currentDaddy', first.id);
  let id = 50;
  const message = (text: string): Update => ({
    update_id: id++,
    message: {
      message_id: id,
      text,
      from: { id: 7 },
      chat: { id: 7, type: 'private' },
    },
  });
  const file = (name: string): Update => ({
    update_id: id++,
    message: {
      message_id: id,
      from: { id: 7 },
      chat: { id: 7, type: 'private' },
      document: {
        file_id: `file-${id}`,
        file_unique_id: `unique-${id}`,
        file_name: name,
        file_size: 100,
      },
    },
  });
  const unchanged = () => {
    expect(f.daddy.group(first.id).instructions).toEqual({
      daddy: { prompt: 'A' },
      worker: {},
    });
    expect(f.daddy.group(second.id).instructions).toEqual({
      daddy: { prompt: 'B' },
      worker: {},
    });
  };
  try {
    telegram.document(JSON.stringify({ daddy: { prompt: 'changed' }, worker: {} }));
    await bot.handle(message('/instructions import'));
    await bot.handle(message(`/session ${second.id.slice(0, 8)}`));
    await bot.handle(file('instructions.json'));
    unchanged();

    await bot.handle(message(`/session ${first.id.slice(0, 8)}`));
    await bot.handle(message('/skill worker file'));
    await bot.handle(message(`/session ${second.id.slice(0, 8)}`));
    await bot.handle(file('skill.md'));
    unchanged();

    await bot.handle(message(`/session ${first.id.slice(0, 8)}`));
    await bot.handle(message('/instructions import'));
    let release!: (value: Uint8Array<ArrayBuffer>) => void;
    telegram.downloadDocument.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const uploading = bot.handle(file('instructions.json'));
    await vi.waitFor(() => expect(telegram.downloadDocument).toHaveBeenCalled());
    await bot.handle(message(`/session ${second.id.slice(0, 8)}`));
    release(new TextEncoder().encode(JSON.stringify({ daddy: { prompt: 'late' }, worker: {} })));
    await uploading;
    unchanged();
  } finally {
    await bot.stop();
    await f.close();
  }
});

it('rechecks instruction snapshots after waiting for the session lock', async () => {
  const f = daddyFixture(),
    telegram = apiFixture(),
    bot = new TelegramWorkspace(f.daddy, telegram.api, 'fixture_bot', () => 'en');
  f.store.setSetting('telegram.pairing', { chatId: 7, userId: 7 });
  const group = f.daddy.create({
    workspaceId: f.workspace.id,
    instructions: { daddy: { prompt: 'Initial' }, worker: {} },
  });
  f.store.setSetting('telegram.currentDaddy', group.id);
  let id = 120;
  const message = (text: string): Update => ({
    update_id: id++,
    message: {
      message_id: id,
      text,
      from: { id: 7 },
      chat: { id: 7, type: 'private' },
    },
  });
  const file = (name: string): Update => ({
    update_id: id++,
    message: {
      message_id: id,
      from: { id: 7 },
      chat: { id: 7, type: 'private' },
      document: {
        file_id: `file-${id}`,
        file_unique_id: `unique-${id}`,
        file_name: name,
        file_size: 100,
      },
    },
  });
  const block = async () => {
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const locked = f.engine.lock(`create-task:${group.id}`, async () => {
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    await ready;
    return { release, locked };
  };
  try {
    telegram.document(JSON.stringify({ daddy: { prompt: 'Imported' }, worker: {} }));
    await bot.handle(message('/instructions import'));
    const first = await block();
    const web = f.daddy.settings(group.id, {
      instructions: { daddy: { prompt: 'Web change' }, worker: {} },
    });
    const upload = bot.handle(file('instructions.json'));
    first.release();
    await Promise.all([first.locked, web, upload]);
    expect(f.daddy.group(group.id).instructions).toEqual({
      daddy: { prompt: 'Web change' },
      worker: {},
    });

    telegram.document('# Skill\n\nDo not restore an old prompt.');
    await bot.handle(message('/skill worker file'));
    const second = await block();
    const nextWeb = f.daddy.settings(group.id, {
      instructions: { daddy: { prompt: 'Later web change' }, worker: {} },
    });
    const skill = bot.handle(file('skill.md'));
    second.release();
    await Promise.all([second.locked, nextWeb, skill]);
    expect(f.daddy.group(group.id).instructions).toEqual({
      daddy: { prompt: 'Later web change' },
      worker: {},
    });
  } finally {
    await bot.stop();
    await f.close();
  }
});

it('manages preset snapshots and per-session components from Telegram', async () => {
  const f = daddyFixture(),
    telegram = apiFixture(),
    bot = new TelegramWorkspace(f.daddy, telegram.api, 'fixture_bot', () => 'en');
  f.store.setSetting('telegram.pairing', { chatId: 7, userId: 7 });
  const group = f.daddy.create({
    workspaceId: f.workspace.id,
    instructions: {
      daddy: { prompt: 'Preset daddy prompt' },
      worker: { prompt: 'Preset worker prompt' },
    },
  });
  f.store.setSetting('telegram.currentDaddy', group.id);
  let id = 100;
  const message = (text: string): Update => ({
    update_id: id++,
    message: {
      message_id: id,
      text,
      from: { id: 7 },
      chat: { id: 7, type: 'private' },
    },
  });
  const click = (data: string): Update => ({
    update_id: id++,
    callback_query: {
      id: String(id),
      data,
      from: { id: 7 },
      message: { chat: { id: 7, type: 'private' } },
    },
  });
  try {
    await bot.handle(message('/preset save Phone style'));
    const library = new InstructionPresets(f.store);
    expect(library.list()).toHaveLength(1);
    await bot.handle(message('/preset describe Phone style :: Used from Telegram'));
    await bot.handle(message('/preset rename Phone style :: Mobile style'));
    expect(library.list()[0]).toMatchObject({
      name: 'Mobile style',
      description: 'Used from Telegram',
      revision: 3,
    });
    const originalId = library.list()[0].id;
    await bot.handle(message('/preset Mobile style'));
    expect(f.daddy.group(group.id).instructions?.presets?.[0].preset.name).toBe('Mobile style');

    await bot.handle(message('/preset parts Mobile style'));
    const toggle = telegram.sent.at(-1)!.card.buttons[0][0].callback_data;
    await bot.handle(click(toggle));
    expect(f.daddy.group(group.id).instructions?.presets?.[0].omit).toContain('daddy:prompt');
    const toggleId = String(toggle).slice('dad:preset:'.length);
    expect(
      f.store.db.prepare('SELECT consumed FROM bot_actions WHERE id=?').get(toggleId)?.consumed,
    ).toBe(1);
    await bot.handle(click(toggle));
    expect(f.daddy.group(group.id).instructions?.presets?.[0].omit).toContain('daddy:prompt');

    const enable = telegram.sent.at(-1)!.card.buttons[0][0].callback_data;
    telegram.send.mockRejectedValueOnce(new Error('response lost after settings were saved'));
    await bot.handle(click(enable));
    expect(f.daddy.group(group.id).instructions?.presets?.[0].omit).not.toContain('daddy:prompt');
    const restarted = new TelegramWorkspace(f.daddy, telegram.api, 'fixture_bot', () => 'en');
    await restarted.handle(click(enable));
    expect(f.daddy.group(group.id).instructions?.presets?.[0].omit).not.toContain('daddy:prompt');
    await restarted.stop();

    await bot.handle(message('/preset delete Mobile style'));
    const remove = telegram.sent.at(-1)!.card.buttons[0][0].callback_data,
      cancel = telegram.sent.at(-1)!.card.buttons[1][0].callback_data;
    await bot.handle(click(cancel));
    const afterCancel = new TelegramWorkspace(f.daddy, telegram.api, 'fixture_bot', () => 'en');
    await afterCancel.handle(click(remove));
    expect(library.list()).toHaveLength(1);
    await afterCancel.stop();

    await bot.handle(message('/preset delete Mobile style'));
    await bot.handle(click(telegram.sent.at(-1)!.card.buttons[0][0].callback_data));
    expect(library.list()).toHaveLength(0);
    expect(f.daddy.group(group.id).instructions?.presets?.[0].preset.name).toBe('Mobile style');

    await bot.handle(message('/preset disable Mobile style'));
    expect(f.daddy.group(group.id).instructions?.presets?.[0].enabled).toBe(false);
    await bot.handle(message(`/preset enable ${originalId}`));
    expect(f.daddy.group(group.id).instructions?.presets?.[0].enabled).toBe(true);

    const replacement = library.save({
      name: 'Mobile style',
      instructions: { daddy: { prompt: 'Replacement' }, worker: {} },
    });
    await bot.handle(message('/preset disable Mobile style'));
    expect(f.daddy.group(group.id).instructions?.presets).toMatchObject([
      { preset: { id: originalId }, enabled: false },
    ]);
    await bot.handle(message(`/preset remove ${originalId}`));
    expect(f.daddy.group(group.id).instructions?.presets).toEqual([]);
    expect(library.list()).toMatchObject([{ id: replacement.id, name: 'Mobile style' }]);
    await bot.handle(message('/preset Mobile style'));
    expect(f.daddy.group(group.id).instructions?.presets).toMatchObject([
      { preset: { id: replacement.id }, enabled: true },
    ]);
  } finally {
    await bot.stop();
    await f.close();
  }
});

it('keeps saved instruction text private through preset and settings callback buttons', async () => {
  const f = daddyFixture(),
    telegram = apiFixture(),
    bot = new TelegramWorkspace(f.daddy, telegram.api, 'fixture_bot', () => 'en');
  f.store.setSetting('telegram.pairing', { chatId: 7, userId: 7 });
  f.store.setSetting('telegram.group', { chatId: -10042, ownerId: 7, title: 'Work' });
  const group = f.daddy.create({ workspaceId: f.workspace.id });
  new InstructionPresets(f.store).save({
    name: 'Private preset',
    instructions: {
      daddy: { prompt: 'PRIVATE_PRESET_PROMPT' },
      worker: { prompt: 'PRIVATE_WORKER_PROMPT' },
    },
  });
  await f.daddy.settings(group.id, {
    instructions: {
      daddy: {},
      worker: {},
    },
  });
  const topic = await bot.ensureTopic(group);
  let id = 180;
  const message = (text: string, threadId: number | null = topic!.threadId): Update => ({
    update_id: id++,
    message: {
      message_id: id,
      text,
      from: { id: 7 },
      chat: { id: -10042, type: 'supergroup' },
      message_thread_id: threadId ?? undefined,
    },
  });
  const click = (data: string): Update => ({
    update_id: id++,
    callback_query: {
      id: String(id),
      data,
      from: { id: 7 },
      message: {
        chat: { id: -10042, type: 'supergroup' },
        message_thread_id: topic!.threadId,
      },
    },
  });
  try {
    await bot.handle(message('/preset Private preset'));
    expect(telegram.sent.at(-1)!.card.text).toContain('Private preset');
    expect(telegram.sent.at(-1)!.card.text).not.toContain('PRIVATE_PRESET_PROMPT');
    expect(telegram.sent.at(-1)!.card.text).not.toContain('PRIVATE_WORKER_PROMPT');

    await bot.handle(message(`/session ${group.id.slice(0, 8)}`, null));
    await bot.handle(message('/preset Private preset', null));
    expect(telegram.sent.at(-1)!.card.text).toContain('Private preset');
    expect(telegram.sent.at(-1)!.card.text).not.toContain('PRIVATE_PRESET_PROMPT');
    expect(telegram.sent.at(-1)!.card.text).not.toContain('PRIVATE_WORKER_PROMPT');
    expect(f.daddy.group(group.id).instructions?.presets?.[0].enabled).toBe(true);

    await bot.handle(message('/preset parts Private preset'));
    const back = telegram.sent.at(-1)!.card.buttons.at(-1)[0].callback_data;
    await bot.handle(click(back));
    expect(telegram.sent.at(-1)!.card.text).toContain('paired private chat');
    expect(telegram.sent.at(-1)!.card.text).not.toContain('PRIVATE_PRESET_PROMPT');

    await bot.handle(click(`dad:settings:${group.id}`));
    const instructions = telegram.sent
      .at(-1)!
      .card.buttons.flat()
      .find((button: any) => button.callback_data === `dad:instructions:${group.id}`).callback_data;
    await bot.handle(click(instructions));
    expect(telegram.sent.at(-1)!.card.text).toContain('paired private chat');
    expect(telegram.sent.at(-1)!.card.text).not.toContain('PRIVATE_PRESET_PROMPT');
  } finally {
    await bot.stop();
    await f.close();
  }
});

it('keeps concurrent instruction changes when Telegram applies presets or edits another role', async () => {
  const f = daddyFixture(),
    telegram = apiFixture(),
    bot = new TelegramWorkspace(f.daddy, telegram.api, 'fixture_bot', () => 'en');
  f.store.setSetting('telegram.pairing', { chatId: 7, userId: 7 });
  const group = f.daddy.create({
    workspaceId: f.workspace.id,
    instructions: {
      daddy: { prompt: 'Original daddy' },
      worker: { prompt: 'Original worker' },
    },
  });
  f.store.setSetting('telegram.currentDaddy', group.id);
  const preset = new InstructionPresets(f.store).save({
    name: 'Concurrent preset',
    instructions: {
      daddy: { prompt: 'Preset daddy' },
      worker: { prompt: 'Preset worker' },
    },
  });
  let id = 240;
  const message = (text: string): Update => ({
    update_id: id++,
    message: {
      message_id: id,
      text,
      from: { id: 7 },
      chat: { id: 7, type: 'private' },
    },
  });
  const click = (data: string): Update => ({
    update_id: id++,
    callback_query: {
      id: String(id),
      data,
      from: { id: 7 },
      message: { chat: { id: 7, type: 'private' } },
    },
  });
  const block = async () => {
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const locked = f.engine.lock(`create-task:${group.id}`, async () => {
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    await ready;
    return { release, locked };
  };
  const race = async (instructions: any, action: () => Promise<unknown>) => {
    const lock = await block();
    const web = f.daddy.settings(group.id, { instructions });
    const telegramAction = action();
    lock.release();
    await Promise.all([lock.locked, web, telegramAction]);
  };
  try {
    await bot.handle(message('/presets'));
    const select = telegram.sent
      .at(-1)!
      .card.buttons.flat()
      .find((button: any) => button.text === preset.name).callback_data;
    await race({ daddy: { prompt: 'Web daddy 1' }, worker: { prompt: 'Original worker' } }, () =>
      bot.handle(click(select)),
    );
    expect(f.daddy.group(group.id).instructions).toEqual({
      daddy: { prompt: 'Web daddy 1' },
      worker: { prompt: 'Original worker' },
    });
    const selectId = String(select).slice('dad:preset:'.length);
    expect(
      f.store.db.prepare('SELECT consumed FROM bot_actions WHERE id=?').get(selectId)?.consumed,
    ).toBe(0);

    await race({ daddy: { prompt: 'Web daddy 1b' }, worker: { prompt: 'Original worker' } }, () =>
      bot.handle(message('/preset Concurrent preset')),
    );
    expect(f.daddy.group(group.id).instructions).toEqual({
      daddy: { prompt: 'Web daddy 1b' },
      worker: { prompt: 'Original worker' },
    });

    await f.daddy.settings(group.id, {
      instructions: {
        daddy: { prompt: 'Web daddy 1b' },
        worker: { prompt: 'Original worker' },
        presets: [{ preset, enabled: true, omit: [] }],
      },
    });
    await bot.handle(message('/preset parts Concurrent preset'));
    const part = telegram.sent.at(-1)!.card.buttons[0][0].callback_data;
    await race(
      {
        daddy: { prompt: 'Web daddy 2' },
        worker: { prompt: 'Original worker' },
        presets: [{ preset, enabled: true, omit: [] }],
      },
      () => bot.handle(click(part)),
    );
    expect(f.daddy.group(group.id).instructions?.daddy.prompt).toBe('Web daddy 2');
    expect(f.daddy.group(group.id).instructions?.presets?.[0].omit).toEqual([]);
    const partId = String(part).slice('dad:preset:'.length);
    expect(
      f.store.db.prepare('SELECT consumed FROM bot_actions WHERE id=?').get(partId)?.consumed,
    ).toBe(0);

    await f.daddy.settings(group.id, {
      instructions: {
        daddy: { prompt: 'Web daddy 2' },
        worker: { prompt: 'Original worker' },
        presets: [{ preset, enabled: false, omit: [] }],
      },
    });
    await race(
      {
        daddy: { prompt: 'Web daddy 2b' },
        worker: { prompt: 'Original worker' },
        presets: [{ preset, enabled: false, omit: [] }],
      },
      () => bot.handle(message('/preset enable Concurrent preset')),
    );
    expect(f.daddy.group(group.id).instructions?.daddy.prompt).toBe('Web daddy 2b');
    expect(f.daddy.group(group.id).instructions?.presets?.[0].enabled).toBe(false);

    await race(
      {
        daddy: { prompt: 'Web daddy 3' },
        worker: { prompt: 'Original worker' },
        presets: [{ preset, enabled: true, omit: [] }],
      },
      () => bot.handle(message('/preset disable Concurrent preset')),
    );
    expect(f.daddy.group(group.id).instructions?.daddy.prompt).toBe('Web daddy 3');
    expect(f.daddy.group(group.id).instructions?.presets?.[0].enabled).toBe(true);

    await race(
      {
        daddy: { prompt: 'Web daddy 4' },
        worker: { prompt: 'Original worker' },
        presets: [{ preset, enabled: true, omit: [] }],
      },
      () => bot.handle(message('/instructions worker Replacement worker')),
    );
    expect(f.daddy.group(group.id).instructions?.daddy.prompt).toBe('Web daddy 4');
    expect(f.daddy.group(group.id).instructions?.worker.prompt).toBe('Original worker');

    await race(
      {
        daddy: { prompt: 'Web daddy 5' },
        worker: { prompt: 'Original worker' },
        presets: [{ preset, enabled: true, omit: [] }],
      },
      () => bot.handle(message('/instructions worker --clear')),
    );
    expect(f.daddy.group(group.id).instructions?.daddy.prompt).toBe('Web daddy 5');
    expect(f.daddy.group(group.id).instructions?.worker.prompt).toBe('Original worker');
  } finally {
    await bot.stop();
    await f.close();
  }
});

it('rejects Telegram instruction imports while a session is being deleted', async () => {
  const f = daddyFixture(),
    telegram = apiFixture(),
    bot = new TelegramWorkspace(f.daddy, telegram.api, 'fixture_bot', () => 'en');
  f.store.setSetting('telegram.pairing', { chatId: 7, userId: 7 });
  const group = f.daddy.create({
    workspaceId: f.workspace.id,
    instructions: { daddy: { prompt: 'Original' }, worker: {} },
  });
  f.store.setSetting('telegram.currentDaddy', group.id);
  let id = 320;
  const message = (text: string): Update => ({
    update_id: id++,
    message: {
      message_id: id,
      text,
      from: { id: 7 },
      chat: { id: 7, type: 'private' },
    },
  });
  const file = (name = 'instructions.json'): Update => ({
    update_id: id++,
    message: {
      message_id: id,
      from: { id: 7 },
      chat: { id: 7, type: 'private' },
      document: {
        file_id: `file-${id}`,
        file_unique_id: `unique-${id}`,
        file_name: name,
        file_size: 100,
      },
    },
  });
  telegram.document(JSON.stringify({ daddy: { prompt: 'Imported' }, worker: {} }));
  try {
    for (const state of ['pending', 'running', 'error'] as const) {
      const current = f.daddy.group(group.id);
      current.deletion = { state };
      f.store.saveGroup(current);
      await bot.handle(message('/instructions import'));
      await bot.handle(file());
      expect(f.daddy.group(group.id).instructions?.daddy.prompt).toBe('Original');
      expect(telegram.sent.at(-1)!.card.text).toContain('being deleted');
    }

    const deleting = f.daddy.group(group.id);
    deleting.deletion = { state: 'pending' };
    f.store.saveGroup(deleting);
    telegram.document('# Skill\n\nDo not save during deletion.');
    await bot.handle(message('/skill worker file'));
    await bot.handle(file('skill.md'));
    expect(f.daddy.group(group.id).instructions?.worker.skills).toBeUndefined();
    expect(telegram.sent.at(-1)!.card.text).toContain('being deleted');

    const current = f.daddy.group(group.id);
    delete current.deletion;
    current.daddyState = 'paused';
    f.store.saveGroup(current);
    telegram.document(JSON.stringify({ daddy: { prompt: 'Imported' }, worker: {} }));
    await bot.handle(message('/instructions import'));
    await bot.handle(file());
    expect(f.daddy.group(group.id).instructions?.daddy.prompt).toBe('Imported');
  } finally {
    await bot.stop();
    await f.close();
  }
});

it('edits saved workspace defaults in private without exposing repository paths to a group', async () => {
  const f = daddyFixture(),
    telegram = apiFixture(),
    bot = new TelegramWorkspace(f.daddy, telegram.api, 'fixture_bot', () => 'en');
  f.store.setSetting('telegram.pairing', { chatId: 7, userId: 7 });
  f.store.setSetting('telegram.group', { chatId: -10042, ownerId: 7, title: 'Work' });
  const register = vi.spyOn(f.workspaces, 'register').mockImplementation(async (input, id) => {
    const current = f.workspaces.get(id!);
    const saved = {
      ...current,
      name: input.name,
      repoPath: input.path,
      scope: input.scope ?? '',
      base: input.base,
      copyMode: input.copyMode ?? current.copyMode,
    };
    f.store.saveWorkspace(saved);
    return saved;
  });
  let id = 200;
  const message = (text: string, chat = 7): Update => ({
    update_id: id++,
    message: {
      message_id: id,
      text,
      from: { id: 7 },
      chat: { id: chat, type: chat === 7 ? 'private' : 'supergroup' },
    },
  });
  try {
    await bot.handle(message(`/workspace ${f.workspace.id.slice(0, 8)}`));
    expect(telegram.sent.at(-1)!.card.text).toContain(f.workspace.repoPath);
    await bot.handle(message(`/workspace ${f.workspace.id.slice(0, 8)} name Mobile repository`));
    expect(register).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Mobile repository', path: f.workspace.repoPath }),
      f.workspace.id,
    );
    const before = register.mock.calls.length;
    await bot.handle(message(`/workspace ${f.workspace.id.slice(0, 8)}`, -10042));
    expect(register).toHaveBeenCalledTimes(before);
    expect(telegram.sent.at(-1)!.card.text).not.toContain(f.workspace.repoPath);
    expect(telegram.sent.at(-1)!.card.text).toContain('private bot chat');
  } finally {
    await bot.stop();
    await f.close();
  }
});

it('shows individual CI checks and safe links in the Telegram task card', async () => {
  const f = daddyFixture(),
    telegram = apiFixture(),
    bot = new TelegramWorkspace(f.daddy, telegram.api, 'fixture_bot', () => 'en');
  f.store.setSetting('telegram.pairing', { chatId: 7, userId: 7 });
  const group = f.daddy.create({ workspaceId: f.workspace.id });
  const task = await f.engine.create({
    ref: {
      provider: 'demo',
      host: 'demo.local',
      repo: 'test/repo',
      number: 44,
      url: 'https://demo.local/pull/44',
    },
    repoPath: f.dir,
    requirements: 'Show check details',
    groupId: group.id,
    groupGeneration: group.generation,
  });
  task.pr!.checks = 'failing';
  task.pr!.checkDetails = Array.from({ length: 13 }, (_, index) => ({
    name: `Check ${index + 1}`,
    status: index === 12 ? 'failed' : 'success',
    url: `https://ci.example.test/run/${index + 1}`,
  }));
  f.store.saveTask(task);
  f.store.setSetting('telegram.currentDaddy', group.id);
  try {
    await bot.handle({
      update_id: 500,
      message: {
        message_id: 501,
        text: '/tasks',
        from: { id: 7 },
        chat: { id: 7, type: 'private' },
      },
    });
    const open = telegram.sent.at(-1)!.card.buttons[0][0].callback_data;
    await bot.handle({
      update_id: 501,
      callback_query: {
        id: 'open-task',
        data: open,
        from: { id: 7 },
        message: { chat: { id: 7, type: 'private' } },
      },
    });
    expect(telegram.sent.at(-1)!.card.text).toContain('Check 13: failed');
    expect(telegram.sent.at(-1)!.card.entities).toContainEqual(
      expect.objectContaining({ type: 'text_link', url: 'https://ci.example.test/run/13' }),
    );
  } finally {
    await bot.stop();
    await f.close();
  }
});

it('redacts preset and skill names from group library and component cards', async () => {
  const f = daddyFixture(),
    telegram = apiFixture(),
    bot = new TelegramWorkspace(f.daddy, telegram.api, 'fixture_bot', () => 'en');
  const secret = rememberSecret('PRIVATE_PRESET_MARKER_12345');
  f.store.setSetting('telegram.pairing', { chatId: 7, userId: 7 });
  f.store.setSetting('telegram.group', { chatId: -10042, ownerId: 7, title: 'Work' });
  const group = f.daddy.create({ workspaceId: f.workspace.id }),
    skill = await new InstructionSources().import({
      kind: 'text',
      name: `Skill ${secret}`,
      text: 'Keep this fixture private.',
    }),
    preset = new InstructionPresets(f.store).save({
      name: `Preset ${secret}`,
      instructions: { daddy: {}, worker: { skills: [skill] } },
    });
  await f.daddy.settings(group.id, {
    instructions: { daddy: {}, worker: {}, presets: [{ preset, enabled: true, omit: [] }] },
  });
  const topic = await bot.ensureTopic(group);
  let id = 540;
  const message = (text: string, threadId?: number): Update => ({
    update_id: id++,
    message: {
      message_id: id,
      text,
      from: { id: 7 },
      chat: { id: -10042, type: 'supergroup' },
      message_thread_id: threadId,
    },
  });
  try {
    await bot.handle(message('/presets', topic!.threadId));
    expect(JSON.stringify(telegram.sent.at(-1)!.card)).not.toContain(secret);
    await bot.handle(message(`/preset parts ${preset.id}`, topic!.threadId));
    expect(JSON.stringify(telegram.sent.at(-1)!.card)).not.toContain(secret);
    f.store.setSetting('telegram.selectedSession:7:-10042:0', null);
    await bot.handle(message('/presets'));
    expect(JSON.stringify(telegram.sent.at(-1)!.card)).not.toContain(secret);
  } finally {
    await bot.stop();
    await f.close();
  }
});

it('pages through every task and preset without requiring a known name', async () => {
  const f = daddyFixture(),
    telegram = apiFixture(),
    bot = new TelegramWorkspace(f.daddy, telegram.api, 'fixture_bot', () => 'en');
  f.store.setSetting('telegram.pairing', { chatId: 7, userId: 7 });
  const group = f.daddy.create({ workspaceId: f.workspace.id });
  f.store.setSetting('telegram.currentDaddy', group.id);
  for (let index = 1; index <= 31; index++)
    await f.tickets.local({
      workspace: f.workspace,
      groupId: group.id,
      groupGeneration: group.generation,
      title: `Paged task ${index}`,
      requirements: `Task ${index}`,
      createdByAction: `task-${index}`,
    });
  const library = new InstructionPresets(f.store);
  for (let index = 1; index <= 21; index++)
    library.save({
      name: `Paged preset ${index}`,
      instructions: { daddy: { prompt: `Prompt ${index}` }, worker: {} },
    });
  let id = 600;
  const message = (text: string): Update => ({
    update_id: id++,
    message: {
      message_id: id,
      text,
      from: { id: 7 },
      chat: { id: 7, type: 'private' },
    },
  });
  const click = (data: string): Update => ({
    update_id: id++,
    callback_query: {
      id: String(id),
      data,
      from: { id: 7 },
      message: { chat: { id: 7, type: 'private' } },
    },
  });
  const button = (text: string) =>
    telegram.sent
      .at(-1)!
      .card.buttons.flat()
      .find((item: any) => item.text.includes(text));
  try {
    await bot.handle(message('/tasks'));
    await bot.handle(click(button('→').callback_data));
    await bot.handle(click(button('Paged task 1').callback_data));
    expect(telegram.sent.at(-1)!.card.text).toContain('Paged task 1');

    await bot.handle(message('/presets'));
    await bot.handle(click(button('→').callback_data));
    await bot.handle(click(button('→').callback_data));
    await bot.handle(click(button('Paged preset 21').callback_data));
    expect(f.daddy.group(group.id).instructions?.presets?.[0].preset.name).toBe('Paged preset 21');
  } finally {
    await bot.stop();
    await f.close();
  }
});

it('cleans expired task and preset button records during normal list browsing', async () => {
  const f = daddyFixture(),
    telegram = apiFixture(),
    bot = new TelegramWorkspace(f.daddy, telegram.api, 'fixture_bot', () => 'en');
  f.store.setSetting('telegram.pairing', { chatId: 7, userId: 7 });
  const group = f.daddy.create({ workspaceId: f.workspace.id });
  f.store.setSetting('telegram.currentDaddy', group.id);
  await f.tickets.local({
    workspace: f.workspace,
    groupId: group.id,
    groupGeneration: group.generation,
    title: 'Control task',
    requirements: 'Control task',
    createdByAction: 'control-task',
  });
  new InstructionPresets(f.store).save({
    name: 'Control preset',
    instructions: { daddy: { prompt: 'Control prompt' }, worker: {} },
  });
  let id = 690;
  const message = (text: string): Update => ({
    update_id: id++,
    message: {
      message_id: id,
      text,
      from: { id: 7 },
      chat: { id: 7, type: 'private' },
    },
  });
  try {
    for (let index = 0; index < 10; index++) {
      await bot.handle(message('/tasks'));
      await bot.handle(message('/presets'));
    }
    expect(f.store.db.prepare('SELECT count(*) AS count FROM bot_actions').get()!.count).toBe(20);
    f.store.db
      .prepare("UPDATE bot_actions SET data=json_set(data,'$.expiresAt',?)")
      .run('2000-01-01T00:00:00.000Z');
    await bot.handle(message('/tasks'));
    await bot.handle(message('/presets'));
    expect(f.store.db.prepare('SELECT count(*) AS count FROM bot_actions').get()!.count).toBe(2);
  } finally {
    await bot.stop();
    await f.close();
  }
});

it('keeps preset pages bound to their session while allowing global browsing', async () => {
  const f = daddyFixture(),
    telegram = apiFixture(),
    bot = new TelegramWorkspace(f.daddy, telegram.api, 'fixture_bot', () => 'en');
  f.store.setSetting('telegram.pairing', { chatId: 7, userId: 7 });
  const first = f.daddy.create({ workspaceId: f.workspace.id, title: 'Preset A' }),
    second = f.daddy.create({ workspaceId: f.workspace.id, title: 'Preset B' });
  const library = new InstructionPresets(f.store);
  for (let index = 1; index <= 21; index++)
    library.save({
      name: `Global preset ${index}`,
      description: `Description ${index}`,
      instructions: { daddy: { prompt: `Global ${index}` }, worker: {} },
    });
  let id = 700;
  const message = (text: string): Update => ({
    update_id: id++,
    message: {
      message_id: id,
      text,
      from: { id: 7 },
      chat: { id: 7, type: 'private' },
    },
  });
  const click = (data: string): Update => ({
    update_id: id++,
    callback_query: {
      id: String(id),
      data,
      from: { id: 7 },
      message: { chat: { id: 7, type: 'private' } },
    },
  });
  const buttons = () => telegram.sent.at(-1)!.card.buttons.flat();
  try {
    f.store.setSetting('telegram.currentDaddy', null);
    await bot.handle(message('/presets'));
    expect(telegram.sent.at(-1)!.card.text).toContain('Global preset 1');
    expect(telegram.sent.at(-1)!.card.text).toContain('Description 1');
    await bot.handle(click(buttons().find((button: any) => button.text === '→').callback_data));
    await bot.handle(click(buttons().find((button: any) => button.text === '→').callback_data));
    expect(telegram.sent.at(-1)!.card.text).toContain('Global preset 21');
    expect(telegram.sent.at(-1)!.card.text).toContain('Description 21');

    await bot.handle(message(`/session ${first.id.slice(0, 8)}`));
    await bot.handle(message('/presets'));
    expect(telegram.sent.at(-1)!.card.text).toContain('Description 1');
    const oldSelect = buttons().find(
      (button: any) => button.text === 'Global preset 1',
    ).callback_data;
    const oldNext = buttons().find((button: any) => button.text === '→').callback_data;
    await bot.handle(message(`/session ${second.id.slice(0, 8)}`));
    await bot.handle(click(oldSelect));
    expect(telegram.sent.at(-1)!.card.text).toContain('selected session changed');
    await bot.handle(click(oldNext));
    expect(telegram.sent.at(-1)!.card.text).toContain('selected session changed');
    expect(f.daddy.group(first.id).instructions?.presets).toBeUndefined();
    expect(f.daddy.group(second.id).instructions?.presets).toBeUndefined();

    await bot.handle(message('/presets'));
    await bot.handle(
      click(buttons().find((button: any) => button.text === 'Global preset 1').callback_data),
    );
    expect(f.daddy.group(second.id).instructions?.presets?.[0].preset.name).toBe('Global preset 1');
  } finally {
    await bot.stop();
    await f.close();
  }
});
