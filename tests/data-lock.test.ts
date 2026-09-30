import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, writeFile, rm, stat, symlink, link } from 'node:fs/promises';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { acquireDataLock } from '../src/ops/data-lock.js';

afterEach(() => vi.restoreAllMocks());

it.each(['', '0', '-1', 'invalid', '2147483647', String(process.pid)])(
  'uses kernel ownership instead of stale PID contents %j',
  async (contents) => {
    const dir = await mkdtemp(join(tmpdir(), 'daddyloop-lock-'));
    const path = join(dir, 'server.lock');
    let release: (() => Promise<void>) | undefined;
    try {
      await writeFile(path, contents);
      const inode = (await stat(path)).ino;
      release = await acquireDataLock(dir);
      expect(await readFile(path, 'utf8')).toBe(String(process.pid));
      await expect(acquireDataLock(dir)).rejects.toMatchObject({ code: 'state_locked' });
      expect((await stat(path)).ino).toBe(inode);
      await release();
      await release();
      expect(await readFile(path, 'utf8')).toBe('');
      release = await acquireDataLock(dir);
      expect((await stat(path)).ino).toBe(inode);
    } finally {
      await release?.();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

it('releases ownership when writing the PID fails with a full disk', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'daddyloop-lock-full-'));
  const path = join(dir, 'server.lock');
  const handle = await fs.open(path, 'w+');
  vi.spyOn(Object.getPrototypeOf(handle), 'writeFile').mockRejectedValueOnce(
    Object.assign(new Error('No space left on device'), { code: 'ENOSPC' }),
  );
  try {
    await expect(acquireDataLock(dir)).rejects.toMatchObject({ code: 'ENOSPC' });
    expect(await readFile(path, 'utf8')).toBe('');
    const release = await acquireDataLock(dir);
    await release();
  } finally {
    await handle.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it.each(['symlink', 'hardlink'])('preserves files aliased through a %s', async (kind) => {
  const dir = await mkdtemp(join(tmpdir(), 'daddyloop-lock-alias-'));
  const target = join(dir, 'keep');
  try {
    await writeFile(target, 'user data');
    await (kind === 'symlink' ? symlink : link)(target, join(dir, 'server.lock'));
    await expect(acquireDataLock(dir)).rejects.toThrow();
    expect(await readFile(target, 'utf8')).toBe('user data');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('releases after SIGKILL even while a detached descendant stays alive', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'daddyloop-lock-crash-'));
  const module = new URL('../src/ops/data-lock.ts', import.meta.url).href;
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      `
    import { acquireDataLock } from ${JSON.stringify(module)};
    import { spawn } from 'node:child_process';
    const release = await acquireDataLock(process.argv[1]);
    const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true, stdio: 'ignore'
    });
    descendant.unref();
    process.stdout.write(String(descendant.pid) + '\\n');
    setInterval(() => { void release; }, 1000);
  `,
      dir,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let descendant: number | undefined;
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });
  try {
    descendant = await new Promise<number>((resolve, reject) => {
      child.stdout.once('data', (data) => resolve(Number(String(data).trim())));
      child.once('error', reject);
      child.once('exit', () => reject(new Error(stderr || 'Lock owner exited before ready')));
    });
    expect(descendant).toBeGreaterThan(1);
    await expect(acquireDataLock(dir)).rejects.toMatchObject({ code: 'state_locked' });
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
    expect(() => process.kill(descendant!, 0)).not.toThrow();
    const release = await acquireDataLock(dir);
    await release();
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    if (descendant && descendant > 1) {
      try {
        process.kill(descendant, 'SIGKILL');
      } catch {}
    }
    await rm(dir, { recursive: true, force: true });
  }
});
