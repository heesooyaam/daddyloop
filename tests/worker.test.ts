import { AppError } from '../src/core/types.js';
import { DatabaseSync } from 'node:sqlite';
import { GitHubQuotaError } from '../src/providers/github-quota.js';
import { it, expect, vi } from 'vitest';
import { fixture } from './helpers.js';
import { Worker } from '../src/runtime/worker.js';
import { git, Workspaces } from '../src/runtime/workspaces.js';
import { DemoRuntime } from '../src/runtime/demo.js';
import { TicketWorkflow } from '../src/core/ticket-workflow.js';
import { Engine } from '../src/core/engine.js';
import { Store } from '../src/core/store.js';
import { DemoProvider } from '../src/providers/demo.js';
import type { AgentInput } from '../src/runtime/agent.js';
import { prRef, revisionOf, type ResourceStatus, type ReviewHandle } from '../src/core/types.js';
import { allRepositories } from '../src/modules/repositories/index.js';
import { RepositoryRegistry } from '../src/modules/repositories/registry.js';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const healthy = () => ({
  memoryAvailableGiB: 30,
  memoryTotalGiB: 90,
  diskAvailableGiB: 180,
  diskUsedPercent: 77,
  ok: true,
  reasons: [],
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

async function queueFix(f: Awaited<ReturnType<typeof fixture>>) {
  await f.engine.review(f.task.id);
  const finding = (await f.engine.broker.call(f.job(), 'add_comment', {
    key: 'R1',
    body: 'Needs a fix',
  })) as { id: string };
  await f.run();
  await f.engine.publish(f.task.id);
  return finding.id;
}

async function recordLegacyLostFix(f: Awaited<ReturnType<typeof fixture>>, completed = true) {
  await queueFix(f);
  const id = f.task.id;
  const fix = f.store.claim()!;
  const saved = 'f'.repeat(40);
  const starting = f.store.getTask(id);
  f.store.event(
    id,
    'author.feedback_snapshot',
    { ...starting.feedback, targetBranch: starting.pr?.targetBranch },
    fix.id,
  );
  f.store.event(id, 'author.fixes_saved', { head: saved }, fix.id);
  await f.engine.completeJob(fix, f.result());
  if (completed) f.store.saveJob({ ...fix, status: 'completed' });
  const task = f.store.getTask(id);
  expect(task.reason).toContain('Author made no code changes');
  return { task, saved };
}

it.each([
  ['reconcile', 'draft'],
  ['reconcile', 'published'],
  ['completeJob', 'draft'],
  ['completeJob', 'published'],
  ['reconcile first', 'published'],
  ['completeJob first', 'published'],
  ['reconcile after discussion', 'published'],
  ['retry after discussion', 'published'],
  ['reconcile after discussion and deletion', 'published'],
  ['reconcile after discussion and edit', 'published'],
] as const)(
  'retains the old native review when %s notices the new base (%s)',
  async (first, status) => {
    const f = await fixture();
    try {
      const earlier = await queueFix(f);
      const author = f.store.claim()!;
      const task = f.store.getTask(f.task.id);
      const ref = { ...prRef(task), provider: 'github' as const };
      f.store.saveTask({ ...task, ref });
      const head = 'fc7653947a156709d819016a0aaa0c7d0a0b8908';
      await f.engine.completeJob(author, f.result(), { head, revision: task.revision! });
      f.store.saveJob({ ...author, status: 'completed' });
      const fixed = { ...task.pr!, head };
      await f.engine.submitSavedFix(
        task.id,
        async () => async () => f.store.setSetting('demo-pr:1', fixed),
      );
      const started = await f.engine.review(task.id);
      const old = started.review!;
      const reviewer = f.store.claim()!;
      const added = await f.provider.createComment(
        ref,
        old,
        'A newly published finding',
        `${old.marker}:comment:R2`,
      );
      const observedInChat = first.includes('after discussion');
      const retriedFirst = first === 'retry after discussion';
      const deleted = first === 'reconcile after discussion and deletion';
      const edited = first === 'reconcile after discussion and edit';
      if (observedInChat) {
        await f.engine.completeJob(
          reviewer,
          f.result(retriedFirst ? {} : { verifiedCommentIds: [earlier] }),
        );
        f.store.saveJob({ ...reviewer, status: 'completed' });
        await f.engine.chat(task.id, 'reviewer', 'Discuss the review');
      }
      if (status === 'published') await f.provider.publish(ref, old);
      if (observedInChat) {
        await f.run();
        expect(f.store.getTask(task.id)).toMatchObject({
          state: 'awaiting_publication',
          reviewFinished: true,
          snapshot: { status: 'published' },
          feedback: { comments: [{ id: earlier }] },
        });
      }
      if (deleted) await f.provider.deleteComment(ref, old, added.id);
      if (edited) await f.provider.updateComment(ref, old, added.id, 'Updated finding');
      const findings = deleted ? [earlier] : [earlier, added.id];

      const moved = { ...fixed, base: 'e'.repeat(40) };
      f.store.setSetting('demo-pr:1', moved);
      if (first.startsWith('reconcile')) await f.engine.reconcile(task.id);
      if (first !== 'reconcile' && !observedInChat)
        await f.engine.completeJob(reviewer, f.result({ verifiedCommentIds: [earlier] }));
      if (first === 'completeJob first') await f.engine.reconcile(task.id);
      const blocked = f.store.getTask(task.id);
      if (observedInChat && !retriedFirst) {
        expect(blocked.state).toBe('queued');
        expect(blocked.feedback?.comments.map(({ id }) => id)).toEqual(findings);
      } else if (!retriedFirst)
        expect(blocked).toMatchObject({ state: 'needs_input', review: old });
      expect(f.store.busy(task.id)).toBe(false);
      const restarted = new Engine(f.store, () => f.provider);
      if (status === 'draft') {
        const create = vi.spyOn(f.provider, 'createReview');
        expect(await restarted.review(task.id, true)).toMatchObject({
          state: 'needs_input',
          review: old,
        });
        expect(create).not.toHaveBeenCalled();
        await f.provider.publish(ref, old);
      }
      const next = await restarted.review(task.id, true);
      expect(next).toMatchObject({ state: 'reviewing', review: { revision: revisionOf(moved) } });
      expect(next.feedback?.comments.map(({ id }) => id)).toEqual(findings);
      if (edited)
        expect(next.feedback?.comments.find(({ id }) => id === added.id)?.body).toBe(
          'Updated finding',
        );
      await f.run({ verifiedCommentIds: [retriedFirst ? added.id : earlier] });
      if (deleted) {
        expect(f.store.getTask(task.id).state).toBe('awaiting_publication');
        expect(await f.engine.publish(task.id)).toMatchObject({ state: 'complete' });
      } else {
        expect(f.store.getTask(task.id)).toMatchObject({
          state: 'needs_input',
          reviewFinished: false,
        });
      }
    } finally {
      f.store.close();
    }
  },
);

it('keeps a saved fix when reconcile overlaps the author commit', async () => {
  const f = await fixture();
  const originalHead = '17ee5c79997b7f5402d3d2c66c3cc59a75854098';
  f.store.setSetting('demo-pr:1', { ...f.task.pr, head: originalHead });
  const finding = await queueFix(f);
  const task = f.store.getTask(f.task.id);
  task.ref.provider = 'github';
  f.store.saveTask(task);
  const head = 'fc7653947a156709d819016a0aaa0c7d0a0b8908';
  let current = task.pr!;
  const providerRead = deferred<typeof current>();
  const commitResult = deferred<string>();
  const provider = vi.spyOn(f.provider, 'getPR').mockImplementation(async () => current);
  const workspaces = new Workspaces('/tmp');
  vi.spyOn(workspaces, 'prepare').mockResolvedValue('/tmp');
  const commit = vi.spyOn(workspaces, 'commitFix').mockReturnValue(commitResult.promise);
  const push = vi.spyOn(workspaces, 'prepareSavedFixPush').mockResolvedValue(async () => {});
  const complete = vi.spyOn(f.engine, 'completeJob');
  const run = vi.fn(async ({ task, job }: AgentInput) =>
    f.result({
      checkedHead: task.revision!.head,
      verifiedCommentIds: job.kind === 'review' ? [finding] : [],
    }),
  );
  const worker = new Worker(f.engine, workspaces, { run }, new DemoRuntime(), healthy, 0);
  const workflow = new TicketWorkflow(f.engine, workspaces);
  worker.autoSubmit = (id) => workflow.pushFixes(id);
  try {
    await worker.tick();
    await vi.waitFor(() => expect(commit).toHaveBeenCalled());
    provider.mockClear().mockReturnValueOnce(providerRead.promise);
    const reconcile = f.engine.reconcile(task.id);
    await vi.waitFor(() => expect(provider).toHaveBeenCalled());
    commitResult.resolve(head);
    await vi.waitFor(() => expect(complete).toHaveBeenCalled());

    const author = complete.mock.calls[0][0];
    const snapshotDir = mkdtempSync(join(tmpdir(), 'daddyloop-saved-fix-snapshot-'));
    const snapshotPath = join(snapshotDir, 'state.sqlite');
    try {
      f.store.db.prepare('VACUUM INTO ?').run(snapshotPath);
      const snapshot = new Store(snapshotPath);
      try {
        expect(snapshot.getTask(task.id).pendingAuthorFix).toBeUndefined();
        const restored = new Engine(snapshot, () => new DemoProvider(snapshot));
        restored.recoverInterruptedJobs();
        await expect(restored.review(task.id, true)).rejects.toMatchObject({
          code: 'fix_pending',
          message: expect.stringContaining(head),
        });
        expect(snapshot.getTask(task.id)).toMatchObject({
          state: 'needs_input',
          revision: { head: originalHead },
          reason: expect.stringContaining(head),
        });
        expect(snapshot.events(task.id)).toContainEqual(
          expect.objectContaining({
            type: 'author.fixes_saved',
            runId: author.id,
            data: { head, revision: task.revision },
          }),
        );
        expect(snapshot.activeJobs(task.id)).toEqual([]);
        expect(await restored.action(task.id, 'resume')).toMatchObject({
          state: 'needs_input',
          reason: expect.stringContaining(head),
        });
        const prepare = vi.fn(async () => async () => {});
        await restored.submitSavedFix(task.id, prepare);
        expect(prepare).not.toHaveBeenCalled();
      } finally {
        snapshot.close();
      }
    } finally {
      rmSync(snapshotDir, { recursive: true, force: true });
    }

    providerRead.resolve(current);
    await reconcile;
    await vi.waitFor(() => expect(f.store.busy(task.id)).toBe(false));
    expect(f.store.getTask(task.id)).toMatchObject({
      state: 'awaiting_push',
      pendingAuthorHead: head,
    });
    await worker.tick();
    await vi.waitFor(() => expect(f.store.getTask(task.id).reason).toContain('Waiting for the PR'));
    await worker.tick();
    expect(f.store.getTask(task.id).revision?.head).toBe(originalHead);
    expect(run).toHaveBeenCalledTimes(1);
    expect(f.store.events(task.id).some((event) => event.type === 'author.submitted')).toBe(false);
    expect(push).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: task.id }), head);
    current = { ...current, head };
    await vi.waitFor(async () => {
      await worker.tick();
      expect(f.store.getTask(task.id).revision?.head).toBe(head);
    });
    await worker.tick();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    expect(run.mock.calls[1][0].task.revision?.head).toBe(head);
  } finally {
    providerRead.resolve(current);
    commitResult.resolve(head);
    await worker.stop();
    f.store.close();
  }
});

it('records structured agent events containing quoted command text without interrupting review', async () => {
  const f = await fixture();
  const demo = new DemoRuntime();
  const run = demo.run.bind(demo);
  vi.spyOn(demo, 'run').mockImplementation(async (input) => {
    input.onEvent('runtime.item', {
      type: 'commandExecution',
      command: 'inspect authorization: "test-fixture" then continue',
      output: [{ private: { api_key: 'opaque test value' }, exitCode: 0 }, 'quoted "output"'],
    });
    return run(input);
  });
  const worker = new Worker(f.engine, new Workspaces('/tmp'), demo, demo, healthy, 0);
  try {
    await worker.tick();
    await vi.waitFor(() => expect(f.store.getTask(f.task.id).state).toBe('awaiting_publication'));
    const item = f.store
      .events(f.task.id)
      .find(
        (e) => e.type === 'runtime.item' && JSON.stringify(e.data).includes('commandExecution'),
      );
    expect(item?.data).toEqual({
      type: 'commandExecution',
      command: 'inspect authorization: "[REDACTED]" then continue',
      output: [{ private: { api_key: '[REDACTED]' }, exitCode: 0 }, 'quoted "output"'],
    });
  } finally {
    await worker.stop();
    f.store.close();
  }
});

it.each([
  'service.interrupted',
  'resource.pause',
  'closed PR',
  'manual pause',
  'legacy manual pause',
] as const)('recovers a saved fix from an author run cancelled by %s', async (source) => {
  const f = await fixture();
  const snapshotDir = mkdtempSync(join(tmpdir(), 'daddyloop-stopped-fix-'));
  const snapshotPath = join(snapshotDir, 'state.sqlite');
  const workspaces = new Workspaces('/tmp');
  const commitResult = deferred<string>();
  const commit = vi.spyOn(workspaces, 'commitFix').mockReturnValue(commitResult.promise);
  vi.spyOn(workspaces, 'prepare').mockResolvedValue('/tmp');
  const runtime = { run: vi.fn(async () => f.result()) };
  let resources: ResourceStatus = healthy();
  const worker = new Worker(f.engine, workspaces, runtime, runtime, () => resources, 0);
  const head = 'f'.repeat(40);
  try {
    await queueFix(f);
    const task = f.store.getTask(f.task.id);
    task.ref.provider = 'github';
    f.store.saveTask(task);
    await worker.tick();
    await vi.waitFor(() => expect(commit).toHaveBeenCalledOnce());
    const author = f.store.jobs(task.id).find((job) => job.kind === 'fix')!;
    if (source === 'resource.pause')
      resources = { ...resources, ok: false, reasons: ['Disk threshold reached'] };
    if (source === 'closed PR') f.store.setSetting('demo-pr:1', { ...task.pr!, state: 'closed' });
    const manuallyPaused = source === 'manual pause' || source === 'legacy manual pause';
    let stopped: Promise<unknown>;
    if (source === 'closed PR') stopped = f.engine.reconcile(task.id);
    else if (manuallyPaused) stopped = f.engine.action(task.id, 'pause');
    else if (source === 'service.interrupted') stopped = worker.stop();
    else stopped = worker.tick();
    await vi.waitFor(() => expect(f.store.getTask(task.id).generation).toBe(author.generation + 1));
    const stoppedReason = f.store.getTask(task.id).reason;
    commitResult.resolve(head);
    await stopped;
    await vi.waitFor(() =>
      expect(f.store.events(task.id)).toContainEqual(
        expect.objectContaining({ type: 'job.cancelled', runId: author.id }),
      ),
    );
    expect(f.store.jobs(task.id).find((job) => job.id === author.id)?.status).toBe('cancelled');
    expect(f.store.getTask(task.id).pendingAuthorFix).toBeUndefined();
    if (source === 'resource.pause') expect(f.store.getTask(task.id).reason).toContain(head);
    expect(f.store.events(task.id)).toContainEqual(
      expect.objectContaining({
        type: 'author.fixes_saved',
        runId: author.id,
        data: { head, revision: task.revision },
      }),
    );

    f.store.db.prepare('VACUUM INTO ?').run(snapshotPath);
    const snapshot = new Store(snapshotPath);
    try {
      // Older snapshots show only the interruption reason until recovery reads the fix journal.
      snapshot.saveTask({ ...snapshot.getTask(task.id), reason: stoppedReason });
      if (source === 'closed PR') snapshot.setSetting('demo-pr:1', task.pr);
      if (source === 'legacy manual pause') {
        const saved = snapshot
          .events(task.id)
          .find((event) => event.type === 'author.fixes_saved' && event.runId === author.id)!;
        snapshot.db
          .prepare('UPDATE events SET data=? WHERE id=?')
          .run(JSON.stringify({ head }), saved.id);
      }
      const provider = new DemoProvider(snapshot);
      const restored = new Engine(snapshot, () => provider);
      if (manuallyPaused) {
        // Simulate a legacy Resume that queued another author before checking the journal.
        const fixing = { ...snapshot.getTask(task.id), state: 'fixing' as const };
        snapshot.saveTask(fixing);
        snapshot.enqueue(fixing, 'author', 'fix', 'Continue the interrupted fix');
        const retry = snapshot.claim()!;
        await restored.completeJob(retry, f.result({ status: 'incomplete' }));
        snapshot.saveJob({ ...retry, status: 'completed' });
      }
      restored.recoverInterruptedJobs();
      await expect(restored.review(task.id, true)).rejects.toMatchObject({
        code: 'fix_pending',
        message: expect.stringContaining(head),
      });
      expect(snapshot.getTask(task.id)).toMatchObject({
        state: 'needs_input',
        revision: task.revision,
        reason: expect.stringContaining(head),
      });
      expect(snapshot.activeJobs(task.id)).toEqual([]);
      expect(snapshot.jobs(task.id).find((job) => job.id === author.id)?.status).toBe('cancelled');

      expect(await restored.action(task.id, 'resume')).toMatchObject({ state: 'needs_input' });
      const prepare = vi.fn(async () => async () => {});
      await restored.submitSavedFix(task.id, prepare);
      expect(prepare).not.toHaveBeenCalled();

      snapshot.setSetting('demo-pr:1', { ...task.pr!, head });
      expect(await restored.action(task.id, 'resume')).toMatchObject({
        state: 'queued',
        revision: { head },
      });
      expect(await restored.review(task.id)).toMatchObject({
        state: 'reviewing',
        review: { revision: { head } },
      });
    } finally {
      snapshot.close();
    }
  } finally {
    commitResult.resolve(head);
    await worker.stop();
    f.store.close();
    rmSync(snapshotDir, { recursive: true, force: true });
  }
});

it('recovers an outstanding pre-upgrade human question only when it still explains the task state', async () => {
  const f = await fixture();
  try {
    await f.engine.review(f.task.id);
    const job = f.store.claim()!;
    const result = {
      ...f.result(),
      status: 'needs_input',
      question: 'Which variant?',
      summary: 'A choice is missing.',
    };
    f.store.event(
      f.task.id,
      'runtime.item',
      { type: 'agentMessage', phase: 'final_answer', text: JSON.stringify(result) },
      job.id,
    );
    await f.engine.completeJob(job, { ...result, status: 'needs_input' });
    f.store.saveJob({ ...job, status: 'completed' });
    const task = f.store.getTask(job.taskId);
    delete task.inputRequest;
    f.store.saveTask({ ...task, reason: 'Another reason' });
    f.engine.recoverInterruptedJobs();
    expect(f.store.getTask(task.id).inputRequest).toBeUndefined();
    f.store.saveTask(task);
    f.engine.recoverInterruptedJobs();
    expect(f.store.getTask(task.id).inputRequest).toEqual({
      runId: job.id,
      role: job.role,
      generation: job.generation,
    });
  } finally {
    f.store.close();
  }
});
it('persists each completed draft before publishing it and running the next stage', async () => {
  const f = await fixture();
  const worker = new Worker(
    f.engine,
    new Workspaces('/tmp'),
    new DemoRuntime(),
    new DemoRuntime(),
    healthy,
    0,
  );
  try {
    await worker.tick();
    await vi.waitFor(() => expect(f.store.getTask(f.task.id).state).toBe('awaiting_publication'));
    const initial = f.store.getTask(f.task.id);
    expect(initial.snapshot?.comments).toHaveLength(1);
    await f.engine.publish(initial.id);
    await worker.tick();
    await vi.waitFor(() => expect(f.store.getTask(initial.id).state).toBe('queued'));
    await worker.tick();
    await vi.waitFor(() => expect(f.store.getTask(initial.id).state).toBe('awaiting_publication'));
    const final = f.store.getTask(initial.id);
    expect(final.round).toBe(2);
    expect(final.snapshot?.comments).toHaveLength(0);
    expect(final.revision?.head).not.toBe(initial.revision?.head);
    await f.engine.publish(initial.id);
    expect(f.store.getTask(initial.id).state).toBe('complete');
    expect(f.store.messages(initial.id).map((m) => m.role)).toEqual([
      'reviewer',
      'author',
      'reviewer',
    ]);
  } finally {
    await worker.stop();
    f.store.close();
  }
});
it('publishes automatically even when an older task stored a manual policy', async () => {
  const f = await fixture();
  Object.assign(f.task.policy, { publication: 'human', autoPush: false });
  f.store.saveTask(f.task);
  const worker = new Worker(
    f.engine,
    new Workspaces('/tmp'),
    new DemoRuntime(),
    new DemoRuntime(),
    healthy,
    0,
  );
  try {
    for (let round = 0; round < 6 && f.store.getTask(f.task.id).state !== 'complete'; round++) {
      await worker.tick();
      await vi.waitFor(() =>
        expect(f.store.jobs().some((j) => j.status === 'running')).toBe(false),
      );
    }
    expect(f.store.getTask(f.task.id).state).toBe('complete');
  } finally {
    await worker.stop();
    f.store.close();
  }
});

it('sends an older task’s saved corrections and reconciles the new PR head', async () => {
  const f = await fixture();
  const workspaces = new Workspaces('/tmp');
  const runtime = new DemoRuntime();
  const worker = new Worker(f.engine, workspaces, runtime, runtime, healthy, 0);
  const workflow = new TicketWorkflow(f.engine, workspaces);
  worker.autoSubmit = (id) => workflow.pushFixes(id);
  try {
    await queueFix(f);
    const author = f.store.claim()!;
    const task = f.store.getTask(f.task.id);
    const pending = 'f'.repeat(40);
    f.store.event(
      task.id,
      'author.feedback_snapshot',
      { ...task.feedback, targetBranch: task.pr?.targetBranch },
      author.id,
    );
    f.store.event(task.id, 'author.fixes_saved', { head: pending }, author.id);
    f.store.saveJob({ ...author, status: 'completed' });
    task.state = 'awaiting_push';
    task.pendingAuthorHead = pending;
    task.authorBaseHead = task.revision?.head;
    Object.assign(task.policy, { autoPush: false });
    f.store.saveTask(task);
    let current = task.pr!;
    vi.spyOn(f.provider, 'getPR').mockImplementation(async () => current);
    const push = vi
      .spyOn(workspaces, 'prepareSavedFixPush')
      .mockImplementation(async () => async () => {
        current = { ...current, head: pending };
      });
    await worker.tick();
    await vi.waitFor(() => expect(f.store.getTask(task.id).revision?.head).toBe(pending));
    expect(push).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: task.id }), pending);
  } finally {
    await worker.stop();
    f.store.close();
  }
});

it.each([true, false])(
  'holds a legacy pending head after a retarget (author target recorded: %s)',
  async (recorded) => {
    const f = await fixture();
    const runtime = { run: vi.fn() };
    const worker = new Worker(f.engine, new Workspaces('/tmp'), runtime, runtime, healthy, 0);
    const push = vi.fn(async () => {});
    worker.autoSubmit = (id) => f.engine.submitSavedFix(id, async () => push);
    try {
      await queueFix(f);
      const author = f.store.claim()!;
      const task = f.store.getTask(f.task.id);
      const created = task.pr!;
      const saved = 'f'.repeat(40);
      f.store.event(
        task.id,
        'author.feedback_snapshot',
        { ...task.feedback, targetBranch: recorded ? created.targetBranch : undefined },
        author.id,
      );
      f.store.event(task.id, 'author.fixes_saved', { head: saved }, author.id);
      f.store.saveJob({ ...author, status: 'completed' });
      const retargeted = { ...created, targetBranch: 'release' };
      f.store.saveTask({
        ...task,
        state: 'awaiting_push',
        pendingAuthorHead: saved,
        authorBaseHead: task.revision!.head,
        pr: retargeted,
        ticketRepository: {
          baseBranch: created.targetBranch,
          baseHead: created.base,
          branch: created.branch,
        },
      });
      f.store.setSetting('demo-pr:1', retargeted);
      await worker.tick();
      await vi.waitFor(() => expect(f.store.getTask(task.id).state).toBe('needs_input'));
      expect(f.store.getTask(task.id).reason).toContain(saved);
      expect(f.store.getTask(task.id).reason).toContain(created.targetBranch);
      expect(f.store.getTask(task.id).reason).toContain(retargeted.targetBranch);
      expect(push).not.toHaveBeenCalled();
      expect(runtime.run).not.toHaveBeenCalled();

      if (!recorded) {
        f.store.setSetting('demo-pr:1', created);
        await f.engine.action(task.id, 'resume');
        await f.engine.submitSavedFix(task.id, async () => push);
        expect(f.store.getTask(task.id)).toMatchObject({
          state: 'needs_input',
          pendingAuthorHead: saved,
        });
        expect(push).not.toHaveBeenCalled();
      }
    } finally {
      await worker.stop();
      f.store.close();
    }
  },
);

it('keeps a legacy pending fix ahead of queued review after the PR base changes', async () => {
  const f = await fixture();
  const runtime = { run: vi.fn(async () => f.result()) };
  const worker = new Worker(f.engine, new Workspaces('/tmp'), runtime, runtime, healthy, 0);
  try {
    await queueFix(f);
    const author = f.store.claim()!;
    const task = f.store.getTask(f.task.id);
    const head = 'f'.repeat(40);
    f.store.event(task.id, 'author.feedback_snapshot', task.feedback, author.id);
    f.store.event(task.id, 'author.fixes_saved', { head }, author.id);
    f.store.saveJob({ ...author, status: 'completed' });
    f.store.event(task.id, 'task.state', {
      state: 'awaiting_push',
      generation: author.generation,
      head: task.revision!.head,
    });
    const pr = { ...task.pr!, base: 'e'.repeat(40) };
    const revision = revisionOf(pr);
    const generation = author.generation + 1;
    f.store.event(task.id, 'revision.changed', { revision, generation });
    f.store.event(task.id, 'task.state', {
      state: 'queued',
      reason: 'New revision is ready for review',
      generation,
      head: pr.head,
    });
    f.store.saveTask({
      ...task,
      pr,
      revision,
      generation,
      state: 'queued',
      review: undefined,
      snapshot: undefined,
      pendingAuthorHead: head,
      authorBaseHead: task.revision!.head,
    });
    f.store.setSetting('demo-pr:1', pr);
    await worker.tick();
    await vi.waitFor(() => expect(f.store.busy(task.id)).toBe(false));
    expect(runtime.run).not.toHaveBeenCalled();
    expect(f.store.getTask(task.id)).toMatchObject({
      state: 'needs_input',
      pendingAuthorHead: head,
      reason: expect.stringContaining(head),
    });
    await expect(f.engine.review(task.id, true)).rejects.toMatchObject({ code: 'fix_pending' });
  } finally {
    await worker.stop();
    f.store.close();
  }
});

it.each([
  'rolled back',
  'manually reviewed',
  'draft on another base',
  'first observation on another base',
  'first observation with another start',
] as const)(
  'uses provider and review revisions to recover a legacy pending fix (%s)',
  async (scenario) => {
    const f = await fixture();
    const runtime = { run: vi.fn(async () => f.result()) };
    const worker = new Worker(f.engine, new Workspaces('/tmp'), runtime, runtime, healthy, 0);
    try {
      await queueFix(f);
      const author = f.store.claim()!;
      const task = f.store.getTask(f.task.id);
      const head = 'f'.repeat(40);
      f.store.event(task.id, 'author.feedback_snapshot', task.feedback, author.id);
      f.store.event(task.id, 'author.fixes_saved', { head }, author.id);
      f.store.saveJob({ ...author, status: 'completed' });
      const original = task.pr!;
      const rolledBack = scenario === 'rolled back';
      const wrongDraftBase = scenario === 'draft on another base';
      const firstObservationChanged = scenario.startsWith('first observation');
      if (rolledBack) f.store.event(task.id, 'author.submitted', { head, pushed: true });
      const pr = {
        ...original,
        head: rolledBack ? original.head : head,
        base:
          rolledBack || scenario === 'first observation on another base'
            ? 'e'.repeat(40)
            : original.base,
        start:
          scenario === 'first observation with another start' ? 'd'.repeat(40) : original.start,
      };
      const revision = revisionOf(pr);
      const generation = author.generation + 1;
      f.store.event(task.id, 'revision.changed', { revision, generation });
      f.store.event(task.id, 'task.state', {
        state: 'queued',
        reason: 'New revision is ready for review',
        generation,
        head: pr.head,
      });
      const review: ReviewHandle | undefined =
        rolledBack || firstObservationChanged
          ? undefined
          : await f.provider.createReview(
              prRef(task),
              wrongDraftBase ? { ...revision, base: 'e'.repeat(40) } : revision,
              'legacy-review-on-H2',
            );
      if (review && scenario === 'manually reviewed') review.targetBranch = original.targetBranch;
      f.store.saveTask({
        ...task,
        pr,
        revision,
        generation,
        pendingAuthorHead: head,
        authorBaseHead: original.head,
        state: review ? 'awaiting_publication' : 'queued',
        review,
        snapshot: review && (await f.provider.getReview(prRef(task), review)),
        reviewFinished: !!review,
      });
      f.store.setSetting('demo-pr:1', pr);
      await worker.tick();
      await vi.waitFor(() => expect(f.store.busy(task.id)).toBe(false));
      const current = f.store.getTask(task.id);
      expect(runtime.run).not.toHaveBeenCalled();
      if (rolledBack) {
        expect(current.state).toBe('needs_input');
        expect(current.reason).toContain(head);
        expect(current.reason).toContain(original.head);
      } else if (firstObservationChanged) {
        expect(current).toMatchObject({ state: 'needs_input', pendingAuthorHead: head });
        for (const sha of [head, original.base, original.start, pr.base, pr.start])
          expect(current.reason).toContain(sha);
        await f.engine.action(task.id, 'resume');
        const prepare = vi.fn(async () => async () => {});
        await f.engine.submitSavedFix(task.id, prepare);
        expect(prepare).not.toHaveBeenCalled();
        expect(f.store.getTask(task.id).state).toBe('needs_input');
        for (const sha of [head, original.base, original.start, pr.base, pr.start])
          expect(f.store.getTask(task.id).reason).toContain(sha);
      } else if (wrongDraftBase) {
        expect(current).toMatchObject({ state: 'needs_input', revision });
        expect(await f.provider.getReview(prRef(task), review!)).toMatchObject({ status: 'draft' });
      } else {
        expect(current).toMatchObject({ state: 'complete', revision });
        expect(await f.provider.getReview(prRef(task), review!)).toMatchObject({
          status: 'published',
        });
      }
    } finally {
      await worker.stop();
      f.store.close();
    }
  },
);

it.each(['head', 'base', 'targetBranch', 'cached targetBranch'] as const)(
  'checks a published legacy fix when the next PR %s changes',
  async (changed) => {
    const f = await fixture();
    try {
      await queueFix(f);
      const author = f.store.claim()!;
      const task = f.store.getTask(f.task.id);
      const head = 'f'.repeat(40);
      f.store.event(task.id, 'author.feedback_snapshot', task.feedback, author.id);
      f.store.event(task.id, 'author.fixes_saved', { head }, author.id);
      f.store.saveJob({ ...author, status: 'completed' });
      f.store.event(task.id, 'author.submitted', { head, pushed: true });
      const pr = { ...task.pr!, head, checks: 'pending' as const };
      const revision = revisionOf(pr);
      const generation = author.generation + 1;
      f.store.event(task.id, 'revision.changed', { revision, generation });
      const review = await f.provider.createReview(prRef(task), revision, 'legacy-review-on-H2');
      await f.provider.publish(prRef(task), review);
      const snapshot = await f.provider.getReview(prRef(task), review);
      f.store.event(task.id, 'review.published', { reviewId: review.id, snapshot });
      f.store.saveTask({
        ...task,
        pr,
        revision,
        generation,
        pendingAuthorHead: head,
        authorBaseHead: task.revision!.head,
        state: 'awaiting_checks',
        review,
        reviewFinished: true,
        snapshot,
      });

      const retargeted = changed === 'targetBranch' || changed === 'cached targetBranch';
      const next = retargeted
        ? { ...pr, targetBranch: 'release', checks: 'passing' as const }
        : { ...pr, [changed]: 'e'.repeat(40) };
      if (changed === 'cached targetBranch') {
        const legacy = f.store.getTask(task.id);
        f.store.saveTask({ ...legacy, pr: { ...pr, targetBranch: next.targetBranch } });
      }
      f.store.setSetting('demo-pr:1', next);
      const restarted = new Engine(f.store, () => f.provider);
      if (retargeted) {
        const runtime = { run: vi.fn() };
        const worker = new Worker(restarted, new Workspaces('/tmp'), runtime, runtime, healthy, 0);
        try {
          await worker.tick();
          expect(runtime.run).not.toHaveBeenCalled();
          const blocked = f.store.getTask(task.id);
          expect(blocked).toMatchObject({
            state: 'needs_input',
            review,
            pr: { targetBranch: changed === 'targetBranch' ? pr.targetBranch : next.targetBranch },
          });
          const branchEvidence =
            changed === 'targetBranch' ? pr.targetBranch : 'no recorded target branch';
          for (const value of [branchEvidence, next.targetBranch, 'Retry review'])
            expect(blocked.reason).toContain(value);
        } finally {
          await worker.stop();
        }
      } else {
        expect(await restarted.reconcile(task.id)).toMatchObject({
          state: 'queued',
          revision: revisionOf(next),
        });
      }
      expect(await restarted.review(task.id, true)).toMatchObject({
        state: 'reviewing',
        review: { revision: revisionOf(next), targetBranch: next.targetBranch },
      });
    } finally {
      f.store.close();
    }
  },
);

it.each(['base', 'start'] as const)(
  'blocks a rollback when the legacy fix was published with a different %s',
  async (field) => {
    const f = await fixture();
    const runtime = { run: vi.fn(async () => f.result()) };
    const worker = new Worker(
      new Engine(f.store, () => f.provider),
      new Workspaces('/tmp'),
      runtime,
      runtime,
      healthy,
      0,
    );
    try {
      await queueFix(f);
      const author = f.store.claim()!;
      const task = f.store.getTask(f.task.id);
      const original = task.pr!;
      const head = 'fc7653947a156709d819016a0aaa0c7d0a0b8908';
      const wrong = 'e'.repeat(40);
      f.store.event(task.id, 'author.feedback_snapshot', task.feedback, author.id);
      f.store.event(task.id, 'author.fixes_saved', { head }, author.id);
      f.store.saveJob({ ...author, status: 'completed' });
      const pr = { ...original, head, [field]: wrong };
      const revision = revisionOf(pr);
      const generation = author.generation + 1;
      f.store.event(task.id, 'revision.changed', { revision, generation });
      f.store.event(task.id, 'task.state', {
        state: 'queued',
        head,
        generation,
        reason: 'Author pushed changes; independent verification is next',
      });
      const ref = prRef(task);
      const review = await f.provider.createReview(ref, revision, 'legacy-review-on-moved-base');
      await f.provider.publish(ref, review);
      const snapshot = await f.provider.getReview(ref, review);
      f.store.event(task.id, 'review.published', { reviewId: review.id, snapshot });
      f.store.saveTask({
        ...task,
        pr,
        revision,
        generation,
        review,
        snapshot,
        state: 'awaiting_checks',
        reviewFinished: true,
      });
      f.store.setSetting('demo-pr:1', original);
      await worker.tick();
      await vi.waitFor(() => expect(f.store.busy(task.id)).toBe(false));
      const blocked = f.store.getTask(task.id);
      expect(blocked).toMatchObject({ state: 'needs_input', review });
      for (const expected of [head, original[field], wrong])
        expect(blocked.reason).toContain(expected);
      expect(runtime.run).not.toHaveBeenCalled();
      await expect(f.engine.review(task.id, true)).rejects.toMatchObject({ code: 'fix_pending' });
    } finally {
      await worker.stop();
      f.store.close();
    }
  },
);

it.each(['after polling', 'after reading the draft'] as const)(
  'keeps a legacy review in draft when the target changes %s',
  async (when) => {
    const f = await fixture();
    const runtime = { run: vi.fn() };
    const worker = new Worker(f.engine, new Workspaces('/tmp'), runtime, runtime, healthy, 0);
    try {
      await f.engine.review(f.task.id);
      await f.run();
      const task = f.store.getTask(f.task.id);
      const review = { ...task.review!, targetBranch: undefined };
      f.store.saveTask({ ...task, review });
      const pr = task.pr!;
      const retargeted = { ...pr, targetBranch: 'release' };
      const publish = vi.spyOn(f.provider, 'publish');
      const check = vi.spyOn(f.provider, 'getPR').mockResolvedValue(retargeted);
      check.mockResolvedValueOnce(pr);
      if (when === 'after reading the draft') check.mockResolvedValueOnce(pr);
      await worker.tick();
      const blocked = f.store.getTask(task.id);
      expect(blocked.state).toBe('needs_input');
      expect(blocked.review?.id).toBe(review.id);
      expect(blocked.reason).toContain(pr.targetBranch);
      expect(blocked.reason).toContain(retargeted.targetBranch);
      expect(publish).not.toHaveBeenCalled();
      expect(await f.provider.getReview(prRef(task), review)).toMatchObject({ status: 'draft' });
    } finally {
      await worker.stop();
      f.store.close();
    }
  },
);

it.each(['draft', 'published'] as const)(
  'holds the legacy round in awaiting_publication with a cached retarget and a %s review',
  async (status) => {
    const f = await fixture();
    const runtime = { run: vi.fn() };
    const worker = new Worker(f.engine, new Workspaces('/tmp'), runtime, runtime, healthy, 0);
    try {
      await f.engine.review(f.task.id);
      await f.run();
      const task = f.store.getTask(f.task.id);
      expect(task.state).toBe('awaiting_publication');
      const review = task.review!;
      delete review.targetBranch;
      const ref = { ...prRef(task), provider: 'github' as const };
      if (status === 'published') await f.provider.publish(ref, review);
      const snapshot = await f.provider.getReview(ref, review);
      const pr = { ...task.pr!, targetBranch: 'release', checks: 'passing' as const };
      f.store.saveTask({ ...task, ref, review, pr });
      f.store.setSetting('demo-pr:1', pr);
      const publish = vi.spyOn(f.provider, 'publish');

      await worker.tick();

      const blocked = f.store.getTask(task.id);
      expect(blocked).toMatchObject({ state: 'needs_input', revision: task.revision, review });
      for (const detail of ['no recorded target branch', 'Retry review', 'release'])
        expect(blocked.reason).toContain(detail);
      expect(publish).not.toHaveBeenCalled();
      expect(runtime.run).not.toHaveBeenCalled();
      expect(await f.provider.getReview(ref, review)).toEqual(snapshot);
      expect(f.store.events(task.id).some(({ type }) => type === 'review.published')).toBe(false);

      if (status === 'draft') {
        expect(await f.engine.review(task.id, true)).toMatchObject({
          state: 'needs_input',
          review,
          reason: expect.stringContaining('GitHub still has a draft'),
        });
        expect(await f.provider.getReview(ref, review)).toEqual(snapshot);
        f.store.setSetting(`demo-review:${review.id}`, { ...snapshot, status: 'missing' });
      }
      const next = await f.engine.review(task.id, true);
      expect(next).toMatchObject({ state: 'reviewing', review: { targetBranch: 'release' } });
      expect(next.review?.id).not.toBe(review.id);
    } finally {
      await worker.stop();
      f.store.close();
    }
  },
);

it('stops a queued legacy reviewer when the target changes after polling', async () => {
  const f = await fixture();
  const runtime = { run: vi.fn(async () => f.result()) };
  const workspaces = new Workspaces('/tmp');
  const prepare = vi.spyOn(workspaces, 'prepare').mockResolvedValue('/tmp');
  const worker = new Worker(f.engine, workspaces, runtime, runtime, healthy, 0);
  try {
    const task = await f.engine.review(f.task.id);
    const review = task.review!;
    delete review.targetBranch;
    const ref = prRef(task);
    const snapshot = await f.provider.getReview(ref, review);
    f.store.saveTask({ ...task, ref: { ...ref, provider: 'github' }, review });
    const pr = task.pr!;
    vi.spyOn(f.provider, 'getPR')
      .mockResolvedValue({ ...pr, targetBranch: 'release' })
      .mockResolvedValueOnce(pr);

    await f.engine.reconcile(task.id);
    await worker.tick();
    await vi.waitFor(() => expect(f.store.busy(task.id)).toBe(false));

    const blocked = f.store.getTask(task.id);
    expect(blocked).toMatchObject({ state: 'needs_input', revision: task.revision, review });
    for (const detail of [pr.targetBranch, 'release', 'Retry review'])
      expect(blocked.reason).toContain(detail);
    expect(prepare).not.toHaveBeenCalled();
    expect(runtime.run).not.toHaveBeenCalled();
    expect(await f.provider.getReview(ref, review)).toEqual(snapshot);
  } finally {
    await worker.stop();
    f.store.close();
  }
});

it.each([
  ['main', 'draft'],
  ['release', 'draft'],
  ['release', 'published'],
  ['main', 'rolled back'],
  ['main', 'changed base'],
  ['main', 'lost response then published'],
] as const)(
  'binds an explicit legacy fix retry to the observed PR (%s, %s)',
  async (branch, status) => {
    const f = await fixture();
    const checked: string[] = [];
    const workspaces = new Workspaces('/tmp');
    vi.spyOn(workspaces, 'prepare').mockResolvedValue('/tmp');
    const restarted = new Engine(f.store, () => f.provider);
    const runtime = {
      run: vi.fn(async ({ task }: AgentInput) => {
        checked.push(task.revision!.head);
        return f.result({ checkedHead: task.revision!.head });
      }),
    };
    const worker = new Worker(restarted, workspaces, runtime, runtime, healthy, 0);
    try {
      const finding = await queueFix(f);
      runtime.run.mockImplementation(async ({ task }) => {
        checked.push(task.revision!.head);
        return f.result({ checkedHead: task.revision!.head, verifiedCommentIds: [finding] });
      });
      const author = f.store.claim()!;
      const task = f.store.getTask(f.task.id);
      const ref = { ...prRef(task), provider: 'github' as const };
      const head = 'fc7653947a156709d819016a0aaa0c7d0a0b8908';
      f.store.event(task.id, 'author.feedback_snapshot', task.feedback, author.id);
      f.store.event(task.id, 'author.fixes_saved', { head }, author.id);
      f.store.saveJob({ ...author, status: 'completed' });
      const pr = { ...task.pr!, head, targetBranch: branch };
      const revision = revisionOf(pr);
      const generation = author.generation + 1;
      f.store.event(task.id, 'revision.changed', { revision, generation });
      const review = await f.provider.createReview(ref, revision, 'legacy-fix-review');
      if (status === 'published') await f.provider.publish(ref, review);
      f.store.saveTask({
        ...task,
        ref,
        pr,
        revision,
        generation,
        review,
        pendingAuthorHead: head,
        state: 'awaiting_publication',
        reviewFinished: true,
        snapshot: await f.provider.getReview(ref, review),
      });
      f.store.setSetting('demo-pr:1', pr);
      expect(await f.engine.publish(task.id)).toMatchObject({ state: 'needs_input' });
      if (status !== 'published') {
        const snapshot = await f.provider.getReview(ref, review);
        f.store.setSetting(`demo-review:${review.id}`, { ...snapshot, status: 'missing' });
      }
      if (status === 'rolled back' || status === 'changed base') {
        f.store.setSetting(
          'demo-pr:1',
          status === 'rolled back'
            ? { ...pr, head: task.revision!.head }
            : { ...pr, base: 'e'.repeat(40) },
        );
        const create = vi.spyOn(f.provider, 'createReview');
        await expect(f.engine.review(task.id, true)).rejects.toMatchObject({ code: 'fix_pending' });
        expect(create).not.toHaveBeenCalled();
        return;
      }
      if (status === 'lost response then published') {
        const create = f.provider.createReview.bind(f.provider);
        vi.spyOn(f.provider, 'createReview').mockImplementationOnce(async (...args) => {
          const saved = await create(...args);
          await f.provider.publish(ref, saved);
          throw new Error('Lost create response');
        });
        await expect(f.engine.review(task.id, true)).rejects.toThrow('Lost create response');
        expect(await restarted.review(task.id, true)).toMatchObject({
          state: 'needs_input',
          reason: expect.stringContaining('already published'),
        });
        expect(
          f.store.events(task.id).some(({ type }) => type === 'author.fix_confirmed_for_review'),
        ).toBe(true);
      }
      expect(await f.engine.review(task.id, true)).toMatchObject({
        state: 'reviewing',
        review: { targetBranch: branch },
      });
      await worker.tick();
      await vi.waitFor(() => expect(f.store.busy(task.id)).toBe(false));
      expect(checked).toEqual([head]);
      expect(f.store.getTask(task.id).state).toBe('awaiting_publication');
    } finally {
      await worker.stop();
      f.store.close();
    }
  },
);

it.each([false, true])(
  'recovers a fix whose first legacy observation cleared its pointer (rolled back: %s)',
  async (rolledBack) => {
    const f = await fixture();
    const runtime = { run: vi.fn(async () => f.result()) };
    const worker = new Worker(f.engine, new Workspaces('/tmp'), runtime, runtime, healthy, 0);
    try {
      await queueFix(f);
      const author = f.store.claim()!;
      const task = f.store.getTask(f.task.id);
      const original = task.pr!;
      const head = 'f'.repeat(40);
      f.store.event(task.id, 'author.feedback_snapshot', task.feedback, author.id);
      f.store.event(task.id, 'author.fixes_saved', { head }, author.id);
      // Legacy completeJob saw H2 on B2 before awaiting_push and cleared the pending pointer.
      const pr = { ...original, head, base: 'e'.repeat(40) };
      const revision = revisionOf(pr);
      const generation = author.generation + 1;
      f.store.event(task.id, 'revision.changed', { revision, generation });
      f.store.event(task.id, 'task.state', {
        state: 'queued',
        reason: 'Author pushed changes; independent verification is next',
        generation,
        head,
      });
      f.store.saveJob({ ...author, status: 'completed' });
      f.store.saveTask({
        ...task,
        pr,
        revision,
        generation,
        state: 'queued',
        review: undefined,
        snapshot: undefined,
        reviewFinished: false,
        pendingAuthorHead: undefined,
      });
      const observed = rolledBack ? { ...pr, head: original.head } : pr;
      f.store.setSetting('demo-pr:1', observed);

      await worker.tick();
      await vi.waitFor(() => expect(f.store.busy(task.id)).toBe(false));
      expect(runtime.run).not.toHaveBeenCalled();
      const blocked = f.store.getTask(task.id);
      expect(blocked).toMatchObject({ state: 'needs_input', revision });
      expect(blocked.reason).toContain(head);
      expect(blocked.reason).toContain(observed.head);
      expect(blocked.reason).toContain(original.base);
      expect(blocked.reason).toContain(observed.base);
    } finally {
      await worker.stop();
      f.store.close();
    }
  },
);

it.each(['retargeted', 'unknown', 'matching'] as const)(
  'checks the author target before the first review of a recovered fix (%s)',
  async (scenario) => {
    const f = await fixture();
    const runtime = { run: vi.fn(async () => f.result()) };
    const worker = new Worker(f.engine, new Workspaces('/tmp'), runtime, runtime, healthy, 0);
    try {
      await queueFix(f);
      const author = f.store.claim()!;
      const task = f.store.getTask(f.task.id);
      const original = task.pr!;
      const head = 'f'.repeat(40);
      f.store.event(
        task.id,
        'author.feedback_snapshot',
        {
          ...task.feedback,
          targetBranch: scenario === 'unknown' ? undefined : original.targetBranch,
        },
        author.id,
      );
      f.store.event(task.id, 'author.fixes_saved', { head }, author.id);
      f.store.saveJob({ ...author, status: 'completed' });
      const pr = {
        ...original,
        head,
        targetBranch: scenario === 'matching' ? original.targetBranch : 'release',
      };
      const revision = revisionOf(pr);
      const generation = author.generation + 1;
      f.store.event(task.id, 'revision.changed', { revision, generation });
      f.store.event(task.id, 'task.state', {
        state: 'queued',
        reason: 'New revision is ready for review',
        generation,
        head,
      });
      f.store.saveTask({
        ...task,
        pr,
        revision,
        generation,
        state: 'queued',
        review: undefined,
        snapshot: undefined,
        reviewFinished: false,
        pendingAuthorHead: head,
        authorBaseHead: original.head,
      });
      f.store.setSetting('demo-pr:1', pr);

      await worker.tick();
      await vi.waitFor(() => expect(f.store.busy(task.id)).toBe(false));
      const current = f.store.getTask(task.id);
      if (scenario === 'matching') {
        expect(runtime.run).toHaveBeenCalledOnce();
        expect(current.review).toMatchObject({ revision, targetBranch: pr.targetBranch });
      } else {
        expect(runtime.run).not.toHaveBeenCalled();
        expect(current).toMatchObject({ state: 'needs_input', revision, pendingAuthorHead: head });
        expect(current.reason).toContain(head);
        expect(current.reason).toContain(pr.targetBranch);
        expect(current.reason).toContain(
          scenario === 'retargeted' ? original.targetBranch : 'target branch could not be verified',
        );
      }
    } finally {
      await worker.stop();
      f.store.close();
    }
  },
);

it.each(['available', 'unavailable', 'unknown target'] as const)(
  'recovers a legacy push receipt without sending again (%s)',
  async (scenario) => {
    const f = await fixture();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      await queueFix(f);
      const author = f.store.claim()!;
      const task = f.store.getTask(f.task.id);
      const head = 'f'.repeat(40);
      f.store.event(
        task.id,
        'author.feedback_snapshot',
        {
          ...task.feedback,
          targetBranch: scenario === 'unknown target' ? undefined : task.pr!.targetBranch,
        },
        author.id,
      );
      f.store.event(task.id, 'author.fixes_saved', { head }, author.id);
      f.store.saveJob({ ...author, status: 'completed' });
      f.store.event(task.id, 'author.submitted', { head, pushed: true });
      f.store.saveTask({
        ...task,
        state: 'awaiting_push',
        pendingAuthorHead: head,
        authorBaseHead: task.revision!.head,
      });
      const prepare = vi.fn(async () => async () => {});
      const now = Date.now();
      if (scenario === 'unavailable') {
        const getPR = vi.spyOn(f.provider, 'getPR').mockImplementation(async () => {
          expect(f.store.getTask(task.id).pendingAuthorFix).toMatchObject({
            sent: true,
            confirmUntil: now + 60_000,
          });
          throw new Error('Provider unavailable');
        });
        await expect(f.engine.submitSavedFix(task.id, prepare)).rejects.toThrow(
          'Provider unavailable',
        );
        vi.setSystemTime(now + 120_000);
        await new Engine(f.store, () => f.provider).submitSavedFix(task.id, prepare);
        expect(f.store.getTask(task.id)).toMatchObject({
          state: 'needs_input',
          pendingAuthorHead: head,
        });
        expect(f.store.getTask(task.id).reason).toContain('Provider unavailable');
        expect(f.store.getTask(task.id).reason).toContain(head);
        vi.setSystemTime(now + 2 * 60 * 60_000);
        await f.engine.submitSavedFix(task.id, prepare);
        expect(f.store.getTask(task.id).state).toBe('needs_input');
        expect(getPR).toHaveBeenCalledTimes(2);
      } else {
        await f.engine.submitSavedFix(task.id, prepare);
        const current = f.store.getTask(task.id);
        if (scenario === 'unknown target') {
          expect(current.state).toBe('needs_input');
          expect(current.reason).toContain('target branch could not be verified');
          expect(current.reason).toContain(head);
          expect(current.reason).toContain(task.revision!.head);
        } else {
          expect(current.reason).toContain(`Waiting for the PR to confirm saved fix ${head}`);
        }
      }
      expect(prepare).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      f.store.close();
    }
  },
);

it('still blocks retry review after an author discussion fails with a legacy pending fix', async () => {
  const f = await fixture();
  try {
    await queueFix(f);
    const author = f.store.claim()!;
    const task = f.store.getTask(f.task.id);
    const head = 'f'.repeat(40);
    f.store.event(task.id, 'author.feedback_snapshot', task.feedback, author.id);
    f.store.event(task.id, 'author.fixes_saved', { head }, author.id);
    f.store.saveJob({ ...author, status: 'completed' });
    f.store.saveTask({
      ...task,
      state: 'awaiting_push',
      pendingAuthorHead: head,
      authorBaseHead: task.revision!.head,
    });
    const push = vi.fn(async () => {});
    await f.engine.submitSavedFix(task.id, async () => push);
    expect(f.store.getTask(task.id).state).toBe('needs_input');
    await f.engine.chat(task.id, 'author', 'Discuss the target branch');
    const chat = f.store.claim()!;
    f.engine.failJob(chat, new Error('Discussion failed'));
    f.store.saveJob({ ...chat, status: 'failed' });
    expect(f.store.getTask(task.id)).toMatchObject({
      state: 'needs_input',
      resumeState: 'needs_input',
      pendingAuthorHead: head,
      reason: expect.stringContaining(head),
    });
    await expect(f.engine.review(task.id, true)).rejects.toMatchObject({
      code: 'fix_pending',
      message: expect.stringContaining(head),
    });
    expect(push).not.toHaveBeenCalled();
  } finally {
    f.store.close();
  }
});

it.each([false, true])(
  'stops the author when the PR is retargeted after feedback was published (cached PR already updated: %s)',
  async (cachedPRMoved) => {
    const f = await fixture();
    const runtime = { run: vi.fn(async () => f.result()) };
    const workspaces = new Workspaces('/tmp');
    const prepare = vi.spyOn(workspaces, 'prepare').mockResolvedValue('/tmp');
    const commit = vi.spyOn(workspaces, 'commitFix').mockResolvedValue('f'.repeat(40));
    const worker = new Worker(f.engine, workspaces, runtime, runtime, healthy, 0);
    const push = vi.fn(async () => {});
    worker.autoSubmit = (id) => f.engine.submitSavedFix(id, async () => push);
    try {
      await queueFix(f);
      const task = f.store.getTask(f.task.id);
      const original = task.pr!;
      const retargeted = { ...original, targetBranch: 'release' };
      task.ref.provider = 'github';
      if (cachedPRMoved) task.pr = retargeted;
      f.store.saveTask(task);
      f.store.setSetting('demo-pr:1', retargeted);
      await worker.tick();
      await vi.waitFor(() => expect(f.store.busy(task.id)).toBe(false));
      expect(runtime.run).not.toHaveBeenCalled();
      expect(prepare).not.toHaveBeenCalled();
      expect(commit).not.toHaveBeenCalled();
      expect(push).not.toHaveBeenCalled();
      expect(f.store.getTask(task.id)).toMatchObject({
        state: 'needs_input',
        revision: task.revision,
        reason: expect.stringContaining(original.targetBranch),
      });
      expect(f.store.getTask(task.id).reason).toContain(retargeted.targetBranch);
      expect(
        f.store.events(task.id).some((event) => event.type === 'author.feedback_snapshot'),
      ).toBe(false);
    } finally {
      await worker.stop();
      f.store.close();
    }
  },
);

it.each(['before reviewer', 'before publication', 'while reading the draft'] as const)(
  'preserves a fix review draft when its target changes %s',
  async (when) => {
    const f = await fixture();
    const runtime = { run: vi.fn(async () => f.result()) };
    const worker = new Worker(
      f.engine,
      new Workspaces('/tmp'),
      runtime,
      runtime,
      healthy,
      Infinity,
    );
    try {
      const finding = await queueFix(f);
      const author = f.store.claim()!;
      const task = f.store.getTask(f.task.id);
      const head = 'f'.repeat(40);
      await f.engine.completeJob(author, f.result(), { head, revision: task.revision! });
      f.store.saveJob({ ...author, status: 'completed' });
      const pr = { ...task.pr!, head };
      await f.engine.submitSavedFix(
        task.id,
        async () => async () => f.store.setSetting('demo-pr:1', pr),
      );
      const queued = await f.engine.review(task.id);
      expect(queued.pendingAuthorFix).toBeUndefined();
      const draft = queued.review!;
      expect(draft.targetBranch).toBe(pr.targetBranch);
      if (when !== 'before reviewer') {
        await f.run({ verifiedCommentIds: [finding] });
        expect(f.store.getTask(task.id).state).toBe('awaiting_publication');
      }
      const ref = prRef(task);
      const before = await f.provider.getReview(ref, draft);
      const publish = vi.spyOn(f.provider, 'publish');
      const retargeted = { ...pr, targetBranch: 'release' };
      if (when === 'while reading the draft') {
        const read = f.provider.getReview.bind(f.provider);
        vi.spyOn(f.provider, 'getReview').mockImplementationOnce(async (ref, review) => {
          f.store.setSetting('demo-pr:1', retargeted);
          return read(ref, review);
        });
      } else {
        f.store.setSetting('demo-pr:1', retargeted);
      }

      if (when === 'before reviewer') {
        await worker.tick();
        await vi.waitFor(() => expect(f.store.busy(task.id)).toBe(false));
        expect(runtime.run).not.toHaveBeenCalled();
      } else {
        await f.engine.publish(task.id);
      }
      expect(publish).not.toHaveBeenCalled();
      const blocked = f.store.getTask(task.id);
      expect(blocked).toMatchObject({ state: 'needs_input', review: draft });
      expect(blocked.reason).toContain(pr.targetBranch);
      expect(blocked.reason).toContain(retargeted.targetBranch);
      expect(await f.provider.getReview(ref, draft)).toEqual(before);

      const next = await f.engine.review(task.id, true);
      expect(next).toMatchObject({
        state: 'reviewing',
        review: { targetBranch: retargeted.targetBranch },
      });
      expect(next.review?.id).not.toBe(draft.id);
      expect(await f.provider.getReview(ref, draft)).toEqual(before);
    } finally {
      await worker.stop();
      f.store.close();
    }
  },
);

it.each(['published', 'deleted'] as const)(
  'carries published feedback on retry after the old GitHub draft was %s',
  async (status) => {
    const f = await fixture();
    try {
      const first = await queueFix(f);
      const author = f.store.claim()!;
      const task = f.store.getTask(f.task.id);
      task.ref.provider = 'github';
      f.store.saveTask(task);
      const head = 'f'.repeat(40);
      await f.engine.completeJob(author, f.result(), { head, revision: task.revision! });
      f.store.saveJob({ ...author, status: 'completed' });
      const pr = { ...task.pr!, head };
      await f.engine.submitSavedFix(
        task.id,
        async () => async () => f.store.setSetting('demo-pr:1', pr),
      );
      const secondReview = await f.engine.review(task.id);
      const second = (await f.engine.broker.call(f.job(), 'add_comment', {
        key: 'R2',
        body: 'Check this finding on the next target',
      })) as { id: string };
      await f.run({ verifiedCommentIds: [first] });
      f.store.setSetting('demo-pr:1', { ...pr, targetBranch: 'release' });
      const oldReview = secondReview.review!;
      if (status === 'published') await f.provider.publish(prRef(task), oldReview);
      else {
        const draft = await f.provider.getReview(prRef(task), oldReview);
        f.store.setSetting(`demo-review:${oldReview.id}`, {
          ...draft,
          status: 'missing',
          comments: [],
        });
      }
      const snapshot = await f.provider.getReview(prRef(task), oldReview);
      const expected =
        status === 'published'
          ? { ...snapshot, comments: [...task.feedback!.comments, ...snapshot.comments] }
          : task.feedback;

      const next = await f.engine.review(task.id, true);
      expect(next.review?.targetBranch).toBe('release');
      expect(next.feedback).toEqual(expected);
      expect(next.feedback?.comments.map((comment) => comment.id)).toEqual(
        status === 'published' ? [first, second.id] : [first],
      );
      await f.run({ verifiedCommentIds: [first] });
      if (status === 'published') {
        expect(f.store.getTask(task.id)).toMatchObject({
          state: 'needs_input',
          reason: 'Reviewer has not verified all previously published findings',
        });
      } else {
        expect(f.store.getTask(task.id).state).toBe('awaiting_publication');
      }
    } finally {
      f.store.close();
    }
  },
);

it.each(
  (['approve-plan', 'waive-checks'] as const).flatMap((action) =>
    (['open', 'unknown target', 'closed', 'merged'] as const).map(
      (scenario) => [action, scenario] as const,
    ),
  ),
)('blocks %s after a target change (%s)', async (action, scenario) => {
  const plan = action === 'approve-plan';
  const f = await fixture({ kind: plan ? 'plan' : 'code' });
  try {
    const finding = await queueFix(f);
    const author = f.store.claim()!;
    const task = f.store.getTask(f.task.id);
    const head = 'f'.repeat(40);
    await f.engine.completeJob(author, f.result(), { head, revision: task.revision! });
    f.store.saveJob({ ...author, status: 'completed' });
    const pr = { ...task.pr!, head, checks: plan ? 'passing' : 'missing' };
    await f.engine.submitSavedFix(
      task.id,
      async () => async () => f.store.setSetting('demo-pr:1', pr),
    );
    await f.engine.review(task.id);
    await f.run({ verifiedCommentIds: [finding] });
    const published = await f.engine.publish(task.id);
    expect(published.state).toBe(plan ? 'awaiting_plan_approval' : 'awaiting_checks');
    const savedReview = published.review!;
    if (scenario === 'unknown target') {
      delete savedReview.targetBranch;
      f.store.saveTask(published);
    }
    const retargeted = {
      ...pr,
      state: scenario === 'unknown target' ? 'open' : scenario,
      targetBranch: 'release',
    };
    f.store.setSetting('demo-pr:1', retargeted);

    const blocked = await f.engine.action(task.id, action, 'Reviewed output manually');
    expect(blocked).toMatchObject({
      state: 'needs_input',
      review: savedReview,
      snapshot: published.snapshot,
    });
    expect(blocked.reason).toContain(retargeted.targetBranch);
    if (scenario === 'unknown target') expect(blocked.reason).toContain('Retry review');
    else expect(blocked.reason).toContain(pr.targetBranch);
    if (retargeted.state !== 'open') expect(blocked.reason).toContain(retargeted.state);
    expect(blocked.checksWaivedAt).toBeUndefined();
    expect(blocked.approvedAt).toBeUndefined();
    expect(
      f.store
        .events(task.id)
        .filter((event) => ['checks.waived', `human.${action}`].includes(event.type)),
    ).toEqual([]);

    if (retargeted.state === 'open')
      expect(await f.engine.review(task.id, true)).toMatchObject({
        state: 'reviewing',
        review: { targetBranch: 'release' },
      });
  } finally {
    f.store.close();
  }
});

it('requires a new review when legacy published feedback has no recorded target branch', async () => {
  const f = await fixture();
  const runtime = { run: vi.fn(async () => f.result()) };
  const workspaces = new Workspaces('/tmp');
  const prepare = vi.spyOn(workspaces, 'prepare').mockResolvedValue('/tmp');
  const worker = new Worker(f.engine, workspaces, runtime, runtime, healthy, 0);
  try {
    await queueFix(f);
    const task = f.store.getTask(f.task.id);
    const oldReview = task.review!;
    delete oldReview.targetBranch;
    const pr = { ...task.pr!, targetBranch: 'release' };
    f.store.saveTask({ ...task, pr });
    f.store.setSetting('demo-pr:1', pr);
    await worker.tick();
    await vi.waitFor(() => expect(f.store.busy(task.id)).toBe(false));
    expect(runtime.run).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    const blocked = f.store.getTask(task.id);
    expect(blocked).toMatchObject({ state: 'needs_input', review: oldReview });
    expect(blocked.reason).toContain('no recorded target branch');
    expect(blocked.reason).toContain('release');
    const next = await f.engine.review(task.id, true);
    expect(next).toMatchObject({ state: 'reviewing', review: { targetBranch: 'release' } });
    expect(next.review?.id).not.toBe(oldReview.id);
  } finally {
    await worker.stop();
    f.store.close();
  }
});

it.each([
  ['head before push', false, { head: 'd'.repeat(40) }],
  ['base before push', false, { base: 'e'.repeat(40) }],
  ['comparison start after push', true, { start: 'e'.repeat(40) }],
  ['head after push', true, { head: 'd'.repeat(40) }],
] as const)('preserves the fix when the PR changes its %s', async (_name, afterPush, change) => {
  const f = await fixture();
  try {
    const task = f.store.getTask(f.task.id);
    const head = 'f'.repeat(40);
    task.state = 'awaiting_push';
    task.pendingAuthorHead = head;
    task.pendingAuthorFix = { generation: task.generation, revision: task.revision! };
    f.store.saveTask(task);
    let current = afterPush ? task.pr! : { ...task.pr!, ...change };
    vi.spyOn(f.provider, 'getPR').mockImplementation(async () => current);
    const push = vi.fn(async () => {
      current = { ...current, head, ...change };
    });
    await f.engine.reconcile(task.id);
    await f.engine.submitSavedFix(task.id, async () => push);
    expect(push).toHaveBeenCalledTimes(afterPush ? 1 : 0);
    expect(f.store.getTask(task.id)).toMatchObject({
      state: 'needs_input',
      revision: task.revision,
      pendingAuthorHead: head,
      reason: expect.stringContaining(head),
    });
    await expect(f.engine.review(task.id, true)).rejects.toMatchObject({ code: 'fix_pending' });
    expect(f.store.jobs(task.id)).toHaveLength(0);
  } finally {
    f.store.close();
  }
});

it('blocks the next review if the confirmed PR revision changes before review starts', async () => {
  const f = await fixture();
  try {
    const task = f.store.getTask(f.task.id);
    const head = 'f'.repeat(40);
    task.state = 'awaiting_push';
    task.pendingAuthorHead = head;
    task.pendingAuthorFix = { generation: task.generation, revision: task.revision! };
    f.store.saveTask(task);
    const confirmed = { ...task.pr!, head };
    f.store.setSetting('demo-pr:1', confirmed);
    const push = vi.fn();
    await f.engine.submitSavedFix(task.id, async () => push);
    expect(push).not.toHaveBeenCalled();
    expect(f.store.getTask(task.id).state).toBe('queued');

    f.store.setSetting('demo-pr:1', { ...confirmed, base: 'e'.repeat(40) });
    const blocked = await f.engine.review(task.id);
    expect(blocked).toMatchObject({
      state: 'needs_input',
      revision: { head, base: confirmed.base },
      pendingAuthorHead: head,
      reason: expect.stringContaining(head),
    });
    expect(f.store.jobs(task.id)).toHaveLength(0);
  } finally {
    f.store.close();
  }
});

it('preserves a fix but prevents automatic submission from a stale generation', async () => {
  const f = await fixture();
  try {
    const task = f.store.getTask(f.task.id);
    const head = 'f'.repeat(40);
    task.state = 'awaiting_push';
    task.pendingAuthorHead = head;
    task.pendingAuthorFix = { generation: task.generation, revision: task.revision! };
    task.generation++;
    f.store.saveTask(task);
    const push = vi.fn();
    await f.engine.submitSavedFix(task.id, async () => push);
    expect(push).not.toHaveBeenCalled();
    expect(f.store.getTask(task.id)).toMatchObject({
      state: 'needs_input',
      pendingAuthorHead: head,
      reason: expect.stringContaining(head),
    });
  } finally {
    f.store.close();
  }
});

it('recovers the lost saved fix on Resume and leaves both earlier reviews intact', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'daddyloop-saved-fix-'));
  const f = await fixture();
  const runtime = { run: vi.fn() };
  let worker: Worker | undefined;
  try {
    const remote = join(dir, 'remote.git'),
      source = join(dir, 'source');
    mkdirSync(source);
    await git(['init'], source);
    await git(['init', '--bare', remote], dir);
    writeFileSync(join(source, 'file.txt'), 'Before review\n');
    await git(['add', 'file.txt'], source);
    await git(
      ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-m', 'Initial'],
      source,
    );
    const ref = 'refs/heads/fix';
    await git(['push', remote, `HEAD:${ref}`], source);
    const originalHead = await git(['rev-parse', 'HEAD'], source);

    const task = f.store.getTask(f.task.id);
    task.ref.provider = 'github';
    task.ref.host = 'github.com';
    task.repoPath = source;
    task.revision = { head: originalHead, base: originalHead, start: originalHead };
    const pr = { ...task.pr!, ...task.revision, branch: 'fix', cloneUrl: remote };
    task.pr = pr;
    f.store.saveTask(task);
    vi.spyOn(f.provider, 'getPR').mockImplementation(async () => ({
      ...pr,
      head: await git(['--git-dir', remote, 'rev-parse', ref], dir),
    }));
    const repositories = new RepositoryRegistry([
      {
        ...allRepositories().get('github'),
        git: {
          parse: () => ({
            url: remote,
            host: task.ref.host,
            repo: task.ref.repo,
            protocol: 'https:',
          }),
          environment: () => ({}),
        },
      },
    ]);
    const workspaces = new Workspaces(join(dir, 'data'), repositories);

    const first = await f.engine.review(task.id);
    await f.engine.broker.call(f.job(), 'add_comment', { key: 'R1', body: 'Needs a fix' });
    await f.run();
    await f.engine.publish(task.id);
    const author = f.store.claim()!;
    const fixing = f.store.getTask(task.id);
    const cwd = await workspaces.prepare(fixing, 'author');
    f.store.saveTask(fixing);
    writeFileSync(join(cwd, 'file.txt'), 'Fixed\n');
    const saved = await workspaces.commitFix(fixing, 'Fix review finding');
    f.store.event(
      task.id,
      'author.feedback_snapshot',
      { ...fixing.feedback, targetBranch: pr.targetBranch },
      author.id,
    );
    f.store.event(task.id, 'author.fixes_saved', { head: saved }, author.id);
    await f.engine.completeJob(author, f.result());
    author.status = 'completed';
    f.store.saveJob(author);
    const oldRound = f.store.getTask(task.id);
    expect(oldRound.reason).toContain('Author made no code changes');
    delete oldRound.authorWorktree;
    delete oldRound.authorBaseHead;
    oldRound.round = 2;
    oldRound.review = await f.provider.createReview(prRef(task), task.revision, 'legacy-round-2');
    oldRound.state = 'reviewing';
    f.store.saveTask(oldRound);
    const staleJob = f.store.enqueue(oldRound, 'reviewer', 'review', 'Verify previous findings');
    const restarted = new Engine(f.store, () => f.provider);
    worker = new Worker(restarted, workspaces, runtime, runtime, healthy, 0);
    restarted.recoverInterruptedJobs();
    expect(f.store.jobs(task.id).at(-1)?.status).toBe('queued');
    await worker.tick();
    await vi.waitFor(() => expect(f.store.busy(task.id)).toBe(false));
    expect(runtime.run).not.toHaveBeenCalled();
    expect(f.store.getTask(task.id)).toMatchObject({
      state: 'needs_input',
      reason: expect.stringContaining(saved),
    });
    expect(f.store.jobs(task.id).at(-1)).toMatchObject({ id: staleJob.id, status: 'failed' });
    await expect(f.engine.review(task.id, true)).rejects.toMatchObject({ code: 'fix_pending' });
    const events = f.store.events(task.id);
    const jobs = f.store.jobs(task.id);
    const staleDraft = await f.provider.getReview(prRef(task), oldRound.review);

    const resumed = await f.engine.action(task.id, 'resume');
    expect(resumed).toMatchObject({ state: 'awaiting_push', pendingAuthorHead: saved });
    await new TicketWorkflow(f.engine, new Workspaces(dir)).pushFixes(task.id);
    expect(f.store.getTask(task.id)).toMatchObject({
      state: 'needs_input',
      reason: expect.stringContaining('managed author workspace is missing'),
    });
    const preflight = f.store.getTask(task.id).pendingAuthorFix;
    expect(preflight?.pushStarted).toBeUndefined();
    expect(preflight?.confirmUntil).toBeUndefined();
    expect(await git(['--git-dir', remote, 'rev-parse', ref], dir)).toBe(originalHead);
    await f.engine.action(task.id, 'resume');
    await new TicketWorkflow(f.engine, workspaces).pushFixes(task.id);
    expect(await git(['--git-dir', remote, 'rev-parse', ref], dir)).toBe(saved);
    expect(await f.engine.review(task.id)).toMatchObject({
      state: 'needs_input',
      reason: expect.stringContaining('GitHub still has a draft'),
    });
    expect(await f.provider.getReview(prRef(task), oldRound.review)).toEqual(staleDraft);
    f.store.setSetting(`demo-review:${oldRound.review.id}`, { ...staleDraft, status: 'missing' });
    await f.engine.action(task.id, 'resume');
    const next = await f.engine.review(task.id);
    expect(next).toMatchObject({ round: 3, revision: { head: saved } });
    expect(next.pendingAuthorFix).toBeUndefined();
    expect(next.resumeState).toBeUndefined();
    expect(next.feedback?.revision.head).toBe(originalHead);
    expect(await f.provider.getReview(prRef(task), first.review!)).toEqual(next.feedback);
    expect(f.store.events(task.id).slice(0, events.length)).toEqual(events);
    expect(f.store.jobs(task.id).filter((job) => jobs.some((old) => old.id === job.id))).toEqual(
      jobs,
    );
  } finally {
    await worker?.stop();
    f.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it.each([true, false])(
  'notices a lost fix after the old service replaced the starting base (run revision recorded: %s)',
  async (hasRunRevision) => {
    const f = await fixture();
    const runtime = { run: vi.fn() };
    const worker = new Worker(f.engine, new Workspaces('/tmp'), runtime, runtime, healthy, 0);
    try {
      await queueFix(f);
      const author = f.store.claim()!;
      const task = f.store.getTask(f.task.id);
      const head = 'f'.repeat(40);
      const pr = { ...task.pr!, base: 'e'.repeat(40) };
      if (hasRunRevision)
        f.store.event(task.id, 'author.feedback_snapshot', task.feedback, author.id);
      f.store.event(task.id, 'author.fixes_saved', { head }, author.id);
      f.store.saveJob({ ...author, status: 'completed' });
      const reason = 'Author pushed changes; independent verification is next';
      const generation = author.generation + 1;
      const revision = revisionOf(pr);
      f.store.saveTask({
        ...task,
        pr,
        revision,
        generation,
        state: 'queued',
        reason,
        review: undefined,
        snapshot: undefined,
      });
      f.store.event(task.id, 'revision.changed', { revision, generation });
      f.store.event(task.id, 'task.state', { state: 'queued', reason, generation, head: pr.head });
      f.store.setSetting('demo-pr:1', pr);
      await worker.tick();
      await vi.waitFor(() => expect(f.store.busy(task.id)).toBe(false));
      expect(runtime.run).not.toHaveBeenCalled();
      const blocked = f.store.getTask(task.id);
      expect(blocked.state).toBe('needs_input');
      expect(blocked.reason).toContain(head);
      expect(blocked.reason).toContain(pr.base);
      if (hasRunRevision) expect(blocked.reason).toContain(task.revision!.base);
      expect(await f.engine.action(task.id, 'resume')).toMatchObject({ state: 'needs_input' });
    } finally {
      await worker.stop();
      f.store.close();
    }
  },
);

it('keeps the starting revision if the base changes during an author discussion', async () => {
  const f = await fixture();
  try {
    const { task, saved } = await recordLegacyLostFix(f);
    f.store.saveTask({ ...task, state: 'needs_input' });
    await f.engine.chat(task.id, 'author', 'Discuss the published findings');
    const base = 'e'.repeat(40);
    f.store.setSetting('demo-pr:1', { ...task.pr!, base });
    await f.run();
    const blocked = f.store.getTask(task.id);
    expect(blocked).toMatchObject({ state: 'needs_input', revision: task.revision });
    expect(blocked.reason).toContain(saved);
    expect(blocked.reason).toContain(base);
    await expect(f.engine.review(task.id, true)).rejects.toMatchObject({ code: 'fix_pending' });
  } finally {
    f.store.close();
  }
});

it.each([false, true])(
  'holds a pending fix observed on the wrong base (revision already replaced: %s)',
  async (revisionAlreadyReplaced) => {
    const f = await fixture();
    try {
      await queueFix(f);
      const author = f.store.claim()!;
      const task = f.store.getTask(f.task.id);
      const head = 'f'.repeat(40);
      await f.engine.completeJob(author, f.result(), { head, revision: task.revision! });
      f.store.saveJob({ ...author, status: 'completed' });
      const push = vi.fn(async () => {});
      const submit = () => f.engine.submitSavedFix(task.id, async () => push);
      await submit();
      const current = { ...task.pr!, head, base: 'e'.repeat(40) };
      f.store.setSetting('demo-pr:1', current);
      if (revisionAlreadyReplaced) {
        f.store.saveTask({
          ...f.store.getTask(task.id),
          state: 'needs_input',
          pr: current,
          revision: revisionOf(current),
        });
      } else {
        await f.engine.chat(task.id, 'author', 'Discuss the published findings');
        expect(f.store.activeJobs(task.id)).toEqual([]);
        await f.engine.reconcile(task.id);
        const held = f.store.getTask(task.id);
        expect(held).toMatchObject({
          state: 'needs_input',
          revision: task.revision,
          pendingAuthorHead: head,
        });
        expect(held.deferredWorkerInstructions).toEqual([
          expect.objectContaining({ text: 'Discuss the published findings' }),
        ]);
        expect(held.reason).toContain(task.revision!.base);
        expect(held.reason).toContain(current.base);
      }
      const resumed = await f.engine.action(task.id, 'resume');
      expect(resumed.state).toBe('awaiting_push');
      await submit();
      const blocked = f.store.getTask(task.id);
      expect(blocked.state).toBe('needs_input');
      expect(blocked.reason).toContain(task.revision!.base);
      expect(blocked.reason).toContain(current.base);
      await expect(f.engine.review(task.id, true)).rejects.toMatchObject({ code: 'fix_pending' });
      expect(f.store.events(task.id).some((event) => event.type === 'author.submitted')).toBe(
        false,
      );
      const confirmed = { ...task.pr!, head };
      f.store.setSetting('demo-pr:1', confirmed);
      await f.engine.action(task.id, 'resume');
      await submit();
      expect(await f.engine.review(task.id)).toMatchObject({
        state: 'reviewing',
        revision: revisionOf(confirmed),
      });
      expect(push).toHaveBeenCalledOnce();
    } finally {
      f.store.close();
    }
  },
);

it.each([
  ['closed', { state: 'closed' }],
  ['changed base', { base: 'e'.repeat(40) }],
  ['changed source branch', { branch: 'other-source' }],
] as const)('checks for a %s PR again after local push preparation', async (_scenario, change) => {
  const f = await fixture();
  try {
    const task = f.store.getTask(f.task.id);
    const head = 'f'.repeat(40);
    task.state = 'awaiting_push';
    task.pendingAuthorHead = head;
    task.pendingAuthorFix = { generation: task.generation, revision: task.revision! };
    f.store.saveTask(task);
    const pr = { ...task.pr!, ...change };
    const push = vi.fn(async () => {
      f.store.setSetting('demo-pr:1', { ...pr, head });
    });
    await f.engine.submitSavedFix(task.id, async () => {
      f.store.setSetting('demo-pr:1', pr);
      return push;
    });
    expect(push).not.toHaveBeenCalled();
    expect(await f.provider.getPR(prRef(task))).toEqual(pr);
    const blocked = f.store.getTask(task.id);
    expect(blocked).toMatchObject({
      state: 'needs_input',
      revision: task.revision,
      pendingAuthorHead: head,
    });
    expect(blocked.pendingAuthorFix?.pushStarted).toBeUndefined();
    expect(blocked.pendingAuthorFix?.confirmUntil).toBeUndefined();
  } finally {
    f.store.close();
  }
});

it('resumes a paused legacy task after the saved commit was pushed manually', async () => {
  const f = await fixture();
  try {
    const { task, saved } = await recordLegacyLostFix(f);
    task.ref.provider = 'github';
    task.review = await f.provider.createReview(prRef(task), task.revision!, 'legacy-round-2');
    f.store.saveTask({ ...task, state: 'needs_input' });
    await f.engine.action(task.id, 'pause');
    const current = { ...task.pr!, head: saved };
    f.store.setSetting('demo-pr:1', { ...current, base: 'e'.repeat(40) });
    expect(await f.engine.action(task.id, 'resume')).toMatchObject({ state: 'needs_input' });

    f.store.setSetting('demo-pr:1', current);
    expect(await f.engine.reconcile(task.id)).toMatchObject({
      state: 'needs_input',
      reason: expect.stringContaining('contains the saved fix on the original base'),
    });
    expect(await f.engine.action(task.id, 'resume')).toMatchObject({
      state: 'needs_input',
      reason: expect.stringContaining('GitHub still has a draft'),
    });
    const draft = await f.provider.getReview(prRef(task), task.review);
    f.store.setSetting(`demo-review:${task.review.id}`, { ...draft, status: 'missing' });
    expect(await f.engine.action(task.id, 'resume')).toMatchObject({
      state: 'queued',
      revision: { head: saved },
    });
    const push = vi.fn();
    await f.engine.submitSavedFix(task.id, async () => push);
    expect(push).not.toHaveBeenCalled();
    const next = await f.engine.review(task.id);
    expect(next).toMatchObject({ state: 'reviewing', revision: { head: saved } });
    expect(f.store.jobs(task.id).at(-1)?.generation).toBe(next.generation);
  } finally {
    f.store.close();
  }
});

it.each([
  ['github', 'resume', 'published'],
  ['github', 'resume', 'missing'],
  ['github', 'retry', 'published'],
  ['github', 'retry', 'missing'],
  ['gitlab', 'retry', 'published'],
] as const)(
  'preserves published feedback while recovering a confirmed fix (%s, %s, stale draft %s)',
  async (provider, path, status) => {
    const f = await fixture();
    try {
      const { task, saved } = await recordLegacyLostFix(f, false);
      const prior = task.feedback!;
      task.ref.provider = provider;
      const ref = prRef(task);
      const stale = await f.provider.createReview(ref, task.revision!, 'stale-draft-on-H1');
      await f.provider.createComment(ref, stale, 'A second finding', `${stale.marker}:comment:R2`);
      task.review = stale;
      task.state = 'needs_input';
      if (path === 'retry') {
        task.state = 'awaiting_push';
        task.pendingAuthorHead = saved;
        task.pendingAuthorFix = {
          revision: task.revision!,
          generation: task.generation,
          staleDraft: stale,
        };
      }
      f.store.saveTask(task);
      f.store.setSetting('demo-pr:1', { ...task.pr!, head: saved });
      const prepare = vi.fn(async () => async () => {});
      if (path === 'retry') await f.engine.submitSavedFix(task.id, prepare);
      const blocked =
        path === 'resume'
          ? await f.engine.action(task.id, 'resume')
          : await f.engine.review(task.id);
      expect(blocked).toMatchObject({
        state: 'needs_input',
        reason: expect.stringContaining(
          provider === 'github' ? 'GitHub still has a draft' : 'GitLab still has draft',
        ),
      });
      expect(prepare).not.toHaveBeenCalled();

      if (status === 'published') await f.provider.publish(ref, stale);
      else
        f.store.setSetting(`demo-review:${stale.id}`, {
          ...(await f.provider.getReview(ref, stale)),
          status: 'missing',
        });
      const snapshot = await f.provider.getReview(ref, stale);
      const expected =
        status === 'published'
          ? { ...snapshot, comments: [...prior.comments, ...snapshot.comments] }
          : prior;
      const queued = await f.engine.action(task.id, 'resume');
      expect(queued.state).toBe('queued');
      if (path === 'resume') expect(queued.feedback).toEqual(expected);
      const next = await f.engine.review(task.id);
      expect(next).toMatchObject({
        state: 'reviewing',
        revision: { head: saved },
        feedback: expected,
      });
      await f.run({ verifiedCommentIds: [prior.comments[0].id] });
      expect(f.store.getTask(task.id).state).toBe(
        status === 'published' ? 'needs_input' : 'awaiting_publication',
      );
    } finally {
      f.store.close();
    }
  },
);

it.each(['ticket', 'author run', 'unknown'] as const)(
  'recovers on the original PR target and base (branch evidence: %s)',
  async (branchEvidence) => {
    const f = await fixture();
    try {
      await queueFix(f);
      const author = f.store.claim()!;
      const task = f.store.getTask(f.task.id);
      const head = 'f'.repeat(40);
      const targetBranch = task.pr!.targetBranch;
      f.store.event(
        task.id,
        'author.feedback_snapshot',
        {
          ...task.feedback,
          targetBranch: branchEvidence === 'author run' ? targetBranch : undefined,
        },
        author.id,
      );
      if (branchEvidence !== 'unknown') {
        task.ticketRepository = {
          baseHead: task.revision!.base,
          baseBranch: branchEvidence === 'ticket' ? targetBranch : 'original-creation-target',
          branch: task.pr!.branch,
        };
      }
      f.store.event(task.id, 'author.fixes_saved', { head }, author.id);
      f.store.saveJob({ ...author, status: 'completed' });
      const temporary = { ...task.pr!, base: 'e'.repeat(40), targetBranch: 'release' };
      const revision = revisionOf(temporary);
      const generation = author.generation + 1;
      f.store.event(task.id, 'revision.changed', { revision, generation });
      f.store.event(task.id, 'task.state', {
        state: 'queued',
        reason: 'Author pushed changes; independent verification is next',
        generation,
        head: temporary.head,
      });
      f.store.saveTask({
        ...task,
        state: 'needs_input',
        pr: temporary,
        revision,
        generation,
        review: undefined,
        snapshot: undefined,
      });
      const current = { ...task.pr!, head };
      f.store.setSetting('demo-pr:1', { ...current, targetBranch: temporary.targetBranch });
      expect(await f.engine.action(task.id, 'resume')).toMatchObject({
        state: 'needs_input',
        revision,
      });
      f.store.setSetting('demo-pr:1', current);
      if (branchEvidence !== 'author run') {
        expect(await f.engine.action(task.id, 'resume')).toMatchObject({
          state: 'needs_input',
          revision,
          reason: expect.stringMatching(/original PR target branch.*saved fix/i),
        });
        expect(f.store.busy(task.id)).toBe(false);
        return;
      }
      expect(await f.engine.reconcile(task.id)).toMatchObject({
        state: 'needs_input',
        reason: expect.stringContaining('contains the saved fix on the original base'),
        revision,
      });
      expect(await f.engine.action(task.id, 'resume')).toMatchObject({
        state: 'queued',
        revision: revisionOf(current),
        pendingAuthorFix: { revision: task.revision, sent: false },
      });
      expect(
        f.store.events(task.id).find((event) => event.type === 'author.submitted')?.data,
      ).toEqual({ head, pushed: false });
      expect(await f.engine.review(task.id)).toMatchObject({
        state: 'reviewing',
        revision: revisionOf(current),
      });
    } finally {
      f.store.close();
    }
  },
);

it.each([true, false])(
  'makes a stranded legacy fix in awaiting_push resumable (provider available: %s)',
  async (providerAvailable) => {
    const f = await fixture();
    const runtime = { run: vi.fn() };
    const worker = new Worker(f.engine, new Workspaces('/tmp'), runtime, runtime, healthy, 0);
    const push = vi.fn(async () => {});
    worker.autoSubmit = (id) => f.engine.submitSavedFix(id, async () => push);
    try {
      const { task, saved } = await recordLegacyLostFix(f);
      f.store.saveTask({
        ...task,
        state: 'awaiting_push',
        reason: 'Resumed by the user; current provider state will be reconciled',
      });
      if (!providerAvailable)
        vi.spyOn(f.provider, 'getPR').mockRejectedValue(new Error('Provider unavailable'));
      await worker.tick();
      expect(f.store.getTask(task.id)).toMatchObject({
        state: 'needs_input',
        revision: task.revision,
        reason: expect.stringContaining(saved),
      });
      expect(push).not.toHaveBeenCalled();
      expect(runtime.run).not.toHaveBeenCalled();
      expect(await f.engine.action(task.id, 'resume')).toMatchObject({
        state: 'awaiting_push',
        pendingAuthorHead: saved,
      });
    } finally {
      await worker.stop();
      f.store.close();
    }
  },
);

it('continues to block review of a lost fix after pause advances the generation', async () => {
  const f = await fixture();
  try {
    const { task, saved } = await recordLegacyLostFix(f);
    const id = task.id;
    f.store.saveTask({ ...task, state: 'needs_input' });
    await expect(f.engine.review(id, true)).rejects.toMatchObject({ code: 'fix_pending' });

    await f.engine.action(id, 'pause');
    expect(await f.engine.action(id, 'resume')).toMatchObject({
      state: 'needs_input',
      revision: task.revision,
      generation: task.generation + 1,
      reason: expect.stringContaining(saved),
    });
    await expect(f.engine.review(id, true)).rejects.toMatchObject({
      code: 'fix_pending',
      message: expect.stringContaining(saved),
    });
    const push = vi.fn();
    await f.engine.submitSavedFix(id, async () => push);
    expect(push).not.toHaveBeenCalled();
    expect(f.store.busy(id)).toBe(false);
  } finally {
    f.store.close();
  }
});

it('does not use the creation branch as the target of an unrecorded legacy fix', async () => {
  const f = await fixture();
  try {
    const created = f.task.pr!;
    const retargeted = { ...created, targetBranch: 'release' };
    f.store.setSetting('demo-pr:1', retargeted);
    await queueFix(f);
    const author = f.store.claim()!;
    const task = f.store.getTask(f.task.id);
    const saved = 'f'.repeat(40);
    f.store.event(task.id, 'author.feedback_snapshot', task.feedback, author.id);
    f.store.event(task.id, 'author.fixes_saved', { head: saved }, author.id);
    await f.engine.completeJob(author, f.result());
    f.store.saveJob({ ...author, status: 'completed' });
    f.store.saveTask({
      ...f.store.getTask(task.id),
      state: 'needs_input',
      ticketRepository: {
        baseBranch: created.targetBranch,
        baseHead: created.base,
        branch: created.branch,
      },
    });
    const push = vi.fn(async () => {
      f.store.setSetting('demo-pr:1', { ...created, head: saved });
    });
    for (const pr of [retargeted, created, { ...created, head: saved }]) {
      f.store.setSetting('demo-pr:1', pr);
      await f.engine.action(task.id, 'resume');
      await f.engine.submitSavedFix(task.id, async () => push);
      const blocked = f.store.getTask(task.id);
      expect(blocked.state).toBe('needs_input');
      expect(blocked.reason).toContain(saved);
      expect(blocked.reason).toContain(created.targetBranch);
      expect(blocked.reason).toContain(retargeted.targetBranch);
      expect(push).not.toHaveBeenCalled();
      await expect(f.engine.review(task.id, true)).rejects.toMatchObject({ code: 'fix_pending' });
    }
    vi.spyOn(f.provider, 'getPR').mockRejectedValue(new Error('Provider unavailable'));
    const blocked = await f.engine.action(task.id, 'resume');
    expect(blocked.state).toBe('needs_input');
    expect(blocked.reason).toContain(saved);
    expect(blocked.reason).toContain(created.targetBranch);
    expect(blocked.reason).toContain(retargeted.targetBranch);
  } finally {
    f.store.close();
  }
});

it.each(['publish', 'worker', 'finish'] as const)(
  'keeps a legacy review with a lost fix from advancing through %s',
  async (entry) => {
    const f = await fixture();
    const runtime = { run: vi.fn() };
    const worker = new Worker(f.engine, new Workspaces('/tmp'), runtime, runtime, healthy, 0);
    try {
      const { task, saved } = await recordLegacyLostFix(f);
      const ref = prRef(task);
      const review = await f.provider.createReview(ref, task.revision!, 'legacy-round-2');
      if (entry === 'finish') await f.provider.publish(ref, review);
      const snapshot = await f.provider.getReview(ref, review);
      const publish = vi.spyOn(f.provider, 'publish');
      f.store.saveTask({
        ...task,
        state: entry === 'finish' ? 'awaiting_checks' : 'awaiting_publication',
        review,
        reviewFinished: true,
        round: 2,
        snapshot,
      });
      f.engine.recoverInterruptedJobs();
      if (entry === 'publish') await f.engine.publish(task.id);
      else if (entry === 'finish') await f.engine.reconcile(task.id);
      else await worker.tick();
      expect(f.store.getTask(task.id)).toMatchObject({
        state: 'needs_input',
        reason: expect.stringContaining(saved),
        review,
        snapshot,
        revision: task.revision,
      });
      expect(publish).not.toHaveBeenCalled();
      expect(runtime.run).not.toHaveBeenCalled();
      expect(await f.provider.getReview(ref, review)).toEqual(snapshot);
    } finally {
      await worker.stop();
      f.store.close();
    }
  },
);

it.each(['needs_input', 'queued'] as const)(
  'preserves the original revision of a lost fix when the PR base changes in %s',
  async (state) => {
    const f = await fixture();
    try {
      const { task, saved } = await recordLegacyLostFix(f);
      f.store.saveTask({ ...task, state });
      await expect(f.engine.review(task.id, true)).rejects.toMatchObject({ code: 'fix_pending' });
      const changedBase = 'e'.repeat(40);
      f.store.setSetting('demo-pr:1', { ...task.pr!, base: changedBase });
      const blocked = await f.engine.reconcile(task.id);
      expect(blocked).toMatchObject({
        state: 'needs_input',
        revision: task.revision,
        feedback: task.feedback,
      });
      expect(blocked.reason).toContain(saved);
      expect(blocked.reason).toContain(changedBase);
      await expect(f.engine.review(task.id, true)).rejects.toMatchObject({ code: 'fix_pending' });
      expect(f.store.busy(task.id)).toBe(false);
    } finally {
      f.store.close();
    }
  },
);

it('blocks a lost fix when the original author job was left cancelled before its final write', async () => {
  const f = await fixture();
  const runtime = { run: vi.fn() };
  const worker = new Worker(f.engine, new Workspaces('/tmp'), runtime, runtime, healthy, 0);
  try {
    const { task, saved } = await recordLegacyLostFix(f, false);
    expect(f.store.jobs(task.id).at(-1)).toMatchObject({ kind: 'fix', status: 'cancelled' });
    f.engine.recoverInterruptedJobs();
    await worker.tick();
    await vi.waitFor(() => expect(f.store.busy(task.id)).toBe(false));
    expect(runtime.run).not.toHaveBeenCalled();
    expect(f.store.getTask(task.id)).toMatchObject({
      state: 'needs_input',
      reason: expect.stringContaining(saved),
    });
    expect(await f.engine.action(task.id, 'resume')).toMatchObject({
      state: 'needs_input',
      reason: `The author run did not record completion. Inspect saved fix ${saved} before continuing.`,
    });
    const push = vi.fn();
    await f.engine.submitSavedFix(task.id, async () => push);
    expect(push).not.toHaveBeenCalled();
    expect(f.store.jobs(task.id).at(-1)).toMatchObject({ kind: 'fix', status: 'cancelled' });
  } finally {
    await worker.stop();
    f.store.close();
  }
});

it.each([
  ['closed', false],
  ['merged', true],
] as const)('stops the author when the PR becomes %s', async (state, saving) => {
  const f = await fixture();
  await queueFix(f);
  const task = f.store.getTask(f.task.id);
  task.ref.provider = 'github';
  f.store.saveTask(task);
  const result = f.result();
  const runtimeResult = deferred<typeof result>();
  const commitResult = deferred<string>();
  const head = 'f'.repeat(40);
  const runtime = { run: vi.fn((_input: AgentInput) => runtimeResult.promise) };
  const workspaces = new Workspaces('/tmp');
  vi.spyOn(workspaces, 'prepare').mockResolvedValue('/tmp');
  const commit = vi
    .spyOn(workspaces, 'commitFix')
    .mockImplementation(async (_task, _message, signal) => {
      const saved = await commitResult.promise;
      signal?.throwIfAborted();
      return saved;
    });
  const worker = new Worker(f.engine, workspaces, runtime, runtime, healthy, 0);
  try {
    await worker.tick();
    await vi.waitFor(() => expect(runtime.run).toHaveBeenCalledOnce());
    if (saving) {
      runtimeResult.resolve(result);
      await vi.waitFor(() => expect(commit).toHaveBeenCalledOnce());
    }
    f.store.setSetting('demo-pr:1', { ...task.pr!, state });
    await f.engine.reconcile(task.id);
    expect(runtime.run.mock.calls[0][0].signal.aborted).toBe(true);
    expect(f.store.getTask(task.id)).toMatchObject({
      state: 'needs_input',
      reason: `PR is ${state}; automatic work stopped`,
    });
    runtimeResult.resolve(result);
    commitResult.resolve(head);
    await vi.waitFor(() => {
      const events = f.store.events(task.id);
      expect(events.at(-1)?.type).toBe('job.cancelled');
      expect(
        events.filter((event) => event.type === 'author.fixes_saved').map((event) => event.data),
      ).toEqual(saving ? [{ head, revision: task.revision }] : []);
    });
    expect(f.store.getTask(task.id).state).toBe('needs_input');
    expect(f.store.getTask(task.id).pendingAuthorHead).toBeUndefined();
    expect(commit).toHaveBeenCalledTimes(saving ? 1 : 0);
  } finally {
    runtimeResult.resolve(result);
    commitResult.resolve(head);
    await worker.stop();
    f.store.close();
  }
});

it.each([false, true])(
  'bounds the confirmation wait across restart and Resume (already sent: %s)',
  async (alreadySent) => {
    const f = await fixture();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const task = f.store.getTask(f.task.id);
      const head = 'f'.repeat(40);
      task.state = 'awaiting_push';
      task.pendingAuthorHead = head;
      task.pendingAuthorFix = {
        generation: task.generation,
        revision: task.revision!,
        sent: alreadySent,
      };
      f.store.saveTask(task);
      // The push succeeded, but getPR still observes the old head.
      const push = vi.fn(async () => {});
      const start = Date.now();
      await f.engine.submitSavedFix(task.id, async () => push);
      const restarted = new Engine(f.store, () => f.provider);
      vi.setSystemTime(start + 30_000);
      await restarted.action(task.id, 'pause');
      await restarted.action(task.id, 'resume');
      await restarted.submitSavedFix(task.id, async () => push);
      expect(f.store.getTask(task.id).state).toBe('awaiting_push');

      vi.setSystemTime(start + 61_000);
      await restarted.submitSavedFix(task.id, async () => push);
      const blocked = f.store.getTask(task.id);
      expect(blocked).toMatchObject({ state: 'needs_input', pendingAuthorHead: head });
      expect(blocked.reason).toContain(head);
      expect(blocked.reason).toContain(task.revision!.head);
      await restarted.action(task.id, 'resume');
      await restarted.submitSavedFix(task.id, async () => push);
      expect(f.store.getTask(task.id).state).toBe('needs_input');
      expect(push).toHaveBeenCalledTimes(alreadySent ? 0 : 1);
      expect(f.store.jobs(task.id)).toHaveLength(0);

      f.store.setSetting('demo-pr:1', { ...task.pr!, head });
      await restarted.action(task.id, 'resume');
      await restarted.submitSavedFix(task.id, async () => push);
      expect(await restarted.review(task.id)).toMatchObject({
        state: 'reviewing',
        revision: { head },
      });
      expect(push).toHaveBeenCalledTimes(alreadySent ? 0 : 1);
    } finally {
      vi.useRealTimers();
      f.store.close();
    }
  },
);

it.each(['reverted', 'accepted'] as const)(
  'reconciles a %s push after a crash before its result was recorded',
  async (remoteResult) => {
    const f = await fixture();
    const crashState = new Store(':memory:');
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const task = f.store.getTask(f.task.id);
      const head = 'f'.repeat(40);
      task.state = 'awaiting_push';
      task.pendingAuthorHead = head;
      task.pendingAuthorFix = { generation: task.generation, revision: task.revision! };
      f.store.saveTask(task);
      const start = Date.now();
      await f.engine.submitSavedFix(task.id, async () => async () => {
        f.store.setSetting('demo-pr:1', { ...task.pr!, head });
        // Preserve what the restarted service sees after the push but before its result write.
        crashState.saveTask(f.store.getTask(task.id));
      });
      const pending = crashState.getTask(task.id).pendingAuthorFix;
      expect(pending).toMatchObject({ pushStarted: true, confirmUntil: start + 60_000 });
      expect(pending?.sent).toBeUndefined();
      const restarted = new Engine(crashState, () => f.provider);
      if (remoteResult === 'reverted') f.store.setSetting('demo-pr:1', task.pr);
      const push = vi.fn(async () => {
        f.store.setSetting('demo-pr:1', { ...task.pr!, head });
      });
      await restarted.submitSavedFix(task.id, async () => push);
      expect(push).not.toHaveBeenCalled();
      if (remoteResult === 'accepted') {
        expect(crashState.getTask(task.id)).toMatchObject({ state: 'queued', revision: { head } });
        expect(
          crashState.events(task.id).find((event) => event.type === 'author.submitted')?.data,
        ).toEqual({ head, pushed: false });
      } else {
        expect(crashState.getTask(task.id).state).toBe('awaiting_push');
        vi.setSystemTime(start + 61_000);
        await restarted.submitSavedFix(task.id, async () => push);
        const blocked = crashState.getTask(task.id);
        expect(blocked.state).toBe('needs_input');
        expect(blocked.reason).toContain(head);
        expect(blocked.reason).toContain(task.revision!.head);
        expect(crashState.jobs(task.id)).toHaveLength(0);
        expect(push).not.toHaveBeenCalled();
      }
    } finally {
      vi.useRealTimers();
      crashState.close();
      f.store.close();
    }
  },
);

it('blocks a sent fix when provider errors outlast the confirmation deadline', async () => {
  const f = await fixture();
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    const task = f.store.getTask(f.task.id);
    const head = 'f'.repeat(40);
    task.state = 'awaiting_push';
    task.pendingAuthorHead = head;
    task.pendingAuthorFix = { generation: task.generation, revision: task.revision! };
    f.store.saveTask(task);
    const push = vi.fn(async () => {});
    vi.spyOn(f.provider, 'getPR')
      .mockResolvedValueOnce(task.pr!)
      .mockResolvedValueOnce(task.pr!)
      .mockRejectedValue(new Error('Provider unavailable'));
    const check = () => f.engine.submitSavedFix(task.id, async () => push);
    const start = Date.now();
    await expect(check()).rejects.toThrow('Provider unavailable');
    expect(f.store.getTask(task.id).state).toBe('awaiting_push');
    vi.setSystemTime(start + 30_000);
    await expect(check()).rejects.toThrow('Provider unavailable');
    expect(f.store.getTask(task.id).state).toBe('awaiting_push');
    vi.setSystemTime(start + 61_000);
    await check();
    const blocked = f.store.getTask(task.id);
    expect(blocked).toMatchObject({ state: 'needs_input', pendingAuthorHead: head });
    expect(blocked.reason).toContain(head);
    expect(blocked.reason).toContain('Provider unavailable');
    expect(push).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
    f.store.close();
  }
});

it('holds agent execution when resource thresholds are exceeded', async () => {
  const f = await fixture(),
    runtime = { run: vi.fn() };
  const worker = new Worker(
    f.engine,
    new Workspaces('/tmp'),
    runtime,
    runtime,
    () => ({ ...healthy(), ok: false, reasons: ['Low RAM'] }),
    0,
  );
  try {
    await worker.tick();
    expect(runtime.run).not.toHaveBeenCalled();
    expect(f.store.jobs()[0].status).toBe('queued');
  } finally {
    await worker.stop();
    f.store.close();
  }
});

it('does not overwrite a human pause when workspace preparation finishes late', async () => {
  const f = await fixture();
  const task = f.store.getTask(f.task.id);
  task.ref.provider = 'github';
  f.store.saveTask(task);
  const workspaces = new Workspaces('/tmp');
  let finish!: (value: string) => void;
  const pending = new Promise<string>((resolve) => {
    finish = resolve;
  });
  const prepare = vi.spyOn(workspaces, 'prepare').mockImplementation(async (task) => {
    task.reviewerWorktree = '/tmp/late-worktree';
    return pending;
  });
  const runtime = { run: vi.fn() };
  const worker = new Worker(f.engine, workspaces, runtime, runtime, healthy, 0);
  try {
    await worker.tick();
    await vi.waitFor(() => expect(prepare).toHaveBeenCalled());
    await f.engine.action(task.id, 'pause');
    const generation = f.store.getTask(task.id).generation;
    finish('/tmp');
    await vi.waitFor(() => expect(f.store.jobs().some((j) => j.status === 'running')).toBe(false));
    expect(f.store.getTask(task.id).state).toBe('paused');
    expect(f.store.getTask(task.id).generation).toBe(generation);
    expect(runtime.run).not.toHaveBeenCalled();
  } finally {
    finish('/tmp');
    await worker.stop();
    f.store.close();
  }
});

it('emits an attention milestone when a native review cannot start', async () => {
  const f = await fixture(),
    runtime = { run: vi.fn() };
  vi.spyOn(f.engine, 'review').mockRejectedValue(new Error('Native account needs reconnection'));
  const worker = new Worker(f.engine, new Workspaces('/tmp'), runtime, runtime, healthy, 0);
  try {
    await worker.tick();
    expect(f.store.getTask(f.task.id).state).toBe('needs_input');
    expect(
      f.store
        .events(f.task.id)
        .some(
          (event) =>
            event.type === 'task.state' &&
            (event.data as { state: string }).state === 'needs_input',
        ),
    ).toBe(true);
    expect(runtime.run).not.toHaveBeenCalled();
  } finally {
    await worker.stop();
    f.store.close();
  }
});

it('finishes the saved result after a throttled verification read without restarting the agent', async () => {
  const f = await fixture(),
    runtime = new DemoRuntime();
  const taskIds = [f.task.id];
  let firstStart: string | undefined;
  const agent = vi.spyOn(runtime, 'run').mockImplementation(async () => {
    firstStart = f.store.jobs(f.task.id)[0]?.startedAt;
    expect(firstStart).toBeDefined();
    expect(f.store.firstTaskStarts(taskIds).get(f.task.id)).toBe(firstStart);
    vi.spyOn(f.provider, 'getPR').mockRejectedValueOnce(new GitHubQuotaError(Date.now() + 60_000));
    return f.result();
  });
  const worker = new Worker(f.engine, new Workspaces('/tmp'), runtime, runtime, healthy, 0);
  try {
    expect(f.store.firstTaskStarts(taskIds).size).toBe(0);
    await worker.tick();
    await vi.waitFor(() =>
      expect(f.store.jobs()[0]).toMatchObject({
        status: 'queued',
        deferredResult: { status: 'completed' },
      }),
    );
    const job = f.store.jobs()[0];
    expect(job.firstStartedAt).toBe(firstStart);
    expect(f.store.firstTaskStarts(taskIds).get(f.task.id)).toBe(firstStart);
    f.store.saveJob({ ...job, notBefore: undefined });
    await worker.tick();
    await vi.waitFor(() => expect(f.store.getTask(f.task.id).state).toBe('awaiting_publication'));
    expect(agent).toHaveBeenCalledTimes(1);
    expect(f.store.jobs()[0].startedAt! > firstStart!).toBe(true);
    expect(f.store.firstTaskStarts(taskIds).get(f.task.id)).toBe(firstStart);
    expect(f.store.messages(f.task.id)).toHaveLength(1);
  } finally {
    await worker.stop();
    f.store.close();
  }
});

it('blocks starting and completing merge verification while the legacy fix is still absent', async () => {
  const f = await fixture();
  try {
    const { task, saved } = await recordLegacyLostFix(f);
    const pr = { ...task.pr!, state: 'merged' as const, mergeCommit: 'merged-old-head' };
    f.store.saveTask({ ...task, pr, state: 'needs_input' });
    f.store.setSetting('demo-pr:1', pr);
    expect(await f.engine.action(task.id, 'verify-merge')).toMatchObject({ state: 'needs_input' });
    expect(f.store.activeJobs(task.id)).toHaveLength(0);
    const stale = f.store.getTask(task.id);
    f.store.enqueue(stale, 'reviewer', 'verify_merge', 'Check an older merge');
    const job = f.store.claim()!;
    await f.engine.completeJob(job, f.result());
    const held = f.store.getTask(task.id);
    expect(held.state).toBe('needs_input');
    for (const sha of [saved, pr.head]) expect(held.reason).toContain(sha);
    expect(held.verifiedMerge).toBeUndefined();
  } finally {
    f.store.close();
  }
});

it('requires verification on the merged result instead of accepting verification from another target', async () => {
  const f = await fixture();
  try {
    const checked = await f.engine.review(f.task.id);
    f.store.cancelJobs(checked.id);
    const ref = prRef(checked);
    const oldPr = checked.pr!;
    const pr = {
      ...oldPr,
      state: 'merged' as const,
      base: 'c'.repeat(40),
      targetBranch: 'release',
      mergeCommit: 'merged-head',
    };
    const snapshot = {
      status: 'published' as const,
      url: ref.url,
      body: '',
      revision: checked.revision!,
      comments: [{ id: 'R1', url: ref.url, body: 'Verify the saved fix' }],
    };
    f.store.decision(checked, { commentId: 'R1', outcome: 'verified', reason: 'Verified on main' });
    f.store.saveTask({ ...checked, feedback: snapshot, state: 'needs_input' });
    f.store.setSetting('demo-pr:1', pr);
    await f.engine.action(checked.id, 'verify-merge');
    const job = f.store.claim()!;
    expect(job.kind).toBe('verify_merge');
    await f.engine.completeJob(job, f.result());
    expect(f.store.getTask(checked.id).state).toBe('needs_input');
  } finally {
    f.store.close();
  }
});

it.each([false, true])(
  'only prepares a restored merge verification for the saved commit (merged fix: %s)',
  async (mergedFix) => {
    const f = await fixture();
    const workspaces = new Workspaces('/tmp');
    const prepare = vi.spyOn(workspaces, 'prepare').mockResolvedValue('/tmp');
    const runtime = { run: vi.fn(async () => f.result()) };
    const worker = new Worker(f.engine, workspaces, runtime, runtime, healthy, 0);
    try {
      const { task, saved } = await recordLegacyLostFix(f);
      const pr = {
        ...task.pr!,
        head: mergedFix ? saved : task.pr!.head,
        state: 'merged' as const,
        mergeCommit: 'merge',
      };
      const queued = {
        ...task,
        ref: { ...prRef(task), provider: 'github' as const },
        state: 'reviewing' as const,
        pr,
        revision: pr,
      };
      if (mergedFix) {
        queued.pendingAuthorHead = saved;
        queued.pendingAuthorFix = {
          revision: task.revision!,
          generation: task.generation,
        };
      }
      f.store.saveTask(queued);
      f.store.setSetting('demo-pr:1', pr);
      const job = f.store.enqueue(queued, 'reviewer', 'verify_merge', 'Verify the merged PR');
      await worker.tick();
      await vi.waitFor(() =>
        expect(f.store.jobs(task.id).find((run) => run.id === job.id)?.status).toBe(
          mergedFix ? 'completed' : 'cancelled',
        ),
      );
      expect(prepare).toHaveBeenCalledTimes(mergedFix ? 1 : 0);
      expect(runtime.run).toHaveBeenCalledTimes(mergedFix ? 1 : 0);
      if (!mergedFix) {
        const held = f.store.getTask(task.id);
        expect(held.state).toBe('needs_input');
        expect(held.reason).toContain(saved);
        expect(held.reason).toContain(pr.head);
      }
    } finally {
      await worker.stop();
      f.store.close();
    }
  },
);

it.each([
  ['advance', false],
  ['rollback', false],
  ['divergence', false],
  ['retargeted', false],
  ['unknown target', false],
  ['original base', true],
  ['confirmed base', true],
  ['advance', true],
  ['rollback', true],
  ['divergence', true],
  ['retargeted', true],
] as const)(
  'checks the saved-fix confirmation before running restored merge verification (%s, manual push: %s)',
  async (movement, manualPush) => {
    const f = await fixture();
    const workspaces = new Workspaces('/tmp');
    const prepare = vi.spyOn(workspaces, 'prepare').mockResolvedValue('/tmp');
    const runtime = { run: vi.fn(async () => f.result()) };
    const worker = new Worker(f.engine, workspaces, runtime, runtime, healthy, 0);
    try {
      const task = f.store.getTask(f.task.id);
      const original = task.revision!;
      const saved = 'f'.repeat(40);
      const base = movement === 'original base' ? original.base : 'c'.repeat(40);
      const unchanged = movement === 'original base' || movement === 'confirmed base';
      const nextBase = unchanged ? base : movement === 'rollback' ? original.base : 'e'.repeat(40);
      const author = f.store.enqueue(task, 'author', 'fix', 'Save the worker changes');
      f.store.saveJob({ ...author, status: 'completed' });
      f.store.event(task.id, 'author.fixes_saved', { head: saved, revision: original }, author.id);
      if (!manualPush) f.store.event(task.id, 'author.submitted', { head: saved, pushed: true });
      const generation = task.generation + 1;
      f.store.event(task.id, 'revision.changed', {
        revision: { head: saved, base, start: base },
        generation,
      });
      f.store.event(task.id, 'task.state', {
        state: 'queued',
        reason: 'New revision is ready for review',
        head: saved,
        generation,
      });
      const targetBranch = movement === 'retargeted' ? 'release' : task.pr!.targetBranch;
      if (movement !== 'unknown target')
        f.store.event(task.id, 'task.state', {
          state: 'needs_input',
          reason: `Saved fix ${saved} is preserved. PR is merged at ${saved} (base ${nextBase}, target ${targetBranch}); expected ${saved} (base ${base}, target ${task.pr!.targetBranch}). Inspect the target and submission outcome.`,
          generation,
          head: saved,
        });
      const pr = {
        ...task.pr!,
        head: saved,
        base: nextBase,
        start: nextBase,
        targetBranch,
        state: 'merged' as const,
        mergeCommit: 'merged-saved-fix',
      };
      const queued = {
        ...task,
        ref: { ...prRef(task), provider: 'github' as const },
        state: 'reviewing' as const,
        generation: generation + 1,
        pr,
        revision: revisionOf(pr),
        pendingAuthorHead: saved,
      };
      f.store.saveTask(queued);
      f.store.setSetting('demo-pr:1', pr);
      const targetAdvanced = vi.fn(
        async (_ref: unknown, before: string) => before === original.base || movement === 'advance',
      );
      Object.assign(f.provider, { targetAdvanced });
      const job = f.store.enqueue(queued, 'reviewer', 'verify_merge', 'Verify the merged PR');
      await worker.tick();
      const allowed = unchanged || movement === 'advance';
      await vi.waitFor(() =>
        expect(f.store.jobs(task.id).find(({ id }) => id === job.id)?.status).toBe(
          allowed ? 'completed' : 'cancelled',
        ),
      );
      expect(prepare).toHaveBeenCalledTimes(allowed ? 1 : 0);
      expect(runtime.run).toHaveBeenCalledTimes(allowed ? 1 : 0);
      if (allowed) {
        expect(f.store.getTask(task.id)).toMatchObject({ state: 'complete' });
      } else {
        expect(f.store.getTask(task.id)).toMatchObject({
          state: 'needs_input',
          pendingAuthorHead: saved,
          reason: expect.stringContaining(saved),
        });
      }
      if (unchanged || movement === 'retargeted' || movement === 'unknown target')
        expect(targetAdvanced).not.toHaveBeenCalled();
      else expect(targetAdvanced).toHaveBeenCalledWith(prRef(queued), base, nextBase);
    } finally {
      await worker.stop();
      f.store.close();
    }
  },
);

it.each(['published', 'draft', 'result after restart'] as const)(
  'recovers native review findings for an already queued merge verification (%s)',
  async (scenario) => {
    const f = await fixture();
    const workspaces = new Workspaces('/tmp');
    const prepare = vi.spyOn(workspaces, 'prepare').mockResolvedValue('/tmp');
    const task = f.store.getTask(f.task.id);
    const ref = { ...prRef(task), provider: 'github' as const };
    const saved = 'f'.repeat(40);
    const pr = { ...task.pr!, state: 'merged' as const, head: saved, mergeCommit: 'merge' };
    const queued = {
      ...task,
      ref,
      state: 'reviewing' as const,
      revision: revisionOf(pr),
      pr,
      pendingAuthorHead: saved,
      pendingAuthorFix: { revision: task.revision!, generation: task.generation },
    };
    const runtime = { run: vi.fn(async (_input: AgentInput) => f.result()) };
    const worker = new Worker(f.engine, workspaces, runtime, runtime, healthy, 0);
    try {
      const review = await f.engine.broker.ensureReview({ ...queued, round: queued.round + 1 });
      if (!review) throw new Error('Expected the earlier native review');
      const finding = await f.provider.createComment(
        ref,
        review,
        'Recovered finding',
        review.marker + ':comment:R1',
      );
      if (scenario !== 'draft') await f.provider.publish(ref, review);
      f.store.saveTask(queued);
      f.store.setSetting('demo-pr:1', pr);
      const job = f.store.enqueue(queued, 'reviewer', 'verify_merge', 'Verify the merged PR');
      if (scenario === 'result after restart')
        f.store.saveJob({ ...job, deferredResult: f.result() });
      await worker.tick();
      await vi.waitFor(() =>
        expect(f.store.jobs(task.id).find(({ id }) => id === job.id)?.status).toBe(
          scenario === 'draft' ? 'cancelled' : 'completed',
        ),
      );
      expect(prepare).toHaveBeenCalledTimes(scenario === 'published' ? 1 : 0);
      expect(runtime.run).toHaveBeenCalledTimes(scenario === 'published' ? 1 : 0);
      if (scenario === 'published')
        expect(
          runtime.run.mock.calls[0]?.[0].task.feedback?.comments.map(({ id }) => id),
        ).toContain(finding.id);
      expect(f.store.getTask(task.id)).toMatchObject({
        state: 'needs_input',
        review: { id: review.id },
        reason: expect.stringContaining(scenario === 'draft' ? 'draft notes' : 'not verified'),
      });
    } finally {
      await worker.stop();
      f.store.close();
    }
  },
);

it.each(['short', 'restart', 'live'] as const)(
  'preserves the returned fix SHA across SQLite contention (%s)',
  async (recovery) => {
    const exhausted = recovery !== 'short';
    const dir = mkdtempSync(join(tmpdir(), 'daddy-first-fix-receipt-'));
    const path = join(dir, 'state.sqlite');
    const f = await fixture({}, path);
    let store = f.store;
    const other = new DatabaseSync(path);
    const saved = 'f'.repeat(40);
    const workspaces = new Workspaces(dir);
    vi.spyOn(workspaces, 'prepare').mockResolvedValue(dir);
    const runtime = { run: vi.fn(async () => f.result()) };
    const worker = new Worker(f.engine, workspaces, runtime, runtime, healthy, 0);
    let locked = false;
    let release: ReturnType<typeof setTimeout> | undefined;
    try {
      store.db.exec('PRAGMA busy_timeout=0');
      await queueFix(f);
      const task = store.getTask(f.task.id);
      store.saveTask({ ...task, ref: { ...prRef(task), provider: 'github' } });
      vi.spyOn(workspaces, 'commitFix').mockImplementation(async () => {
        other.exec('BEGIN IMMEDIATE');
        locked = true;
        return saved;
      });
      const record = store.event.bind(store);
      let failedWrites = 0;
      vi.spyOn(store, 'event').mockImplementation((...args) => {
        if (args[1] !== 'author.fixes_saved') return record(...args);
        try {
          return record(...args);
        } catch (error) {
          failedWrites++;
          if (exhausted) {
            if (failedWrites === 10) {
              other.exec('ROLLBACK');
              locked = false;
            }
          } else {
            release ??= setTimeout(() => {
              other.exec('ROLLBACK');
              locked = false;
            }, 10);
          }
          throw error;
        }
      });
      await worker.tick();
      if (exhausted) {
        await vi.waitFor(() => expect(failedWrites).toBe(10));
        expect(
          store.events(task.id).filter(({ type }) => type === 'author.fixes_saved'),
        ).toHaveLength(0);
      } else {
        await vi.waitFor(() =>
          expect(store.getTask(task.id)).toMatchObject({
            state: 'awaiting_push',
            pendingAuthorHead: saved,
          }),
        );
        expect(failedWrites).toBeGreaterThan(0);
        expect(
          store.events(task.id).filter(({ type }) => type === 'author.fixes_saved'),
        ).toHaveLength(1);
      }
      if (recovery === 'live') {
        await new Promise((resolve) => setTimeout(resolve, 5));
        await worker.tick();
        expect(store.getTask(task.id)).toMatchObject({
          state: 'needs_input',
          reason: expect.stringContaining(saved),
        });
        await expect(f.engine.review(task.id, true)).rejects.toMatchObject({
          code: 'fix_pending',
          message: expect.stringContaining(saved),
        });
        expect(store.activeJobs(task.id)).toHaveLength(0);
        return;
      }
      await worker.stop();
      store.close();
      store = new Store(path);
      const restarted = new Engine(store, () => new DemoProvider(store));
      if (exhausted) {
        restarted.recoverInterruptedJobs();
        expect(store.getTask(task.id).reason).toContain(saved);
        expect(
          store.events(task.id).filter(({ type }) => type === 'author.fixes_saved'),
        ).toHaveLength(1);
      }
      await expect(restarted.review(task.id, true)).rejects.toMatchObject({
        code: 'fix_pending',
        message: expect.stringContaining(saved),
      });
      expect(store.getTask(task.id).revision).toEqual(task.revision);
      expect(store.activeJobs(task.id)).toHaveLength(0);
    } finally {
      if (release) clearTimeout(release);
      if (locked) other.exec('ROLLBACK');
      await worker.stop();
      other.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

it.each(['SQLite available', 'both writes fail'] as const)(
  'recovers a fix when the receipt file cannot be written (%s)',
  async (scenario) => {
    const dir = mkdtempSync(join(tmpdir(), 'daddy-receipt-file-failure-'));
    const path = join(dir, 'state.sqlite');
    const f = await fixture({}, path);
    let store = f.store;
    let engine = f.engine;
    const other = new DatabaseSync(path);
    const saved = 'f'.repeat(40);
    const workspaces = new Workspaces(dir);
    vi.spyOn(workspaces, 'prepare').mockResolvedValue(dir);
    const inspect = vi.spyOn(workspaces, 'inspectSavedFixHead').mockResolvedValue(saved);
    const runtime = { run: vi.fn(async () => f.result()) };
    const worker = new Worker(f.engine, workspaces, runtime, runtime, healthy, 0);
    let locked = false;
    try {
      // A non-directory at this path reliably refuses the file write, even when run as root.
      writeFileSync(path + '.saved-fixes', '');
      store.db.exec('PRAGMA busy_timeout=0');
      await queueFix(f);
      const task = store.getTask(f.task.id);
      store.saveTask({ ...task, ref: { ...prRef(task), provider: 'github' } });
      vi.spyOn(workspaces, 'commitFix').mockImplementation(async () => {
        if (scenario === 'both writes fail') {
          other.exec('BEGIN IMMEDIATE');
          locked = true;
        }
        return saved;
      });
      const record = store.event.bind(f.store);
      let failedWrites = 0;
      vi.spyOn(f.store, 'event').mockImplementation((...args) => {
        if (args[1] !== 'author.fixes_saved') return record(...args);
        try {
          return record(...args);
        } catch (error) {
          if (++failedWrites === 10) {
            other.exec('ROLLBACK');
            locked = false;
          }
          throw error;
        }
      });
      await worker.tick();
      if (scenario === 'both writes fail') {
        await vi.waitFor(() => expect(failedWrites).toBe(10));
        expect(store.pendingFixSaves(task.id)).toHaveLength(1);
        // Restore the receipt directory path before opening a new Engine on the same database.
        rmSync(path + '.saved-fixes');
        await worker.stop();
        store.close();
        store = new Store(path);
        engine = new Engine(store, () => new DemoProvider(store));
        const recovery = new Worker(engine, workspaces, runtime, runtime, healthy, 0);
        try {
          engine.recoverInterruptedJobs();
          await expect(engine.review(task.id, true)).rejects.toMatchObject({
            code: 'fix_pending',
            message: expect.stringContaining('worker copy must be checked'),
          });
          await recovery.tick();
          expect(inspect).toHaveBeenCalledOnce();
          expect(store.getTask(task.id)).toMatchObject({
            state: 'needs_input',
            reason: expect.stringContaining(saved),
          });
        } finally {
          await recovery.stop();
        }
      } else {
        await vi.waitFor(() =>
          expect(store.getTask(task.id)).toMatchObject({
            state: 'awaiting_push',
            pendingAuthorHead: saved,
          }),
        );
        expect(inspect).not.toHaveBeenCalled();
      }
      expect(
        store.events(task.id).filter(({ type }) => type === 'author.fixes_saved'),
      ).toHaveLength(1);
      store.restoreSavedFixReceipts(task.id);
      await expect(engine.review(task.id, true)).rejects.toMatchObject({
        code: 'fix_pending',
        message: expect.stringContaining(saved),
      });
      expect(store.activeJobs(task.id)).toHaveLength(0);
    } finally {
      if (locked) other.exec('ROLLBACK');
      await worker.stop();
      other.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

it.each(['job write', 'event write'] as const)(
  'retries a blocked job outcome without keeping the worker active (%s)',
  async (point) => {
    const dir = mkdtempSync(join(tmpdir(), 'daddy-worker-outcome-'));
    const path = join(dir, 'state.sqlite');
    const f = await fixture({}, path);
    const other = new DatabaseSync(path);
    const workspaces = new Workspaces(dir);
    const saved = 'f'.repeat(40);
    vi.spyOn(workspaces, 'prepare').mockResolvedValue(dir);
    vi.spyOn(workspaces, 'commitFix').mockResolvedValue(saved);
    const runtime = { run: vi.fn(async () => f.result()) };
    const worker = new Worker(f.engine, workspaces, runtime, runtime, healthy, 0);
    let locked = false;
    try {
      f.store.db.exec('PRAGMA busy_timeout=0');
      await queueFix(f);
      const task = f.store.getTask(f.task.id);
      f.store.saveTask({ ...task, ref: { ...prRef(task), provider: 'github' } });
      const job = f.store.activeJobs(task.id)[0];
      let attempts = 0;
      if (point === 'job write') {
        const complete = f.engine.completeJob.bind(f.engine);
        vi.spyOn(f.engine, 'completeJob').mockImplementationOnce(async (...args) => {
          await complete(...args);
          other.exec('BEGIN IMMEDIATE');
          locked = true;
        });
        const transaction = f.store.transaction.bind(f.store);
        vi.spyOn(f.store, 'transaction').mockImplementation((fn) => {
          if (locked) attempts++;
          return transaction(fn);
        });
      } else {
        const event = f.store.event.bind(f.store);
        vi.spyOn(f.store, 'event').mockImplementation((...args) => {
          if (args[1] === 'job.completed' && attempts++ === 0)
            throw Object.assign(new Error('database is locked'), { errcode: 5 });
          return event(...args);
        });
      }
      await worker.tick();
      await vi.waitFor(() => expect(attempts).toBeGreaterThan(0));
      expect(f.store.jobs(task.id).find(({ id }) => id === job.id)?.status).toBe('running');
      if (locked) {
        other.exec('ROLLBACK');
        locked = false;
      }
      await worker.tick();
      expect(f.store.activeJobs(task.id)).toHaveLength(0);
      expect(f.store.jobs(task.id).find(({ id }) => id === job.id)?.status).toBe('completed');
      expect(
        f.store
          .events(task.id)
          .filter(({ type, runId }) => type === 'job.completed' && runId === job.id),
      ).toHaveLength(1);
      expect(f.store.getTask(task.id)).toMatchObject({
        state: 'awaiting_push',
        pendingAuthorHead: saved,
      });
      await expect(f.engine.review(task.id, true)).rejects.toMatchObject({ code: 'fix_pending' });
    } finally {
      if (locked) other.exec('ROLLBACK');
      await worker.stop();
      other.close();
      f.store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

it.skipIf(process.getuid?.() === 0).each([true, false])(
  'starts with an unreadable receipt directory (journaled fix: %s)',
  async (journaled) => {
    const dir = mkdtempSync(join(tmpdir(), 'daddy-unreadable-fix-receipts-'));
    const path = join(dir, 'state.sqlite');
    const receipts = path + '.saved-fixes';
    const f = await fixture({ state: 'fixing' }, path);
    const saved = 'f'.repeat(40);
    const workspaces = new Workspaces(dir);
    const inspect = vi.spyOn(workspaces, 'inspectSavedFixHead').mockResolvedValue(saved);
    const runtime = { run: vi.fn() };
    const worker = new Worker(f.engine, workspaces, runtime, runtime, healthy, 0);
    try {
      const task = f.store.getTask(f.task.id);
      f.store.enqueue(task, 'author', 'fix', 'Save the fix');
      const job = f.store.claim()!;
      if (!journaled) {
        job.fixSaveRevision = task.revision;
        f.store.saveJob(job);
        f.store.stageSavedFixReceipt(job, { head: saved, revision: task.revision! });
      }
      mkdirSync(receipts, { mode: 0o700, recursive: true });
      chmodSync(receipts, 0);
      if (journaled) await f.engine.recordSavedFix(job, { head: saved, revision: task.revision! });
      f.engine.recoverInterruptedJobs();
      await expect(f.engine.review(task.id, true)).rejects.toMatchObject({
        code: 'fix_pending',
        message: expect.stringContaining(journaled ? saved : 'worker copy must be checked'),
      });
      await worker.tick();
      expect(inspect).not.toHaveBeenCalled();
      if (!journaled) {
        expect(f.store.pendingFixSaves(task.id)).toHaveLength(1);
        await expect(f.engine.review(task.id, true)).rejects.toMatchObject({ code: 'fix_pending' });
        chmodSync(receipts, 0o700);
        await worker.tick();
        expect(inspect).not.toHaveBeenCalled();
      }
      expect(f.store.getTask(task.id)).toMatchObject({
        state: 'needs_input',
        reason: expect.stringContaining(saved),
      });
      expect(f.store.activeJobs(task.id)).toHaveLength(0);
      expect(runtime.run).not.toHaveBeenCalled();
    } finally {
      chmodSync(receipts, 0o700);
      await worker.stop();
      f.store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

it('resumes the author in the same Git copy after a definite pre-commit rejection', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'daddy-precommit-rejection-'));
  const f = await fixture();
  const workspaces = new Workspaces(dir);
  const repo = join(dir, 'source');
  const runtime = { run: vi.fn(async (_input: AgentInput) => f.result()) };
  const worker = new Worker(f.engine, workspaces, runtime, runtime, healthy, 0);
  try {
    mkdirSync(repo);
    await git(['init', '-b', 'main'], repo);
    writeFileSync(join(repo, 'tracked'), 'original\n');
    await git(['add', 'tracked'], repo);
    await git(
      ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@local', 'commit', '-m', 'initial'],
      repo,
    );
    const head = await git(['rev-parse', 'HEAD'], repo);
    const task = f.store.getTask(f.task.id);
    const revision = { head, base: head, start: head };
    const pr = { ...task.pr!, ...revision };
    f.store.saveTask({ ...task, repoPath: repo, pr, revision });
    f.store.setSetting('demo-pr:1', pr);
    await queueFix(f);
    const current = f.store.getTask(task.id);
    f.store.saveTask({ ...current, ref: { ...prRef(current), provider: 'github' } });
    let copy: string | undefined;
    runtime.run.mockImplementationOnce(async (input) => {
      copy = input.cwd;
      writeFileSync(join(copy, 'tracked'), 'saved edit  \n');
      return f.result();
    });
    await worker.tick();
    await vi.waitFor(() => {
      expect(f.store.activeJobs(task.id)).toHaveLength(0);
      expect(f.store.getTask(task.id).state).toBe('needs_input');
    });
    expect(f.store.pendingFixSaves(task.id)).toMatchObject([
      { errorCode: 'fix_precommit_rejected' },
    ]);
    expect(await git(['rev-parse', 'HEAD'], copy!)).toBe(head);
    expect(readFileSync(join(copy!, 'tracked'), 'utf8')).toBe('saved edit  \n');
    await expect(f.engine.review(task.id, true)).rejects.toMatchObject({ code: 'fix_pending' });

    await f.engine.action(task.id, 'resume');
    expect(f.store.activeJobs(task.id)).toMatchObject([{ kind: 'fix', role: 'author' }]);
    runtime.run.mockImplementationOnce(async (input) => {
      expect(input.cwd).toBe(copy);
      expect(readFileSync(join(input.cwd, 'tracked'), 'utf8')).toBe('saved edit  \n');
      writeFileSync(join(input.cwd, 'tracked'), 'saved edit\n');
      return f.result();
    });
    await worker.tick();
    await vi.waitFor(() => {
      expect(f.store.activeJobs(task.id)).toHaveLength(0);
      expect(f.store.getTask(task.id)).toMatchObject({ state: 'awaiting_push' });
    });
    expect(f.store.getTask(task.id).pendingAuthorHead).toBe(
      await git(['rev-parse', 'HEAD'], copy!),
    );
    await expect(f.engine.review(task.id, true)).rejects.toMatchObject({ code: 'fix_pending' });
  } finally {
    await worker.stop();
    f.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it.each(['review', 'publication'] as const)(
  'keeps a competing %s transition and its queued job',
  async (step) => {
    const f = await fixture({ state: 'queued' });
    const runtime = new DemoRuntime();
    const worker = new Worker(f.engine, new Workspaces('/tmp'), runtime, runtime, healthy, 60000);
    try {
      if (step === 'review') {
        const start = f.engine.review.bind(f.engine);
        vi.spyOn(f.engine, 'review').mockImplementationOnce(async (id) => {
          await start(id);
          return start(id);
        });
      } else {
        await f.engine.review(f.task.id);
        await f.engine.broker.call(f.job(), 'add_comment', {
          key: 'needed',
          body: 'A real regression',
        });
        await f.run();
        const publish = f.engine.publish.bind(f.engine);
        vi.spyOn(f.engine, 'publish').mockImplementationOnce(async (id) => {
          await publish(id);
          return publish(id);
        });
      }
      vi.spyOn(f.store, 'claim').mockReturnValue(undefined);
      await worker.tick();
      expect(f.store.getTask(f.task.id).state).toBe(step === 'review' ? 'reviewing' : 'fixing');
      expect(f.store.activeJobs(f.task.id)).toMatchObject([
        { kind: step === 'review' ? 'review' : 'fix', status: 'queued' },
      ]);
    } finally {
      await worker.stop();
      f.store.close();
    }
  },
);

it.each([true, false])(
  'only repeats a review when a native tool operation remains unconfirmed (same retry: %s)',
  async (same) => {
    const f = await fixture({ state: 'queued' }),
      runtime = new DemoRuntime();
    const worker = new Worker(f.engine, new Workspaces('/tmp'), runtime, runtime, healthy, 0);
    const run = vi.spyOn(runtime, 'run').mockImplementation(async (input) => {
      const error = new GitHubQuotaError(Date.now() + 30000);
      const call = vi.spyOn(f.engine.broker, 'call');
      call.mockRejectedValueOnce(error);
      await expect(
        input.onTool('add_comment', { key: 'R1', body: 'First finding' }, 'first'),
      ).rejects.toBe(error);
      // This unrelated successful read does not confirm a write.
      await input.onTool('read_review', {}, 'read');
      await input.onTool(
        'add_comment',
        same ? { body: 'First finding', key: 'R1' } : { key: 'R2', body: 'Second finding' },
        'retry',
      );
      return f.result();
    });
    try {
      await worker.tick();
      await vi.waitFor(() => expect(f.store.jobs(f.task.id).at(-1)?.finishedAt).toBeDefined());
      expect(run).toHaveBeenCalledOnce();
      const job = f.store.jobs(f.task.id).at(-1)!;
      expect(job.status).toBe(same ? 'completed' : 'queued');
      if (same) expect(f.store.getTask(f.task.id).state).toBe('awaiting_publication');
      else expect(job.notBefore).toBeDefined();
    } finally {
      await worker.stop();
      f.store.close();
    }
  },
);

it('retries the failed task transition together with the outcome when SQLite is busy', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'daddy-locked-outcome-')),
    path = join(dir, 'state.sqlite');
  const f = await fixture({}, path),
    lock = new DatabaseSync(path),
    ws = new Workspaces(dir);
  const runtime = { run: vi.fn(async () => f.result()) };
  const worker = new Worker(f.engine, ws, runtime, runtime, healthy, 0);
  let locked = false;
  try {
    await queueFix(f);
    const t = f.store.getTask(f.task.id);
    f.store.saveTask({ ...t, ref: { ...prRef(t), provider: 'github' } });
    f.store.db.exec('PRAGMA busy_timeout=0');
    vi.spyOn(ws, 'prepare').mockResolvedValue(dir);
    vi.spyOn(ws, 'commitFix').mockImplementationOnce(async () => {
      lock.exec('BEGIN IMMEDIATE');
      locked = true;
      throw new AppError('fix_precommit_rejected', 'Index is locked');
    });
    const job = f.store.claim()!;
    await worker['run'](job);
    lock.exec('ROLLBACK');
    locked = false;
    await worker.tick();
    expect(f.store.getTask(t.id)).toMatchObject({ state: 'needs_input', resumeState: 'fixing' });
    expect(f.store.jobs(t.id).find((j) => j.id === job.id)).toMatchObject({
      status: 'failed',
      errorCode: 'fix_precommit_rejected',
    });
    expect((await f.engine.action(t.id, 'resume')).state).toBe('fixing');
    expect(f.store.activeJobs(t.id)).toHaveLength(1);
  } finally {
    if (locked) lock.exec('ROLLBACK');
    await worker.stop();
    lock.close();
    f.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it.each(['deleted', 'edited', 'unchanged'] as const)(
  'presents the current published feedback after preparing a merged checkout (%s)',
  async (change) => {
    const f = await fixture(),
      task = f.store.getTask(f.task.id);
    const ref = { ...prRef(task), provider: 'github' as const },
      head = 'f'.repeat(40);
    const pr = { ...task.pr!, state: 'merged' as const, head, mergeCommit: 'merge' };
    const queued = {
      ...task,
      ref,
      state: 'reviewing' as const,
      revision: revisionOf(pr),
      pr,
      pendingAuthorHead: head,
      pendingAuthorFix: { revision: task.revision!, generation: task.generation },
    };
    const ws = new Workspaces('/tmp'),
      runtime = { run: vi.fn(async (_input: AgentInput) => f.result()) };
    const worker = new Worker(f.engine, ws, runtime, runtime, healthy, 0);
    try {
      const handle = await f.engine.broker.ensureReview({ ...queued, round: queued.round + 1 });
      if (!handle) throw new Error('Fixture failed to create the native review');
      const finding = await f.provider.createComment(
        ref,
        handle,
        'Original finding',
        handle.marker + ':comment:R',
      );
      await f.provider.publish(ref, handle);
      f.store.saveTask(queued);
      f.store.setSetting('demo-pr:1', pr);
      vi.spyOn(ws, 'prepare').mockImplementation(async () => {
        if (change === 'deleted') await f.provider.deleteComment(ref, handle, finding.id);
        if (change === 'edited')
          await f.provider.updateComment(ref, handle, finding.id, 'Updated finding');
        return '/tmp';
      });
      f.store.enqueue(queued, 'reviewer', 'verify_merge', 'Verify the merged task');
      await worker.tick();
      await vi.waitFor(() => expect(runtime.run).toHaveBeenCalled());
      const shown = runtime.run.mock.calls[0][0].task.feedback?.comments ?? [];
      expect(shown.map((c) => c.body.split('\n')[0])).toEqual(
        change === 'deleted' ? [] : [change === 'edited' ? 'Updated finding' : 'Original finding'],
      );
    } finally {
      await worker.stop();
      f.store.close();
    }
  },
);
