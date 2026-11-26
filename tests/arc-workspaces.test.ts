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

it('recovers the saved Arc hash and refuses a push from a different checkout hash', async () => {
  const f = await fixture({ repoPath: '/fake/arc-source' });
  const dir = mkdtempSync(join(tmpdir(), 'daddy-arc-fix-'));
  const bridge = new MountFixture();
  const workspaces = new ArcWorkspaces(dir, bridge);
  try {
    const task = f.task;
    task.pr!.branch = 'users/test/correction';
    await workspaces.prepare(task, 'author');
    bridge.hash = 'c'.repeat(40);
    const save = {
      runId: 'fix-run',
      generation: task.generation,
      revision: task.revision!,
      pr: task.pr!,
      ref: task.ref,
      summary: 'Saved correction',
    };
    const saved = await workspaces.commit(task, 'Save correction', undefined, save);
    await workspaces.pushSavedFix(task, saved);
    expect(bridge.calls.filter((args) => args[0] === 'push')).toEqual([
      ['push', `${saved}:users/test/correction`],
    ]);
    bridge.hash = 'd'.repeat(40);
    expect(await new ArcWorkspaces(dir, bridge).recoverFix(task, save)).toBe(saved);
    await expect(workspaces.pushSavedFix(task, saved)).rejects.toMatchObject({
      code: 'fix_before_push',
    });
    expect(bridge.calls.filter((args) => args[0] === 'push')).toHaveLength(1);
  } finally {
    f.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it.each([
  'normal',
  'branch moved',
  'amended before confirmation',
  'interrupted read',
  'amended after interrupted read',
  'missing command SHA',
])('attributes an Arc commit only to the marked save after %s', async (scenario) => {
  const moved = scenario === 'branch moved';
  const amended = scenario === 'amended before confirmation';
  const interrupted = scenario.includes('interrupted read');
  const noSha = scenario === 'missing command SHA';
  const f = await fixture({ repoPath: '/fake/arc-source' });
  const dir = mkdtempSync(join(tmpdir(), 'daddy-arc-moved-save-'));
  const bridge = new MountFixture();
  const workspaces = new ArcWorkspaces(dir, bridge);
  try {
    const task = f.task;
    await workspaces.prepare(task, 'author');
    bridge.status = ' M fixed.txt';
    const h2 = 'c'.repeat(40),
      h3 = 'd'.repeat(40);
    const native = bridge.native.bind(bridge);
    let title = '';
    let commits = 0;
    let failRead = interrupted;
    bridge.native = async (args) => {
      if (args[0] === 'commit') {
        commits++;
        title = args[2];
        const branch = bridge.branch;
        bridge.hash = moved || amended ? h3 : h2;
        if (moved) bridge.branch += '-different';
        return noSha ? '' : `[${branch} ${h2}] ${title}\n1 file changed`;
      }
      if (args[0] === 'log') {
        if (failRead) {
          failRead = false;
          throw new Error('Interrupted commit read');
        }
        return title;
      }
      return native(args);
    };
    const save = {
      runId: 'fix-run',
      generation: task.generation,
      revision: task.revision!,
      pr: task.pr!,
      ref: task.ref,
      summary: 'Saved correction',
    };
    const commit = workspaces.commit(task, 'Correct finding', undefined, save);
    const restarted = new ArcWorkspaces(dir, bridge);
    task.pr!.branch = 'users/test/correction';
    if (moved || amended || noSha) {
      await expect(commit).rejects.toThrow(
        noSha ? 'did not report an exact SHA' : 'did not confirm',
      );
      await expect(restarted.recoverFix(task, save)).rejects.toThrow();
    } else if (interrupted) {
      await expect(commit).rejects.toThrow('Interrupted commit read');
      if (scenario === 'amended after interrupted read') {
        bridge.hash = h3;
        await expect(restarted.recoverFix(task, save)).rejects.toThrow('did not confirm');
      } else {
        expect(await restarted.recoverFix(task, save)).toBe(h2);
      }
    } else expect(await commit).toBe(h2);
    const held = moved || amended || noSha || scenario === 'amended after interrupted read';
    if (!held) {
      expect(await restarted.recoverFix(task, save)).toBe(h2);
      await restarted.pushSavedFix(task, h2);
    } else if (!noSha) {
      expect(bridge.hash).toBe(h3);
      await expect(restarted.pushSavedFix(task, h2)).rejects.toMatchObject({
        code: 'fix_before_push',
      });
    }
    expect(bridge.calls.filter((args) => args[0] === 'push')).toHaveLength(held ? 0 : 1);
    expect(commits).toBe(1);
  } finally {
    f.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
