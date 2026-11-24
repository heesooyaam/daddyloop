import { expect, it, vi } from 'vitest';
import { fixture } from './helpers.js';
import { Engine } from '../src/core/engine.js';
import { prRef } from '../src/core/types.js';

const savedHead = 'f'.repeat(40);

it('submits the saved commit when a PR poll overlaps fix finalization', async () => {
  const f = await fixture({ state: 'fixing' });
  try {
    f.store.enqueue(f.task, 'author', 'fix', 'Apply feedback');
    const job = f.store.claim()!;
    const pr = await f.provider.getPR(prRef(f.task));
    let unblock!: (value: typeof pr) => void;
    const read = vi.spyOn(f.provider, 'getPR').mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          unblock = resolve;
        }),
    );
    const poll = f.engine.reconcile(f.task.id);
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    const finish = f.engine.completeJob(job, f.result(), {
      head: savedHead,
      revision: f.task.revision!,
    });
    unblock(pr);
    await Promise.all([poll, finish]);
    expect(f.store.getTask(f.task.id)).toMatchObject({
      state: 'awaiting_push',
      pendingAuthorHead: savedHead,
    });
    f.store.saveJob({ ...job, status: 'completed' });
    await expect(f.engine.review(f.task.id, true)).rejects.toMatchObject({ code: 'fix_pending' });
    const push = vi.fn(async (_task: unknown, head: string) => async () => {
      read.mockResolvedValue({ ...pr, head });
      // Git accepted the push, but the acknowledgement was lost.
      throw new Error('Connection closed');
    });
    await f.engine.submitSavedFix(f.task.id, push);
    await f.engine.action(f.task.id, 'resume');
    await f.engine.submitSavedFix(f.task.id, push);
    expect(push).toHaveBeenCalledExactlyOnceWith(expect.anything(), savedHead);
    expect(f.store.getTask(f.task.id)).toMatchObject({
      state: 'queued',
      revision: { head: savedHead },
    });
    await f.engine.review(f.task.id);
    expect(f.store.getTask(f.task.id).review?.revision.head).toBe(savedHead);
  } finally {
    f.store.close();
  }
});

it('keeps a saved fix visible on PR divergence, including after another poll', async () => {
  const f = await fixture({ state: 'fixing' });
  try {
    const pr = await f.provider.getPR(prRef(f.task));
    vi.spyOn(f.provider, 'getPR').mockResolvedValue({ ...pr, base: 'c'.repeat(40) });
    await f.engine.completeJob({ ...f.job('author'), kind: 'fix' }, f.result(), {
      head: savedHead,
      revision: f.task.revision!,
    });
    await f.engine.reconcile(f.task.id);
    const task = f.store.getTask(f.task.id);
    expect(task).toMatchObject({
      state: 'needs_input',
      pendingAuthorHead: savedHead,
      revision: f.task.revision,
    });
    expect(task.reason).toContain(savedHead);
    const push = vi.fn();
    await f.engine.submitSavedFix(task.id, push);
    expect(push).not.toHaveBeenCalled();
  } finally {
    f.store.close();
  }
});

it('recovers the legacy no-change transition and keeps the obsolete native draft separate', async () => {
  const f = await fixture({ state: 'fixing' });
  try {
    const task = f.store.getTask(f.task.id);
    const original = task.revision!;
    const fix = f.store.enqueue(task, 'author', 'fix', 'Fix the finding');
    f.store.saveJob({ ...fix, status: 'completed' });
    task.ref = { ...prRef(task), provider: 'github' };
    f.store.event(
      task.id,
      'author.feedback_snapshot',
      { revision: original, targetBranch: task.pr!.targetBranch },
      fix.id,
    );
    f.store.event(task.id, 'author.fixes_saved', { head: savedHead }, fix.id);
    task.generation++;
    f.store.event(task.id, 'task.state', {
      state: 'queued',
      reason: 'Author made no code changes; independent verification of the decisions is next',
      generation: task.generation,
      head: original.head,
    });
    task.state = 'needs_input';
    task.feedback = {
      status: 'published',
      body: '',
      comments: [],
      url: task.ref.url,
      revision: original,
    };
    task.review = await f.provider.createReview(prRef(task), original, 'old-draft');
    f.store.saveTask(task);
    await f.engine.action(task.id, 'resume');
    const pr = await f.provider.getPR(prRef(task));
    const read = vi.spyOn(f.provider, 'getPR').mockResolvedValue(pr);
    await f.engine.submitSavedFix(task.id, async () => async () => {
      read.mockResolvedValue({ ...pr, head: savedHead });
    });
    expect(f.store.getTask(task.id)).toMatchObject({
      state: 'queued',
      revision: { head: savedHead },
      pendingAuthorFix: { staleDraft: task.review },
    });
    expect(await f.engine.review(task.id, true)).toMatchObject({ state: 'needs_input' });
    expect((await f.provider.getReview(prRef(task), task.review)).status).toBe('draft');
  } finally {
    f.store.close();
  }
});

it('holds a confirmed fix if the PR moves again before review is queued', async () => {
  const f = await fixture({ state: 'awaiting_push', pendingAuthorHead: savedHead });
  try {
    const pr = f.task.pr!;
    f.store.saveTask({ ...f.task, pendingFix: { revision: f.task.revision! } });
    const getPR = vi.spyOn(f.provider, 'getPR').mockResolvedValue(pr);
    await f.engine.submitSavedFix(f.task.id, async () => async () => {
      getPR.mockResolvedValue({ ...pr, head: savedHead });
    });
    getPR.mockResolvedValue({ ...pr, head: 'c'.repeat(40) });
    await f.engine.review(f.task.id);
    const t = f.store.getTask(f.task.id);
    expect(t).toMatchObject({
      state: 'needs_input',
      pendingAuthorHead: savedHead,
      revision: { head: savedHead },
    });
    expect(f.store.jobs(f.task.id)).toHaveLength(0);
  } finally {
    f.store.close();
  }
});

it('polls for a successfully sent head when the first provider reads lag behind Git', async () => {
  const f = await fixture({ state: 'awaiting_push', pendingAuthorHead: savedHead });
  try {
    const pr = f.task.pr!;
    f.store.saveTask({ ...f.task, pendingFix: { revision: f.task.revision! } });
    const remote = vi.spyOn(f.provider, 'getPR').mockResolvedValue(pr);
    const push = vi.fn(async () => async () => {});
    await f.engine.submitSavedFix(f.task.id, push);
    await f.engine.reconcile(f.task.id);
    await f.engine.submitSavedFix(f.task.id, push);
    expect(f.store.getTask(f.task.id).state).toBe('awaiting_push');
    expect(push).toHaveBeenCalledOnce();
    remote.mockResolvedValue({ ...pr, head: savedHead });
    await f.engine.reconcile(f.task.id);
    expect(f.store.getTask(f.task.id)).toMatchObject({
      state: 'queued',
      revision: { head: savedHead },
    });
  } finally {
    f.store.close();
  }
});

it('recovers an earlier unconfirmed push by reading the PR without resending', async () => {
  const f = await fixture({ state: 'needs_input', pendingAuthorHead: savedHead });
  try {
    const task = f.store.getTask(f.task.id);
    task.pendingFix = { revision: task.revision!, attempted: true };
    task.reason = `Submission of saved fix ${savedHead} is unconfirmed; the PR still shows ${task.revision!.head}. Inspect the outcome and resume to retry this exact commit.`;
    f.store.saveTask(task);
    await f.engine.action(task.id, 'resume');
    expect(f.store.getTask(task.id).state).toBe('awaiting_push');
    const remote = vi.spyOn(f.provider, 'getPR').mockResolvedValue(task.pr!);
    const push = vi.fn();
    await f.engine.submitSavedFix(task.id, push);
    remote.mockResolvedValue({ ...task.pr!, head: savedHead });
    await f.engine.submitSavedFix(task.id, push);
    expect(f.store.getTask(task.id).state).toBe('queued');
    expect(push).not.toHaveBeenCalled();
  } finally {
    f.store.close();
  }
});

it.each(['waiting', 'moved base', 'deadline expired'] as const)(
  'recovers a main saved-fix receipt without reviewing the old head (%s)',
  async (scenario) => {
    const movedBase = scenario === 'moved base';
    const f = await fixture({ state: 'awaiting_push', pendingAuthorHead: savedHead });
    try {
      const task = f.store.getTask(f.task.id);
      const author = f.store.enqueue(task, 'author', 'fix', 'Save the fix');
      f.store.saveJob({ ...author, status: 'completed' });
      const confirmUntil = new Date(
        Date.now() + (scenario === 'deadline expired' ? -1 : 120_000),
      ).toISOString();
      f.store.event(
        task.id,
        'author.fixes_saved',
        { head: savedHead, revision: task.revision },
        author.id,
      );
      f.store.event(task.id, 'author.submitted', { head: savedHead, pushed: true });
      f.store.saveTask({
        ...task,
        pendingFix: { revision: task.revision!, attempted: true, confirmUntil },
      });
      const original = task.pr!;
      f.store.setSetting('demo-pr:1', movedBase ? { ...original, base: 'c'.repeat(40) } : original);
      const restarted = new Engine(f.store, () => f.provider);
      await expect(restarted.review(task.id, true)).rejects.toMatchObject({ code: 'fix_pending' });
      expect(await restarted.reconcile(task.id)).toMatchObject({
        state: scenario === 'waiting' ? 'awaiting_push' : 'needs_input',
        pendingAuthorFix: {
          pushStarted: true,
          confirmUntil: Date.parse(confirmUntil),
          revision: task.revision,
        },
      });
      expect(f.store.activeJobs(task.id)).toEqual([]);
      const push = vi.fn();
      await restarted.submitSavedFix(task.id, push);
      expect(push).not.toHaveBeenCalled();
      if (scenario === 'deadline expired')
        expect(f.store.getTask(task.id).reason).toContain(original.head);
      if (movedBase) {
        const reason = f.store.getTask(task.id).reason;
        for (const value of [savedHead, 'c'.repeat(40)]) expect(reason).toContain(value);
      } else if (scenario === 'waiting') {
        f.store.setSetting('demo-pr:1', { ...original, head: savedHead });
        expect(await restarted.reconcile(task.id)).toMatchObject({ state: 'queued' });
        expect(await restarted.review(task.id)).toMatchObject({
          review: { revision: { head: savedHead } },
        });
      }
    } finally {
      f.store.close();
    }
  },
);
