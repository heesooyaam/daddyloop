import { constants } from 'node:fs';
import { lstat, open, readdir, realpath, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { AppError } from '../core/types.js';
import type { CacheTarget } from './config.js';

const marker = '.daddyloop-cleanup';
const markerValue = ({ directory, prefix }: CacheTarget) => JSON.stringify({ directory, prefix });
const dayMs = 86400000;

function overlaps(first: string, second: string) {
  return first === second || first.startsWith(second + sep) || second.startsWith(first + sep);
}

async function openTarget(target: CacheTarget, dataDir: string, protectedPaths: string[]) {
  const { directory } = target;
  const home = homedir();
  const forbidden = [
    dataDir,
    join(home, '.tokens'),
    join(home, '.ssh'),
    join(home, '.config'),
    join(home, '.codex'),
    join(home, '.claude'),
    ...protectedPaths,
  ];
  const canonicalData = await realpath(dataDir);
  if (
    directory === sep ||
    directory === home ||
    directory !== resolve(directory) ||
    (await realpath(directory)) !== directory
  )
    throw new AppError(
      'cache_target_invalid',
      'Choose a dedicated cache directory with a canonical path',
    );
  for (const path of forbidden.filter(isAbsolute)) {
    const canonical = await realpath(path).catch(() => resolve(path));
    if (overlaps(directory, canonical))
      throw new AppError(
        'cache_target_protected',
        'The cache target overlaps protected service or workspace data',
      );
  }
  const file = await open(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  const pinned = `/proc/self/fd/${file.fd}`;
  try {
    const info = await file.stat();
    if (
      (await realpath(pinned)) !== directory ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o022) !== 0 ||
      info.dev !== (await stat(canonicalData)).dev
    )
      throw new AppError(
        'cache_target_ownership',
        'Use an owned cache directory on the service data filesystem with group and other writes disabled',
      );
    return { file, pinned, info };
  } catch (error) {
    await file.close();
    throw error;
  }
}

async function checkMarker(pinned: string, target: CacheTarget) {
  const approval = await open(
    join(pinned, marker),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = await approval.stat();
    if (
      !info.isFile() ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o022) !== 0 ||
      info.size > 8192 ||
      (await approval.readFile('utf8')) !== markerValue(target)
    )
      throw new AppError(
        'cache_target_unapproved',
        'The cache target approval does not match its directory and prefix',
      );
  } finally {
    await approval.close();
  }
}

/** Approval is local and explicit. A policy file or a model cannot create it during cleanup. */
export async function approveCacheTarget(target: CacheTarget, dataDir: string) {
  const { file, pinned } = await openTarget(target, dataDir, []);
  try {
    try {
      await writeFile(join(pinned, marker), markerValue(target), { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      await checkMarker(pinned, target);
    }
  } finally {
    await file.close();
  }
}

export async function pruneCacheTarget(
  target: CacheTarget,
  dataDir: string,
  protectedPaths: string[],
  signal: AbortSignal,
  shouldContinue: () => boolean,
) {
  const { file, pinned, info } = await openTarget(target, dataDir, protectedPaths);
  try {
    await checkMarker(pinned, target);
    const cutoff = Date.now() - target.minAgeDays * dayMs;
    for (const entry of await readdir(pinned, { withFileTypes: true })) {
      signal.throwIfAborted();
      if (!shouldContinue()) break;
      if (!entry.isFile() || !entry.name.startsWith(target.prefix)) continue;
      const path = join(pinned, entry.name);
      try {
        const current = await lstat(path);
        if (
          current.isFile() &&
          current.nlink === 1 &&
          current.uid === info.uid &&
          current.dev === info.dev &&
          Math.max(current.mtimeMs, current.atimeMs) < cutoff &&
          (await realpath(pinned)) === target.directory
        ) {
          signal.throwIfAborted();
          if (shouldContinue()) await unlink(path);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  } finally {
    await file.close();
  }
}
