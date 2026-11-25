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

it.each(['advanced target', 'rewritten target', 'different branch'] as const)(
  'recovers an ordinary GitHub fix confirmed by main (%s)',
  async (scenario) => {
    const f = await fixture();
    try {
      const task = f.store.getTask(f.task.id);
      const original = task.revision!;
      const confirmed = {
        ...task.pr!,
        head: savedHead,
        base: 'c'.repeat(40),
        start: 'c'.repeat(40),
      };
      const ref = { ...prRef(task), provider: 'github' as const };
      const author = f.store.enqueue(task, 'author', 'fix', 'Save the fix');
      f.store.saveJob({ ...author, status: 'completed' });
      f.store.event(
        task.id,
        'author.fixes_saved',
        { head: savedHead, revision: original },
        author.id,
      );
      f.store.event(task.id, 'author.submitted', { head: savedHead, pushed: true });
      f.store.saveTask({
        ...task,
        ref,
        pr: confirmed,
        revision: confirmed,
        state: 'queued',
        pendingAuthorHead: savedHead,
        pendingFix: { revision: original, attempted: true },
      });
      f.store.setSetting(
        'demo-pr:1',
        scenario === 'different branch' ? { ...confirmed, targetBranch: 'release' } : confirmed,
      );
      const targetAdvanced = vi.fn(async () => scenario === 'advanced target');
      Object.assign(f.provider, { targetAdvanced });
      const restarted = new Engine(f.store, () => f.provider);
      if (scenario === 'advanced target') {
        expect(await restarted.review(task.id, true)).toMatchObject({
          state: 'reviewing',
          review: { revision: { head: savedHead, base: confirmed.base } },
        });
        expect(targetAdvanced).toHaveBeenCalledWith(ref, original.base, confirmed.base);
      } else {
        await expect(restarted.review(task.id, true)).rejects.toMatchObject({
          code: 'fix_pending',
        });
        expect(f.store.activeJobs(task.id)).toHaveLength(0);
        if (scenario === 'different branch') expect(targetAdvanced).not.toHaveBeenCalled();
      }
      expect(
        f.store.events(task.id).filter(({ type }) => type === 'author.submitted'),
      ).toHaveLength(1);
    } finally {
      f.store.close();
    }
  },
);

it('retains a worker message through push confirmation and delivers it once on the published revision', async () => {
  const f = await fixture({ state: 'awaiting_push', pendingAuthorHead: savedHead });
  try {
    const original = f.task.pr!;
    f.store.saveTask({ ...f.task, pendingFix: { revision: f.task.revision! } });
    const native = vi.spyOn(f.provider, 'getPR').mockResolvedValue(original);
    await f.engine.chat(f.task.id, 'author', 'Check the empty state too', 'command-one');
    await f.engine.chat(f.task.id, 'author', 'Check the empty state too', 'command-one');
    expect(f.store.messages(f.task.id)).toHaveLength(1);
    await f.engine.deliverWorkerInstruction(f.task.id);
    expect(f.store.activeJobs(f.task.id)).toHaveLength(0);
    await f.engine.submitSavedFix(f.task.id, async () => async () => {
      native.mockResolvedValue({ ...original, head: savedHead });
    });
    await f.engine.review(f.task.id);
    const review = f.store.claim()!;
    await f.engine.completeJob(review, f.result({ checkedHead: savedHead }));
    f.store.saveJob({ ...review, status: 'completed' });
    await f.engine.publish(f.task.id);
    await Promise.all([
      f.engine.deliverWorkerInstruction(f.task.id),
      f.engine.deliverWorkerInstruction(f.task.id),
    ]);
    const job = f.store.claim()!;
    expect(job).toMatchObject({
      kind: 'chat',
      input: 'Check the empty state too',
      generation: f.store.getTask(f.task.id).generation,
    });
    await f.engine.completeJob(job, f.result({ checkedHead: savedHead }));
    f.store.saveJob({ ...job, status: 'completed' });
    await f.engine.deliverWorkerInstruction(f.task.id);
    expect(f.store.activeJobs(f.task.id)).toHaveLength(0);
  } finally {
    f.store.close();
  }
});

it.each([false, true])(
  'verifies the merged saved fix (observed before merge: %s)',
  async (confirmed) => {
    const f = await fixture();
    try {
      const task = f.store.getTask(f.task.id);
      const original = task.revision!;
      const pr = { ...task.pr!, head: savedHead, state: 'merged' as const, mergeCommit: 'merge' };
      f.store.saveTask({
        ...task,
        state: 'needs_input',
        pendingAuthorHead: savedHead,
        pr: confirmed ? { ...pr, state: 'open' } : task.pr,
        revision: confirmed ? { ...original, head: savedHead } : original,
        pendingAuthorFix: { revision: original, generation: task.generation, sent: true },
      });
      f.store.setSetting('demo-pr:1', pr);
      const queued = await f.engine.action(task.id, 'verify-merge');
      expect(queued.state).toBe('reviewing');
      const job = f.store.claim()!;
      expect(job.kind).toBe('verify_merge');
      await f.engine.completeJob(job, f.result({ checkedHead: savedHead }));
      expect(f.store.getTask(task.id)).toMatchObject({
        state: 'complete',
        verifiedMerge: { head: savedHead },
      });
    } finally {
      f.store.close();
    }
  },
);

it.each(['awaiting_push', 'paused'] as const)(
  'rejects merge verification without changing %s',
  async (state) => {
    const f = await fixture({ state, pendingAuthorHead: savedHead });
    try {
      const task = f.store.getTask(f.task.id);
      f.store.saveTask({
        ...task,
        pendingAuthorFix: { revision: task.revision!, generation: task.generation },
      });
      await expect(f.engine.action(task.id, 'verify-merge')).rejects.toMatchObject({
        code: 'task_busy',
      });
      expect(f.store.getTask(task.id).state).toBe(state);
    } finally {
      f.store.close();
    }
  },
);

it.each([false, true])(
  'honors the saved deadline when GitHub cannot compare bases (saved head visible: %s)',
  async (visible) => {
    const f = await fixture({ state: 'awaiting_push', pendingAuthorHead: savedHead });
    try {
      const task = f.store.getTask(f.task.id);
      const ref = { ...prRef(task), provider: 'github' as const };
      const observed = {
        ...task.pr!,
        head: visible ? savedHead : task.revision!.head,
        base: 'e'.repeat(40),
      };
      f.store.saveTask({
        ...task,
        ref,
        pendingAuthorFix: {
          revision: task.revision!,
          generation: task.generation,
          pushStarted: true,
          confirmUntil: Date.now() - 1,
        },
      });
      f.store.setSetting('demo-pr:1', observed);
      Object.assign(f.provider, {
        targetAdvanced: async () => {
          throw new Error('comparison unavailable');
        },
      });
      const restarted = new Engine(f.store, () => f.provider);
      const held = await restarted.reconcile(task.id);
      expect(held.state).toBe('needs_input');
      for (const value of [savedHead, observed.head, observed.base, 'comparison unavailable'])
        expect(held.reason).toContain(value);
      const send = vi.fn();
      await restarted.submitSavedFix(task.id, send);
      expect(send).not.toHaveBeenCalled();
    } finally {
      f.store.close();
    }
  },
);
