import { randomUUID } from 'node:crypto';
import { translate, type Locale } from '../src/i18n/index.js';
import { AppError, type AgentProfile } from '../src/core/types.js';
import Fastify from 'fastify';
import { registerDaddy } from '../src/server/daddy.js';
import { TelegramWorkspace } from '../src/integrations/telegram-workspace.js';
import type { TelegramApi } from '../src/integrations/telegram.js';
import type { TelegramCard } from '../src/integrations/telegram-text.js';
import { expect, it, vi } from 'vitest';
import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { daddyFixture } from './daddy-fixture.js';
import { profiles, ticketInput } from './planning-fixture.js';
import type { AgentInput } from '../src/runtime/agent.js';

function holdWorker(f: ReturnType<typeof daddyFixture>) {
  const runs: { input: AgentInput; finish: () => void }[] = [];
  f.agentRuntime.run.mockImplementation(async (input) => {
    input.onSession(`test-thread-${runs.length}`);
    await new Promise<void>((finish) => runs.push({ input, finish }));
    return { status: 'completed', summary: 'Done', checkedHead: input.task.revision!.head };
  });
  return runs;
}

it('uses matching free workers, honors an explicit slot and retunes the first free worker', async () => {
  const f = daddyFixture(),
    runs = holdWorker(f);
  const group = f.daddy.create({ workspaceId: f.workspace.id, workerLimit: 2 });
  const tuned = { ...profiles.daddy, effort: 'medium' };
  const alternate = { ...profiles.worker, effort: 'medium' };
  const finish = async (run: (typeof runs)[number]) => {
    run.finish();
    const { taskId, id } = run.input.job;
    await vi.waitFor(() =>
      expect(f.store.jobs(taskId).find((job) => job.id === id)?.status).toBe('completed'),
    );
    f.store.saveTask({ ...f.store.getTask(taskId), state: 'complete' });
  };
  try {
    await f.daddy.configureWorker(group.id, 2, tuned);
    const matched = await f.daddy.createTask(group.id, {
      validatePlan: false,
      requirements: 'Use the tuned worker',
      requestId: 'matching',
      workerRequest: { profile: tuned },
    });
    const pinned = await f.daddy.createTask(group.id, {
      validatePlan: false,
      requirements: 'Wait for worker 2',
      requestId: 'pinned',
      workerRequest: { slot: 2 },
    });
    const ordinary = await f.daddy.createTask(group.id, {
      validatePlan: false,
      requirements: 'Fit anywhere',
      requestId: 'ordinary',
    });
    const retuned = await f.daddy.createTask(group.id, {
      validatePlan: false,
      requirements: 'A new profile',
      requestId: 'retuned',
      workerRequest: { profile: alternate },
    });
    await f.worker.tick();
    await vi.waitFor(() => expect(runs).toHaveLength(2));
    expect(f.daddy.board(group.id).workers.slots).toEqual([
      { number: 1, taskId: ordinary.id },
      { number: 2, taskId: matched.id, profile: tuned },
    ]);
    expect(runs.map(({ input }) => input.job.profile)).toEqual([tuned, profiles.worker]);
    await expect(f.daddy.settings(group.id, { workerLimit: 1 })).rejects.toThrow(
      'A task is waiting for a worker that would be removed',
    );

    await finish(runs[1]!);
    await f.worker.tick();
    await vi.waitFor(() => expect(runs).toHaveLength(3));
    expect(runs[2]!.input.job).toMatchObject({ taskId: retuned.id, profile: alternate });
    expect(f.store.jobs(pinned.id)[0]!.status).toBe('queued');
    expect(f.daddy.board(group.id).workers.slots[0]).toMatchObject({
      number: 1,
      taskId: retuned.id,
      profile: alternate,
    });
    const followup = await f.daddy.createTask(group.id, {
      validatePlan: false,
      requirements: 'Inherit the assigned worker profile',
      requestId: 'inherit',
    });
    await f.engine.chat(followup.id, 'author', 'Follow-up queued before assignment');
    await finish(runs[2]!);
    await f.worker.tick();
    await vi.waitFor(() => expect(runs).toHaveLength(4));
    expect(runs[3]!.input.job.taskId).toBe(followup.id);
    expect(f.store.jobs(followup.id).map((job) => job.profile)).toEqual([alternate, alternate]);
  } finally {
    runs.forEach(({ finish }) => finish());
    await f.close();
  }
});

it('forces only the active author attempt to restart and preserves its queue order and working copy', async () => {
  const f = daddyFixture(),
    runs = holdWorker(f);
  const group = f.daddy.create({ workspaceId: f.workspace.id });
  const next = { engine: 'claude', model: 'sonnet', effort: 'high' };
  try {
    const task = await f.daddy.createTask(group.id, {
      validatePlan: false,
      requirements: 'Continue in the author copy',
      requestId: 'forced',
    });
    await f.worker.tick();
    await vi.waitFor(() => expect(runs).toHaveLength(1));
    const first = runs[0]!.input;
    const file = join(first.cwd, 'uncommitted.txt');
    writeFileSync(file, 'unfinished edit');
    await f.engine.chat(task.id, 'author', 'Follow-up after implementation');

    expect(await f.daddy.configureWorker(group.id, 1, next)).toEqual({
      restarted: false,
      profile: next,
    });
    expect(first.signal.aborted).toBe(false);
    expect(f.store.getTask(task.id).agents?.worker).toEqual(profiles.worker);

    await expect(
      f.daddy.configureWorker(group.id, 1, next, { force: true, expectedTaskId: 'old-task' }),
    ).rejects.toMatchObject({ code: 'stale_worker' });
    expect(first.signal.aborted).toBe(false);
    expect(
      await f.daddy.configureWorker(group.id, 1, next, { force: true, expectedTaskId: task.id }),
    ).toEqual({ restarted: true, profile: next });
    expect(first.signal.aborted).toBe(true);
    expect(f.store.getTask(task.id)).toMatchObject({
      generation: task.generation + 1,
      agents: { worker: next, daddy: profiles.daddy },
    });
    first.onSession('stale-author-thread');
    expect(f.store.getTask(task.id).authorThreadId).toBeUndefined();
    expect(f.store.activeJobs().map((job) => [job.kind, job.profile])).toEqual([
      ['implement', next],
      ['chat', next],
    ]);
    await f.worker.tick();
    expect(runs).toHaveLength(1);

    runs[0]!.finish();
    await vi.waitFor(() =>
      expect(f.store.events(task.id).some((event) => event.type === 'job.cancelled')).toBe(true),
    );
    expect(f.checkouts.commitTicket).not.toHaveBeenCalled();
    await f.worker.tick();
    await vi.waitFor(() => expect(runs).toHaveLength(2));
    const replacement = runs[1]!.input;
    expect(replacement.cwd).toBe(first.cwd);
    expect(readFileSync(file, 'utf8')).toBe('unfinished edit');
    expect(replacement.job).toMatchObject({
      kind: 'implement',
      input: first.job.input,
      profile: next,
    });
    expect(replacement.job.id).not.toBe(first.job.id);
  } finally {
    runs.forEach(({ finish }) => finish());
    await f.close();
  }
});

function confirmWorker(
  f: ReturnType<typeof daddyFixture>,
  groupId: string,
  locale: Locale = 'en',
  inTopic = false,
) {
  const app = Fastify();
  registerDaddy(app, f.daddy);
  const cards: TelegramCard[] = [];
  const api = {
    send: async (_destination: unknown, card: TelegramCard) => {
      cards.push(card);
    },
    call: async () => ({}),
    replaceCard: async (_callback: unknown, action: () => Promise<void>) => action(),
  } as unknown as TelegramApi;
  const workspace = new TelegramWorkspace(f.daddy, api, 'fixture_bot', () => locale);
  f.store.setSetting('telegram.pairing', { chatId: 7, userId: 7 });
  f.store.setSetting('telegram.currentDaddy', groupId);
  const chat = inTopic ? { id: -10042, type: 'supergroup' } : { id: 7, type: 'private' };
  const message_thread_id = inTopic ? 17 : undefined;
  if (inTopic) {
    f.store.setSetting('telegram.group', { chatId: chat.id, title: 'Work', ownerId: 7 });
    f.store.db
      .prepare('INSERT INTO telegram_topics VALUES(?,?,?)')
      .run(
        `7:${chat.id}:${groupId}`,
        groupId,
        JSON.stringify({ chatId: chat.id, threadId: message_thread_id, groupId, ownerId: 7 }),
      );
  }
  let updateId = 0;
  const send = (text: string) =>
    workspace.handle({
      update_id: ++updateId,
      message: { from: { id: 7 }, chat, message_thread_id, text },
    });
  const command = (choice: string) => send('/worker 1 ' + choice);
  const prompt = async (choice = 'gpt-6-astra') => {
    await command(choice + ' --force');
    const button = cards.at(-1)!.buttons![0]![0]!;
    if (!('callback_data' in button) || !button.callback_data)
      throw new Error('Missing force confirmation');
    return button.callback_data;
  };
  const confirm = (data: string) =>
    workspace.handle({
      update_id: ++updateId,
      callback_query: {
        id: String(updateId),
        data,
        from: { id: 7 },
        message: { chat, message_thread_id },
      },
    });
  const save = (profile: AgentProfile, baseline: AgentProfile) =>
    app.inject({
      method: 'POST',
      url: '/api/daddy/sessions/' + groupId + '/workers/1',
      payload: { profile, baseline, expectedGeneration: f.daddy.group(groupId).generation },
    });

  return {
    cards,
    send,
    post: (path: string, payload: object) =>
      app.inject({ method: 'POST', url: '/api/daddy/sessions/' + groupId + path, payload }),
    command,
    prompt,
    confirm,
    save,
    read: () => app.inject('/api/daddy/sessions/' + groupId),

    async close() {
      await workspace.stop();
      await app.close();
    },
  };
}

it.each([false, true])(
  'queues direct Telegram tasks for the received generation, topic=%s',
  async (inTopic) => {
    const f = daddyFixture();
    const group = f.daddy.create({ workspaceId: f.workspace.id });
    const controls = confirmWorker(f, group.id, 'en', inTopic);
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      const lock = f.engine.lock('create-task:' + group.id, () => blocked);
      const pause = f.daddy.pause(group.id);
      const resume = f.daddy.resume(group.id);
      const create = vi.spyOn(f.daddy, 'createTask');
      const command = '/task --no-plan --engine claude -- Keep this task and profile';
      const pending = controls.send(command);
      try {
        await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
      } finally {
        release();
        await Promise.all([lock, pause, resume, pending]);
        create.mockRestore();
      }
      expect(f.store.tasks(group.id)).toHaveLength(0);
      expect(controls.cards.at(-1)?.text).toContain('session changed');
      await controls.send(command);
      const [task] = f.store.tasks(group.id);
      expect(task?.requirements).toBe('Keep this task and profile');
      expect(f.store.jobs(task!.id)).toMatchObject([
        { kind: 'implement', profile: { engine: 'claude' } },
      ]);
    } finally {
      release();
      await controls.close();
      await f.close();
    }
  },
);

it.each([
  { field: 'model', choice: 'gpt-6-astra max', late: { ...profiles.worker, model: 'gpt-6-astra' } },
  { field: 'engine', choice: '--engine claude', late: { engine: 'claude' } },
  { field: 'effort', choice: 'gpt-5.6-sol medium', late: { ...profiles.worker, effort: 'medium' } },
])(
  'rejects a web restart after a Telegram change to the shown $field',
  async ({ choice, late }) => {
    const f = daddyFixture();
    const runs = holdWorker(f);
    const group = f.daddy.create({ workspaceId: f.workspace.id });
    const controls = confirmWorker(f, group.id);
    try {
      const task = await f.daddy.createTask(group.id, {
        validatePlan: false,
        requirements: 'Restart the profile displayed in the form',
        requestId: 'web-confirm-profile',
      });
      await f.worker.tick();
      await vi.waitFor(() => expect(runs).toHaveLength(1));
      const active = runs[0]!;
      const force = (profile: AgentProfile) =>
        controls.post('/workers/1', {
          profile,
          baseline: profile,
          expectedGeneration: group.generation,
          forceTaskId: task.id,
          expected: {
            groupGeneration: group.generation,
            task: {
              head: task.revision?.head ?? '',
              revision: task.revision,
              generation: task.generation,
            },
          },
        });
      expect((await force(profiles.worker)).json()).toEqual({ restarted: false });
      await controls.command(choice);
      expect((await controls.read()).json().workers.slots[0].profile).toEqual(late);
      expect(active.input.signal.aborted).toBe(false);
      expect((await force(profiles.worker)).statusCode).toBe(409);
      expect(active.input.signal.aborted).toBe(false);
      expect((await force(late)).json()).toEqual({ restarted: true });
      expect(active.input.signal.aborted).toBe(true);
      active.finish();
      await vi.waitFor(async () => {
        await f.worker.tick();
        expect(runs).toHaveLength(2);
      });
      expect(runs[1]!.input.job.profile).toEqual(late);
    } finally {
      runs.forEach(({ finish }) => finish());
      await controls.close();
      await f.close();
    }
  },
);

it.each([
  { client: 'http', inherit: false },
  { client: 'private', inherit: false },
  { client: 'topic', inherit: false },
  { client: 'http', inherit: true },
] as const)(
  'queues the chosen worker for an imported or fresh issue via $client, inherit=$inherit',
  async ({ client, inherit }) => {
    const f = daddyFixture();
    const group = f.daddy.create({ workspaceId: f.workspace.id, workerLimit: 2 });
    const controls = confirmWorker(
      f,
      group.id,
      client === 'topic' ? 'ru' : 'en',
      client === 'topic',
    );
    const runs = holdWorker(f);
    const imported = ticketInput(42);
    const fresh = ticketInput(43);
    const read = vi
      .spyOn(f.daddy.tickets.reader, 'read')
      .mockImplementation(async (url) => (url === imported.ref.url ? imported : fresh));
    const requestId = randomUUID();
    const workerRequest = { slot: 2, ...(inherit ? {} : { profile: { engine: 'claude' } }) };
    const expectedProfile = inherit ? profiles.worker : workerRequest.profile;
    const post = (id: string, url: string) =>
      controls.post('/tasks', {
        requestId: id,
        requirements: url,
        validatePlan: false,
        workerRequest,
      });
    try {
      const existing = await f.engine.createTicket({
        ...imported,
        groupId: group.id,
        repoPath: f.dir,
        scope: f.workspace.scope,
      });
      for (const state of ['paused', 'needs_input'] as const) {
        f.store.saveTask({ ...existing, state });
        if (client === 'http') {
          const response = await post(randomUUID(), imported.ref.url);
          expect(response.statusCode).toBe(409);
          expect(response.json().message).toContain(existing.id.slice(0, 8));
          expect(response.json().message).toContain(state);
        } else {
          await controls.send('/task --no-plan --worker 2 --engine claude -- ' + imported.ref.url);
          expect(controls.cards.at(-1)?.text).toContain(existing.id.slice(0, 8));
          expect(controls.cards.at(-1)?.text).toContain(
            translate(
              client === 'topic' ? 'ru' : 'en',
              state === 'paused' ? 'Paused' : 'Action needed',
            ),
          );
        }
        expect(f.store.activeJobs(existing.id)).toHaveLength(0);
      }
      f.store.saveTask({ ...existing, agents: { ...profiles, worker: { engine: 'claude' } } });
      f.store.enqueue(f.store.getTask(existing.id), 'author', 'chat', 'Discuss the issue');
      await f.worker.tick();
      await vi.waitFor(() => expect(runs).toHaveLength(1));
      runs[0]!.finish();
      await vi.waitFor(() => expect(f.store.activeJobs(existing.id)).toHaveLength(0));
      expect(f.daddy.board(group.id).workers.slots[0]?.taskId).toBe(existing.id);
      const send = async (url: string) => {
        if (client === 'http') expect((await post(requestId, url)).statusCode).toBe(201);
        else await controls.send('/task --no-plan --worker 2 --engine claude -- ' + url);
      };
      const requirements = `GitHub issue: ${imported.ref.url}\nOnly update the offline parser fixture`;
      await send(requirements);
      const queued = f.store.getTask(existing.id);
      expect(queued.workerRequest).toEqual(workerRequest);
      await f.worker.tick();
      await vi.waitFor(() => expect(runs).toHaveLength(2));
      expect(runs[1]!.input.prompt).toContain('Only update the offline parser fixture');
      expect(runs[1]!.input.job.profile).toEqual(expectedProfile);
      expect(f.daddy.board(group.id).workers.slots[1]?.taskId).toBe(existing.id);
      runs[1]!.finish();
      await vi.waitFor(() => expect(f.store.activeJobs(existing.id)).toHaveLength(0));
      f.store.saveTask({ ...f.store.getTask(existing.id), state: 'complete' });
      if (client === 'http') {
        f.store.db
          .prepare('DELETE FROM settings WHERE key=?')
          .run(`task.queue:${group.id}:web:task:${requestId}`);
        const replay = await post(requestId, requirements);
        expect(replay.json()).toEqual({ id: existing.id });
        expect(f.store.tasks(group.id)).toHaveLength(1);
      }
      const created = await post(
        randomUUID(),
        requirements.replace(imported.ref.url, fresh.ref.url),
      );
      expect(created.statusCode).toBe(201);
      expect(f.store.getTask(created.json().id).workerRequest).toEqual(workerRequest);
      await f.worker.tick();
      await vi.waitFor(() => expect(runs).toHaveLength(3));
      expect(runs[2]!.input.prompt).toContain('Only update the offline parser fixture');
      expect(runs[2]!.input.job.profile).toEqual(expectedProfile);
      expect(f.daddy.board(group.id).workers.slots[1]?.taskId).toBe(created.json().id);
    } finally {
      read.mockRestore();
      runs.forEach(({ finish }) => finish());
      await controls.close();
      await f.close();
    }
  },
);

it('returns a committed web queue result after the selected folder moves', async () => {
  const f = daddyFixture();
  const group = f.daddy.create({ workspaceId: f.workspace.id });
  const controls = confirmWorker(f, group.id);
  const folder = join(f.dir, 'selected');
  mkdirSync(folder);
  vi.spyOn(f.daddy.workspaces, 'inspect').mockImplementation(async (input) => ({
    ...f.workspace,
    repoPath: realpathSync(input.path),
  }));
  const payload = {
    requestId: randomUUID(),
    requirements: 'Queue in selected folder',
    repository: { path: folder },
  };
  try {
    const original = await controls.post('/tasks', payload);
    expect(original.statusCode).toBe(201);
    expect((await controls.post('/tasks', payload)).json()).toEqual(original.json());
    renameSync(folder, folder + '-moved');
    const replay = await controls.post('/tasks', payload);
    expect(replay.statusCode).toBe(201);
    expect(replay.json()).toEqual(original.json());
    const fresh = await controls.post('/tasks', { ...payload, requestId: randomUUID() });
    expect(fresh.statusCode).not.toBe(201);
    expect(f.store.tasks(group.id)).toHaveLength(1);
    expect(f.store.getTask(original.json().id).repoPath).toBe(folder);
  } finally {
    await controls.close();
    await f.close();
  }
});

it('merges an independent web edit at Telegram force confirmation and leaves a conflicting run active', async () => {
  const f = daddyFixture();
  const runs = holdWorker(f);
  const group = f.daddy.create({ workspaceId: f.workspace.id });
  const controls = confirmWorker(f, group.id);
  const { prompt, confirm, save } = controls;
  try {
    const task = await f.daddy.createTask(group.id, {
      validatePlan: false,
      requirements: 'Keep an active author attempt',
      requestId: 'force-merge',
    });
    await f.worker.tick();
    await vi.waitFor(() => expect(runs).toHaveLength(1));
    const active = runs[0]!.input;
    const conflicting = await prompt();
    const newModel = { ...profiles.worker, model: 'parallel-model' };
    expect((await save(newModel, profiles.worker)).statusCode).toBe(200);
    await confirm(conflicting);
    expect(f.daddy.board(group.id).workers.slots[0]?.profile).toEqual(newModel);
    expect(f.store.getTask(task.id).generation).toBe(task.generation);
    expect(active.signal.aborted).toBe(false);
    expect(f.store.jobs(task.id).find(({ id }) => id === active.job.id)?.status).toBe('running');

    const validate = vi.spyOn(f.daddy.catalogue, 'validate').mockImplementation(async (profile) => {
      if (profile.model === 'high-only' && profile.effort && profile.effort !== 'max')
        throw new AppError('effort_unavailable', 'Choose max effort', 422);
    });
    try {
      const incompatible = await prompt('high-only');
      const later = { ...newModel, effort: 'medium' };
      expect((await save(later, newModel)).statusCode).toBe(200);
      await confirm(incompatible);
      expect(f.daddy.board(group.id).workers.slots[0]?.profile).toEqual(later);
      expect(f.store.getTask(task.id).generation).toBe(task.generation);
      expect(active.signal.aborted).toBe(false);
      expect(f.store.jobs(task.id).find(({ id }) => id === active.job.id)?.status).toBe('running');
      expect((await save(newModel, later)).statusCode).toBe(200);
    } finally {
      validate.mockRestore();
    }

    const compatible = await prompt();
    expect((await save({ ...newModel, effort: 'medium' }, newModel)).statusCode).toBe(200);
    expect(active.signal.aborted).toBe(false);
    await confirm(compatible);
    const merged = { ...profiles.daddy, effort: 'medium' };
    expect(f.daddy.board(group.id).workers.slots[0]?.profile).toEqual(merged);
    expect(active.signal.aborted).toBe(true);
    expect(f.store.getTask(task.id).generation).toBe(task.generation + 1);
    expect(
      f.store.activeJobs().find((job) => job.taskId === task.id && job.status === 'queued')
        ?.profile,
    ).toEqual(merged);
    await confirm(compatible);
    expect(f.store.getTask(task.id).generation).toBe(task.generation + 1);
  } finally {
    runs.forEach(({ finish }) => finish());
    await controls.close();
    await f.close();
  }
});

it.each([
  { choice: 'standard', model: 'standard', unsupported: true },
  { choice: 'gpt-5.6-sol default', model: 'gpt-5.6-sol', unsupported: false },
  { choice: 'gpt-6-astra default', model: 'gpt-6-astra', unsupported: false },
])('shows and applies the default effort for $choice', async ({ choice, model, unsupported }) => {
  const f = daddyFixture();
  const runs = holdWorker(f);
  const group = f.daddy.create({ workspaceId: f.workspace.id });
  const controls = confirmWorker(f, group.id);
  const validate = vi.spyOn(f.daddy.catalogue, 'validate').mockImplementation(async (profile) => {
    if (unsupported && profile.model === model && profile.effort)
      throw new AppError('effort_unavailable', 'The model uses its default effort', 422);
  });
  try {
    const task = await f.daddy.createTask(group.id, {
      validatePlan: false,
      requirements: 'Resume without an effort override',
      requestId: 'force-default',
    });
    await f.worker.tick();
    await vi.waitFor(() => expect(runs).toHaveLength(1));
    const active = runs[0]!.input;
    expect(active.job.profile?.effort).toBe(profiles.worker.effort);
    if (choice.endsWith(' default')) {
      const defaultProfile = { engine: 'codex', model };
      await controls.command(choice);
      expect(f.daddy.board(group.id).workers.slots[0]?.profile).toEqual(defaultProfile);
      expect(active.signal.aborted).toBe(false);
      expect(f.store.jobs(task.id).find(({ id }) => id === active.job.id)?.status).toBe('running');
      expect((await controls.save(profiles.worker, defaultProfile)).statusCode).toBe(200);
    }
    const confirmation = await controls.prompt(choice);
    expect(controls.cards.at(-1)?.text).toContain('codex · ' + model + ' · Default');
    expect(
      f.daddy.board(group.id).workers.slots[0]?.profile?.effort ?? profiles.worker.effort,
    ).toBe(profiles.worker.effort);
    expect(active.signal.aborted).toBe(false);
    await controls.confirm(confirmation);
    expect(f.daddy.board(group.id).workers.slots[0]?.profile).toEqual({ engine: 'codex', model });
    expect(active.signal.aborted).toBe(true);
    expect(
      f.store.activeJobs().find((job) => job.taskId === task.id && job.status === 'queued')
        ?.profile,
    ).toEqual({ engine: 'codex', model });
  } finally {
    validate.mockRestore();
    runs.forEach(({ finish }) => finish());
    await controls.close();
    await f.close();
  }
});

it.each(
  ['max', undefined].flatMap((initial) =>
    [false, true].flatMap((force) =>
      [false, true].map((explicit) => ({ initial, force, explicit })),
    ),
  ),
)(
  'worker effort intent: $initial, force=$force, explicit=$explicit',
  async ({ initial, force, explicit }) => {
    const f = daddyFixture();
    const runs = holdWorker(f);
    const group = f.daddy.create({ workspaceId: f.workspace.id });
    const controls = confirmWorker(f, group.id);
    const baseline = { ...profiles.worker, effort: initial };
    const later = { ...baseline, effort: 'medium' };
    const model = profiles.daddy.model!;
    const choice = model + (explicit ? ' ' + (initial ?? 'default') : '');
    try {
      expect((await controls.save(baseline, profiles.worker)).statusCode).toBe(200);
      const task = await f.daddy.createTask(group.id, {
        validatePlan: false,
        requirements: 'Preserve explicit choice on the slot',
        requestId: 'worker-effort-intent',
      });
      await f.worker.tick();
      await vi.waitFor(() => expect(runs).toHaveLength(1));
      const active = runs[0]!.input;
      if (force) {
        const confirmation = await controls.prompt(choice);
        expect((await controls.save(later, baseline)).statusCode).toBe(200);
        await controls.confirm(confirmation);
      } else {
        let release!: () => void;
        const blocked = new Promise<void>((resolve) => {
          release = resolve;
        });
        const validation = vi
          .spyOn(f.daddy.catalogue, 'validate')
          .mockImplementationOnce(() => blocked);
        const pending = controls.command(choice);
        try {
          await vi.waitFor(() => expect(validation).toHaveBeenCalledOnce());
          expect((await controls.save(later, baseline)).statusCode).toBe(200);
        } finally {
          release();
          await pending;
          validation.mockRestore();
        }
      }
      const expected = explicit ? later : { ...later, model };
      expect(f.daddy.board(group.id).workers.slots[0]?.profile).toEqual(expected);
      expect(active.signal.aborted).toBe(force && !explicit);
      expect(f.store.getTask(task.id).generation).toBe(
        task.generation + Number(force && !explicit),
      );
      if (explicit) expect(controls.cards.at(-1)?.text).toContain('worker.profile.effort');
      if (force && !explicit)
        expect(
          f.store.activeJobs().find((job) => job.taskId === task.id && job.status === 'queued')
            ?.profile,
        ).toEqual(expected);
    } finally {
      runs.forEach(({ finish }) => finish());
      await controls.close();
      await f.close();
    }
  },
);

it.each(
  [false, true].flatMap((force) =>
    (['model', 'engine', 'effort'] as const).map((field) => ({ force, field })),
  ),
)('worker named selection: $field, force=$force', async ({ force, field }) => {
  const f = daddyFixture();
  const runs = holdWorker(f);
  const group = f.daddy.create({ workspaceId: f.workspace.id });
  const controls = confirmWorker(f, group.id);
  const baseline = profiles.worker;
  const later =
    field === 'model'
      ? { ...baseline, model: profiles.daddy.model }
      : field === 'engine'
        ? { engine: 'claude', model: 'sonnet', effort: 'high' }
        : { ...baseline, effort: 'medium' };
  const choice = baseline.model! + (field === 'engine' ? ' --engine codex' : '');
  try {
    const task = await f.daddy.createTask(group.id, {
      validatePlan: false,
      requirements: 'Keep the explicitly selected model and engine',
      requestId: 'worker-named-selection',
    });
    await f.worker.tick();
    await vi.waitFor(() => expect(runs).toHaveLength(1));
    const active = runs[0]!.input;
    if (force) {
      const confirmation = await controls.prompt(choice);
      expect((await controls.save(later, baseline)).statusCode).toBe(200);
      await controls.confirm(confirmation);
    } else {
      let release!: () => void;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      const validation = vi
        .spyOn(f.daddy.catalogue, 'validate')
        .mockImplementationOnce(() => blocked);
      const pending = controls.command(choice);
      try {
        await vi.waitFor(() => expect(validation).toHaveBeenCalledOnce());
        expect((await controls.save(later, baseline)).statusCode).toBe(200);
      } finally {
        release();
        await pending;
        validation.mockRestore();
      }
    }
    expect((await controls.read()).json().workers.slots[0].profile).toEqual(later);
    const restarted = force && field === 'effort';
    expect(active.signal.aborted).toBe(restarted);
    expect(f.store.getTask(task.id).generation).toBe(task.generation + Number(restarted));
    if (field !== 'effort')
      expect(controls.cards.at(-1)?.text).toContain('worker.profile.' + field);
    if (restarted)
      expect(f.store.activeJobs(task.id).find((job) => job.status === 'queued')?.profile).toEqual(
        later,
      );
  } finally {
    runs.forEach(({ finish }) => finish());
    await controls.close();
    await f.close();
  }
});

it.each(
  (['daddy', 'worker', 'architect', 'task'] as const).flatMap((role) => [
    { role, inTopic: false },
    { role, inTopic: true },
  ]),
)(
  'offers default effort and engine configuration in the $role profile menu, topic=$inTopic',
  async ({ role, inTopic }) => {
    const f = daddyFixture();
    const group = f.daddy.create({ workspaceId: f.workspace.id });
    const locale = inTopic ? 'ru' : 'en';
    const controls = confirmWorker(f, group.id, locale, inTopic);
    try {
      const task =
        role === 'task'
          ? await f.daddy.createTask(group.id, {
              requirements: 'Choose an explicit task architect',
              requestId: 'architect-default',
            })
          : undefined;
      const menu = () =>
        controls.confirm(task ? 'dad:arch-task:' + task.id : 'dad:models:' + group.id + ':' + role);
      const click = async (name: string) => {
        const button = controls.cards
          .at(-1)
          ?.buttons?.flat()
          .find((button) => button.text === name);
        expect(button, 'missing button ' + name).toBeDefined();
        if (button && 'callback_data' in button && button.callback_data)
          await controls.confirm(button.callback_data);
      };
      const profile = async () => {
        const board = (await controls.read()).json();
        return task
          ? board.tasks.find(({ id }: { id: string }) => id === task.id)?.architectProfile
          : board.group[role === 'architect' ? 'architectProfile' : role];
      };
      const select = async (model: string, effort: string) => {
        await menu();
        await click('codex · ' + model);
        await click(effort);
      };
      await select('gpt-6-astra', 'max');
      expect(await profile()).toEqual(profiles.daddy);
      await select('gpt-5.6-sol', translate(locale, 'Default'));
      expect(await profile()).toEqual({ engine: 'codex', model: 'gpt-5.6-sol' });
      const list = vi.spyOn(f.daddy.catalogue, 'list');
      for (const unavailable of [false, true]) {
        if (unavailable) list.mockRejectedValue(new Error('Offline catalogue'));
        else list.mockResolvedValue([]);
        await menu();
        await click('codex · ' + translate(locale, 'Engine configuration'));
        expect(await profile()).toEqual({ engine: 'codex' });
      }
      if (role === 'task' || role === 'architect') {
        expect(f.daddy.group(group.id).daddy.model).toBeDefined();
        await menu();
        await click(
          translate(
            locale,
            task ? 'Use the session architect profile' : 'Use the shared reviewer profile',
          ),
        );
        expect(await profile()).toBeUndefined();
      }
      list.mockRestore();
    } finally {
      vi.restoreAllMocks();
      await controls.close();
      await f.close();
    }
  },
);

it.each(
  ['http', 'telegram'].flatMap((client) =>
    [false, true].flatMap((occupied) =>
      [false, true].map((converged) => ({ client, occupied, converged })),
    ),
  ),
)(
  'checks the $client bulk profile against shown slot overrides, occupied=$occupied, converged=$converged',
  async ({ client, occupied, converged }) => {
    const f = daddyFixture();
    const runs = occupied ? holdWorker(f) : [];
    const group = f.daddy.create({ workspaceId: f.workspace.id });
    const controls = confirmWorker(f, group.id);
    try {
      if (occupied) {
        await f.daddy.createTask(group.id, {
          validatePlan: false,
          requirements: 'Keep the current run active',
          requestId: 'occupied-bulk-profile',
        });
        await f.worker.tick();
        await vi.waitFor(() => expect(runs).toHaveLength(1));
      }
      const baseline = profiles.worker;
      const later = { ...baseline, effort: 'medium' };
      const preview = async (fresh = false) => {
        const board = (await controls.read()).json();
        if (client === 'http')
          return () =>
            controls.post('/settings', {
              profiles: { worker: { engine: 'codex' } },
              autoMerge: true,
              applyWorkers: fresh,
              baseline: {
                profiles: { worker: board.workerDefault },
                workerSlotProfiles:
                  board.group.workerSlots?.flatMap(
                    ({ number, profile }: { number: number; profile?: AgentProfile }) =>
                      profile ? [{ number, profile }] : [],
                  ) ?? [],
              },
            });
        await controls.confirm('dad:models:' + group.id + ':worker');
        const button = controls.cards
          .at(-1)!
          .buttons!.flat()
          .find(({ text }) => text === 'codex · Engine configuration')!;
        if (!('callback_data' in button) || !button.callback_data)
          throw new Error('Missing profile button');
        return () => controls.confirm(button.callback_data!);
      };
      const stale = await preview();
      if (converged)
        await f.daddy.settings(group.id, { profiles: { worker: { engine: 'codex' } } });
      if (client === 'http') await controls.command('gpt-5.6-sol medium');
      else
        expect(
          (await controls.save(later, converged ? { engine: 'codex' } : baseline)).statusCode,
        ).toBe(200);
      const response = await stale();
      if (client === 'http') expect(response).toMatchObject({ statusCode: 409 });
      else expect(controls.cards.at(-1)?.text).toContain('workerSlotProfiles');
      const kept = (await controls.read()).json();
      expect(kept.workers.slots[0].profile).toEqual(later);
      expect(kept.group.autoMerge).toBe(false);
      await (
        await preview(true)
      )();
      const saved = (await controls.read()).json();
      expect(saved.workerDefault).toEqual({ engine: 'codex' });
      expect(saved.workers.slots[0].profile).toBeUndefined();
      for (const { input } of runs) expect(input.signal.aborted).toBe(false);
    } finally {
      runs.forEach(({ finish }) => finish());
      await controls.close();
      await f.close();
    }
  },
);

it.each([false, true])(
  'queues explicit worker engine, named model and inheritance in topic=%s',
  async (inTopic) => {
    const f = daddyFixture();
    const group = f.daddy.create({ workspaceId: f.workspace.id });
    const controls = confirmWorker(f, group.id, 'en', inTopic);
    const runs = holdWorker(f);
    try {
      await controls.send('/task --no-plan --engine claude -- Engine only');
      await controls.send('/task --no-plan --model gpt-5.6-sol --effort medium -- Named model');
      await controls.send('/task --no-plan -- Inherited worker');
      const byTitle = Object.fromEntries(
        f.store
          .tasks(group.id)
          .map((task) => [task.requirements, f.store.jobs(task.id)[0]?.profile]),
      );
      expect(byTitle).toEqual({
        'Engine only': { engine: 'claude' },
        'Named model': { ...profiles.worker, effort: 'medium' },
        'Inherited worker': profiles.worker,
      });
      await f.worker.tick();
      await vi.waitFor(() => expect(runs).toHaveLength(1));
      expect(runs[0]!.input.job.profile).toEqual({ engine: 'claude' });
    } finally {
      runs.forEach(({ finish }) => finish());
      await controls.close();
      await f.close();
    }
  },
);

it.each(['http', 'telegram'] as const)(
  'preserves a later queued worker request during %s bulk save, before and after assignment',
  async (client) => {
    const f = daddyFixture();
    const group = f.daddy.create({ workspaceId: f.workspace.id });
    const controls = confirmWorker(f, group.id);
    const runs = holdWorker(f);
    const profile = { ...profiles.worker, effort: 'medium' };
    try {
      let callback = '';
      if (client === 'telegram') {
        await controls.confirm('dad:models:' + group.id + ':worker');
        const button = controls.cards
          .at(-1)!
          .buttons!.flat()
          .find((button) => button.text === 'codex · Engine configuration');
        if (!button || !('callback_data' in button) || !button.callback_data)
          throw new Error('Missing choice');
        callback = button.callback_data;
      }
      const bulk = async () => {
        if (client === 'telegram') {
          await controls.confirm(callback);
          expect(controls.cards.at(-1)?.text).toContain('workerTaskProfiles');
        } else {
          const result = await controls.post('/settings', {
            profiles: { worker: { engine: 'codex' } },
            autoMerge: true,
            baseline: { profiles: { worker: profiles.worker }, workerSlotProfiles: [] },
          });
          expect(result.statusCode).toBe(409);
        }
      };
      if (client === 'http')
        await controls.send(
          '/task --no-plan --worker 1 --model gpt-5.6-sol --effort medium -- Preserve request',
        );
      else
        expect(
          (
            await controls.post('/tasks', {
              requirements: 'Preserve request',
              requestId: randomUUID(),
              validatePlan: false,
              workerRequest: { slot: 1, profile },
            })
          ).statusCode,
        ).toBe(201);
      const task = f.store.tasks(group.id)[0]!;
      await bulk();
      expect(f.store.getTask(task.id).workerRequest?.profile).toEqual(profile);
      expect(f.store.jobs(task.id)[0]?.profile).toEqual(profile);
      await f.worker.tick();
      await vi.waitFor(() => expect(runs).toHaveLength(1));
      expect(runs[0]!.input.job.profile).toEqual(profile);
      if (client === 'http') {
        await bulk();
      } else {
        await controls.confirm(callback);
        expect(controls.cards.at(-1)?.text).toMatch(/workerSlotProfiles|workerTaskProfiles/);
      }
      expect((await controls.read()).json().group.autoMerge).toBe(false);
      if (client === 'http') {
        const board = (await controls.read()).json();
        const fresh = await controls.post('/settings', {
          profiles: { worker: { engine: 'codex' } },
          baseline: {
            profiles: { worker: board.workerDefault },
            workerSlotProfiles: [{ number: 1, profile }],
            workerTaskProfiles: { [task.id]: profile },
          },
        });
        expect(fresh.statusCode).toBe(200);
        expect(f.store.getTask(task.id).workerRequest?.profile).toEqual({ engine: 'codex' });
        expect(runs[0]!.input.signal.aborted).toBe(false);
      }
    } finally {
      runs.forEach(({ finish }) => finish());
      await controls.close();
      await f.close();
    }
  },
);

it.each([false, true])(
  'uses the chosen architect engine in the first queued plan, topic=%s',
  async (inTopic) => {
    const f = daddyFixture();
    const group = f.daddy.create({ workspaceId: f.workspace.id });
    const controls = confirmWorker(f, group.id, 'en', inTopic);
    try {
      await f.daddy.settings(group.id, { architectProfile: profiles.worker });
      expect(
        (
          await controls.post('/tasks', {
            requirements: 'Web chooses engine',
            requestId: randomUUID(),
            architectProfile: { engine: 'codex' },
          })
        ).statusCode,
      ).toBe(201);
      await controls.send('/task --architect-engine codex -- Telegram chooses engine');
      await controls.send('/task Inherited architect');
      const byTitle = Object.fromEntries(
        f.store
          .tasks(group.id)
          .map((task) => [task.requirements, f.store.jobs(task.id)[0]?.profile]),
      );
      expect(byTitle).toEqual({
        'Web chooses engine': { engine: 'codex' },
        'Telegram chooses engine': { engine: 'codex' },
        'Inherited architect': profiles.worker,
      });
    } finally {
      await controls.close();
      await f.close();
    }
  },
);

it.each([
  { provider: 'gitlab', client: 'telegram' },
  { provider: 'arcanum', client: 'http' },
  { provider: 'github', client: 'http' },
])('keeps review work paused for $provider through $client', async ({ provider, client }) => {
  const f = daddyFixture();
  const group = f.daddy.create({ workspaceId: f.workspace.id });
  const controls = confirmWorker(f, group.id);
  try {
    const task = await f.engine.create({
      groupId: group.id,
      requirements: 'Review after the session resumes',
      repoPath: f.dir,
      ref: {
        kind: 'pull_request',
        provider,
        host: 'fixture.local',
        repo: 'test/repo',
        number: 42,
        url: 'https://fixture.local/pr/42',
      },
    });
    f.store.saveTask({ ...task, round: 15, reviewRoundLimit: 15 });
    await f.engine.review(task.id);
    expect(f.store.getTask(task.id).state).toBe('paused');
    await f.daddy.pause(group.id);
    const expected = {
      task: {
        head: task.revision!.head,
        revision: task.revision,
        generation: f.store.getTask(task.id).generation,
      },
      groupGeneration: f.daddy.group(group.id).generation,
      limit: 15,
    };
    const path = '/tasks/' + task.id + '/review-limit';
    expect((await controls.post(path, { limit: 16, expected })).statusCode).toBe(200);
    if (client === 'http') {
      expect((await controls.post(path + '/resume', { ...expected, limit: 16 })).statusCode).toBe(
        200,
      );
    } else {
      await controls.confirm('dad:task:' + task.id);
      const button = controls.cards
        .at(-1)
        ?.buttons?.flat()
        .find(({ text }) => text === 'Resume task');
      if (!button || !('callback_data' in button) || !button.callback_data)
        throw new Error('Missing resume button');
      await controls.confirm(button.callback_data);
    }
    expect(f.store.getTask(task.id).state).toBe('queued');
    await f.worker.tick();
    expect(f.store.getTask(task.id)).toMatchObject({ state: 'queued', round: 15 });
    expect(f.store.getTask(task.id).review).toBeUndefined();
    expect(f.store.activeJobs(task.id)).toHaveLength(0);
    await f.daddy.resume(group.id);
    await f.engine.review(task.id);
    expect(f.store.getTask(task.id)).toMatchObject({ state: 'reviewing', round: 16 });
    expect(f.store.activeJobs(task.id)).toMatchObject([{ kind: 'review' }]);
  } finally {
    await controls.close();
    await f.close();
  }
});

it('clears a worker slot model through Telegram and HTTP while retaining its engine', async () => {
  const f = daddyFixture();
  const group = f.daddy.create({ workspaceId: f.workspace.id });
  const controls = confirmWorker(f, group.id);
  const engineProfile = { engine: profiles.worker.engine };
  try {
    await controls.command('--engine codex');
    expect((await controls.read()).json().workers.slots[0].profile).toEqual(engineProfile);
    await controls.command('gpt-5.6-sol max');
    expect((await controls.read()).json().workers.slots[0].profile).toEqual(profiles.worker);
    const baseline = { engine: 'codex', model: profiles.worker.model };
    expect((await controls.save(baseline, profiles.worker)).statusCode).toBe(200);
    expect((await controls.save(profiles.worker, baseline)).statusCode).toBe(200);
    expect((await controls.save(engineProfile, baseline)).statusCode).toBe(409);
    expect((await controls.read()).json().workers.slots[0].profile).toEqual(profiles.worker);
    expect((await controls.save(engineProfile, profiles.worker)).statusCode).toBe(200);
    expect((await controls.read()).json().workers.slots[0].profile).toEqual(engineProfile);
  } finally {
    await controls.close();
    await f.close();
  }
});

it.each(
  (['en', 'ru'] as const).flatMap((locale) =>
    [false, true].flatMap((occupied) =>
      [false, true].map((supported) => ({ locale, occupied, supported })),
    ),
  ),
)(
  'worker save reply: $locale, occupied=$occupied, supports inherited effort=$supported',
  async ({ locale, occupied, supported }) => {
    const f = daddyFixture();
    const runs = holdWorker(f);
    const group = f.daddy.create({ workspaceId: f.workspace.id });
    const controls = confirmWorker(f, group.id, locale);
    const target = { engine: 'claude', model: 'next-model' };
    const validate = vi.spyOn(f.daddy.catalogue, 'validate').mockImplementation(async (profile) => {
      if (!supported && profile.model === target.model && profile.effort)
        throw new AppError('effort_unavailable', 'Use the default reasoning effort', 422);
    });
    try {
      const baseline = { engine: 'claude', model: 'old-model', effort: 'high' };
      expect((await controls.save(baseline, profiles.worker)).statusCode).toBe(200);
      if (occupied) {
        await f.daddy.createTask(group.id, {
          validatePlan: false,
          requirements: 'Keep the current author attempt',
          requestId: 'worker-reply',
        });
        await f.worker.tick();
        await vi.waitFor(() => expect(runs).toHaveLength(1));
      }
      await controls.command(target.model + (occupied ? '' : ' --force'));
      const saved = (await controls.read()).json().workers.slots[0].profile;
      expect(saved).toEqual(supported ? { ...target, effort: 'high' } : target);
      const title = translate(locale, 'Worker {number} model saved · {profile}', {
        number: 1,
        profile: [saved.engine, saved.model, saved.effort ?? translate(locale, 'Default')].join(
          ' · ',
        ),
      });
      expect(controls.cards.at(-1)).toBe(title);
      if (occupied) expect(runs[0]!.input.signal.aborted).toBe(false);
    } finally {
      validate.mockRestore();
      runs.forEach(({ finish }) => finish());
      await controls.close();
      await f.close();
    }
  },
);

it('legacy force confirmation requires a fresh preview', async () => {
  const f = daddyFixture();
  const runs = holdWorker(f);
  const group = f.daddy.create({ workspaceId: f.workspace.id });
  const controls = confirmWorker(f, group.id);
  try {
    const task = await f.daddy.createTask(group.id, {
      validatePlan: false,
      requirements: 'Keep the active run until a valid confirmation',
      requestId: 'legacy-force',
    });
    await f.worker.tick();
    await vi.waitFor(() => expect(runs).toHaveLength(1));
    const active = runs[0]!.input;
    const fresh = await controls.prompt();
    const legacyKey = 'legacy_force_001';
    expect(
      f.store.db
        .prepare(
          "INSERT INTO bot_actions(id,data,consumed) SELECT ?,json_remove(data,'$.confirmedProfile'),consumed FROM bot_actions WHERE id=?",
        )
        .run(legacyKey, fresh.slice('dad:force:'.length)).changes,
    ).toBe(1);
    await controls.confirm('dad:force:' + legacyKey);
    expect(f.store.getTask(task.id).generation).toBe(task.generation);
    expect(active.signal.aborted).toBe(false);
    expect(f.store.jobs(task.id).find(({ id }) => id === active.job.id)?.status).toBe('running');
    expect(f.daddy.board(group.id).workers.slots[0]?.profile ?? profiles.worker).toEqual(
      profiles.worker,
    );
    expect(controls.cards.at(-1)?.text).toContain('Open a fresh card');

    await controls.confirm(fresh);
    expect(f.daddy.board(group.id).workers.slots[0]?.profile).toEqual(profiles.daddy);
    expect(active.signal.aborted).toBe(true);
    expect(f.store.getTask(task.id).generation).toBe(task.generation + 1);
    await controls.confirm(fresh);
    expect(f.store.getTask(task.id).generation).toBe(task.generation + 1);
  } finally {
    runs.forEach(({ finish }) => finish());
    await controls.close();
    await f.close();
  }
});

it('keeps a result that is already being saved when the model is switched', async () => {
  const f = daddyFixture();
  const group = f.daddy.create({ workspaceId: f.workspace.id });
  let saveCommit!: (head: string) => void;
  const saved = new Promise<string>((resolve) => {
    saveCommit = resolve;
  });
  vi.mocked(f.checkouts.commitTicket).mockReturnValue(saved);
  try {
    const task = await f.daddy.createTask(group.id, {
      validatePlan: false,
      requirements: 'Save before switching',
      requestId: 'saving',
    });
    await f.worker.tick();
    await vi.waitFor(() => expect(f.checkouts.commitTicket).toHaveBeenCalledOnce());
    expect(await f.daddy.configureWorker(group.id, 1, profiles.daddy, { force: true })).toEqual({
      restarted: false,
      profile: profiles.daddy,
    });
    saveCommit('b'.repeat(40));
    await vi.waitFor(() =>
      expect(f.store.getTask(task.id)).toMatchObject({
        state: 'ready_for_review',
        pendingAuthorHead: 'b'.repeat(40),
        agents: { worker: profiles.daddy },
      }),
    );
    expect(f.store.jobs(task.id)).toHaveLength(1);
  } finally {
    saveCommit('b'.repeat(40));
    await f.close();
  }
});

it('applies the common worker profile to overridden slots, assigned tasks and queued turns', async () => {
  const f = daddyFixture(),
    runs = holdWorker(f);
  try {
    const group = f.daddy.create({ workspaceId: f.workspace.id, workerLimit: 2 });
    const override = { engine: 'claude', model: 'sonnet', effort: 'high' };
    await f.daddy.configureWorker(group.id, 1, override);
    const task = await f.daddy.createTask(group.id, {
      validatePlan: false,
      requirements: 'Active job',
      requestId: 'active',
      workerRequest: { slot: 1 },
    });
    await f.worker.tick();
    await vi.waitFor(() => expect(runs).toHaveLength(1));
    const waiting = await f.daddy.createTask(group.id, {
      validatePlan: false,
      requirements: 'Next job',
      requestId: 'waiting',
      workerRequest: { profile: override },
    });
    await f.daddy.settings(group.id, { profiles: { worker: profiles.worker }, applyWorkers: true });
    const board = f.daddy.board(group.id);
    expect(board.workers.slots.every((s) => !s.profile)).toBe(true);
    expect(board.workerDefault).toEqual(profiles.worker);
    expect(runs[0].input.signal.aborted).toBe(false);
    expect(runs[0].input.job.profile).toEqual(override);
    expect(f.store.getTask(task.id).agents?.worker).toEqual(profiles.worker);
    expect(f.store.getTask(waiting.id).workerRequest?.profile).toEqual(profiles.worker);
    expect(f.store.activeJobs(waiting.id)[0].profile).toEqual(profiles.worker);
    runs[0].input.onSession('stale-author-thread');
    expect(f.store.getTask(task.id).authorThreadId).toBeUndefined();
  } finally {
    runs.forEach((r) => r.finish());
    await f.close();
  }
});

it('forces a busy coordinator onto the selected model, preserving its request and rejecting late tools', async () => {
  const f = daddyFixture();
  let finish!: () => void;
  const held = new Promise<void>((r) => {
    finish = r;
  });
  f.runtime.runSession.mockImplementationOnce(async (input) => {
    input.onSession('previous-coordinator');
    await held;
    return { status: 'completed', summary: 'Ignored late result', checkedHead: '' };
  });
  try {
    const group = f.daddy.create({
      workspaceId: f.workspace.id,
      message: 'Continue the original request',
    });
    f.daddy.tick();
    await vi.waitFor(() => expect(f.runtime.runSession).toHaveBeenCalledOnce());
    const active = f.runtime.runSession.mock.calls[0][0];
    const previous = f.store.daddyJobs(group.id)[0];
    f.daddy.chat(group.id, 'Another request');
    const profile = { engine: 'claude', model: 'sonnet', effort: 'high' };
    await expect(
      f.daddy.settings(group.id, { profiles: { daddy: profile } }),
    ).rejects.toMatchObject({ code: 'daddy_busy' });
    await f.daddy.settings(group.id, { profiles: { daddy: profile }, forceDaddy: true });
    expect(active.signal.aborted).toBe(true);
    expect(f.store.getGroup(group.id).daddyThreadId).toBeUndefined();
    expect(f.store.daddyJobs(group.id).filter((j) => j.status === 'queued')).toMatchObject([
      { firstAttemptId: previous.id, input: previous.input, profile },
      { input: 'Another request', profile },
    ]);
    await expect(active.onTool('read_board', {}, 'late')).rejects.toThrow('no longer active');
    finish();
    await vi.waitFor(() => {
      f.daddy.tick();
      expect(f.runtime.runSession).toHaveBeenCalledTimes(2);
    });
    expect(f.runtime.runSession.mock.calls[1][0].profile).toEqual(profile);
    expect(f.store.messages(group.id).some((m) => m.text === 'Ignored late result')).toBe(false);
  } finally {
    finish();
    await f.close();
  }
});

it('restarts an active shared review while retaining its draft and draft publication gate', async () => {
  const f = daddyFixture(),
    runs = holdWorker(f);
  try {
    const group = f.daddy.create({ workspaceId: f.workspace.id });
    const task = await f.engine.create({
      groupId: group.id,
      requirements: 'Review a PR',
      repoPath: f.dir,
      ref: {
        provider: 'demo',
        host: 'demo',
        repo: 'test/repo',
        number: 12,
        url: 'https://example.test/pull/12',
      },
    });
    await f.engine.review(task.id);
    await f.worker.tick();
    await vi.waitFor(() => expect(runs).toHaveLength(1));
    const previous = f.store.getTask(task.id);
    const profile = { engine: 'claude', model: 'sonnet', effort: 'high' };
    await f.daddy.settings(group.id, { profiles: { daddy: profile }, forceDaddy: true });
    const active = f.store.activeJobs(task.id);
    expect(active).toMatchObject([
      { kind: 'review', status: 'queued', profile, firstAttemptId: runs[0].input.job.id },
    ]);
    expect(f.store.getTask(task.id)).toMatchObject({
      review: { id: previous.review!.id },
      reviewFinished: false,
      generation: previous.generation + 1,
    });
    expect(runs[0].input.signal.aborted).toBe(true);
    runs[0].finish();
    await vi.waitFor(() =>
      expect(f.store.jobs(task.id).find((j) => j.id === runs[0].input.job.id)?.status).toBe(
        'cancelled',
      ),
    );
    await vi.waitFor(async () => {
      await f.worker.tick();
      expect(runs).toHaveLength(2);
    });
    expect(runs[1].input.job.profile).toEqual(profile);
  } finally {
    runs.forEach((r) => r.finish());
    await f.close();
  }
});
