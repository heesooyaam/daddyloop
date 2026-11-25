import { expect, it, vi } from 'vitest';
import { TelegramWorkspace } from '../src/integrations/telegram-workspace.js';
import type { TelegramApi, Update } from '../src/integrations/telegram.js';
import { daddyFixture } from './daddy-fixture.js';
import { rememberSecret } from '../src/core/security.js';

function telegramFixture() {
  const sent: { destination: any; card: any }[] = [];
  let topic = 40;
  const api = {
    replaceCard: async (_callback: unknown, action: () => Promise<unknown>) => action(),
    send: vi.fn(async (destination, card) => {
      sent.push({ destination, card });
      return { message_id: sent.length };
    }),
    call: vi.fn(async (method: string) =>
      method === 'createForumTopic' ? { message_thread_id: ++topic } : true,
    ),
  } as unknown as TelegramApi;
  return { api, sent };
}

it('redacts registered secrets from every group task card and button', async () => {
  const f = daddyFixture(),
    telegram = telegramFixture();
  let locale: 'en' | 'ru' = 'en';
  const bot = new TelegramWorkspace(f.daddy, telegram.api, 'fixture_bot', () => locale);
  const secret = rememberSecret('PRIVATE_TASK_MARKER_12345');
  f.store.setSetting('telegram.pairing', { chatId: 7, userId: 7 });
  f.store.setSetting('telegram.group', { chatId: -10042, title: 'Work', ownerId: 7 });
  const group = f.daddy.create({ workspaceId: f.workspace.id, title: `Session ${secret}` }),
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
  task.state = 'needs_input';
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
    await bot.handle(message(`/task DADDY-${task.id.slice(0, 8)}`, topic!.threadId));
    safe();
    locale = 'ru';
    await bot.handle(message(`/session ${group.id.slice(0, 8)}`));
    safe();
    await bot.handle(message('/tasks'));
    safe();
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
  f.daddy.create({ workspaceId: f.workspace.id, title: 'First session' });
  const second = f.daddy.create({ workspaceId: f.workspace.id, title: 'Second session' });
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
    await bot.handle(message('/status'));
    expect(telegram.sent.at(-1)!.card.text).toContain('Second session');
    const before = f.store.messages(second.id).length;
    await bot.handle(message('ordinary group message'));
    expect(f.store.messages(second.id)).toHaveLength(before);
    const sent = telegram.sent.length;
    await bot.handle(message('/help@another_bot'));
    expect(telegram.sent).toHaveLength(sent);
  } finally {
    await bot.stop();
    await f.close();
  }
});

it.each([
  ['awaiting_plan_approval', 'plan', '/approve', 'approve-plan', undefined],
  [
    'awaiting_checks',
    'code',
    '/waive Offline integration checks passed',
    'waive-checks',
    'Offline integration checks passed',
  ],
] as const)(
  'routes the %s Telegram confirmation through the shared safe task action',
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
        requirements: 'Keep the explicit safe action gate',
        createdByAction: 'fixture',
      });
    task.state = state;
    task.kind = kind;
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
      await bot.handle(click(telegram.sent.at(-1)!.card.buttons[0][0].callback_data));
      await bot.handle(message(command));
      await bot.handle(click(telegram.sent.at(-1)!.card.buttons[0][0].callback_data));
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

it('rejects legacy submit and publish commands and confirmation records', async () => {
  const f = daddyFixture(),
    telegram = telegramFixture(),
    bot = new TelegramWorkspace(f.daddy, telegram.api, 'fixture_bot', () => 'en');
  f.store.setSetting('telegram.pairing', { chatId: 7, userId: 7 });
  const group = f.daddy.create({ workspaceId: f.workspace.id }),
    task = await f.tickets.local({
      workspace: f.workspace,
      groupId: group.id,
      groupGeneration: group.generation,
      title: 'Automatic workflow',
      requirements: 'Do not expose removed manual actions',
      createdByAction: 'fixture',
    });
  f.store.setSetting('telegram.currentDaddy', group.id);
  const submit = vi.spyOn(f.tickets, 'submit'),
    publish = vi.spyOn(f.engine, 'publish');
  let id = 1000;
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
    await bot.handle(message('/submit'));
    await bot.handle(message('/publish'));
    const legacyId = 'abcdefghijklmnop';
    f.store.db.prepare('INSERT INTO bot_actions(id,data) VALUES(?,?)').run(
      legacyId,
      JSON.stringify({
        kind: 'confirm',
        destination: { chatId: 7 },
        ownerId: 7,
        groupId: group.id,
        taskId: task.id,
        action: 'submit',
        expectedHead: task.revision!.head,
        expectedGeneration: task.generation,
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      }),
    );
    await bot.handle(click(`dad:task:${legacyId}`));
    expect(telegram.sent.at(-1)!.card.text).toContain('not available');
    expect(submit).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  } finally {
    await bot.stop();
    await f.close();
  }
});

it('binds merge verification to the selected session and exact task version', async () => {
  const f = daddyFixture(),
    telegram = telegramFixture(),
    bot = new TelegramWorkspace(f.daddy, telegram.api, 'fixture_bot', () => 'en');
  f.store.setSetting('telegram.pairing', { chatId: 7, userId: 7 });
  const first = f.daddy.create({ workspaceId: f.workspace.id, title: 'Session A' }),
    second = f.daddy.create({ workspaceId: f.workspace.id, title: 'Session B' }),
    task = await f.engine.create({
      ref: {
        provider: 'demo',
        host: 'demo.local',
        repo: 'test/repo',
        number: 88,
        url: 'https://demo.local/pull/88',
      },
      repoPath: f.dir,
      requirements: 'Verify the merged result',
      groupId: first.id,
      groupGeneration: first.generation,
    });
  task.state = 'needs_input';
  f.store.saveTask(task);
  const remote = task.pr!;
  f.store.setSetting('demo-pr:' + task.ref.number, {
    ...remote,
    state: 'merged',
    head: task.revision!.head,
    checks: 'pending',
    mergeCommit: 'c'.repeat(40),
  });
  f.store.setSetting('telegram.currentDaddy', first.id);
  let id = 1100;
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
  const openTask = async () => {
    await bot.handle(message('/tasks'));
    await bot.handle(click(telegram.sent.at(-1)!.card.buttons[0][0].callback_data));
  };
  try {
    await bot.handle(click(`dad:merge:${task.id}:${task.generation}`));
    expect(f.store.activeJobs(task.id)).toHaveLength(0);

    await openTask();
    const prepare = telegram.sent
      .at(-1)!
      .card.buttons.flat()
      .find((button: any) => button.text === 'Verify merge');
    expect(prepare).toBeTruthy();
    await bot.handle(click(prepare.callback_data));
    const staleConfirmation = telegram.sent.at(-1)!.card.buttons[0][0].callback_data;
    await bot.handle(message(`/session ${second.id.slice(0, 8)}`));
    await bot.handle(click(staleConfirmation));
    expect(f.store.activeJobs(task.id)).toHaveLength(0);

    await bot.handle(message(`/session ${first.id.slice(0, 8)}`));
    await openTask();
    const freshPrepare = telegram.sent
      .at(-1)!
      .card.buttons.flat()
      .find((button: any) => button.text === 'Verify merge');
    await bot.handle(click(freshPrepare.callback_data));
    await bot.handle(click(telegram.sent.at(-1)!.card.buttons[0][0].callback_data));
    expect(f.store.activeJobs(task.id)).toMatchObject([{ kind: 'verify_merge', role: 'reviewer' }]);
  } finally {
    await bot.stop();
    await f.close();
  }
});
