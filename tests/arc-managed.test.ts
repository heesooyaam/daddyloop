import { expect, it, vi } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  rmSync,
  realpathSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ManagedArcMounts, type NativeArcMount } from '../src/integrations/arc-managed.js';
import type { command } from '../src/ops/process.js';

export function managedFixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'daddy-arc-managed-')));
  const shared = join(dir, 'shared'),
    leaseRoot = join(dir, 'leases');
  mkdirSync(shared);
  mkdirSync(leaseRoot);
  writeFileSync(join(shared, 'preserve'), 'shared data');
  const inventory = new Map<string, NativeArcMount>();
  const leases = new Map<string, string>();
  const run = vi.fn<typeof command>(async (executable, args) => {
    const json = (value: unknown) => ({ code: 0, stdout: JSON.stringify(value), stderr: '' });
    if (executable === 'arc') {
      if (args[0] === 'mount' && args.includes('-l')) return json([...inventory.values()]);
      if (args[0] === 'mount') {
        const mount = args[args.indexOf('-m') + 1],
          store = args[args.indexOf('-S') + 1];
        expect(existsSync(join(store, '..', 'owner.json'))).toBe(true);
        expect(args[args.indexOf('--object-store') + 1]).toBe(shared);
        inventory.set(mount, { mount, store, status: 'mounted', 'object-store': shared });
        writeFileSync(join(store, 'overlay'), 'local Arc state');
        return json({});
      }
      if (args[0] === 'unmount') {
        expect(args).not.toContain('--force');
        const path = args.at(-1)!;
        const value = inventory.get(path)!;
        if (args.includes('--forget')) {
          rmSync(value.store, { recursive: true });
          inventory.delete(path);
        } else value.status = 'unmounted';
        return json({});
      }
      throw new Error('Unexpected Arc command: ' + args.join(' '));
    }
    if (args.includes('config'))
      return json({
        status: 'success',
        data: {
          object_store: shared,
          lease_root: leaseRoot,
          store_root: join(dir, 'pool-stores'),
          mount_prefix: join(dir, 'arcadia'),
          mount_start: 1,
          mount_end: 2,
          extra_mounts: '',
          human_reserved_mount_numbers: '1',
        },
      });
    const owner = args[args.indexOf('--owner-id') + 1],
      mount = args[args.indexOf('--owner-id') + 2];
    if (args.includes('status'))
      return json({
        status: 'success',
        data: {
          mounts: [...inventory.values()].map((value) => ({
            path: value.mount,
            mounted: value.status === 'mounted',
            object_store_ok: value.status === 'mounted' && value['object-store'] === shared,
            lease_owner_id: leases.get(value.mount),
            claimable: !leases.has(value.mount),
          })),
        },
      });
    if (args.includes('claim')) {
      if (leases.has(mount)) throw new Error('busy: even the same owner cannot claim twice');
      leases.set(mount, owner);
      return json({
        status: 'success',
        data: { mount, object_store: shared, object_store_ok: true },
      });
    }
    if (args.includes('release')) {
      expect(leases.get(mount)).toBe(owner);
      leases.delete(mount);
      return json({ status: 'success' });
    }
    throw new Error('Unexpected helper command');
  });
  const resources = vi.fn();
  const manager = new ManagedArcMounts(dir, run, resources, () => '/fake/arcadia-mount-lease');
  return {
    dir,
    shared,
    leaseRoot,
    inventory,
    leases,
    run,
    resources,
    manager,
    close: () => rmSync(dir, { recursive: true, force: true }),
  };
}

it('allocates distinct session copies using one shared store and reuses their existing leases', async () => {
  const f = managedFixture();
  try {
    const session = randomUUID(),
      task = randomUUID();
    const first = await f.manager.ensure(session, task, 'author');
    const again = await f.manager.ensure(session, task, 'author');
    const reviewer = await f.manager.ensure(session, task, 'reviewer');
    expect(again.lease).toEqual(first.lease);
    expect(reviewer.lease.mount).not.toBe(first.lease.mount);
    expect(first.lease.objectStore).toBe(f.shared);
    expect(f.run.mock.calls.filter(([, args]) => args.includes('claim'))).toHaveLength(2);
    expect((await f.manager.status()).every((entry: { managed: boolean }) => entry.managed)).toBe(
      true,
    );
  } finally {
    f.close();
  }
});
it('parks an idle copy without losing files and remounts the same store', async () => {
  const f = managedFixture();
  try {
    const group = randomUUID(),
      task = randomUUID();
    const { lease } = await f.manager.ensure(group, task, 'author');
    const record = f.manager.records(group)[0];
    writeFileSync(join(record.store, 'work'), 'unpublished work');
    await f.manager.park(lease);
    expect(f.inventory.get(lease.mount)?.status).toBe('unmounted');
    expect(f.leases.get(lease.mount)).toBe(lease.ownerId);
    const resumed = await f.manager.ensure(group, task, 'author');
    expect(resumed.lease).toEqual(lease);
    expect(readFileSync(join(record.store, 'work'), 'utf8')).toBe('unpublished work');
  } finally {
    f.close();
  }
});
it('forgets only the owned local copy, preserving the shared store and other sessions', async () => {
  const f = managedFixture();
  try {
    const group = randomUUID();
    await f.manager.ensure(group, randomUUID(), 'reviewer');
    const other = await f.manager.ensure(randomUUID(), randomUUID(), 'author');
    const record = f.manager.records(group)[0];
    await f.manager.remove(record);
    expect(f.inventory.has(record.mount)).toBe(false);
    expect(f.leases.has(record.mount)).toBe(false);
    expect(existsSync(join(f.manager.root, group))).toBe(false);
    expect(f.inventory.has(other.lease.mount)).toBe(true);
    expect(readFileSync(join(f.shared, 'preserve'), 'utf8')).toBe('shared data');
  } finally {
    f.close();
  }
});
it('refuses changed lease ownership and symlinked stores without unmounting anything', async () => {
  const f = managedFixture();
  try {
    const group = randomUUID(),
      task = randomUUID();
    const { lease } = await f.manager.ensure(group, task, 'author');
    const record = f.manager.records(group)[0];
    f.leases.set(lease.mount, 'another-owner');
    await expect(f.manager.ensure(group, task, 'author')).rejects.toThrow('another owner');
    await expect(f.manager.remove(record)).rejects.toThrow('another process');
    f.leases.set(lease.mount, lease.ownerId);
    rmSync(record.store, { recursive: true });
    symlinkSync(f.shared, record.store);
    await expect(f.manager.remove(record)).rejects.toThrow('redirected');
    expect(f.run.mock.calls.filter(([, args]) => args[0] === 'unmount')).toHaveLength(0);
    expect(existsSync(join(f.shared, 'preserve'))).toBe(true);
  } finally {
    f.close();
  }
});
it('keeps an ownership journal when mounting fails so the same operation can recover', async () => {
  const f = managedFixture();
  try {
    const group = randomUUID(),
      task = randomUUID();
    const original = f.run.getMockImplementation()!;
    let failed = false;
    f.run.mockImplementation(async (command, args, options) => {
      if (!failed && command === 'arc' && args.includes('-m')) {
        failed = true;
        throw new Error('mount interrupted');
      }
      return original(command, args, options);
    });
    await expect(f.manager.ensure(group, task, 'reviewer')).rejects.toThrow('mount interrupted');
    const record = f.manager.records(group)[0];
    expect(record.state).toBe('creating');
    expect((await f.manager.ensure(group, task, 'reviewer')).lease.ownerId).toBe(record.ownerId);
  } finally {
    f.close();
  }
});
