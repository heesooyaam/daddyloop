import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { daddyFixture } from './daddy-fixture.js';
import type { SessionInput, AgentInput } from '../src/runtime/agent.js';
import { profiles } from './planning-fixture.js';
afterEach(() => vi.restoreAllMocks());
it('creates one daddy conversation idempotently and lets him split and dispatch work without contacting writers', async () => {
  const f = daddyFixture();
  let created: string[] = [];
  f.runtime.runSession.mockImplementation(async (input) => {
    input.onSession('one-daddy');
    expect(input.tools?.some((tool) => tool.name === 'create_task')).toBe(true);
    expect(input.tools?.some((tool) => tool.name === 'read_review')).toBe(false);
    for (let i = 0; i < 3; i++) {
      const task = (await input.onTool(
        'create_task',
        { title: `Part ${i}`, requirements: `Implement independent part ${i}` },
        `create-${i}`,
      )) as { taskId: string };
      created.push(task.taskId);
      const again = (await input.onTool(
        'create_task',
        { title: `Part ${i}`, requirements: `Implement independent part ${i}` },
        `create-${i}`,
      )) as { taskId: string };
      expect(again.taskId).toBe(task.taskId);
      await input.onTool('dispatch', { taskId: task.taskId }, `dispatch-${i}`);
    }
    return {
      status: 'completed',
      summary: 'I assigned the three independent tasks.',
      checkedHead: '',
    };
  });
  try {
    const requestId = randomUUID(),
      group = f.daddy.create({
        projectId: f.project.id,
        message: 'Build three independent features.',
        requestId,
      });
    expect(
      f.daddy.create({
        projectId: f.project.id,
        message: 'Build three independent features.',
        requestId,
      }).id,
    ).toBe(group.id);
    expect(() =>
      f.daddy.create({ projectId: f.project.id, message: 'Different request', requestId }),
    ).toThrow('different arguments');
    expect(f.store.messages(group.id)).toHaveLength(1);
    f.daddy.tick();
    await vi.waitFor(() => expect(f.store.daddyJobs(group.id)[0].status).toBe('completed'));
    expect(created).toHaveLength(3);
    expect(f.store.tasks()).toHaveLength(3);
    expect(f.store.jobs()).toHaveLength(3);
    expect(f.store.jobs().every((job) => job.kind === 'implement' && job.role === 'author')).toBe(
      true,
    );
    expect(f.store.getGroup(group.id).daddyThreadId).toBe('one-daddy');
    expect(f.store.messages(group.id).at(-1)?.text).toContain('assigned');
    expect(f.store.jobs().every((job) => job.profile?.model === profiles.author.model)).toBe(true);
  } finally {
    await f.close();
  }
});
it('drains whole tasks through review and fixes before retiring writer slots', async () => {
  const f = daddyFixture(),
    pending: { input: AgentInput; done: () => void }[] = [];
  f.writer.run.mockImplementation(async (input) => {
    await new Promise<void>((done) => pending.push({ input, done }));
    return { status: 'completed', summary: 'Done', checkedHead: input.task.revision!.head };
  });
  try {
    const group = f.daddy.create({ projectId: f.project.id, writerLimit: 2 });
    for (let i = 0; i < 3; i++) {
      const task = await f.tickets.local({
        project: f.project,
        groupId: group.id,
        groupGeneration: group.generation,
        title: `Task ${i}`,
        requirements: 'Independent change',
        createdByAction: `fixture-${i}`,
      });
      await f.engine.implement(task.id);
    }
    await f.worker.tick();
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    const a = pending[0].input.task.id,
      b = pending[1].input.task.id;
    const requested = await f.daddy.settings(group.id, { writerLimit: 1 });
    expect(requested.writers).toMatchObject({
      limit: 2,
      target: 1,
      pending: true,
      active: 2,
      occupied: 2,
    });
    pending.splice(0).forEach((run) => run.done());
    await vi.waitFor(() => expect(f.daddy.board(group.id).writers.active).toBe(0));
    await f.worker.tick();
    expect(pending).toHaveLength(0); // Both tasks still owe review; the queued third task waits.
    expect(f.daddy.board(group.id).writers).toMatchObject({ limit: 2, occupied: 2, retiring: 1 });
    const fixing = f.store.getTask(a);
    fixing.state = 'fixing';
    f.store.saveTask(fixing);
    f.store.enqueue(fixing, 'author', 'chat', 'Apply the published review feedback');
    await f.worker.tick();
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    expect(pending[0].input.task.id).toBe(a);
    pending.shift()!.done();
    await vi.waitFor(() => expect(f.daddy.board(group.id).writers.active).toBe(0));
    for (const state of ['paused', 'needs_input', 'awaiting_checks'] as const) {
      const current = f.store.getTask(a);
      current.state = state;
      f.store.saveTask(current);
      await f.worker.tick();
      expect(pending).toHaveLength(0);
      expect(f.daddy.board(group.id).writers.occupied).toBe(2);
    }
    const completedA = f.store.getTask(a);
    completedA.state = 'complete';
    f.store.saveTask(completedA);
    await f.worker.tick();
    expect(f.daddy.board(group.id).writers).toMatchObject({
      limit: 1,
      target: 1,
      pending: false,
      occupied: 1,
    });
    expect(pending).toHaveLength(0);
    const completedB = f.store.getTask(b);
    completedB.state = 'complete';
    f.store.saveTask(completedB);
    await f.worker.tick();
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    expect([a, b]).not.toContain(pending[0].input.task.id);
  } finally {
    pending.forEach((run) => run.done());
    await f.close();
  }
});
it('applies growth asynchronously and lets the latest pool request supersede a pending resize', async () => {
  const f = daddyFixture();
  try {
    const group = f.daddy.create({ projectId: f.project.id });
    expect((await f.daddy.settings(group.id, { writerLimit: 3 })).writers).toMatchObject({
      limit: 1,
      target: 3,
      hostLimit: 1,
      pending: true,
    });
    await f.daddy.settings(group.id, { writerLimit: 2 });
    expect(f.daddy.board(group.id).writers.limit).toBe(1);
    await f.worker.tick();
    expect(f.daddy.board(group.id).writers).toMatchObject({
      limit: 2,
      target: 2,
      hostLimit: 2,
      pending: false,
    });
    await f.daddy.settings(group.id, { writerLimit: 1 });
    await f.daddy.settings(group.id, { writerLimit: 2 });
    await f.worker.tick();
    expect(f.daddy.board(group.id).writers.limit).toBe(2);
  } finally {
    await f.close();
  }
});
it('keeps the shared daddy thread exclusive with native review and fences tools after pause', async () => {
  const f = daddyFixture();
  let current!: SessionInput, done!: () => void;
  f.runtime.runSession.mockImplementation(async (input) => {
    current = input;
    input.onSession('one-daddy');
    await new Promise<void>((resolve) => {
      done = resolve;
      input.signal.addEventListener('abort', () => resolve(), { once: true });
    });
    return { status: 'completed', summary: 'Done', checkedHead: '' };
  });
  try {
    const group = f.daddy.create({ projectId: f.project.id, message: 'Discuss the work' });
    f.daddy.tick();
    await vi.waitFor(() => expect(current).toBeDefined());
    expect(f.worker.reserveGroup(group.id)).toBe(false);
    await f.daddy.pause(group.id);
    await expect(
      current.onTool('create_task', { title: 'Late', requirements: 'Must not be created' }, 'late'),
    ).rejects.toThrow('no longer active');
    await vi.waitFor(() => expect(f.store.daddyJobs(group.id)[0].status).toBe('cancelled'));
    expect(f.store.tasks()).toHaveLength(0);
    expect(f.store.getGroup(group.id).daddyState).toBe('paused');
    expect(f.worker.reserveGroup(group.id)).toBe(true);
    f.worker.releaseGroup(group.id);
  } finally {
    done?.();
    await f.close();
  }
});
it('enforces same-session task scope and acyclic prerequisites before dispatch', async () => {
  const f = daddyFixture();
  let current!: SessionInput, done!: () => void;
  f.runtime.runSession.mockImplementation(async (input) => {
    current = input;
    await new Promise<void>((resolve) => {
      done = resolve;
      input.signal.addEventListener('abort', () => resolve(), { once: true });
    });
    return { status: 'completed', summary: 'Done', checkedHead: '' };
  });
  try {
    const group = f.daddy.create({ projectId: f.project.id, message: 'Plan' }),
      other = f.daddy.create({ projectId: f.project.id });
    const foreign = await f.tickets.local({
      project: f.project,
      groupId: other.id,
      groupGeneration: other.generation,
      title: 'Foreign',
      requirements: 'Foreign',
      createdByAction: 'foreign',
    });
    f.daddy.tick();
    await vi.waitFor(() => expect(current).toBeDefined());
    await expect(current.onTool('read_task', { taskId: foreign.id }, 'read')).rejects.toThrow(
      'another daddy',
    );
    const a = (await current.onTool('create_task', { title: 'A', requirements: 'A' }, 'a')) as {
      taskId: string;
    };
    expect(f.store.getTask(a.taskId).groupId).toBe(group.id);
    const b = (await current.onTool(
      'create_task',
      { title: 'B', requirements: 'B', dependsOn: [a.taskId] },
      'b',
    )) as { taskId: string };
    await expect(
      current.onTool('set_dependencies', { taskId: a.taskId, dependsOn: [b.taskId] }, 'cycle'),
    ).rejects.toThrow('cycle');
    await expect(current.onTool('dispatch', { taskId: b.taskId }, 'early')).rejects.toThrow(
      'prerequisite',
    );
    expect(f.store.jobs()).toHaveLength(0);
    await expect(
      current.onTool('add_comment', { body: 'Cross-mode mutation' }, 'review'),
    ).rejects.toThrow('unavailable');
  } finally {
    done?.();
    await f.close();
  }
});
it('allows writer defaults to change while daddy works, but preserves his active model', async () => {
  const f = daddyFixture();
  let started = false,
    done!: () => void;
  f.runtime.runSession.mockImplementation(async (input) => {
    started = true;
    await new Promise<void>((resolve) => {
      done = resolve;
      input.signal.addEventListener('abort', () => resolve(), { once: true });
    });
    return { status: 'completed', summary: 'Done', checkedHead: '' };
  });
  try {
    const group = f.daddy.create({ projectId: f.project.id, message: 'Work' });
    f.daddy.tick();
    await vi.waitFor(() => expect(started).toBe(true));
    await f.daddy.settings(group.id, {
      profiles: { ...profiles, author: { ...profiles.author, effort: 'medium' } },
    });
    expect(f.store.getGroup(group.id).generation).toBe(group.generation);
    await expect(
      f.daddy.settings(group.id, { profiles: { ...profiles, reviewer: profiles.author } }),
    ).rejects.toThrow('idle');
    expect(f.store.getGroup(group.id).reviewer).toEqual(profiles.reviewer);
  } finally {
    done?.();
    await f.close();
  }
});
it('creates a separate session through a scoped tool without duplicating it on a retry', async () => {
  const f = daddyFixture();
  try {
    const parent = f.daddy.create({
        projectId: f.project.id,
        message: 'Create a separate session for the API work',
      }),
      job = f.store.daddyJobs(parent.id)[0];
    const result = (await f.daddy.call(
      job,
      'create_session',
      { title: 'API work', goal: 'Design the new endpoint' },
      'create-session',
      new AbortController().signal,
    )) as { sessionId: string };
    const again = (await f.daddy.call(
      job,
      'create_session',
      { title: 'API work', goal: 'Design the new endpoint' },
      'create-session',
      new AbortController().signal,
    )) as { sessionId: string };
    expect(again.sessionId).toBe(result.sessionId);
    expect(f.daddy.sessions()).toHaveLength(2);
    const child = f.daddy.group(result.sessionId);
    expect(child.parentGroupId).toBe(parent.id);
    expect(child.reviewer).toEqual(parent.reviewer);
    expect(f.store.messages(child.id)[0].text).toBe('Design the new endpoint');
    expect(f.store.tasks()).toHaveLength(0);
    await expect(
      f.daddy.call(
        { ...job, trigger: 'worker' },
        'create_session',
        { title: 'Unasked', goal: 'Unasked' },
        'forbidden',
        new AbortController().signal,
      ),
    ).rejects.toThrow('user request');
  } finally {
    await f.close();
  }
});
it('refreshes coordination tools while preserving saved history and the native review thread', async () => {
  const f = daddyFixture();
  try {
    const group = f.daddy.create({ projectId: f.project.id });
    group.daddyThreadId = 'previous-coordination';
    group.reviewerThreadId = 'private-native-review';
    f.store.saveGroup(group);
    f.store.daddyMessage(group.id, 'user', 'An earlier requirement');
    f.daddy.chat(group.id, 'Continue with the upgraded tools');
    f.runtime.runSession.mockImplementation(async (input) => {
      expect(input.threadId).toBeUndefined();
      expect(input.tools!.some((tool) => tool.name === 'create_session')).toBe(true);
      const history = (await input.onTool(
        'read_conversation',
        { offset: 0, limit: 30 },
        'read',
      )) as { messages: { text: string }[] };
      expect(history.messages.some((message) => message.text === 'An earlier requirement')).toBe(
        true,
      );
      input.onSession('new-coordination');
      return { status: 'completed', summary: 'Ready', checkedHead: '' };
    });
    f.daddy.tick();
    await vi.waitFor(() => expect(f.store.daddyJobs(group.id)[0].status).toBe('completed'));
    expect(f.daddy.group(group.id).reviewerThreadId).toBe('private-native-review');
    expect(f.store.setting(`daddy.previousThread:${group.id}:previous-coordination`)).toBeTruthy();
  } finally {
    await f.close();
  }
});
