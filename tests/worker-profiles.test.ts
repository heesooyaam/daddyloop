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
      requirements: 'Use the tuned worker',
      requestId: 'matching',
      workerRequest: { profile: tuned },
    });
    const pinned = await f.daddy.createTask(group.id, {
      requirements: 'Wait for worker 2',
      requestId: 'pinned',
      workerRequest: { slot: 2 },
    });
    const ordinary = await f.daddy.createTask(group.id, {
      requirements: 'Fit anywhere',
      requestId: 'ordinary',
    });
    const retuned = await f.daddy.createTask(group.id, {
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

    expect(await f.daddy.configureWorker(group.id, 1, next, true)).toEqual({ restarted: true });
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
      requirements: 'Save before switching',
      requestId: 'saving',
    });
    await f.worker.tick();
    await vi.waitFor(() => expect(f.checkouts.commitTicket).toHaveBeenCalledOnce());
    expect(await f.daddy.configureWorker(group.id, 1, profiles.daddy, true)).toEqual({
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
