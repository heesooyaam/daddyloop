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
  const messages = vi.spyOn(f.store, 'messages');
  try {
    messages.mockClear();
    await bot.handle(message('/status', topic!.threadId));
    safe();
    expect(messages).not.toHaveBeenCalled();
    await bot.handle(click(`dad:open:${group.id}`, topic!.threadId));
    safe();
    await bot.handle(message(`/task Queue ${secret}`, topic!.threadId));
    safe();
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
    await bot.handle(click(`dad:open:${group.id}`));
    safe();
    await bot.handle(message('/tasks'));
    safe();
    messages.mockClear();
    f.store.setSetting('telegram.currentDaddy', group.id);
    await bot.handle({
      update_id: id++,
      message: {
        message_id: id,
        text: '/status',
        from: { id: 7 },
        chat: { id: 7, type: 'private' },
      },
    });
    expect(JSON.stringify(telegram.sent.at(-1)!.card)).toContain(secret);
    expect(messages).not.toHaveBeenCalled();
  } finally {
    await bot.stop();
    await f.close();
  }
});

it('opens complete local task requirements from a group through the paired private chat', async () => {
  const f = daddyFixture(),
    telegram = telegramFixture(),
    bot = new TelegramWorkspace(f.daddy, telegram.api, 'fixture_bot', () => 'en');
  f.store.setSetting('telegram.pairing', { chatId: 7, userId: 7 });
  f.store.setSetting('telegram.group', { chatId: -10042, title: 'Work', ownerId: 7 });
  const group = f.daddy.create({ workspaceId: f.workspace.id }),
    topic = await bot.ensureTopic(group),
    requirements = 'Short title\n\nAcceptance criterion only visible in the full requirements.',
    task = await f.tickets.local({
      workspace: f.workspace,
      groupId: group.id,
      groupGeneration: group.generation,
      title: 'Short title',
      requirements,
      createdByAction: 'requirements-fixture',
    });
  f.store.message(task.id, 'author', 'agent', 'First worker report from the task.');
  f.store.message(task.id, 'reviewer', 'agent', 'Final reviewer summary for the task.');
  let id = 1500;
  const message = (text: string, chatId: number, threadId?: number): Update => ({
    update_id: id++,
    message: {
      message_id: id,
      text,
      from: { id: 7 },
      chat: { id: chatId, type: chatId === 7 ? 'private' : 'supergroup' },
      message_thread_id: threadId,
    },
  });
  try {
    await bot.handle(message(`/task DADDY-${task.id.slice(0, 8)}`, -10042, topic!.threadId));
    const groupCard = telegram.sent.at(-1)!.card;
    expect(groupCard.text).not.toContain('Acceptance criterion');
    const open = groupCard.buttons
      .flat()
      .find((button: any) => button.text === 'View task details');
    expect(open.url).toContain(`start=task_${task.id}`);

    await bot.handle(message(`/start task_${task.id}`, 7));
    expect(telegram.sent.at(-1)!.card.text).toContain(
      'Acceptance criterion only visible in the full requirements.',
    );
    expect(telegram.sent.at(-1)!.card.text).toContain('First worker report from the task.');
    expect(telegram.sent.at(-1)!.card.text).toContain('Final reviewer summary for the task.');
    expect(f.store.setting('telegram.currentDaddy')).toBe(group.id);
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
        expect.any(String),
      );
    } finally {
      await bot.stop();
      await f.close();
    }
  },
);

it('recovers a plan approval when its confirmation receipt write is interrupted', async () => {
  const f = daddyFixture(),
    telegram = telegramFixture(),
    bot = new TelegramWorkspace(f.daddy, telegram.api, 'fixture_bot', () => 'en');
  f.store.setSetting('telegram.pairing', { chatId: 7, userId: 7 });
  const group = f.daddy.create({ workspaceId: f.workspace.id }),
    task = await f.engine.create({
      ref: {
        provider: 'demo',
        host: 'demo.local',
        repo: 'test/repo',
        number: 63,
        url: 'https://demo.local/pull/63',
      },
      repoPath: f.dir,
      requirements: 'Approve one exact plan',
      groupId: group.id,
      groupGeneration: group.generation,
    });
  task.kind = 'plan';
  task.state = 'awaiting_plan_approval';
  f.store.saveTask(task);
  f.store.setSetting('telegram.currentDaddy', group.id);
  let id = 930;
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
    await bot.handle(message('/approve'));
    const confirmation = telegram.sent.at(-1)!.card.buttons[0][0].callback_data,
      actionId = confirmation.slice('dad:task:'.length),
      event = f.store.event.bind(f.store);
    let failReceipt = true;
    vi.spyOn(f.store, 'event').mockImplementation((taskId, type, data, runId) => {
      if (type === 'human.task_action' && failReceipt) {
        failReceipt = false;
        throw new Error('fixture receipt write failed');
      }
      return event(taskId, type, data, runId);
    });
    await bot.handle(click(confirmation));
    expect(f.store.getTask(task.id).state).toBe('complete');
    expect(
      f.store.db
        .prepare("SELECT 1 FROM events WHERE task_id=? AND run_id=? AND type='human.task_action'")
        .get(task.id, actionId),
    ).toBeTruthy();
  } finally {
    await bot.stop();
    await f.close();
  }
});

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

it('does not reuse a completed waiver receipt for another reason', async () => {
  const f = daddyFixture(),
    telegram = telegramFixture(),
    bot = new TelegramWorkspace(f.daddy, telegram.api, 'fixture_bot', () => 'en');
  f.store.setSetting('telegram.pairing', { chatId: 7, userId: 7 });
  const group = f.daddy.create({ workspaceId: f.workspace.id }),
    task = await f.engine.create({
      ref: {
        provider: 'demo',
        host: 'demo.local',
        repo: 'test/repo',
        number: 64,
        url: 'https://demo.local/pull/64',
      },
      repoPath: f.dir,
      requirements: 'Keep waiver receipts distinct',
      groupId: group.id,
      groupGeneration: group.generation,
    });
  task.state = 'awaiting_checks';
  f.store.saveTask(task);
  f.store.setSetting('telegram.currentDaddy', group.id);
  let id = 1200;
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
    await bot.handle(message('/waive First offline verification'));
    const first = telegram.sent.at(-1)!.card.buttons[0][0].callback_data;
    await bot.handle(message('/waive Different reason'));
    const second = telegram.sent.at(-1)!.card.buttons[0][0].callback_data;
    const event = f.store.event.bind(f.store);
    let failReceipt = true;
    vi.spyOn(f.store, 'event').mockImplementation((taskId, type, data, runId) => {
      if (type === 'human.task_action' && failReceipt) {
        failReceipt = false;
        throw new Error('fixture receipt write failed');
      }
      return event(taskId, type, data, runId);
    });
    await bot.handle(click(first));
    await bot.handle(click(second));
    const waivers = f.store.events(task.id).filter((event) => event.type === 'checks.waived');
    expect(waivers).toHaveLength(1);
    expect(waivers[0]!.data).toMatchObject({ reason: 'First offline verification' });
    const secondId = second.slice('dad:task:'.length);
    expect(
      f.store.db.prepare('SELECT consumed FROM bot_actions WHERE id=?').get(secondId)!.consumed,
    ).toBe(0);
    expect(String(telegram.sent.at(-1)!.card.text ?? telegram.sent.at(-1)!.card)).not.toContain(
      'Done: allow CI waiver',
    );
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
    const confirmation = telegram.sent.at(-1)!.card.buttons[0][0].callback_data;
    const event = f.store.event.bind(f.store);
    let failReceipt = true;
    vi.spyOn(f.store, 'event').mockImplementation((taskId, type, data, runId) => {
      if (type === 'human.task_action' && failReceipt) {
        failReceipt = false;
        throw new Error('fixture receipt write failed');
      }
      return event(taskId, type, data, runId);
    });
    await bot.handle(click(confirmation));
    expect(f.store.activeJobs(task.id)).toMatchObject([{ kind: 'verify_merge', role: 'reviewer' }]);
    const receiptId = confirmation.slice('dad:task:'.length),
      saved = f.store.db.prepare('SELECT data FROM bot_actions WHERE id=?').get(receiptId);
    const control = JSON.parse(String(saved!.data));
    delete control.outcome;
    f.store.db
      .prepare('UPDATE bot_actions SET data=?,consumed=0 WHERE id=?')
      .run(JSON.stringify(control), receiptId);
    f.store.db
      .prepare("DELETE FROM events WHERE task_id=? AND run_id=? AND type='human.task_action'")
      .run(task.id, receiptId);
    await bot.handle(click(confirmation));
    expect(f.store.activeJobs(task.id)).toHaveLength(1);
    expect(
      JSON.parse(
        String(f.store.db.prepare('SELECT data FROM bot_actions WHERE id=?').get(receiptId)!.data),
      ).outcome,
    ).toBe('completed');
  } finally {
    await bot.stop();
    await f.close();
  }
});

it('shows the same GitHub retry status when a task is opened from tasks or queue', async () => {
  const f = daddyFixture(),
    telegram = telegramFixture(),
    bot = new TelegramWorkspace(f.daddy, telegram.api, 'fixture_bot', () => 'en');
  f.store.setSetting('telegram.pairing', { chatId: 7, userId: 7 });
  const group = f.daddy.create({ workspaceId: f.workspace.id }),
    task = await f.engine.create({
      ref: {
        provider: 'demo',
        host: 'demo.local',
        repo: 'test/repo',
        number: 77,
        url: 'https://demo.local/pull/77',
      },
      repoPath: f.dir,
      requirements: 'Show one retry time everywhere',
      groupId: group.id,
      groupGeneration: group.generation,
    });
  task.ref = {
    provider: 'github',
    host: 'github.com',
    repo: 'test/repo',
    number: 77,
    url: 'https://github.com/test/repo/pull/77',
  };
  task.state = 'submitting';
  const taskUntil = Date.now() + 60_000;
  task.prLink = {
    ref: task.ref,
    head: task.revision!.head,
    generation: task.generation,
    retryAt: taskUntil,
  };
  f.store.saveTask(task);
  const until = Date.now() + 24 * 60 * 60_000;
  f.store.setSetting('github.read-backoff:github.com', {
    until,
    delay: 15_000,
    status: 503,
  });
  f.store.setSetting('telegram.currentDaddy', group.id);
  let id = 1300;
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
  const webStatus = () =>
    f.daddy.board(group.id).tasks.find((item) => item.id === task.id)!.statusLabel;
  const openFromTasks = async () => {
    await bot.handle(message('/tasks'));
    await bot.handle(click(telegram.sent.at(-1)!.card.buttons[0][0].callback_data));
    return telegram.sent.at(-1)!.card.text as string;
  };
  try {
    const sharedRetry = webStatus();
    expect(await openFromTasks()).toContain(sharedRetry);
    await bot.handle(message('/queue'));
    expect(telegram.sent.at(-1)!.card.text).toContain(sharedRetry);

    f.store.setSetting('github.read-backoff:github.com', null);
    const localRetry = webStatus();
    expect(await openFromTasks()).toContain(localRetry);
    await bot.handle(message('/queue'));
    expect(telegram.sent.at(-1)!.card.text).toContain(localRetry);

    delete task.prLink.retryAt;
    f.store.saveTask(task);
    expect(await openFromTasks()).not.toContain('retry at');
    expect(webStatus()).not.toContain('retry at');
  } finally {
    await bot.stop();
    await f.close();
  }
});
