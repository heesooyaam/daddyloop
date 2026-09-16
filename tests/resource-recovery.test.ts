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
  const clean = vi.fn(async () => {
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
