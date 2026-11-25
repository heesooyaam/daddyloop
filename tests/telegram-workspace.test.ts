import { reminderOpen } from '../src/integrations/telegram-reminders.js';
import { afterEach, expect, it, vi } from 'vitest';
import { daddyFixture } from './daddy-fixture.js';
import { Telegram, TelegramApi, type Update } from '../src/integrations/telegram.js';
import { TelegramWorkspace } from '../src/integrations/telegram-workspace.js';
import { UpdateMonitor } from '../src/core/updates.js';
import { catalogue } from './planning-fixture.js';
import { InstructionPresets } from '../src/core/instruction-presets.js';
import { effectiveInstructions } from '../src/core/instructions.js';
import { randomUUID } from 'node:crypto';
import { rememberSecret } from '../src/core/security.js';
afterEach(() => vi.restoreAllMocks());
it('changes only the selected session role from a private chat or topic and ignores other senders', async () => {
  const f = daddyFixture(),
    sent: any[] = [];
  let topic = 30;
  const api = {
    replaceCard: async (_callback: unknown, action: () => Promise<unknown>) => action(),
    send: vi.fn(async (_destination, card) => {
      sent.push(card);
      return { message_id: sent.length };
    }),
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
    const secret = rememberSecret('PRIVATE_PRESET_NAME_12345');
    new InstructionPresets(f.store).save({
      name: `Protected ${secret}`,
      instructions: { daddy: { prompt: 'Protected prompt' }, worker: {} },
    });
    await workspace.handle(
      message(`/preset Protected ${secret}`, 7, -10042, destination!.threadId),
    );
    expect(JSON.stringify(sent.at(-1))).not.toContain(secret);
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
    const start = sent.filter((item) => item.method === 'sendMessage').at(-1)!.body.reply_markup
      .inline_keyboard[0][0].callback_data;
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
    vi.mocked(f.workspaces.selection).mockClear();
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
it('keeps repository paths private for topic, general-group and new-session choices', async () => {
  const f = daddyFixture(),
    sent: { destination: any; card: any }[] = [];
  const api = {
    replaceCard: async (_callback: unknown, action: () => Promise<unknown>) => action(),
    send: vi.fn(async (destination, card) => {
      sent.push({ destination, card });
      return { message_id: sent.length };
    }),
    call: vi.fn(async (method: string) =>
      method === 'createForumTopic' ? { message_thread_id: 41 } : true,
    ),
  } as unknown as TelegramApi;
  const bot = new TelegramWorkspace(f.daddy, api, 'fixture_bot', () => 'en');
  f.store.setSetting('telegram.pairing', { chatId: 7, userId: 7 });
  f.store.setSetting('telegram.group', { chatId: -10042, title: 'Work', ownerId: 7 });
  const group = f.daddy.create({ workspaceId: f.workspace.id, title: 'Repository session' }),
    privateGroup = f.daddy.create({ workspaceId: f.workspace.id, title: 'Private session B' }),
    topic = await bot.ensureTopic(group);
  f.store.setSetting('telegram.currentDaddy', privateGroup.id);
  vi.spyOn(f.workspaces, 'selection').mockImplementation(async (workspace, input) => ({
    ...workspace,
    repoPath: input?.path ?? workspace.repoPath,
  }));
  let id = 180;
  const message = (text: string, chatId = -10042, threadId?: number): Update => ({
    update_id: id++,
    message: {
      message_id: id,
      text,
      from: { id: 7 },
      chat: { id: chatId, type: chatId === 7 ? 'private' : 'supergroup' },
      message_thread_id: threadId,
    },
  });
  const click = (data: string, chatId = -10042, threadId?: number): Update => ({
    update_id: id++,
    callback_query: {
      id: String(id),
      data,
      from: { id: 7 },
      message: {
        chat: { id: chatId, type: chatId === 7 ? 'private' : 'supergroup' },
        message_thread_id: threadId,
      },
    },
  });
  try {
    await bot.handle(message('/repo', -10042, topic!.threadId));
    const topicCard = sent.at(-1)!.card;
    expect(topicCard.text).toContain(f.workspace.name);
    expect(topicCard.text).not.toContain(f.workspace.repoPath);
    expect(topicCard.buttons[0][0].text).toBe('Use workspace defaults');
    const privateUrl = topicCard.buttons[1][0].url as string;

    const payload = new URL(privateUrl).searchParams.get('start');
    await bot.handle(message(`/start ${payload}`, 7));
    expect(sent.at(-1)!.destination).toEqual({ chatId: 7, threadId: undefined });
    expect(sent.at(-1)!.card.text).toContain(f.workspace.repoPath);
    expect(
      sent
        .at(-1)!
        .card.buttons.flat()
        .map((button: any) => button.text),
    ).toContain('Browse server folders');
    const browse = sent
      .at(-1)!
      .card.buttons.flat()
      .find((button: any) => button.text === 'Browse server folders').callback_data;
    await bot.handle(click(browse, 7));
    await bot.handle(message('/repo /server/topic-choice', 7));
    await bot.handle(click(sent.at(-1)!.card.buttons[0][0].callback_data, 7));
    expect(sent.at(-1)!.card.text).toContain('/task');
    expect(sent.at(-1)!.card.text).toContain(group.title);
    expect(sent.at(-1)!.card.buttons[0][0]).toMatchObject({
      text: 'Open session topic',
      url: expect.stringContaining(`/${topic!.threadId}`),
    });
    expect(
      f.store.setting<{ workspace: { repoPath: string } }>(
        `telegram.nextRepo:7:-10042:${topic!.threadId}:${group.id}`,
      )?.workspace.repoPath,
    ).toBe('/server/topic-choice');
    expect(f.store.setting('telegram.currentDaddy')).toBe(privateGroup.id);

    await bot.handle(message(`/session ${group.id.slice(0, 8)}`));
    await bot.handle(message('/repo'));
    const generalCard = sent.at(-1)!.card;
    expect(generalCard.text).not.toContain(f.workspace.repoPath);
    await bot.handle(
      message(`/start ${new URL(generalCard.buttons[1][0].url).searchParams.get('start')}`, 7),
    );
    await bot.handle(message('/repo /server/general-choice', 7));
    await bot.handle(click(sent.at(-1)!.card.buttons[0][0].callback_data, 7));
    expect(sent.at(-1)!.card.text).toContain('/task');
    expect(sent.at(-1)!.card.text).toContain('Work');
    expect(sent.at(-1)!.card.buttons).toBeUndefined();
    expect(
      f.store.setting<{ workspace: { repoPath: string } }>(
        `telegram.nextRepo:7:-10042:0:${group.id}`,
      )?.workspace.repoPath,
    ).toBe('/server/general-choice');
    expect(f.store.setting('telegram.currentDaddy')).toBe(privateGroup.id);

    await bot.handle(message('/new', -10042));
    await bot.handle(click(`dad:new:${f.workspace.id}`));
    const newCard = sent.at(-1)!.card;
    expect(newCard.text).toContain(f.workspace.name);
    expect(newCard.text).not.toContain(f.workspace.repoPath);
    await bot.handle(
      message(`/start ${new URL(newCard.buttons[1][0].url).searchParams.get('start')}`, 7),
    );
    await bot.handle(message('/repo /server/new-session-choice', 7));
    await bot.handle(click(sent.at(-1)!.card.buttons[0][0].callback_data, 7));
    expect(
      f.daddy
        .sessions()
        .some((session) => session.workspace?.repoPath === '/server/new-session-choice'),
    ).toBe(true);
    expect(f.store.setting('telegram.currentDaddy')).toBe(privateGroup.id);

    for (const item of sent.filter(({ destination }) => destination.chatId === -10042))
      expect(item.card.text ?? item.card).not.toContain(f.workspace.repoPath);
  } finally {
    await bot.stop();
    await f.close();
  }
});
it('applies a one-task branch and subfolder without changing workspace defaults', async () => {
  const f = daddyFixture(),
    sent: any[] = [];
  const api = {
    replaceCard: async (_callback: unknown, action: () => Promise<unknown>) => action(),
    send: vi.fn(async (_to, card) => {
      sent.push(card);
      return { message_id: sent.length };
    }),
    call: vi.fn(async () => ({})),
  } as unknown as TelegramApi;
  const bot = new TelegramWorkspace(f.daddy, api, 'fixture_bot', () => 'en');
  f.store.setSetting('telegram.pairing', { chatId: 7, userId: 7 });
  const group = f.daddy.create({ workspaceId: f.workspace.id });
  f.store.setSetting('telegram.currentDaddy', group.id);
  const selection = vi
    .spyOn(f.workspaces, 'selection')
    .mockImplementation(async (workspace, input) => ({
      ...workspace,
      repoPath: input?.path ?? workspace.repoPath,
      scope: input?.scope ?? workspace.scope,
      base: input?.base ?? workspace.base,
    }));
  vi.spyOn(f.workspaces, 'browse').mockResolvedValue({
    path: '/server',
    parent: '/parent',
    directories: [{ name: 'Child', path: '/server/child' }],
    truncated: false,
  });
  vi.mocked(f.checkouts.describeTicket).mockImplementation(async (path, ref, base) => ({
    repoPath: path,
    ref,
    repository: {
      baseHead: 'a'.repeat(40),
      baseBranch: base ?? 'main',
      branch: '',
      cloneUrl: 'https://github.com/test/repo.git',
    },
  }));
  let id = 430;
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
    sent
      .at(-1)
      .buttons.flat()
      .find((item: any) => item.text.includes(text));
  try {
    await bot.handle(
      message(
        '/repo --base release-candidate --scope apps/mobile app -- https://example.test/one.git',
      ),
    );
    expect(sent.at(-1).text).toContain('--base BRANCH');
    expect(sent.at(-1).text).toContain('Base branch: release-candidate');
    expect(sent.at(-1).text).toContain('Scope: apps/mobile app');
    await bot.handle(click(button('Browse server folders').callback_data));
    await bot.handle(click(button('Child').callback_data));
    expect(sent.at(-1).text).toContain('Base branch: release-candidate');
    expect(sent.at(-1).text).toContain('Scope: apps/mobile app');
    await bot.handle(click(sent.at(-1).buttons[0][0].callback_data));
    expect(selection).toHaveBeenCalledWith(
      f.workspace,
      expect.objectContaining({
        path: '/server/child',
        base: 'release-candidate',
        scope: 'apps/mobile app',
      }),
    );
    await bot.handle(message('/task One-off repository selection'));
    const first = f.store.tasks(group.id).at(-1)!;
    expect(first).toMatchObject({
      repoPath: '/server/child',
      scope: 'apps/mobile app',
      ticketRepository: { baseBranch: 'release-candidate' },
    });

    await bot.handle(
      message('/repo --base default --scope default -- https://example.test/two.git'),
    );
    expect(sent.at(-1).text).toContain('Base branch: default');
    expect(sent.at(-1).text).toContain('Scope: default');
    await bot.handle(click(sent.at(-1).buttons[0][0].callback_data));
    await bot.handle(message('/task Literal default options'));
    const literal = f.store.tasks(group.id).find((task) => task.title.includes('Literal default'))!;
    expect(literal).toMatchObject({
      repoPath: 'https://example.test/two.git',
      scope: 'default',
      ticketRepository: { baseBranch: 'default' },
    });

    await bot.handle(message('/task Workspace defaults again'));
    const second = f.store
      .tasks(group.id)
      .find((task) => task.title.includes('Workspace defaults'))!;
    expect(second.repoPath).toBe(f.workspace.repoPath);
    expect(second.scope).toBe(f.workspace.scope);
    expect(f.workspaces.get(f.workspace.id)).toMatchObject(f.workspace);
  } finally {
    await bot.stop();
    await f.close();
  }
});
it('browses through a plain server directory before offering repository confirmation', async () => {
  const f = daddyFixture(),
    sent: any[] = [];
  const api = {
    replaceCard: async (_callback: unknown, action: () => Promise<unknown>) => action(),
    send: vi.fn(async (_to, card) => {
      sent.push(card);
      return { message_id: sent.length };
    }),
    call: vi.fn(async () => ({})),
  } as unknown as TelegramApi;
  const bot = new TelegramWorkspace(f.daddy, api, 'fixture_bot', () => 'en');
  f.store.setSetting('telegram.pairing', { chatId: 7, userId: 7 });
  const group = f.daddy.create({ workspaceId: f.workspace.id });
  f.store.setSetting('telegram.currentDaddy', group.id);
  vi.spyOn(f.workspaces, 'browse').mockImplementation(async (path?: string) => ({
    path: path ?? '',
    parent: path ? '/root' : null,
    directories: path
      ? [{ name: 'Nested repository', path: '/root/repo' }]
      : [{ name: 'Plain root', path: '/root' }],
    truncated: path === '/root',
  }));
  vi.spyOn(f.workspaces, 'selection').mockImplementation(async (workspace, input) => {
    if (input?.path === '/root') throw new Error('Not a repository');
    return {
      ...workspace,
      repoPath: input?.path ?? workspace.repoPath,
      scope: '',
      base: 'main',
    };
  });
  let id = 520;
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
    sent
      .at(-1)
      .buttons.flat()
      .find((item: any) => item.text.includes(text));
  try {
    await bot.handle(message('/repo https://example.test/source.git'));
    await bot.handle(click(button('Browse server folders').callback_data));
    await bot.handle(click(button('Plain root').callback_data));
    expect(button('Nested repository')).toBeTruthy();
    expect(button('Use this folder once')).toBeUndefined();
    expect(sent.at(-1).text).toContain('Only the first 150 folders are shown');
    await bot.handle(click(button('Nested repository').callback_data));
    expect(button('Use this folder once')).toBeTruthy();
    expect(sent.at(-1).text).toContain('/root/repo');
  } finally {
    await bot.stop();
    await f.close();
  }
});
it('stores literal workspace defaults and clears them only with an explicit value', async () => {
  const f = daddyFixture(),
    sent: any[] = [];
  const api = {
    replaceCard: async (_callback: unknown, action: () => Promise<unknown>) => action(),
    send: vi.fn(async (_to, card) => {
      sent.push(card);
      return { message_id: sent.length };
    }),
    call: vi.fn(async () => ({})),
  } as unknown as TelegramApi;
  const bot = new TelegramWorkspace(f.daddy, api, 'fixture_bot', () => 'en');
  f.store.setSetting('telegram.pairing', { chatId: 7, userId: 7 });
  vi.spyOn(f.workspaces, 'register').mockImplementation(async (input, id) => {
    const saved = {
      ...f.workspace,
      id: id ?? f.workspace.id,
      scope: input.scope ?? '',
      base: input.base,
    };
    f.store.saveWorkspace(saved);
    return saved;
  });
  let id = 560;
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
    await bot.handle(message(`/workspace ${f.workspace.id} base default`));
    await bot.handle(message(`/workspace ${f.workspace.id} scope root`));
    expect(f.workspaces.get(f.workspace.id)).toMatchObject({ base: 'default', scope: 'root' });
    await bot.handle(message(`/workspace ${f.workspace.id} base clear`));
    await bot.handle(message(`/workspace ${f.workspace.id} scope clear`));
    expect(f.workspaces.get(f.workspace.id)).toMatchObject({ base: 'clear', scope: 'clear' });
    await bot.handle(message(`/workspace ${f.workspace.id} clear base`));
    await bot.handle(message(`/workspace ${f.workspace.id} clear scope`));
    expect(f.workspaces.get(f.workspace.id).base).toBeUndefined();
    expect(f.workspaces.get(f.workspace.id).scope).toBe('');
    await bot.handle(message(`/workspace ${f.workspace.id}`));
    expect(sent.at(-1).text).toContain('/workspace <ID> clear scope|base');
  } finally {
    await bot.stop();
    await f.close();
  }
});
it('expires, cancels and isolates private repository input for its original route', async () => {
  const f = daddyFixture(),
    sent: { destination: any; card: any }[] = [];
  const api = {
    replaceCard: async (_callback: unknown, action: () => Promise<unknown>) => action(),
    send: vi.fn(async (destination, card) => {
      sent.push({ destination, card });
      return { message_id: sent.length };
    }),
    call: vi.fn(async (method: string) =>
      method === 'createForumTopic' ? { message_thread_id: 51 } : true,
    ),
  } as unknown as TelegramApi;
  const bot = new TelegramWorkspace(f.daddy, api, 'fixture_bot', () => 'en');
  f.store.setSetting('telegram.pairing', { chatId: 7, userId: 7 });
  f.store.setSetting('telegram.group', { chatId: -10042, title: 'Work', ownerId: 7 });
  const first = f.daddy.create({ workspaceId: f.workspace.id, title: 'Session A' }),
    second = f.daddy.create({ workspaceId: f.workspace.id, title: 'Session B' }),
    topic = await bot.ensureTopic(first);
  f.store.setSetting('telegram.currentDaddy', second.id);
  vi.spyOn(f.workspaces, 'selection').mockImplementation(async (workspace, input) => ({
    ...workspace,
    repoPath: input?.path ?? workspace.repoPath,
  }));
  let id = 260;
  const message = (text: string, chatId = 7, threadId?: number): Update => ({
    update_id: id++,
    message: {
      message_id: id,
      text,
      from: { id: 7 },
      chat: { id: chatId, type: chatId === 7 ? 'private' : 'supergroup' },
      message_thread_id: threadId,
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
  const inputKey = 'telegram.repoInput:7:7';
  const open = async () => {
    await bot.handle(message('/repo', -10042, topic!.threadId));
    const url = sent.at(-1)!.card.buttons[1][0].url as string;
    await bot.handle(message(`/start ${new URL(url).searchParams.get('start')}`));
    expect(sent.at(-1)!.card.text).toContain('Target: Session A · topic');
    const buttons = sent.at(-1)!.card.buttons.flat();
    return {
      use: buttons[0].callback_data as string,
      browse: buttons.find((button: any) => button.text === 'Browse server folders')
        .callback_data as string,
    };
  };
  try {
    await open();
    const expired = f.store.setting<{ id: string; choice: { expiresAt: string } }>(inputKey)!;
    expired.choice.expiresAt = '2000-01-01T00:00:00.000Z';
    f.store.setSetting(inputKey, expired);
    await bot.handle(message('/repo /server/expired'));
    expect(sent.at(-1)!.card.text).toContain('selection expired');
    expect(f.workspaces.selection).not.toHaveBeenCalled();
    expect(f.store.setting(inputKey)).toBeNull();

    const sessionCard = await open();
    await bot.handle(message(`/session ${second.id.slice(0, 8)}`));
    expect(f.store.setting(inputKey)).toBeNull();
    await bot.handle(click(sessionCard.use));
    expect(f.workspaces.selection).not.toHaveBeenCalled();

    await open();
    await bot.handle(message('/repo /server/cancelled'));
    const cancelledUse = sent.at(-1)!.card.buttons[0][0].callback_data;
    vi.mocked(f.workspaces.selection).mockClear();
    await bot.handle(message('/cancel'));
    expect(sent.at(-1)!.card).toContain('Repository selection cancelled');
    expect(f.store.setting(inputKey)).toBeNull();
    await bot.handle(click(cancelledUse));
    expect(f.workspaces.selection).not.toHaveBeenCalled();

    const old = await open();
    await open();
    const latest = f.store.setting<{ id: string }>(inputKey)!;
    await bot.handle(click(old.browse));
    expect(f.store.setting<{ id: string }>(inputKey)?.id).toBe(latest.id);
    expect(f.workspaces.selection).not.toHaveBeenCalled();
    await bot.handle(message('/repo /server/latest'));
    await bot.handle(click(sent.at(-1)!.card.buttons[0][0].callback_data));
    expect(
      f.store.setting<{ workspace: { repoPath: string } }>(
        `telegram.nextRepo:7:-10042:${topic!.threadId}:${first.id}`,
      )?.workspace.repoPath,
    ).toBe('/server/latest');
    expect(f.store.setting(`telegram.nextRepo:7:7:0:${second.id}`)).toBeUndefined();

    const sessionCount = f.daddy.sessions().length;
    await bot.handle(message('/new', -10042));
    await bot.handle({
      update_id: id++,
      callback_query: {
        id: String(id),
        data: `dad:new:${f.workspace.id}`,
        from: { id: 7 },
        message: { chat: { id: -10042, type: 'supergroup' } },
      },
    });
    const newUrl = sent.at(-1)!.card.buttons[1][0].url as string;
    await bot.handle(message(`/start ${new URL(newUrl).searchParams.get('start')}`));
    await bot.handle(message('/repo /server/cancelled-session'));
    const cancelledStart = sent.at(-1)!.card.buttons[0][0].callback_data;
    await bot.handle(message('/cancel'));
    await bot.handle(click(cancelledStart));
    expect(f.daddy.sessions()).toHaveLength(sessionCount);
  } finally {
    await bot.stop();
    await f.close();
  }
});
it('rejects a private repository card after switching sessions and labels a fresh target', async () => {
  const f = daddyFixture(),
    sent: any[] = [];
  const api = {
    replaceCard: async (_callback: unknown, action: () => Promise<unknown>) => action(),
    send: vi.fn(async (_to, card) => {
      sent.push(card);
      return { message_id: sent.length };
    }),
    call: vi.fn(async () => ({})),
  } as unknown as TelegramApi;
  const bot = new TelegramWorkspace(f.daddy, api, 'fixture_bot', () => 'en');
  f.store.setSetting('telegram.pairing', { chatId: 7, userId: 7 });
  const first = f.daddy.create({ workspaceId: f.workspace.id, title: 'Session A' }),
    second = f.daddy.create({ workspaceId: f.workspace.id, title: 'Session B' });
  f.store.setSetting('telegram.currentDaddy', first.id);
  vi.spyOn(f.workspaces, 'selection').mockImplementation(async (workspace, input) => ({
    ...workspace,
    repoPath: input?.path ?? workspace.repoPath,
  }));
  let id = 610;
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
    await bot.handle(message('/repo /server/a'));
    const oldUse = sent.at(-1).buttons[0][0].callback_data;
    await bot.handle(message('/repo /server/intended'));
    await bot.handle(click(sent.at(-1).buttons[0][0].callback_data));
    await bot.handle(message(`/session ${second.id.slice(0, 8)}`));
    await bot.handle(click(oldUse));
    expect(
      f.store.setting<{ workspace: { repoPath: string } }>(`telegram.nextRepo:7:7:0:${first.id}`)
        ?.workspace.repoPath,
    ).toBe('/server/intended');
    expect(f.store.setting(`telegram.nextRepo:7:7:0:${second.id}`)).toBeFalsy();

    await bot.handle(message(`/session ${first.id.slice(0, 8)}`));
    await bot.handle(message('/task Uses intended once'));
    expect(
      f.store.tasks(first.id).find((item) => item.title.includes('Uses intended'))?.repoPath,
    ).toBe('/server/intended');

    await bot.handle(message(`/session ${second.id.slice(0, 8)}`));
    await bot.handle(message('/repo /server/b'));
    await bot.handle(click(sent.at(-1).buttons[0][0].callback_data));
    expect(sent.at(-1).text).toContain('Session B');
    await bot.handle(message('/task Uses B once'));
    const task = f.store.tasks(second.id).find((item) => item.title.includes('Uses B'))!;
    expect(task.repoPath).toBe('/server/b');
    expect(f.store.setting(`telegram.nextRepo:7:7:0:${second.id}`)).toBeNull();
  } finally {
    await bot.stop();
    await f.close();
  }
});
it('pages through all sessions and workspaces without losing a group /new request', async () => {
  const f = daddyFixture(),
    sent: any[] = [];
  const api = {
    replaceCard: async (_callback: unknown, action: () => Promise<unknown>) => action(),
    send: vi.fn(async (_destination, card) => {
      sent.push(card);
      return { message_id: sent.length };
    }),
    call: vi.fn(async (method: string) =>
      method === 'createForumTopic' ? { message_thread_id: sent.length + 70 } : true,
    ),
  } as unknown as TelegramApi;
  const bot = new TelegramWorkspace(f.daddy, api, 'fixture_bot', () => 'en');
  f.store.setSetting('telegram.pairing', { chatId: 7, userId: 7 });
  f.store.setSetting('telegram.group', { chatId: -10042, title: 'Work', ownerId: 7 });
  for (let index = 1; index <= 18; index++)
    f.daddy.create({ workspaceId: f.workspace.id, title: `Paged session ${index}` });
  const workspaces = [f.workspace];
  for (let index = 2; index <= 23; index++) {
    const workspace = { ...f.workspace, id: randomUUID(), name: `Paged workspace ${index}` };
    f.store.saveWorkspace(workspace);
    workspaces.push(workspace);
  }
  let id = 600;
  const message = (text: string, chatId = 7): Update => ({
    update_id: id++,
    message: {
      message_id: id,
      text,
      from: { id: 7 },
      chat: { id: chatId, type: chatId === 7 ? 'private' : 'supergroup' },
    },
  });
  const click = (data: string, chatId = 7): Update => ({
    update_id: id++,
    callback_query: {
      id: String(id),
      data,
      from: { id: 7 },
      message: { chat: { id: chatId, type: chatId === 7 ? 'private' : 'supergroup' } },
    },
  });
  const button = (text: string) =>
    sent
      .at(-1)
      .buttons.flat()
      .find((item: any) => item.text.includes(text));
  try {
    await bot.handle(message('/sessions'));
    await bot.handle(click(button('→').callback_data));
    await bot.handle(click(button('Paged session 1').callback_data));
    expect(f.store.setting('telegram.currentDaddy')).toBe(
      f.daddy.sessions().find((group) => group.title === 'Paged session 1')!.id,
    );

    await bot.handle(message('/new Preserve this request', -10042));
    await bot.handle(click(button('→').callback_data, -10042));
    await bot.handle(click(button('→').callback_data, -10042));
    const last = workspaces.at(-1)!;
    await bot.handle(click(button(last.name).callback_data, -10042));
    await bot.handle(click(sent.at(-1).buttons[0][0].callback_data, -10042));
    const created = f.daddy.sessions().find((group) => group.workspace?.id === last.id)!;
    expect(f.store.messages(created.id).at(-1)?.text).toBe('Preserve this request');
  } finally {
    await bot.stop();
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
        .some((button: any) => button.callback_data === 'dad:workspace-module:standalone:gitlab'),
    ).toBe(true);
    await bot.handle(click('dad:workspace-module:gitlab', 7, 12));
    const privateUrl = sent.at(-1).buttons[0][0].url as string;
    await bot.handle(message('https://code.example.test/team/sub/app', 99, 12));
    await bot.handle(message('https://code.example.test/team/sub/app', 7, 12));
    expect(JSON.stringify(sent.at(-1))).not.toContain('Workspace name');
    await bot.handle(message(`/start ${new URL(privateUrl).searchParams.get('start')}`));
    await bot.handle(message('https://code.example.test/team/sub/app'));
    expect(sent.at(-1).text).toContain('Workspace name');
    await bot.handle(message('Company'));
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

it('expires private repository registration without routing its input into a session', async () => {
  const f = daddyFixture(),
    sent: { destination: any; card: any }[] = [];
  const api = {
    replaceCard: async (_callback: unknown, action: () => Promise<unknown>) => action(),
    send: vi.fn(async (destination, card) => {
      sent.push({ destination, card });
      return { message_id: sent.length };
    }),
    call: vi.fn(async () => ({})),
  } as unknown as TelegramApi;
  const bot = new TelegramWorkspace(f.daddy, api, 'fixture_bot', () => 'en');
  f.store.setSetting('telegram.pairing', { chatId: 7, userId: 7 });
  f.store.setSetting('telegram.group', { chatId: -10042, ownerId: 7, title: 'Tasks' });
  const current = f.daddy.create({ workspaceId: f.workspace.id, title: 'Current session' });
  f.store.setSetting('telegram.currentDaddy', current.id);
  let id = 950;
  const message = (text: string, thread?: number): Update => ({
    update_id: id++,
    message: {
      message_id: id,
      text,
      from: { id: 7 },
      chat: { id: thread ? -10042 : 7, type: thread ? 'supergroup' : 'private' },
      message_thread_id: thread,
    },
  });
  const click = (data: string, thread?: number): Update => ({
    update_id: id++,
    callback_query: {
      id: String(id),
      data,
      from: { id: 7 },
      message: {
        chat: { id: thread ? -10042 : 7, type: thread ? 'supergroup' : 'private' },
        message_thread_id: thread,
      },
    },
  });
  const openPrivateRegistration = async () => {
    await bot.handle(click('dad:add-workspace:standalone', 12));
    await bot.handle(click('dad:workspace-module:standalone:github', 12));
    const privateUrl = sent.at(-1)!.card.buttons[0][0].url as string;
    await bot.handle(message(`/start ${new URL(privateUrl).searchParams.get('start')}`));
  };
  try {
    await openPrivateRegistration();
    const registrationKey = 'telegram.addWorkspace:7:7:0',
      registration = f.store.setting<Record<string, unknown>>(registrationKey)!;
    f.store.setSetting(registrationKey, {
      ...registration,
      expiresAt: '2000-01-01T00:00:00.000Z',
    });
    const expiredAddress = message('https://example.test/expired/repository');
    await bot.handle(expiredAddress);
    const expiredAddressReplies = sent.length;
    await bot.handle(expiredAddress);
    expect(sent).toHaveLength(expiredAddressReplies);
    expect(sent.at(-1)!.card).toContain('Repository registration expired');
    expect(f.store.messages(current.id)).toHaveLength(0);

    await openPrivateRegistration();
    await bot.handle(message('https://example.test/expired/name'));
    const waitingForName = f.store.setting<Record<string, unknown>>(registrationKey)!;
    f.store.setSetting(registrationKey, {
      ...waitingForName,
      expiresAt: '2000-01-01T00:00:00.000Z',
    });
    const expiredName = message('Expired name');
    await bot.handle(expiredName);
    const expiredNameReplies = sent.length;
    await bot.handle(expiredName);
    expect(sent).toHaveLength(expiredNameReplies);
    expect(sent.at(-1)!.card).toContain('Repository registration expired');
    expect(f.store.messages(current.id)).toHaveLength(0);
    expect(f.workspaces.list().some((workspace) => workspace.name === 'Expired name')).toBe(false);

    await openPrivateRegistration();
    const repeatedAddress = message('https://example.test/idempotent/repository');
    await bot.handle(repeatedAddress);
    await bot.handle(repeatedAddress);
    expect(
      f.workspaces.list().some((workspace) => workspace.repoPath.includes('idempotent/repository')),
    ).toBe(false);
    const repeatedName = message('Idempotent registration');
    await bot.handle(repeatedName);
    await bot.handle(repeatedName);
    expect(
      f.workspaces.list().filter((workspace) => workspace.name === 'Idempotent registration'),
    ).toHaveLength(1);
    expect(f.store.messages(current.id)).toHaveLength(0);

    await bot.handle(click('dad:add-workspace:standalone', 12));
    await bot.handle(click('dad:workspace-module:standalone:github', 12));
    const expiredLink = sent.at(-1)!.card.buttons[0][0].url as string,
      expiredKey = `telegram.workspacePrivate:${new URL(expiredLink).searchParams
        .get('start')!
        .slice('workspace_'.length)}`,
      expired = f.store.setting<Record<string, unknown>>(expiredKey)!;
    f.store.setSetting(expiredKey, { ...expired, expiresAt: '2000-01-01T00:00:00.000Z' });
    await bot.handle(click('dad:add-workspace', 12));
    await bot.handle(click('dad:workspace-module:github', 12));
    const freshLink = sent.at(-1)!.card.buttons[0][0].url as string,
      freshId = new URL(freshLink).searchParams.get('start')!.slice('workspace_'.length);
    expect(
      f.store.db
        .prepare("SELECT key FROM settings WHERE key LIKE 'telegram.workspacePrivate:%'")
        .all()
        .map((row) => row.key),
    ).toEqual([`telegram.workspacePrivate:${freshId}`]);
    await bot.handle(message(`/start workspace_${freshId}`));
    expect(
      f.store.db
        .prepare("SELECT key FROM settings WHERE key LIKE 'telegram.workspacePrivate:%'")
        .all(),
    ).toEqual([]);
  } finally {
    await bot.stop();
    await f.close();
  }
});

it('recovers the expected private registration reply after its delivery record fails', async () => {
  const f = daddyFixture(),
    sent: { destination: any; card: any; options?: any }[] = [];
  let failure: 'name' | 'continue' | undefined;
  const api = {
    replaceCard: async (_callback: unknown, action: () => Promise<unknown>) => action(),
    send: vi.fn(async (destination, card, _buttons, options) => {
      const name = String(card?.text ?? card).includes('Workspace name'),
        continuation = card?.buttons
          ?.flat()
          .some((button: any) => String(button.text).includes('Continue new session'));
      if ((failure === 'name' && name) || (failure === 'continue' && continuation)) {
        failure = undefined;
        throw Object.assign(new Error('fixture delivery insert failed'), {
          code: 'ERR_SQLITE_ERROR',
        });
      }
      sent.push({ destination, card, options });
      return { message_id: sent.length };
    }),
    call: vi.fn(async () => ({})),
  } as unknown as TelegramApi;
  let bot = new TelegramWorkspace(f.daddy, api, 'fixture_bot', () => 'en');
  f.store.setSetting('telegram.pairing', { chatId: 7, userId: 7 });
  let id = 970;
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
    await bot.handle(message('/new Keep the recovered reply'));
    await bot.handle(click('dad:add-workspace:new'));
    await bot.handle(click('dad:workspace-module:new:github'));
    const address = message('https://example.test/recovered/reply');
    failure = 'name';
    await expect(bot.handle(address)).rejects.toThrow('fixture delivery insert failed');
    await bot.stop();
    bot = new TelegramWorkspace(f.daddy, api, 'fixture_bot', () => 'en');
    await bot.handle(address);
    expect(sent.filter((item) => String(item.card?.text).includes('Workspace name'))).toHaveLength(
      1,
    );
    expect(sent.at(-1)!.options.key).toBe(`registration:${address.update_id}:0`);

    const name = message('Recovered reply repository');
    failure = 'continue';
    await expect(bot.handle(name)).rejects.toThrow('fixture delivery insert failed');
    await bot.stop();
    bot = new TelegramWorkspace(f.daddy, api, 'fixture_bot', () => 'en');
    await bot.handle(name);
    const continuations = sent.filter((item) =>
      item.card?.buttons
        ?.flat()
        .some((button: any) => String(button.text).includes('Continue new session')),
    );
    expect(continuations).toHaveLength(1);
    expect(continuations[0]!.options.key).toBe(`registration:${name.update_id}:0`);
  } finally {
    await bot.stop();
    await f.close();
  }
});

it('continues repository registration only for its exact new-session draft', async () => {
  const f = daddyFixture(),
    sent: { destination: any; card: any }[] = [],
    secret = rememberSecret('PRIVATE_REPOSITORY_NAME_12345');
  const api = {
    replaceCard: async (_callback: unknown, action: () => Promise<unknown>) => action(),
    send: vi.fn(async (destination, card) => {
      sent.push({ destination, card });
      return { message_id: sent.length };
    }),
    call: vi.fn(async () => ({ message_thread_id: 44 })),
  } as unknown as TelegramApi;
  const bot = new TelegramWorkspace(f.daddy, api, 'fixture_bot', () => 'en');
  f.store.setSetting('telegram.pairing', { chatId: 7, userId: 7 });
  f.store.setSetting('telegram.group', { chatId: -10042, ownerId: 7, title: 'Tasks' });
  let id = 980;
  const message = (text: string, thread?: number): Update => ({
    update_id: id++,
    message: {
      message_id: id,
      text,
      from: { id: 7 },
      chat: { id: thread ? -10042 : 7, type: thread ? 'supergroup' : 'private' },
      message_thread_id: thread,
    },
  });
  const click = (data: string, thread?: number): Update => ({
    update_id: id++,
    callback_query: {
      id: String(id),
      data,
      from: { id: 7 },
      message: {
        chat: { id: thread ? -10042 : 7, type: thread ? 'supergroup' : 'private' },
        message_thread_id: thread,
      },
    },
  });
  try {
    await bot.handle(message('/new Preserve this instruction', 12));
    await bot.handle(click('dad:add-workspace:new', 12));
    await bot.handle(click('dad:workspace-module:new:github', 12));
    const privateUrl = sent.at(-1)!.card.buttons[0][0].url as string;
    await bot.handle(message(`/start ${new URL(privateUrl).searchParams.get('start')}`));
    await bot.handle(message('https://example.test/new/session'));
    await bot.handle(message('New session repository'));
    const continuation = sent.filter((item) => item.destination.chatId === -10042).at(-1)!.card
      .buttons[0][0].callback_data as string;
    const creationKey = 'telegram.newSession:7:-10042:12',
      draft = f.store.setting<Record<string, unknown>>(creationKey)!;
    f.store.setSetting(creationKey, { ...draft, expiresAt: '2000-01-01T00:00:00.000Z' });
    await bot.handle(click(continuation, 12));
    expect(f.daddy.sessions()).toHaveLength(0);
    expect(sent.at(-1)!.card.text ?? sent.at(-1)!.card).toContain(
      'original new-session draft expired',
    );

    await bot.handle(message('/new Keep the valid instruction', 12));
    await bot.handle(click('dad:add-workspace:new', 12));
    await bot.handle(click('dad:workspace-module:new:github', 12));
    const validPrivateUrl = sent.at(-1)!.card.buttons[0][0].url as string;
    await bot.handle(message(`/start ${new URL(validPrivateUrl).searchParams.get('start')}`));
    await bot.handle(message('https://example.test/new/valid-session'));
    await bot.handle(message(`Valid ${secret}`));
    const groupContinuation = sent.filter((item) => item.destination.chatId === -10042).at(-1)!;
    expect(JSON.stringify(groupContinuation.card)).not.toContain(secret);
    const validContinuation = groupContinuation.card.buttons[0][0].callback_data as string,
      saveGroup = f.store.saveGroup.bind(f.store);
    let failCreation = true;
    vi.spyOn(f.store, 'saveGroup').mockImplementation((group) => {
      if (group.orchestrated && failCreation) {
        failCreation = false;
        throw new Error('fixture session insert failed');
      }
      return saveGroup(group);
    });
    await bot.handle(click(validContinuation, 12));
    expect(f.daddy.sessions()).toHaveLength(0);
    await bot.handle(click(validContinuation, 12));
    expect(f.daddy.sessions()).toHaveLength(1);
    expect(f.store.messages(f.daddy.sessions()[0]!.id)[0].text).toBe('Keep the valid instruction');

    await bot.handle(message('/new Private original instruction'));
    await bot.handle(click('dad:add-workspace:new'));
    await bot.handle(click('dad:workspace-module:new:github'));
    await bot.handle(message('https://example.test/new/private-stale'));
    await bot.handle(message('Private stale repository'));
    const privateStale = sent.at(-1)!.card.buttons[0][0].callback_data as string;
    await bot.handle(message('/new Replacement private instruction'));
    await bot.handle(click(privateStale));
    expect(f.daddy.sessions()).toHaveLength(1);
    expect(sent.at(-1)!.card.text ?? sent.at(-1)!.card).toContain(
      'original new-session draft expired',
    );

    await bot.handle(message('/new Private valid instruction'));
    await bot.handle(click('dad:add-workspace:new'));
    await bot.handle(click('dad:workspace-module:new:github'));
    await bot.handle(message('https://example.test/new/private-valid'));
    await bot.handle(message('Private valid repository'));
    const privateValid = sent.at(-1)!.card.buttons[0][0].callback_data as string;
    await bot.handle(click(privateValid));
    expect(f.daddy.sessions()).toHaveLength(2);
    const privateSession = f.daddy
      .sessions()
      .find((session) =>
        f.store.messages(session.id).some((entry) => entry.text === 'Private valid instruction'),
      );
    expect(privateSession).toBeTruthy();

    await bot.handle(message('/new Expired standalone draft'));
    const privateDraftKey = 'telegram.newSession:7:7:0',
      expiredDraft = f.store.setting<Record<string, unknown>>(privateDraftKey)!;
    f.store.setSetting(privateDraftKey, {
      ...expiredDraft,
      expiresAt: '2000-01-01T00:00:00.000Z',
    });
    await bot.handle(click('dad:add-workspace:standalone'));
    await bot.handle(click('dad:workspace-module:standalone:github'));
    await bot.handle(message('https://example.test/new/standalone'));
    await bot.handle(message('Standalone repository'));
    expect(
      f.workspaces.list().some((workspace) => workspace.name === 'Standalone repository'),
    ).toBe(true);

    const upgradedExpires = new Date(Date.now() + 60_000).toISOString();
    f.store.setSetting('telegram.newSession:7:-10042:13', {
      id: 'upgraded-draft',
      text: 'Upgraded instruction',
      expiresAt: upgradedExpires,
    });
    f.store.setSetting('telegram.workspacePrivate:abcdefghijklmnop', {
      provider: 'github',
      origin: { chatId: -10042, threadId: 13 },
      creationId: 'upgraded-draft',
      creationText: 'Upgraded instruction',
      creationExpiresAt: upgradedExpires,
      ownerId: 7,
      expiresAt: upgradedExpires,
    });
    await bot.handle(message('/start workspace_abcdefghijklmnop'));
    await bot.handle(message('https://example.test/new/upgraded'));
    await bot.handle(message('Upgraded repository'));
    const upgradedContinuation = sent
      .filter((item) => item.destination.chatId === -10042 && item.destination.threadId === 13)
      .at(-1)!.card.buttons[0][0].callback_data as string;
    await bot.handle(click(upgradedContinuation, 13));
    expect(
      f.daddy
        .sessions()
        .some((session) =>
          f.store.messages(session.id).some((entry) => entry.text === 'Upgraded instruction'),
        ),
    ).toBe(true);

    f.store.setSetting('telegram.newSession:7:-10042:13', {
      id: 'legacy-draft',
      text: 'Legacy instruction',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    f.store.setSetting('telegram.addWorkspace:7:7:0', {
      provider: 'github',
      path: 'https://example.test/new/legacy',
      origin: { chatId: -10042, threadId: 13 },
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await bot.handle(message('Legacy repository'));
    expect(f.daddy.sessions()).toHaveLength(3);
    expect(sent.at(-1)!.card).toContain('selection expired');

    f.store.setSetting('telegram.addWorkspace:7:-10042:14', {
      provider: 'github',
      path: 'https://example.test/new/group-legacy',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await bot.handle(message('Group legacy repository', 14));
    expect(
      f.workspaces.list().some((workspace) => workspace.name === 'Group legacy repository'),
    ).toBe(false);
    expect(JSON.stringify(sent.at(-1)!.card)).toContain('paired private chat');
  } finally {
    await bot.stop();
    await f.close();
  }
});

it('mirrors a CLI-created session and live assistant messages to one topic without tool logs or Telegram echoes', async () => {
  const f = daddyFixture();
  const sent: { destination: any; card: any; options?: any }[] = [];
  const api = {
    replaceCard: async (_callback: unknown, action: () => Promise<unknown>) => action(),
    send: vi.fn(async (destination, card, _buttons, options) => {
      sent.push({ destination, card, options });
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
    expect(sent.slice(count)).toEqual([
      expect.objectContaining({
        card: expect.objectContaining({ text: expect.stringContaining(group.title) }),
        options: expect.objectContaining({
          key: `telegram:daddy-intro:-10042:${group.id}`,
          replace: true,
        }),
      }),
    ]);
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

it.each(['private', 'topic'])(
  'sends a fresh owner mention for a real decision in %s and deduplicates replay',
  async (where) => {
    const f = daddyFixture();
    const sent: { destination: any; card: any; options: any }[] = [];
    const api = {
      send: vi.fn(async (destination, card, _unused, options) => {
        sent.push({ destination, card, options });
        return { message_id: sent.length };
      }),
      call: vi.fn(async (method) =>
        method === 'getChat' ? { id: 7, first_name: 'Owner' } : { message_thread_id: 31 },
      ),
    } as unknown as TelegramApi;
    const bot = new TelegramWorkspace(f.daddy, api, 'fixture_bot', () => 'en');
    const secret = rememberSecret('PRIVATE_OWNER_QUESTION_TITLE_12345');
    f.store.setSetting('telegram.pairing', { chatId: 7, userId: 7, username: 'fixture_bot' });
    if (where === 'topic')
      f.store.setSetting('telegram.group', { chatId: -10042, title: 'Work', ownerId: 7 });
    const listener = (event: any) => bot.onEvent(event);
    f.store.changes.on('event', listener);
    const mentions = () =>
      sent.filter((item) => item.card.entities?.some((e: any) => e.url === 'tg://user?id=7'));
    try {
      const group = f.daddy.create({ workspaceId: f.workspace.id });
      f.runtime.runSession.mockImplementationOnce(async (input) => {
        input.onAssistantMessage?.({ id: 'p', text: 'Checking.' });
        return {
          status: 'needs_input',
          summary: 'Choose a branch?',
          question: 'Choose a branch?',
          checkedHead: '',
        };
      });
      f.daddy.chat(group.id, 'Check the branch');
      f.daddy.tick();
      await vi.waitFor(() => expect(mentions()).toHaveLength(1));
      const first = mentions()[0];
      expect(first.destination).toMatchObject(
        where === 'topic' ? { chatId: -10042, threadId: 31 } : { chatId: 7 },
      );
      expect(first.card.text).toContain('Choose a branch?');
      expect(first.card.text).toContain('Owner');
      expect(first.options.replace).toBe(false);
      expect(
        sent.find((entry) => entry.card.text?.includes('Checking.'))?.card.entities,
      ).not.toContainEqual(expect.objectContaining({ url: 'tg://user?id=7' }));

      const task = await f.daddy.createTask(group.id, {
        requirements: 'Build the layout',
        requestId: 'ask-worker',
      });
      task.title = `Build ${secret}`;
      f.store.saveTask(task);
      f.agentRuntime.run.mockImplementationOnce(async (input) => ({
        status: 'needs_input',
        summary: 'Blocked',
        question: 'Which layout?',
        checkedHead: input.task.revision!.head,
      }));
      await f.worker.tick();
      await vi.waitFor(() => expect(mentions()).toHaveLength(2));
      const second = mentions()[1];
      expect(second.card.text).toContain('Which layout?');
      if (where === 'topic') expect(second.card.text).not.toContain(secret);
      else expect(second.card.text).toContain(secret);
      expect(second.card.buttons[0][0].callback_data).toBe('dad:task:' + task.id);
      bot.replay();
      await new Promise((resolve) => setImmediate(resolve));
      expect(mentions()).toHaveLength(2);

      const setting = f.store.getTask(task.id);
      f.store.saveTask({ ...setting, inputRequest: undefined, reason: 'Server restarted' });
      f.store.event(task.id, 'task.state', { state: 'needs_input' });
      const source = 'https://github.com/test/repo/pull/7';
      f.store.saveTask({
        ...setting,
        ref: { provider: 'github', host: 'github.com', repo: 'test/repo', number: 7, url: source },
        review: { id: 'old-draft', marker: 'test', revision: setting.revision! },
        inputRequest: undefined,
        reason:
          'Inspect the old review draft: it contains changes that daddy cannot safely replace.',
      });
      f.store.db
        .prepare('INSERT INTO operations VALUES(?,?,?,?,NULL)')
        .run('test:run:edit_comment:call', task.id, 'pending', 'unknown');
      bot.replay();
      await new Promise((resolve) => setImmediate(resolve));
      expect(mentions()).toHaveLength(2);
      f.store.db.prepare("DELETE FROM operations WHERE id='test:run:edit_comment:call'").run();
      bot.replay();
      await vi.waitFor(() => expect(mentions()).toHaveLength(3));
      expect(mentions()[2].card.buttons[0]).toContainEqual({ text: 'PR', url: source });
      f.store.setSetting('notifications.telegram', { enabled: false, mode: 'all' });
      f.store.finishDaddyReply(group.id, 'Muted request', 'another-run', true);
      await bot.stop();
      expect(mentions()).toHaveLength(3);
    } finally {
      f.store.changes.off('event', listener);
      await bot.stop();
      await f.close();
    }
  },
);

it('repeats only an open owner question after 30 minutes, once across replays and restarts', async () => {
  const f = daddyFixture();
  const sent: any[] = [];
  const api = {
    send: vi.fn(async (_to, card, _unused, options) => {
      sent.push({ card, options });
      return { message_id: sent.length };
    }),
    call: vi.fn(),
  } as unknown as TelegramApi;
  let bot = new TelegramWorkspace(f.daddy, api, 'fixture_bot', () => 'en');
  f.store.setSetting('telegram.pairing', { userId: 7, chatId: 7, ownerLabel: 'Owner' });
  const group = f.daddy.create({ workspaceId: f.workspace.id });
  const t = await f.daddy.createTask(group.id, { requirements: 'Layout', requestId: 'test' });
  f.store.saveTask({
    ...t,
    state: 'needs_input',
    reason: 'Which layout?',
    inputRequest: { role: 'author', runId: 'run', generation: t.generation },
  });
  const pings = () =>
    sent.filter((x) => x.card.entities?.some((e: any) => e.url === 'tg://user?id=7'));
  try {
    bot.replay();
    await vi.waitFor(() => expect(pings()).toHaveLength(1));
    const id = pings()[0].options.notificationId;
    const age = (minutes: number, key = id) =>
      f.store.db
        .prepare('UPDATE notifications SET at=? WHERE id=?')
        .run(new Date(Date.now() - minutes * 60000).toISOString(), key);
    age(29);
    bot.remindOwners();
    await bot.stop();
    expect(pings()).toHaveLength(1);
    bot = new TelegramWorkspace(f.daddy, api, 'fixture_bot', () => 'en');
    age(95);
    bot.remindOwners();
    bot.remindOwners();
    await vi.waitFor(() => expect(pings()).toHaveLength(2));
    const reminder = pings()[1];
    expect(reminder.options.replace).toBe(false);
    expect(reminder.card.text).toContain('Which layout?');
    bot.replay();
    bot.remindOwners();
    await bot.stop();
    expect(pings()).toHaveLength(2);
    bot = new TelegramWorkspace(f.daddy, api, 'fixture_bot', () => 'en');
    age(31, reminder.options.notificationId);
    f.store.setSetting('notifications.telegram', { enabled: false, mode: 'all' });
    bot.remindOwners();
    f.store.setSetting('notifications.telegram', { enabled: true, mode: 'attention' });
    f.store.saveTask({ ...t, state: 'fixing' });
    bot.remindOwners();
    await bot.stop();
    expect(pings()).toHaveLength(2);
  } finally {
    await bot.stop();
    await f.close();
  }
});

it('acknowledges an explicit reply to the matching task ping while its answer is being processed', async () => {
  const f = daddyFixture();
  try {
    const group = f.daddy.create({ workspaceId: f.workspace.id });
    const task = await f.daddy.createTask(group.id, { requirements: 'Task', requestId: 'asked' });
    f.store.saveTask({
      ...task,
      state: 'needs_input',
      inputRequest: { runId: 'question', role: 'author', generation: task.generation },
    });
    f.store.setSetting('telegram.pairing', { chatId: 7, userId: 7 });
    const q = { groupId: group.id, taskId: task.id, request: 'question' };
    f.store.setSetting('telegram.delivery:test', {
      destination: { chatId: -1001 },
      options: { key: 'telegram:question:7:' + task.id + ':question' },
      messages: [{ id: 42 }],
    });
    f.store.daddyMessage(group.id, 'user', 'Another reply', undefined, undefined, {
      origin: { channel: 'telegram', chatId: 7, replyTo: { messageId: 42 } },
    });
    expect(reminderOpen(f.store, q)).toBe(true);
    f.store.daddyMessage(group.id, 'user', 'Use main', undefined, undefined, {
      origin: { channel: 'telegram', chatId: -1001, replyTo: { messageId: 42 } },
    });
    expect(reminderOpen(f.store, q)).toBe(false);
  } finally {
    await f.close();
  }
});

it('stops reminders for a coordinator question after an owner answer', async () => {
  const f = daddyFixture();
  const sent: any[] = [];
  const api = {
    send: vi.fn(async (_to, card, _unused, options) => {
      sent.push({ card, options });
      return { message_id: sent.length };
    }),
  } as unknown as TelegramApi;
  const bot = new TelegramWorkspace(f.daddy, api, 'fixture_bot', () => 'en');
  try {
    f.store.setSetting('telegram.pairing', { chatId: 7, userId: 7, ownerLabel: 'Owner' });
    const group = f.daddy.create({ workspaceId: f.workspace.id });
    f.store.saveGroup({ ...group, daddyState: 'needs_input' });
    f.store.finishDaddyReply(group.id, 'Which branch?', 'test-turn', true);
    bot.replay();
    await vi.waitFor(() => expect(sent.length).toBe(1));
    f.store.db
      .prepare('UPDATE notifications SET at=? WHERE id=?')
      .run('2000-01-01T00:00:00.000Z', sent[0].options.notificationId);
    bot.remindOwners();
    await vi.waitFor(() => expect(sent.length).toBe(2));
    f.store.db
      .prepare('UPDATE notifications SET at=? WHERE id=?')
      .run('2000-01-02T00:00:00.000Z', sent[1].options.notificationId);
    f.daddy.chat(group.id, 'Use main.');
    bot.remindOwners();
    await bot.stop();
    expect(sent.length).toBe(2);
  } finally {
    await bot.stop();
    await f.close();
  }
});

it('offers an immediate model switch from the daddy effort picker', async () => {
  const f = daddyFixture();
  const sent: any[] = [];
  const api = {
    replaceCard: async (_callback: unknown, action: () => Promise<unknown>) => action(),
    send: vi.fn(async (_to, card) => {
      sent.push(card);
      return { message_id: sent.length };
    }),
    call: vi.fn(async () => ({})),
  } as unknown as TelegramApi;
  const bot = new TelegramWorkspace(f.daddy, api, 'fixture_bot', () => 'en');
  f.store.setSetting('telegram.pairing', { userId: 7, chatId: 7 });
  const group = f.daddy.create({ workspaceId: f.workspace.id });
  f.store.setSetting('telegram.currentDaddy', group.id);
  let n = 1;
  const press = (data: string) =>
    bot.handle({
      update_id: n++,
      callback_query: {
        id: String(n),
        data,
        from: { id: 7 },
        message: { chat: { id: 7, type: 'private' } },
      },
    });
  try {
    await press('dad:models:' + group.id + ':daddy');
    const choice = sent
      .at(-1)
      .buttons.flat()
      .find((b: any) => b.text.includes('gpt-5.6-sol'));
    await press(choice.callback_data);
    const force = sent
      .at(-1)
      .buttons.flat()
      .find((b: any) => b.callback_data?.endsWith(':force'));
    const settings = vi.spyOn(f.daddy, 'settings');
    await press(force.callback_data);
    expect(settings).toHaveBeenCalledWith(
      group.id,
      expect.objectContaining({
        profiles: { daddy: expect.objectContaining({ model: 'gpt-5.6-sol' }) },
        forceDaddy: true,
      }),
    );
  } finally {
    await bot.stop();
    await f.close();
  }
});

it('pages through every model and supports profiles without effort and engine defaults', async () => {
  const f = daddyFixture();
  const sent: any[] = [];
  const api = {
    replaceCard: async (_callback: unknown, action: () => Promise<unknown>) => action(),
    send: vi.fn(async (_to, card) => {
      sent.push(card);
      return { message_id: sent.length };
    }),
    call: vi.fn(async () => ({})),
  } as unknown as TelegramApi;
  let locale: 'en' | 'ru' = 'en';
  const bot = new TelegramWorkspace(f.daddy, api, 'fixture_bot', () => locale);
  f.store.setSetting('telegram.pairing', { userId: 7, chatId: 7 });
  const group = f.daddy.create({ workspaceId: f.workspace.id });
  f.store.setSetting('telegram.currentDaddy', group.id);
  const models = Array.from({ length: 30 }, (_, index) => ({
    id: `codex-${index + 1}`,
    engine: 'codex',
    name: `Codex ${index + 1}`,
    efforts: ['medium'],
    defaultEffort: 'medium',
    isDefault: index === 0,
  }));
  models.push({
    id: 'claude-no-effort',
    engine: 'claude',
    name: 'Claude without effort',
    efforts: [],
    defaultEffort: '',
    isDefault: false,
  });
  const list = vi.spyOn(f.daddy.catalogue, 'list').mockResolvedValue(models);
  let n = 1400;
  const press = (data: string) =>
    bot.handle({
      update_id: n++,
      callback_query: {
        id: String(n),
        data,
        from: { id: 7 },
        message: { chat: { id: 7, type: 'private' } },
      },
    });
  const button = (text: string) =>
    sent
      .at(-1)
      .buttons.flat()
      .find((item: any) => item.text.includes(text));
  const expectBoundedCallbacks = () =>
    expect(
      sent
        .at(-1)
        .buttons.flat()
        .map((item: any) => item.callback_data?.length ?? 0)
        .sort((left: number, right: number) => right - left)[0],
    ).toBeLessThanOrEqual(64);
  try {
    for (const role of ['daddy', 'worker'] as const) {
      await press(`dad:models:${group.id}:${role}`);
      for (let page = 0; page < 3; page++) await press(button('→').callback_data);
      expectBoundedCallbacks();
      const last = button('Claude without effort');
      expect(last).toBeTruthy();
      await press(last.callback_data);
      expectBoundedCallbacks();
      const noEffort = sent
        .at(-1)
        .buttons.flat()
        .find((item: any) => item.callback_data?.endsWith(':default'));
      expect(noEffort).toBeTruthy();
      await press(noEffort.callback_data);
      const selected = f.daddy.group(group.id);
      expect((role === 'daddy' ? selected.daddy : selected.worker)?.model).toBe('claude-no-effort');
      expect((role === 'daddy' ? selected.daddy : selected.worker)?.effort).toBeUndefined();

      locale = 'ru';
      await press(`dad:models:${group.id}:${role}`);
      await press(button('по умолчанию').callback_data);
      expectBoundedCallbacks();
      const saveDefault = sent
        .at(-1)
        .buttons.flat()
        .find((item: any) => item.callback_data?.endsWith(':save'));
      await press(saveDefault.callback_data);
      const reset = f.daddy.group(group.id);
      expect(role === 'daddy' ? reset.daddy : reset.worker).toEqual({ engine: 'claude' });
    }

    locale = 'en';
    f.daddy.chat(group.id, 'Keep this turn queued while changing models');
    await press(`dad:models:${group.id}:daddy`);
    for (let page = 0; page < 3; page++) await press(button('→').callback_data);
    await press(button('Claude without effort').callback_data);
    expectBoundedCallbacks();
    const normal = button('Default effort').callback_data,
      force = sent
        .at(-1)
        .buttons.flat()
        .find((item: any) => item.callback_data?.endsWith(':force')).callback_data;
    await press(normal);
    expect(f.daddy.group(group.id).daddy).toEqual({ engine: 'claude' });
    await press(force);
    expect(f.daddy.group(group.id).daddy).toEqual({
      engine: 'claude',
      model: 'claude-no-effort',
    });

    await press(`dad:models:${group.id}:worker`);
    await press(button('Codex 1').callback_data);
    await press(button('Default effort').callback_data);
    expect(f.daddy.group(group.id).worker).toMatchObject({
      engine: 'codex',
      model: 'codex-1',
    });
    expect(f.daddy.group(group.id).worker?.effort).toBeUndefined();

    const empty = f.daddy.create({ workspaceId: f.workspace.id, title: 'Empty catalogues' });
    f.store.setSetting('telegram.currentDaddy', empty.id);
    (f.daddy.catalogue as any).engines = () => [
      { id: 'codex', name: 'Codex' },
      { id: 'claude', name: 'Claude' },
    ];
    list.mockRejectedValue(new Error('All model catalogues are unavailable'));
    for (const role of ['daddy', 'worker'] as const) {
      await press(`dad:models:${empty.id}:${role}`);
      const claude = button('Claude · Engine configuration');
      expect(claude).toBeTruthy();
      await press(claude.callback_data);
      await press(
        sent
          .at(-1)
          .buttons.flat()
          .find((item: any) => item.callback_data?.endsWith(':save')).callback_data,
      );
      expect(
        role === 'daddy' ? f.daddy.group(empty.id).daddy : f.daddy.group(empty.id).worker,
      ).toEqual({ engine: 'claude' });
    }
  } finally {
    await bot.stop();
    await f.close();
  }
});

it('rejects model buttons from a previously selected private session', async () => {
  const f = daddyFixture(),
    sent: any[] = [];
  const api = {
    replaceCard: async (_callback: unknown, action: () => Promise<unknown>) => action(),
    send: vi.fn(async (_to, card) => {
      sent.push(card);
      return { message_id: sent.length };
    }),
    call: vi.fn(async () => ({})),
  } as unknown as TelegramApi;
  const bot = new TelegramWorkspace(f.daddy, api, 'fixture_bot', () => 'en');
  f.store.setSetting('telegram.pairing', { userId: 7, chatId: 7 });
  const first = f.daddy.create({ workspaceId: f.workspace.id, title: 'Session A' }),
    second = f.daddy.create({ workspaceId: f.workspace.id, title: 'Session B' });
  f.store.setSetting('telegram.currentDaddy', first.id);
  vi.spyOn(f.daddy.catalogue, 'list').mockResolvedValue([
    {
      id: 'fixture-model',
      engine: 'codex',
      name: 'Fixture model',
      efforts: ['medium'],
      defaultEffort: 'medium',
      isDefault: true,
    },
  ]);
  let id = 1700;
  const press = (data: string) =>
    bot.handle({
      update_id: id++,
      callback_query: {
        id: String(id),
        data,
        from: { id: 7 },
        message: { chat: { id: 7, type: 'private' } },
      },
    });
  const message = (text: string): Update => ({
    update_id: id++,
    message: {
      message_id: id,
      text,
      from: { id: 7 },
      chat: { id: 7, type: 'private' },
    },
  });
  const button = (text: string) =>
    sent
      .at(-1)
      .buttons.flat()
      .find((item: any) => item.text.includes(text));
  try {
    const beforeDaddy = structuredClone(first.daddy),
      beforeWorker = structuredClone(first.worker);
    await press(`dad:models:${first.id}:daddy`);
    const oldDefault = button('Use engine defaults').callback_data;
    await bot.handle(message(`/session ${second.id.slice(0, 8)}`));
    await press(oldDefault);
    expect(f.daddy.group(first.id).daddy).toEqual(beforeDaddy);

    await bot.handle(message(`/session ${first.id.slice(0, 8)}`));
    await press(`dad:models:${first.id}:worker`);
    await press(button('Fixture model').callback_data);
    expect(sent.at(-1).text).toContain('Session A');
    const oldEffort = button('medium').callback_data;
    await bot.handle(message(`/session ${second.id.slice(0, 8)}`));
    await press(oldEffort);
    expect(f.daddy.group(first.id).worker).toEqual(beforeWorker);

    await press(`dad:models:${second.id}:worker`);
    await press(button('Fixture model').callback_data);
    await press(button('medium').callback_data);
    expect(f.daddy.group(second.id).worker).toMatchObject({ model: 'fixture-model' });
  } finally {
    await bot.stop();
    await f.close();
  }
});

it('pages through discovered repositories and server folders without losing the new-session target', async () => {
  const f = daddyFixture(),
    sent: any[] = [];
  const api = {
    replaceCard: async (_callback: unknown, action: () => Promise<unknown>) => action(),
    send: vi.fn(async (_to, card) => {
      sent.push(card);
      return { message_id: sent.length };
    }),
    call: vi.fn(async () => ({})),
  } as unknown as TelegramApi;
  const bot = new TelegramWorkspace(f.daddy, api, 'fixture_bot', () => 'en');
  f.store.setSetting('telegram.pairing', { userId: 7, chatId: 7 });
  vi.spyOn(f.workspaces, 'suggestions').mockResolvedValue(
    Array.from({ length: 35 }, (_, index) => ({
      name: `Discovered ${index + 1}`,
      path: `/fixture/discovered-${index + 1}`,
    })),
  );
  vi.spyOn(f.workspaces, 'browse').mockImplementation(async (path?: string) => ({
    path: path ?? '',
    parent: null,
    directories: Array.from({ length: 35 }, (_, index) => ({
      name: `Folder ${index + 1}`,
      path: `/fixture/folder-${index + 1}`,
    })),
    truncated: false,
  }));
  vi.spyOn(f.workspaces, 'selection').mockImplementation(async (workspace, input) => ({
    ...workspace,
    repoPath: input?.path ?? workspace.repoPath,
  }));
  let id = 1600;
  const message = (text: string): Update => ({
    update_id: id++,
    message: {
      message_id: id,
      text,
      from: { id: 7 },
      chat: { id: 7, type: 'private' },
    },
  });
  const press = (data: string) =>
    bot.handle({
      update_id: id++,
      callback_query: {
        id: String(id),
        data,
        from: { id: 7 },
        message: { chat: { id: 7, type: 'private' } },
      },
    });
  const button = (text: string) =>
    sent
      .at(-1)
      .buttons.flat()
      .find((item: any) => item.text === text || item.text.includes(text));
  const exactButton = (text: string) =>
    sent
      .at(-1)
      .buttons.flat()
      .find((item: any) => item.text === text);
  try {
    await bot.handle(message('/new Keep this phone task'));
    await press(button('Find on server').callback_data);
    for (let page = 0; page < 3; page++) await press(exactButton('→').callback_data);
    expect(button('Discovered 35')).toBeTruthy();

    await bot.handle(message('/new Keep this phone task'));
    await press(`dad:new:${f.workspace.id}`);
    await press(button('Browse server folders').callback_data);
    for (let page = 0; page < 3; page++) await press(exactButton('→').callback_data);
    await press(button('Folder 35').callback_data);
    expect(sent.at(-1).text).toContain('/fixture/folder-35');
    await press(button('Start session').callback_data);
    const created = f.daddy.sessions()[0]!;
    expect(created.workspace?.repoPath).toBe('/fixture/folder-35');
    expect(f.store.daddyJobs(created.id)[0]?.input).toBe('Keep this phone task');
  } finally {
    await bot.stop();
    await f.close();
  }
});

it('pages through every model and supports profiles without effort and engine defaults', async () => {
  const f = daddyFixture(),
    sent: any[] = [];
  const api = {
    replaceCard: async (_callback: unknown, action: () => Promise<unknown>) => action(),
    send: vi.fn(async (_to, card) => {
      sent.push(card);
      return { message_id: sent.length };
    }),
    call: vi.fn(async () => ({})),
  } as unknown as TelegramApi;
  let locale: 'en' | 'ru' = 'en';
  const bot = new TelegramWorkspace(f.daddy, api, 'fixture_bot', () => locale);
  f.store.setSetting('telegram.pairing', { userId: 7, chatId: 7 });
  const group = f.daddy.create({ workspaceId: f.workspace.id });
  f.store.setSetting('telegram.currentDaddy', group.id);
  const models = Array.from({ length: 30 }, (_, index) => ({
    id: `codex-${index + 1}`,
    engine: 'codex',
    name: `Codex ${index + 1}`,
    efforts: ['medium'],
    defaultEffort: 'medium',
    isDefault: index === 0,
  }));
  models.push({
    id: 'claude-no-effort',
    engine: 'claude',
    name: 'Claude without effort',
    efforts: [],
    defaultEffort: '',
    isDefault: false,
  });
  vi.spyOn(f.daddy.catalogue, 'list').mockResolvedValue(models);
  let n = 1400;
  const press = (data: string) =>
    bot.handle({
      update_id: n++,
      callback_query: {
        id: String(n),
        data,
        from: { id: 7 },
        message: { chat: { id: 7, type: 'private' } },
      },
    });
  const button = (text: string) =>
    sent
      .at(-1)
      .buttons.flat()
      .find((item: any) => item.text.includes(text));
  try {
    for (const role of ['daddy', 'worker'] as const) {
      await press(`dad:models:${group.id}:${role}`);
      for (let page = 0; page < 3; page++) await press(button('→').callback_data);
      await press(button('Claude without effort').callback_data);
      await press(
        sent
          .at(-1)
          .buttons.flat()
          .find((item: any) => item.callback_data?.endsWith(':default')).callback_data,
      );
      const selected = f.daddy.group(group.id);
      expect((role === 'daddy' ? selected.daddy : selected.worker)?.model).toBe('claude-no-effort');
      expect((role === 'daddy' ? selected.daddy : selected.worker)?.effort).toBeUndefined();

      locale = 'ru';
      await press(`dad:models:${group.id}:${role}`);
      await press(button('по умолчанию').callback_data);
      await press(
        sent
          .at(-1)
          .buttons.flat()
          .find((item: any) => item.callback_data?.endsWith(':save')).callback_data,
      );
      expect(
        role === 'daddy' ? f.daddy.group(group.id).daddy : f.daddy.group(group.id).worker,
      ).toEqual({ engine: 'claude' });
    }

    locale = 'en';
    await press(`dad:models:${group.id}:worker`);
    await press(button('Codex 1').callback_data);
    await press(button('Default effort').callback_data);
    expect(f.daddy.group(group.id).worker).toMatchObject({ engine: 'codex', model: 'codex-1' });
    expect(f.daddy.group(group.id).worker?.effort).toBeUndefined();
  } finally {
    await bot.stop();
    await f.close();
  }
});

it('binds the current turn to the quoted Telegram parent even after an unrelated update', async () => {
  const f = daddyFixture();
  const api = {
    send: vi.fn(async () => ({ message_id: 1 })),
    call: vi.fn(async () => ({})),
  } as unknown as TelegramApi;
  const bot = new TelegramWorkspace(f.daddy, api, 'fixture_bot', () => 'ru');
  const group = f.daddy.create({ workspaceId: f.workspace.id });
  f.store.setSetting('telegram.pairing', { chatId: 7, userId: 7 });
  f.store.setSetting('telegram.currentDaddy', group.id);
  const chat = { id: 7, type: 'private' };
  const message = {
    message_id: 365,
    from: { id: 7 },
    chat,
    text: 'а на что это влияет?',
    reply_to_message: {
      message_id: 359,
      chat,
      from: { id: 12, username: 'fixture_bot', is_bot: true },
      text: 'Воркер · DADDY-ccf7e32c · PR #39. Какой контракт сохранить?',
    },
    quote: { text: 'Какой контракт сохранить?', position: 38, is_manual: true },
  };
  try {
    f.store.daddyMessage(group.id, 'agent', 'Newer result about PR #64');
    await bot.handle({ update_id: 365, message });
    await bot.handle({ update_id: 365, message });
    await bot.handle({
      update_id: 366,
      message: { message_id: 366, chat, from: { id: 7 }, text: 'и отдельный вопрос' },
    });
    const jobs = f.store.daddyJobs(group.id);
    expect(jobs.filter((j) => j.trigger === 'user')).toHaveLength(2);
    expect(jobs[0].replyTo).toMatchObject({
      messageId: 359,
      text: message.reply_to_message.text,
      quote: message.quote.text,
    });
    expect(jobs[1].replyTo).toBeUndefined();
    const saved = f.store.messages(group.id).find((m) => m.text === message.text);
    expect(saved?.origin).toMatchObject({ messageId: 365, replyTo: jobs[0].replyTo });
    f.daddy.tick();
    await vi.waitFor(() => expect(f.runtime.runSession).toHaveBeenCalledOnce());
    const context = JSON.parse(f.runtime.runSession.mock.calls[0][0].prompt);
    expect(context.currentInstruction).toBe(message.text);
    expect(context.replyTo).toMatchObject({
      messageId: 359,
      text: expect.stringContaining('PR #39'),
      quote: message.quote.text,
    });
  } finally {
    await bot.stop();
    await f.close();
  }
});
