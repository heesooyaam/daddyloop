import { randomUUID } from 'node:crypto';
import { Store } from '../src/core/store.js';
import { Engine } from '../src/core/engine.js';
import { DemoProvider } from '../src/providers/demo.js';
import type { PRTask as Task, Job, AgentResult } from '../src/core/types.js';
export async function fixture(overrides: Partial<Task> = {}) {
  const store = new Store(':memory:'),
    provider = new DemoProvider(store),
    engine = new Engine(store, () => provider);
  let task = await engine.create({
    ref: {
      provider: 'demo',
      host: 'demo.local',
      repo: 'test/repo',
      number: 1,
      url: 'https://demo.local/pull/1',
    },
    repoPath: '/tmp',
    requirements: 'Preserve session generation invariants',
    policy: { publication: 'human' },
  });
  task = { ...task, ...overrides };
  store.saveTask(task);
  const result = (extra: Partial<AgentResult> = {}): AgentResult => ({
    status: 'completed',
    summary: 'Reviewed the pinned change',
    checkedHead: store.getTask(task.id).revision!.head,
    verifiedCommentIds: [],
    disputedCommentIds: [],
    ...extra,
  });
  const run = async (input: Partial<AgentResult> = {}) => {
    const job = store.claim()!;
    if (!job) throw new Error('No job to claim');
    await engine.completeJob(job, result(input));
    job.status = 'completed';
    store.saveJob(job);
    return job;
  };
  const job = (role: Job['role'] = 'reviewer'): Job => ({
    id: randomUUID(),
    taskId: task.id,
    generation: store.getTask(task.id).generation,
    role,
    kind: 'review',
    input: 'review',
    status: 'running',
    createdAt: new Date().toISOString(),
  });
  return { store, engine, provider, task, run, result, job };
}
