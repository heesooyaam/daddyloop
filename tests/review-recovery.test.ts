import { expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { daddyFixture } from './daddy-fixture.js';
import { DemoProvider } from '../src/providers/demo.js';
import { taskSession } from '../src/runtime/agent.js';
import { Store } from '../src/core/store.js';
import { Engine } from '../src/core/engine.js';
import { activityStatus } from '../src/core/task-activity.js';
import { taskCard } from '../src/integrations/telegram-tasks.js';
import { taskRequestKey } from '../src/integrations/telegram-reminders.js';
import { prRef, type AgentResult, type Job } from '../src/core/types.js';
import { repeatedReviewFindings } from '../src/core/review-recovery.js';

async function scenario() {
  const f = daddyFixture(true);
  const group = f.daddy.create({ workspaceId: f.workspace.id });
  const task = await f.engine.create({
    ref: {
      provider: 'fixture',
      host: 'fixture.local',
      repo: 'test/repo',
      number: 147,
      url: 'https://fixture.local/test/repo/pull/147',
    },
    repoPath: f.dir,
    groupId: group.id,
    requirements: 'Deliver the original text through src/queue.ts to the reviewer.',
  });
  const peer = {
    ...task,
    id: 'other-task',
    title: 'Related task',
    requirements: 'The consumer in src/queue.ts expects the original text.',
  };
  f.store.saveTask(peer);
  const architect = { engine: 'codex', model: 'architect-test' };
  await f.daddy.taskArchitect(group.id, task.id, architect);
  const remote = new DemoProvider(f.store);
  const prepared = vi.spyOn(f.checkouts, 'prepare').mockImplementation(async (t, role) => {
    if (role === 'reviewer') t.reviewerWorktree = f.dir;
    else t.authorWorktree = f.dir;
    return f.dir;
  });
  const claimed = () => f.store.claim((j) => j.taskId === task.id)!;
  const finish = (job: Job) =>
    f.store.saveJob({ ...job, status: 'completed', finishedAt: new Date().toISOString() });
  const current = () => f.store.getTask(task.id);
  const review = async (key: string | undefined, text = '') => {
    await f.engine.review(task.id);
    const t = current(),
      job = claimed();
    await f.engine.broker.call(job, 'set_summary', {
      body: 'Published evidence on the pinned revision. ' + text,
    });
    if (key)
      await f.engine.broker.call(job, 'add_comment', {
        key,
        body: text,
        path: 'src/queue.ts',
        line: 10 + t.round,
      });
    await f.engine.completeJob(job, {
      status: 'completed',
      checkedHead: t.revision!.head,
      summary: text || 'Verified with the regression test',
      verifiedCommentIds: key ? [] : t.feedback?.comments.map((c) => c.id),
    });
    finish(job);
    await f.engine.publish(task.id);
  };
  const fix = async (text: string) => {
    const t = current(),
      job = claimed();
    expect(job.kind).toBe('fix');
    expect(await f.engine.admitReviewWork(job, t.snapshot!, t.pr!)).toBe(true);
    await f.engine.completeJob(
      job,
      { status: 'completed', checkedHead: t.revision!.head, summary: text },
      async () => {
        await remote.advance(prRef(t));
        return (await remote.getPR(prRef(t))).head;
      },
    );
    finish(job);
  };
  const reachArchitect = async () => {
    await review('deliver', 'First counterexample');
    await fix('First correction tested the write');
    await review('deliver', 'Changed wording on a different source line');
    await fix('Second correction tested the read');
    await review('deliver', 'The final consumer still lost the text');
  };
  return {
    f,
    group,
    task,
    peer,
    architect,
    prepared,
    remote,
    claimed,
    finish,
    current,
    review,
    fix,
    reachArchitect,
  };
}

it('replans two confirmed corrections with the task architect and returns the plan to the same worker before independent review', async () => {
  const { f, group, task, peer, architect, prepared, current, review, fix, reachArchitect } =
    await scenario();
  try {
    await reachArchitect();
    const original = current();
    expect(original.reviewRecovery?.attempts).toHaveLength(2);
    const [queued] = f.store.activeJobs(task.id);
    expect(queued).toMatchObject({ kind: 'plan', role: 'author', profile: architect });
    expect(activityStatus({ task: original, job: queued })).toBe('Waiting for the task architect');
    expect(taskCard('ru', { task: original, job: queued }).text).toContain(
      'Ждёт архитектора задачи',
    );
    // Keep the existing worker lease while the architect is reading the pinned source.
    const g = f.store.getGroup(group.id);
    g.workerSlots = [{ number: 1, taskId: task.id }];
    f.store.saveGroup(g);
    const summary =
      'Compare both consumers, preserve the input before branching, and test the received text.';
    f.agentRuntime.run.mockImplementationOnce(async (input) => {
      expect(prepared).toHaveBeenCalledWith(
        expect.objectContaining({ id: task.id }),
        'reviewer',
        expect.any(AbortSignal),
      );
      expect(input.tools).toEqual([]);
      expect(taskSession(input)).toMatchObject({
        readOnly: true,
        execution: 'sandbox',
        workspaceRoot: f.dir,
        profile: architect,
      });
      expect(input.prompt).toContain('First correction tested the write');
      expect(input.prompt).toContain('Second correction tested the read');
      expect(input.prompt).toContain('The final consumer still lost the text');
      expect(input.prompt).toContain(peer.requirements);
      for (const step of original.reviewRecovery!.attempts)
        expect(input.prompt).toContain(step.after);
      return { status: 'completed', summary, checkedHead: input.task.revision!.head };
    });
    await f.worker.tick();
    await vi.waitFor(() => expect(current().reviewRecovery?.plan).toBe(summary));
    expect(f.store.getGroup(group.id).workerSlots?.[0].taskId).toBe(task.id);
    expect(f.store.activeJobs(task.id)).toMatchObject([
      { kind: 'fix', profile: original.agents?.worker ?? f.engine.defaultAgents().worker },
    ]);
    expect(f.store.daddyJobs(group.id)).toHaveLength(0);
    const duplicate = {
      status: 'completed' as const,
      summary: 'Late duplicate',
      checkedHead: original.revision!.head,
    };
    await f.engine.completeJob(queued, duplicate);
    expect(f.store.activeJobs(task.id)).toHaveLength(1);
    await fix('The two end-to-end test cases pass.');
    expect(current().state).toBe('queued');
    await review(undefined);
    expect(current().state).toBe('complete');
  } finally {
    await f.close();
  }
});

it('preserves the architecture gate across restart, pause, a stale result and a cross-task ownership decision', async () => {
  const { f, group, task, current, claimed, finish, reachArchitect } = await scenario();
  try {
    await reachArchitect();
    const first = claimed();
    const db = new Store(join(f.dir, 'state.sqlite'));
    try {
      new Engine(db, () => new DemoProvider(db)).recoverInterruptedJobs();
    } finally {
      db.close();
    }
    expect(f.store.activeJobs(task.id)).toMatchObject([{ id: first.id, status: 'queued' }]);
    const old = claimed();
    await f.daddy.pause(group.id);
    await f.engine.completeJob(old, {
      status: 'completed',
      summary: 'Stale plan',
      checkedHead: current().revision!.head,
    });
    expect(current().reviewRecovery?.plan).toBeUndefined();
    await f.daddy.resume(group.id);
    const active = claimed();
    expect(active.kind).toBe('plan');
    const question = 'Which task owns the shared consumer, this one or other-task?';
    await f.engine.completeJob(active, {
      status: 'needs_input',
      summary: 'Needs coordination between tasks',
      question,
      checkedHead: current().revision!.head,
    });
    finish(active);
    expect(f.engine.coordinationBlocker(current())?.question).toBe(question);
    expect(taskRequestKey(f.store, current())).toBeUndefined();
    expect(current().inputRequest?.reviewDispute).toBe('daddy');
    await f.engine.chat(
      task.id,
      'author',
      'This task owns src/queue.ts. The sibling consumes it.',
      'coordination-action',
    );
    const next = claimed();
    expect(next).toMatchObject({ kind: 'plan', input: expect.stringContaining('This task owns') });
    const done: AgentResult = {
      status: 'completed',
      summary: 'New test through the shared consumer',
      checkedHead: current().revision!.head,
    };
    await f.engine.completeJob(active, done);
    expect(current().reviewRecovery?.plan).toBeUndefined();
    await f.engine.completeJob(next, done);
    finish(next);
    expect(f.store.activeJobs(task.id)).toMatchObject([{ kind: 'fix' }]);
  } finally {
    await f.close();
  }
});

it('ignores a repeated read, unrelated criteria and a revision without both confirmed fix edges', async () => {
  const { f, task, current, review, fix } = await scenario();
  try {
    await review('one', 'First');
    await fix('A');
    await review('one', 'Second');
    const t = current();
    expect(repeatedReviewFindings(f.store, t, t.snapshot!)).toBeUndefined();
    await fix('B');
    await review('other', 'Unrelated reported failure');
    expect(f.store.activeJobs(task.id)).toMatchObject([{ kind: 'fix' }]);
    const now = current(),
      one = { ...now.snapshot!, comments: t.snapshot!.comments };
    expect(repeatedReviewFindings(f.store, now, one)?.criteria).toEqual(['one']);
    f.store.db
      .prepare(
        "DELETE FROM events WHERE id=(SELECT max(id) FROM events WHERE task_id=? AND type='author.fixes_saved')",
      )
      .run(task.id);
    expect(repeatedReviewFindings(f.store, now, one)).toBeUndefined();
  } finally {
    await f.close();
  }
});

it('lets daddy settle only an architect ownership question and routes its answer back to the task architect', async () => {
  const { f, group, task, claimed, finish, current, reachArchitect } = await scenario();
  try {
    await reachArchitect();
    f.daddy.start();
    const plan = claimed();
    const decision = 'Which task owns the queue change shared with other-task?';
    await f.engine.completeJob(plan, {
      status: 'needs_input',
      question: decision,
      summary: 'Both plans change the same delivery rule.',
      checkedHead: current().revision!.head,
    });
    finish(plan);
    f.store.event(task.id, 'job.completed', { kind: 'plan' }, plan.id);
    await vi.waitFor(() =>
      expect(f.store.daddyJobs(group.id).filter((j) => j.disputeRunId === plan.id)).toHaveLength(1),
    );
    f.runtime.runSession.mockImplementationOnce(async (input) => {
      const report = (await input.onTool('read_task', { taskId: task.id }, 'inspect')) as {
        task: { blocker: { question: string } };
      };
      expect(report.task.blocker.question).toBe(decision);
      await input.onTool(
        'message_worker',
        {
          taskId: task.id,
          instruction: 'This task owns delivery. Keep the other task on its consumer.',
        },
        'coordinate',
      );
      return {
        status: 'completed',
        summary: 'Assigned the shared delivery change.',
        checkedHead: '',
      };
    });
    await f.daddy.tick();
    await vi.waitFor(() =>
      expect(f.store.activeJobs(task.id)).toMatchObject([
        { kind: 'plan', input: expect.stringContaining('owns delivery') },
      ]),
    );
    const final = claimed();
    await f.engine.completeJob(final, {
      status: 'completed',
      summary: 'Fix the first lost handoff and exercise both consumers.',
      checkedHead: current().revision!.head,
    });
    finish(final);
    f.store.event(task.id, 'job.completed', { kind: 'plan' }, final.id);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.store.daddyJobs(group.id).filter((j) => j.trigger === 'worker')).toHaveLength(1);
    expect(f.store.activeJobs(task.id)).toMatchObject([{ kind: 'fix' }]);
  } finally {
    await f.close();
  }
});

it('rejects a plan after a native edit and never treats a stale or incomplete result as a ready fix', async () => {
  const { f, task, remote, claimed, current, reachArchitect } = await scenario();
  try {
    await reachArchitect();
    const job = claimed(),
      t = current();
    await f.engine.completeJob(job, {
      status: 'completed',
      summary: 'Wrong revision',
      checkedHead: 'wrong',
    });
    expect(current()).toMatchObject({ state: 'needs_input' });
    expect(current().reviewRecovery?.plan).toBeUndefined();
    f.store.saveJob({ ...job, status: 'completed' });
    await f.engine.action(task.id, 'resume');
    const retry = claimed();
    const native = await remote.getReview(prRef(t), t.review!);
    native.comments[0].body = 'Externally edited finding';
    f.store.setSetting('demo-review:' + t.review!.id, native);
    await f.engine.completeJob(retry, {
      status: 'completed',
      summary: 'Outdated plan',
      checkedHead: t.revision!.head,
    });
    expect(current().state).toBe('queued');
    expect(current().reviewRecovery).toBeUndefined();
    expect(
      f.store.jobs(task.id).filter((j) => j.kind === 'fix' && j.status === 'queued'),
    ).toHaveLength(0);
  } finally {
    await f.close();
  }
});
