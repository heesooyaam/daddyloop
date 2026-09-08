import { lstat, readdir, readFile, realpath, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import type { Engine } from '../core/engine.js';
import type { Config } from './config.js';
import { git } from '../runtime/workspaces.js';

export interface CacheCandidate {
  path: string;
  bytes: number;
  eligible: boolean;
  reason: string;
  taskId?: string;
  kind: 'reviewer' | 'download';
}
async function size(path: string, budget = { left: 100000 }): Promise<number> {
  if (--budget.left < 0)
    throw new Error('Cache scan exceeded 100,000 entries; inspect this directory separately');
  const st = await lstat(path);
  if (st.isSymbolicLink()) return 0;
  if (!st.isDirectory()) return st.size;
  let total = 0;
  for (const entry of await readdir(path)) total += await size(join(path, entry), budget);
  return total;
}
export class CacheManager {
  private running = false;
  constructor(
    private engine: Engine,
    private dataDir: string,
    private policy: Config['cache'],
  ) {}
  async inspect(): Promise<CacheCandidate[]> {
    const items: CacheCandidate[] = [],
      root = resolve(this.dataDir, 'workspaces');
    if (existsSync(root))
      for (const folder of await readdir(root)) {
        const base = join(root, folder),
          marker = join(base, 'owner.json');
        if (!existsSync(marker) || (await lstat(base)).isSymbolicLink()) continue;
        let owner: { application: string; taskId: string };
        try {
          owner = JSON.parse(await readFile(marker, 'utf8'));
        } catch {
          continue;
        }
        if (owner.application !== 'reviewloop' || owner.taskId !== folder) continue;
        let task;
        try {
          task = this.engine.store.getTask(folder);
        } catch {
          continue;
        }
        if (task.ref.provider === 'arcadia') continue;
        const names = (await readdir(base)).filter((name) =>
          /^reviewer-[a-f0-9]+-[a-f0-9]+$/.test(name),
        );
        const sorted = await Promise.all(
          names.map(async (name) => ({ name, at: (await lstat(join(base, name))).mtimeMs })),
        );
        sorted.sort((a, b) => b.at - a.at);
        for (let i = 0; i < sorted.length; i++) {
          const path = join(base, sorted[i].name);
          if (
            (await lstat(path)).isSymbolicLink() ||
            !(await realpath(path)).startsWith((await realpath(base)) + '/')
          )
            continue;
          let reason = 'Old, clean reviewer snapshot';
          if (this.engine.store.busy(task.id)) reason = 'Task has active or queued work';
          else if (task.state !== 'complete' && task.reviewerWorktree === path)
            reason = 'Current reviewer workspace';
          else if (i < this.policy.keepReviewerCopies) reason = 'Kept by retention policy';
          else if (Date.now() - sorted[i].at < this.policy.maxAgeDays * 86400000)
            reason = 'Younger than retention policy';
          else {
            try {
              if (await git(['status', '--porcelain'], path))
                reason = 'Contains uncommitted files; preserved';
            } catch {
              reason = 'Could not verify Git state; preserved';
            }
          }
          items.push({
            path,
            bytes: await size(path),
            eligible: reason === 'Old, clean reviewer snapshot',
            reason,
            taskId: task.id,
            kind: 'reviewer',
          });
        }
      }
    // Only an installer-created cache with this marker belongs to Reviewloop.
    const cache = join(this.dataDir, 'cache'),
      marker = join(cache, '.reviewloop-cache');
    if (
      existsSync(marker) &&
      !(await lstat(cache)).isSymbolicLink() &&
      (await readFile(marker, 'utf8')).trim() === 'reviewloop-cache-v1'
    ) {
      for (const name of await readdir(cache)) {
        if (!/^(download|temporary)-[A-Za-z0-9._-]+$/.test(name)) continue;
        const path = join(cache, name),
          st = await lstat(path);
        if (st.isSymbolicLink()) continue;
        const old = Date.now() - st.mtimeMs > this.policy.maxAgeDays * 86400000;
        items.push({
          path,
          bytes: await size(path),
          eligible: old,
          reason: old ? 'Expired task-owned temporary download' : 'Recent download',
          kind: 'download',
        });
      }
    }
    return items;
  }
  async prune(apply: boolean) {
    if (this.running) throw new Error('Cache maintenance is already running');
    this.running = true;
    try {
      const candidates = await this.inspect(),
        removed: string[] = [];
      let removedBytes = 0;
      if (apply)
        for (const item of candidates.filter((i) => i.eligible)) {
          const clean = async () => {
            // Re-evaluate ownership, retention and active jobs immediately before deletion.
            const current = (await this.inspect()).find((i) => i.path === item.path && i.eligible);
            if (!current) return;
            if (item.kind === 'reviewer') {
              const bare = join(resolve(this.dataDir, 'workspaces', item.taskId!), 'objects.git');
              const listed = await git(
                ['--git-dir', bare, 'worktree', 'list', '--porcelain'],
                this.dataDir,
              );
              const registered = await Promise.all(
                listed
                  .split('\n')
                  .filter((line) => line.startsWith('worktree '))
                  .map((line) => realpath(line.slice(9)).catch(() => undefined)),
              );
              if (!registered.includes(await realpath(item.path)))
                throw new Error('Snapshot is not a registered worktree; preserved it');
              await git(['--git-dir', bare, 'worktree', 'remove', item.path], this.dataDir);
            } else {
              if (
                basename(item.path) === 'cache' ||
                !item.path.startsWith(resolve(this.dataDir, 'cache') + '/')
              )
                throw new Error('Unsafe cleanup path');
              await rm(item.path, { recursive: true });
            }
            removed.push(item.path);
            removedBytes += item.bytes;
          };
          if (item.taskId) await this.engine.lock(item.taskId, clean);
          else await clean();
        }
      if (apply) this.engine.store.event('_system', 'cache.pruned', { removed, removedBytes });
      return {
        dryRun: !apply,
        candidates,
        removableBytes: candidates.filter((c) => c.eligible).reduce((n, c) => n + c.bytes, 0),
        removed,
        removedBytes,
        preserved:
          'Author workspaces, shared object stores, credentials and workflow history are never removed by this command.',
      };
    } finally {
      this.running = false;
    }
  }
}
