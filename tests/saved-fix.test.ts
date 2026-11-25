import { expect, it, vi } from 'vitest';
import { GitHubQuota, GitHubQuotaError, githubWait } from '../src/providers/github-quota.js';
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

it.each(
  [false, true].flatMap((confirmed) =>
    (['complete', 'checks pass', 'waive checks', 'approve plan'] as const).map(
      (continuation) => [confirmed, continuation] as const,
    ),
  ),
)('keeps a verified merged fix after restart (%s, %s)', async (confirmed, continuation) => {
  const f = await fixture({ kind: continuation === 'approve plan' ? 'plan' : 'code' });
  try {
    const task = f.store.getTask(f.task.id);
    const original = task.revision!;
    const author = f.store.enqueue(task, 'author', 'fix', 'Save the fix');
    f.store.saveJob({ ...author, status: 'completed' });
    f.store.event(
      task.id,
      'author.fixes_saved',
      { head: savedHead, revision: original },
      author.id,
    );
    if (confirmed) f.store.event(task.id, 'author.submitted', { head: savedHead, pushed: true });
    const pr = {
      ...task.pr!,
      head: savedHead,
      state: 'merged' as const,
      mergeCommit: 'merge',
      checks:
        continuation === 'checks pass' || continuation === 'waive checks'
          ? ('pending' as const)
          : ('passing' as const),
    };
    f.store.saveTask({
      ...task,
      state: 'needs_input',
      pendingAuthorHead: savedHead,
      pr: confirmed ? { ...pr, state: 'open' } : task.pr,
      revision: confirmed ? { ...original, head: savedHead } : original,
      pendingAuthorFix: { revision: original, generation: task.generation, sent: true },
    });
    f.store.setSetting('demo-pr:1', pr);
    expect(await f.engine.action(task.id, 'verify-merge')).toMatchObject({ state: 'reviewing' });
    const job = f.store.claim()!;
    expect(job.kind).toBe('verify_merge');
    await f.engine.completeJob(job, f.result({ checkedHead: savedHead }));
    f.store.saveJob({ ...job, status: 'completed' });

    const restarted = new Engine(f.store, () => f.provider);
    const expected =
      continuation === 'approve plan'
        ? 'awaiting_plan_approval'
        : continuation === 'complete'
          ? 'complete'
          : 'awaiting_checks';
    expect(await restarted.reconcile(task.id)).toMatchObject({
      state: expected,
      verifiedMerge: { head: savedHead },
    });
    if (continuation === 'checks pass') {
      f.store.setSetting('demo-pr:1', { ...pr, checks: 'passing' });
      await restarted.reconcile(task.id);
    } else if (continuation === 'waive checks') {
      await restarted.action(task.id, 'waive-checks', 'Verified checks separately');
    } else if (continuation === 'approve plan') {
      await restarted.action(task.id, 'approve-plan');
    }
    expect(await restarted.reconcile(task.id)).toMatchObject({ state: 'complete' });
  } finally {
    f.store.close();
  }
});

it('keeps both SHAs when merge verification observes an older commit', async () => {
  const f = await fixture({ state: 'needs_input', pendingAuthorHead: savedHead });
  try {
    const task = f.store.getTask(f.task.id);
    const pr = { ...task.pr!, state: 'merged' as const, mergeCommit: 'merge' };
    f.store.saveTask({
      ...task,
      pendingAuthorFix: { revision: task.revision!, generation: task.generation, sent: true },
    });
    f.store.setSetting('demo-pr:1', pr);
    const held = await f.engine.action(task.id, 'verify-merge');
    expect(held).toMatchObject({ state: 'needs_input', pendingAuthorHead: savedHead });
    expect(held.reason).toContain(savedHead);
    expect(held.reason).toContain(pr.head);
    expect(f.store.activeJobs(task.id)).toHaveLength(0);
  } finally {
    f.store.close();
  }
});

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

it.each([
  'after merge',
  'on original base',
  'on advanced base',
  'rewritten',
  'retargeted',
] as const)('checks a saved fix merged after the target advances (%s)', async (scenario) => {
  const f = await fixture({ state: 'needs_input', pendingAuthorHead: savedHead });
  try {
    const task = f.store.getTask(f.task.id);
    const original = task.revision!;
    const originalPR = { ...task.pr!, head: savedHead };
    const advanced = { ...originalPR, base: 'c'.repeat(40), start: 'c'.repeat(40) };
    const merged = {
      ...advanced,
      targetBranch: scenario === 'retargeted' ? 'release' : advanced.targetBranch,
      state: 'merged' as const,
      mergeCommit: 'merge',
    };
    const observed =
      scenario === 'on advanced base'
        ? advanced
        : scenario === 'on original base'
          ? originalPR
          : task.pr!;
    f.store.saveTask({
      ...task,
      ref: { ...prRef(task), provider: 'github' },
      pr: observed,
      revision: observed,
      pendingAuthorFix: {
        revision: scenario === 'on advanced base' ? advanced : original,
        generation: task.generation,
        sent: true,
      },
    });
    f.store.setSetting('demo-pr:1', merged);
    const targetAdvanced = vi.fn(async () => scenario !== 'rewritten');
    Object.assign(f.provider, { targetAdvanced });
    const queued = await f.engine.action(task.id, 'verify-merge');
    if (scenario === 'retargeted' || scenario === 'rewritten') {
      expect(queued.state).toBe('needs_input');
      expect(queued.reason).toContain(savedHead);
      expect(f.store.activeJobs(task.id)).toHaveLength(0);
    } else {
      expect(queued).toMatchObject({
        state: 'reviewing',
        pendingAuthorFix: { revision: { base: advanced.base, start: advanced.start } },
      });
      const restarted = new Engine(f.store, () => f.provider);
      const job = f.store.claim()!;
      expect(job.kind).toBe('verify_merge');
      expect(await restarted.canStartMergeVerification(job, merged)).toBe(true);
      await restarted.completeJob(job, f.result({ checkedHead: savedHead }));
      expect(await restarted.reconcile(task.id)).toMatchObject({
        state: 'complete',
        verifiedMerge: { head: savedHead, base: advanced.base },
      });
    }
    expect(targetAdvanced).toHaveBeenCalledTimes(
      scenario === 'retargeted' || scenario === 'on advanced base' ? 0 : 1,
    );
  } finally {
    f.store.close();
  }
});

it.each([
  ['PR read', false],
  ['base comparison', false],
  ['base comparison', true],
] as const)(
  'can resume a fix blocked before its first push (%s, already pushed: %s)',
  async (failure, visible) => {
    const f = await fixture({ state: 'awaiting_push', pendingAuthorHead: savedHead });
    try {
      const task = f.store.getTask(f.task.id);
      const observed = {
        ...task.pr!,
        head: visible ? savedHead : task.revision!.head,
        base: 'c'.repeat(40),
      };
      f.store.saveTask({
        ...task,
        ref: { ...prRef(task), provider: 'github' },
        pendingAuthorFix: { revision: task.revision!, generation: task.generation },
      });
      f.store.setSetting('demo-pr:1', observed);
      let unavailable = true;
      Object.assign(f.provider, {
        targetAdvanced: async () => {
          if (failure === 'base comparison' && unavailable) throw new Error('access denied');
          return true;
        },
      });
      const getPR = f.provider.getPR.bind(f.provider);
      vi.spyOn(f.provider, 'getPR').mockImplementation(async (ref) => {
        if (failure === 'PR read' && unavailable) throw new Error('access denied');
        return getPR(ref);
      });
      const send = vi.fn(async () => {
        f.store.setSetting('demo-pr:1', { ...observed, head: savedHead });
      });
      const preparePush = vi.fn(async () => send);
      const restarted = new Engine(f.store, () => f.provider);
      await restarted.submitSavedFix(task.id, preparePush);
      const held = f.store.getTask(task.id);
      expect(held.state).toBe('needs_input');
      expect(held.reason).toContain(savedHead);
      expect(held.reason).toContain('access denied');
      if (failure === 'base comparison') {
        expect(held.reason).toContain(observed.head);
        expect(held.reason).toContain(observed.base);
      }
      expect(preparePush).not.toHaveBeenCalled();
      unavailable = false;
      await restarted.action(task.id, 'resume');
      await restarted.submitSavedFix(task.id, preparePush);
      expect(send).toHaveBeenCalledTimes(visible ? 0 : 1);
      expect(f.store.getTask(task.id)).toMatchObject({
        state: 'queued',
        revision: { head: savedHead },
      });
    } finally {
      f.store.close();
    }
  },
);

it.each([
  ['PR read', false],
  ['base comparison', false],
  ['base comparison', true],
] as const)(
  'automatically retries a throttled preflight (%s, already pushed: %s)',
  async (where, visible) => {
    const f = await fixture({ state: 'awaiting_push', pendingAuthorHead: savedHead });
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
    try {
      const task = f.store.getTask(f.task.id);
      const ref = { ...prRef(task), provider: 'github' as const };
      const observed = {
        ...task.pr!,
        head: visible ? savedHead : task.revision!.head,
        base: 'c'.repeat(40),
      };
      f.store.saveTask({
        ...task,
        ref,
        pendingAuthorFix: { revision: task.revision!, generation: task.generation },
      });
      f.store.setSetting('demo-pr:1', observed);
      const quota = new GitHubQuota(f.store, ref.host);
      let limited = true;
      const read = () => {
        quota.check('GET');
        if (limited)
          quota.observe(
            new Response(null, { status: 429, headers: { 'Retry-After': '2' } }),
            'GET',
            '',
          );
      };
      const getPR = f.provider.getPR.bind(f.provider);
      vi.spyOn(f.provider, 'getPR').mockImplementation(async (ref) => {
        if (where === 'PR read') read();
        return getPR(ref);
      });
      Object.assign(f.provider, {
        targetAdvanced: async () => {
          if (where === 'base comparison') read();
          return true;
        },
      });
      const send = vi.fn(async () =>
        f.store.setSetting('demo-pr:1', { ...observed, head: savedHead }),
      );
      await expect(f.engine.reconcile(task.id)).rejects.toBeInstanceOf(GitHubQuotaError);
      expect(f.store.getTask(task.id)).toMatchObject({
        state: 'awaiting_push',
        pendingAuthorHead: savedHead,
      });
      const retryAt = githubWait(f.store, ref)!;
      expect(retryAt).toBeGreaterThan(Date.now());
      now.mockReturnValue(retryAt + 1);
      limited = false;
      const restarted = new Engine(f.store, () => f.provider);
      await restarted.reconcile(task.id);
      await restarted.submitSavedFix(task.id, async () => send);
      await restarted.submitSavedFix(task.id, async () => send);
      expect(send).toHaveBeenCalledTimes(visible ? 0 : 1);
      expect(f.store.getTask(task.id)).toMatchObject({
        state: 'queued',
        revision: { head: savedHead },
      });
    } finally {
      now.mockRestore();
      f.store.close();
    }
  },
);

it.each(['advance', 'rollback', 'divergence'] as const)(
  'uses the last confirmed base after upgrading a queued fix (%s)',
  async (movement) => {
    const f = await fixture();
    try {
      const task = f.store.getTask(f.task.id);
      const original = task.revision!;
      const base = 'c'.repeat(40);
      const confirmed = { ...task.pr!, head: savedHead, base, start: base };
      const author = f.store.enqueue(task, 'author', 'fix', 'Save the fix');
      f.store.saveJob({ ...author, status: 'completed' });
      f.store.event(
        task.id,
        'author.fixes_saved',
        { head: savedHead, revision: original },
        author.id,
      );
      f.store.event(task.id, 'author.submitted', { head: savedHead, pushed: true });
      task.generation++;
      f.store.event(task.id, 'revision.changed', {
        revision: confirmed,
        generation: task.generation,
      });
      f.store.event(task.id, 'task.state', {
        state: 'queued',
        reason: 'New revision is ready for review',
        generation: task.generation,
        head: savedHead,
      });
      const ref = { ...prRef(task), provider: 'github' as const };
      f.store.saveTask({
        ...task,
        ref,
        state: 'queued',
        pr: confirmed,
        revision: confirmed,
        pendingAuthorHead: savedHead,
        pendingFix: { revision: original, attempted: true },
      });
      const nextBase = movement === 'rollback' ? original.base : 'e'.repeat(40);
      f.store.setSetting('demo-pr:1', { ...confirmed, base: nextBase, start: nextBase });
      const targetAdvanced = vi.fn(
        async (_ref: unknown, before: string) => before === original.base || movement === 'advance',
      );
      Object.assign(f.provider, { targetAdvanced });
      const first = await f.engine.review(task.id);
      if (movement === 'advance') {
        expect(first).toMatchObject({
          state: 'reviewing',
          review: { revision: { head: savedHead, base: nextBase } },
        });
        expect(f.store.activeJobs(task.id)).toHaveLength(1);
      } else {
        expect(first).toMatchObject({ state: 'needs_input', revision: { base } });
        expect(first.reason).toContain(savedHead);
        const restarted = new Engine(f.store, () => f.provider);
        await restarted.action(task.id, 'resume');
        const held = await restarted.review(task.id, true);
        expect(held).toMatchObject({ state: 'needs_input', revision: { base } });
        expect(held.reason).toContain(savedHead);
        expect(f.store.activeJobs(task.id)).toHaveLength(0);
      }
      expect(targetAdvanced).toHaveBeenCalledWith(ref, base, nextBase);
      expect(targetAdvanced).not.toHaveBeenCalledWith(ref, original.base, nextBase);
      expect(
        f.store.events(task.id).filter(({ type }) => type === 'author.submitted'),
      ).toHaveLength(1);
    } finally {
      f.store.close();
    }
  },
);
