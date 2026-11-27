import { afterEach, expect, it, vi } from 'vitest';
import { daddyFixture } from './daddy-fixture.js';
import { TelegramApi } from '../src/integrations/telegram.js';
import { TelegramWorkspace } from '../src/integrations/telegram-workspace.js';
import { TelegramDelivery } from '../src/integrations/telegram-delivery.js';
import { TelegramProgress } from '../src/integrations/telegram-progress.js';

afterEach(() => vi.restoreAllMocks());

it('pins one topic status card and edits it as the queue changes across restarts', async () => {
  vi.useFakeTimers();
  const f = daddyFixture();
  const sent: { method: string; body: Record<string, unknown> }[] = [];
  const api = new TelegramApi('123456:abcdefghijklmnopqrstuvwxyz123456', async (url, options) => {
    sent.push({ method: String(url).split('/').at(-1)!, body: JSON.parse(String(options?.body)) });
    return Response.json({ ok: true, result: { message_id: 100 + sent.length } });
  });
  const route = { chatId: -10042, threadId: 17, ownerId: 7 };
  f.store.setSetting('telegram.pairing', { chatId: 7, userId: 7 });
  f.store.setSetting('telegram.group', { chatId: route.chatId, ownerId: 7 });
  const integration = () => {
    api.delivery = new TelegramDelivery(f.store, api, 'fixture_bot');
    return new TelegramProgress(
      f.store,
      api,
      'telegram.progress:fixture_bot:',
      () => 'en',
      () => route,
    );
  };
  let progress = integration();
  const group = f.daddy.create({ workspaceId: f.workspace.id, title: 'Work' });
  const bindThread = (threadId: number) =>
    f.store.db
      .prepare('INSERT OR REPLACE INTO telegram_topics VALUES(?,?,?)')
      .run(
        `7:-10042:${group.id}`,
        group.id,
        JSON.stringify({ ...route, threadId, groupId: group.id }),
      );
  bindThread(route.threadId);
  try {
    progress.start();
    await vi.advanceTimersByTimeAsync(5000);
    await api.delivery!.flush();
    expect(sent[0]).toMatchObject({
      method: 'sendMessage',
      body: { message_thread_id: 17, text: expect.stringContaining('No work in progress') },
    });
    expect(sent[1]).toMatchObject({
      method: 'pinChatMessage',
      body: { chat_id: route.chatId, message_id: 101, disable_notification: true },
    });
    await progress.stop();
    await api.delivery!.stop();

    // The released version stored one progress record directly under the group key.
    const oldKey = `telegram.progress:fixture_bot:${group.id}`;
    f.store.db
      .prepare('UPDATE settings SET key=? WHERE key=?')
      .run(oldKey, oldKey + ':7:-10042:17');
    progress = integration();
    const task = await f.daddy.createTask(group.id, {
      requirements: 'Show in pin',
      requestId: 'task',
    });
    progress.start();
    await vi.advanceTimersByTimeAsync(5000);
    expect(sent.at(-1)).toMatchObject({
      method: 'editMessageText',
      body: { message_id: 101, text: expect.stringContaining(task.source!.key) },
    });
    const queued = f.store.jobs(task.id)[0]!;
    f.store.saveJob({ ...queued, status: 'completed' });
    f.store.saveTask({ ...task, state: 'complete' });
    await vi.advanceTimersByTimeAsync(5000);
    expect(sent.map(({ method }) => method)).toEqual([
      'sendMessage',
      'pinChatMessage',
      'editMessageText',
      'editMessageText',
    ]);
    expect(sent.at(-1)?.body).toMatchObject({
      message_id: 101,
      text: expect.stringContaining('All tasks complete'),
    });
    route.threadId = 18;
    bindThread(route.threadId);
    await vi.advanceTimersByTimeAsync(5000);
    await api.delivery!.flush();
    expect(
      sent
        .filter(({ method }) => method === 'sendMessage')
        .map(({ body }) => body.message_thread_id),
    ).toEqual([17, 18]);
    route.threadId = 17;
    bindThread(route.threadId);
    f.store.saveGroup({ ...f.store.getGroup(group.id), title: 'Returned to the original topic' });
    await vi.advanceTimersByTimeAsync(5000);
    await api.delivery!.flush();
    expect(sent.filter(({ method }) => method === 'sendMessage')).toHaveLength(2);
    expect(sent.at(-1)).toMatchObject({ method: 'editMessageText', body: { message_id: 101 } });
  } finally {
    await progress.stop();
    await api.delivery?.stop();
    await f.close();
    vi.useRealTimers();
  }
});

it('updates the initial private-chat card after /new as well', async () => {
  const f = daddyFixture();
  const sent: { method: string; body: Record<string, any> }[] = [];
  const api = new TelegramApi('123456:abcdefghijklmnopqrstuvwxyz123456', async (url, options) => {
    sent.push({ method: String(url).split('/').at(-1)!, body: JSON.parse(String(options?.body)) });
    return new Response(JSON.stringify({ ok: true, result: { message_id: sent.length } }));
  });
  api.delivery = new TelegramDelivery(f.store, api, 'fixture_bot');
  const workspace = new TelegramWorkspace(f.daddy, api, 'fixture_bot', () => 'en');
  f.store.setSetting('telegram.pairing', { chatId: 7, userId: 7 });
  const create = f.daddy.create.bind(f.daddy);
  vi.spyOn(f.daddy, 'create').mockImplementation((input) => {
    const group = create(input);
    group.workspacePreparation = { state: 'preparing' };
    f.store.saveGroup(group);
    return group;
  });
  const message = { chat: { id: 7, type: 'private' }, from: { id: 7 } };
  const click = (data: string, id: number) =>
    workspace.handle({
      update_id: id,
      callback_query: { id: String(id), from: { id: 7 }, data, message },
    });
  try {
    await workspace.handle({ update_id: 1, message: { ...message, text: '/new' } });
    await click(`dad:new:${f.workspace.id}`, 2);
    await click(sent.at(-1)!.body.reply_markup.inline_keyboard[0][0].callback_data, 3);
    const group = f.daddy.sessions()[0];
    const initial = sent.find(
      (item) => item.method === 'sendMessage' && item.body.text.includes(group.title),
    )!;
    const messageId = sent.indexOf(initial) + 1;
    expect(initial.body.text).toContain('Preparing');
    group.workspacePreparation = { state: 'ready' };
    f.store.saveGroup(group);
    workspace.onEvent({
      id: 4,
      taskId: group.id,
      type: 'daddy.workspace_ready',
      data: {},
      at: group.updatedAt,
    });
    await vi.waitFor(() =>
      expect(sent.filter((item) => item.method === 'editMessageText')).toHaveLength(1),
    );
    expect(sent.at(-1)!.body).toMatchObject({
      chat_id: 7,
      message_id: messageId,
      text: expect.stringContaining('ready'),
    });
    expect(
      sent.filter((item) => item.method === 'sendMessage' && item.body.text.includes(group.title)),
    ).toHaveLength(1);
  } finally {
    await workspace.stop();
    await api.delivery.stop();
    await f.close();
  }
});

it.each(['online', 'failed-edit', 'missed-event'])(
  'edits the session card after preparation and replay: %s',
  async (mode) => {
    const failEdit = mode === 'failed-edit';
    const f = daddyFixture(true);
    const sent: { method: string; body: Record<string, any> }[] = [];
    const boardSends = () =>
      sent.filter(
        (item) => item.method === 'sendMessage' && !item.body.text.includes('Server status'),
      );
    const boardEdits = () =>
      sent.filter((item) => item.method === 'editMessageText' && item.body.message_id === 102);
    let unavailable = false;
    let messageId = 100;
    let clock = Date.now();
    const api = new TelegramApi('123456:abcdefghijklmnopqrstuvwxyz123456', async (url, options) => {
      const method = String(url).split('/').at(-1)!;
      const body = JSON.parse(String(options?.body));
      sent.push({ method, body });
      if (method === 'editMessageText' && unavailable)
        return new Response('unavailable', { status: 503 });
      const result =
        method === 'createForumTopic'
          ? { message_thread_id: 17 }
          : { message_id: method === 'sendMessage' ? ++messageId : 0 };
      return new Response(JSON.stringify({ ok: true, result }));
    });
    const delivery = () => new TelegramDelivery(f.store, api, 'fixture_bot', () => clock);
    const integration = () => new TelegramWorkspace(f.daddy, api, 'fixture_bot', () => 'en');
    api.delivery = delivery();
    const send = vi.spyOn(api, 'send');
    let workspace = integration();
    f.store.setSetting('telegram.pairing', { chatId: 7, userId: 7 });
    f.store.setSetting('telegram.group', { chatId: -10042, title: 'Work', ownerId: 7 });
    try {
      const group = f.daddy.create({ workspaceId: f.workspace.id });
      group.workspacePreparation = { state: 'preparing' };
      f.store.saveGroup(group);
      workspace.onEvent({
        id: 1,
        taskId: group.id,
        type: 'daddy.created',
        data: {},
        at: group.updatedAt,
      });
      await vi.waitFor(() => expect(boardSends()).toHaveLength(1));
      expect(boardSends()[0]!.body).toMatchObject({
        chat_id: -10042,
        message_thread_id: 17,
        text: expect.stringContaining('Preparing'),
      });
      await api.delivery.flush();
      group.workspacePreparation = { state: 'ready' };
      group.updatedAt = new Date(Date.now() + 1000).toISOString();
      f.store.saveGroup(group);
      unavailable = failEdit;
      const ready = {
        id: 2,
        taskId: group.id,
        type: 'daddy.workspace_ready',
        data: {},
        at: group.updatedAt,
      };
      if (mode !== 'missed-event') {
        workspace.onEvent(ready);
        await vi.waitFor(() => expect(boardEdits()).toHaveLength(1));
      }
      await workspace.stop();
      await api.delivery.stop();
      if (failEdit) expect(api.delivery.status().pending).toBe(1);
      unavailable = false;
      clock += 600000;
      api.delivery = delivery();
      workspace = integration();
      await api.delivery.flush();
      const beforeReplay = send.mock.calls.length;
      workspace.replay();
      if (mode !== 'missed-event') workspace.onEvent(ready);
      await vi.waitFor(() =>
        expect(send).toHaveBeenCalledTimes(beforeReplay + (mode === 'missed-event' ? 2 : 3)),
      );
      await workspace.stop();
      await api.delivery.flush();
      expect(api.delivery.status().pending).toBe(0);
      expect(boardSends()).toHaveLength(1);
      const edits = boardEdits();
      expect(edits).toHaveLength(failEdit ? 2 : 1);
      expect(edits.at(-1)!.body).toMatchObject({
        chat_id: -10042,
        message_id: 102,
        text: expect.stringContaining('ready'),
      });
    } finally {
      await workspace.stop();
      await api.delivery.stop();
      await f.close();
    }
  },
);

it.each(['private', 'topic'])(
  'updates one progress card for a silent agent and reports failure in %s',
  async (mode) => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    const f = daddyFixture(true);
    const calls: { method: string; body: Record<string, any> }[] = [];
    const api = new TelegramApi('123456:abcdefghijklmnopqrstuvwxyz123456', async (url, options) => {
      const method = String(url).split('/').at(-1)!;
      calls.push({ method, body: JSON.parse(String(options?.body)) });
      return Response.json({
        ok: true,
        result:
          method === 'createForumTopic' ? { message_thread_id: 31 } : { message_id: calls.length },
      });
    });
    api.delivery = new TelegramDelivery(f.store, api, 'fixture_bot');
    let workspace = new TelegramWorkspace(f.daddy, api, 'fixture_bot', () => 'en');
    let finish!: () => void;
    const running = new Promise<void>((resolve) => {
      finish = resolve;
    });
    f.runtime.runSession.mockImplementation(async (input) => {
      if (mode === 'topic') {
        input.onSession('daddy-thread');
        input.onEvent('runtime.item', { aggregatedOutput: 'PRIVATE SHELL OUTPUT' });
      }
      await running;
      throw new Error('PRIVATE AGENT ERROR');
    });
    try {
      const group = f.daddy.create({ workspaceId: f.workspace.id, title: 'Fix search' });
      f.store.setSetting('telegram.pairing', { chatId: 7, userId: 7 });
      f.store.setSetting('telegram.currentDaddy', group.id);
      const topic = mode === 'topic';
      if (topic) {
        f.store.setSetting('telegram.group', { chatId: -10042, title: 'Work', ownerId: 7 });
        await workspace.ensureTopic(group);
      }
      f.daddy.chat(group.id, 'Fix the timeout', undefined, undefined, {
        channel: 'telegram',
        chatId: topic ? -10042 : 7,
        threadId: topic ? 31 : undefined,
      });
      workspace.start();
      await vi.advanceTimersByTimeAsync(5000);
      const initial = calls.find((call) =>
        call.body.text?.includes('Request saved. Waiting to start.'),
      );
      const firstStatus = calls.find(
        (call) => call.method === 'sendMessage' && call.body.text?.includes('Server status'),
      )!;
      expect(firstStatus.body.message_thread_id).toBe(topic ? 31 : undefined);
      const messageId = calls.indexOf(firstStatus) + 1;
      expect(initial).toMatchObject({
        method: topic ? 'editMessageText' : 'sendMessage',
        body: { chat_id: topic ? -10042 : 7, ...(topic ? { message_id: messageId } : {}) },
      });
      const edits = () =>
        calls.filter(
          (call) => call.method === 'editMessageText' && call.body.message_id === messageId,
        );

      f.daddy.tick();
      await vi.advanceTimersByTimeAsync(5000);
      expect(edits().at(-1)?.body.text).toContain('Codex · Handling your request');
      const activity = (text: string) =>
        text.split('\n').find((line) => line.startsWith('Last agent activity'));
      const first = edits().at(-1)?.body.text;
      if (topic) expect(activity(first)).toBeDefined();
      else expect(first).toContain('No agent activity received yet');

      await workspace.stop();
      await api.delivery.stop();
      api.delivery = new TelegramDelivery(f.store, api, 'fixture_bot');
      workspace = new TelegramWorkspace(f.daddy, api, 'fixture_bot', () => 'en');
      workspace.start();
      await vi.advanceTimersByTimeAsync(605000);
      const later = edits().at(-1)?.body.text;
      expect(later).toContain('10 min elapsed');
      expect(later).not.toBe(first);
      expect(activity(later)).toBe(activity(first));

      finish();
      await vi.advanceTimersByTimeAsync(5000);
      expect(edits().at(-1)?.body.text).toContain('Agent run failed');
      const afterFailure = edits().length;
      await vi.advanceTimersByTimeAsync(60000);
      expect(edits()).toHaveLength(afterFailure);
      expect(
        calls.filter(
          (call) => call.method === 'sendMessage' && call.body.text.includes('Server status'),
        ),
      ).toHaveLength(1);
      expect(calls.some((call) => call.body.text?.includes('PRIVATE'))).toBe(false);
    } finally {
      finish();
      await workspace.stop();
      await api.delivery.stop();
      await f.close();
      vi.useRealTimers();
    }
  },
);

it('keeps task entry on the home screen and opens configuration on demand', async () => {
  const f = daddyFixture();
  const api = new TelegramApi('123456:abcdefghijklmnopqrstuvwxyz123456', async () => {
    throw new Error('Expected mocked delivery');
  });
  const send = vi.spyOn(api, 'send').mockResolvedValue({ message_id: 1 });
  const workspace = new TelegramWorkspace(f.daddy, api, 'fixture_bot', () => 'ru');
  const destination = { chatId: 7 };
  const from = { id: 7 },
    chat = { id: 7, type: 'private' };
  const buttons = () =>
    (send.mock.lastCall?.[1] as { buttons: { callback_data: string }[][] }).buttons
      .flat()
      .map((button) => button.callback_data);
  try {
    const group = f.daddy.create({ workspaceId: f.workspace.id, title: 'Поиск' });
    f.store.setSetting('telegram.pairing', { chatId: 7, userId: 7 });
    await workspace.callback('dad:home', destination);
    expect(buttons()).toEqual(['dad:new', `dad:open:${group.id}`, 'dad:settings']);
    await workspace.callback('dad:settings', destination);
    expect(buttons()).toContain('dad:workspaces');
    expect(buttons()).toContain('notifications:show');

    await workspace.callback('dad:new', destination);
    await workspace.callback(`dad:open:${group.id}`, destination);
    expect(buttons()).toContain(`dad:status:${group.id}`);
    expect(buttons()).not.toContain(`dad:models:${group.id}`);
    await workspace.callback(`dad:settings:${group.id}`, destination);
    expect(buttons()).toContain(`dad:models:${group.id}`);

    await workspace.handle({ update_id: 1, message: { chat, from, text: 'Исправь поиск' } });
    expect(f.store.messages(group.id).map((message) => message.text)).toEqual(['Исправь поиск']);
    await workspace.handle({ update_id: 2, message: { chat, from, text: '/status' } });
    expect(send.mock.lastCall?.[1]).toMatchObject({
      text: expect.stringContaining('Запрос сохранён. Ждёт запуска.'),
    });
  } finally {
    await workspace.stop();
    await f.close();
  }
});
