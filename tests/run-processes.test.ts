import { it, expect, vi } from 'vitest';
import { spawn } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  realpathSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/core/store.js';
import {
  RunProcesses,
  linuxProcessTable,
  scopeVariable,
  type ProcessTable,
  type OwnedProcess,
} from '../src/runtime/run-processes.js';

const owner = {
  runId: 'run-fixture',
  groupId: 'group-fixture',
  taskId: 'task-fixture',
  kind: 'worker' as const,
};
function fixture(table = linuxProcessTable()) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'daddyloop-run-processes-')));
  const store = new Store(':memory:');
  return {
    dir,
    store,
    table,
    manager: new RunProcesses(store, dir, table, 60),
    close() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
async function detached(dir: string, name: string, env: NodeJS.ProcessEnv) {
  const marker = join(dir, name + '.json');
  const child = `process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(process.argv[1],JSON.stringify({pid:process.pid}));setInterval(()=>{},1000);`;
  const parent = spawn(
    process.execPath,
    [
      '-e',
      `const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(child)},process.argv[1]],{detached:true,stdio:'ignore',env:process.env});child.unref();`,
      marker,
    ],
    { cwd: dir, env, stdio: 'ignore' },
  );
  await new Promise<void>((resolve, reject) => {
    parent.once('error', reject);
    parent.once('exit', (code) =>
      code === 0 ? resolve() : reject(Error('Fixture parent failed')),
    );
  });
  await vi.waitFor(() => expect(existsSync(marker)).toBe(true));
  return JSON.parse(readFileSync(marker, 'utf8')).pid as number;
}
it.skipIf(process.platform !== 'linux')(
  'stops a detached, reparented child after the run, preserves active/foreign processes and removes only owned disposable caches',
  async () => {
    const f = fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let child = 0,
      human = 0,
      cache = '';
    const source = join(f.dir, 'working-copy.txt');
    writeFileSync(source, 'keep my changes');
    let running: Promise<void> | undefined;
    try {
      const humanEnv = { ...process.env };
      delete humanEnv[scopeVariable];
      human = await detached(f.dir, 'unrelated', humanEnv);
      running = f.manager.run(owner, async (scope) => {
        cache = scope.cacheDir;
        writeFileSync(join(cache, 'disposable'), 'cache');
        child = await detached(f.dir, 'owned', { ...process.env, ...scope.env });
        await gate;
      });
      void running.catch(() => {});
      await vi.waitFor(() => expect(child).toBeGreaterThan(0));
      const owned = f.table.list().find((p) => p.pid === child)!;
      expect(owned.scope).toBeTruthy();
      expect(f.table.signal({ ...owned, startTime: 'reused-pid' }, 'SIGTERM')).toBe(false);
      expect(f.table.signal({ ...owned, scope: randomUUID() }, 'SIGTERM')).toBe(false);
      expect(await f.manager.reclaim(owner.groupId, true)).toEqual([]);
      expect(f.table.identity(child)).toBeDefined();
      release();
      await running;
      expect(f.table.identity(child)).toBeUndefined();
      expect(f.table.identity(human)).toBeDefined();
      expect(existsSync(cache)).toBe(true);
      expect(
        f.store
          .events(owner.taskId)
          .some(
            (e) =>
              e.type === 'runtime.process_cleanup' && JSON.stringify(e.data).includes('SIGKILL'),
          ),
      ).toBe(true);
      expect((await f.manager.reclaim(owner.groupId, true))[0].cacheRemoved).toBe(true);
      expect(existsSync(cache)).toBe(false);
      expect(readFileSync(source, 'utf8')).toBe('keep my changes');
      expect(f.table.identity(human)).toBeDefined();
    } finally {
      release();
      await running?.catch(() => {});
      for (const pid of [child, human])
        if (pid && f.table.identity(pid)) process.kill(pid, 'SIGKILL');
      f.close();
    }
  },
);
function simulated() {
  const entries = new Map<number, OwnedProcess>();
  const signal = vi.fn((p: OwnedProcess, _signal: NodeJS.Signals) => {
    entries.delete(p.pid);
    return true;
  });
  const service = { pid: 20, uid: process.getuid!(), startTime: 'new-service' };
  const table: ProcessTable = {
    bootId: 'same-boot',
    service,
    identity: (pid) => (pid === service.pid ? service : entries.get(pid)),
    list: () => [...entries.values()],
    signal,
  };
  return { entries, signal, table };
}
it('preserves a cache path redirected to user files', async () => {
  const table = simulated(),
    f = fixture(table.table);
  try {
    const { cache } = abandoned(f);
    const elsewhere = join(f.dir, 'user-files');
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, 'keep'), 'user work');
    rmSync(cache, { recursive: true });
    symlinkSync(elsewhere, cache);
    await expect(f.manager.reclaim(owner.groupId, true)).rejects.toThrow('replaced');
    expect(readFileSync(join(elsewhere, 'keep'), 'utf8')).toBe('user work');
  } finally {
    f.close();
  }
});
function abandoned(f: ReturnType<typeof fixture>, bootId = 'same-boot') {
  const id = randomUUID();
  f.store.setSetting('runtime.processScope:' + id, {
    ...owner,
    id,
    bootId,
    service: { pid: 10, uid: process.getuid!(), startTime: 'old-service' },
    state: 'active',
    createdAt: new Date().toISOString(),
  });
  const cache = join(f.dir, 'run-cache', id);
  mkdirSync(cache, { recursive: true });
  writeFileSync(join(cache, 'cache'), 'reproducible');
  return { id, cache };
}
it.each(['cancelled', 'provider error'])(
  'closes owned processes on %s without turning the error into success',
  async (reason) => {
    const table = simulated(),
      f = fixture(table.table);
    try {
      await expect(
        f.manager.run(owner, async (scope) => {
          table.entries.set(31, {
            pid: 31,
            uid: process.getuid!(),
            startTime: 'child',
            scope: scope.env[scopeVariable],
            name: 'rsync',
          });
          throw new Error(reason);
        }),
      ).rejects.toThrow(reason);
      expect(table.entries.size).toBe(0);
      expect(f.manager.inspect(owner.groupId)).toEqual([]);
    } finally {
      f.close();
    }
  },
);
it('keeps surviving processes recorded and blocks a new run instead of reporting completion', async () => {
  const table = simulated(),
    f = fixture(table.table);
  table.signal.mockImplementation(() => true);
  let cache = '';
  try {
    await expect(
      f.manager.run(owner, async (scope) => {
        cache = scope.cacheDir;
        writeFileSync(join(cache, 'keep-until-stopped'), 'cache');
        table.entries.set(31, {
          pid: 31,
          uid: process.getuid!(),
          startTime: 'child',
          scope: scope.env[scopeVariable],
          name: 'blocked-io',
        });
        return 'completed';
      }),
    ).rejects.toThrow('still stopping');
    const start = vi.fn(async () => {});
    await expect(f.manager.run(owner, start)).rejects.toThrow('previous run');
    expect(start).not.toHaveBeenCalled();
    expect(existsSync(cache)).toBe(true);
    expect(f.manager.inspect(owner.groupId)[0].processes).toHaveLength(1);
    table.entries.clear();
    expect((await f.manager.reclaim(owner.groupId, true))[0].cacheRemoved).toBe(true);
  } finally {
    f.close();
  }
});
it('recovers recorded detached descendants after a service restart without removing their cache until cleanup', async () => {
  const table = simulated(),
    f = fixture(table.table);
  try {
    const { id, cache } = abandoned(f);
    table.entries.set(31, {
      pid: 31,
      uid: process.getuid!(),
      startTime: 'child',
      scope: id,
      name: 'rsync',
    });
    table.entries.set(32, {
      pid: 32,
      uid: process.getuid!(),
      startTime: 'other',
      scope: randomUUID(),
      name: 'rsync',
    });
    await f.manager.recover();
    expect(table.signal).toHaveBeenCalledOnce();
    expect(table.entries.has(32)).toBe(true);
    expect(existsSync(cache)).toBe(true);
    await f.manager.recover(true);
    expect(existsSync(cache)).toBe(false);
  } finally {
    f.close();
  }
});
it('never signals a process using a receipt from another host boot or another user', async () => {
  const table = simulated(),
    f = fixture(table.table);
  try {
    const old = abandoned(f, 'previous-boot');
    table.entries.set(31, {
      pid: 31,
      uid: process.getuid!(),
      startTime: 'reused',
      scope: old.id,
      name: 'bash',
    });
    const foreign = abandoned(f);
    table.entries.set(32, {
      pid: 32,
      uid: 2000,
      startTime: 'foreign',
      scope: foreign.id,
      name: 'bash',
    });
    await f.manager.recover();
    expect(table.signal).not.toHaveBeenCalled();
    expect(table.entries.size).toBe(2);
  } finally {
    f.close();
  }
});
it('preserves a run cache containing an active mount', async () => {
  const table = simulated(),
    f = fixture(table.table);
  try {
    const { cache } = abandoned(f);
    const manager = new RunProcesses(f.store, f.dir, table.table, 60, () => [
      join(cache, 'mounted'),
    ]);
    expect((await manager.reclaim(owner.groupId, true))[0].cacheRemoved).toBe(false);
    expect(existsSync(join(cache, 'cache'))).toBe(true);
  } finally {
    f.close();
  }
});
it('preserves a cache that the user has registered as a workspace', async () => {
  const table = simulated(),
    f = fixture(table.table);
  try {
    const { cache } = abandoned(f);
    f.store.saveWorkspace({
      id: randomUUID(),
      name: 'User workspace',
      repoPath: cache,
      scope: '',
      vcs: 'git',
      provider: 'github',
      host: 'github.com',
      repo: 'fixture/repo',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    expect((await f.manager.reclaim(owner.groupId, true))[0].cacheRemoved).toBe(false);
    expect(existsSync(join(cache, 'cache'))).toBe(true);
  } finally {
    f.close();
  }
});
it('preserves runs owned by another live service process', async () => {
  const table = simulated(),
    f = fixture(table.table);
  try {
    const { id, cache } = abandoned(f);
    table.entries.set(10, {
      pid: 10,
      uid: process.getuid!(),
      startTime: 'old-service',
      scope: 'unrelated',
      name: 'node',
    });
    table.entries.set(31, {
      pid: 31,
      uid: process.getuid!(),
      startTime: 'child',
      scope: id,
      name: 'rsync',
    });
    await f.manager.reclaim(owner.groupId, true);
    expect(table.signal).not.toHaveBeenCalled();
    expect(existsSync(cache)).toBe(true);
  } finally {
    f.close();
  }
});
it('allows maintenance to reclaim finished run caches while protecting its own processes', async () => {
  const table = simulated(),
    f = fixture(table.table);
  try {
    const old = abandoned(f);
    await f.manager.run(
      { ...owner, taskId: undefined, runId: 'maintenance', kind: 'maintenance' },
      async (scope) => {
        table.entries.set(40, {
          pid: 40,
          uid: process.getuid!(),
          startTime: 'maintenance',
          scope: scope.env[scopeVariable],
          name: 'codex',
        });
        const results = await f.manager.reclaim(owner.groupId, true);
        expect(results).toHaveLength(1);
        expect(results[0].cacheRemoved).toBe(true);
        expect(table.entries.has(40)).toBe(true);
        expect(existsSync(old.cache)).toBe(false);
      },
    );
  } finally {
    f.close();
  }
});
