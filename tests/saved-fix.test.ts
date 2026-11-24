import { expect, it, vi } from 'vitest';
import { fixture } from './helpers.js';
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
    const save = vi.fn(async () => savedHead);
    const finish = f.engine.completeJob(job, f.result(), save);
    unblock(pr);
    await Promise.all([poll, finish]);
    expect(save).toHaveBeenCalledOnce();
    expect(f.store.getTask(f.task.id)).toMatchObject({
      state: 'awaiting_push',
      pendingAuthorHead: savedHead,
    });
    f.store.saveJob({ ...job, status: 'completed' });
    await expect(f.engine.review(f.task.id, true)).rejects.toMatchObject({ code: 'fix_pending' });
    const push = vi.fn(async (_task, head: string) => {
      read.mockResolvedValue({ ...pr, head });
      // Git accepted the push, but the acknowledgement was lost.
      throw new Error('Connection closed');
    });
    await f.engine.submitSavedFix(f.task.id, push);
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
    await f.engine.completeJob(
      { ...f.job('author'), kind: 'fix' },
      f.result(),
      async () => savedHead,
    );
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
    f.engine.recoverLostFixes();
    f.engine.recoverLostFixes();
    expect(f.store.events(task.id).filter((e) => e.type === 'author.fix_recovered')).toHaveLength(
      1,
    );
    const pr = await f.provider.getPR(prRef(task));
    const read = vi.spyOn(f.provider, 'getPR').mockResolvedValue(pr);
    await f.engine.submitSavedFix(task.id, async () => {
      read.mockResolvedValue({ ...pr, head: savedHead });
    });
    expect(f.store.getTask(task.id)).toMatchObject({
      state: 'needs_input',
      revision: { head: savedHead },
      review: task.review,
    });
    await expect(f.engine.review(task.id, true)).rejects.toMatchObject({ code: 'stale_draft' });
    expect((await f.provider.getReview(prRef(task), task.review)).status).toBe('draft');
  } finally {
    f.store.close();
  }
});
