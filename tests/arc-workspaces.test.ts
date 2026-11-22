import { it, expect, vi } from 'vitest';
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
  pushedHead?: string;
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
    if (args[0] === 'push') this.pushedHead = this.hash;
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

it.each(['head', 'branch', 'lease'] as const)(
  'stops the saved fix push if the author %s changes during the second PR read',
  async (changed) => {
    const f = await fixture({ repoPath: '/fake/arc-source' });
    const dir = mkdtempSync(join(tmpdir(), 'daddyloop-arc-push-'));
    try {
      const bridge = new MountFixture();
      const workspaces = new ArcWorkspaces(dir, bridge);
      const task = f.task;
      task.pr!.branch = 'users/worker/fix';
      await workspaces.prepare(task, 'author');
      const { branch, owner } = bridge;
      const head = 'c'.repeat(40);
      bridge.hash = head;
      task.state = 'awaiting_push';
      task.pendingAuthorHead = head;
      task.pendingAuthorFix = { revision: task.revision!, generation: task.generation };
      f.store.saveTask(task);
      vi.spyOn(f.provider, 'getPR')
        .mockImplementation(async () => ({ ...task.pr!, head: bridge.pushedHead ?? task.pr!.head }))
        .mockImplementationOnce(async () => task.pr!)
        .mockImplementationOnce(async () => {
          if (changed === 'head') bridge.hash = 'd'.repeat(40);
          if (changed === 'branch') bridge.branch += '-other';
          if (changed === 'lease') bridge.owner = 'another-owner';
          return task.pr!;
        });
      const submit = () =>
        f.engine.submitSavedFix(task.id, (current, saved) =>
          workspaces.prepareSavedFixPush(current, saved),
        );
      await submit();
      expect(bridge.pushedHead).toBeUndefined();
      const blocked = f.store.getTask(task.id);
      expect(blocked).toMatchObject({
        state: 'needs_input',
        pendingAuthorHead: head,
        reason: expect.stringContaining(head),
      });
      expect(blocked.pendingAuthorFix?.pushStarted).toBeUndefined();
      expect(blocked.pendingAuthorFix?.confirmUntil).toBeUndefined();
      Object.assign(bridge, { hash: head, branch, owner });
      await f.engine.action(task.id, 'resume');
      await submit();
      expect(bridge.pushedHead).toBe(head);
      expect(f.store.getTask(task.id)).toMatchObject({ state: 'queued', revision: { head } });
    } finally {
      f.store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

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
it('keeps a control workspace available when the worker pool would consume the last Arc mount', async () => {
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
