import Fastify from 'fastify';
import { registerDaddy } from '../src/server/daddy.js';
import { TelegramWorkspace } from '../src/integrations/telegram-workspace.js';
import type { TelegramApi } from '../src/integrations/telegram.js';
import type { TelegramCard } from '../src/integrations/telegram-text.js';
import { expect, it, vi } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { daddyFixture } from './daddy-fixture.js';
import { profiles } from './planning-fixture.js';
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

    expect(await f.daddy.configureWorker(group.id, 1, next)).toEqual({ restarted: false });
    expect(first.signal.aborted).toBe(false);
    expect(f.store.getTask(task.id).agents?.worker).toEqual(profiles.worker);

    await expect(
      f.daddy.configureWorker(group.id, 1, next, { force: true, expectedTaskId: 'old-task' }),
    ).rejects.toMatchObject({ code: 'stale_worker' });
    expect(first.signal.aborted).toBe(false);
    expect(
      await f.daddy.configureWorker(group.id, 1, next, { force: true, expectedTaskId: task.id }),
    ).toEqual({ restarted: true });
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

it('merges an independent web edit at Telegram force confirmation and leaves a conflicting run active', async () => {
  const f = daddyFixture();
  const runs = holdWorker(f);
  const group = f.daddy.create({ workspaceId: f.workspace.id });
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
  const workspace = new TelegramWorkspace(f.daddy, api, 'fixture_bot', () => 'en');
  f.store.setSetting('telegram.pairing', { chatId: 7, userId: 7 });
  f.store.setSetting('telegram.currentDaddy', group.id);
  const chat = { id: 7, type: 'private' };
  let updateId = 0;
  const prompt = async () => {
    await workspace.handle({
      update_id: ++updateId,
      message: { from: { id: 7 }, chat, text: '/worker 1 gpt-6-astra --force' },
    });
    const button = cards.at(-1)!.buttons![0]![0]!;
    if (!('callback_data' in button) || !button.callback_data)
      throw new Error('Missing force confirmation');
    return button.callback_data;
  };
  const confirm = (data: string) =>
    workspace.handle({
      update_id: ++updateId,
      callback_query: { id: String(updateId), data, from: { id: 7 }, message: { chat } },
    });
  const save = (profile: typeof profiles.worker, baseline: typeof profiles.worker) =>
    app.inject({
      method: 'POST',
      url: '/api/daddy/sessions/' + group.id + '/workers/1',
      payload: { profile, baseline, expectedGeneration: group.generation },
    });
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
    await workspace.stop();
    await app.close();
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
