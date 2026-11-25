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
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { ManagedArcMounts, type NativeArcMount } from '../src/integrations/arc-managed.js';
import type { command } from '../src/ops/process.js';

export function managedFixture(lockTimeoutMs = 120000) {
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
    expect(executable).toBe('bash');
    expect(args[0]).toBe('/fake/arcadia-mount-lease');
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
  const manager = new ManagedArcMounts(
    dir,
    run,
    resources,
    () => '/fake/arcadia-mount-lease',
    lockTimeoutMs,
  );
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
    const interrupted = f.run.getMockImplementation()!;
    f.run.mockImplementation(async (command, args, options) => {
      const result = await interrupted(command, args, options);
      if (command === 'bash' && args.includes('config')) {
        const value = JSON.parse(result.stdout);
        value.data.object_store = join(f.dir, 'another-shared-store');
        return { ...result, stdout: JSON.stringify(value) };
      }
      return result;
    });
    await expect(f.manager.status()).rejects.toThrow('shared store or lease root changed');
    f.run.mockImplementation(interrupted);
    expect((await f.manager.ensure(group, task, 'reviewer')).lease.ownerId).toBe(record.ownerId);
  } finally {
    f.close();
  }
});
it('serializes setup validation with session journal creation', async () => {
  const f = managedFixture();
  try {
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const validation = f.manager.withJournalLock(async () => {
      enter();
      await gate;
    });
    await entered;
    const controller = new AbortController();
    const cancelled = f.manager.ensure(randomUUID(), randomUUID(), 'reviewer', controller.signal);
    await Promise.resolve();
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    const creation = f.manager.ensure(randomUUID(), randomUUID(), 'author');
    await Promise.resolve();
    expect(f.run.mock.calls.some(([, args]) => args[0] === 'mount')).toBe(false);
    release();
    await validation;
    await expect(creation).resolves.toHaveProperty('lease.mount');
  } finally {
    f.close();
  }
});
it('starts each flock timeout after its local queue turn', async () => {
  const f = managedFixture(150);
  try {
    const order: string[] = [];
    await Promise.all(
      [1, 2, 3].map((id) =>
        f.manager.withJournalLock(async () => {
          order.push(`start-${id}`);
          await new Promise((resolve) => setTimeout(resolve, 80));
          order.push(`end-${id}`);
        }),
      ),
    );
    expect(order).toEqual(['start-1', 'end-1', 'start-2', 'end-2', 'start-3', 'end-3']);
  } finally {
    f.close();
  }
});
it.skipIf(!existsSync('/usr/bin/flock'))(
  'shares the session journal lock across processes',
  async () => {
    const f = managedFixture();
    const lock = join(f.dir, 'arcadia-session-journals.lock');
    const child = spawn(
      '/usr/bin/flock',
      ['--exclusive', lock, 'sh', '-c', 'printf locked; read value'],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        child.stdout.once('data', () => resolve());
        child.once('error', reject);
        child.once('exit', () => reject(new Error(stderr || 'flock exited before ready')));
      });
      await expect(
        f.manager.ensure(randomUUID(), randomUUID(), 'author', AbortSignal.abort()),
      ).rejects.toMatchObject({ name: 'AbortError' });

      const controller = new AbortController();
      const pending = f.manager.ensure(randomUUID(), randomUUID(), 'reviewer', controller.signal);
      await new Promise((resolve) => setTimeout(resolve, 50));
      controller.abort();
      let timer!: NodeJS.Timeout;
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Cancellation did not stop flock')), 1000);
        timer.unref();
      });
      await expect(Promise.race([pending, deadline])).rejects.toMatchObject({ name: 'AbortError' });
      clearTimeout(timer);
      expect(f.manager.records()).toEqual([]);
      expect(child.exitCode).toBeNull();

      child.stdin.write('\n');
      await once(child, 'exit');
      await expect(f.manager.ensure(randomUUID(), randomUUID(), 'author')).resolves.toHaveProperty(
        'lease.mount',
      );
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      f.close();
    }
  },
);
