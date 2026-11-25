import { expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { daddyFixture } from './daddy-fixture.js';
import { catalogue } from './planning-fixture.js';
import { Telegram, TelegramApi, type Update } from '../src/integrations/telegram.js';
import { UpdateMonitor } from '../src/core/updates.js';
import { setLocale } from '../src/core/preferences.js';
import { registerDaddy } from '../src/server/daddy.js';
import { taskReference } from '../src/core/task-activity.js';
import { queueCard } from '../src/integrations/telegram-tasks.js';
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
    expect(lastText()).toContain('Worker 2\ncodex · gpt-5.6-sol · medium');
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
    f.store.saveJob({ ...firstRun!, status: 'completed', startedAt: started(90) });
    const reviewing = { ...task!, state: 'reviewing', generation: task!.generation + 1 } as const;
    f.store.saveTask(reviewing);
    const review = f.store.enqueue(reviewing, 'reviewer', 'review', '');
    f.store.saveJob({ ...review, status: 'running', startedAt: started(5) });
    await bot.handle(message('/queue'));
    expect(lastText()).toContain(
      'Reviewing the changes · 90 min since work began\nShared reviewer · 5 min elapsed · Requested author worker 2',
    );
    f.store.saveJob({ ...review, status: 'completed', startedAt: started(5) });
    for (const state of ['awaiting_checks', 'awaiting_merge', 'needs_input', 'paused'] as const) {
      f.store.saveTask({ ...reviewing, state });
      await bot.handle(message('/queue'));
      expect(lastText()).toContain('90 min since work began');
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
    'Syncing the GitHub draft',
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
    const task = { id: randomUUID(), title: 'Search', state: 'implementing', reason: '' } as Task;
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
          reason:
            'Waiting to confirm the GitHub draft or its target branch before restarting review.',
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
