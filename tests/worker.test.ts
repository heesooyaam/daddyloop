import { it, expect, vi } from 'vitest';
import { fixture } from './helpers.js';
import { Worker } from '../src/runtime/worker.js';
import { git, Workspaces } from '../src/runtime/workspaces.js';
import { DemoRuntime } from '../src/runtime/demo.js';
import { TicketWorkflow } from '../src/core/ticket-workflow.js';
import { Engine } from '../src/core/engine.js';
import type { AgentInput } from '../src/runtime/agent.js';
import { prRef } from '../src/core/types.js';
import { allRepositories } from '../src/modules/repositories/index.js';
import { RepositoryRegistry } from '../src/modules/repositories/registry.js';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
  const push = vi.spyOn(workspaces, 'pushSavedFix').mockResolvedValue(undefined);
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
    const task = f.store.getTask(f.task.id);
    const pending = 'f'.repeat(40);
    task.state = 'awaiting_push';
    task.pendingAuthorHead = pending;
    task.authorBaseHead = task.revision?.head;
    Object.assign(task.policy, { autoPush: false });
    f.store.saveTask(task);
    let current = task.pr!;
    vi.spyOn(f.provider, 'getPR').mockImplementation(async () => current);
    const push = vi.spyOn(workspaces, 'pushSavedFix').mockImplementation(async () => {
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
    await f.engine.submitSavedFix(task.id, push);
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
    await f.engine.submitSavedFix(task.id, push);
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
    await f.engine.submitSavedFix(task.id, push);
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

it('continues to block review of a lost fix after pause advances the generation', async () => {
  const f = await fixture();
  try {
    await queueFix(f);
    const id = f.task.id;
    const fix = f.store.claim()!;
    const saved = 'f'.repeat(40);
    f.store.event(id, 'author.fixes_saved', { head: saved }, fix.id);
    await f.engine.completeJob(fix, f.result());
    f.store.saveJob({ ...fix, status: 'completed' });
    const task = f.store.getTask(id);
    expect(task.reason).toContain('Author made no code changes');
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
    await f.engine.submitSavedFix(id, push);
    expect(push).not.toHaveBeenCalled();
    expect(f.store.busy(id)).toBe(false);
  } finally {
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
      await f.engine.submitSavedFix(task.id, push);
      const restarted = new Engine(f.store, () => f.provider);
      vi.setSystemTime(start + 30_000);
      await restarted.action(task.id, 'pause');
      await restarted.action(task.id, 'resume');
      await restarted.submitSavedFix(task.id, push);
      expect(f.store.getTask(task.id).state).toBe('awaiting_push');

      vi.setSystemTime(start + 61_000);
      await restarted.submitSavedFix(task.id, push);
      const blocked = f.store.getTask(task.id);
      expect(blocked).toMatchObject({ state: 'needs_input', pendingAuthorHead: head });
      expect(blocked.reason).toContain(head);
      expect(blocked.reason).toContain(task.revision!.head);
      await restarted.action(task.id, 'resume');
      await restarted.submitSavedFix(task.id, push);
      expect(f.store.getTask(task.id).state).toBe('needs_input');
      expect(push).toHaveBeenCalledTimes(alreadySent ? 0 : 1);
      expect(f.store.jobs(task.id)).toHaveLength(0);

      f.store.setSetting('demo-pr:1', { ...task.pr!, head });
      await restarted.action(task.id, 'resume');
      await restarted.submitSavedFix(task.id, push);
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
