import { expect, it, vi } from 'vitest';
import { assertTaskVersion, type PRRef } from '../src/core/types.js';
import { TelegramWorkspace } from '../src/integrations/telegram-workspace.js';
import type { TelegramApi, Update } from '../src/integrations/telegram.js';
import { daddyFixture } from './daddy-fixture.js';

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

it('requires an explicit session outside a topic and installs separate private/group command menus', async () => {
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
    await bot.syncCommands();
    expect(telegram.calls.filter((call) => call.method === 'setMyCommands')).toEqual([
      expect.objectContaining({
        body: expect.objectContaining({ scope: { type: 'all_private_chats' } }),
      }),
      expect.objectContaining({
        body: expect.objectContaining({ scope: { type: 'chat', chat_id: -10042 } }),
      }),
    ]);
    const privateCommands = telegram.calls[0].body.commands.map((item: any) => item.command);
    const groupCommands = telegram.calls[1].body.commands.map((item: any) => item.command);
    expect(privateCommands).toContain('updates');
    expect(groupCommands).not.toContain('updates');
    expect(groupCommands).toEqual(expect.arrayContaining(['help', 'tasks', 'submit']));

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
    expect(telegram.sent.at(-1)!.card.text).toContain('general topic');
    expect(telegram.sent.at(-1)!.card.text).toContain('/command@fixture_bot');
    expect(first.id).not.toBe(second.id);
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
      await bot.handle(message(`/task ${task.id.slice(0, 8)}`));
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
