import { expect, it, vi } from 'vitest';
import { InstructionPresets } from '../src/core/instruction-presets.js';
import { TelegramWorkspace } from '../src/integrations/telegram-workspace.js';
import type { TelegramApi, Update } from '../src/integrations/telegram.js';
import { daddyFixture } from './daddy-fixture.js';

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
  const api = {
    replaceCard: async (_callback: unknown, action: () => Promise<unknown>) => action(),
    send,
    call: vi.fn(async (method: string) =>
      method === 'createForumTopic' ? { message_thread_id: 51 } : true,
    ),
    downloadDocument: vi.fn(async () => document),
    sendDocument,
  } as unknown as TelegramApi;
  return {
    api,
    sent,
    send,
    sendDocument,
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

    telegram.document('# Phone skill\n\nKeep reports short.');
    await bot.handle(message('/skill worker file'));
    await bot.handle(file('phone-skill.md'));
    expect(f.daddy.group(group.id).instructions?.worker.skills?.[0]).toMatchObject({
      name: 'phone-skill.md',
      source: { kind: 'file' },
    });

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
    const remove = telegram.sent.at(-1)!.card.buttons[0][0].callback_data;
    await bot.handle(click(remove));
    expect(library.list()).toHaveLength(0);
    expect(f.daddy.group(group.id).instructions?.presets?.[0].preset.name).toBe('Mobile style');
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
  const preset = new InstructionPresets(f.store).save({
    name: 'Private preset',
    instructions: {
      daddy: { prompt: 'PRIVATE_PRESET_PROMPT' },
      worker: {},
    },
  });
  await f.daddy.settings(group.id, {
    instructions: {
      daddy: {},
      worker: {},
      presets: [{ preset, enabled: true, omit: [] }],
    },
  });
  const topic = await bot.ensureTopic(group);
  let id = 180;
  const message = (text: string): Update => ({
    update_id: id++,
    message: {
      message_id: id,
      text,
      from: { id: 7 },
      chat: { id: -10042, type: 'supergroup' },
      message_thread_id: topic!.threadId,
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
  task.pr!.checkDetails = [
    { name: 'Unit tests', status: 'failed', url: 'https://ci.example.test/run/7' },
  ];
  f.store.saveTask(task);
  f.store.setSetting('telegram.currentDaddy', group.id);
  try {
    await bot.handle({
      update_id: 500,
      message: {
        message_id: 501,
        text: `/task ${task.id.slice(0, 8)}`,
        from: { id: 7 },
        chat: { id: 7, type: 'private' },
      },
    });
    expect(telegram.sent.at(-1)!.card.text).toContain('Unit tests: failed');
    expect(telegram.sent.at(-1)!.card.buttons.flat()).toContainEqual({
      text: 'CI · Unit tests',
      url: 'https://ci.example.test/run/7',
    });
  } finally {
    await bot.stop();
    await f.close();
  }
});
