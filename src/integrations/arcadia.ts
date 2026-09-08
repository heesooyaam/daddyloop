import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { command } from '../ops/process.js';
import { loadConfig } from '../ops/config.js';
import { credential } from '../core/security.js';
import { AppError } from '../core/types.js';

export interface ArcLease {
  mount: string;
  ownerId: string;
  objectStore: string;
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
export function leaseHelper() {
  const configured =
    loadConfig().arcadia.leaseHelper ?? process.env.REVIEWLOOP_ARCADIA_LEASE_HELPER;
  if (configured) return configured;
  const candidates = (process.env.PATH ?? '')
    .split(':')
    .map((path) => join(path, 'arcadia-mount-lease'));
  for (const base of ['.agents', '.codex', '.claude', '.cursor'])
    candidates.push(join(homedir(), base, 'skills/arcadia-mounts/scripts/arcadia-mount-lease'));
  const path = candidates.find(existsSync);
  if (!path)
    throw new AppError(
      'arcadia_lease_helper_missing',
      'Configure the company arcadia-mount-lease helper with reviewctl arcadia setup --lease-helper <path>',
      422,
    );
  return path;
}
export class ArcBridge {
  async mounts() {
    const r = await command(leaseHelper(), ['--json', 'status']);
    return JSON.parse(r.stdout).data.mounts as {
      path: string;
      claimable: boolean;
      object_store_ok: boolean;
      lease_owner_id?: string;
    }[];
  }
  async claim(ownerId: string, mount?: string): Promise<ArcLease> {
    const result = await command(leaseHelper(), [
      '--json',
      'claim',
      '--owner-id',
      ownerId,
      ...(mount ? [mount, 'Reviewloop workspace'] : ['--note', 'Reviewloop workspace']),
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
    await command(leaseHelper(), ['--json', 'release', '--owner-id', lease.ownerId, lease.mount]);
  }
  async native(args: string[], mount: string, signal?: AbortSignal) {
    return (await command('arc', args, { cwd: mount, timeoutMs: 120000, signal })).stdout.trimEnd();
  }
  async withMount<T>(fn: (mount: string) => Promise<T>) {
    const lease = await this.claim(`reviewloop-read-${randomUUID()}`);
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
    const result = await command(loadConfig().arcadia.arcanumCli, ['--json', ...args], {
      env: {
        ARC_TOKEN: token,
        DISABLE_AUTO_FETCH_TOKEN: 'true',
        NODE_USE_SYSTEM_CA: '1',
        ...(ca ? { NODE_EXTRA_CA_CERTS: ca } : {}),
        ARCANUM_CLI_RETRY_MAX_ATTEMPTS: mutation ? '1' : '3',
      },
      timeoutMs: 90000,
    });
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
    if (!existsSync(join(homedir(), '.tokens/arcadia')) && !process.env.ARC_TOKEN)
      throw new Error('Configure ~/.tokens/arcadia or ARC_TOKEN');
    if (workspace) {
      const lease = await this.claim(`reviewloop-doctor-${randomUUID()}`, workspace);
      try {
        return JSON.parse(await this.native(['info', '--json'], lease.mount)) as {
          user_login: string;
          hash: string;
          branch: string;
        };
      } finally {
        await this.release(lease);
      }
    }
    return this.withMount(
      async (mount) =>
        JSON.parse(await this.native(['info', '--json'], mount)) as {
          user_login: string;
          hash: string;
          branch: string;
        },
    );
  }
}
