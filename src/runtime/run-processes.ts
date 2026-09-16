import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, statSync, lstatSync, realpathSync, mkdirSync } from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Store } from '../core/store.js';
import { AppError, now } from '../core/types.js';
import type { RunOwner, RunProcessScope } from './agent.js';

const prefix = 'runtime.processScope:';
export const scopeVariable = 'DADDYLOOP_RUN_SCOPE';
export interface ProcessIdentity {
  pid: number;
  uid: number;
  startTime: string;
}
export interface OwnedProcess extends ProcessIdentity {
  scope: string;
  name: string;
}
export interface ProcessTable {
  bootId: string;
  service: ProcessIdentity;
  identity(pid: number): ProcessIdentity | undefined;
  list(): OwnedProcess[];
  signal(process: OwnedProcess, signal: NodeJS.Signals): boolean;
}
const sameProcess = (a: ProcessIdentity | undefined, b: ProcessIdentity) =>
  a?.pid === b.pid && a.uid === b.uid && a.startTime === b.startTime;

/** Read only the ownership marker; never log or persist process environments/arguments. */
export function linuxProcessTable(): ProcessTable {
  const uid = process.getuid?.();
  const identity = (pid: number): ProcessIdentity | undefined => {
    try {
      const root = `/proc/${pid}`;
      if (statSync(root).uid !== uid) return;
      const stat = readFileSync(root + '/stat', 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      if (fields[0] === 'Z' || !/^\d+$/.test(fields[19])) return;
      return { pid, uid: uid!, startTime: fields[19] };
    } catch {
      return;
    }
  };
  const owned = (pid: number): OwnedProcess | undefined => {
    const before = identity(pid);
    if (!before || pid === process.pid) return;
    try {
      const entry = readFileSync(`/proc/${pid}/environ`, 'utf8')
        .split('\0')
        .find((value) => value.startsWith(scopeVariable + '='));
      const scope = entry?.slice(scopeVariable.length + 1);
      if (!scope || !/^[a-f0-9-]{36}$/.test(scope) || !sameProcess(identity(pid), before)) return;
      return {
        ...before,
        scope,
        name: readFileSync(`/proc/${pid}/comm`, 'utf8').trim().slice(0, 80),
      };
    } catch {
      return;
    }
  };
  const service = identity(process.pid);
  if (!service) throw new Error('Managed agent processes require Linux /proc access');
  return {
    bootId: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
    service,
    identity,
    list: () =>
      readdirSync('/proc')
        .filter((pid) => /^\d+$/.test(pid))
        .flatMap((pid) => {
          const value = owned(Number(pid));
          return value ? [value] : [];
        }),
    signal: (expected, signal) => {
      const current = owned(expected.pid);
      if (!sameProcess(current, expected) || current?.scope !== expected.scope) return false;
      try {
        process.kill(expected.pid, signal);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
        throw error;
      }
    },
  };
}
export function linuxMountPaths() {
  return readFileSync('/proc/self/mountinfo', 'utf8')
    .trim()
    .split('\n')
    .map((line) =>
      line
        .split(' ')[4]
        .replace(/\\([0-7]{3})/g, (_match, octal: string) =>
          String.fromCharCode(parseInt(octal, 8)),
        ),
    );
}
interface ScopeRecord extends RunOwner {
  id: string;
  bootId: string;
  service: ProcessIdentity;
  state: 'active' | 'finished';
  createdAt: string;
}
export class RunProcesses {
  private active = new Set<string>();
  private locks = new Map<string, Promise<void>>();
  readonly cacheRoot: string;
  constructor(
    private store: Store,
    dataDir: string,
    private table: ProcessTable = linuxProcessTable(),
    private graceMs = 3000,
    private mounts: () => string[] = linuxMountPaths,
  ) {
    this.cacheRoot = join(realpathSync(dataDir), 'run-cache');
  }
  private records(groupId?: string): ScopeRecord[] {
    return this.store.db
      .prepare("SELECT value FROM settings WHERE key LIKE 'runtime.processScope:%'")
      .all()
      .map((row) => JSON.parse(String(row.value)) as ScopeRecord)
      .filter((record) => groupId === undefined || record.groupId === groupId);
  }
  private save(record: ScopeRecord) {
    this.store.setSetting(prefix + record.id, record);
  }
  private eligible(record: ScopeRecord) {
    return (
      !this.active.has(record.id) &&
      (record.state === 'finished' ||
        record.bootId !== this.table.bootId ||
        !sameProcess(this.table.identity(record.service.pid), record.service))
    );
  }
  private cachePath(record: ScopeRecord) {
    if (!/^[a-f0-9-]{36}$/.test(record.id)) throw new Error('Invalid process scope identity');
    return join(this.cacheRoot, record.id);
  }
  private owned(record: ScopeRecord) {
    if (record.bootId !== this.table.bootId || record.service.uid !== this.table.service.uid)
      return [];
    return this.table
      .list()
      .filter((process) => process.scope === record.id && process.uid === record.service.uid);
  }
  private async lock<T>(groupId: string, fn: () => Promise<T>): Promise<T> {
    const before = this.locks.get(groupId) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.locks.set(groupId, next);
    await before;
    try {
      return await fn();
    } finally {
      release();
      if (this.locks.get(groupId) === next) this.locks.delete(groupId);
    }
  }
  private async stop(record: ScopeRecord) {
    const signalled = new Map<number, { pid: number; name: string; signal: NodeJS.Signals }>();
    const stopAt = Date.now() + this.graceMs + 1500;
    const forceAt = Date.now() + this.graceMs;
    let remaining = this.owned(record);
    while (remaining.length && Date.now() < stopAt) {
      const signal = Date.now() >= forceAt ? 'SIGKILL' : 'SIGTERM';
      for (const process of remaining) {
        if (signalled.get(process.pid)?.signal === signal) continue;
        if (this.table.signal(process, signal))
          signalled.set(process.pid, { pid: process.pid, name: process.name, signal });
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
      remaining = this.owned(record);
    }
    if (signalled.size)
      this.store.event(
        record.taskId ?? record.groupId,
        'runtime.process_cleanup',
        {
          signalled: [...signalled.values()],
          remaining: remaining.map(({ pid, name }) => ({ pid, name })),
        },
        record.runId,
      );
    return {
      signalled: [...signalled.values()],
      stopped: [...signalled.values()].filter(
        (process) => !remaining.some((value) => value.pid === process.pid),
      ),
      remaining: remaining.map(({ pid, name }) => ({ pid, name })),
    };
  }
  async run<T>(owner: RunOwner, fn: (scope: RunProcessScope) => Promise<T>): Promise<T> {
    const record = await this.lock(owner.groupId, async () => {
      if (
        this.records(owner.groupId).some(
          (value) =>
            value.taskId === owner.taskId && value.kind === owner.kind && !this.eligible(value),
        )
      )
        throw new AppError(
          'run_processes_busy',
          'The previous run still owns this task; wait for it to stop',
        );
      for (const previous of this.records(owner.groupId).filter(
        (value) => value.taskId === owner.taskId && this.eligible(value),
      )) {
        if ((await this.stop(previous)).remaining.length)
          throw new AppError(
            'owned_processes_pending',
            'A previous run still has processes stopping; its working files are preserved',
          );
      }
      const value: ScopeRecord = {
        ...owner,
        id: randomUUID(),
        bootId: this.table.bootId,
        service: this.table.service,
        state: 'active',
        createdAt: now(),
      };
      mkdirSync(this.cacheRoot, { recursive: true, mode: 0o700 });
      if (
        realpathSync(this.cacheRoot) !== this.cacheRoot ||
        lstatSync(this.cacheRoot).uid !== this.table.service.uid
      )
        throw new Error('Run cache root was redirected');
      mkdirSync(this.cachePath(value), { mode: 0o700 });
      this.save(value);
      this.active.add(value.id);
      return value;
    });
    try {
      return await fn({
        cacheDir: this.cachePath(record),
        env: {
          [scopeVariable]: record.id,
          DADDYLOOP_RUN_CACHE: this.cachePath(record),
        },
      });
    } finally {
      await this.lock(owner.groupId, async () => {
        record.state = 'finished';
        this.save(record);
        this.active.delete(record.id);
        const result = await this.stop(record);
        if (result.remaining.length)
          throw new AppError(
            'owned_processes_pending',
            'Owned processes are still stopping; the service will retry cleanup and preserve working files',
          );
        await this.removeCache(record, false);
      });
    }
  }
  inspect(groupId: string) {
    const processes = this.table.list();
    return this.records(groupId).map((record) => ({
      runId: record.runId,
      taskId: record.taskId,
      active: !this.eligible(record),
      cacheDir: this.cachePath(record),
      processes:
        record.bootId === this.table.bootId
          ? processes
              .filter((process) => process.scope === record.id)
              .map(({ pid, name }) => ({ pid, name }))
          : [],
    }));
  }
  private async removeCache(record: ScopeRecord, apply: boolean) {
    const path = this.cachePath(record);
    const entry = lstatSync(path, { throwIfNoEntry: false });
    if (entry) {
      if (
        entry.isSymbolicLink() ||
        realpathSync(path) !== path ||
        realpathSync(this.cacheRoot) !== this.cacheRoot
      )
        throw new Error('Run cache path was replaced; files were preserved');
      if (!apply && (await readdir(path)).length) return false;
      const workspaces = [
        ...this.store.workspaces().map((workspace) => workspace.repoPath),
        ...this.store.groups().map((group) => group.workspace?.repoPath),
        ...this.store
          .tasks()
          .flatMap((task) => [task.repoPath, task.authorWorktree, task.reviewerWorktree]),
      ];
      if (workspaces.some((workspace) => workspace === path || workspace?.startsWith(path + '/')))
        return false;
      if (entry.uid !== this.table.service.uid)
        throw new Error('Run cache ownership changed; files were preserved');
      if (
        this.mounts().some(
          (mount) => mount === this.cacheRoot || mount === path || mount.startsWith(path + '/'),
        )
      )
        return false;
      await rm(path, { recursive: true });
    }
    this.store.db.prepare('DELETE FROM settings WHERE key=?').run(prefix + record.id);
    return true;
  }
  async reclaim(groupId: string, removeCaches = false, signal?: AbortSignal) {
    return this.lock(groupId, async () => {
      const results = [];
      const active = this.records(groupId).some(
        (record) => record.kind !== 'maintenance' && !this.eligible(record),
      );
      for (const record of this.records(groupId).filter((record) => this.eligible(record))) {
        signal?.throwIfAborted();
        const result = await this.stop(record);
        record.state = 'finished';
        this.save(record);
        const cacheRemoved =
          !active && !result.remaining.length && (await this.removeCache(record, removeCaches));
        results.push({ runId: record.runId, ...result, cacheRemoved });
      }
      return results;
    });
  }
  async recover(removeCaches = false) {
    const groups = new Set(this.records().map((record) => record.groupId));
    for (const groupId of groups) await this.reclaim(groupId, removeCaches);
  }
}
