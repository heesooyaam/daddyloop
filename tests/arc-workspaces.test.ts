import { it, expect } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArcBridge, type ArcLease } from '../src/integrations/arcadia.js';
import { ArcWorkspaces } from '../src/runtime/arc-workspaces.js';
import { fixture } from './helpers.js';
class MountFixture extends ArcBridge {
  calls: string[][] = [];
  owner?: string;
  hash = 'b'.repeat(40);
  branch = 'trunk';
  status = '';
  failCheckout = false;
  control = true;
  override async mounts() {
    return [
      { path: '/fake/arc-source', claimable: true, object_store_ok: true },
      {
        path: '/fake/arc-worker',
        claimable: !this.owner,
        object_store_ok: true,
        lease_owner_id: this.owner,
      },
      ...(this.control
        ? [{ path: '/fake/arc-control', claimable: true, object_store_ok: true }]
        : []),
    ];
  }
  override async claim(ownerId: string, mount?: string): Promise<ArcLease> {
    expect(mount).toBe('/fake/arc-worker');
    this.owner = ownerId;
    return { ownerId, mount: mount!, objectStore: '/fake/shared-store' };
  }
  override async release() {
    this.owner = undefined;
  }
  override async native(args: string[]) {
    this.calls.push(args);
    if (args[0] === 'status') return this.status;
    if (args[0] === 'info') return JSON.stringify({ hash: this.hash, branch: this.branch });
    if (args[0] === 'merge-base') return args[2];
    if (args[0] === 'checkout') {
      if (this.failCheckout) throw new Error('Simulated process interruption');
      if (args[1] === '-b') {
        this.branch = args[2];
        this.hash = args[3];
      } else {
        this.branch = '';
        this.hash = args[1];
      }
    }
    return '';
  }
}
it('retains the named author branch when its pushed head becomes the next review revision', async () => {
  const f = await fixture({
    repoPath: '/fake/arc-source',
    revision: { head: 'a'.repeat(40), base: 'b'.repeat(40), start: 'b'.repeat(40) },
  });
  const dir = mkdtempSync(join(tmpdir(), 'daddyloop-arc-test-')),
    bridge = new MountFixture(),
    workspaces = new ArcWorkspaces(dir, bridge);
  try {
    await workspaces.prepare(f.task, 'author');
    const branch = bridge.branch;
    bridge.hash = 'c'.repeat(40);
    f.task.revision!.head = bridge.hash;
    f.task.generation++;
    await workspaces.prepare(f.task, 'author');
    expect(bridge.branch).toBe(branch);
    expect(bridge.calls.filter((call) => call[0] === 'checkout')).toHaveLength(1);
  } finally {
    f.store.close();
    rmSync(dir, { recursive: true });
  }
});
it('keeps a control workspace available when the writer pool would consume the last Arc mount', async () => {
  const f = await fixture({
    repoPath: '/fake/arc-source',
    revision: { head: 'a'.repeat(40), base: 'b'.repeat(40), start: 'b'.repeat(40) },
  });
  const dir = mkdtempSync(join(tmpdir(), 'daddy-arc-capacity-')),
    bridge = new MountFixture();
  bridge.control = false;
  const workspaces = new ArcWorkspaces(dir, bridge);
  try {
    await expect(workspaces.prepare(f.task, 'author')).rejects.toMatchObject({
      code: 'workspace_capacity',
    });
    expect(bridge.owner).toBeUndefined();
    expect(bridge.calls).toEqual([]);
    expect(await workspaces.prepare(f.task, 'reviewer')).toBe('/fake/arc-worker');
  } finally {
    f.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
it('recovers the lease journal after interrupted checkout and refuses to start an author on trunk', async () => {
  const f = await fixture({
    repoPath: '/fake/arc-source',
    revision: { head: 'a'.repeat(40), base: 'b'.repeat(40), start: 'b'.repeat(40) },
  });
  const dir = mkdtempSync(join(tmpdir(), 'daddyloop-arc-test-')),
    bridge = new MountFixture(),
    workspaces = new ArcWorkspaces(dir, bridge);
  bridge.failCheckout = true;
  try {
    await expect(workspaces.prepare(f.task, 'author')).rejects.toThrow('interruption');
    const journal = JSON.parse(
      readFileSync(join(dir, 'arc-leases', `${f.task.id}-author.json`), 'utf8'),
    );
    expect(journal.ownerId).toBe(bridge.owner);
    f.task.arcWorkspaces = undefined;
    await expect(workspaces.prepare(f.task, 'author')).rejects.toThrow('checkout was interrupted');
    expect(bridge.branch).toBe('trunk');
    expect(bridge.owner).toBe(journal.ownerId);
  } finally {
    f.store.close();
    rmSync(dir, { recursive: true });
  }
});
