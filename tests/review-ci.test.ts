import { expect, it, vi } from 'vitest';
import { prRef, type PullRequest } from '../src/core/types.js';
import { Worker } from '../src/runtime/worker.js';
import { DemoRuntime } from '../src/runtime/demo.js';
import { Workspaces } from '../src/runtime/workspaces.js';
import { fixture } from './helpers.js';

async function setup() {
  const f = await fixture();
  const ref = prRef(f.task);
  const current = () => f.store.getTask(f.task.id);
  const ci = async (checks: PullRequest['checks']) => {
    const pr = await f.provider.getPR(ref);
    f.store.setSetting('demo-pr:' + ref.number, {
      ...pr,
      checks,
      checkDetails: [{ name: 'mobile layout', status: checks, url: 'https://example.org/jobs/42' }],
    });
  };
  const runtime = new DemoRuntime();
  const run = vi.spyOn(runtime, 'run');
  const worker = new Worker(
    f.engine,
    new Workspaces('/tmp'),
    runtime,
    runtime,
    () => ({
      memoryAvailableGiB: 30,
      memoryTotalGiB: 90,
      diskAvailableGiB: 180,
      diskUsedPercent: 77,
      ok: true,
      reasons: [],
    }),
    0,
  );
  return { ...f, current, ci, worker, run };
}

it('waits without a round, assigns red CI to the worker, and reviews only the new passing commit', async () => {
  const f = await setup();
  const id = f.task.id;
  const original = f.current().revision!.head;
  const draft = vi.spyOn(f.provider, 'createReview');
  const readReview = vi.spyOn(f.provider, 'getReview');
  try {
    await f.ci('pending');
    await f.worker.tick();
    expect(f.current()).toMatchObject({ state: 'awaiting_review_checks', round: 0 });
    expect(f.store.jobs(id)).toHaveLength(0);
    expect(draft).not.toHaveBeenCalled();
    await f.ci('failing');
    await f.engine.review(id);
    expect(f.store.activeJobs(id)).toMatchObject([{ kind: 'fix', role: 'author' }]);
    await f.worker.tick();
    await vi.waitFor(() => expect(f.store.busy(id)).toBe(false));
    expect(f.current().state, f.current().reason).toBe('queued');
    expect(readReview).not.toHaveBeenCalled();
    expect(f.run).toHaveBeenCalledTimes(1);
    expect(f.run.mock.calls[0][0].prompt).toContain('https://example.org/jobs/42');
    const repaired = f.current().revision!.head;
    expect(repaired).not.toBe(original);
    await f.ci('pending');
    await f.engine.review(id);
    await f.engine.review(id);
    expect(f.current().round).toBe(0);
    expect(draft).not.toHaveBeenCalled();
    await f.ci('passing');
    await f.worker.tick();
    await vi.waitFor(() => expect(f.current().state).toBe('awaiting_publication'));
    expect(draft).toHaveBeenCalledTimes(1);
    expect(f.run.mock.calls.map(([input]) => [input.job.kind, input.task.revision?.head])).toEqual([
      ['fix', original],
      ['review', repaired],
    ]);
    expect(f.current().round).toBe(1);
  } finally {
    await f.worker.stop();
    f.store.close();
  }
});

it('rechecks a previously queued reviewer before the model and resumes the same draft and round', async () => {
  const f = await setup();
  const id = f.task.id;
  try {
    await f.engine.review(id);
    const draft = f.current().review;
    const first = f.store.activeJobs(id)[0];
    first.input = 'Continue the preserved run';
    f.store.saveJob(first);
    await f.ci('pending');
    await f.worker.tick();
    await vi.waitFor(() => expect(f.current().state).toBe('awaiting_review_checks'));
    expect(f.store.activeJobs(id)).toHaveLength(0);
    expect(f.current().review).toEqual(draft);
    expect(f.run).not.toHaveBeenCalled();
    await f.engine.action(id, 'pause');
    await f.engine.action(id, 'resume');
    await f.ci('passing');
    await f.engine.review(id);
    f.engine.recoverInterruptedJobs();
    expect(f.store.activeJobs(id)).toMatchObject([{ kind: 'review' }]);
    await f.worker.tick();
    await vi.waitFor(() => expect(f.current().state).toBe('awaiting_publication'));
    expect(f.run).toHaveBeenCalledTimes(1);
    expect(f.run.mock.calls[0][0].job.input).toBe(first.input);
    expect(f.current()).toMatchObject({ round: 1, review: draft });
  } finally {
    await f.worker.stop();
    f.store.close();
  }
});

it('a revision-bound CI waiver admits review without completing it, and expires on a different head', async () => {
  const f = await setup();
  const id = f.task.id;
  try {
    await f.ci('missing');
    await f.engine.review(id);
    await expect(f.engine.action(id, 'waive-checks', '')).rejects.toMatchObject({
      code: 'waiver_invalid',
    });
    await f.engine.action(id, 'waive-checks', 'Verified the tests offline');
    await f.engine.review(id);
    expect(f.current().state).toBe('reviewing');
    expect(f.current().reviewFinished).toBe(false);
    await f.provider.advance(prRef(f.task));
    await f.engine.reconcile(id);
    expect(f.current().checksWaivedAt).toBeUndefined();
  } finally {
    await f.worker.stop();
    f.store.close();
  }
});

it('a 15-round task limit permits round 15, blocks the new 16th draft, and leaves other tasks running', async () => {
  const f = await setup();
  try {
    const ref = prRef(f.task);
    f.store.saveTask({ ...f.current(), round: 14, reviewRoundLimit: 15 });
    await f.engine.review(f.task.id);
    expect(f.current().round).toBe(15);
    f.store.cancelJobs(f.task.id);
    // The previous round finished and the worker has submitted a different commit.
    const pr = await f.provider.getPR(ref);
    const next = { ...pr, head: 'e'.repeat(40) };
    f.store.setSetting('demo-pr:' + ref.number, next);
    f.store.saveTask({ ...f.current(), state: 'queued', review: undefined, snapshot: undefined });
    const other = await f.engine.create({
      ref: { ...ref, number: 2, url: 'https://demo.local/pull/2' },
      repoPath: '/tmp',
      requirements: 'Independent task',
    });
    const draft = vi.spyOn(f.provider, 'createReview');
    await f.engine.review(f.task.id);
    expect(f.current()).toMatchObject({ round: 15, state: 'paused' });
    expect(draft).not.toHaveBeenCalled();
    await f.engine.review(other.id);
    expect(f.store.getTask(other.id)).toMatchObject({ state: 'reviewing', round: 1 });
    f.store.saveTask({ ...f.current(), reviewRoundLimit: 16 });
    await f.engine.action(f.task.id, 'resume');
    await f.engine.review(f.task.id);
    expect(f.current()).toMatchObject({ state: 'reviewing', round: 16 });
  } finally {
    await f.worker.stop();
    f.store.close();
  }
});
