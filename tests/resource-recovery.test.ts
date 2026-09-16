import { it, expect, vi } from 'vitest';
import { join } from 'node:path';
import { Daddy } from '../src/core/daddy.js';
import { ResourceRecovery } from '../src/core/resource-recovery.js';
import { daddyFixture } from './daddy-fixture.js';
import { healthy, catalogue } from './planning-fixture.js';
import type { ResourceStatus } from '../src/core/types.js';
import type { SessionInput } from '../src/runtime/agent.js';

function fixture() {
  const f = daddyFixture();
  let resources: ResourceStatus = {
    ...healthy(),
    ok: false,
    diskUsedPercent: 81,
    reasons: ['Disk-space threshold reached'],
  };
  const inspect = vi.fn(async () => ({ candidates: ['verified disposable cache'] }));
  const stopProcesses = vi.fn(async () => ({ stopped: [42], remaining: [] }));
  const clean = vi.fn(async (_groupId: string, _signal: AbortSignal) => {
    resources = healthy();
    return { removedBytes: 1024 };
  });
  const daddy = new Daddy(
    f.engine,
    f.workspaces,
    f.tickets,
    f.worker,
    f.runtime,
    () => resources,
    catalogue,
    f.context,
  );
  daddy.resourceRecovery = new ResourceRecovery(f.engine, f.runtime, () => resources, {
    directory: join(f.dir, 'maintenance'),
    allowCleanup: true,
    inspect,
    clean,
    stopProcesses,
  });
  const calls: SessionInput[] = [];
  f.runtime.runSession.mockImplementation(async (input) => {
    calls.push(input);
    if (input.tools?.some((tool) => tool.name === 'clean_cache')) {
      await expect(input.onTool('clean_cache', { path: '/someone-elses-files' })).rejects.toThrow(
        'bounded',
      );
      await expect(input.onTool('dispatch', {})).rejects.toThrow('bounded');
      await input.onTool('inspect_cache', {});
      await expect(input.onTool('stop_processes', { pid: 42 })).rejects.toThrow('bounded');
      await input.onTool('stop_processes', {});
      await input.onTool('clean_cache', {});
      expect(((await input.onTool('read_resources', {})) as ResourceStatus).ok).toBe(true);
    }
    return { status: 'completed', summary: 'Checked the current state.', checkedHead: '' };
  });
  return {
    ...f,
    daddy,
    clean,
    inspect,
    stopProcesses,
    calls,
    setResources: (value: ResourceStatus) => {
      resources = value;
    },
    async close() {
      await daddy.stop();
      await f.close();
    },
  };
}

it('asks daddy to repair resource pressure without allocating a repository and keeps user questions queued', async () => {
  const f = fixture();
  try {
    const group = f.daddy.create({ workspaceId: f.workspace.id });
    f.daddy.chat(group.id, 'How is the task going?');
    expect(f.store.events(group.id).some((event) => event.type === 'daddy.resource_wait')).toBe(
      true,
    );
    f.daddy.tick();
    await vi.waitFor(() =>
      expect(f.store.daddyJobs(group.id).find((job) => job.trigger === 'resources')?.status).toBe(
        'completed',
      ),
    );
    expect(f.clean).toHaveBeenCalledOnce();
    expect(f.inspect).toHaveBeenCalledOnce();
    expect(f.stopProcesses).toHaveBeenCalledTimes(2);
    expect(f.context.prepare).not.toHaveBeenCalled();
    expect(f.store.daddyJobs(group.id).find((job) => job.trigger === 'user')).toMatchObject({
      status: 'queued',
      input: 'How is the task going?',
    });
    f.daddy.tick();
    await vi.waitFor(() =>
      expect(f.store.daddyJobs(group.id).find((job) => job.trigger === 'user')?.status).toBe(
        'completed',
      ),
    );
    expect(f.context.prepare).toHaveBeenCalledOnce();
    expect(f.daddy.group(group.id).resourceWait).toBeUndefined();
    expect(f.calls[0].cwd).toBe(join(f.dir, 'maintenance'));
  } finally {
    await f.close();
  }
});

it('does not start a model at the hard resource floor or create a repair job every tick', async () => {
  const f = fixture();
  try {
    f.setResources({
      ...healthy(),
      ok: false,
      diskAvailableGiB: 0.2,
      reasons: ['Disk-space threshold reached'],
    });
    const group = f.daddy.create({ workspaceId: f.workspace.id });
    f.daddy.chat(group.id, 'Keep my question');
    for (let i = 0; i < 10; i++) f.daddy.tick();
    expect(f.runtime.runSession).not.toHaveBeenCalled();
    expect(f.store.daddyJobs(group.id).filter((job) => job.trigger === 'resources')).toHaveLength(
      1,
    );
    expect(f.store.messages(group.id)[0].text).toBe('Keep my question');
  } finally {
    await f.close();
  }
});

it('stops owned leftovers before calling a model and skips the model when that restores resources', async () => {
  const f = fixture();
  try {
    f.stopProcesses.mockImplementation(async () => {
      f.setResources(healthy());
      return { stopped: [42], remaining: [] };
    });
    const group = f.daddy.create({ workspaceId: f.workspace.id });
    f.daddy.chat(group.id, 'Keep working');
    f.daddy.tick();
    await vi.waitFor(() =>
      expect(f.store.daddyJobs(group.id).find((j) => j.trigger === 'resources')?.status).toBe(
        'completed',
      ),
    );
    expect(f.stopProcesses).toHaveBeenCalledOnce();
    expect(f.runtime.runSession).not.toHaveBeenCalled();
    expect(f.clean).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

it('replaces a late cleanup question with measured recovery instead of asking the user to kill a finished process', async () => {
  const f = fixture();
  try {
    f.runtime.runSession.mockImplementation(async () => {
      f.setResources(healthy());
      return {
        status: 'needs_input',
        summary: 'Please stop the build.',
        question: 'Kill PID 42 manually?',
        checkedHead: '',
      };
    });
    const group = f.daddy.create({ workspaceId: f.workspace.id });
    f.daddy.chat(group.id, 'Keep working');
    f.daddy.tick();
    await vi.waitFor(() =>
      expect(f.store.daddyJobs(group.id).find((j) => j.trigger === 'resources')?.status).toBe(
        'completed',
      ),
    );
    const messages = f.store.messages(group.id).filter((m) => m.sender === 'agent');
    expect(messages.at(-1)?.text).toContain('Resources are available again');
    expect(messages.some((m) => m.text.includes('Kill PID'))).toBe(false);
  } finally {
    await f.close();
  }
});

it('cancels pending cleanup when the maintenance model disconnects', async () => {
  const f = fixture();
  let cancelled = false;
  f.clean.mockImplementation(async (_groupId, signal) => {
    await new Promise<void>((_resolve, reject) =>
      signal.addEventListener(
        'abort',
        () => {
          cancelled = true;
          reject(new Error('cleanup cancelled'));
        },
        { once: true },
      ),
    );
    return { removedBytes: 0 };
  });
  f.runtime.runSession.mockImplementation(async (input) => {
    void input.onTool('clean_cache', {}).catch(() => {});
    throw new Error('model disconnected');
  });
  try {
    const group = f.daddy.create({ workspaceId: f.workspace.id });
    f.daddy.chat(group.id, 'Continue');
    f.daddy.tick();
    await vi.waitFor(() =>
      expect(f.store.daddyJobs(group.id).find((j) => j.trigger === 'resources')?.status).toBe(
        'failed',
      ),
    );
    expect(cancelled).toBe(true);
  } finally {
    await f.close();
  }
});

it('lets cancelled maintenance stop waiting for an active worker without cancelling that worker', async () => {
  const f = daddyFixture();
  let began!: () => void;
  const ready = new Promise<void>((resolve) => {
    began = resolve;
  });
  f.agentRuntime.run.mockImplementation(async (input) => {
    began();
    await new Promise<void>((resolve) =>
      input.signal.addEventListener('abort', () => resolve(), { once: true }),
    );
    return { status: 'incomplete', summary: 'Stopped', checkedHead: '' };
  });
  try {
    const group = f.daddy.create({ workspaceId: f.workspace.id });
    const task = await f.tickets.local({
      workspace: f.workspace,
      groupId: group.id,
      groupGeneration: group.generation,
      title: 'Fixture',
      requirements: 'Fixture',
      createdByAction: 'wait-fixture',
    });
    await f.engine.implement(task.id);
    await f.worker.tick();
    await ready;
    const controller = new AbortController();
    const waiting = f.worker.waitForGroup(group.id, controller.signal);
    controller.abort(new Error('maintenance cancelled'));
    await expect(waiting).rejects.toThrow('maintenance cancelled');
    expect(f.store.busy(task.id)).toBe(true);
  } finally {
    await f.close();
  }
});

it('resumes only monitor-paused tasks after recovery and respects a subsequent manual pause', async () => {
  const f = fixture();
  try {
    const group = f.daddy.create({ workspaceId: f.workspace.id });
    const create = async (title: string) => {
      const task = await f.tickets.local({
        workspace: f.workspace,
        groupId: group.id,
        groupGeneration: group.generation,
        title,
        requirements: 'Fixture',
        createdByAction: title,
      });
      await f.engine.implement(task.id);
      await f.engine.interruptTask(task.id, 'Disk threshold', 'resource.pause');
      return task.id;
    };
    const automatic = await create('automatic'),
      manual = await create('manual');
    await f.engine.action(manual, 'pause');
    f.setResources(healthy());
    f.daddy.tick();
    await vi.waitFor(() => expect(f.store.getTask(automatic).state).toBe('implementing'));
    expect(f.store.getTask(automatic).resourcePause).toBeUndefined();
    expect(f.store.getTask(manual).state).toBe('paused');
    expect(
      f.store.jobs(automatic).some((job) => job.status === 'queued' && job.kind === 'implement'),
    ).toBe(true);
  } finally {
    await f.close();
  }
});

it('repository recovery only collects ordinary Arc cache and parks verified idle owned mounts', async () => {
  const f = fixture();
  try {
    const { ArcadiaSessionWorkspace } =
      await import('../src/modules/repositories/arcadia-sessions.js');
    const group = f.daddy.create({ workspaceId: f.workspace.id });
    const record = {
      sessionId: group.id,
      taskId: 'owned-context',
      role: 'reviewer',
      mount: '/service-owned/copy',
    };
    const lease = {
      mount: record.mount,
      ownerId: 'service-owner',
      managed: { sessionId: group.id },
    };
    const arc = { native: vi.fn(async () => 'collected') };
    const mounts = {
      records: vi.fn(() => [record]),
      nativeMounts: vi.fn(async () => [
        { status: 'mounted', mount: record.mount },
        { status: 'mounted', mount: '/human/source' },
      ]),
      ensure: vi.fn(async () => ({ lease })),
      park: vi.fn(async () => {}),
    };
    const backend = new ArcadiaSessionWorkspace(
      { dataDir: f.dir, store: f.store, registry: f.workspaces, checkouts: f.checkouts },
      arc as any,
      mounts as any,
    );
    const result = await backend.reclaim(group, new AbortController().signal, true);
    expect(result).toEqual({
      parked: [record.mount],
      ordinaryGc: true,
      workingDataPreserved: true,
    });
    expect(arc.native.mock.calls).toEqual([[['gc'], record.mount, expect.any(AbortSignal)]]);
    expect(mounts.park).toHaveBeenCalledWith(lease);
    mounts.ensure.mockRejectedValueOnce(new Error('owner changed'));
    await expect(backend.reclaim(group, new AbortController().signal, true)).rejects.toThrow(
      'owner changed',
    );
    expect(arc.native).toHaveBeenCalledOnce();
  } finally {
    await f.close();
  }
});

it('keeps an interrupted coordinator question active so the monitor can repair and retry it', async () => {
  const f = fixture();
  f.setResources(healthy());
  let started = false,
    interrupted = false;
  f.runtime.runSession.mockImplementation(async (input) => {
    if (input.tools?.some((tool) => tool.name === 'clean_cache'))
      await input.onTool('clean_cache', {});
    else if (!interrupted) {
      started = true;
      await new Promise((_resolve, reject) =>
        input.signal.addEventListener(
          'abort',
          () => {
            interrupted = true;
            reject(new Error('interrupted'));
          },
          { once: true },
        ),
      );
    }
    return { status: 'completed', summary: 'Answered after recovery.', checkedHead: '' };
  });
  try {
    const group = f.daddy.create({ workspaceId: f.workspace.id });
    f.daddy.chat(group.id, 'Please answer this question');
    f.daddy.tick();
    await vi.waitFor(() => expect(started).toBe(true));
    f.setResources({ ...healthy(), ok: false, reasons: ['Disk-space threshold reached'] });
    f.daddy.tick();
    await vi.waitFor(() =>
      expect(f.store.daddyJobs(group.id).find((job) => job.trigger === 'user')?.status).toBe(
        'queued',
      ),
    );
    expect(f.daddy.group(group.id).daddyState).toBe('active');
    f.daddy.tick();
    await vi.waitFor(() =>
      expect(f.store.daddyJobs(group.id).find((job) => job.trigger === 'resources')?.status).toBe(
        'completed',
      ),
    );
    f.daddy.tick();
    await vi.waitFor(() =>
      expect(f.store.daddyJobs(group.id).find((job) => job.trigger === 'user')?.status).toBe(
        'completed',
      ),
    );
    expect(
      f.store.daddyJobs(group.id).find((job) => job.trigger === 'user')?.error,
    ).toBeUndefined();
  } finally {
    await f.close();
  }
});
