import { it, expect, vi } from 'vitest';
import { fixture } from './helpers.js';
import { Worker } from '../src/runtime/worker.js';
import { git, Workspaces } from '../src/runtime/workspaces.js';
import { DemoRuntime } from '../src/runtime/demo.js';
import { TicketWorkflow } from '../src/core/ticket-workflow.js';
import { Engine } from '../src/core/engine.js';
import { Store } from '../src/core/store.js';
import type { AgentInput } from '../src/runtime/agent.js';
import { prRef, revisionOf } from '../src/core/types.js';
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

it.each(['rolled back', 'manually reviewed', 'draft on another base'] as const)(
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
      if (rolledBack) f.store.event(task.id, 'author.submitted', { head, pushed: true });
      const pr = rolledBack ? { ...original, base: 'e'.repeat(40) } : { ...original, head };
      const revision = revisionOf(pr);
      const generation = author.generation + 1;
      f.store.event(task.id, 'revision.changed', { revision, generation });
      f.store.event(task.id, 'task.state', {
        state: 'queued',
        reason: 'New revision is ready for review',
        generation,
        head: pr.head,
      });
      const review = rolledBack
        ? undefined
        : await f.provider.createReview(
            prRef(task),
            wrongDraftBase ? { ...revision, base: 'e'.repeat(40) } : revision,
            'legacy-review-on-H2',
          );
      f.store.saveTask({
        ...task,
        pr,
        revision,
        generation,
        pendingAuthorHead: head,
        authorBaseHead: original.head,
        state: rolledBack ? 'queued' : 'awaiting_publication',
        review,
        snapshot: review && (await f.provider.getReview(prRef(task), review)),
        reviewFinished: !rolledBack,
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

it('does not repeat a legacy push while the provider still shows the old revision', async () => {
  const f = await fixture();
  try {
    await queueFix(f);
    const author = f.store.claim()!;
    const task = f.store.getTask(f.task.id);
    const head = 'f'.repeat(40);
    f.store.event(
      task.id,
      'author.feedback_snapshot',
      { ...task.feedback, targetBranch: task.pr!.targetBranch },
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
    await f.engine.submitSavedFix(task.id, prepare);
    expect(prepare).not.toHaveBeenCalled();
    expect(f.store.getTask(task.id).reason).toContain(
      `Waiting for the PR to confirm saved fix ${head}`,
    );
  } finally {
    f.store.close();
  }
});

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
        await f.run();
        const held = f.store.getTask(task.id);
        expect(held).toMatchObject({
          state: 'needs_input',
          revision: task.revision,
          pendingAuthorHead: head,
        });
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
