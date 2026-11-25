import { expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../src/server/app.js';
import { registerDaddy } from '../src/server/daddy.js';
import { daddyFixture } from './daddy-fixture.js';
import { healthy, catalogue } from './planning-fixture.js';
import { assertTaskVersion } from '../src/core/types.js';

it('lists session counts and running roles without reading job or conversation history', async () => {
  const f = daddyFixture(),
    app = Fastify();
  registerDaddy(app, f.daddy);
  try {
    const workers = f.daddy.create({
      workspaceId: f.workspace.id,
      instructions: { daddy: { prompt: 'Fixture instructions' }, worker: {} },
    });
    const review = f.daddy.create({ workspaceId: f.workspace.id });
    const coordination = f.daddy.create({ workspaceId: f.workspace.id, message: 'Start' });
    const local = (groupId: string, title: string) =>
      f.tickets.local({
        workspace: f.workspace,
        groupId,
        groupGeneration: 1,
        title,
        requirements: 'Fixture task',
        createdByAction: title,
      });
    const completed = await local(workers.id, 'Completed');
    completed.state = 'complete';
    f.store.saveTask(completed);
    const author = await local(workers.id, 'Author');
    const reviewer = await local(review.id, 'Reviewer');
    const pastReview = f.store.enqueue(completed, 'reviewer', 'review', 'Prior review');
    pastReview.status = 'completed';
    f.store.saveJob(pastReview);
    f.store.enqueue(author, 'author', 'implement', 'Implement');
    f.store.enqueue(reviewer, 'reviewer', 'review', 'Review');
    f.store.claim();
    f.store.claim();
    const [daddyJob] = f.store.daddyJobs(coordination.id);
    daddyJob.status = 'running';
    f.store.saveDaddyJob(daddyJob);

    const messages = vi.spyOn(f.store, 'messages');
    const jobs = vi.spyOn(f.store, 'jobs');
    const result = await app.inject('/api/daddy/sessions');
    expect(result.statusCode).toBe(200);
    const sessions = result.json();
    expect(sessions).toMatchObject([
      { id: coordination.id, total: 0, complete: 0, daddyBusy: true, workers: { active: 0 } },
      { id: review.id, total: 1, complete: 0, daddyBusy: true, workers: { active: 0 } },
      { id: workers.id, total: 2, complete: 1, daddyBusy: false, workers: { active: 1 } },
    ]);
    expect(sessions[2]).not.toHaveProperty('instructions');
    expect(messages).not.toHaveBeenCalled();
    expect(jobs).not.toHaveBeenCalled();
  } finally {
    await app.close();
    await f.close();
  }
});

it('checks the viewed revision after acquiring the task lock before a human approval', async () => {
  const f = daddyFixture();
  let release!: () => void, entered!: () => void;
  try {
    const task = await f.engine.create({
      ref: {
        provider: 'demo',
        host: 'demo.local',
        repo: 'fixture/repo',
        number: 1,
        url: 'https://demo.local/pull/1',
      },
      repoPath: f.dir,
      requirements: 'Review plan',
    });
    task.state = 'awaiting_plan_approval';
    task.kind = 'plan';
    f.store.saveTask(task);
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const locked = f.engine.lock(task.id, async () => {
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      const current = f.store.getTask(task.id);
      current.generation++;
      current.revision!.head = 'f'.repeat(40);
      f.store.saveTask(current);
    });
    await ready;
    const approval = f.engine.action(task.id, 'approve-plan', '', {
      head: task.revision!.head,
      generation: task.generation,
    });
    release();
    await locked;
    await expect(approval).rejects.toMatchObject({ code: 'stale_task' });
    expect(f.store.getTask(task.id).approvedAt).toBeUndefined();
  } finally {
    release?.();
    await f.close();
  }
});
it('routes web task actions through the shared revision-bound service with the waiver reason', async () => {
  const f = daddyFixture(),
    app = Fastify();
  registerDaddy(app, f.daddy);
  try {
    const group = f.daddy.create({ workspaceId: f.workspace.id });
    const task = await f.tickets.local({
      workspace: f.workspace,
      groupId: group.id,
      groupGeneration: group.generation,
      title: 'Manual check',
      requirements: 'Review the offline result',
      createdByAction: 'fixture',
    });
    const action = vi.spyOn(f.daddy, 'taskAction').mockResolvedValue(task);
    const response = await app.inject({
      method: 'POST',
      url: `/api/daddy/sessions/${group.id}/task-action`,
      payload: {
        taskId: task.id,
        action: 'waive-checks',
        expectedHead: task.revision!.head,
        expectedGeneration: task.generation,
        reason: 'Offline checks passed on the saved revision',
      },
    });
    expect(response.statusCode).toBe(200);
    expect(action).toHaveBeenCalledWith(
      group.id,
      task.id,
      'waive-checks',
      { head: task.revision!.head, generation: task.generation },
      'Offline checks passed on the saved revision',
    );
  } finally {
    await app.close();
    await f.close();
  }
});
it('requires the exact pending head before a web action submits saved PR fixes', async () => {
  const f = daddyFixture(),
    app = Fastify();
  registerDaddy(app, f.daddy);
  try {
    const group = f.daddy.create({ workspaceId: f.workspace.id, autoPush: false });
    const task = await f.engine.create({
      ref: {
        provider: 'demo',
        host: 'demo.local',
        repo: 'test/repo',
        number: 91,
        url: 'https://demo.local/pull/91',
      },
      repoPath: f.dir,
      requirements: 'Submit this saved fix explicitly',
      groupId: group.id,
      groupGeneration: group.generation,
    });
    const saved = 'f'.repeat(40);
    task.state = 'awaiting_push';
    task.pendingAuthorHead = saved;
    f.store.saveTask(task);
    let pushes = 0;
    vi.spyOn(f.tickets, 'pushFixes').mockImplementation(async (id, expected) =>
      f.engine.lock(id, async () => {
        const current = f.store.getTask(id);
        assertTaskVersion(current, expected);
        pushes++;
        current.revision = { ...current.revision!, head: saved };
        f.store.saveTask(current);
        return current;
      }),
    );
    const action = (expectedPendingHead?: string) =>
      app.inject({
        method: 'POST',
        url: `/api/daddy/sessions/${group.id}/task-action`,
        payload: {
          taskId: task.id,
          action: 'submit',
          expectedHead: task.revision!.head,
          expectedGeneration: task.generation,
          ...(expectedPendingHead !== undefined ? { expectedPendingHead } : {}),
        },
      });
    expect((await action()).statusCode).toBe(400);
    expect((await action('')).statusCode).toBe(400);
    expect((await action('e'.repeat(40))).statusCode).toBe(409);
    expect(pushes).toBe(0);
    expect((await action(saved)).statusCode).toBe(200);
    expect((await action(saved)).statusCode).toBe(409);
    expect(pushes).toBe(1);
  } finally {
    await app.close();
    await f.close();
  }
});
it('authenticates workspace/session controls, deduplicates messages and closes public worker chat', async () => {
  const f = daddyFixture(),
    server = await buildApp({
      dataDir: f.dir,
      store: f.store,
      workspaces: f.workspaces,
      checkouts: f.checkouts,
      daddyRuntime: f.runtime,
      daddyWorkspace: f.context,
      catalogue,
      resourceCheck: healthy,
      startWorker: false,
      token: 'fixture',
    });
  const headers = { authorization: 'Bearer fixture' };
  try {
    expect((await server.app.inject('/api/workspaces')).statusCode).toBe(401);
    expect((await server.app.inject({ url: '/api/projects', headers })).statusCode).toBe(404);
    expect((await server.app.inject({ url: '/api/workspaces', headers })).json()).toEqual(
      (await server.app.inject({ url: '/api/workspaces', headers })).json(),
    );
    expect((await server.app.inject({ url: '/api/workspaces', headers })).json()).toHaveLength(1);
    const requestId = randomUUID(),
      input = { workspaceId: f.workspace.id, message: 'Start from this goal', requestId };
    const first = (
      await server.app.inject({
        method: 'POST',
        url: '/api/daddy/sessions',
        headers,
        payload: input,
      })
    ).json();
    const second = (
      await server.app.inject({
        method: 'POST',
        url: '/api/daddy/sessions',
        headers,
        payload: input,
      })
    ).json();
    expect(second.group.id).toBe(first.group.id);
    const chat = { text: 'Add one more ticket', requestId: randomUUID() };
    for (let i = 0; i < 2; i++)
      expect(
        (
          await server.app.inject({
            method: 'POST',
            url: `/api/daddy/sessions/${first.group.id}/chat`,
            headers,
            payload: chat,
          })
        ).statusCode,
      ).toBe(200);
    expect(
      f.store.messages(first.group.id).filter((message) => message.sender === 'user'),
    ).toHaveLength(2);
    expect(
      (
        await server.app.inject({
          method: 'POST',
          url: `/api/daddy/sessions/${first.group.id}/settings`,
          headers,
          payload: { workerLimit: 9 },
        })
      ).statusCode,
    ).toBe(400);
    const task = await f.tickets.local({
      workspace: f.workspace,
      groupId: first.group.id,
      groupGeneration: first.group.generation,
      title: 'Subtask',
      requirements: 'Work',
      createdByAction: 'fixture',
    });
    expect(
      (
        await server.app.inject({
          method: 'POST',
          url: `/api/tasks/${task.id}/messages`,
          headers,
          payload: { role: 'author', text: 'Bypass daddy' },
        })
      ).statusCode,
    ).toBe(404);
    expect(f.store.jobs(task.id)).toHaveLength(0);
    expect(
      (
        await server.app.inject({
          method: 'POST',
          url: `/api/tasks/${task.id}/messages`,
          headers,
          payload: { role: 'reviewer', text: 'Question for daddy' },
        })
      ).statusCode,
    ).toBe(404);
    expect(f.store.messages(first.group.id).at(-1)?.text).toBe('Add one more ticket');
    expect(f.store.messages(task.id)).toHaveLength(0);
  } finally {
    await server.app.close();
    await f.close();
  }
});
