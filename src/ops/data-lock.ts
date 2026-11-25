import { constants } from 'node:fs';
import { open, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { AppError } from '../core/types.js';

async function lockDescriptor(
  fd: number,
  nonblocking = true,
  timeoutMs = 5000,
  signal?: AbortSignal,
) {
  return new Promise<number>((resolve, reject) => {
    signal?.throwIfAborted();
    // flock locks the shared open file description. Our FileHandle retains it
    // after this short helper exits; ordinary child processes do not inherit it.
    const child = spawn(
      'flock',
      ['--exclusive', ...(nonblocking ? ['--nonblock', '--conflict-exit-code', '73'] : []), '3'],
      {
        stdio: ['ignore', 'ignore', 'pipe', fd],
      },
    );
    let stderr = '';
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      fn();
    };
    const abort = () => {
      child.kill('SIGKILL');
      finish(() =>
        reject(signal?.reason ?? new DOMException('The operation was aborted', 'AbortError')),
      );
    };
    child.stderr!.on('data', (chunk) => {
      stderr = (stderr + String(chunk)).slice(0, 2000);
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(() => reject(new Error('Timed out acquiring the daddyloop state lock')));
    }, timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.once('error', (error) => {
      finish(() => reject(error));
    });
    child.once('close', (code) => {
      finish(() => {
        if (code === 0 || code === 73) resolve(code);
        else reject(new Error(stderr.trim() || 'Could not acquire the daddyloop state lock'));
      });
    });
  });
}

/** Cross-process lock for one durable operation. Keep the inode between calls. */
export async function acquireFileLock(path: string, timeoutMs = 120000, signal?: AbortSignal) {
  signal?.throwIfAborted();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const handle = await open(
    path,
    constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1)
      throw new Error('The lock must be a regular file without aliases');
    await handle.chmod(0o600);
    await lockDescriptor(handle.fd, false, timeoutMs, signal);
  } catch (error) {
    await handle.close();
    throw error;
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await handle.close();
  };
}

/** Shared by serve and backup. Keep the inode: never unlink a live lock path. */
export async function acquireDataLock(dataDir: string, writeOwner = true) {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const handle = await open(
    join(dataDir, 'server.lock'),
    constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1)
      throw new Error('The daddyloop state lock must be a regular file without aliases');
    if ((await lockDescriptor(handle.fd)) === 73)
      throw new AppError(
        'state_locked',
        'Another daddyloop server or backup is using this data directory',
        409,
      );
    if (writeOwner) {
      await handle.chmod(0o600);
      await handle.truncate(0);
      await handle.writeFile(String(process.pid));
      await handle.sync();
    }
  } catch (error) {
    await handle.close();
    throw error;
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    try {
      if (writeOwner) await handle.truncate(0);
    } finally {
      await handle.close();
    }
  };
}
