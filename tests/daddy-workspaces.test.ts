import { expect, it, vi } from 'vitest';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { daddyFixture } from './daddy-fixture.js';
import { Store } from '../src/core/store.js';
import { reconcileWorkerPools, workerPool } from '../src/core/worker-pool.js';

it('pins defaults and per-request repositories through queued turns, tool calls and a restart', async () => {
  const f = daddyFixture(true);
  try {
    const original = { ...f.workspace },
      group = f.daddy.create({ workspaceId: original.id });
    const other = {
      ...original,
      id: '713a8568-7553-5cef-8f52-590d51bbd880',
      repoPath: join(f.dir, 'other'),
      repo: 'test/other',
      scope: 'src',
      base: 'release',
    };
    mkdirSync(join(other.repoPath, 'src'), { recursive: true });
    f.daddy.chat(group.id, 'Task in another repository', 'one', other);
    f.daddy.chat(group.id, 'Task using defaults', 'two');
    f.store.saveWorkspace({ ...original, repoPath: join(f.dir, 'future') });
    const reopened = new Store(join(f.dir, 'state.sqlite'));
    const jobs = reopened.daddyJobs(group.id);
    reopened.close();
    expect(jobs).toHaveLength(2);
    expect(jobs.map((job) => job.workspace?.repoPath)).toEqual([other.repoPath, original.repoPath]);
    for (const job of jobs) {
      const created = (await f.daddy.call(
        job,
        'create_task',
        { title: job.input, requirements: job.input },
        'create',
        new AbortController().signal,
      )) as { taskId: string };
      expect(f.store.getTask(created.taskId)).toMatchObject({
        repoPath: job.workspace!.repoPath,
        scope: job.workspace!.scope,
      });
      expect(
        (
          (await f.daddy.call(
            job,
            'read_board',
            {},
            undefined,
            new AbortController().signal,
          )) as any
        ).workspace.repoPath,
      ).toBe(job.workspace!.repoPath);
    }
    const defaultsJob = jobs[1];
    const available = (await f.daddy.call(
      defaultsJob,
      'list_workspaces',
      {},
      undefined,
      new AbortController().signal,
    )) as (typeof original)[];
    expect(available.find((workspace) => workspace.id === other.id)?.repoPath).toBe(other.repoPath);
    const followup = (await f.daddy.call(
      defaultsJob,
      'create_task',
      {
        workspaceId: other.id,
        title: 'Follow-up',
        requirements: 'Continue in the previously selected repository',
      },
      'followup',
      new AbortController().signal,
    )) as { taskId: string };
    expect(f.store.getTask(followup.taskId).repoPath).toBe(other.repoPath);
    expect(f.daddy.board(group.id).workspace).toEqual(original);
    expect(f.daddy.create({ workspaceId: original.id }).workspace!.repoPath).toBe(
      join(f.dir, 'future'),
    );
    expect(f.store.messages(group.id).map((message) => message.workspace?.repoPath)).toEqual([
      other.repoPath,
      original.repoPath,
    ]);
    expect(() => f.daddy.chat(group.id, 'Task in another repository', 'one', original)).toThrow(
      'different arguments',
    );
    f.daddy.tick();
    await vi.waitFor(() => expect(f.context.prepare).toHaveBeenCalled());
    expect(f.context.prepare).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(AbortSignal),
      other,
    );
  } finally {
    await f.close();
  }
});

it('recovers occupied workers and pending retirements from durable state', async () => {
  const f = daddyFixture(true);
  try {
    const group = f.daddy.create({ workspaceId: f.workspace.id, workerLimit: 2 });
    for (let n = 0; n < 2; n++) {
      const task = await f.tickets.local({
        workspace: f.workspace,
        groupId: group.id,
        groupGeneration: group.generation,
        title: `Task ${n}`,
        requirements: 'Finish the review cycle',
        createdByAction: `test-${n}`,
      });
      group.workerTasks!.push(task.id);
      f.store.saveGroup(group);
      task.authorThreadId = `worker-${n}`;
      task.state = 'awaiting_checks';
      f.store.saveTask(task);
    }
    await f.daddy.settings(group.id, { workerLimit: 1 });
    const restarted = new Store(join(f.dir, 'state.sqlite'));
    try {
      reconcileWorkerPools(restarted);
      expect(workerPool(restarted, restarted.getGroup(group.id))).toMatchObject({
        limit: 2,
        target: 1,
        occupied: 2,
        pending: true,
        active: 0,
      });
      const task = restarted.tasks()[0];
      task.state = 'complete';
      restarted.saveTask(task);
      reconcileWorkerPools(restarted);
      expect(workerPool(restarted, restarted.getGroup(group.id))).toMatchObject({
        limit: 1,
        target: 1,
        occupied: 1,
        pending: false,
      });
    } finally {
      restarted.close();
    }
  } finally {
    await f.close();
  }
});
