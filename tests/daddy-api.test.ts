import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../src/server/app.js';
import { daddyFixture } from './daddy-fixture.js';
import { healthy, catalogue } from './planning-fixture.js';
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
it('authenticates project/session controls, deduplicates messages and closes public writer chat', async () => {
  const f = daddyFixture(),
    server = await buildApp({
      dataDir: f.dir,
      store: f.store,
      projects: f.projects,
      workspaces: f.workspaces,
      daddyRuntime: f.runtime,
      daddyWorkspace: f.context,
      catalogue,
      resourceCheck: healthy,
      startWorker: false,
      token: 'fixture',
    });
  const headers = { authorization: 'Bearer fixture' };
  try {
    expect((await server.app.inject('/api/projects')).statusCode).toBe(401);
    expect((await server.app.inject('/api/workspaces')).statusCode).toBe(401);
    expect((await server.app.inject({ url: '/api/workspaces', headers })).json()).toEqual(
      (await server.app.inject({ url: '/api/projects', headers })).json(),
    );
    expect((await server.app.inject({ url: '/api/projects', headers })).json()).toHaveLength(1);
    const requestId = randomUUID(),
      input = { projectId: f.project.id, message: 'Start from this goal', requestId };
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
          payload: { writerLimit: 9 },
        })
      ).statusCode,
    ).toBe(400);
    const task = await f.tickets.local({
      project: f.project,
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
    ).toBe(403);
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
    ).toBe(200);
    expect(f.store.messages(first.group.id).at(-1)?.text).toBe('Question for daddy');
    expect(f.store.messages(task.id)).toHaveLength(0);
  } finally {
    await server.app.close();
    await f.close();
  }
});
