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
  } finally {
    await progress.stop();
    await api.delivery?.stop();
    await f.close();
    vi.useRealTimers();
  }
});

it.each(['en', 'ru'] as const)(
  'reuses one pinned status card per route after switching back and restarting: %s',
  async (locale) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const f = daddyFixture();
    const sent: { method: string; body: Record<string, any> }[] = [];
    let nextMessageId = 100;
    const api = new TelegramApi('123456:abcdefghijklmnopqrstuvwxyz123456', async (url, options) => {
      const method = String(url).split('/').at(-1)!;
      const body = JSON.parse(String(options?.body));
      sent.push({ method, body });
      return Response.json({
        ok: true,
        result: method === 'sendMessage' ? { message_id: ++nextMessageId } : true,
      });
    });
    const privateRoute = { chatId: 7, ownerId: 7 };
    const topicRoute = { chatId: -10042, threadId: 17, ownerId: 7 };
    let route = privateRoute;
    f.store.setSetting('telegram.pairing', { chatId: 7, userId: 7 });
    const integration = () => {
      api.delivery = new TelegramDelivery(f.store, api, 'fixture_bot');
      return new TelegramProgress(
        f.store,
        api,
        'telegram.progress:fixture_bot:',
        () => locale,
        () => route,
      );
    };
    const group = f.daddy.create({ workspaceId: f.workspace.id, title: 'Route status' });
    let progress = integration();
    try {
      await progress.ensure(group.id);
      await api.delivery!.flush(10);
      const progressKey = `telegram.progress:fixture_bot:${group.id}`;
      const firstFormat = f.store.setting<{ cards: unknown[] }>(progressKey)!;
      f.store.setSetting(progressKey, firstFormat.cards[0]);
      f.store.setSetting('telegram.group', { chatId: -10042, ownerId: 7 });
      route = topicRoute;
      vi.setSystemTime(new Date('2026-01-01T00:01:00.000Z'));
      await progress.ensure(group.id);
      await api.delivery!.flush(10);
      await progress.stop();
      await api.delivery!.stop();

      progress = integration();
      f.store.setSetting('telegram.group', null);
      route = privateRoute;
      vi.setSystemTime(new Date('2026-01-01T00:02:00.000Z'));
      await progress.ensure(group.id);
      await api.delivery!.flush(10);
      f.store.setSetting('telegram.group', { chatId: -10042, ownerId: 7 });
      route = topicRoute;
      vi.setSystemTime(new Date('2026-01-01T00:03:00.000Z'));
      await progress.ensure(group.id);
      await api.delivery!.flush(10);

      expect(sent.map(({ method }) => method)).toEqual([
        'sendMessage',
        'pinChatMessage',
        'sendMessage',
        'pinChatMessage',
        'editMessageText',
        'editMessageText',
      ]);
      expect(
        sent
          .filter(({ method }) => method === 'pinChatMessage')
          .map(({ body }) => [body.chat_id, body.message_id]),
      ).toEqual([
        [7, 101],
        [-10042, 102],
      ]);
      expect(
        sent
          .filter(({ method }) => method === 'editMessageText')
          .map(({ body }) => [body.chat_id, body.message_id]),
      ).toEqual([
        [7, 101],
        [-10042, 102],
      ]);
      expect(sent.some(({ method }) => method.startsWith('unpin'))).toBe(false);
    } finally {
      await progress.stop();
      await api.delivery?.stop();
      await f.close();
      vi.useRealTimers();
    }
  },
);

it.each([
  [
    'en',
    'private chat to topic',
    { chatId: 7, ownerId: 7 },
    { chatId: -10042, threadId: 17, ownerId: 7 },
  ],
  [
    'ru',
    'topic to private chat',
    { chatId: -10042, threadId: 17, ownerId: 7 },
    { chatId: 7, ownerId: 7 },
  ],
] as const)(
  'serializes a slow status refresh while switching %s: %s',
  async (locale, _direction, initialRoute, nextRoute) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const f = daddyFixture();
    let finishFirst = () => {};
    const first = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    const sent: { destination: typeof initialRoute | typeof nextRoute; key?: string }[] = [];
    let block = true;
    const api = {
      send: vi.fn(async (destination, _card, _buttons, options) => {
        sent.push({ destination, key: options?.key });
        if (block) {
          block = false;
          await first;
        }
        return { message_id: sent.length };
      }),
    } as unknown as TelegramApi;
    let route: typeof initialRoute | typeof nextRoute = initialRoute;
    const progress = new TelegramProgress(
      f.store,
      api,
      'telegram.progress:fixture_bot:',
      () => locale,
      () => route,
    );
    const group = f.daddy.create({ workspaceId: f.workspace.id, title: 'Slow status' });
    group.workspacePreparation = { state: 'preparing' };
    f.store.saveGroup(group);
    try {
      progress.start();
      const initial = progress.ensure(group.id);
      await vi.waitFor(() => expect(sent).toHaveLength(1));
      route = nextRoute;
      await vi.advanceTimersByTimeAsync(5000);
      expect(sent).toHaveLength(1);
      finishFirst();
      await initial;
      await vi.advanceTimersByTimeAsync(5000);
      await vi.waitFor(() => expect(sent).toHaveLength(2));
      await vi.advanceTimersByTimeAsync(5000);
      expect(sent).toHaveLength(2);
      route = initialRoute;
      vi.setSystemTime(new Date('2026-01-01T00:01:00.000Z'));
      await progress.ensure(group.id);
      expect(sent).toHaveLength(3);
      expect(sent.map(({ key }) => key)).toEqual([sent[0].key, sent[1].key, sent[0].key]);
    } finally {
      finishFirst();
      await progress.stop();
      await f.close();
      vi.useRealTimers();
    }
  },
);

it.each([
  ['en', false],
  ['ru', true],
] as const)(
  'retries the first pin for an unchanged topic card after reconnect: %s, restart=%s',
  async (locale, restart) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const f = daddyFixture();
    const sent: { method: string; body: Record<string, any> }[] = [];
    let nextMessageId = 500;
    const api = new TelegramApi('123456:abcdefghijklmnopqrstuvwxyz123456', async (url, options) => {
      const method = String(url).split('/').at(-1)!;
      const body = JSON.parse(String(options?.body));
      sent.push({ method, body });
      return Response.json({
        ok: true,
        result: method === 'sendMessage' ? { message_id: ++nextMessageId } : true,
      });
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
        () => locale,
        () => route,
      );
    };
    const group = f.daddy.create({ workspaceId: f.workspace.id, title: 'Unchanged card' });
    let progress = integration();
    try {
      await progress.ensure(group.id);
      f.store.setSetting('telegram.group', null);
      await api.delivery!.flush(10);
      expect(sent.map(({ method }) => method)).toEqual(['sendMessage']);
      if (restart) {
        await progress.stop();
        await api.delivery!.stop();
        progress = integration();
      }
      f.store.setSetting('telegram.group', { chatId: route.chatId, ownerId: 7 });
      await progress.ensure(group.id);
      await api.delivery!.flush(10);
      expect(sent.map(({ method }) => method)).toEqual(['sendMessage', 'pinChatMessage']);
      expect(sent[1].body).toMatchObject({
        chat_id: route.chatId,
        message_id: 501,
        disable_notification: true,
      });
    } finally {
      await progress.stop();
      await api.delivery?.stop();
      await f.close();
      vi.useRealTimers();
    }
  },
);

it.each([
  ['en', 'queued private card', { chatId: 7, ownerId: 7 }, 'queued'],
  ['ru', 'topic card with a denied pin', { chatId: -10042, threadId: 17, ownerId: 7 }, 'pin'],
] as const)(
  'cancels unsent status work after the session is deleted: %s, %s',
  async (locale, _case, route, mode) => {
    const f = daddyFixture();
    const sent: { method: string; body: Record<string, any> }[] = [];
    let clock = 1000;
    let nextMessageId = 600;
    const api = new TelegramApi('123456:abcdefghijklmnopqrstuvwxyz123456', async (url, options) => {
      const method = String(url).split('/').at(-1)!;
      const body = JSON.parse(String(options?.body));
      sent.push({ method, body });
      if (method === 'pinChatMessage' && mode === 'pin')
        return new Response(
          JSON.stringify({
            ok: false,
            error_code: 400,
            description: 'Bad Request: not enough rights to pin a message',
          }),
          { status: 400 },
        );
      return Response.json({
        ok: true,
        result: method === 'sendMessage' ? { message_id: ++nextMessageId } : true,
      });
    });
    f.store.setSetting('telegram.pairing', { chatId: 7, userId: 7 });
    if ('threadId' in route)
      f.store.setSetting('telegram.group', { chatId: route.chatId, ownerId: 7 });
    if (mode === 'queued') f.store.setSetting('telegram.deliveryLimit:fixture_bot', clock + 60000);
    api.delivery = new TelegramDelivery(f.store, api, 'fixture_bot', () => clock);
    const progress = new TelegramProgress(
      f.store,
      api,
      'telegram.progress:fixture_bot:',
      () => locale,
      () => route,
    );
    const group = f.daddy.create({ workspaceId: f.workspace.id, title: 'Deleted status' });
    try {
      await progress.ensure(group.id);
      if (mode === 'pin') await api.delivery.flush(10);
      const deleted = f.store.getGroup(group.id);
      f.store.saveGroup({ ...deleted, deletedAt: new Date().toISOString() });
      clock += 60 * 60 * 1000;
      await api.delivery.flush(20);
      await progress.ensure(group.id);
      await api.delivery.flush(20);
      expect(sent.map(({ method }) => method)).toEqual(
        mode === 'pin' ? ['sendMessage', 'pinChatMessage'] : [],
      );
      await api.delivery.stop();
      api.delivery = new TelegramDelivery(f.store, api, 'fixture_bot', () => clock);
      await api.delivery.flush(20);
      expect(sent.map(({ method }) => method)).toEqual(
        mode === 'pin' ? ['sendMessage', 'pinChatMessage'] : [],
      );
    } finally {
      await progress.stop();
      await api.delivery?.stop();
      await f.close();
    }
  },
);

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
    const initial = sent.filter(
      (item) => item.method === 'sendMessage' && item.body.text.includes(group.title),
    );
    const status = initial.find((item) => item.body.text.includes('Server status'))!;
    const board = initial.find((item) => !item.body.text.includes('Server status'))!;
    const statusId = sent.indexOf(status) + 1;
    const boardId = sent.indexOf(board) + 1;
    expect(status.body.text).toContain('Preparing');
    expect(board.body.text).toContain('Preparing');
    await api.delivery.flush();
    expect(sent.find((item) => item.method === 'pinChatMessage')?.body).toMatchObject({
      chat_id: 7,
      message_id: statusId,
      disable_notification: true,
    });
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
      expect(sent.filter((item) => item.method === 'editMessageText')).toHaveLength(2),
    );
    const edits = sent.filter((item) => item.method === 'editMessageText');
    expect(edits.map((item) => item.body.message_id)).toEqual([statusId, boardId]);
    expect(edits[0].body.text).not.toContain('Preparing');
    expect(edits[1].body.text).toContain('ready');
    expect(initial).toHaveLength(2);
  } finally {
    await workspace.stop();
    await api.delivery.stop();
    await f.close();
  }
});

it.each(['online', 'failed-edit', 'missed-event'])(
  'edits the session and pinned status cards after preparation and replay: %s',
  async (mode) => {
    const failEdit = mode === 'failed-edit';
    const f = daddyFixture(true);
    const sent: { method: string; body: Record<string, any> }[] = [];
    let unavailable = false;
    let clock = Date.now();
    const api = new TelegramApi('123456:abcdefghijklmnopqrstuvwxyz123456', async (url, options) => {
      const method = String(url).split('/').at(-1)!;
      const body = JSON.parse(String(options?.body));
      sent.push({ method, body });
      if (method === 'editMessageText' && unavailable)
        return new Response('unavailable', { status: 503 });
      const result =
        method === 'createForumTopic' ? { message_thread_id: 17 } : { message_id: 101 };
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
      await vi.waitFor(() =>
        expect(sent.filter((item) => item.method === 'sendMessage')).toHaveLength(2),
      );
      const initial = sent.filter((item) => item.method === 'sendMessage');
      expect(
        initial.every(
          (item) =>
            item.body.chat_id === -10042 &&
            item.body.message_thread_id === 17 &&
            item.body.text.includes('Preparing'),
        ),
      ).toBe(true);
      expect(initial.filter((item) => item.body.text.includes('Server status'))).toHaveLength(1);
      await api.delivery.flush();
      expect(sent.filter((item) => item.method === 'pinChatMessage')).toHaveLength(1);
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
        await vi.waitFor(() =>
          expect(sent.filter((item) => item.method === 'editMessageText')).toHaveLength(2),
        );
      }
      await workspace.stop();
      await api.delivery.stop();
      if (failEdit) expect(api.delivery.status().pending).toBe(2);
      unavailable = false;
      clock += 600000;
      api.delivery = delivery();
      workspace = integration();
      await api.delivery.flush();
      const beforeReplay = send.mock.calls.length;
      workspace.replay();
      if (mode !== 'missed-event') workspace.onEvent(ready);
      await vi.waitFor(() =>
        expect(send).toHaveBeenCalledTimes(beforeReplay + (mode === 'missed-event' ? 2 : 4)),
      );
      await workspace.stop();
      await api.delivery.flush();
      expect(api.delivery.status().pending).toBe(0);
      expect(sent.filter((item) => item.method === 'sendMessage')).toHaveLength(2);
      expect(sent.filter((item) => item.method === 'pinChatMessage')).toHaveLength(1);
      const edits = sent.filter((item) => item.method === 'editMessageText');
      expect(edits).toHaveLength(failEdit ? 4 : 2);
      expect(edits.at(-1)!.body).toMatchObject({
        chat_id: -10042,
        message_id: 101,
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
      expect(initial).toMatchObject({
        method: 'sendMessage',
        body: { chat_id: topic ? -10042 : 7 },
      });
      expect(initial?.body.message_thread_id).toBe(topic ? 31 : undefined);
      const messageId = calls.indexOf(initial!) + 1;
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
