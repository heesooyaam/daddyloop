import { expect, it, vi } from 'vitest';
import { Daddy } from '../src/core/daddy.js';
import type { AgentResult } from '../src/core/types.js';
import { daddyFixture } from './daddy-fixture.js';
import { healthy, catalogue } from './planning-fixture.js';

function fixture() {
  const f = daddyFixture();
  const lifecycle = {
    supports: vi.fn(() => true),
    prepare: vi.fn(async () => ({ path: f.dir })),
    remove: vi.fn(async () => ({ archivePath: f.dir + '/archive' })),
  };
  const daddy = new Daddy(
    f.engine,
    f.workspaces,
    f.tickets,
    f.worker,
    f.runtime,
    healthy,
    catalogue,
    f.context,
    lifecycle,
  );
  return {
    ...f,
    daddy,
    lifecycle,
    async close() {
      await daddy.stop();
      await f.close();
    },
  };
}
const finished: AgentResult = { status: 'completed', summary: 'Done', checkedHead: 'a'.repeat(40) };

it('prepares an empty session without a model call and gates queued goals until the copy is ready', async () => {
  const f = fixture();
  let ready!: (value: { path: string }) => void;
  f.lifecycle.prepare.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        ready = resolve;
      }),
  );
  try {
    const group = f.daddy.create({ workspaceId: f.workspace.id, message: 'Fix search' });
    f.daddy.tick();
    await vi.waitFor(() => expect(f.lifecycle.prepare).toHaveBeenCalledOnce());
    expect(f.store.getGroup(group.id).workspacePreparation?.state).toBe('preparing');
    expect(f.runtime.runSession).not.toHaveBeenCalled();
    ready({ path: f.dir + '/copy' });
    await vi.waitFor(() =>
      expect(f.store.getGroup(group.id).workspacePreparation?.state).toBe('ready'),
    );
    f.daddy.tick();
    await vi.waitFor(() => expect(f.runtime.runSession).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(f.daddy.board(group.id).daddyBusy).toBe(false));
    const empty = f.daddy.create({ workspaceId: f.workspace.id });
    f.daddy.tick();
    await vi.waitFor(() =>
      expect(f.store.getGroup(empty.id).workspacePreparation?.state).toBe('ready'),
    );
    expect(f.runtime.runSession).toHaveBeenCalledOnce();
  } finally {
    ready?.({ path: f.dir });
    await f.close();
  }
});
it('does not accept late preparation after a pause and can prepare again on resume', async () => {
  const f = fixture();
  let old!: (value: { path: string }) => void;
  f.lifecycle.prepare.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        old = resolve;
      }),
  );
  try {
    const group = f.daddy.create({ workspaceId: f.workspace.id });
    f.daddy.tick();
    await vi.waitFor(() => expect(f.lifecycle.prepare).toHaveBeenCalledOnce());
    await f.daddy.pause(group.id);
    old({ path: '/stale-copy' });
    await f.daddy.resume(group.id);
    await vi.waitFor(() => {
      f.daddy.tick();
      expect(f.lifecycle.prepare).toHaveBeenCalledTimes(2);
    });
    await vi.waitFor(() =>
      expect(f.store.getGroup(group.id).workspacePreparation).toEqual({
        state: 'ready',
        path: f.dir,
      }),
    );
  } finally {
    old?.({ path: f.dir });
    await f.close();
  }
});
it('waits for this session workers before removing copies without stopping another session', async () => {
  const f = fixture();
  const releases = new Map<string, (result: AgentResult) => void>();
  try {
    const a = f.daddy.create({ workspaceId: f.workspace.id });
    const b = f.daddy.create({ workspaceId: f.workspace.id });
    await vi.waitFor(() => {
      f.daddy.tick();
      expect(f.lifecycle.prepare).toHaveBeenCalledTimes(2);
    });
    const makeTask = (group: typeof a) =>
      f.tickets.local({
        workspace: f.workspace,
        groupId: group.id,
        groupGeneration: group.generation,
        title: group.id,
        requirements: 'Fixture',
        createdByAction: group.id,
      });
    const ta = await makeTask(a),
      tb = await makeTask(b);
    await f.engine.implement(ta.id);
    await f.engine.implement(tb.id);
    f.store.setSetting('worker.maxAgents', 2);
    f.agentRuntime.run.mockImplementation(
      (input) =>
        new Promise((resolve) => {
          releases.set(input.task.id, resolve);
        }),
    );
    await f.worker.tick();
    await vi.waitFor(() => expect(releases.size).toBe(2));
    await f.daddy.remove(a.id, a.generation);
    await vi.waitFor(() => expect(f.store.getGroup(a.id).deletion?.state).toBe('running'));
    expect(f.lifecycle.remove).not.toHaveBeenCalled();
    releases.get(ta.id)!(finished);
    await vi.waitFor(() => expect(f.store.getGroup(a.id).deletedAt).toBeTruthy());
    expect(f.lifecycle.remove).toHaveBeenCalledOnce();
    expect(f.store.getGroup(b.id).daddyState).toBe('active');
    expect(f.store.busy(tb.id)).toBe(true);
    expect(f.daddy.sessions().map((group) => group.id)).toEqual([b.id]);
    await expect(f.engine.action(ta.id, 'resume')).rejects.toMatchObject({
      code: 'session_deleting',
    });
  } finally {
    for (const release of releases.values()) release(finished);
    await f.close();
  }
});
it('preserves task references on archive failure and supports a deliberate deletion retry', async () => {
  const f = fixture();
  try {
    const group = f.daddy.create({ workspaceId: f.workspace.id });
    await vi.waitFor(() => {
      f.daddy.tick();
      expect(f.store.getGroup(group.id).workspacePreparation?.state).toBe('ready');
    });
    const task = await f.tickets.local({
      workspace: f.workspace,
      groupId: group.id,
      groupGeneration: group.generation,
      title: 'Task',
      requirements: 'Keep work',
      createdByAction: 'fixture',
    });
    task.authorWorktree = f.dir + '/keep';
    f.store.saveTask(task);
    f.lifecycle.remove.mockRejectedValueOnce(new Error('Archive could not be saved'));
    await f.daddy.remove(group.id, group.generation);
    await vi.waitFor(() => expect(f.store.getGroup(group.id).deletion?.state).toBe('error'));
    expect(f.store.getTask(task.id).authorWorktree).toBe(task.authorWorktree);
    expect(f.store.getTask(task.id).state).toBe('paused');
    await expect(f.daddy.resume(group.id)).rejects.toMatchObject({ code: 'session_deleting' });
    await f.daddy.remove(group.id, f.store.getGroup(group.id).generation);
    await vi.waitFor(() => expect(f.store.getGroup(group.id).deletedAt).toBeTruthy());
    expect(f.store.getGroup(group.id).deletion?.archivePath).toBe(f.dir + '/archive');
    expect(f.store.getTask(task.id).authorWorktree).toBeUndefined();
    expect(f.store.getTask(task.id).state).toBe('paused');
  } finally {
    await f.close();
  }
});
it('rejects a stale deletion confirmation before cancelling work', async () => {
  const f = fixture();
  try {
    const group = f.daddy.create({ workspaceId: f.workspace.id });
    await f.daddy.pause(group.id);
    await expect(f.daddy.remove(group.id, group.generation)).rejects.toMatchObject({
      code: 'stale_session',
    });
    expect(f.lifecycle.remove).not.toHaveBeenCalled();
    expect(f.store.getGroup(group.id).deletion).toBeUndefined();
  } finally {
    await f.close();
  }
});

it('does not park completed copies while their session is exporting and deleting them', async () => {
  const f = fixture();
  try {
    const group = f.daddy.create({ workspaceId: f.workspace.id });
    const task = await f.engine.create({
      ref: {
        provider: 'demo',
        host: 'demo.local',
        repo: 'fixture/repo',
        number: 1,
        url: 'https://demo.local/pull/1',
      },
      repoPath: f.dir,
      requirements: 'Fixture',
      groupId: group.id,
    });
    task.state = 'complete';
    task.arcWorkspaces = {
      author: {
        mount: f.dir,
        ownerId: 'fixture',
        objectStore: f.dir,
        initialHash: 'a'.repeat(40),
        initialBranch: 'main',
        baseHead: 'a'.repeat(40),
        managed: { sessionId: group.id, taskId: task.id, role: 'author' },
      },
    };
    f.store.saveTask(task);
    const current = f.store.getGroup(group.id);
    current.deletion = { state: 'running' };
    current.daddyState = 'paused';
    f.store.saveGroup(current);
    const park = vi.spyOn(f.checkouts, 'parkArc').mockResolvedValue(undefined);
    await f.worker.tick();
    expect(park).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});
