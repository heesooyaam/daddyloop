import { it, expect } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  existsSync,
  rmSync,
  utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture } from './helpers.js';
import { CacheManager } from '../src/ops/cache.js';
import { execFileSync } from 'node:child_process';
it('prunes only explicitly owned, expired temporary artifacts and never follows symlinks', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'reviewloop-cache-')),
    f = await fixture();
  try {
    const cache = join(dir, 'cache'),
      outside = join(dir, 'important');
    mkdirSync(cache);
    mkdirSync(outside);
    writeFileSync(join(outside, 'keep'), 'user data');
    writeFileSync(join(cache, '.reviewloop-cache'), 'reviewloop-cache-v1');
    const old = join(cache, 'download-old');
    writeFileSync(old, 'reproducible');
    utimesSync(old, new Date(0), new Date(0));
    symlinkSync(outside, join(cache, 'download-link'));
    writeFileSync(join(cache, 'credentials'), 'preserve');
    const manager = new CacheManager(f.engine, dir, {
      auto: false,
      maxAgeDays: 7,
      keepReviewerCopies: 1,
    });
    expect((await manager.prune(false)).removed).toHaveLength(0);
    expect(existsSync(old)).toBe(true);
    const result = await manager.prune(true);
    expect(result.removed).toEqual([old]);
    expect(existsSync(join(outside, 'keep'))).toBe(true);
    expect(existsSync(join(cache, 'credentials'))).toBe(true);
  } finally {
    f.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
it('does not clean an unmarked cache directory', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'reviewloop-cache-')),
    f = await fixture();
  try {
    mkdirSync(join(dir, 'cache'));
    writeFileSync(join(dir, 'cache/download-old'), 'not owned');
    const manager = new CacheManager(f.engine, dir, {
      auto: false,
      maxAgeDays: 1,
      keepReviewerCopies: 1,
    });
    expect((await manager.prune(true)).removed).toHaveLength(0);
  } finally {
    f.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
it('removes a registered clean old reviewer worktree while preserving dirty, current and author copies', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'reviewloop-cache-git-')),
    f = await fixture();
  const run = (args: string[], cwd = dir) => execFileSync('git', args, { cwd, stdio: 'pipe' });
  try {
    const seed = join(dir, 'seed');
    mkdirSync(seed);
    run(['init'], seed);
    run(['config', 'user.email', 'test@example.com'], seed);
    run(['config', 'user.name', 'Test'], seed);
    writeFileSync(join(seed, 'code.txt'), 'original');
    run(['add', '.'], seed);
    run(['commit', '-m', 'seed'], seed);
    const base = join(dir, 'workspaces', f.task.id);
    mkdirSync(base, { recursive: true });
    const bare = join(base, 'objects.git');
    run(['clone', '--bare', seed, bare]);
    writeFileSync(
      join(base, 'owner.json'),
      JSON.stringify({ application: 'reviewloop', taskId: f.task.id }),
    );
    const paths = ['reviewer-a-a', 'reviewer-b-b', 'reviewer-c-c', 'author'].map((name) =>
      join(base, name),
    );
    for (const path of paths) run(['--git-dir', bare, 'worktree', 'add', '--detach', path, 'HEAD']);
    writeFileSync(join(paths[1], 'code.txt'), 'user edit');
    paths.forEach((path, i) => utimesSync(path, new Date(i * 1000), new Date(i * 1000)));
    const task = f.store.getTask(f.task.id);
    task.reviewerWorktree = paths[2];
    task.authorWorktree = paths[3];
    f.store.saveTask(task);
    const manager = new CacheManager(f.engine, dir, {
      auto: false,
      maxAgeDays: 7,
      keepReviewerCopies: 1,
    });
    await f.engine.review(task.id);
    expect((await manager.prune(true)).removed).toEqual([]);
    f.store.cancelJobs(task.id);
    expect((await manager.prune(true)).removed).toEqual([paths[0]]);
    expect(existsSync(paths[0])).toBe(false);
    for (const path of paths.slice(1)) expect(existsSync(path)).toBe(true);
  } finally {
    f.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
