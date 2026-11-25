import { expect, it, vi } from 'vitest';
import { assertTaskVersion, type PRRef } from '../src/core/types.js';
import { TelegramWorkspace } from '../src/integrations/telegram-workspace.js';
import type { TelegramApi, Update } from '../src/integrations/telegram.js';
import { daddyFixture } from './daddy-fixture.js';
import { rememberSecret } from '../src/core/security.js';

function telegramFixture() {
  const sent: { destination: any; card: any }[] = [];
  let topic = 40;
  const calls: { method: string; body: any }[] = [];
  const api = {
    replaceCard: async (_callback: unknown, action: () => Promise<unknown>) => action(),
    send: vi.fn(async (destination, card) => {
      sent.push({ destination, card });
      return { message_id: sent.length };
    }),
    call: vi.fn(async (method: string, body: any) => {
      calls.push({ method, body });
      if (method === 'createForumTopic') return { message_thread_id: ++topic };
      return true;
    }),
  } as unknown as TelegramApi;
  return { api, sent, calls };
}

it('redacts registered secrets from every group task card and button', async () => {
  const f = daddyFixture(),
    telegram = telegramFixture();
  let locale: 'en' | 'ru' = 'en';
  const bot = new TelegramWorkspace(f.daddy, telegram.api, 'fixture_bot', () => locale);
  const secret = rememberSecret('PRIVATE_TASK_MARKER_12345');
  f.store.setSetting('telegram.pairing', { chatId: 7, userId: 7 });
  f.store.setSetting('telegram.group', { chatId: -10042, title: 'Work', ownerId: 7 });
  const group = f.daddy.create({
      workspaceId: f.workspace.id,
      title: `Session ${secret}`,
      autoPush: false,
    }),
    topic = await bot.ensureTopic(group),
    task = await f.engine.create({
      ref: {
        provider: 'demo',
        host: 'demo.local',
        repo: 'test/repo',
        number: 55,
        url: 'https://demo.local/pull/55',
      },
      repoPath: f.dir,
      requirements: 'Keep group diagnostics private',
      groupId: group.id,
      groupGeneration: group.generation,
    });
  task.title = `Task ${secret}`;
  task.reason = `Question ${secret}`;
  task.state = 'awaiting_push';
  task.policy.autoPush = false;
  task.pendingAuthorHead = 'f'.repeat(40);
  task.pr!.checkDetails = [{ name: `Check ${secret}`, status: 'failed' }];
  f.store.saveTask(task);
  let id = 20;
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
  const click = (data: string, threadId?: number): Update => ({
    update_id: id++,
    callback_query: {
      id: String(id),
      data,
      from: { id: 7 },
      message: {
        chat: { id: -10042, type: 'supergroup' },
        message_thread_id: threadId,
      },
    },
  });
  const safe = () => expect(JSON.stringify(telegram.sent.at(-1)!.card)).not.toContain(secret);
  try {
    await bot.handle(message('/tasks', topic!.threadId));
    safe();
    await bot.handle(
      click(telegram.sent.at(-1)!.card.buttons[0][0].callback_data, topic!.threadId),
    );
    safe();
    const prepare = telegram.sent
      .at(-1)!
      .card.buttons.flat()
      .find((button: any) => button.text === 'Submit for review').callback_data;
    await bot.handle(click(prepare, topic!.threadId));
    safe();
    await bot.handle(
      click(telegram.sent.at(-1)!.card.buttons[1][0].callback_data, topic!.threadId),
    );
    safe();
    await bot.handle(message(`/task DADDY-${task.id.slice(0, 8)}`, topic!.threadId));
    safe();

    locale = 'ru';
    await bot.handle(message(`/session ${group.id.slice(0, 8)}`));
    safe();
    await bot.handle(message('/tasks'));
    safe();
    expect(JSON.stringify(telegram.sent.slice(-7).map((item) => item.card))).not.toContain(secret);
  } finally {
    await bot.stop();
    await f.close();
  }
});

it('binds a Telegram submit confirmation to its owner, topic, task and exact revision across retries and restart', async () => {
  const f = daddyFixture(true),
    telegram = telegramFixture();
  f.store.setSetting('telegram.pairing', { chatId: 7, userId: 7 });
  f.store.setSetting('telegram.group', { chatId: -10042, title: 'Work', ownerId: 7 });
  const group = f.daddy.create({ workspaceId: f.workspace.id, autoPush: false }),
    firstWorkspace = new TelegramWorkspace(f.daddy, telegram.api, 'fixture_bot', () => 'en'),
    topic = await firstWorkspace.ensureTopic(group),
    task = await f.tickets.local({
      workspace: f.workspace,
      groupId: group.id,
      groupGeneration: group.generation,
      title: 'Submit this change',
      requirements: 'Keep the manual submission gate',
      createdByAction: 'fixture',
    });
  task.state = 'ready_for_review';
  task.policy.autoPush = false;
  task.revision!.head = 'b'.repeat(40);
  task.pendingAuthorHead = task.revision!.head;
  f.store.saveTask(task);
  let effects = 0;
  vi.spyOn(f.tickets, 'submit').mockImplementation(async (id, expected) =>
    f.engine.lock(id, async () => {
      const current = f.store.getTask(id);
      assertTaskVersion(current, expected);
      if (current.ref.kind !== 'ticket' || current.state !== 'ready_for_review')
        throw new Error('Implementation is not ready for submission');
      effects++;
      current.ref = {
        kind: 'pull_request',
        provider: 'github',
        host: 'github.com',
        repo: 'test/repo',
        number: 17,
        url: 'https://github.com/test/repo/pull/17',
      } satisfies PRRef;
      current.state = 'queued';
      f.store.saveTask(current);
      return current;
    }),
  );
  let id = 100;
  const message = (text: string, user = 7, thread = topic!.threadId): Update => ({
    update_id: id++,
    message: {
      message_id: id,
      text,
      from: { id: user },
      chat: { id: -10042, type: 'supergroup' },
      message_thread_id: thread,
    },
  });
  const click = (data: string, user = 7, thread = topic!.threadId): Update => ({
    update_id: id++,
    callback_query: {
      id: String(id),
      data,
      from: { id: user },
      message: {
        chat: { id: -10042, type: 'supergroup' },
        message_thread_id: thread,
      },
    },
  });
  try {
    await firstWorkspace.handle(message('submit it now'));
    expect(effects).toBe(0);
    expect(f.store.messages(group.id).at(-1)?.text).toBe('submit it now');

    await firstWorkspace.handle(message('/tasks@fixture_bot'));
    const openTask = telegram.sent.at(-1)!.card.buttons[0][0].callback_data;
    await firstWorkspace.handle(click(openTask));
    expect(telegram.sent.at(-1)!.card.text).toContain('b'.repeat(40));
    const prepare = telegram.sent
      .at(-1)!
      .card.buttons.flat()
      .find((button: any) => button.text === 'Submit for review').callback_data;
    await firstWorkspace.handle(click(prepare));
    const staleConfirmation = telegram.sent.at(-1)!.card.buttons[0][0].callback_data;
    expect(telegram.sent.at(-1)!.card.text).toContain('Generation: 1');

    const changed = f.store.getTask(task.id);
    changed.generation++;
    changed.revision!.head = 'c'.repeat(40);
    changed.pendingAuthorHead = changed.revision!.head;
    f.store.saveTask(changed);
    await firstWorkspace.handle(click(staleConfirmation));
    expect(effects).toBe(0);
    expect(telegram.sent.some((item) => item.card.text?.includes('task changed'))).toBe(true);

    const currentCard = telegram.sent.at(-1)!.card;
    const currentPrepare = currentCard.buttons
      .flat()
      .find((button: any) => button.text === 'Submit for review').callback_data;
    await firstWorkspace.handle(click(currentPrepare));
    const confirmation = telegram.sent.at(-1)!.card.buttons[0][0].callback_data;
    expect(telegram.sent.at(-1)!.card.text).toContain('c'.repeat(40));

    await firstWorkspace.handle(click(confirmation, 99));
    await firstWorkspace.handle(click(confirmation, 7, topic!.threadId + 1));
    expect(effects).toBe(0);

    // bot_actions is persistent service state. Recreating the adapter simulates a restart
    // between showing the confirmation and receiving the click.
    const restarted = new TelegramWorkspace(f.daddy, telegram.api, 'fixture_bot', () => 'en');
    await Promise.all([
      restarted.handle(click(confirmation)),
      restarted.handle(click(confirmation)),
    ]);
    await restarted.handle(click(confirmation));
    expect(effects).toBe(1);
    expect(f.store.getTask(task.id).ref.kind).toBe('pull_request');
    expect(telegram.sent.some((item) => item.card.text?.includes('already completed'))).toBe(true);
    await restarted.stop();
  } finally {
    await firstWorkspace.stop();
    await f.close();
  }
});

it('persists cancellation and rejects a private confirmation after the selected session changes', async () => {
  const f = daddyFixture(),
    telegram = telegramFixture(),
    first = f.daddy.create({ workspaceId: f.workspace.id, title: 'Session A', autoPush: false }),
    second = f.daddy.create({ workspaceId: f.workspace.id, title: 'Session B', autoPush: false });
  f.store.setSetting('telegram.pairing', { chatId: 7, userId: 7 });
  f.store.setSetting('telegram.currentDaddy', first.id);
  const create = async (groupId: string, title: string) => {
    const task = await f.tickets.local({
      workspace: f.workspace,
      groupId,
      groupGeneration: f.daddy.group(groupId).generation,
      title,
      requirements: title,
      createdByAction: title,
    });
    task.state = 'ready_for_review';
    task.policy.autoPush = false;
    task.revision!.head = 'b'.repeat(40);
    task.pendingAuthorHead = task.revision!.head;
    f.store.saveTask(task);
    return task;
  };
  const firstTask = await create(first.id, 'Shared task title'),
    secondTask = await create(second.id, 'Shared task title');
  const submit = vi.spyOn(f.tickets, 'submit').mockResolvedValue(firstTask);
  let bot = new TelegramWorkspace(f.daddy, telegram.api, 'fixture_bot', () => 'en');
  let id = 350;
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
      .find((item: any) => item.text === text).callback_data;
  try {
    await bot.handle(message('/tasks'));
    await bot.handle(click(telegram.sent.at(-1)!.card.buttons[0][0].callback_data));
    await bot.handle(click(button('Submit for review')));
    const confirmation = button('Confirm: submit for review'),
      cancel = button('Cancel');
    expect(telegram.sent.at(-1)!.card.text).toContain('Session A');

    await bot.handle(click(cancel));
    expect(submit).not.toHaveBeenCalled();
    await bot.stop();
    bot = new TelegramWorkspace(f.daddy, telegram.api, 'fixture_bot', () => 'en');
    await bot.handle(click(confirmation));
    expect(submit).not.toHaveBeenCalled();
    expect(telegram.sent.at(-2)!.card.text).toContain('already stale');

    await bot.handle(message('/submit'));
    const freshConfirmation = button('Confirm: submit for review');
    expect(freshConfirmation).not.toBe(confirmation);
    await bot.handle(message(`/session ${second.id.slice(0, 8)}`));
    await bot.handle(click(freshConfirmation));
    expect(submit).not.toHaveBeenCalled();
    expect(telegram.sent.at(-1)!.card.text).toContain('selected session changed');
    expect(f.store.getTask(firstTask.id).state).toBe('ready_for_review');
    expect(f.store.getTask(secondTask.id).state).toBe('ready_for_review');
  } finally {
    await bot.stop();
    await f.close();
  }
});

it('requires an explicit session outside a topic and ignores commands for another bot', async () => {
  const f = daddyFixture(),
    telegram = telegramFixture(),
    bot = new TelegramWorkspace(f.daddy, telegram.api, 'fixture_bot', () => 'en');
  f.store.setSetting('telegram.pairing', { chatId: 7, userId: 7 });
  f.store.setSetting('telegram.group', { chatId: -10042, title: 'Work', ownerId: 7 });
  const first = f.daddy.create({ workspaceId: f.workspace.id, title: 'First session' }),
    second = f.daddy.create({ workspaceId: f.workspace.id, title: 'Second session' });
  await f.tickets.local({
    workspace: f.workspace,
    groupId: second.id,
    groupGeneration: second.generation,
    title: 'Second task',
    requirements: 'Work',
    createdByAction: 'fixture',
  });
  let id = 500;
  const message = (text: string): Update => ({
    update_id: id++,
    message: {
      message_id: id,
      text,
      from: { id: 7 },
      chat: { id: -10042, type: 'supergroup' },
    },
  });
  try {
    await bot.handle(message('/tasks'));
    expect(telegram.sent.at(-1)!.card.text).toContain('Choose a session');
    await bot.handle(message('/session Second session'));
    expect(telegram.sent.at(-1)!.card.text).toContain('Second session');
    expect(telegram.sent.at(-1)!.card.text).not.toContain('First session');
    await bot.handle(message('/status'));
    expect(telegram.sent.at(-1)!.card.text).toContain('Second session');
    const before = f.store.messages(second.id).length;
    await bot.handle(message('ordinary group message'));
    expect(f.store.messages(second.id)).toHaveLength(before);
    expect(telegram.sent.at(-1)!.card).toContain('Open a session topic');

    const sent = telegram.sent.length;
    await bot.handle(message('/help@another_bot'));
    expect(telegram.sent).toHaveLength(sent);
    await bot.handle(message('/help@fixture_bot'));
    expect(telegram.sent.at(-1)!.card.text).toContain('/session [name|ID]');
    expect(first.id).not.toBe(second.id);
  } finally {
    await bot.stop();
    await f.close();
  }
});

it('rejects an old selected session and confirmation after the topic is attached elsewhere', async () => {
  const f = daddyFixture(),
    telegram = telegramFixture(),
    bot = new TelegramWorkspace(f.daddy, telegram.api, 'fixture_bot', () => 'en');
  f.store.setSetting('telegram.pairing', { chatId: 7, userId: 7 });
  f.store.setSetting('telegram.group', { chatId: -10042, title: 'Work', ownerId: 7 });
  const first = f.daddy.create({ workspaceId: f.workspace.id, title: 'First session' }),
    second = f.daddy.create({ workspaceId: f.workspace.id, title: 'Second session' }),
    task = await f.tickets.local({
      workspace: f.workspace,
      groupId: first.id,
      groupGeneration: first.generation,
      title: 'First task',
      requirements: 'Keep topic routing exact',
      createdByAction: 'fixture',
    });
  task.state = 'ready_for_review';
  task.policy.autoPush = false;
  task.pendingAuthorHead = task.revision!.head;
  f.store.saveTask(task);
  const submit = vi.spyOn(f.tickets, 'submit').mockResolvedValue(task);
  let id = 700;
  const message = (text: string): Update => ({
    update_id: id++,
    message: {
      message_id: id,
      text,
      from: { id: 7 },
      chat: { id: -10042, type: 'supergroup' },
      message_thread_id: 77,
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
        message_thread_id: 77,
      },
    },
  });
  try {
    await bot.handle(message(`/session ${first.id.slice(0, 8)}`));
    const open = telegram.sent.at(-1)!.card.buttons[0][0].callback_data;
    await bot.handle(click(open));
    const prepare = telegram.sent
      .at(-1)!
      .card.buttons.flat()
      .find((button: any) => button.text === 'Submit for review').callback_data;
    await bot.handle(click(prepare));
    const confirm = telegram.sent.at(-1)!.card.buttons[0][0].callback_data;

    await bot.handle(message(`/attach ${second.id.slice(0, 8)}`));
    expect(f.store.setting('telegram.selectedSession:7:-10042:77')).toBeNull();
    await bot.handle(click(`dad:instructions:${first.id}`));
    expect(telegram.sent.at(-1)!.card.text).toContain('topic belonging to this daddy session');
    await bot.handle(click(confirm));
    expect(submit).not.toHaveBeenCalled();
    expect(telegram.sent.at(-1)!.card.text).toContain('topic belonging to this daddy session');
  } finally {
    await bot.stop();
    await f.close();
  }
});

it('holds and explicitly submits a saved PR fix exactly once in manual mode', async () => {
  const f = daddyFixture(),
    telegram = telegramFixture(),
    bot = new TelegramWorkspace(f.daddy, telegram.api, 'fixture_bot', () => 'en');
  f.store.setSetting('telegram.pairing', { chatId: 7, userId: 7 });
  const group = f.daddy.create({ workspaceId: f.workspace.id, autoPush: false });
  const task = await f.engine.create({
    ref: {
      provider: 'demo',
      host: 'demo.local',
      repo: 'test/repo',
      number: 72,
      url: 'https://demo.local/pull/72',
    },
    repoPath: f.dir,
    requirements: 'Submit the saved fix manually',
    groupId: group.id,
    groupGeneration: group.generation,
  });
  const saved = 'f'.repeat(40);
  task.state = 'awaiting_push';
  task.pendingAuthorHead = saved;
  f.store.saveTask(task);
  f.store.setSetting('telegram.currentDaddy', group.id);
  const push = vi.spyOn(f.tickets, 'pushFixes').mockImplementation(async (id, expected) => {
    const current = f.store.getTask(id);
    assertTaskVersion(current, expected);
    current.revision = { ...current.revision!, head: saved };
    f.store.saveTask(current);
    return current;
  });
  let id = 780;
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
    await bot.handle(message('/tasks'));
    await bot.handle(click(telegram.sent.at(-1)!.card.buttons[0][0].callback_data));
    const prepare = telegram.sent
      .at(-1)!
      .card.buttons.flat()
      .find((button: any) => button.text === 'Submit for review').callback_data;
    await bot.handle(click(prepare));
    const confirm = telegram.sent.at(-1)!.card.buttons[0][0].callback_data;
    expect(telegram.sent.at(-1)!.card.text).toContain(saved);
    await bot.handle(click(confirm));
    await bot.handle(click(confirm));
    expect(push).toHaveBeenCalledOnce();
    expect(push).toHaveBeenCalledWith(task.id, expect.objectContaining({ pendingHead: saved }));
  } finally {
    await bot.stop();
    await f.close();
  }
});

it('uses one selected task across task cards and accepts displayed DADDY IDs', async () => {
  const f = daddyFixture(),
    telegram = telegramFixture(),
    bot = new TelegramWorkspace(f.daddy, telegram.api, 'fixture_bot', () => 'en');
  f.store.setSetting('telegram.pairing', { chatId: 7, userId: 7 });
  const group = f.daddy.create({ workspaceId: f.workspace.id, autoPush: false });
  const create = (title: string) =>
    f.tickets.local({
      workspace: f.workspace,
      groupId: group.id,
      groupGeneration: group.generation,
      title,
      requirements: title,
      createdByAction: title,
    });
  const first = await create('Task A'),
    second = await create('Task B');
  first.state = 'ready_for_review';
  first.pendingAuthorHead = first.revision!.head = 'b'.repeat(40);
  second.state = 'ready_for_review';
  second.pendingAuthorHead = second.revision!.head = 'c'.repeat(40);
  f.store.saveTask(first);
  f.store.saveTask(second);
  f.store.setSetting('telegram.currentDaddy', group.id);
  let id = 860;
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
    await bot.handle(message('/tasks'));
    const firstButton = telegram.sent
      .at(-1)!
      .card.buttons.flat()
      .find((button: any) => button.text.includes('Task A')).callback_data;
    await bot.handle(click(firstButton));
    await bot.handle(message(`/task ${second.source!.key}`));
    await bot.handle(message('/submit'));
    expect(telegram.sent.at(-1)!.card.text).toContain('c'.repeat(40));

    await bot.handle(message(`/submit ${second.source!.key}`));
    expect(telegram.sent.at(-1)!.card.text).toContain('c'.repeat(40));
  } finally {
    await bot.stop();
    await f.close();
  }
});

it.each([
  ['ready_for_review', 'en'],
  ['needs_input', 'ru'],
  ['submitting', 'en'],
] as const)('offers submit for a saved ticket in %s (%s)', async (state, locale) => {
  const f = daddyFixture(),
    telegram = telegramFixture(),
    bot = new TelegramWorkspace(f.daddy, telegram.api, 'fixture_bot', () => locale);
  f.store.setSetting('telegram.pairing', { chatId: 7, userId: 7 });
  const group = f.daddy.create({ workspaceId: f.workspace.id, autoPush: false });
  const task = await f.tickets.local({
    workspace: f.workspace,
    groupId: group.id,
    groupGeneration: group.generation,
    title: `Retry ${state}`,
    requirements: 'Retry the same saved commit',
    createdByAction: state,
  });
  task.state = state;
  task.pendingAuthorHead = 'd'.repeat(40);
  f.store.saveTask(task);
  f.store.setSetting('telegram.currentDaddy', group.id);
  try {
    await bot.handle({
      update_id: 910,
      message: {
        message_id: 911,
        text: '/tasks',
        from: { id: 7 },
        chat: { id: 7, type: 'private' },
      },
    });
    const open = telegram.sent.at(-1)!.card.buttons[0][0].callback_data;
    await bot.handle({
      update_id: 912,
      callback_query: {
        id: 'open-retry',
        data: open,
        from: { id: 7 },
        message: { chat: { id: 7, type: 'private' } },
      },
    });
    expect(telegram.sent.at(-1)!.card.buttons.flat()).toContainEqual(
      expect.objectContaining({
        text: locale === 'ru' ? 'Отправить на ревью' : 'Submit for review',
      }),
    );

    task.pendingAuthorHead = undefined;
    f.store.saveTask(task);
    await bot.handle({
      update_id: 913,
      message: {
        message_id: 914,
        text: '/tasks',
        from: { id: 7 },
        chat: { id: 7, type: 'private' },
      },
    });
    await bot.handle({
      update_id: 915,
      callback_query: {
        id: 'open-without-saved-head',
        data: telegram.sent.at(-1)!.card.buttons[0][0].callback_data,
        from: { id: 7 },
        message: { chat: { id: 7, type: 'private' } },
      },
    });
    expect(telegram.sent.at(-1)!.card.buttons.flat()).not.toContainEqual(
      expect.objectContaining({
        text: locale === 'ru' ? 'Отправить на ревью' : 'Submit for review',
      }),
    );
  } finally {
    await bot.stop();
    await f.close();
  }
});

it.each([
  ['awaiting_plan_approval', 'plan', '/approve', 'approve-plan', undefined],
  ['awaiting_publication', 'code', '/publish', 'publish', undefined],
  [
    'awaiting_checks',
    'code',
    '/waive Offline integration checks passed',
    'waive-checks',
    'Offline integration checks passed',
  ],
] as const)(
  'routes the %s Telegram confirmation through the shared task action',
  async (state, kind, command, expectedAction, expectedReason) => {
    const f = daddyFixture(),
      telegram = telegramFixture(),
      bot = new TelegramWorkspace(f.daddy, telegram.api, 'fixture_bot', () => 'en');
    f.store.setSetting('telegram.pairing', { chatId: 7, userId: 7 });
    const group = f.daddy.create({ workspaceId: f.workspace.id }),
      task = await f.tickets.local({
        workspace: f.workspace,
        groupId: group.id,
        groupGeneration: group.generation,
        title: `Action ${expectedAction}`,
        requirements: 'Keep the explicit human gate',
        createdByAction: 'fixture',
      });
    task.state = state;
    task.kind = kind;
    task.policy.publication = 'human';
    f.store.saveTask(task);
    f.store.setSetting('telegram.currentDaddy', group.id);
    const action = vi.spyOn(f.daddy, 'taskAction').mockResolvedValue(task);
    let id = 900;
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
      await bot.handle(message('/tasks'));
      const open = telegram.sent.at(-1)!.card.buttons[0][0].callback_data;
      await bot.handle(click(open));
      const explicit =
        expectedAction === 'waive-checks'
          ? `/waive ${task.source!.key} -- Offline integration checks passed`
          : `${command} ${task.source!.key}`;
      await bot.handle(message(explicit));
      expect(telegram.sent.at(-1)!.card.text).toContain(task.revision!.head);
      await bot.handle(message(command));
      const confirm = telegram.sent.at(-1)!.card.buttons[0][0].callback_data;
      await bot.handle(click(confirm));
      expect(action).toHaveBeenCalledWith(
        group.id,
        task.id,
        expectedAction,
        { head: task.revision!.head, generation: task.generation },
        expectedReason,
      );
    } finally {
      await bot.stop();
      await f.close();
    }
  },
);
