import { expect, it } from 'vitest';
import { daddyFixture } from './daddy-fixture.js';

it('restores the session-owned tasks and their attempts once, including a running review', async () => {
  const f = daddyFixture();
  try {
    const group = f.daddy.create({ workspaceId: f.workspace.id });
    const active = await f.daddy.createTask(group.id, {
      requirements: 'Implement',
      requestId: 'active',
    });
    const manual = await f.daddy.createTask(group.id, {
      requirements: 'Separate pause',
      requestId: 'manual',
    });
    await f.engine.action(manual.id, 'pause', 'Waiting for upstream');
    const wait = await f.daddy.createTask(group.id, {
      requirements: 'Check after CI',
      requestId: 'ci',
    });
    f.store.cancelJobs(wait.id);
    f.store.saveTask({ ...wait, state: 'awaiting_checks', reason: 'Checking CI' });
    const first = f.store.claim()!;
    expect(first.taskId).toBe(active.id);
    const review = f.store.enqueue(
      active,
      'reviewer',
      'chat',
      'Retain this follow-up',
      'review-action',
    );
    f.daddy.chat(group.id, 'Save this user request');
    const queued = f.store.daddyJobs(group.id)[0];
    await f.daddy.pause(group.id);
    const generation = f.store.getGroup(group.id).generation;
    await f.daddy.pause(group.id);
    expect(f.store.getGroup(group.id).generation).toBe(generation);
    expect(f.store.activeJobs()).toHaveLength(0);
    expect(f.store.getTask(active.id).state).toBe('paused');
    f.engine.recoverInterruptedJobs();
    await f.daddy.resume(group.id);
    await f.daddy.resume(group.id);
    expect(f.store.getTask(active.id)).toMatchObject({
      state: 'implementing',
      reason: active.reason,
    });
    expect(f.store.getTask(wait.id)).toMatchObject({
      state: 'awaiting_checks',
      reason: 'Checking CI',
    });
    expect(f.store.getTask(manual.id)).toMatchObject({
      state: 'paused',
      reason: 'Waiting for upstream',
    });
    expect(f.store.activeJobs(active.id)).toMatchObject([
      {
        firstAttemptId: first.id,
        kind: 'implement',
        status: 'queued',
        groupGeneration: generation,
      },
      {
        firstAttemptId: review.id,
        actionId: 'review-action',
        status: 'queued',
        groupGeneration: generation,
      },
    ]);
    expect(
      f.store.daddyJobs(group.id).filter((j) => j.status === 'queued' && j.trigger === 'user'),
    ).toMatchObject([{ id: queued.id, input: 'Save this user request' }]);
  } finally {
    await f.close();
  }
});

it('recognizes an already resumed legacy session and preserves individual pauses', async () => {
  const f = daddyFixture();
  try {
    const group = f.daddy.create({ workspaceId: f.workspace.id });
    const manual = await f.daddy.createTask(group.id, {
      requirements: 'Separate',
      requestId: 'manual',
    });
    const task = await f.daddy.createTask(group.id, {
      requirements: 'Continue',
      requestId: 'legacy',
    });
    await f.engine.action(manual.id, 'pause', 'Intentional pause');
    const original = f.store.activeJobs(task.id)[0];
    await f.engine.action(task.id, 'pause');
    f.store.event(group.id, 'daddy.paused');
    f.store.event(group.id, 'daddy.resumed');
    f.daddy.start();
    expect(f.store.getTask(manual.id).state).toBe('paused');
    expect(f.store.getTask(task.id).state).toBe('implementing');
    expect(f.store.activeJobs(task.id)).toMatchObject([
      { firstAttemptId: original.id, input: original.input },
    ]);
  } finally {
    await f.close();
  }
});
