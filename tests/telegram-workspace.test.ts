import { afterEach, expect, it, vi } from 'vitest';
import { daddyFixture } from './daddy-fixture.js';
import { Telegram, TelegramApi, type Update } from '../src/integrations/telegram.js';
import { TelegramWorkspace } from '../src/integrations/telegram-workspace.js';
import { UpdateMonitor } from '../src/core/updates.js';
import { catalogue } from './planning-fixture.js';
afterEach(() => vi.restoreAllMocks());
it('binds a forum selected by the paired owner, creates one topic per session and routes only that owner’s messages to Daddy', async () => {
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
    updates = new UpdateMonitor(f.store, { probe: async () => ({ source: 'missing' }) });
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
    await bot.handle(message('/workspace'));
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
    expect(f.store.setting('telegram.workspace')).toBeUndefined();
    await bot.handle({
      update_id: id++,
      message: {
        chat: { id: 7, type: 'private' },
        from: { id: 7 },
        chat_shared: { request_id: request.request_id, chat_id: -10042 },
      },
    });
    expect(f.store.setting('telegram.workspace')).toMatchObject({ chatId: -10042, ownerId: 7 });
    await bot.handle(message('/new'));
    await bot.handle(click(`dad:new:${f.project.id}`));
    const group = f.daddy.sessions()[0];
    await vi.waitFor(() =>
      expect(sent.filter((item) => item.method === 'createForumTopic')).toHaveLength(1),
    );
    await bot.handle(click(`dad:new:${f.project.id}`));
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
    expect(f.daddy.group(group.id).writerLimit).toBe(3);
    await bot.handle(click(`dad:pool:${group.id}:8`, -10042, 99, 17));
    expect(f.daddy.group(group.id).writerLimit).toBe(3);
    expect(sent.filter((item) => item.method === 'createForumTopic')).toHaveLength(1);
    const task = await f.tickets.local({
      project: f.project,
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
  f.store.setSetting('telegram.workspace', { chatId: -10042, title: 'Work', ownerId: 7 });
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
    const group = f.daddy.create({ projectId: f.project.id });
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
