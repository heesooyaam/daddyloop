import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { command } from '../ops/process.js';
import { defaultDataDir, loadConfig, privateWrite } from '../ops/config.js';
import { resources } from '../core/resources.js';
import { AppError, type Role } from '../core/types.js';
import { leaseHelper } from './arc-lease.js';
import type { ArcLease } from './arcadia.js';

const identity = z.string().regex(/^[a-f0-9]{32}$|^[a-f0-9-]{36}$/);
const checkpointSchema = z.object({
  initialHash: z.string().regex(/^[a-f0-9]{40}$/),
  initialBranch: z.string(),
  baseHead: z.string().regex(/^[a-f0-9]{40}$/),
  prepared: z.boolean().optional(),
  targetBranch: z.string().optional(),
});
export type ArcCheckpoint = z.infer<typeof checkpointSchema>;
const recordSchema = z.object({
  version: z.literal(1),
  sessionId: identity,
  taskId: identity,
  role: z.enum(['author', 'reviewer']),
  ownerId: z.string(),
  mount: z.string(),
  store: z.string(),
  objectStore: z.string(),
  leaseRoot: z.string(),
  state: z.enum(['creating', 'ready', 'removing']),
  checkpoint: checkpointSchema.optional(),
});
export type ManagedArcRecord = z.infer<typeof recordSchema>;
export interface NativeArcMount {
  status: string;
  mount: string;
  store: string;
  'object-store': string;
}
const configSchema = z.object({
  status: z.literal('success'),
  data: z.object({
    object_store: z.string().min(1),
    lease_root: z.string().min(1),
    store_root: z.string().min(1),
    mount_prefix: z.string().min(1),
    mount_start: z.number().int(),
    mount_end: z.number().int(),
    extra_mounts: z.string(),
    human_reserved_mount_numbers: z.string(),
  }),
});
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

/** Only paths with an owned journal under this data directory can be created or removed. */
export class ManagedArcMounts {
  private static locks = new Map<string, Promise<void>>();
  readonly root: string;
  constructor(
    readonly dataDir = defaultDataDir(),
    private run: typeof command = command,
    private resourceCheck = () => {
      const status = resources(dataDir, loadConfig().resources);
      if (!status.ok) throw new AppError('resource_limit', status.reasons.join('; '), 422);
    },
    private helper: () => string = leaseHelper,
  ) {
    this.root = join(resolve(dataDir), 'arcadia-sessions');
  }
  private async lock<T>(fn: () => Promise<T>): Promise<T> {
    const before = ManagedArcMounts.locks.get(this.root) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    ManagedArcMounts.locks.set(this.root, next);
    await before;
    try {
      return await fn();
    } finally {
      release();
      if (ManagedArcMounts.locks.get(this.root) === next) ManagedArcMounts.locks.delete(this.root);
    }
  }
  directory(sessionId: string, taskId: string, role: Role) {
    identity.parse(sessionId);
    identity.parse(taskId);
    return join(this.root, sessionId, `${taskId}-${role}`);
  }
  private safeDirectory(path: string, create = false) {
    const data = realpathSync(this.dataDir);
    if (resolve(this.dataDir) !== data)
      throw new Error('Managed Arc copies require a data directory without symlink aliases');
    const relative = path.slice(this.root.length);
    if (!path.startsWith(this.root + '/') && path !== this.root)
      throw new Error('Arc copy escaped its managed directory');
    let at = this.root;
    for (const part of ['', ...relative.split('/').filter(Boolean)]) {
      if (part) at = join(at, part);
      let entry = lstatSync(at, { throwIfNoEntry: false });
      if (!entry) {
        if (!create) return;
        mkdirSync(at, { mode: 0o700 });
        entry = lstatSync(at);
      }
      if (entry.isSymbolicLink() || !entry.isDirectory() || realpathSync(at) !== at)
        throw new Error('The managed Arc directory was replaced or redirected');
    }
  }
  records(sessionId?: string): ManagedArcRecord[] {
    if (sessionId) identity.parse(sessionId);
    if (!lstatSync(this.root, { throwIfNoEntry: false })) return [];
    this.safeDirectory(this.root);
    const sessions = sessionId
      ? [sessionId]
      : readdirSync(this.root).filter((id) => identity.safeParse(id).success);
    const result: ManagedArcRecord[] = [];
    for (const id of sessions) {
      const parent = join(this.root, id);
      if (!existsSync(parent)) continue;
      this.safeDirectory(parent);
      for (const child of readdirSync(parent, { withFileTypes: true })) {
        if (!child.isDirectory() || child.isSymbolicLink())
          throw new Error('Unexpected entry in the managed Arc session directory');
        const directory = join(parent, child.name);
        this.safeDirectory(directory);
        const file = join(directory, 'owner.json');
        if (!existsSync(file)) throw new Error('Managed Arc copy has no ownership journal');
        if (lstatSync(file).isSymbolicLink()) throw new Error('Arc ownership journal is a symlink');
        const record = recordSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
        if (
          record.sessionId !== id ||
          this.directory(id, record.taskId, record.role) !== directory ||
          record.mount !== join(directory, 'checkout') ||
          record.store !== join(directory, 'store') ||
          !record.ownerId.startsWith(`daddyloop-${record.taskId}-${record.role}-`)
        )
          throw new Error('Arc ownership journal does not match this session copy');
        result.push(record);
      }
    }
    return result;
  }
  private save(record: ManagedArcRecord) {
    const directory = this.directory(record.sessionId, record.taskId, record.role);
    this.safeDirectory(directory, true);
    privateWrite(
      join(directory, 'owner.json'),
      JSON.stringify(recordSchema.parse(record), null, 2),
    );
  }
  async nativeMounts(): Promise<NativeArcMount[]> {
    const output = await this.run('arc', ['mount', '-l', '--json']);
    return z
      .array(
        z.object({
          status: z.string(),
          mount: z.string(),
          store: z.string(),
          'object-store': z.string(),
        }),
      )
      .parse(JSON.parse(output.stdout));
  }
  private async config(records: ManagedArcRecord[], file: string) {
    const base = configSchema.parse(
      JSON.parse((await this.run(this.helper(), ['--json', 'config'])).stdout),
    ).data;
    for (const shared of [base.object_store, base.lease_root]) {
      const path = existsSync(shared) ? realpathSync(shared) : resolve(shared);
      if (!shared.startsWith('/') || path === this.root || path.startsWith(this.root + '/'))
        throw new Error(
          'Shared Arc objects and leases must live outside the disposable session directory',
        );
    }
    if (
      records.some(
        (record) =>
          record.objectStore !== base.object_store || record.leaseRoot !== base.lease_root,
      )
    )
      throw new Error(
        'The Arc shared store or lease root changed; existing session copies were preserved',
      );
    if (records.some((record) => /\s/.test(record.mount)))
      throw new Error(
        'The configured Arc lease helper cannot represent paths containing whitespace',
      );
    const entries = {
      ARCADIA_MOUNT_PREFIX: base.mount_prefix,
      ARCADIA_MOUNT_START: String(base.mount_start),
      ARCADIA_MOUNT_END: String(base.mount_end),
      ARCADIA_EXTRA_MOUNTS: [
        ...new Set([
          ...base.extra_mounts
            .split(/\s+/)
            .filter(Boolean)
            .map((path) => (path.startsWith('/') ? path : join(homedir(), path))),
          ...records.map((record) => record.mount),
        ]),
      ].join(' '),
      ARCADIA_OBJECT_STORE: base.object_store,
      ARCADIA_STORE_ROOT: base.store_root,
      ARCADIA_LEASE_ROOT: base.lease_root,
      ARCADIA_HUMAN_RESERVED_MOUNT_NUMBERS: base.human_reserved_mount_numbers,
    };
    privateWrite(
      file,
      Object.entries(entries)
        .map(([key, value]) => `${key}=${quote(value)}`)
        .join('\n') + '\n',
    );
    return file;
  }
  private recordConfig(record: ManagedArcRecord) {
    return this.config(
      [record],
      join(this.directory(record.sessionId, record.taskId, record.role), 'lease.env'),
    );
  }
  async status() {
    const records = this.records().filter((record) => record.state !== 'creating');
    if (!records.length) return [];
    const file = await this.config(records, join(this.dataDir, 'arcadia-session-leases.env'));
    const value = JSON.parse(
      (await this.run(this.helper(), ['--json', '--config', file, 'status'])).stdout,
    );
    if (value.status !== 'success' || !Array.isArray(value.data?.mounts))
      throw new Error('The Arc lease helper returned an invalid session inventory');
    return value.data.mounts
      .filter((mount: { path: string }) => records.some((record) => record.mount === mount.path))
      .map((mount: object) => ({ ...mount, managed: true }));
  }
  async ensure(sessionId: string, taskId: string, role: Role, signal?: AbortSignal) {
    return this.lock(async () => {
      signal?.throwIfAborted();
      if (/\s/.test(this.root))
        throw new Error('Automatic Arc copies require a data directory without whitespace');
      const directory = this.directory(sessionId, taskId, role);
      this.safeDirectory(join(this.root, sessionId), true);
      let record = this.records(sessionId).find(
        (record) => record.taskId === taskId && record.role === role,
      );
      if (!record) {
        this.resourceCheck();
        if (existsSync(directory)) throw new Error('The target Arc copy directory already exists');
        const base = configSchema.parse(
          JSON.parse((await this.run(this.helper(), ['--json', 'config'])).stdout),
        ).data;
        record = {
          version: 1,
          sessionId,
          taskId,
          role,
          ownerId: `daddyloop-${taskId}-${role}-${randomUUID()}`,
          mount: join(directory, 'checkout'),
          store: join(directory, 'store'),
          objectStore: base.object_store,
          leaseRoot: base.lease_root,
          state: 'creating',
        };
        this.save(record);
      }
      if (record.state === 'removing') throw new Error('This session copy is being removed');
      const file = await this.recordConfig(record);
      const current = (await this.nativeMounts()).find((mount) => mount.mount === record.mount);
      if (
        current &&
        (current.store !== record.store || current['object-store'] !== record.objectStore)
      )
        throw new Error('The session mount was replaced with another Arc store');
      if (current?.status !== 'mounted') {
        this.resourceCheck();
        for (const path of [record.mount, record.store]) this.safeDirectory(path, true);
        await this.run(
          'arc',
          [
            'mount',
            '-m',
            record.mount,
            '-S',
            record.store,
            '--object-store',
            record.objectStore,
            '--override-object-store',
          ],
          { timeoutMs: 120000, signal },
        );
      }
      signal?.throwIfAborted();
      const mounted = (await this.nativeMounts()).find((mount) => mount.mount === record!.mount);
      if (
        mounted?.status !== 'mounted' ||
        mounted.store !== record.store ||
        mounted['object-store'] !== record.objectStore
      )
        throw new Error('Arc mounted the copy with unexpected storage paths; it was preserved');
      const inventory = JSON.parse(
        (await this.run(this.helper(), ['--json', '--config', file, 'status'], { signal })).stdout,
      );
      const existing = inventory.data?.mounts?.find(
        (mount: { path: string }) => mount.path === record!.mount,
      );
      if (existing?.lease_owner_id && existing.lease_owner_id !== record.ownerId)
        throw new Error('The session copy is leased by another owner; it was preserved');
      if (existing?.lease_owner_id !== record.ownerId) {
        const claimed = JSON.parse(
          (
            await this.run(
              this.helper(),
              [
                '--json',
                '--config',
                file,
                'claim',
                '--owner-id',
                record.ownerId,
                record.mount,
                'daddyloop session copy',
              ],
              { signal },
            )
          ).stdout,
        );
        if (
          claimed.status !== 'success' ||
          claimed.data?.mount !== record.mount ||
          claimed.data?.object_store_ok !== true
        )
          throw new Error('Could not verify the session copy lease');
      } else if (!existing.mounted || !existing.object_store_ok) {
        throw new Error('The owned session copy is not mounted with its shared store');
      }
      record.state = 'ready';
      this.save(record);
      return {
        lease: {
          mount: record.mount,
          ownerId: record.ownerId,
          objectStore: record.objectStore,
          managed: { sessionId, taskId, role },
        } satisfies ArcLease,
        checkpoint: record.checkpoint,
        wasMounted: current?.status === 'mounted',
      };
    });
  }
  checkpoint(lease: ArcLease, value: z.infer<typeof checkpointSchema>) {
    if (!lease.managed) return;
    const record = this.records(lease.managed.sessionId).find(
      (record) => record.mount === lease.mount,
    );
    if (!record || record.ownerId !== lease.ownerId)
      throw new Error('Arc session copy ownership changed');
    record.checkpoint = checkpointSchema.parse(value);
    this.save(record);
  }
  async releaseLease(lease: ArcLease) {
    if (!lease.managed) throw new Error('Expected a managed Arc lease');
    const record = this.records(lease.managed.sessionId).find(
      (record) => record.mount === lease.mount,
    );
    if (!record || record.ownerId !== lease.ownerId)
      throw new Error('Arc session copy ownership changed');
    const file = await this.recordConfig(record);
    await this.run(this.helper(), [
      '--json',
      '--config',
      file,
      'release',
      '--owner-id',
      lease.ownerId,
      lease.mount,
    ]);
  }
  /** Stop an idle FUSE process, keeping its store, branch, files and ownership for the session. */
  async park(lease: ArcLease) {
    if (!lease.managed) throw new Error('Expected a managed Arc copy');
    return this.lock(async () => {
      const record = this.records(lease.managed!.sessionId).find(
        (record) => record.mount === lease.mount,
      );
      if (!record || record.ownerId !== lease.ownerId || record.state !== 'ready')
        throw new Error('The session copy ownership changed');
      const native = (await this.nativeMounts()).find((mount) => mount.mount === record.mount);
      if (native?.status !== 'mounted') return;
      this.safeDirectory(record.mount);
      this.safeDirectory(record.store);
      if (native.store !== record.store || native['object-store'] !== record.objectStore)
        throw new Error('The session mount was replaced with another Arc store');
      const file = await this.recordConfig(record);
      const status = JSON.parse(
        (await this.run(this.helper(), ['--json', '--config', file, 'status'])).stdout,
      );
      const owned = status.data?.mounts?.find(
        (mount: { path: string }) => mount.path === record.mount,
      );
      if (owned?.lease_owner_id !== record.ownerId)
        throw new Error('The Arc session lease changed');
      await this.run('arc', ['unmount', record.mount], { cwd: this.dataDir, timeoutMs: 120000 });
    });
  }
  /** Caller has stopped every session run and durably exported its changes. Never force-unmount. */
  async remove(record: ManagedArcRecord) {
    return this.lock(async () => {
      const saved = this.records(record.sessionId).find((value) => value.mount === record.mount);
      if (!saved) return;
      if (saved.ownerId !== record.ownerId)
        throw new Error('Arc copy owner changed during removal');
      const directory = this.directory(record.sessionId, record.taskId, record.role);
      const unexpected = readdirSync(directory).filter(
        (name) => !['owner.json', 'lease.env', 'checkout', 'store'].includes(name),
      );
      if (unexpected.length) throw new Error('Unexpected files beside the Arc copy were preserved');
      const file = await this.recordConfig(saved);
      this.safeDirectory(saved.store);
      this.safeDirectory(saved.mount);
      const native = (await this.nativeMounts()).find((mount) => mount.mount === saved.mount);
      if (native) {
        if (native.store !== saved.store || native['object-store'] !== saved.objectStore)
          throw new Error('Refusing to remove an Arc mount whose store changed');
        const status = JSON.parse(
          (await this.run(this.helper(), ['--json', '--config', file, 'status'])).stdout,
        );
        const owned = status.data?.mounts?.find(
          (mount: { path: string }) => mount.path === saved.mount,
        );
        if (owned?.lease_owner_id !== saved.ownerId)
          throw new Error('Refusing to remove an Arc copy owned by another process');
        saved.state = 'removing';
        this.save(saved);
        await this.run('arc', ['unmount', '--forget', saved.mount], {
          cwd: this.dataDir,
          timeoutMs: 120000,
        });
      } else if (existsSync(saved.store)) {
        throw new Error(
          'Arc no longer knows this copy; its local store was preserved for recovery',
        );
      }
      if ((await this.nativeMounts()).some((mount) => mount.mount === saved.mount))
        throw new Error('Arc still reports the session copy; local files were preserved');
      await this.run(this.helper(), [
        '--json',
        '--config',
        file,
        'release',
        '--owner-id',
        saved.ownerId,
        saved.mount,
      ]);
      for (const path of [saved.mount, saved.store]) if (existsSync(path)) rmdirSync(path);
      unlinkSync(join(directory, 'lease.env'));
      unlinkSync(join(directory, 'owner.json'));
      rmdirSync(directory);
      const parent = dirname(directory);
      if (!readdirSync(parent).length) rmdirSync(parent);
    });
  }
}
