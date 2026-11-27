import { InstructionPresets } from '../src/core/instruction-presets.js';
import { taskRequestKey } from '../src/integrations/telegram-reminders.js';
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
import { AppError, prRef as taskPrRef, type Job, type Task } from '../src/core/types.js';
import { DemoProvider } from '../src/providers/demo.js';

it('shares task IDs, the queue and worker profiles between Telegram and the web API', async () => {
  const f = daddyFixture(true);
  const app = Fastify();
  registerDaddy(app, f.daddy);
  const sent: { method: string; body: Record<string, unknown> }[] = [];
  const localBotApi = Fastify();
  const imported = { daddy: { prompt: 'From Telegram' }, worker: {} };
  const documents: string[] = [];
  localBotApi.addContentTypeParser(
    /^multipart\/form-data/,
    { parseAs: 'string' },
    (_request, body, done) => {
      documents.push(String(body));
      done(null, {});
    },
  );
  localBotApi.get('/instructions.json', async () => imported);
  localBotApi.post<{ Params: { method: string }; Body: Record<string, unknown> }>(
    '/:method',
    async (request) => {
      sent.push({ method: request.params.method, body: request.body });
      if (request.params.method === 'getFile')
        return { ok: true, result: { file_path: 'instructions.json' } };
      return { ok: true, result: { message_id: sent.length } };
    },
  );
  const origin = await localBotApi.listen({ host: '127.0.0.1', port: 0 });
  const createBot = () => {
    const api = new TelegramApi('123456:abcdefghijklmnopqrstuvwxyz123456', (url, request) =>
      fetch(origin + '/' + String(url).split('/').at(-1), request),
    );
    const bot = new Telegram(f.engine, api, 'fixture_bot');
    bot.configure({
      daddy: f.daddy,
      catalogue,
      updates: new UpdateMonitor(f.store, { agents: [] }),
    });
    const receive = bot.handle.bind(bot);
    vi.spyOn(bot, 'handle').mockImplementation(async (update) => {
      await receive(update);
      await api.delivery!.flush();
    });
    return { api, bot };
  };
  let { api, bot } = createBot();

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
      '/task@fixture_bot --worker 2 --model gpt-5.6-sol --effort medium --architect-model gpt-6-astra --architect-effort max -- Fix search\nKeep old filters.';
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
    expect(f.store.jobs(task!.id)).toMatchObject([{ kind: 'plan', status: 'queued' }]);
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

    const settings = session + '/settings';
    const instructions = { daddy: {}, worker: {} };
    const edit = (payload: Record<string, unknown>) =>
      app.inject({ method: 'POST', url: settings, payload });
    expect(
      (await edit({ instructions: { daddy: { prompt: 'Web draft' }, worker: {} } })).statusCode,
    ).toBe(200);
    expect(
      (
        await edit({
          baseline: { instructions },
          instructions: { daddy: {}, worker: { prompt: 'Bot draft' } },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await edit({
          baseline: { instructions },
          instructions: { daddy: { prompt: 'Stale draft' }, worker: {} },
          workerLimit: 3,
        })
      ).statusCode,
    ).toBe(409);
    expect(f.daddy.group(group.id).instructions).toMatchObject({
      daddy: { prompt: 'Web draft' },
      worker: { prompt: 'Bot draft' },
    });
    expect(f.daddy.board(group.id).workers.target).toBe(2);

    const privateMessage = (text?: string): Update => {
      const update = message(text ?? '');
      return {
        ...update,
        message: {
          ...update.message!,
          chat: { id: 7, type: 'private' },
          message_thread_id: undefined,
        },
      };
    };
    const other = f.daddy.create({ workspaceId: f.workspace.id, requirements: 'Other session' });
    await bot.handle(privateMessage('/session@fixture_bot ' + group.id.slice(0, 8)));
    expect(f.store.setting('telegram.currentDaddy')).toBe(group.id);
    const upload = privateMessage();
    await bot.handle({
      ...upload,
      message: {
        ...upload.message!,
        text: undefined,
        caption: '/import@fixture_bot ' + other.id,
        document: { file_id: 'instruction-test' },
      },
    });
    expect((await app.inject('/api/daddy/sessions/' + other.id)).json().group.instructions).toEqual(
      imported,
    );
    expect(f.daddy.group(group.id).instructions?.daddy.prompt).toBe('Web draft');
    await bot.handle(privateMessage('/export@fixture_bot ' + other.id));
    expect(documents).toHaveLength(1);
    expect(documents[0]).toContain(JSON.stringify(imported, null, 2));

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
    const keyboard = () =>
      (
        sent.filter((x) => x.method === 'sendMessage').at(-1)?.body.reply_markup as {
          inline_keyboard: { text: string; callback_data: string; url?: string }[][];
        }
      ).inline_keyboard.flat();
    const buttonFor = (label: string) =>
      keyboard().find((button) => button.text.replace(/^✓ /, '') === label)!.callback_data;
    const limitUrl = session + '/tasks/' + task!.id + '/review-limit';
    const setLimit = (limit: number | null, previous: number | null) =>
      app.inject({
        method: 'POST',
        url: limitUrl,
        payload: {
          limit,
          expected: {
            task: {
              head: task!.revision?.head ?? '',
              revision: task!.revision,
              generation: task!.generation,
            },
            groupGeneration: group.generation,
            limit: previous,
          },
        },
      });
    const openLimit = async (inPrivate: boolean) => {
      await bot.handle((inPrivate ? privateMessage : message)(`/task ${id}`));
      const update = click(buttonFor('Review round limit'));
      if (inPrivate) {
        update.callback_query!.message!.chat = { id: 7, type: 'private' };
        delete update.callback_query!.message!.message_thread_id;
      }
      await bot.handle(update);
      const command = /\/review_limit [A-Za-z0-9_-]{16}/.exec(String(lastText()))?.[0];
      expect(command).toBeDefined();
      return command;
    };
    expect((await setLimit(15, null)).statusCode).toBe(200);
    const staleLimit = await openLimit(false);
    expect((await setLimit(16, 15)).statusCode).toBe(200);
    expect((await setLimit(null, 15)).statusCode).toBe(409);
    await bot.handle(message(staleLimit + ' off'));
    expect(lastText()).toContain('Settings changed');
    const freshLimit = await openLimit(false);
    await bot.handle(message(freshLimit + ' off', 7, 18));
    expect(f.store.getTask(task!.id).reviewRoundLimit).toBe(16);
    await bot.handle(message(freshLimit + ' off'));
    expect((await app.inject(session)).json().tasks[0].reviewRoundLimit).toBeNull();
    const privateLimit = await openLimit(true);
    await bot.handle(privateMessage(privateLimit + ' 18'));
    expect((await app.inject(session)).json().tasks[0].reviewRoundLimit).toBe(18);
    expect((await setLimit(null, 18)).statusCode).toBe(200);

    const queuedPlan = () => f.store.activeJobs(task!.id).find((job) => job.kind === 'plan')!;
    expect(queuedPlan().profile).toMatchObject({ model: 'gpt-6-astra', effort: 'max' });
    const architectUrl = session + '/tasks/' + task!.id + '/architect';
    const updated = await app.inject({
      method: 'POST',
      url: architectUrl,
      payload: { profile: { engine: 'codex', model: 'gpt-5.6-sol', effort: 'medium' } },
    });
    expect(updated.statusCode).toBe(200);
    await bot.handle(click(`dad:arch-task:${task!.id}`));
    const resetTaskArchitect = buttonFor('Use the session architect profile');
    await bot.handle(click(resetTaskArchitect, 7, 18));
    expect(queuedPlan().profile?.model).toBe('gpt-5.6-sol');
    await bot.handle(click(resetTaskArchitect));
    expect((await app.inject(session)).json().tasks[0].architectProfile).toBeUndefined();
    expect(queuedPlan().profile).toEqual(group.daddy);
    await bot.handle(click(`dad:arch-task:${task!.id}`));
    await bot.handle(click(keyboard().find((b) => b.text.includes('gpt-5.6-sol'))!.callback_data));
    await bot.handle(click(keyboard().find((b) => b.text === 'max')!.callback_data));
    expect((await app.inject(session)).json().tasks[0].architectProfile).toMatchObject({
      model: 'gpt-5.6-sol',
      effort: 'max',
    });
    const many = Array.from({ length: 31 }, (_, i) => ({
      id: `architect-${i}`,
      engine: 'codex',
      name: `Architect model ${i}`,
      efforts: [],
      defaultEffort: '',
      isDefault: false,
    }));
    const list = vi
      .spyOn(f.daddy.catalogue, 'list')
      .mockResolvedValueOnce(many)
      .mockResolvedValueOnce(many);
    try {
      await bot.handle(click(`dad:models:${group.id}:architect`));
      await bot.handle(click(keyboard().find((b) => b.text === 'Next page')!.callback_data));
      await bot.handle(
        click(keyboard().find((b) => b.text.includes('Architect model 30'))!.callback_data),
      );
      await bot.handle(click(keyboard().find((b) => b.text === 'Default')!.callback_data));
      expect(f.store.getGroup(group.id).architectProfile).toEqual({
        engine: 'codex',
        model: 'architect-30',
      });
      expect(queuedPlan().profile?.model).toBe('gpt-5.6-sol');
      await bot.handle(click(`dad:models:${group.id}:architect`));
      await bot.handle(click(buttonFor('Use the shared reviewer profile')));
      expect(f.store.getGroup(group.id).architectProfile).toBeUndefined();
    } finally {
      list.mockRestore();
    }
    await bot.handle(click(`dad:settings:${group.id}`));
    const enableMerge = buttonFor('Enable auto-merge for session');
    await bot.handle(click(enableMerge, 99));
    expect((await app.inject(session)).json().group.autoMerge).toBe(false);
    await bot.handle(click(enableMerge));
    expect((await app.inject(session)).json().tasks[0].autoMerge).toMatchObject({
      mode: 'inherit',
      enabled: true,
    });
    await bot.handle(click(`dad:task:${task!.id}`));
    const disableMerge = buttonFor('Off');
    await bot.handle(click(disableMerge, 7, 18));
    expect((await app.inject(session)).json().tasks[0].autoMerge.mode).toBe('inherit');
    await bot.handle(click(disableMerge));
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
    for (const mode of ['On', 'Off', 'Session default']) {
      await bot.handle(click(buttonFor(mode)));
      expect(callbacks()).toContain(backToQueue);
    }
    const verifyButton = callbacks().find((data) => data.startsWith('dad:vm:'))!;
    expect(Buffer.byteLength(verifyButton)).toBeLessThanOrEqual(64);
    await bot.handle(click(verifyButton, 99));
    await bot.handle(click(verifyButton, 7, 18));
    expect(action).not.toHaveBeenCalled();
    await bot.handle(click(verifyButton));
    expect(action).toHaveBeenCalledWith(
      withPr.id,
      'verify-merge',
      '',
      {
        groupId: group.id,
        head: withPr.revision!.head,
        revision: withPr.revision,
        generation: withPr.generation,
      },
      expect.any(Function),
    );
    expect(callbacks()).toContain(backToQueue);
    await bot.handle(click(verifyButton));
    expect(action).toHaveBeenCalledTimes(1);
    action.mockRestore();
    await bot.handle(click(openTenth));
    const stale = buttonFor('Verify merge');
    f.store.saveTask({ ...withPr, revision: { ...withPr.revision!, head: 'c'.repeat(40) } });
    await bot.handle(click(stale));
    expect(lastText()).toContain('The task changed');
    const pr = {
      ...(await new DemoProvider(f.store).getPR(taskPrRef(withPr))),
      ...withPr.revision!,
      checks: 'missing' as const,
    };
    f.store.setSetting('demo-pr:10', pr);
    f.store.saveTask({ ...withPr, pr, state: 'awaiting_checks' });
    const currentWaiver = {
      action: 'waive-checks',
      taskId: tenth.id,
      expectedGeneration: withPr.generation,
      expectedHead: withPr.revision!.head,
      expectedRevision: withPr.revision,
    };
    const noReason = await app.inject({
      method: 'POST',
      url: session + '/task-action',
      payload: currentWaiver,
    });
    expect(noReason.statusCode).toBe(400);
    const wrongBase = await app.inject({
      method: 'POST',
      url: session + '/task-action',
      payload: {
        ...currentWaiver,
        reason: 'Reviewed locally',
        expectedRevision: { ...withPr.revision!, base: 'd'.repeat(40) },
      },
    });
    expect(wrongBase.statusCode).toBe(409);
    expect(f.store.getTask(tenth.id).checksWaivedAt).toBeUndefined();

    await bot.handle(click(openTenth));
    const handoff = keyboard().find((button) => button.text.startsWith('Waive CI checks'));
    const start = new URL(handoff!.url!).searchParams.get('start')!;
    const key = start.slice('waive_'.length);
    await bot.handle(message('/waive ' + key + ' Reviewed locally'));
    expect(f.store.getTask(tenth.id).checksWaivedAt).toBeUndefined();
    await bot.handle(privateMessage('/start@fixture_bot ' + start));
    expect(lastText()).toContain('Reason for waiving CI checks');
    const originalRoom = f.store.setting('telegram.group');
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blocker = f.engine.lock(tenth.id, () => waiting);
    const actionCall = vi.spyOn(f.engine, 'action');
    const staleWaiver = bot.handle(privateMessage('/waive ' + key + ' Interrupted route'));
    try {
      await vi.waitFor(() => expect(actionCall).toHaveBeenCalledOnce());
      f.store.setSetting('telegram.group', null);
    } finally {
      release();
      await Promise.all([blocker, staleWaiver]);
      actionCall.mockRestore();
      f.store.setSetting('telegram.group', originalRoom);
    }
    expect(f.store.getTask(tenth.id).checksWaivedAt).toBeUndefined();
    const confirmWaiver = privateMessage('/waive ' + key + ' Reviewed locally');
    await bot.handle(confirmWaiver);
    await bot.stop();
    ({ api, bot } = createBot());
    await bot.handle(confirmWaiver);
    await bot.handle(privateMessage('/waive ' + key + ' Reviewed locally again'));
    expect(f.store.events(tenth.id).filter(({ type }) => type === 'checks.waived')).toMatchObject([
      { data: { reason: 'Reviewed locally', head: withPr.revision!.head } },
    ]);

    const beforeReview = { ...withPr, pr, state: 'awaiting_review_checks' as const };
    f.store.saveTask(beforeReview);
    const offlineReason = 'Verified on the offline build. '.repeat(140).slice(0, 4000);
    const webWaiver = await app.inject({
      method: 'POST',
      url: session + '/task-action',
      payload: { ...currentWaiver, reason: offlineReason },
    });
    expect(webWaiver.statusCode).toBe(200);
    expect(f.store.getTask(tenth.id).state).toBe('awaiting_review_checks');
    expect(f.store.getTask(tenth.id).checksWaivedAt).toBeDefined();

    f.store.saveTask(beforeReview);
    await bot.handle(click(openTenth));
    const preReview = keyboard().find((button) => button.text.startsWith('Waive CI checks'));
    expect(preReview?.url).toBeDefined();
    const preReviewStart = new URL(preReview!.url!).searchParams.get('start')!;
    await bot.handle(privateMessage('/start ' + preReviewStart));
    expect(lastText()).toContain('Reason for waiving CI checks');
    const preReviewKey = preReviewStart.slice('waive_'.length);
    await bot.handle(privateMessage('/waive ' + preReviewKey + ' ' + offlineReason + 'x'));
    expect(lastText()).toContain('at most 4000 characters');
    expect(f.store.getTask(tenth.id).checksWaivedAt).toBeUndefined();
    await bot.handle(privateMessage('/waive ' + preReviewKey + ' ' + offlineReason));
    expect(f.store.getTask(tenth.id).state).toBe('awaiting_review_checks');
    expect(f.store.getTask(tenth.id).checksWaivedAt).toBeDefined();
    expect(
      f.store
        .events(tenth.id)
        .filter(({ type }) => type === 'checks.waived')
        .at(-1)?.data,
    ).toMatchObject({ reason: offlineReason, head: withPr.revision!.head });

    const reviewPr = { ...pr, checks: 'passing' as const };
    f.store.setSetting('demo-pr:10', reviewPr);
    f.store.cancelJobs(tenth.id);
    f.store.saveTask({
      ...beforeReview,
      pr: reviewPr,
      state: 'queued',
      round: 15,
      reviewRoundLimit: 15,
    });
    await f.engine.review(tenth.id);
    expect(f.store.getTask(tenth.id)).toMatchObject({ state: 'paused', round: 15 });
    await bot.handle(click(openTenth));
    expect(lastText()).toContain('Review round limit · 15');
    expect(keyboard().some(({ text }) => text === 'Resume task')).toBe(false);
    await bot.handle(click(buttonFor('Review round limit')));
    const enterLimit = /\/review_limit [A-Za-z0-9_-]{16}/.exec(String(lastText()))?.[0];
    await bot.handle(message(enterLimit + ' 16'));
    expect(f.store.getTask(tenth.id)).toMatchObject({ state: 'paused', reviewRoundLimit: 16 });
    const resumeButton = buttonFor('Resume task');
    await bot.handle(click(resumeButton, 7, 18));
    expect(f.store.getTask(tenth.id).state).toBe('paused');
    await bot.handle(click(resumeButton));
    expect(f.store.getTask(tenth.id)).toMatchObject({ state: 'queued', round: 15 });
    await f.engine.review(tenth.id);
    expect(f.store.getTask(tenth.id)).toMatchObject({ state: 'reviewing', round: 16 });
    f.store.cancelJobs(tenth.id);

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

    const openTask = () => click(`dad:task:${task!.id}`);
    const authorJob = { ...chat!, generation: reviewing.generation };
    const currentGroup = f.store.getGroup(group.id);
    f.store.saveGroup({ ...currentGroup, workerSlots: [{ number: 2, taskId: task!.id }] });
    const prRef = { ...withPr.ref, kind: 'pull_request', number: 72 } as const;
    const prTask: Task = {
      ...reviewing,
      ref: prRef,
      revision: withPr.revision,
      pr: { state: 'open' } as Task['pr'],
      state: 'awaiting_merge',
    };
    f.store.saveTask(prTask);
    const boardStatus = async () =>
      (await app.inject(session)).json().tasks.find((item: Task) => item.id === task!.id)
        .statusLabel;
    const mergeKey = `autoMerge.result:${task!.id}`;
    for (const message of [
      'Checking GitHub auto-merge',
      'Waiting for GitHub to confirm the previous merge request',
    ]) {
      f.store.setSetting(mergeKey, {
        generation: prTask.generation,
        head: prTask.revision!.head,
        state: 'uncertain',
        message,
      });
      for (const role of ['author', 'reviewer'] as const) {
        f.store.saveJob({ ...authorJob, role, status: 'running', startedAt: started(5) });
        expect(await boardStatus()).toBe('Task discussion in progress');
        f.store.saveJob({ ...authorJob, role, status: 'completed', startedAt: started(5) });
        expect(await boardStatus()).toBe(message);
      }
    }
    f.store.setSetting(mergeKey, null);

    const retryAt = Date.parse('2026-11-25T12:34:56Z');
    for (const locale of ['en', 'ru'] as const) {
      setLocale(f.store, locale);
      const githubReviewRetries = [
        {
          state: 'queued',
          draftStart: { marker: 'review', revision: prTask.revision!, retry: true, retryAt },
          label: 'GitHub review draft · retry at 12:34:56 UTC · PR #72',
        },
        {
          state: 'awaiting_publication',
          publicationRetry: { retryAt, delay: 15_000 },
          label: 'GitHub review publication · retry at 12:34:56 UTC · PR #72',
        },
      ] as const;
      for (const { label, ...retry } of githubReviewRetries) {
        f.store.saveTask({ ...prTask, ...retry });
        f.store.saveJob({ ...authorJob, status: 'running', startedAt: started(5) });
        await bot.handle(openTask());
        expect(lastText()).toContain(translate(locale, 'Task discussion in progress'));
        expect(await boardStatus()).toBe('Task discussion in progress');
        f.store.saveJob({ ...authorJob, status: 'completed', startedAt: started(5) });
        await bot.handle(message('/queue'));
        expect(lastText()).toContain(translate(locale, label));
        expect(await boardStatus()).toBe(label);
      }
      for (const ref of [undefined, prRef]) {
        f.store.saveTask({
          ...reviewing,
          state: 'submitting',
          prLink: { ref, retryAt, head: prTask.revision!.head, generation: reviewing.generation },
        });
        f.store.saveJob({ ...authorJob, status: 'queued' });
        const retry = translate(
          locale,
          ref ? 'PR #72 · retry at 12:34:56 UTC' : 'GitHub · retry at 12:34:56 UTC',
        );
        const worker = translate(locale, 'Worker {number}', { number: 2 });
        const detail = translate(
          locale,
          ref
            ? 'The PR already exists. daddy will connect it automatically.'
            : 'Checking GitHub for the result of the previous PR creation',
        );
        await bot.handle(message('/queue'));
        expect(lastText()).toContain(retry);
        expect(lastText()).toContain(`\n${worker}\n${detail}`);
        await bot.handle(openTask());
        expect(lastText()).toContain(`\n${retry}\n${worker}`);
        expect(lastText()).toContain(detail);
      }
      const localUntil = Math.floor(Date.now() / 1000) * 1000 + 120_000;
      const localTime = new Date(localUntil).toISOString().slice(11, 19);
      for (const retry of [
        {
          state: 'queued' as const,
          draftStart: {
            marker: 'review',
            revision: prTask.revision!,
            retry: true,
            retryAt: localUntil,
          },
          label: `GitHub review draft · retry at ${localTime} UTC · PR #72`,
        },
        {
          state: 'awaiting_publication' as const,
          publicationRetry: { retryAt: localUntil, delay: 15_000 },
          label: `GitHub review publication · retry at ${localTime} UTC · PR #72`,
        },
        {
          state: 'submitting' as const,
          prLink: {
            ref: prRef,
            retryAt: localUntil,
            head: prTask.revision!.head,
            generation: prTask.generation,
          },
          label: `PR #72 · retry at ${localTime} UTC`,
        },
        {
          state: 'fixing' as const,
          fixingMergeConflict: true,
          label: `Continuing conflict resolution after a timeout at ${localTime} UTC · PR #72`,
        },
      ]) {
        const { label, state, ...local } = retry;
        const fix = state === 'fixing';
        const job = { ...authorJob, kind: fix ? 'fix' : 'chat', status: 'queued' } as const;
        const withoutLocal = { ...prTask, state, fixingMergeConflict: fix };
        const setLocal = (enabled: boolean) => {
          f.store.saveTask({ ...withoutLocal, ...(enabled ? local : {}) });
          f.store.saveJob({
            ...job,
            timeoutRetry: fix && enabled,
            notBefore: fix && enabled ? new Date(localUntil).toISOString() : undefined,
          });
        };
        const expectRetry = async (expected: string) => {
          expect(await boardStatus()).toBe(expected);
          await bot.handle(message('/queue'));
          expect(lastText()).toContain(translate(locale, expected));
          await bot.handle(openTask());
          expect(lastText()).toContain(translate(locale, expected));
        };
        for (const kind of ['quota', 'read-backoff'] as const) {
          const key = `github.${kind}:${prRef.host}`;
          for (const offset of [-60_000, 60_000]) {
            setLocal(true);
            const until = localUntil + offset;
            const time = new Date(until).toISOString().slice(11, 19);
            f.store.setSetting(key, { until, delay: 60_000, status: 503 });
            const global =
              kind === 'quota'
                ? `Waiting for GitHub API quota until ${time} UTC · PR #72`
                : `PR #72 · GitHub HTTP 503 · retry at ${time} UTC`;
            await expectRetry(offset > 0 ? global : label);
            if (offset > 0) {
              f.store.setSetting(key, null);
              await expectRetry(label);
              setLocal(false);
            } else {
              setLocal(false);
              await expectRetry(global);
              f.store.setSetting(key, null);
            }
            expect(await boardStatus()).not.toContain('UTC');
          }
        }
      }
      const publicQuestion = 'Should the old filters remain available?';
      const scenarios: Task[] = [
        {
          ...reviewing,
          state: 'needs_input',
          resumeState: 'reviewing',
          reason: `Saved fix ${prTask.revision!.head} is on the PR. Inspect the earlier draft review 42 before starting another review.`,
        },
        {
          ...reviewing,
          state: 'needs_input',
          resumeState: 'reviewing',
          reason:
            'PR changed while a draft existed. Inspect or discard the stale native draft before starting the next review.',
        },
        {
          ...reviewing,
          state: 'fixing',
          fixingMergeConflict: true,
          reason:
            'Conflict repair found additional local changes. The working copies were preserved.',
        },
      ];
      f.store.saveJob({ ...authorJob, status: 'completed' });
      for (const scenario of scenarios) {
        f.store.saveTask(scenario);
        await bot.handle(openTask());
        expect(lastText()).toContain('\n\n' + translate(locale, scenario.reason));
      }
      f.store.saveTask({
        ...reviewing,
        state: 'needs_input',
        resumeState: 'reviewing',
        reason: publicQuestion,
        inputRequest: { runId: authorJob.id, generation: reviewing.generation, role: 'author' },
      });
      f.store.saveJob({ ...authorJob, status: 'running', startedAt: started(5) });
      await bot.handle(openTask());
      expect(lastText()).toContain(translate(locale, 'Task discussion in progress'));
      expect(lastText()).toContain('\n\n' + publicQuestion);
      f.store.saveJob({ ...authorJob, status: 'queued' });
      f.store.setSetting('github.quota:' + task!.ref.host, { until, delay: 60_000 });
      await bot.handle(openTask());
      expect(lastText()).toContain(translate(locale, 'Waiting for GitHub quota'));
      expect(lastText()).toContain('UTC');
      expect(lastText()).toContain('\n\n' + publicQuestion);
      f.store.setSetting('github.quota:' + task!.ref.host, null);
    }

    // Both command spellings acknowledge the update and leave the next command usable.
    const poolUpdate = message('/pool 4');
    await bot.handle(poolUpdate);
    expect(f.daddy.board(group.id).workers.target).toBe(4);
    expect(
      f.store.db.prepare('SELECT 1 FROM bot_receipts WHERE id=?').get(poolUpdate.update_id),
    ).toBeDefined();
    await bot.handle(message('/pool@fixture_bot 5'));
    await bot.handle(message('/status'));
    expect(f.daddy.board(group.id).workers.target).toBe(5);
    await bot.handle(click(`dad:pool:${group.id}:8`));
    expect(f.daddy.board(group.id).workers.target).toBe(5);

    // A success followed by an interrupted acknowledgement cannot overwrite a subsequent web edit.
    const oldInstructions = message('/instructions worker old');
    const prepare = f.store.db.prepare.bind(f.store.db);
    let receipts = 0;
    const fault = vi.spyOn(f.store.db, 'prepare').mockImplementation((sql) => {
      if (sql === 'INSERT OR IGNORE INTO bot_receipts VALUES(?,?)' && ++receipts === 2)
        throw new Error('Interrupted acknowledgement');
      return prepare(sql);
    });
    try {
      await expect(bot.handle(oldInstructions)).rejects.toThrow('Interrupted acknowledgement');
    } finally {
      fault.mockRestore();
    }
    const savedInstructions = f.daddy.group(group.id).instructions!;
    expect(savedInstructions.worker.prompt).toBe('old');
    expect(
      (await edit({ instructions: { ...savedInstructions, worker: { prompt: 'newer from web' } } }))
        .statusCode,
    ).toBe(200);
    await bot.handle(oldInstructions);
    expect(lastText()).toMatch(/already completed|уже выполнено/);
    expect(f.daddy.group(group.id).instructions?.worker.prompt).toBe('newer from web');

    const stopBeforeReply = privateMessage('/notifications off');
    const failedReply = vi
      .spyOn(api, 'send')
      .mockRejectedValueOnce(new Error('Stopped before sending confirmation'));
    try {
      await expect(bot.handle(stopBeforeReply)).rejects.toThrow(
        'Stopped before sending confirmation',
      );
    } finally {
      failedReply.mockRestore();
    }
    expect(f.store.setting('notifications.telegram')).toMatchObject({ enabled: false });
    f.store.setSetting('notifications.telegram', { enabled: true, mode: 'all' });
    await bot.stop();
    ({ api, bot } = createBot());
    await bot.handle(stopBeforeReply);
    expect(lastText()).toMatch(/already completed|уже выполнено/);
    expect(f.store.setting('notifications.telegram')).toMatchObject({ enabled: true, mode: 'all' });

    const crew = f.daddy.group(group.id);
    crew.workerSlots = [{ number: 1, taskId: task!.id }];
    f.store.saveGroup(crew);
    await bot.handle(message('/worker 1 gpt-5.6-sol medium --force'));
    const force = keyboard().find((button) =>
      button.callback_data?.startsWith('dad:force:'),
    )!.callback_data;
    const reassigned = f.daddy.group(group.id);
    reassigned.workerSlots = [{ number: 1, taskId: withPr.id }];
    f.store.saveTask(withPr);
    f.store.saveGroup(reassigned);
    const configure = vi.spyOn(f.daddy, 'configureWorker');
    await bot.handle(click(force));
    expect(f.store.getTask(withPr.id).generation).toBe(withPr.generation);
    expect(f.daddy.board(group.id).workers.slots[0]?.profile).toBeUndefined();
    await bot.handle(message('/worker 1 gpt-5.6-sol medium --force'));
    expect(lastText()).toContain(withPr.title);
    await bot.handle(
      click(
        keyboard().find((button) => button.callback_data?.startsWith('dad:force:'))!.callback_data,
      ),
    );
    expect(configure).toHaveBeenLastCalledWith(
      group.id,
      1,
      expect.objectContaining({ model: 'gpt-5.6-sol' }),
      expect.objectContaining({ expectedTaskId: withPr.id }),
    );
    expect(f.daddy.board(group.id).workers.slots[0]?.profile?.model).toBe('gpt-5.6-sol');
    configure.mockRestore();

    await bot.handle(privateMessage('/agents daddy codex'));
    expect(f.engine.defaultAgents().daddy).toEqual({ engine: 'codex' });
    await bot.handle(privateMessage('/agents worker codex'));
    expect(f.engine.defaultAgents().worker).toEqual({ engine: 'codex' });
    f.store.setSetting('telegram.currentDaddy', null);
    await bot.handle(privateMessage('/task --no-plan -- Keep this queued request'));
    await bot.handle(privateMessage('/session ' + other.id));
    expect(
      f.store
        .tasks(other.id)
        .filter(({ requirements }) => requirements === 'Keep this queued request'),
    ).toHaveLength(1);

    await bot.handle(message('/attach ' + other.id, 7, 18));
    for (const viaButton of [true, false]) {
      f.store.setSetting('telegram.currentDaddy', null);
      await bot.handle(privateMessage('/pause'));
      const choice = () =>
        keyboard().find((button) => button.text === f.daddy.group(other.id).title)!.callback_data;
      const pick = async () => {
        if (viaButton) {
          const update = click(choice());
          update.callback_query!.message = { chat: { id: 7, type: 'private' } };
          await bot.handle(update);
        } else await bot.handle(privateMessage('/session ' + other.id));
      };
      await f.daddy.pause(other.id);
      await f.daddy.resume(other.id);
      await pick();
      expect(f.daddy.group(other.id).daddyState).toBe('active');
      await pick();
      expect(f.daddy.group(other.id).daddyState).toBe('paused');
      await f.daddy.resume(other.id);
    }

    for (const viaButton of [true, false]) {
      f.store.setSetting('telegram.currentDaddy', null);
      await bot.handle(privateMessage('/worker 1 gpt-5.6-sol medium'));
      const pick = () => {
        if (!viaButton) return bot.handle(privateMessage('/session ' + other.id));
        const data = keyboard().find(
          (button) => button.text === f.daddy.group(other.id).title,
        )!.callback_data;
        const update = click(data);
        update.callback_query!.message = { chat: { id: 7, type: 'private' } };
        return bot.handle(update);
      };
      const before = f.daddy.board(other.id).workers.slots[0]?.profile;
      await f.daddy.pause(other.id);
      await f.daddy.resume(other.id);
      await pick();
      expect(f.daddy.board(other.id).workers.slots[0]?.profile).toEqual(before);
      let release!: () => void;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      const validation = vi
        .spyOn(f.daddy.catalogue, 'validate')
        .mockImplementationOnce(() => blocked);
      const delayed = pick();
      try {
        await vi.waitFor(() => expect(validation).toHaveBeenCalledOnce());
        await f.daddy.pause(other.id);
        await f.daddy.resume(other.id);
      } finally {
        release();
        await delayed;
        validation.mockRestore();
      }
      expect(f.daddy.board(other.id).workers.slots[0]?.profile).toEqual(before);
      await pick();
      expect(f.daddy.board(other.id).workers.slots[0]?.profile).toMatchObject({
        model: 'gpt-5.6-sol',
        effort: 'medium',
      });
      const next = f.daddy.group(other.id);
      next.workerSlots = [];
      f.store.saveGroup(next);
    }

    const workerOrigin = f.store.setting('telegram.group');
    for (const interrupt of ['generation', 'topic'] as const) {
      const before = f.daddy.board(other.id).workers.slots[0]?.profile;
      let release!: () => void;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      const validation = vi
        .spyOn(f.daddy.catalogue, 'validate')
        .mockImplementationOnce(() => blocked);
      const delayed = bot.handle(message('/worker 1 gpt-6-astra medium', 7, 18));
      try {
        await vi.waitFor(() => expect(validation).toHaveBeenCalledOnce());
        if (interrupt === 'generation') {
          await f.daddy.pause(other.id);
          await f.daddy.resume(other.id);
        } else f.store.setSetting('telegram.group', null);
      } finally {
        release();
        await delayed;
        validation.mockRestore();
        f.store.setSetting('telegram.group', workerOrigin);
      }
      expect(f.daddy.board(other.id).workers.slots[0]?.profile).toEqual(before);
    }
    await bot.handle(message('/worker 1 gpt-6-astra medium', 7, 18));
    expect(f.daddy.board(other.id).workers.slots[0]?.profile).toMatchObject({
      model: 'gpt-6-astra',
      effort: 'medium',
    });

    const oldBoard = f.daddy.board(other.id);
    const oldSlot = oldBoard.workers.slots[0]!.profile!;
    await f.daddy.pause(other.id);
    await f.daddy.resume(other.id);
    const updateSlot = (generation: number) =>
      app.inject({
        method: 'POST',
        url: '/api/daddy/sessions/' + other.id + '/workers/1',
        payload: {
          profile: { ...oldSlot, effort: 'max' },
          baseline: oldSlot,
          expectedGeneration: generation,
        },
      });
    expect((await updateSlot(oldBoard.group.generation)).statusCode).toBe(409);
    expect(f.daddy.board(other.id).workers.slots[0]?.profile).toEqual(oldSlot);
    expect((await updateSlot(f.daddy.group(other.id).generation)).statusCode).toBe(200);
    expect(f.daddy.board(other.id).workers.slots[0]?.profile?.effort).toBe('max');

    const catalogueEfforts = vi
      .spyOn(f.daddy.catalogue, 'validate')
      .mockImplementation(async (profile) => {
        if (
          (profile.model === 'standard' ||
            profile.model === 'limited' ||
            profile.model === 'high-only') &&
          profile.effort &&
          !(profile.model === 'limited' && profile.effort === 'medium') &&
          !(profile.model === 'high-only' && profile.effort === 'high')
        )
          throw new AppError('effort_unavailable', 'The model does not support that effort', 422);
      });
    try {
      const url = '/api/daddy/sessions/' + other.id + '/workers/1';
      const set = (profile: { engine: string; model: string; effort?: string }) =>
        app.inject({
          method: 'POST',
          url,
          payload: { profile, expectedGeneration: f.daddy.group(other.id).generation },
        });
      const initial = { engine: 'claude', model: 'sonnet', effort: 'high' };
      for (const model of ['standard', 'limited']) {
        const target = { engine: 'claude', model };
        expect((await set(initial)).statusCode).toBe(200);
        await bot.handle(message('/worker 1 ' + model + ' high', 7, 18));
        expect(f.daddy.board(other.id).workers.slots[0]?.profile).toEqual(initial);
        await bot.handle(message('/worker 1 ' + model, 7, 18));
        expect(f.daddy.board(other.id).workers.slots[0]?.profile).toEqual(target);
        expect((await set(initial)).statusCode).toBe(200);
        expect((await set(target)).statusCode).toBe(200);
        expect(f.daddy.board(other.id).workers.slots[0]?.profile).toEqual(target);
      }
      for (const model of ['sonnet', 'high-only']) {
        const target = { engine: 'claude', model };
        expect((await set(initial)).statusCode).toBe(200);
        await bot.handle(message('/worker 1 ' + model + ' default', 7, 18));
        expect(f.daddy.board(other.id).workers.slots[0]?.profile).toEqual(target);
      }

      expect((await set(initial)).statusCode).toBe(200);
      let release!: () => void;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      catalogueEfforts.mockImplementationOnce(() => blocked);
      catalogueEfforts.mockClear();
      const delayed = bot.handle(message('/worker 1 high-only', 7, 18));
      const later = { ...initial, effort: 'medium' };
      try {
        await vi.waitFor(() => expect(catalogueEfforts).toHaveBeenCalledOnce());
        expect((await set(later)).statusCode).toBe(200);
      } finally {
        release();
        await delayed;
      }
      expect(f.daddy.board(other.id).workers.slots[0]?.profile).toEqual(later);
      await bot.handle(message('/worker 1 high-only', 7, 18));
      expect(f.daddy.board(other.id).workers.slots[0]?.profile).toEqual({
        engine: 'claude',
        model: 'high-only',
      });
    } finally {
      catalogueEfforts.mockRestore();
    }

    const profileUrl = session + '/workers/2';
    const workerBaseline = { engine: 'codex', model: 'gpt-5.6-sol', effort: 'max' };
    const saveWorker = (profile: typeof workerBaseline, baseline?: typeof workerBaseline) =>
      app.inject({ method: 'POST', url: profileUrl, payload: { profile, baseline } });
    expect((await saveWorker(workerBaseline)).statusCode).toBe(200);
    await bot.handle(message('/worker 2 gpt-6-astra'));
    expect(
      (await saveWorker({ ...workerBaseline, effort: 'medium' }, workerBaseline)).statusCode,
    ).toBe(200);
    const combined = { engine: 'codex', model: 'gpt-6-astra', effort: 'medium' };
    expect(f.daddy.board(group.id).workers.slots[1]?.profile).toEqual(combined);
    expect(
      (await saveWorker({ ...workerBaseline, model: 'other-model' }, workerBaseline)).statusCode,
    ).toBe(409);
    expect(f.daddy.board(group.id).workers.slots[1]?.profile).toEqual(combined);

    await bot.handle(privateMessage('/session ' + group.id));
    await bot.handle(message('/export ' + other.id));
    const exportLink = keyboard().find((button) => button.url?.includes('?start=operation_'));
    const exportStart = new URL(exportLink!.url!).searchParams.get('start');
    const exportedBefore = documents.length;
    await bot.handle(privateMessage('/start ' + exportStart));
    expect(documents).toHaveLength(exportedBefore + 1);
    expect(documents.at(-1)).toContain('From Telegram');
    expect(f.store.setting('telegram.currentDaddy')).toBe(group.id);

    await bot.handle(message('/concurrency@fixture_bot 3'));
    const changeLink = keyboard().find((button) => button.url?.includes('?start=operation_'));
    const changeStart = new URL(changeLink!.url!).searchParams.get('start');
    const limitBefore = f.daddy.maxConcurrentAgents();
    await bot.handle(privateMessage('/start ' + changeStart));
    expect(f.daddy.maxConcurrentAgents()).toBe(limitBefore);
    const privateClick = click(
      keyboard().find((button) => button.callback_data?.startsWith('dad:private:'))!.callback_data,
    );
    privateClick.callback_query!.message = { chat: { id: 7, type: 'private' } };
    f.store.setSetting('worker.maxAgents', 5);
    await bot.handle(privateClick);
    expect(f.daddy.maxConcurrentAgents()).toBe(5);
    await bot.handle(message('/concurrency 3'));
    const freshLink = keyboard().find((button) => button.url?.includes('?start=operation_'));
    await bot.handle(
      privateMessage('/start ' + new URL(freshLink!.url!).searchParams.get('start')),
    );
    const confirm = () => {
      const update = click(
        keyboard().find((button) => button.callback_data?.startsWith('dad:private:'))!
          .callback_data,
      );
      update.callback_query!.message = { chat: { id: 7, type: 'private' } };
      return bot.handle(update);
    };
    await confirm();
    expect(f.daddy.maxConcurrentAgents()).toBe(3);

    const openPrivate = async () => {
      const link = keyboard().find((button) => button.url?.includes('?start=operation_'));
      await bot.handle(privateMessage('/start ' + new URL(link!.url!).searchParams.get('start')));
    };
    for (const role of ['daddy', 'worker'] as const) {
      const peer = role === 'daddy' ? 'worker' : 'daddy';
      const configured = { engine: 'codex', model: 'gpt-6-astra', effort: 'max' };
      f.engine.setDefaultAgents({ ...f.engine.defaultAgents(), [role]: { engine: 'codex' } });
      await bot.handle(message('/agents ' + role + ' codex'));
      await openPrivate();
      f.engine.setDefaultAgents({ ...f.engine.defaultAgents(), [role]: configured });
      await confirm();
      expect(f.engine.defaultAgents()[role]).toEqual(configured);
      await bot.handle(message('/agents ' + role + ' codex'));
      await openPrivate();
      const unrelated = { engine: 'codex', model: 'gpt-5.6-sol', effort: 'medium' };
      f.engine.setDefaultAgents({ ...f.engine.defaultAgents(), [peer]: unrelated });
      await confirm();
      expect(f.engine.defaultAgents()[role]).toEqual({ engine: 'codex' });
      expect(f.engine.defaultAgents()[peer]).toEqual(unrelated);
    }

    const attachDocument = async (caption: string, update = privateMessage()) => {
      await bot.handle({
        ...update,
        message: {
          ...update.message!,
          text: undefined,
          caption,
          document: { file_id: 'instruction-test', file_name: 'Skill.md' },
        },
      });
    };
    const downloadsBefore = sent.filter(({ method }) => method === 'getFile').length;
    await attachDocument('/import@another_bot ' + other.id, message(''));
    expect(sent.filter(({ method }) => method === 'getFile')).toHaveLength(downloadsBefore);
    await attachDocument('/import@fixture_bot ' + other.id, message(''));
    const attachment = keyboard().find((button) => button.url?.includes('?start=operation_'));
    expect(sent.filter(({ method }) => method === 'getFile')).toHaveLength(downloadsBefore);
    await bot.handle(
      privateMessage('/start ' + new URL(attachment!.url!).searchParams.get('start')),
    );
    await confirm();
    expect(sent.filter(({ method }) => method === 'getFile')).toHaveLength(downloadsBefore + 1);
    expect(f.daddy.group(other.id).instructions?.daddy.prompt).toBe(imported.daddy.prompt);
    await attachDocument('/import@fixture_bot ' + other.id, message(''));
    await openPrivate();
    const retained = f.daddy.group(other.id).instructions;
    const room = f.store.setting('telegram.group');
    let sendFile!: (bytes: Uint8Array) => void;
    const getFile = vi.spyOn(api, 'downloadFile').mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          sendFile = resolve;
        }),
    );
    const late = confirm();
    try {
      await vi.waitFor(() => expect(getFile).toHaveBeenCalledOnce());
      f.store.setSetting('telegram.group', null);
    } finally {
      sendFile?.(Buffer.from(JSON.stringify({ daddy: { prompt: 'Stale late file' }, worker: {} })));
      await late;
      getFile.mockRestore();
      f.store.setSetting('telegram.group', room);
    }
    expect(f.daddy.group(other.id).instructions).toEqual(retained);
    await attachDocument('/skill_file@fixture_bot ' + other.id + ' worker');
    expect(f.daddy.group(other.id).instructions?.worker.skills).toHaveLength(1);
    await attachDocument('/preset_create@fixture_bot From attachment');
    const library = new InstructionPresets(f.store);
    const preset = library.list().find((item) => item.name === 'From attachment')!;
    await attachDocument('/preset_edit@fixture_bot ' + preset.id + ' 1 Renamed attachment');
    expect(library.get(preset.id)).toMatchObject({ name: 'Renamed attachment', revision: 2 });

    const selective = library.save({
      name: 'Selective',
      instructions: { daddy: { prompt: 'Keep this' }, worker: { prompt: 'Skip this' } },
    });
    await bot.handle(message('/preset Selective'));
    await bot.handle(message('/preset_parts ' + selective.id + ' 1'));
    const omitted = f.daddy
      .group(group.id)
      .instructions?.presets?.find((value) => value.preset.id === selective.id)?.omit;
    expect(omitted).toHaveLength(1);
    await bot.handle(message('/preset_parts ' + selective.id + ' off'));
    expect(
      f.daddy
        .group(group.id)
        .instructions?.presets?.find((value) => value.preset.id === selective.id),
    ).toMatchObject({ enabled: false, omit: omitted });
    await bot.handle(message('/preset Selective'));
    expect(
      f.daddy
        .group(group.id)
        .instructions?.presets?.find((value) => value.preset.id === selective.id),
    ).toMatchObject({ enabled: true, omit: omitted });
    await bot.handle(message('/preset_parts ' + selective.id + ' all'));
    expect(
      f.daddy
        .group(group.id)
        .instructions?.presets?.find((value) => value.preset.id === selective.id)?.omit,
    ).toEqual([]);

    const beforePause = f.daddy.group(group.id).generation;
    const shownLimit = f.daddy.board(group.id).workers.target;
    const shownWorker = f.daddy.board(group.id).workers.slots.find(({ number }) => number === 1)!;
    const shownTask = f.store.getTask(shownWorker.taskId!);
    const workerUrl = session + '/workers/1';
    const workerChange = {
      profile: { engine: 'codex', model: 'gpt-6-astra', effort: 'max' },
      forceTaskId: shownTask.id,
      expected: {
        groupGeneration: beforePause,
        task: {
          generation: shownTask.generation,
          head: shownTask.revision?.head ?? '',
          revision: shownTask.revision,
        },
      },
    };
    const lifecycle = (action: string, expectedGeneration: number) =>
      app.inject({
        method: 'POST',
        url: session + '/' + action,
        payload: { expectedGeneration },
      });
    expect((await lifecycle('pause', beforePause)).statusCode).toBe(200);
    const resumed = f.daddy.group(group.id).generation;
    expect((await lifecycle('resume', resumed)).statusCode).toBe(200);
    expect((await lifecycle('pause', beforePause)).statusCode).toBe(409);
    expect(f.daddy.group(group.id).daddyState).toBe('active');
    expect(
      (
        await edit({
          workerLimit: 6,
          expectedGeneration: beforePause,
          baseline: { workerLimit: shownLimit },
        })
      ).statusCode,
    ).toBe(409);
    const workerBefore = f.daddy.board(group.id).workers.slots[0];
    expect(
      (await app.inject({ method: 'POST', url: workerUrl, payload: workerChange })).statusCode,
    ).toBe(409);
    expect(f.daddy.board(group.id).workers.slots[0]).toEqual(workerBefore);
    const currentTask = f.store.getTask(shownTask.id);
    const staleRevision = { ...currentTask.revision!, head: 'd'.repeat(40) };
    f.store.saveTask({ ...currentTask, revision: staleRevision });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: workerUrl,
          payload: {
            ...workerChange,
            expected: {
              groupGeneration: resumed,
              task: {
                generation: currentTask.generation,
                head: currentTask.revision!.head,
                revision: currentTask.revision,
              },
            },
          },
        })
      ).statusCode,
    ).toBe(409);
    expect(f.daddy.board(group.id).workers.slots[0]).toEqual(workerBefore);
    const target = f.daddy.board(group.id).workers.target;
    expect((await edit({ workerLimit: 6, baseline: { workerLimit: target } })).statusCode).toBe(
      200,
    );
    expect((await edit({ workerLimit: 4, baseline: { workerLimit: target } })).statusCode).toBe(
      409,
    );
    expect(f.daddy.board(group.id).workers.target).toBe(6);

    const requestTask = {
      ...withPr,
      state: 'needs_input' as const,
      inputRequest: {
        runId: 'task-question',
        role: 'author' as const,
        generation: withPr.generation,
      },
    };
    f.store.saveTask(requestTask);
    const question = 'Choose the next step for task ten.';
    const destination = { chatId: -10042, threadId: 17 };
    await api.send(destination, question, undefined, {
      key: `telegram:question:7:${withPr.id}:${taskRequestKey(f.store, requestTask)}`,
      groupId: group.id,
    });
    await api.delivery!.flush();
    const messageId = sent.findIndex((item) => item.body.text === question) + 1;
    expect(messageId).toBeGreaterThan(0);
    const reply = message('Continue the task', 7, 18);
    const external = { chat: reply.message!.chat, message_id: messageId };
    await bot.handle(message('/attach ' + other.id, 7, 18));
    await bot.handle({ ...reply, message: { ...reply.message!, external_reply: external } });
    expect(f.store.messages(other.id).every((item) => item.text !== 'Continue the task')).toBe(
      true,
    );

    const reminderText = 'Reminder for task ten';
    await api.send(destination, reminderText, undefined, {
      key: `telegram:question:7:${withPr.id}:${taskRequestKey(f.store, requestTask)}:reminder:1`,
      groupId: group.id,
    });
    await api.delivery!.flush();
    const reminderId = sent.findIndex((item) => item.body.text === reminderText) + 1;
    expect(reminderId).toBeGreaterThan(0);
    const parent = { ...external, message_id: reminderId, message_thread_id: 17 };
    const answered = message('Continue task ten');
    await bot.handle({ ...answered, message: { ...answered.message!, reply_to_message: parent } });
    expect(
      f.store.messages(group.id).find((item) => item.text === 'Continue task ten')?.origin?.replyTo
        ?.taskId,
    ).toBe(withPr.id);
    const duplicate = message('Second answer for the same question');
    await bot.handle({
      ...duplicate,
      message: { ...duplicate.message!, reply_to_message: { ...parent, message_id: messageId } },
    });
    expect(f.store.messages(group.id).some((item) => item.text === duplicate.message!.text)).toBe(
      false,
    );
    f.store.saveTask({ ...requestTask, revision: { ...withPr.revision!, head: 'c'.repeat(40) } });
    const staleReply = message('Answer to an old question');
    await bot.handle({
      ...staleReply,
      message: { ...staleReply.message!, reply_to_message: parent },
    });
    expect(
      f.store.messages(group.id).every((item) => item.text !== 'Answer to an old question'),
    ).toBe(true);
    const coordinator = f.daddy.group(group.id);
    coordinator.daddyState = 'needs_input';
    f.store.saveGroup(coordinator);
    const followUp = f.store.daddyMessage(
      group.id,
      'agent',
      'Coordinator question',
      undefined,
      undefined,
      { phase: 'final', needsReply: true },
    );
    await api.send(destination, followUp.text, undefined, {
      key: 'turn:older-coordinator-run',
      notificationId: `telegram:dialog:-10042:17:${followUp.id}:final`,
      groupId: group.id,
    });
    await api.delivery!.flush();
    const followUpId = sent.findIndex((item) => item.body.text === followUp.text) + 1;
    expect(followUpId).toBeGreaterThan(0);
    const wrong = message('Wrong coordinator topic', 7, 18);
    await bot.handle({
      ...wrong,
      message: {
        ...wrong.message!,
        external_reply: { chat: wrong.message!.chat, message_id: followUpId },
      },
    });
    expect(f.store.messages(other.id).some((item) => item.text === 'Wrong coordinator topic')).toBe(
      false,
    );
    const right = message('Answer the coordinator');
    await bot.handle({
      ...right,
      message: {
        ...right.message!,
        reply_to_message: {
          chat: right.message!.chat,
          message_id: followUpId,
          message_thread_id: 17,
        },
      },
    });
    expect(f.store.messages(group.id).some((item) => item.text === 'Answer the coordinator')).toBe(
      true,
    );
  } finally {
    await localBotApi.close();
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
