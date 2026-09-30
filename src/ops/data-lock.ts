import { constants } from 'node:fs';
import { open, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { AppError } from '../core/types.js';

async function lockDescriptor(fd: number) {
  return new Promise<number>((resolve, reject) => {
    // flock locks the shared open file description. Our FileHandle retains it
    // after this short helper exits; ordinary child processes do not inherit it.
    const child = spawn('flock', ['--exclusive', '--nonblock', '--conflict-exit-code', '73', '3'], {
      stdio: ['ignore', 'ignore', 'pipe', fd],
    });
    let stderr = '';
    child.stderr!.on('data', (chunk) => {
      stderr = (stderr + String(chunk)).slice(0, 2000);
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Timed out acquiring the daddyloop state lock'));
    }, 5000);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code === 0 || code === 73) resolve(code);
      else reject(new Error(stderr.trim() || 'Could not acquire the daddyloop state lock'));
    });
  });
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
