import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { command } from '../ops/process.js';
import { defaultDataDir, loadConfig } from '../ops/config.js';
import { credential } from '../core/security.js';
import { AppError } from '../core/types.js';
import { resources } from '../core/resources.js';
import { leaseHelper } from './arc-lease.js';
import { ManagedArcMounts, type ArcCheckpoint } from './arc-managed.js';
import type { Role, Task } from '../core/types.js';
export { leaseHelper } from './arc-lease.js';

export interface ArcLease {
  mount: string;
  ownerId: string;
  objectStore: string;
  managed?: { sessionId: string; taskId: string; role: Role };
}
export interface ArcNativePR {
  id: number;
  url: string;
  summary: string;
  description: string;
  status: string;
  author: string;
  from_id: string;
  from_branch: string;
  to_branch: string;
}
export class ArcBridge {
  constructor(
    readonly dataDir = defaultDataDir(),
    private readonly leaseHelperPath?: string,
  ) {}
  private selectedHelper() {
    return this.leaseHelperPath ?? leaseHelper();
  }
  private managedMounts() {
    return new ManagedArcMounts(this.dataDir, undefined, undefined, () => this.selectedHelper());
  }
  private helper(args: string[], options: Parameters<typeof command>[2] = {}) {
    return command('bash', [this.selectedHelper(), ...args], options);
  }
  async mounts() {
    const r = await this.helper(['--json', 'status']);
    const value = JSON.parse(r.stdout);
    if (value.status !== 'success' || !Array.isArray(value.data?.mounts))
      throw new Error('The Arc lease helper returned an invalid mount inventory');
    return [
      ...new Map(
        [...value.data.mounts, ...(await this.managedMounts().status())].map((mount) => [
          mount.path,
          mount,
        ]),
      ).values(),
    ] as {
      path: string;
      claimable: boolean;
      object_store_ok: boolean;
      lease_owner_id?: string;
      mounted?: boolean;
      number?: number;
      reserved?: boolean;
      claim_blockers?: string[];
      managed?: boolean;
    }[];
  }
  async sourceMounts() {
    const managed = this.managedMounts();
    return (await managed.nativeMounts()).filter(
      (mount) => !mount.mount.startsWith(managed.root + '/'),
    );
  }
  async sessionMount(task: Pick<Task, 'id' | 'groupId'>, role: Role, signal?: AbortSignal) {
    return this.managedMounts().ensure(task.groupId ?? task.id, task.id, role, signal);
  }
  saveSessionCheckpoint(lease: ArcLease, value: ArcCheckpoint) {
    this.managedMounts().checkpoint(lease, value);
  }
  async parkSessionMount(lease: ArcLease) {
    return this.managedMounts().park(lease);
  }
  async withValidatedJournals<T>(fn: () => Promise<T>) {
    const managed = this.managedMounts();
    managed.validateSessionRoot();
    return managed.withJournalLock(async () => {
      await managed.validateHelperConfig();
      await this.mounts();
      return fn();
    });
  }
  async provision(exclude?: string): Promise<boolean> {
    const candidate = (await this.mounts()).find(
      (mount) =>
        mount.path !== exclude &&
        mount.mounted === false &&
        !mount.reserved &&
        Number.isInteger(mount.number) &&
        mount.claim_blockers?.length === 1 &&
        mount.claim_blockers[0] === 'unmounted',
    );
    if (!candidate) return false;
    const status = resources(homedir(), loadConfig().resources);
    if (!status.ok) throw new AppError('resource_limit', status.reasons.join('; '), 422);
    await this.helper(['--json', 'mount', String(candidate.number)], {
      timeoutMs: 120000,
    });
    return true;
  }
  async claim(ownerId: string, mount?: string): Promise<ArcLease> {
    const result = await this.helper([
      '--json',
      'claim',
      '--owner-id',
      ownerId,
      ...(mount ? [mount, 'daddyloop workspace'] : ['--note', 'daddyloop workspace']),
    ]);
    const value = JSON.parse(result.stdout) as {
      status: string;
      data: { mount: string; object_store_ok: boolean; object_store: string };
    };
    if (value.status !== 'success' || value.data.object_store_ok !== true)
      throw new Error('Arc mount is not safely leased with the configured shared object store');
    return { mount: value.data.mount, ownerId, objectStore: value.data.object_store };
  }
  async release(lease: ArcLease) {
    if (lease.managed) return this.managedMounts().releaseLease(lease);
    await this.helper(['--json', 'release', '--owner-id', lease.ownerId, lease.mount]);
  }
  async native(args: string[], mount: string, signal?: AbortSignal) {
    return (await command('arc', args, { cwd: mount, timeoutMs: 120000, signal })).stdout.trimEnd();
  }
  async withMount<T>(fn: (mount: string) => Promise<T>) {
    if (
      !(await this.mounts()).some(
        (mount) => mount.claimable && mount.object_store_ok && !mount.managed,
      )
    ) {
      const id = randomUUID();
      const managed = this.managedMounts();
      const { lease } = await managed.ensure(id, id, 'reviewer');
      const initial = await this.native(['info', '--json'], lease.mount);
      if (await this.native(['status', '--short', '-u', 'all'], lease.mount))
        throw new Error('The new Arc metadata copy contains changes; it was preserved');
      try {
        return await fn(lease.mount);
      } finally {
        if (
          initial !== (await this.native(['info', '--json'], lease.mount)) ||
          (await this.native(['status', '--short', '-u', 'all'], lease.mount))
        )
          throw new Error('The Arc metadata copy changed; it was preserved');
        const record = managed.records(id)[0];
        if (record) await managed.remove(record);
      }
    }
    const lease = await this.claim(`daddyloop-read-${randomUUID()}`);
    try {
      return await fn(lease.mount);
    } finally {
      await this.release(lease);
    }
  }
  async metadata(id: number) {
    return this.withMount(async (mount) => {
      const pr = JSON.parse(
        await this.native(['pr', 'status', String(id), '--json'], mount),
      ) as ArcNativePR;
      const identity = JSON.parse(await this.native(['info', '--json'], mount)) as {
        user_login: string;
      };
      if (!/^[a-f0-9]{40}$/.test(pr.from_id))
        throw new Error('Arc returned an invalid head revision');
      if (!pr.to_branch || pr.to_branch.startsWith('-'))
        throw new Error('Arc returned an invalid target branch');
      const base = await this.native(['merge-base', '--leftmost', pr.from_id, pr.to_branch], mount);
      if (!/^[a-f0-9]{40}$/.test(base))
        throw new Error('Arc did not return a full merge-base revision');
      return { pr, base, user: identity.user_login };
    });
  }
  async api<T>(args: string[], mutation = false): Promise<T> {
    const token = credential('arcadia', 'a.yandex-team.ru');
    const ca =
      process.env.NODE_EXTRA_CA_CERTS ??
      ['/usr/local/share/ca-certificates/Yandex/RootCA.crt', '/etc/ssl/certs/yandex-ca.pem'].find(
        existsSync,
      );
    let result: Awaited<ReturnType<typeof command>>;
    try {
      result = await command(loadConfig().arcadia.arcanumCli, ['--json', ...args], {
        env: {
          ARC_TOKEN: token,
          DISABLE_AUTO_FETCH_TOKEN: 'true',
          NODE_USE_SYSTEM_CA: '1',
          ...(ca ? { NODE_EXTRA_CA_CERTS: ca } : {}),
          ARCANUM_CLI_RETRY_MAX_ATTEMPTS: mutation ? '1' : '3',
        },
        timeoutMs: 90000,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        throw new AppError(
          'arcanum_cli_missing',
          'Install @yandex-tools/ai-arcanum-cli so arcanum-cli is on PATH',
          422,
        );
      throw error;
    }
    let data: unknown;
    try {
      data = JSON.parse(result.stdout);
    } catch {
      throw new Error('arcanum-cli returned incomplete/non-JSON output');
    }
    if (
      data &&
      typeof data === 'object' &&
      ('error' in data || ('errors' in data && Array.isArray(data.errors) && data.errors.length))
    )
      throw new Error('Arcanum returned an API error; inspect its local CLI output');
    return (data && typeof data === 'object' && 'data' in data ? data.data : data) as T;
  }
  async activeDiff(id: number) {
    const value = await this.api<{ id: number }>([
      'diff',
      'get',
      '--pr',
      String(id),
      '--fields',
      'id',
    ]);
    if (!Number.isSafeInteger(value.id))
      throw new Error('Arcanum did not return an active diff ID');
    return String(value.id);
  }
  async doctor(workspace?: string) {
    const sources = await this.sourceMounts();
    let sourcePath: string;
    if (workspace) {
      const selected = realpathSync(workspace);
      const source = sources.find(
        (mount) =>
          mount.status === 'mounted' &&
          (selected === mount.mount || selected.startsWith(mount.mount + '/')),
      );
      if (!source) throw new Error('The selected Arcadia source is not mounted');
      sourcePath = source.mount;
    } else {
      const source = sources.find((mount) => mount.status === 'mounted');
      if (!source) throw new Error('Choose an existing mounted Arcadia source with --workspace');
      sourcePath = source.mount;
    }
    // Verify the review transport, helper and existing journals without creating a probe copy.
    await this.api(['repo', 'list', '--fields', 'repos(id)']);
    await this.mounts();
    const identity = JSON.parse(await this.native(['info', '--json'], sourcePath)) as {
      user_login: string;
      hash: string;
      branch: string;
    };
    return { ...identity, source: sourcePath };
  }
}
