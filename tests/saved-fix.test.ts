import { Worker } from '../src/runtime/worker.js';
import { DemoRuntime } from '../src/runtime/demo.js';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/core/store.js';
import { Engine } from '../src/core/engine.js';
import { DemoProvider } from '../src/providers/demo.js';
import { git, Workspaces } from '../src/runtime/workspaces.js';
import { allRepositories } from '../src/modules/repositories/index.js';
import { createBackup, restoreBackup } from '../src/ops/backup/snapshot.js';
import { configSchema } from '../src/ops/config.js';
import { expect, it, vi } from 'vitest';
import { fixture } from './helpers.js';
import { AppError, prRef, type Task } from '../src/core/types.js';

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

it('holds a confirmed fix if the PR moves again before review is queued', async () => {
  const f = await fixture({ state: 'awaiting_push', pendingAuthorHead: savedHead });
  try {
    const pr = f.task.pr!;
    const getPR = vi.spyOn(f.provider, 'getPR').mockResolvedValue(pr);
    await f.engine.submitSavedFix(f.task.id, async () => {
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
    expect(t.reason).toContain(savedHead);
    expect(f.store.jobs(f.task.id)).toHaveLength(0);
  } finally {
    f.store.close();
  }
});

it('polls for a successfully sent head when the first provider reads lag behind Git', async () => {
  const f = await fixture({ state: 'awaiting_push', pendingAuthorHead: savedHead });
  try {
    const pr = f.task.pr!;
    const remote = vi.spyOn(f.provider, 'getPR').mockResolvedValue(pr);
    const push = vi.fn(async () => {});
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
    f.engine.recoverLostFixes();
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

it('retains a worker message through push confirmation and delivers it once on the published revision', async () => {
  const f = await fixture({ state: 'awaiting_push', pendingAuthorHead: savedHead });
  try {
    const original = f.task.pr!;
    const native = vi.spyOn(f.provider, 'getPR').mockResolvedValue(original);
    await f.engine.chat(f.task.id, 'author', 'Check the empty state too', 'command-one');
    await f.engine.chat(f.task.id, 'author', 'Check the empty state too', 'command-one');
    expect(f.store.messages(f.task.id)).toHaveLength(1);
    await f.engine.deliverWorkerInstruction(f.task.id);
    expect(f.store.activeJobs(f.task.id)).toHaveLength(0);
    await f.engine.submitSavedFix(f.task.id, async () => {
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

it.each([
  'restart onto H1',
  'restore onto H3',
  'restart through a symlinked data root',
  'restart with GitLab diff lag',
])(
  'recovers the exact Git save after %s and independently reviews the pushed object',
  async (scenario) => {
    const root = mkdtempSync(join(tmpdir(), 'daddyloop-fix-save-'));
    const physical = join(root, 'physical-data');
    const data = join(root, 'data'),
      source = join(root, 'source'),
      remote = join(root, 'remote');
    mkdirSync(source);
    mkdirSync(remote);
    if (scenario.includes('symlinked')) {
      mkdirSync(physical);
      symlinkSync(physical, data, 'dir');
    } else mkdirSync(data);
    const registry = allRepositories();
    const gitlab = scenario.includes('GitLab');
    const host = gitlab ? 'gitlab.com' : 'github.com';
    const transport = registry.get(gitlab ? 'gitlab' : 'github').git!;
    const url = `https://${host}/owner/pull-source.git`;
    const environment = vi.spyOn(transport, 'environment').mockReturnValue({
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: `url.file://${remote}.insteadOf`,
      GIT_CONFIG_VALUE_0: url,
    });
    let store = new Store(join(data, 'daddyloop.sqlite'));
    let worker: Worker | undefined;
    const ref = {
      provider: gitlab ? 'gitlab' : 'github',
      host,
      repo: 'owner/target',
      number: 159,
      url: 'https://github.com/owner/target/pull/159',
    };
    const open = (directory: string) => {
      const workspaces = new Workspaces(directory, registry);
      const provider = new DemoProvider(store);
      const engine = new Engine(store, () => provider);
      engine.readFixSave = (task, save) => workspaces.recoverFix(task, save);
      return { workspaces, provider, engine };
    };
    try {
      await git(['init'], source);
      await git(['init', '--bare'], remote);
      const commit = (cwd: string, subject: string) =>
        git(
          ['-c', 'user.name=Fixture', '-c', 'user.email=test@localhost', 'commit', '-am', subject],
          cwd,
        );
      writeFileSync(join(source, 'tracked'), 'original\n');
      await git(['add', '.'], source);
      await commit(source, 'H1');
      const h1 = await git(['rev-parse', 'HEAD'], source);
      await git(['push', remote, 'HEAD:refs/heads/worker'], source);
      const original = open(data);
      const pr = {
        ...(await original.provider.getPR(ref)),
        head: h1,
        base: h1,
        start: h1,
        branch: 'worker',
        cloneUrl: url,
        draft: false,
      };
      store.setSetting('demo-pr:159', pr);
      const task = await original.engine.create({
        ref,
        repoPath: source,
        requirements: 'Fix tracked file',
      });
      const author = await original.workspaces.prepare(task, 'author');
      task.state = 'fixing';
      store.saveTask(task);
      store.enqueue(task, 'author', 'fix', 'Apply published feedback');
      const run = store.claim()!;
      writeFileSync(join(author, 'tracked'), 'corrected\n');
      let h2 = '';
      const result = { status: 'completed' as const, summary: 'Saved the fix', checkedHead: h1 };
      await expect(
        original.engine.completeJob(run, result, async (current, save) => {
          expect(store.getTask(task.id).fixSave?.runId).toBe(run.id);
          h2 = await original.workspaces.commitFix(current, 'H2', undefined, save);
          throw new Error('Process interrupted before SQLite finalization');
        }),
      ).rejects.toThrow('interrupted');
      expect(store.getTask(task.id).pendingAuthorHead).toBeUndefined();
      const portable = scenario === 'restore onto H3';
      if (portable) {
        writeFileSync(join(author, 'tracked'), 'separate follow-up\n');
        await commit(author, 'H3');
      } else {
        await git(['checkout', '--detach', h1], author);
      }
      const later = await git(['rev-parse', 'HEAD'], author);
      expect(later).not.toBe(h2);
      writeFileSync(join(author, 'notes'), 'untracked work');
      store.close();
      let directory = data;
      if (portable) {
        directory = join(root, 'restored');
        const archive = join(root, 'snapshot.tar.gz');
        await createBackup(data, archive, configSchema.parse({ modules: ['codex', 'github'] }), 1);
        await restoreBackup(archive, directory, {}, 1, 0);
      }
      store = new Store(join(directory, 'daddyloop.sqlite'));
      const restarted = open(directory);
      store.setSetting('demo-pr:159', pr);
      restarted.engine.recoverInterruptedJobs();
      if (portable)
        await restarted.engine.action(task.id, 'resume', '', {
          generation: store.getTask(task.id).generation,
          head: h1,
        });
      const send = vi.fn(async (current: Task, head: string) => {
        expect(head).toBe(h2);
        await restarted.workspaces.pushSavedFix(current, head);
        expect(await git(['rev-parse', 'refs/heads/worker'], remote)).toBe(h2);
        store.setSetting('demo-pr:159', { ...pr, head });
        throw new Error('Response lost after push');
      });
      const runtime = {
        run: vi.fn(async (input: Parameters<DemoRuntime['run']>[0]) => {
          expect(input.job.role).toBe('reviewer');
          expect(await git(['rev-parse', 'HEAD'], input.cwd)).toBe(h2);
          return { ...result, checkedHead: h2 };
        }),
      };
      worker = new Worker(
        restarted.engine,
        restarted.workspaces,
        runtime,
        new DemoRuntime(),
        () => ({
          ok: true,
          reasons: [],
          diskAvailableGiB: 20,
          diskUsedPercent: 50,
          memoryAvailableGiB: 10,
          memoryTotalGiB: 20,
        }),
        0,
      );
      worker.autoSubmit = (id) => restarted.engine.submitSavedFix(id, send);
      await worker.tick();
      await vi.waitFor(() => expect(store.getTask(task.id).revision?.head).toBe(h2));
      if (gitlab) {
        const read = restarted.provider.getPR.bind(restarted.provider);
        const getPR = vi.spyOn(restarted.provider, 'getPR').mockImplementation(async (ref) => {
          if (store.getTask(task.id).state === 'queued')
            throw new AppError('diff_unavailable', 'GitLab still reports the H1 diff', 503);
          return read(ref);
        });
        await worker.tick();
        expect(store.getTask(task.id).state).toBe('queued');
        expect(runtime.run).not.toHaveBeenCalled();
        getPR.mockRestore();
      }
      await worker.tick();
      await vi.waitFor(() => expect(store.getTask(task.id).state).toBe('awaiting_publication'));
      expect(send).toHaveBeenCalledTimes(1);
      expect(runtime.run).toHaveBeenCalledTimes(1);
      const queued = store.getTask(task.id);
      expect(queued.review?.revision.head).toBe(h2);
      const reviewer = await restarted.workspaces.prepare(queued, 'reviewer');
      expect(await git(['rev-parse', 'HEAD'], reviewer)).toBe(h2);
      expect(readFileSync(join(reviewer, 'tracked'), 'utf8')).toBe('corrected\n');
      expect(await git(['rev-parse', 'HEAD'], queued.authorWorktree!)).toBe(later);
      expect(readFileSync(join(queued.authorWorktree!, 'notes'), 'utf8')).toBe('untracked work');
      writeFileSync(join(reviewer, 'unexpected'), 'changed reviewer workspace');
      await expect(restarted.workspaces.prepare(queued, 'reviewer')).rejects.toMatchObject({
        code: 'review_workspace_changed',
      });
    } finally {
      await worker?.stop();
      environment.mockRestore();
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

it.each(['review', 'verify_merge'] as const)(
  'rejects %s when the published finding is edited under the same ID during the run',
  async (kind) => {
    const f = await fixture();
    try {
      await f.engine.review(f.task.id);
      const finding = (await f.engine.broker.call(f.job(), 'add_comment', {
        key: 'current',
        body: 'First version',
      })) as { id: string };
      await f.run();
      await f.engine.publish(f.task.id);
      const task = f.store.getTask(f.task.id);
      const old = task.review!;
      const author = f.store.claim()!;
      await f.engine.completeJob(author, f.result());
      f.store.saveJob({ ...author, status: 'completed' });

      if (kind === 'verify_merge') {
        const candidate = f.store.getTask(task.id);
        candidate.state = 'needs_input';
        f.store.saveTask(candidate);
        f.store.setSetting('demo-pr:1', {
          ...task.pr,
          state: 'merged',
          mergeCommit: 'merge-sha',
        });
        await f.engine.action(task.id, 'verify-merge');
      } else await f.engine.review(task.id);

      const job = f.store.claim()!;
      const current = f.store.getTask(task.id);
      await f.engine.refreshFindingEvidence(current, job);
      f.store.saveTask(current);
      await f.provider.updateComment(prRef(task), old, finding.id, 'Revised acceptance criterion');
      await f.engine.completeJob(job, f.result({ verifiedCommentIds: [finding.id] }));
      expect(f.store.getTask(task.id)).toMatchObject({ state: 'needs_input' });
      expect(f.store.getTask(task.id).verifiedMerge).toBeUndefined();
      expect(f.store.getTask(task.id).feedback?.comments[0].body).toContain('Revised acceptance');
    } finally {
      f.store.close();
    }
  },
);

it.each([true, false])(
  'distinguishes a refused local save from an unknown outcome (%s)',
  async (refused) => {
    const f = await fixture({ state: 'fixing' });
    try {
      f.engine.readFixSave = async () => {
        throw new Error('No ref for this run');
      };
      f.store.enqueue(f.task, 'author', 'fix', 'Apply feedback');
      const job = f.store.claim()!;
      const error = refused
        ? new AppError('fix_before_commit', 'Could not stage changes')
        : new Error('The writer disappeared');
      await expect(
        f.engine.completeJob(job, f.result(), async () => {
          throw error;
        }),
      ).rejects.toBe(error);
      f.engine.failJob(job, error);
      f.store.saveJob({ ...job, status: 'failed' });
      await f.engine.recoverFixSave(f.task.id);
      const current = f.store.getTask(f.task.id);
      expect(current.state).toBe('needs_input');
      expect(current.pendingAuthorHead).toBeUndefined();
      if (refused) {
        expect(current.fixSave).toBeUndefined();
        expect(current.reason).toContain('Could not stage changes');
      } else {
        expect(current.fixSave?.runId).toBe(job.id);
        expect(current.reason).toContain('No ref for this run');
        await expect(f.engine.review(f.task.id, true)).rejects.toMatchObject({
          code: 'fix_pending',
        });
      }
    } finally {
      f.store.close();
    }
  },
);

it.each([false, true])(
  'routes a saved fix merged externally to read-only verification of that exact head (draft delay=%s)',
  async (delayedDraft) => {
    const f = await fixture({ state: 'needs_input', pendingAuthorHead: savedHead });
    try {
      const t = f.store.getTask(f.task.id);
      t.pendingFix = { revision: t.revision!, attempted: true };
      if (delayedDraft) {
        t.revision = { ...t.revision!, head: savedHead };
        t.pr = { ...t.pr!, head: savedHead };
        t.draftStart = {
          marker: `daddyloop:${t.id}:pending`,
          revision: t.revision,
          retry: false,
          retryAt: Date.now() + 60_000,
        };
      }
      f.store.saveTask(t);
      const pr = { ...t.pr!, head: savedHead, state: 'merged' as const, mergeCommit: 'merged-h2' };
      f.store.setSetting('demo-pr:1', { ...pr, targetBranch: 'other' });
      await expect(f.engine.action(t.id, 'verify-merge')).rejects.toMatchObject({
        code: 'merge_unconfirmed',
      });
      f.store.setSetting('demo-pr:1', pr);
      await f.engine.review(t.id, true);
      expect(f.store.getTask(t.id).revision?.head).toBe(savedHead);
      expect(f.store.activeJobs(t.id)[0]).toMatchObject({ kind: 'verify_merge' });
      await f.run({ status: 'incomplete', summary: 'Integration check unavailable' });
      expect(f.store.getTask(t.id)).toMatchObject({
        state: 'needs_input',
        reason: 'Integration check unavailable',
      });
      expect(f.store.getTask(t.id).verifiedMerge).toBeUndefined();
    } finally {
      f.store.close();
    }
  },
);

it.each([
  'legacy receipt',
  'conflicting head',
  'conflicting event base',
  'conflicting pending start',
])('reconciles a saved ref against prior submission evidence for %s', async (scenario) => {
  const recordedHead = scenario === 'conflicting head' ? 'c'.repeat(40) : savedHead;
  const f = await fixture({ state: 'needs_input' });
  try {
    const task = f.store.getTask(f.task.id);
    const job = f.store.enqueue(task, 'author', 'fix', 'Fix');
    f.store.saveJob({ ...job, status: 'failed' });
    const prior = {
      revision: {
        ...task.revision!,
        ...(scenario === 'conflicting pending start' && { start: 'd'.repeat(40) }),
      },
      attempted: true,
      confirmUntil: '2999-01-01',
    };
    task.pendingFix = prior;
    task.pendingAuthorHead = recordedHead;
    task.fixSave = {
      runId: job.id,
      generation: job.generation,
      revision: task.revision!,
      pr: task.pr!,
      ref: prRef(task),
      summary: 'Saved',
    };
    f.store.saveTask(task);
    f.store.event(
      task.id,
      'author.fixes_saved',
      {
        head: recordedHead,
        ...(scenario === 'conflicting event base' && {
          revision: { ...task.revision, base: 'b'.repeat(39) + 'c' },
        }),
      },
      job.id,
    );
    f.engine.readFixSave = async () => savedHead;
    await f.engine.recoverFixSave(task.id);
    const recovered = f.store.getTask(task.id);
    expect(recovered.pendingFix).toEqual(prior);
    expect(recovered.pendingAuthorHead).toBe(recordedHead);
    expect(f.store.events(task.id).filter((e) => e.type === 'author.fixes_saved')).toHaveLength(1);
    if (scenario === 'legacy receipt') {
      expect(recovered.fixSave).toBeUndefined();
      expect(recovered.state).toBe('awaiting_push');
    } else {
      expect(recovered.fixSave?.runId).toBe(job.id);
      expect(recovered.state).toBe('needs_input');
      expect(recovered.reason).toContain(savedHead);
      expect(recovered.reason).toContain(recordedHead);
      expect(recovered.reason).toContain('starting revision');
      const push = vi.fn();
      await f.engine.submitSavedFix(task.id, push);
      expect(push).not.toHaveBeenCalled();
    }
  } finally {
    f.store.close();
  }
});

it.each([false, true])(
  'settles an unchanged save once after an interrupted provider read (retargeted=%s)',
  async (retargeted) => {
    const f = await fixture({ state: 'fixing' });
    try {
      const task = f.store.getTask(f.task.id);
      const head = task.revision!.head;
      const save = vi.fn(async () => head);
      f.engine.readFixSave = save;
      f.store.enqueue(task, 'author', 'fix', 'Apply feedback');
      const job = f.store.claim()!;
      vi.spyOn(f.provider, 'getPR').mockRejectedValueOnce(new Error('Interrupted confirmation'));
      await expect(f.engine.completeJob(job, f.result(), save)).rejects.toThrow('Interrupted');
      f.engine.recoverInterruptedJobs();
      if (retargeted) f.store.setSetting('demo-pr:1', { ...task.pr, targetBranch: 'release' });
      await f.engine.recoverFixSave(task.id);
      await f.engine.recoverFixSave(task.id);
      const outcome = f.store.getTask(task.id);
      expect(outcome.pr?.targetBranch).toBe(task.pr?.targetBranch);
      expect(outcome.state).toBe(retargeted ? 'needs_input' : 'queued');
      expect(f.store.jobs(task.id).filter((j) => j.kind === 'fix')).toHaveLength(1);
      expect(f.store.events(task.id).filter((e) => e.type === 'author.fixes_saved')).toHaveLength(
        retargeted ? 0 : 1,
      );
    } finally {
      f.store.close();
    }
  },
);

it.each([undefined, '/outside/task/author'])(
  'classifies invalid author workspace %s before a Git write',
  async (path) => {
    const f = await fixture({ state: 'fixing', authorWorktree: path });
    try {
      const ws = new Workspaces('/tmp');
      f.engine.readFixSave = (task, save) => ws.recoverFix(task, save);
      f.store.enqueue(f.task, 'author', 'fix', 'Apply feedback');
      const job = f.store.claim()!;
      await expect(
        f.engine.completeJob(job, f.result(), (task, save) =>
          ws.commitFix(task, 'Save', undefined, save),
        ),
      ).rejects.toMatchObject({
        code: 'fix_before_commit',
        message: expect.stringContaining(
          path ? 'outside the managed task directory' : 'not initialized',
        ),
      });
      expect(f.store.getTask(f.task.id).fixSave).toBeUndefined();
    } finally {
      f.store.close();
    }
  },
);

it('waits on the original Arcanum diff ID even when the saved head is already visible', async () => {
  const f = await fixture({ state: 'awaiting_push', pendingAuthorHead: savedHead });
  try {
    const task = f.store.getTask(f.task.id);
    task.ref.provider = 'arcadia';
    task.revision!.revisionId = 'D1';
    task.pr!.revisionId = 'D1';
    f.store.saveTask(task);
    const provider = vi.spyOn(f.provider, 'getPR').mockResolvedValue(task.pr!);
    const push = vi.fn(async () => {
      provider.mockResolvedValue({ ...task.pr!, head: savedHead });
    });
    await f.engine.submitSavedFix(task.id, push);
    await expect(f.engine.review(task.id, true)).rejects.toMatchObject({ code: 'fix_pending' });
    expect(f.store.getTask(task.id)).toMatchObject({
      state: 'awaiting_push',
      pendingAuthorHead: savedHead,
    });
    expect(f.store.jobs(task.id)).toHaveLength(0);
    provider.mockResolvedValue({
      ...task.pr!,
      head: savedHead,
      revisionId: 'older D0',
      diffHead: task.pr!.head,
    });
    await f.engine.submitSavedFix(task.id, push);
    await expect(f.engine.review(task.id, true)).rejects.toMatchObject({ code: 'fix_pending' });
    expect(f.store.jobs(task.id)).toHaveLength(0);
    provider.mockResolvedValue({
      ...task.pr!,
      head: savedHead,
      revisionId: 'D2',
      diffHead: savedHead,
    });
    await f.engine.submitSavedFix(task.id, push);
    await f.engine.review(task.id);
    expect(push).toHaveBeenCalledOnce();
    expect(f.store.getTask(task.id).review?.revision).toMatchObject({
      head: savedHead,
      revisionId: 'D2',
    });
    expect(f.store.jobs(task.id)).toHaveLength(1);
  } finally {
    f.store.close();
  }
});

it.each(['manual publication', 'CI', 'resume'] as const)(
  'keeps the finding version attached to the completed review through %s',
  async (entry) => {
    const f = await fixture();
    try {
      await f.engine.review(f.task.id);
      const old = f.store.getTask(f.task.id).review!;
      const finding = (await f.engine.broker.call(f.job(), 'add_comment', {
        key: 'version',
        body: 'Original finding',
      })) as { id: string };
      await f.run();
      await f.engine.publish(f.task.id);
      await f.run();
      await f.engine.review(f.task.id);
      const current = f.store.getTask(f.task.id);
      const job = f.store.claim()!;
      await f.engine.refreshFindingEvidence(current, job);
      f.store.saveTask(current);
      await f.engine.completeJob(job, f.result({ verifiedCommentIds: [finding.id] }));
      f.store.saveJob({ ...job, status: 'completed' });
      if (entry === 'CI') {
        f.store.setSetting('demo-pr:1', { ...current.pr, checks: 'pending' });
        await f.engine.publish(current.id);
        expect(f.store.getTask(current.id).state).toBe('awaiting_checks');
      } else if (entry === 'resume') {
        await f.engine.publish(current.id);
        const waiting = f.store.getTask(current.id);
        waiting.state = 'awaiting_merge';
        f.store.saveTask(waiting);
        await f.engine.action(current.id, 'pause');
        await f.engine.action(current.id, 'resume');
      } else {
        await f.provider.publish(prRef(current), current.review!);
      }
      await f.provider.updateComment(prRef(current), old, finding.id, 'New acceptance criterion');
      f.store.setSetting('demo-pr:1', { ...current.pr, checks: 'passing' });
      if (entry === 'resume') {
        expect(await f.engine.completedReviewFindingsCurrent(f.store.getTask(current.id))).toBe(
          false,
        );
      } else {
        await f.engine.reconcile(current.id);
        expect(f.store.getTask(current.id).state).toBe('needs_input');
      }
    } finally {
      f.store.close();
    }
  },
);

it.each([false, true])(
  'locates a legacy publication after long history (new head=%s)',
  async (newHead) => {
    const f = await fixture();
    try {
      await f.engine.review(f.task.id);
      const old = f.store.getTask(f.task.id).review!;
      const finding = (await f.engine.broker.call(f.job(), 'add_comment', {
        key: 'legacy',
        body: 'Original finding',
      })) as { id: string };
      for (let i = 0; i < 510; i++) f.store.event(f.task.id, 'fixture.event', {});
      await f.run();
      await f.engine.publish(f.task.id);
      if (newHead) await f.provider.advance(prRef(f.task));
      await f.run();
      await f.engine.review(f.task.id);
      const task = f.store.getTask(f.task.id);
      delete task.feedbackReview;
      const job = f.store.claim()!;
      await f.provider.updateComment(prRef(task), old, finding.id, 'Updated native finding');
      await f.engine.refreshFindingEvidence(task, job);
      expect(job.publishedFindingReview?.id).toBe(old.id);
      expect(task.feedback?.comments[0].body).toContain('Updated native finding');
    } finally {
      f.store.close();
    }
  },
);

it('preserves plan approval through a rerun of mandatory CI on an external merge', async () => {
  const f = await fixture({ kind: 'plan', state: 'needs_input' });
  try {
    const pr = { ...f.task.pr, state: 'merged', mergeCommit: 'merged-plan', checks: 'passing' };
    f.store.setSetting('demo-pr:1', pr);
    await f.engine.action(f.task.id, 'verify-merge');
    await f.run();
    expect(f.store.getTask(f.task.id).state).toBe('awaiting_plan_approval');
    f.store.setSetting('demo-pr:1', { ...pr, checks: 'pending' });
    await f.engine.action(f.task.id, 'approve-plan');
    expect(f.store.getTask(f.task.id)).toMatchObject({
      state: 'awaiting_checks',
      approvedAt: expect.any(String),
    });
    f.store.setSetting('demo-pr:1', { ...pr, checks: 'failing' });
    expect((await f.engine.reconcile(f.task.id)).state).toBe('awaiting_checks');
    f.store.setSetting('demo-pr:1', pr);
    expect((await f.engine.reconcile(f.task.id)).state).toBe('complete');
  } finally {
    f.store.close();
  }
});

it('identifies the legacy publication by native finding IDs among reviews on the same revision', async () => {
  const f = await fixture();
  try {
    await f.engine.review(f.task.id);
    const old = f.store.getTask(f.task.id).review!;
    const finding = (await f.engine.broker.call(f.job(), 'add_comment', {
      key: 'prior',
      body: 'original',
    })) as { id: string };
    await f.run();
    await f.engine.publish(f.task.id);
    const other = await f.provider.createReview(prRef(f.task), old.revision, 'newer-published');
    await f.provider.publish(prRef(f.task), other);
    const snapshot = await f.provider.getReview(prRef(f.task), other);
    f.store.event(f.task.id, 'review.published', { reviewId: other.id, handle: other, snapshot });
    await f.run();
    await f.engine.review(f.task.id);
    const task = f.store.getTask(f.task.id);
    delete task.feedbackReview;
    await f.provider.updateComment(prRef(task), old, finding.id, 'Edited original');
    const job = f.store.claim()!;
    await f.engine.refreshFindingEvidence(task, job);
    expect(job.publishedFindingReview?.id).toBe(old.id);
    expect(task.feedback?.comments[0].body).toContain('Edited original');
    task.feedback!.comments[0].id = 'unattributed';
    delete task.feedbackReview;
    await expect(f.engine.refreshFindingEvidence(task, f.job())).rejects.toMatchObject({
      code: 'feedback_unconfirmed',
    });
  } finally {
    f.store.close();
  }
});

it('requires fresh verification of legacy completed review evidence before manual publication can finish', async () => {
  const f = await fixture();
  try {
    await f.engine.review(f.task.id);
    const old = f.store.getTask(f.task.id).review!;
    const finding = (await f.engine.broker.call(f.job(), 'add_comment', {
      key: 'prior',
      body: 'original',
    })) as { id: string };
    await f.run();
    await f.engine.publish(f.task.id);
    await f.run();
    await f.engine.review(f.task.id);
    const completed = await f.run({ verifiedCommentIds: [finding.id] });
    delete completed.publishedFindingReview;
    delete completed.publishedFindingReviews;
    delete completed.findingVersions;
    f.store.saveJob(completed);
    const task = f.store.getTask(f.task.id);
    delete task.completedReview;
    f.store.saveTask(task);
    await f.provider.updateComment(prRef(task), old, finding.id, 'Edited after the legacy run');
    await f.provider.publish(prRef(task), task.review!);
    expect((await f.engine.reconcile(task.id)).state).toBe('needs_input');
  } finally {
    f.store.close();
  }
});

it('carries an edited finding across a later published review with a different finding', async () => {
  const f = await fixture();
  try {
    const id = f.task.id;
    const add = (job: Parameters<typeof f.engine.broker.call>[0], key: string) =>
      f.engine.broker.call(job, 'add_comment', { key, body: key }) as Promise<{ id: string }>;
    await f.engine.review(id);
    const old = f.store.getTask(id).review!;
    const first = await add(f.job(), 'first');
    await f.run();
    await f.engine.publish(id);
    await f.run();
    const claimReview = async (retry = false) => {
      await f.engine.review(id, retry);
      const job = f.store.claim()!;
      const current = f.store.getTask(id);
      const earlier = await f.engine.refreshFindingEvidence(current, job);
      f.store.saveTask(current);
      return { job, earlier };
    };
    const complete = async (job: ReturnType<typeof f.job>, verifiedCommentIds: string[]) => {
      await f.engine.completeJob(job, f.result({ verifiedCommentIds }));
      f.store.saveJob({ ...job, status: 'completed' });
    };
    const secondRun = await claimReview();
    const second = await add(secondRun.job, 'second');
    await f.provider.updateComment(
      prRef(f.task),
      old,
      first.id,
      'Edited after the second run started',
    );
    await complete(secondRun.job, [first.id]);
    expect(f.store.getTask(id).state).toBe('needs_input');
    expect(f.store.decisions(id).filter((decision) => decision.commentId === first.id)).toEqual([]);
    await complete((await claimReview(true)).job, []);
    await f.engine.publish(id);
    await f.run();
    const thirdRun = await claimReview();
    expect(
      thirdRun.earlier.flatMap((review) => review.comments.map((finding) => finding.id)),
    ).toEqual(expect.arrayContaining([first.id, second.id]));
    await complete(thirdRun.job, [second.id]);
    expect(f.store.getTask(id).state).toBe('needs_input');
    await complete((await claimReview(true)).job, [first.id, second.id]);
    await f.engine.publish(id);
    expect(f.store.getTask(id).state).toBe('complete');
  } finally {
    f.store.close();
  }
});

it.each([
  'after author save',
  'before reviewer',
  'after reviewer report',
  'after reviewer report on a changed head',
  'before publication',
  'after publication',
])('resumes the exact GitLab step %s when the diff lags once', async (phase) => {
  const f = await fixture({ state: 'fixing' });
  const workspaces = new Workspaces('/tmp');
  const id = f.task.id;
  const task = f.store.getTask(id);
  task.ref.provider = 'gitlab';
  const originalReview = await f.provider.createReview(
    prRef(task),
    task.revision!,
    'original-review',
  );
  await f.provider.publish(prRef(task), originalReview);
  task.review = originalReview;
  task.reviewFinished = true;
  task.snapshot = await f.provider.getReview(prRef(task), originalReview);
  f.store.saveTask(task);
  f.store.enqueue(task, 'author', 'fix', 'Apply published feedback');
  const save = vi.spyOn(workspaces, 'commitFix').mockResolvedValue(savedHead);
  vi.spyOn(workspaces, 'prepare').mockResolvedValue('/tmp');
  const headChanged = phase === 'after reviewer report on a changed head';
  let reviewed = 0,
    lagged = false,
    sendingReview = false;
  const runtime = {
    run: vi.fn(async (input: Parameters<DemoRuntime['run']>[0]) => {
      if (input.job.role === 'reviewer') reviewed++;
      return {
        status: 'completed' as const,
        summary: 'Checked the work',
        checkedHead: input.task.revision!.head,
      };
    }),
  };
  const worker = new Worker(
    f.engine,
    workspaces,
    runtime,
    new DemoRuntime(),
    () => ({
      ok: true,
      reasons: [],
      diskAvailableGiB: 20,
      diskUsedPercent: 50,
      memoryAvailableGiB: 10,
      memoryTotalGiB: 20,
    }),
    -1,
  );
  const publish = vi.spyOn(f.provider, 'publish');
  const publishNative = f.engine.broker.publish.bind(f.engine.broker);
  vi.spyOn(f.engine.broker, 'publish').mockImplementation(async (...args) => {
    sendingReview = true;
    try {
      return await publishNative(...args);
    } finally {
      sendingReview = false;
    }
  });
  const original = f.provider.getPR.bind(f.provider);
  vi.spyOn(f.provider, 'getPR').mockImplementation(async (ref) => {
    const current = f.store.getTask(id);
    const running = f.store.activeJobs(id).some((job) => job.status === 'running');
    const lag =
      (phase === 'after author save' &&
        running &&
        save.mock.calls.length > 0 &&
        current.state === 'awaiting_push') ||
      (phase === 'before reviewer' && running && current.state === 'reviewing' && reviewed === 0) ||
      ((phase === 'after reviewer report' || headChanged) &&
        running &&
        current.state === 'reviewing' &&
        reviewed === 1) ||
      (phase === 'before publication' && sendingReview && publish.mock.calls.length === 0) ||
      (phase === 'after publication' &&
        current.state === 'awaiting_publication' &&
        publish.mock.calls.length === 1);
    if (lag && !lagged) {
      lagged = true;
      if (headChanged) f.store.setSetting('demo-pr:1', { ...task.pr, head: 'd'.repeat(40) });
      throw new AppError('diff_unavailable', 'GitLab has not prepared the current diff', 503);
    }
    return original(ref);
  });
  const push = vi.fn(async (_current: Task, head: string) => {
    expect(head).toBe(savedHead);
    f.store.setSetting('demo-pr:1', { ...task.pr, head });
  });
  worker.autoSubmit = () => f.engine.submitSavedFix(id, push);
  try {
    await vi.waitFor(
      async () => {
        for (const job of f.store.activeJobs(id)) {
          if (job.status === 'queued' && job.notBefore)
            f.store.saveJob({ ...job, notBefore: undefined });
        }
        const current = f.store.getTask(id);
        if (current.publicationRetry) {
          current.publicationRetry.retryAt = 0;
          f.store.saveTask(current);
        }
        await worker.tick();
        expect(f.store.getTask(id).state).toBe(headChanged ? 'needs_input' : 'complete');
      },
      { timeout: 5000 },
    );
    expect(lagged).toBe(true);
    expect(save).toHaveBeenCalledOnce();
    expect(push).toHaveBeenCalledOnce();
    expect(runtime.run).toHaveBeenCalledTimes(2);
    expect(reviewed).toBe(1);
    if (headChanged) {
      expect(publish).not.toHaveBeenCalled();
      expect(f.store.getTask(id).reviewFinished).toBe(false);
    } else {
      expect(publish).toHaveBeenCalledOnce();
      expect(f.store.getTask(id).revision?.head).toBe(savedHead);
    }
  } finally {
    await worker.stop();
    f.store.close();
  }
});

it.each(
  (['verification', 'CI', 'plan approval'] as const).flatMap((phase) =>
    (['missing', 'published'] as const).map((status) => ({ phase, status })),
  ),
)(
  'preserves a known published finding when the review is $status without the finding during $phase',
  async ({ phase, status }) => {
    const f = await fixture({
      kind: phase === 'plan approval' ? 'plan' : 'code',
      state: 'needs_input',
    });
    try {
      const task = f.store.getTask(f.task.id);
      const ref = prRef(task);
      const review = await f.provider.createReview(ref, task.revision!, 'published-review');
      const finding = await f.provider.createComment(ref, review, 'Mandatory finding', 'finding');
      await f.provider.publish(ref, review);
      const snapshot = await f.provider.getReview(ref, review);
      task.review = review;
      task.snapshot = snapshot;
      f.store.saveTask(task);
      const merged = {
        ...task.pr,
        state: 'merged',
        mergeCommit: 'merge',
        checks: phase === 'CI' ? 'pending' : 'passing',
      };
      f.store.setSetting('demo-pr:1', merged);
      await f.engine.action(task.id, 'verify-merge');
      const job = f.store.claim()!;
      const current = f.store.getTask(task.id);
      await f.engine.refreshFindingEvidence(current, job);
      f.store.saveTask(current);
      const missing = { ...snapshot, status, comments: [] };
      const complete = async (verified: boolean) => {
        await f.engine.completeJob(
          job,
          f.result({ verifiedCommentIds: verified ? [finding.id] : [] }),
        );
        f.store.saveJob({ ...job, status: 'completed' });
      };
      if (phase === 'verification') {
        const read = vi.spyOn(f.provider, 'getReview').mockResolvedValue(missing);
        await complete(false);
        const held = f.store.getTask(task.id);
        expect(held).toMatchObject({ state: 'needs_input', review, snapshot });
        expect(held.verifiedMerge).toBeUndefined();
        read.mockRestore();
        await f.engine.action(task.id, 'verify-merge');
        await f.run({ verifiedCommentIds: [finding.id] });
      } else {
        await complete(true);
        const waiting = phase === 'CI' ? 'awaiting_checks' : 'awaiting_plan_approval';
        expect(f.store.getTask(task.id).state).toBe(waiting);
        f.store.setSetting('demo-pr:1', { ...merged, checks: 'passing' });
        const read = vi.spyOn(f.provider, 'getReview').mockResolvedValue(missing);
        const advance = () =>
          phase === 'CI' ? f.engine.reconcile(task.id) : f.engine.action(task.id, 'approve-plan');
        await advance();
        expect(f.store.getTask(task.id)).toMatchObject({ state: waiting, review, snapshot });
        read.mockRestore();
        await advance();
      }
      expect(f.store.getTask(task.id).state).toBe('complete');
    } finally {
      f.store.close();
    }
  },
);
