import { GitHubQuotaError } from '../src/providers/github-quota.js';
import { it, expect, vi } from 'vitest';
import { fixture } from './helpers.js';
import { Worker } from '../src/runtime/worker.js';
import { Workspaces } from '../src/runtime/workspaces.js';
import { DemoRuntime } from '../src/runtime/demo.js';
import { TicketWorkflow } from '../src/core/ticket-workflow.js';
import { daddyFixture } from './daddy-fixture.js';
const healthy = () => ({
  memoryAvailableGiB: 30,
  memoryTotalGiB: 90,
  diskAvailableGiB: 180,
  diskUsedPercent: 77,
  ok: true,
  reasons: [],
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
it('keeps explicit session submission and publication policies manual', async () => {
  const f = daddyFixture();
  try {
    const group = f.daddy.create({
      workspaceId: f.workspace.id,
      autoPush: false,
      publication: 'human',
    });
    const task = await f.tickets.local({
      workspace: f.workspace,
      groupId: group.id,
      groupGeneration: group.generation,
      title: 'Manual workflow',
      requirements: 'Wait for explicit actions',
      createdByAction: 'fixture',
    });
    expect(task.policy).toMatchObject({ autoPush: false, publication: 'human' });
    task.state = 'ready_for_review';
    task.pendingAuthorHead = task.revision!.head;
    f.store.saveTask(task);
    const submit = vi.fn(async () => task);
    f.worker.autoSubmit = submit;
    await f.worker.tick();
    expect(submit).not.toHaveBeenCalled();

    task.state = 'awaiting_publication';
    f.store.saveTask(task);
    const publish = vi.spyOn(f.engine, 'publish');
    await f.worker.tick();
    expect(publish).not.toHaveBeenCalled();
  } finally {
    await f.close();
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
  const agent = vi.spyOn(runtime, 'run').mockImplementation(async () => {
    vi.spyOn(f.provider, 'getPR').mockRejectedValueOnce(new GitHubQuotaError(Date.now() + 60_000));
    return f.result();
  });
  const worker = new Worker(f.engine, new Workspaces('/tmp'), runtime, runtime, healthy, 0);
  try {
    await worker.tick();
    await vi.waitFor(() =>
      expect(f.store.jobs()[0]).toMatchObject({
        status: 'queued',
        deferredResult: { status: 'completed' },
      }),
    );
    const job = f.store.jobs()[0];
    f.store.saveJob({ ...job, notBefore: undefined });
    await worker.tick();
    await vi.waitFor(() => expect(f.store.getTask(f.task.id).state).toBe('awaiting_publication'));
    expect(agent).toHaveBeenCalledTimes(1);
    expect(f.store.messages(f.task.id)).toHaveLength(1);
  } finally {
    await worker.stop();
    f.store.close();
  }
});
