import { afterEach, expect, it, vi } from 'vitest';
import { daddyFixture } from './daddy-fixture.js';
import { Telegram, TelegramApi, type Update } from '../src/integrations/telegram.js';
import { TelegramWorkspace } from '../src/integrations/telegram-workspace.js';
import { UpdateMonitor } from '../src/core/updates.js';
import { catalogue } from './planning-fixture.js';
import { InstructionPresets } from '../src/core/instruction-presets.js';
import { effectiveInstructions } from '../src/core/instructions.js';
afterEach(() => vi.restoreAllMocks());
it('changes only the selected session role from a private chat or topic and ignores other senders', async () => {
  const f = daddyFixture();
  let topic = 30;
  const api = {
    replaceCard: async (_callback: unknown, action: () => Promise<unknown>) => action(),
    send: vi.fn(async () => ({ message_id: 1 })),
    call: vi.fn(async () => ({ message_thread_id: ++topic })),
  } as unknown as TelegramApi;
  const workspace = new TelegramWorkspace(f.daddy, api, 'fixture_bot', () => 'ru');
  const first = f.daddy.create({ workspaceId: f.workspace.id }),
    second = f.daddy.create({ workspaceId: f.workspace.id });
  f.store.setSetting('telegram.pairing', { chatId: 7, userId: 7 });
  f.store.setSetting('telegram.currentDaddy', first.id);
  let updateId = 700;
  const message = (text: string, user = 7, chat = 7, thread?: number): Update => ({
    update_id: updateId++,
    message: {
      message_id: updateId,
      text,
      from: { id: user },
      chat: { id: chat, type: chat === 7 ? 'private' : 'supergroup' },
      message_thread_id: thread,
    },
  });
  try {
    await workspace.handle(message('/instructions daddy Answer briefly.'));
    await workspace.handle(message('/instructions worker Check edge cases.'));
    await workspace.handle(message('/instructions daddy Changed by another user', 99));
    expect(f.daddy.group(first.id).instructions).toEqual({
      daddy: { prompt: 'Answer briefly.' },
      worker: { prompt: 'Check edge cases.' },
    });
    expect(f.daddy.group(second.id).instructions).toBeUndefined();
    expect(f.store.messages(first.id)).toHaveLength(0);
    f.store.setSetting('telegram.group', { chatId: -10042, title: 'Room', ownerId: 7 });
    const destination = await workspace.ensureTopic(second);
    await workspace.handle(
      message('/instructions worker Keep reports precise.', 7, -10042, destination!.threadId),
    );
    expect(f.daddy.group(second.id).instructions?.worker.prompt).toBe('Keep reports precise.');
    expect(f.daddy.group(first.id).instructions?.worker.prompt).toBe('Check edge cases.');
    await workspace.handle(
      message('/instructions worker --clear', 7, -10042, destination!.threadId),
    );
    expect(f.daddy.group(second.id).instructions?.worker).toEqual({});
    new InstructionPresets(f.store).save({
      name: 'Shared style',
      instructions: {
        daddy: { prompt: 'Preset daddy style' },
        worker: { prompt: 'Preset worker style' },
      },
    });
    await workspace.handle(message('/preset Shared style', 99, -10042, destination!.threadId));
    expect(f.daddy.group(second.id).instructions?.presets).toBeUndefined();
    await workspace.handle(message('/preset Shared style', 7, -10042, destination!.threadId));
    expect(effectiveInstructions(f.daddy.group(second.id).instructions, 'worker')?.prompt).toBe(
      'Preset worker style',
    );
    expect(f.daddy.group(first.id).instructions?.presets).toBeUndefined();
    await workspace.handle(
      message('/instructions worker --clear', 7, -10042, destination!.threadId),
    );
    expect(effectiveInstructions(f.daddy.group(second.id).instructions, 'worker')).toEqual({});
    expect(effectiveInstructions(f.daddy.group(second.id).instructions, 'daddy')?.prompt).toBe(
      'Preset daddy style',
    );
  } finally {
    await workspace.stop();
    await f.close();
  }
});
it('binds a forum selected by the paired owner, creates one topic per session and routes only that owner’s messages to daddy', async () => {
  const f = daddyFixture(),
    sent: { method: string; body: Record<string, any> }[] = [];
  const api = new TelegramApi('123456:abcdefghijklmnopqrstuvwxyz123456', async (url, options) => {
    const method = String(url).split('/').at(-1)!,
      body = JSON.parse(String(options?.body));
    if (method === 'getUpdates')
      return new Promise((_resolve, reject) =>
        options?.signal?.addEventListener('abort', () => reject(new Error('stop')), { once: true }),
      );
    sent.push({ method, body });
    const result =
      method === 'getChat'
        ? { type: 'supergroup', is_forum: true, title: 'My workspace' }
        : method === 'getChatMember'
          ? body.user_id === 7
            ? { status: 'creator' }
            : { status: 'administrator', can_manage_topics: true }
          : method === 'createForumTopic'
            ? { message_thread_id: 17 }
            : { message_id: sent.length };
    return new Response(JSON.stringify({ ok: true, result }));
  });
  const bot = new Telegram(f.engine, api, 'fixture_bot'),
    updates = new UpdateMonitor(f.store, { agents: [] });
  bot.configure({ daddy: f.daddy, catalogue, updates });
  f.store.setSetting('telegram.botId', 101);
  let id = 1;
  const message = (text: string, chat = 7, user = 7, thread?: number): Update => ({
    update_id: id++,
    message: {
      message_id: id,
      text,
      chat: { id: chat, type: chat === 7 ? 'private' : 'supergroup' },
      from: { id: user },
      message_thread_id: thread,
    },
  });
  const click = (data: string, chat = 7, user = 7, thread?: number): Update => ({
    update_id: id++,
    callback_query: {
      id: String(id),
      data,
      from: { id: user },
      message: {
        chat: { id: chat, type: chat === 7 ? 'private' : 'supergroup' },
        message_thread_id: thread,
      },
    },
  });
  try {
    await bot.handle(message('/start ' + new URL(bot.pair().url).searchParams.get('start')));
    bot.start();
    f.daddy.start();
    await bot.handle(message('/group'));
    const request = sent.find((item) => item.body.reply_markup?.keyboard)?.body.reply_markup
      .keyboard[0][0].request_chat;
    expect(request).toMatchObject({
      chat_is_forum: true,
      bot_administrator_rights: { can_manage_topics: true },
    });
    await bot.handle({
      update_id: id++,
      message: {
        chat: { id: 7, type: 'private' },
        from: { id: 99 },
        chat_shared: { request_id: request.request_id, chat_id: -10042 },
      },
    });
    expect(f.store.setting('telegram.group')).toBeUndefined();
    await bot.handle({
      update_id: id++,
      message: {
        chat: { id: 7, type: 'private' },
        from: { id: 7 },
        chat_shared: { request_id: request.request_id, chat_id: -10042 },
      },
    });
    expect(f.store.setting('telegram.group')).toMatchObject({ chatId: -10042, ownerId: 7 });
    await bot.handle(message('/new'));
    await bot.handle(click(`dad:new:${f.workspace.id}`));
    const start = sent.at(-1)!.body.reply_markup.inline_keyboard[0][0].callback_data;
    await bot.handle(click(start));
    const group = f.daddy.sessions()[0];
    await vi.waitFor(() =>
      expect(sent.filter((item) => item.method === 'createForumTopic')).toHaveLength(1),
    );
    await bot.handle(click(`dad:new:${f.workspace.id}`));
    expect(f.daddy.sessions()).toHaveLength(1);
    await bot.handle(message('Not the owner', -10042, 99, 17));
    expect(f.store.messages(group.id)).toHaveLength(0);
    await bot.handle(message('Wrong topic', -10042, 7, 18));
    expect(f.store.messages(group.id)).toHaveLength(0);
    await bot.handle(message('Build the feature', -10042, 7, 17));
    f.daddy.tick();
    await vi.waitFor(() =>
      expect(f.store.messages(group.id).some((message) => message.sender === 'agent')).toBe(true),
    );
    await vi.waitFor(() =>
      expect(
        sent.some(
          (item) => item.body.message_thread_id === 17 && String(item.body.text).includes('Ready.'),
        ),
      ).toBe(true),
    );
    await bot.handle(click(`dad:pool:${group.id}:3`, -10042, 7, 17));
    expect(f.daddy.group(group.id).requestedWorkerLimit).toBe(3);
    await bot.handle(click(`dad:pool:${group.id}:8`, -10042, 99, 17));
    expect(f.daddy.group(group.id).requestedWorkerLimit).toBe(3);
    expect(sent.filter((item) => item.method === 'createForumTopic')).toHaveLength(1);
    const task = await f.tickets.local({
      workspace: f.workspace,
      groupId: group.id,
      groupGeneration: group.generation,
      title: 'Private worker',
      requirements: 'Work',
      createdByAction: 'fixture',
    });
    const baseline = sent.length;
    f.store.message(task.id, 'author', 'agent', 'Do not forward this raw report');
    await new Promise((resolve) => setImmediate(resolve));
    expect(sent.slice(baseline).some((item) => String(item.body.text).includes('raw report'))).toBe(
      false,
    );
  } finally {
    await f.daddy.stop();
    await bot.stop();
    await updates.stop();
    await f.close();
  }
});
it('does not recreate a topic after a lost response and lets the owner attach the existing topic', async () => {
  const f = daddyFixture();
  f.store.setSetting('telegram.pairing', { chatId: 7, userId: 7 });
  f.store.setSetting('telegram.group', { chatId: -10042, title: 'Work', ownerId: 7 });
  let calls = 0;
  const api = new TelegramApi('123456:abcdefghijklmnopqrstuvwxyz123456', async (url) => {
    if (String(url).endsWith('/createForumTopic')) {
      calls++;
      throw new Error('response lost after creation');
    }
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
  });
  const workspace = new TelegramWorkspace(f.daddy, api, 'fixture_bot', () => 'en');
  try {
    const group = f.daddy.create({ workspaceId: f.workspace.id });
    await expect(workspace.ensureTopic(group)).rejects.toThrow();
    await expect(workspace.ensureTopic(group)).rejects.toThrow('/attach');
    expect(calls).toBe(1);
    await workspace.handle({
      update_id: 1,
      message: {
        text: '/attach ' + group.id,
        chat: { id: -10042, type: 'supergroup' },
        from: { id: 7 },
        message_thread_id: 51,
      },
    });
    expect(await workspace.ensureTopic(group)).toMatchObject({ threadId: 51, groupId: group.id });
    expect(calls).toBe(1);
  } finally {
    await workspace.stop();
    await f.close();
  }
});
it('scopes a one-message repository selection to its owner and conversation, then restores defaults', async () => {
  const f = daddyFixture();
  const sent: any[] = [];
  const api = {
    replaceCard: async (_callback: unknown, action: () => Promise<unknown>) => action(),
    send: vi.fn(async (_destination, card) => {
      sent.push(card);
      return { message_id: sent.length };
    }),
    call: vi.fn(async () => ({})),
  } as unknown as TelegramApi;
  const workspace = new TelegramWorkspace(f.daddy, api, 'fixture_bot', () => 'ru');
  f.store.setSetting('telegram.pairing', { chatId: 7, userId: 7 });
  const group = f.daddy.create({ workspaceId: f.workspace.id });
  f.store.setSetting('telegram.currentDaddy', group.id);
  vi.spyOn(f.workspaces, 'selection').mockImplementation(async (workspace, input) => ({
    ...workspace,
    repoPath: input?.path ?? workspace.repoPath,
  }));
  let id = 100;
  const message = (text: string, userId = 7): Update => ({
    update_id: id++,
    message: { message_id: id, chat: { id: 7, type: 'private' }, from: { id: userId }, text },
  });
  const click = (data: string, userId = 7): Update => ({
    update_id: id++,
    callback_query: {
      id: String(id),
      data,
      from: { id: userId },
      message: { chat: { id: 7, type: 'private' } },
    },
  });
  try {
    await workspace.handle(message('/repo /server/another-repository'));
    const use = sent.at(-1).buttons[0][0].callback_data;
    await workspace.handle(click(use, 99));
    expect(f.workspaces.selection).not.toHaveBeenCalled();
    await workspace.handle(click(use));
    expect(sent.at(-1).text).toContain('/server/another-repository');
    const first = message('Ticket one');
    await workspace.handle(first);
    await workspace.handle(first); // Retried update must not consume defaults or duplicate the task.
    await workspace.handle(message('Ticket two'));
    expect(f.store.messages(group.id).map((message) => message.workspace?.repoPath)).toEqual([
      '/server/another-repository',
      f.workspace.repoPath,
    ]);
    expect(f.workspaces.get(f.workspace.id)).toEqual(f.workspace);
  } finally {
    await workspace.stop();
    await f.close();
  }
});
it('shows shared limits and only the paired owner can confirm consuming a reset', async () => {
  const f = daddyFixture(),
    sent: any[] = [];
  const api = {
    replaceCard: async (_callback: unknown, action: () => Promise<unknown>) => action(),
    send: vi.fn(async (_destination, card) => {
      sent.push(card);
      return { message_id: sent.length };
    }),
    call: vi.fn(async () => ({})),
  } as unknown as TelegramApi;
  const view = {
    agents: [
      {
        engine: 'codex',
        name: 'Codex',
        source: 'codex-app-server:account/rateLimits/read' as const,
        available: true,
        stale: false,
        buckets: [
          {
            id: 'codex',
            name: 'Codex',
            windows: [{ remainingPercent: 19, durationMinutes: 10080 }],
          },
        ],
        resets: { availableCount: 3, canUse: true, credits: [] },
      },
    ],
  };
  const id = '852c8b38-1a61-438c-a250-88098c430d5d';
  const plan = {
    id,
    availableCount: 3,
    title: 'Full reset',
    expiresAt: '2099-01-01T00:00:00Z',
    status: 'ready' as const,
  };
  const usage = {
    read: vi.fn(async () => view),
    prepare: vi.fn(async () => plan),
    consume: vi.fn(async () => ({
      plan: { ...plan, status: 'done' as const, outcome: 'reset' as const },
      usage: view,
    })),
  };
  const workspace = new TelegramWorkspace(f.daddy, api, 'fixture_bot', () => 'ru', usage);
  f.store.setSetting('telegram.pairing', { chatId: 7, userId: 7 });
  const click = (data: string, userId = 7): Update => ({
    update_id: 1,
    callback_query: {
      id: '1',
      data,
      from: { id: userId },
      message: { chat: { id: 7, type: 'private' } },
    },
  });
  try {
    await workspace.handle(click('dad:limits'));
    expect(sent.at(-1).text).toContain('осталось 19%');
    await workspace.handle(click('dad:limits:prepare'));
    expect(usage.consume).not.toHaveBeenCalled();
    const confirm = sent.at(-1).buttons[0][0].callback_data;
    await workspace.handle(click(confirm, 99));
    expect(usage.consume).not.toHaveBeenCalled();
    await workspace.handle(click(confirm));
    expect(usage.consume).toHaveBeenCalledWith(id, 'telegram:7:7:0');
    expect(sent.at(-1).text).toContain('Использован один сброс');
  } finally {
    await workspace.stop();
    await f.close();
  }
});
it('creates a session from a group topic and isolates its wizard from another topic', async () => {
  const f = daddyFixture(),
    sent: { destination: any; card: any }[] = [];
  let thread = 20;
  const api = {
    replaceCard: async (_callback: unknown, action: () => Promise<unknown>) => action(),
    send: vi.fn(async (destination, card) => {
      sent.push({ destination, card });
      return { message_id: sent.length };
    }),
    call: vi.fn(async (method) =>
      method === 'createForumTopic' ? { message_thread_id: thread++ } : {},
    ),
  } as unknown as TelegramApi;
  const workspace = new TelegramWorkspace(f.daddy, api, 'fixture_bot', () => 'en');
  f.store.setSetting('telegram.pairing', { chatId: 7, userId: 7 });
  f.store.setSetting('telegram.group', { chatId: -10042, title: 'Room', ownerId: 7 });
  const root = f.daddy.create({ workspaceId: f.workspace.id }),
    peer = f.daddy.create({ workspaceId: f.workspace.id });
  const a = await workspace.ensureTopic(root),
    b = await workspace.ensureTopic(peer);
  let id = 1000;
  const message = (text: string, tid: number): Update => ({
    update_id: id++,
    message: {
      message_id: id,
      text,
      chat: { id: -10042, type: 'supergroup' },
      from: { id: 7 },
      message_thread_id: tid,
    },
  });
  const click = (data: string, tid: number): Update => ({
    update_id: id++,
    callback_query: {
      id: String(id),
      data,
      from: { id: 7 },
      message: { chat: { id: -10042, type: 'supergroup' }, message_thread_id: tid },
    },
  });
  try {
    await workspace.handle(message('/workspaces', a!.threadId));
    await workspace.handle(message('This is still the original conversation', a!.threadId));
    expect(f.store.messages(root.id).at(-1)?.text).toBe('This is still the original conversation');
    await workspace.handle(message('/new Separate feature', a!.threadId));
    await workspace.handle(message('Keep this in the original peer session', b!.threadId));
    expect(f.store.messages(peer.id)[0].text).toBe('Keep this in the original peer session');
    await workspace.handle(click(`dad:new:${f.workspace.id}`, a!.threadId));
    const use = sent.at(-1)!.card.buttons[0][0].callback_data;
    await workspace.handle(click(use, b!.threadId));
    expect(f.daddy.sessions()).toHaveLength(2);
    await workspace.handle(click(use, a!.threadId));
    const created = f.daddy
      .sessions()
      .find((group) => group.id !== root.id && group.id !== peer.id)!;
    expect(created.title).toBe('Separate feature');
    expect(f.store.messages(created.id)[0].text).toBe('Separate feature');
    expect(sent.at(-1)!.destination.threadId).toBe(a!.threadId);
    expect(sent.at(-1)!.card.buttons[0][0].url).toContain('/22');
    await workspace.handle(message('Old topic still belongs to the old daddy', a!.threadId));
    expect(f.store.messages(root.id).at(-1)?.text).toBe('Old topic still belongs to the old daddy');
  } finally {
    await workspace.stop();
    await f.close();
  }
});

it('registers a named remote workspace from Telegram with owner, topic and cancellation checks', async () => {
  const f = daddyFixture(),
    sent: any[] = [];
  const api = {
    replaceCard: async (_callback: unknown, action: () => Promise<unknown>) => action(),
    send: vi.fn(async (_destination, card) => {
      sent.push(card);
      return { message_id: sent.length };
    }),
    call: vi.fn(async () => ({})),
  } as unknown as TelegramApi;
  const bot = new TelegramWorkspace(f.daddy, api, 'fixture_bot', () => 'en');
  f.store.setSetting('telegram.pairing', { chatId: 7, userId: 7 });
  f.store.setSetting('telegram.group', { chatId: -10042, ownerId: 7, title: 'Tasks' });
  let id = 900;
  const message = (text: string, user = 7, thread?: number): Update => ({
    update_id: id++,
    message: {
      message_id: id,
      text,
      from: { id: user },
      chat: { id: thread ? -10042 : 7, type: thread ? 'supergroup' : 'private' },
      message_thread_id: thread,
    },
  });
  const click = (data: string, user = 7, thread?: number): Update => ({
    update_id: id++,
    callback_query: {
      id: String(id),
      data,
      from: { id: user },
      message: {
        chat: { id: thread ? -10042 : 7, type: thread ? 'supergroup' : 'private' },
        message_thread_id: thread,
      },
    },
  });
  try {
    await bot.handle(click('dad:add-workspace'));
    expect(
      sent
        .at(-1)
        .buttons.flat()
        .some((button: any) => button.callback_data === 'dad:workspace-module:gitlab'),
    ).toBe(true);
    await bot.handle(click('dad:workspace-module:gitlab', 7, 12));
    await bot.handle(message('https://code.example.test/team/sub/app', 99, 12));
    await bot.handle(message('https://code.example.test/team/sub/app', 7, 12));
    expect(sent.at(-1).text).toContain('Workspace name');
    await bot.handle(message('Company', 7, 13));
    expect(f.workspaces.list().some((workspace) => workspace.name === 'Company')).toBe(false);
    await bot.handle(message('Company', 7, 12));
    expect(f.workspaces.list().find((workspace) => workspace.name === 'Company')).toMatchObject({
      provider: 'gitlab',
      repoPath: 'https://code.example.test/team/sub/app.git',
      copyMode: 'session',
    });
    await bot.handle(click('dad:workspace-module:github'));
    await bot.handle(message('/cancel'));
    expect(f.store.setting('telegram.addWorkspace:7:7:0')).toBeNull();
  } finally {
    await bot.stop();
    await f.close();
  }
});

it('mirrors a CLI-created session and live assistant messages to one topic without tool logs or Telegram echoes', async () => {
  const f = daddyFixture();
  const sent: { destination: any; card: any }[] = [];
  const api = {
    replaceCard: async (_callback: unknown, action: () => Promise<unknown>) => action(),
    send: vi.fn(async (destination, card) => {
      sent.push({ destination, card });
      return { message_id: sent.length };
    }),
    call: vi.fn(async () => ({ message_thread_id: 31 })),
  } as unknown as TelegramApi;
  const bot = new TelegramWorkspace(f.daddy, api, 'fixture_bot', () => 'en');
  f.store.setSetting('telegram.pairing', { chatId: 7, userId: 7 });
  f.store.setSetting('telegram.group', { chatId: -10042, ownerId: 7, title: 'Tasks' });
  f.store.setSetting('notifications.telegram', { enabled: false, mode: 'attention' });
  const listener = (event: any) => bot.onEvent(event);
  f.store.changes.on('event', listener);
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  f.runtime.runSession.mockImplementation(async (input) => {
    input.onEvent('runtime.item', {
      type: 'commandExecution',
      aggregatedOutput: 'PRIVATE SHELL OUTPUT',
    });
    input.onEvent('runtime.text', { delta: 'RAW PROTOCOL' });
    input.onEvent('tool.completed', { result: 'PRIVATE TOOL RESULT' });
    input.onAssistantMessage?.({ id: 'progress-1', text: 'Checking the code now.' });
    input.onAssistantMessage?.({ id: 'progress-1', text: 'Checking the code now.' });
    await gate;
    return { status: 'completed', summary: 'The fix is ready.', checkedHead: '' };
  });
  try {
    const group = f.daddy.create({ workspaceId: f.workspace.id, title: 'Started from CLI' });
    f.daddy.chat(group.id, 'Question from CLI');
    f.daddy.tick();
    await vi.waitFor(() =>
      expect(sent.some((item) => item.card.text?.includes('Checking the code now.'))).toBe(true),
    );
    expect(sent.filter((item) => item.card.text?.includes('Question from CLI'))).toHaveLength(1);
    expect(sent.find((item) => item.card.text?.includes('Question from CLI'))).toMatchObject({
      destination: { chatId: -10042, threadId: 31 },
      card: { text: expect.stringContaining('[user]') },
    });
    expect(f.store.daddyJobs(group.id).some((job) => job.status === 'running')).toBe(true);
    expect(sent.filter((item) => item.card.text?.includes('Checking the code now.'))).toHaveLength(
      1,
    );
    await bot.handle({
      update_id: 1000,
      message: {
        message_id: 1001,
        from: { id: 7 },
        chat: { id: -10042, type: 'supergroup' },
        message_thread_id: 31,
        text: 'Question from the phone',
      },
    });
    await vi.waitFor(() =>
      expect(
        f.store.messages(group.id).some((message) => message.text === 'Question from the phone'),
      ).toBe(true),
    );
    finish();
    await vi.waitFor(() =>
      expect(sent.some((item) => item.card.text?.includes('The fix is ready.'))).toBe(true),
    );
    expect(sent.filter((item) => item.card.text?.includes('Question from the phone'))).toHaveLength(
      0,
    );
    expect(sent.some((item) => /PRIVATE|RAW PROTOCOL/.test(item.card.text ?? ''))).toBe(false);
    f.store.daddyMessage(group.id, 'system', 'PRIVATE ERROR STACK');
    const count = sent.length;
    bot.replay();
    await new Promise((resolve) => setImmediate(resolve));
    expect(sent).toHaveLength(count);
    expect(api.call).toHaveBeenCalledTimes(1);
    expect(f.daddy.board(group.id).messages.map((message) => message.text)).toContain(
      'Question from the phone',
    );
  } finally {
    finish();
    f.store.changes.off('event', listener);
    await bot.stop();
    await f.close();
  }
});

it('creates a task-named topic from /new, renames that topic and adds tasks without opening repository modules', async () => {
  const f = daddyFixture();
  const sent: any[] = [],
    native: { method: string; body: any }[] = [];
  const api = {
    replaceCard: async (_callback: unknown, action: () => Promise<unknown>) => action(),
    send: vi.fn(async (_destination, card) => {
      sent.push(card);
      return { message_id: sent.length };
    }),
    call: vi.fn(async (method: string, body: any) => {
      native.push({ method, body });
      return { message_thread_id: 44 };
    }),
  } as unknown as TelegramApi;
  const bot = new TelegramWorkspace(f.daddy, api, 'fixture_bot', () => 'en');
  f.store.setSetting('telegram.pairing', { chatId: 7, userId: 7 });
  f.store.setSetting('telegram.group', { chatId: -10042, ownerId: 7, title: 'Tasks' });
  const listener = (event: any) => bot.onEvent(event);
  f.store.changes.on('event', listener);
  let id = 1100;
  const message = (text: string, user = 7): Update => ({
    update_id: id++,
    message: {
      text,
      message_id: id,
      from: { id: user },
      chat: { id: -10042, type: 'supergroup' },
      message_thread_id: 44,
    },
  });
  const click = (data: string, user = 7): Update => ({
    update_id: id++,
    callback_query: {
      id: String(id),
      data,
      from: { id: user },
      message: { chat: { id: -10042, type: 'supergroup' }, message_thread_id: 44 },
    },
  });
  try {
    await bot.handle(message('/new Fix the search timeout'));
    await bot.handle(click(`dad:new:${f.workspace.id}`));
    const start = sent.at(-1).buttons[0][0].callback_data;
    await bot.handle(click(start));
    const group = f.daddy.sessions()[0];
    expect(group.title).toBe('Fix the search timeout');
    expect(native.find((call) => call.method === 'createForumTopic')?.body.name).toBe(group.title);
    expect(f.store.messages(group.id)[0].text).toBe('Fix the search timeout');
    await bot.handle(message('/rename Release search'));
    await vi.waitFor(() =>
      expect(
        native.some(
          (call) =>
            call.method === 'editForumTopic' &&
            call.body.name === 'Release search' &&
            call.body.message_thread_id === 44,
        ),
      ).toBe(true),
    );
    expect(f.daddy.group(group.id).generation).toBe(group.generation);
    await bot.handle(message('/rename Wrong owner', 99));
    expect(f.daddy.group(group.id).title).toBe('Release search');
    await bot.handle(click(`dad:add:${group.id}`));
    expect(typeof sent.at(-1) === 'string' ? sent.at(-1) : sent.at(-1).text).toContain(
      'More work for daddy',
    );
    expect(f.daddy.sessions()).toHaveLength(1);
    expect(native.filter((call) => call.method === 'createForumTopic')).toHaveLength(1);
    expect(sent.some((card) => card.text?.includes('Choose an enabled repository service'))).toBe(
      false,
    );
  } finally {
    f.store.changes.off('event', listener);
    await bot.stop();
    await f.close();
  }
});

it('keeps Arc copy modes behind an explained settings screen (issue 19, item 12)', async () => {
  const f = daddyFixture(),
    sent: any[] = [];
  f.store.saveWorkspace({
    ...f.workspace,
    vcs: 'arcadia',
    provider: 'arcadia',
    copyMode: 'session',
  });
  const api = {
    replaceCard: async (_callback: unknown, action: () => Promise<unknown>) => action(),
    send: vi.fn(async (_destination, card) => {
      sent.push(card);
      return { message_id: 1 };
    }),
    call: vi.fn(async () => ({})),
  } as unknown as TelegramApi;
  const bot = new TelegramWorkspace(f.daddy, api, 'fixture_bot', () => 'en');
  f.store.setSetting('telegram.pairing', { chatId: 7, userId: 7 });
  let id = 1200;
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
    await bot.handle(click('dad:new'));
    await bot.handle(click(`dad:new:${f.workspace.id}`));
    const buttons = sent.at(-1).buttons.flat();
    expect(buttons.map((button: any) => button.text)).toEqual([
      'Start session',
      'Browse server folders',
      '⚙️ Working copy settings',
    ]);
    await bot.handle(click(buttons[2].callback_data));
    expect(sent.at(-1).text).toContain('an administrator must provide free Arcadia checkouts');
    expect(sent.at(-1).buttons[0][0].text).toContain('recommended');
    expect(f.daddy.sessions()).toHaveLength(0);
  } finally {
    await bot.stop();
    await f.close();
  }
});

it('retries topic creation after retry_after and delivers the saved conversation without another model turn', async () => {
  const f = daddyFixture(),
    sent: any[] = [];
  const calls: string[] = [];
  const api = {
    send: vi.fn(async (_destination, card) => {
      sent.push(card);
      return { message_id: sent.length };
    }),
    call: vi.fn(async (method: string) => {
      calls.push(method);
      if (method === 'createForumTopic' && calls.filter((name) => name === method).length === 1)
        throw Object.assign(new Error('Rate limited'), {
          name: 'AppError',
          code: 'telegram_error',
          retryAfter: 5,
        });
      return { message_thread_id: 61 };
    }),
  } as unknown as TelegramApi;
  const bot = new TelegramWorkspace(f.daddy, api, 'fixture_bot', () => 'en');
  f.store.setSetting('telegram.pairing', { chatId: 7, userId: 7 });
  f.store.setSetting('telegram.group', { chatId: -10042, ownerId: 7 });
  const group = f.daddy.create({
    workspaceId: f.workspace.id,
    message: 'Question saved while Telegram is down',
  });
  try {
    vi.useFakeTimers();
    // Use the real error class so a rejected create request can safely clear its native-write intent.
    const { AppError } = await import('../src/core/types.js');
    api.call = vi.fn(async (method: string) => {
      calls.push(method);
      if (method === 'createForumTopic' && calls.filter((name) => name === method).length === 1)
        throw Object.assign(new AppError('telegram_error', 'Rate limited'), { retryAfter: 5 });
      return { message_thread_id: 61 };
    }) as TelegramApi['call'];
    bot.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.filter((name) => name === 'createForumTopic')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(4999);
    expect(calls.filter((name) => name === 'createForumTopic')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1001);
    expect(calls.filter((name) => name === 'createForumTopic')).toHaveLength(2);
    expect(
      sent.some(
        (card) =>
          card.text?.startsWith('👤 [user]') &&
          card.text.includes('Question saved while Telegram is down'),
      ),
    ).toBe(true);
    expect(f.store.setting('telegram.error')).toBeNull();
    expect(f.daddy.group(group.id).title).toBe('Question saved while Telegram is down');
  } finally {
    await bot.stop();
    vi.useRealTimers();
    await f.close();
  }
});
