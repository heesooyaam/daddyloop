import { expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { daddyFixture } from './daddy-fixture.js';
import { catalogue } from './planning-fixture.js';
import { Telegram, TelegramApi, type Update } from '../src/integrations/telegram.js';
import { UpdateMonitor } from '../src/core/updates.js';
import { setLocale } from '../src/core/preferences.js';
import { registerDaddy } from '../src/server/daddy.js';
import { draftSyncPending, taskReference } from '../src/core/task-activity.js';
import { githubActivityStatus } from '../src/core/auto-merge.js';
import { queueCard } from '../src/integrations/telegram-tasks.js';
import { translate } from '../src/i18n/index.js';
import type { Job, Task } from '../src/core/types.js';

it('shares task IDs, the queue and worker profiles between Telegram and the web API', async () => {
  const f = daddyFixture();
  const app = Fastify();
  registerDaddy(app, f.daddy);
  const sent: { method: string; body: Record<string, unknown> }[] = [];
  const api = new TelegramApi('123456:abcdefghijklmnopqrstuvwxyz123456', async (url, request) => {
    sent.push({ method: String(url).split('/').at(-1)!, body: JSON.parse(String(request?.body)) });
    return Response.json({ ok: true, result: { message_id: sent.length } });
  });
  const bot = new Telegram(f.engine, api, 'fixture_bot');
  bot.configure({ daddy: f.daddy, catalogue, updates: new UpdateMonitor(f.store, { agents: [] }) });
  setLocale(f.store, 'en');
  f.store.setSetting('telegram.pairing', { chatId: 7, userId: 7 });
  f.store.setSetting('telegram.group', { chatId: -10042, title: 'Work', ownerId: 7 });
  const group = f.daddy.create({ workspaceId: f.workspace.id, workerLimit: 2 });
  const session = `/api/daddy/sessions/${group.id}`;
  let updateId = 0;
  const message = (text: string, user = 7, topic = 17): Update => ({
    update_id: ++updateId,
    message: {
      message_id: updateId,
      chat: { id: -10042, type: 'supergroup' },
      message_thread_id: topic,
      from: { id: user },
      text,
    },
  });
  const lastText = () => sent.filter(({ method }) => method === 'sendMessage').at(-1)?.body.text;
  try {
    await bot.handle(message(`/attach ${group.id.slice(0, 8)}`));
    const command =
      '/task@fixture_bot --worker 2 --model gpt-5.6-sol --effort medium -- Fix search\nKeep old filters.';
    await bot.handle(message(command, 7, 18));
    await bot.handle(message(command, 99));
    await bot.handle(message(command.replace('@fixture_bot', '@other_bot')));
    expect(f.store.tasks(group.id)).toHaveLength(0);

    const update = message(command);
    vi.spyOn(f.store, 'enqueue').mockImplementationOnce(() => {
      throw Object.assign(new Error('SQLite write failed'), { code: 'ERR_SQLITE_ERROR' });
    });
    await expect(bot.handle(update)).rejects.toThrow('SQLite write failed');
    expect(f.store.tasks(group.id)).toHaveLength(0);
    expect(
      f.store.db.prepare('SELECT 1 FROM bot_receipts WHERE id=?').get(update.update_id),
    ).toBeUndefined();

    await bot.handle(update);
    await bot.handle(update);
    await bot.handle({ ...update, update_id: ++updateId });
    await api.delivery!.flush();
    const [task] = f.store.tasks(group.id);
    expect(f.store.tasks(group.id)).toHaveLength(1);
    expect(task).toMatchObject({
      requirements: 'Fix search\nKeep old filters.',
      state: 'implementing',
      workerRequest: {
        slot: 2,
        profile: { engine: 'codex', model: 'gpt-5.6-sol', effort: 'medium' },
      },
    });
    expect(f.store.jobs(task!.id)).toMatchObject([{ kind: 'implement', status: 'queued' }]);
    expect(f.store.daddyJobs(group.id)).toHaveLength(0);
    const id = task!.source!.key;
    expect(lastText()).toContain(id);
    expect(sent.filter(({ body }) => String(body.text).startsWith('Task queued'))).toHaveLength(1);

    await bot.handle(message('/queue'));
    expect(lastText()).toContain(`Fix search\n${id} · Waiting for a worker\nRequested worker 2`);
    expect(lastText()).not.toContain('since work began');
    await bot.handle(message(`/task ${id}`));
    expect(lastText()).toContain('Requested worker 2\ncodex · gpt-5.6-sol · medium');
    await bot.handle(message('/worker 1 gpt-6-astra max'));
    await bot.handle(message('/workers'));
    expect(lastText()).toContain('Worker 1 · codex · gpt-6-astra · max\nFree');

    const web = (await app.inject(session)).json();
    expect(web.taskQueue).toEqual([task!.id]);
    expect(web.tasks[0]).toMatchObject({ id: task!.id, statusLabel: 'Waiting for a worker' });
    expect(web.workers.slots[0]).toMatchObject({
      profile: { model: 'gpt-6-astra', effort: 'max' },
    });

    const click = (data: string, user = 7, topic = 17): Update => ({
      update_id: ++updateId,
      callback_query: {
        id: String(updateId),
        data,
        from: { id: user },
        message: {
          chat: { id: -10042, type: 'supergroup' },
          message_thread_id: topic,
        },
      },
    });
    await bot.handle(click(`dad:sm:${group.id}:on`, 99));
    expect((await app.inject(session)).json().group.autoMerge).toBe(false);
    await bot.handle(click(`dad:sm:${group.id}:on`));
    expect((await app.inject(session)).json().tasks[0].autoMerge).toMatchObject({
      mode: 'inherit',
      enabled: true,
    });
    await bot.handle(click(`dad:tm:${task!.id}:off`, 7, 18));
    expect((await app.inject(session)).json().tasks[0].autoMerge.mode).toBe('inherit');
    await bot.handle(click(`dad:tm:${task!.id}:off`));
    expect((await app.inject(session)).json().tasks[0].autoMerge).toMatchObject({
      mode: 'off',
      enabled: false,
    });
    const policyResponse = await app.inject({
      method: 'POST',
      url: session + '/tasks/' + task!.id + '/auto-merge',
      payload: { mode: 'inherit' },
    });
    expect(policyResponse.statusCode).toBe(200);
    await bot.handle(message(`/task ${id}`));
    expect(lastText()).toContain('Auto-merge GitHub PRs · On');

    const input = { requirements: 'Task from web', requestId: randomUUID() };
    const enqueue = () => app.inject({ method: 'POST', url: session + '/tasks', payload: input });
    const queuedFromWeb = await enqueue();
    expect(queuedFromWeb.statusCode).toBe(201);
    const webTask = queuedFromWeb.json();
    expect((await enqueue()).json()).toEqual(webTask);
    expect((await app.inject(session)).json().taskQueue).toEqual([task!.id, webTask.id]);
    await bot.handle(message('/queue'));
    expect(lastText()).toContain('Task from web\n' + taskReference(webTask));

    for (let i = 3; i <= 10; i++) {
      const response = await app.inject({
        method: 'POST',
        url: session + '/tasks',
        payload: { requirements: `Queue task ${i}`, requestId: randomUUID() },
      });
      expect(response.statusCode).toBe(201);
    }
    await bot.handle(message('/queue'));
    expect(lastText()).toContain('Task queue · 1/2');
    expect(lastText()).not.toContain('Queue task 10');
    await bot.handle(click(`dad:queue:${group.id}:1`));
    expect(lastText()).toContain('Task queue · 2/2\n\nQueue task 10');
    const tenth = f.store.tasks(group.id).find((task) => task.title === 'Queue task 10')!;
    const openTenth = `dad:task:${tenth.id}:1`;
    const lastCard = sent.filter(({ method }) => method === 'sendMessage').at(-1)?.body;
    expect(lastCard?.reply_markup).toMatchObject({
      inline_keyboard: [
        [{ callback_data: openTenth }],
        [{ callback_data: `dad:queue:${group.id}:0` }],
        [{ callback_data: `dad:open:${group.id}` }],
      ],
    });
    await bot.handle(click(openTenth));
    expect(lastText()).toContain(`${taskReference(tenth)}  Queue task 10`);
    const detailCard = sent.filter(({ method }) => method === 'sendMessage').at(-1)?.body;
    const backToQueue = `dad:queue:${group.id}:1`;
    expect(detailCard?.reply_markup).toMatchObject({
      inline_keyboard: expect.arrayContaining([
        expect.arrayContaining([expect.objectContaining({ callback_data: backToQueue })]),
      ]),
    });
    await bot.handle(click(backToQueue));
    expect(lastText()).toContain('Task queue · 2/2\n\nQueue task 10');
    const withPr: Task = {
      ...tenth,
      state: 'needs_input',
      ref: { ...tenth.ref, kind: 'pull_request', number: 10 },
      revision: { head: 'b'.repeat(40), base: 'a'.repeat(40), start: 'a'.repeat(40) },
    };
    f.store.saveTask(withPr);
    const action = vi.spyOn(f.engine, 'action').mockResolvedValueOnce(withPr);
    await bot.handle(click(openTenth));
    const callbacks = () => {
      const last = sent.filter(({ method }) => method === 'sendMessage').at(-1)?.body;
      return (
        last?.reply_markup as { inline_keyboard: { callback_data: string }[][] }
      ).inline_keyboard
        .flat()
        .map(({ callback_data }) => callback_data);
    };
    for (const mode of ['on', 'off', 'inherit']) {
      const button = callbacks().find((data) => data.startsWith(`dad:tm:${tenth.id}:${mode}`))!;
      await bot.handle(click(button));
      expect(callbacks()).toContain(backToQueue);
    }
    const verifyButton = callbacks().find((data) => data.startsWith('dad:vm:'))!;
    expect(Buffer.byteLength(verifyButton)).toBeLessThanOrEqual(64);
    await bot.handle(click(verifyButton));
    expect(action).toHaveBeenCalledWith(withPr.id, 'verify-merge', '', {
      groupId: group.id,
      head: withPr.revision!.head,
      generation: withPr.generation,
    });
    expect(callbacks()).toContain(backToQueue);
    action.mockRestore();
    f.store.saveTask({ ...tenth, state: 'complete' });
    await bot.handle(click(backToQueue));
    expect(lastText()).toContain('Task queue\n\nFix search');

    const configured = await app.inject({
      method: 'POST',
      url: session + '/workers/1',
      payload: { profile: { engine: 'codex', model: 'gpt-5.6-sol', effort: 'medium' } },
    });
    expect(configured.statusCode).toBe(200);
    await bot.handle(message('/workers'));
    expect(lastText()).toContain('Worker 1 · codex · gpt-5.6-sol · medium\nFree');

    const started = (minutes: number) =>
      new Date(Date.now() - (minutes * 60 + 20) * 1000).toISOString();
    const [firstRun] = f.store.jobs(task!.id);
    f.store.saveJob({ ...firstRun!, status: 'cancelled' });
    const discussing = { ...task!, state: 'discussing' } as const;
    f.store.saveTask(discussing);
    await f.engine.chat(task!.id, 'author', 'Inspect the filters and propose a plan.');
    const [chat] = f.store.activeJobs(task!.id);
    const until = Date.now() + 60_000;
    for (const backoff of [
      {
        key: 'github.quota:',
        setting: { until, delay: 60_000 },
        expected: 'Waiting for GitHub quota',
        reason: 'Waiting for GitHub API quota until',
      },
      {
        key: 'github.read-backoff:',
        setting: { until, delay: 60_000, status: 503 },
        expected: 'GitHub HTTP 503',
        reason: 'GitHub HTTP 503',
      },
    ]) {
      const key = backoff.key + task!.ref.host;
      f.store.setSetting(key, backoff.setting);
      for (const state of [
        'implementing',
        'discussing',
        'needs_input',
        'awaiting_plan_approval',
      ] as const) {
        f.store.saveTask({ ...discussing, state });
        await bot.handle(message('/queue'));
        expect(lastText()).toContain(`${id} · ${backoff.expected}`);
        expect(lastText()).toContain('UTC');
        expect(lastText()).not.toContain('since work began');
        await bot.handle(click(`dad:task:${task!.id}`));
        expect(lastText()).toContain(`Fix search\n${backoff.expected}`);
        expect(lastText()).toContain(backoff.reason);
        expect(lastText()).toContain('UTC');
      }
      setLocale(f.store, 'ru');
      const waiting = translate('ru', backoff.expected);
      await bot.handle(message('/queue'));
      expect(lastText()).toContain(`${id} · ${waiting}`);
      await bot.handle(click(`dad:task:${task!.id}`));
      expect(lastText()).toContain(`Fix search\n${waiting}`);
      expect(lastText()).toContain('UTC');
      setLocale(f.store, 'en');
      f.store.saveTask(discussing);
      f.store.saveJob({ ...chat!, status: 'running', startedAt: started(95) });
      await bot.handle(message('/queue'));
      expect(lastText()).toContain(`${id} · Task discussion in progress · 95 min since work began`);
      await bot.handle(click(`dad:task:${task!.id}`));
      expect(lastText()).toContain('Fix search\nTask discussion in progress\nWorker');
      f.store.saveJob(chat!);
      f.store.setSetting(key, null);
    }
    f.store.saveJob({ ...chat!, status: 'completed', startedAt: started(95) });
    f.store.saveJob({ ...firstRun!, status: 'completed', startedAt: started(90) });
    for (const item of f.store.tasks(group.id))
      if (item.id !== task!.id && item.id !== webTask.id)
        f.store.saveTask({ ...item, state: 'complete' });
    const reviewing = { ...task!, state: 'reviewing', generation: task!.generation + 1 } as const;
    f.store.saveTask(reviewing);
    const review = f.store.enqueue(reviewing, 'reviewer', 'review', '');
    f.store.saveJob({ ...review, status: 'running', startedAt: started(5) });
    f.store.setSetting('github.quota:' + task!.ref.host, { until, delay: 60_000 });
    await bot.handle(message('/queue'));
    expect(lastText()).toContain(
      'Reviewing the changes · 95 min since work began\nShared reviewer · 5 min elapsed · Requested author worker 2',
    );
    for (const locale of ['en', 'ru'] as const) {
      setLocale(f.store, locale);
      const stage = translate(locale, 'Reviewing the changes');
      const reviewer = translate(locale, 'Shared reviewer');
      const author = translate(locale, 'Requested author worker {number}', { number: 2 });
      await bot.handle(message('/queue'));
      expect(lastText()).toContain(`${id} · ${stage}`);
      expect(lastText()).toContain(reviewer);
      expect(lastText()).toContain(author);
      await bot.handle(click(`dad:task:${task!.id}`));
      expect(lastText()).toContain(`Fix search\n${stage}\n${reviewer} · `);
      expect(lastText()).toContain(author);
      await bot.handle(message('/status'));
      expect(lastText()).toContain(`${id} Fix search · ${stage}`);
    }
    expect((await app.inject(session)).json().tasks).toContainEqual(
      expect.objectContaining({ id: task!.id, statusLabel: 'Reviewing the changes' }),
    );
    setLocale(f.store, 'en');
    f.store.setSetting('github.quota:' + task!.ref.host, null);
    f.store.saveJob({ ...review, status: 'completed', startedAt: started(5) });
    for (const state of ['awaiting_checks', 'awaiting_merge', 'needs_input', 'paused'] as const) {
      f.store.saveTask({ ...reviewing, state });
      await bot.handle(message('/queue'));
      expect(lastText()).toContain('95 min since work began');
      expect(lastText()).not.toContain('5 min elapsed');
    }
  } finally {
    await app.close();
    await bot.stop();
    await f.close();
  }
});

it('shows the current run time and keeps status details on their own line', () => {
  const now = Date.parse('2026-11-25T12:04:30Z');
  const task = {
    id: '12345678-0000-0000-0000-000000000000',
    title: 'Починить поиск',
    state: 'fixing',
    fixingMergeConflict: true,
    workerRequest: { slot: 2 },
  } as Task;
  const job = { status: 'running', role: 'author', startedAt: '2026-11-25T12:00:00Z' } as Job;
  const card = queueCard('ru', 'session', [{ task, job, assignedWorker: 2 }], { now });
  expect(card.text).toBe(
    'Очередь задач\n\nПочинить поиск\n' +
      'DADDY-12345678 · Конфликт слияния\nВоркер 2 · 4 мин с запуска\n' +
      'Воркер разрешает конфликт слияния',
  );
  expect(
    card.entities.map(({ type, offset, length }) => [
      type,
      card.text.slice(offset, offset + length),
    ]),
  ).toEqual([
    ['bold', 'Очередь задач'],
    ['bold', 'Починить поиск'],
    ['code', 'DADDY-12345678'],
    ['italic', 'Воркер разрешает конфликт слияния'],
  ]);
  const waiting = queueCard('en', 'session', [{ task, job: { ...job, status: 'queued' } }], {
    now,
  });
  expect(waiting.text).toContain('Waiting for a worker\nRequested worker 2\n');
  expect(waiting.text).not.toContain('elapsed');
});

it.each([
  [
    'en',
    'Waiting to start',
    'Waiting for GitHub quota',
    'Checking the GitHub draft',
    'Checking GitHub auto-merge',
    'Shared reviewer · 5 min elapsed',
  ],
  [
    'ru',
    'Ждёт запуска',
    'Ждёт квоту GitHub',
    'Сверяет черновик с GitHub',
    'Проверяется автослияние PR',
    'Общий ревьюер · 5 мин с запуска',
  ],
] as const)(
  'shows the effective queue status and the current reviewer in %s',
  (locale, assigned, quota, sync, merge, reviewer) => {
    const now = Date.parse('2026-11-25T12:05:30Z');
    const task = {
      id: randomUUID(),
      title: 'Search',
      generation: 1,
      state: 'implementing',
      reason: '',
    } as Task;
    const job = { status: 'queued', role: 'author' } as Job;
    const render = (item: Parameters<typeof queueCard>[2][number]) =>
      queueCard(locale, 'session', [item], { now }).text;
    const line = taskReference(task) + ' · ';
    expect(render({ task, job, assignedWorker: 2 })).toContain(line + assigned + '\n');
    expect(
      render({ task, job, mergeStatus: 'Waiting for GitHub API quota until 12:34 UTC' }),
    ).toContain(line + quota + '\n');
    expect(
      render({
        task: {
          ...task,
          state: 'needs_input',
          reason: draftSyncPending,
        },
      }),
    ).toContain(line + sync);
    expect(
      render({
        task: { ...task, state: 'complete', pr: { state: 'open' } as Task['pr'] },
        mergeStatus: 'Checking GitHub auto-merge',
      }),
    ).toContain(line + merge);
    const reviewJob = {
      ...job,
      status: 'running',
      role: 'reviewer',
      startedAt: '2026-11-25T12:00:00Z',
    } as const;
    const reviewingTask = { ...task, state: 'reviewing' } as const;
    for (const item of [
      { task: reviewingTask },
      { task: reviewingTask, assignedWorker: 2 },
      { task: { ...reviewingTask, workerRequest: { slot: 2 } } },
    ]) {
      expect(render({ ...item, job: reviewJob })).toContain('\n' + reviewer);
    }
  },
);

it('shows GitHub recovery and owner questions while keeping private reviewer text out of the queue', () => {
  const task = {
    id: randomUUID(),
    title: 'Search',
    generation: 2,
    state: 'submitting',
    prLink: { head: 'saved-head', generation: 2 },
  } as Task;
  const until = Date.parse('2026-11-25T12:34:56Z');
  const mergeStatus = githubActivityStatus(
    task,
    { mode: 'inherit', enabled: false, result: undefined },
    {
      kind: 'read',
      status: 503,
      until,
      delay: 1_000,
    },
  );
  const recovery = queueCard('en', 'session', [{ task, mergeStatus }]);
  expect(recovery.text).toContain(
    'GitHub HTTP 503 · retry at 12:34:56 UTC\nChecking GitHub for the result of the previous PR creation',
  );

  const blocked: Task = {
    ...task,
    state: 'needs_input',
    resumeState: 'reviewing',
    reason: 'Private reviewer text',
  };
  const hidden = queueCard('en', 'session', [{ task: blocked }]);
  expect(hidden.text).toContain('Action needed');
  expect(hidden.text).not.toContain(blocked.reason);
  const question: Task = {
    ...blocked,
    reason: 'Should the old filters remain available?',
    inputRequest: { role: 'reviewer', runId: 'review', generation: blocked.generation },
  };
  expect(queueCard('en', 'session', [{ task: question }]).text).toContain(
    'Waiting for your answer\nShould the old filters remain available?',
  );
});
