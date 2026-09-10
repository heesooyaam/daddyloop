import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { daddyFixture } from './daddy-fixture.js';
import type { SessionInput, AgentInput } from '../src/runtime/agent.js';
import { profiles } from './planning-fixture.js';
afterEach(() => vi.restoreAllMocks());
it('creates one Daddy conversation idempotently and lets him split and dispatch work without contacting writers', async () => {
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
it('enforces writer capacity, grows the pool for N+1 tasks, and drains active work when the limit shrinks', async () => {
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
        requirements: 'Make an independent change',
        createdByAction: `fixture-${i}`,
      });
      await f.engine.implement(task.id);
    }
    await f.worker.tick();
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    expect(f.daddy.board(group.id).writers.active).toBe(2);
    await f.daddy.settings(group.id, { writerLimit: 1 });
    expect(f.daddy.board(group.id).writers.active).toBe(2);
    pending.shift()!.done();
    await vi.waitFor(() => expect(f.daddy.board(group.id).writers.active).toBe(1));
    await f.worker.tick();
    expect(pending).toHaveLength(1);
    pending.shift()!.done();
    await vi.waitFor(() => expect(f.daddy.board(group.id).writers.active).toBe(0));
    await f.worker.tick();
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    pending.shift()!.done();
    await vi.waitFor(() => expect(f.daddy.board(group.id).writers.active).toBe(0));
    expect(f.store.jobs().every((job) => job.status === 'completed')).toBe(true);
  } finally {
    pending.forEach((item) => item.done());
    await f.close();
  }
});
it('keeps the shared Daddy thread exclusive with native review and fences tools after pause', async () => {
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
      'another Daddy',
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
it('allows writer defaults to change while Daddy works, but preserves his active model', async () => {
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
