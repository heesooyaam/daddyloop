import { realpathSync, existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { privateWrite } from '../ops/config.js';
import { randomUUID } from 'node:crypto';
import type { Task, Role } from '../core/types.js';
import { AppError } from '../core/types.js';
import { ArcBridge, type ArcLease } from '../integrations/arcadia.js';
type Saved = ArcLease & { initialHash: string; initialBranch: string; baseHead: string };
export class ArcWorkspaces {
  protectedSources: () => string[] = () => [];
  private allocation = Promise.resolve();
  constructor(
    private dataDir: string,
    private bridge = new ArcBridge(),
  ) {}
  async validate(path: string) {
    const source = realpathSync(path),
      mounts = await this.bridge.mounts();
    const match = mounts
      .filter((m) => source === m.path || source.startsWith(m.path + '/'))
      .sort((a, b) => b.path.length - a.path.length)[0];
    if (!match || !match.object_store_ok)
      throw new Error(
        'The source must be an existing Arc mount using the configured shared object store',
      );
    return match.path;
  }
  async prepare(task: Task, role: Role, signal?: AbortSignal): Promise<string> {
    const previous = this.allocation;
    let release!: () => void;
    this.allocation = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      signal?.throwIfAborted();
      return await this.prepareLocked(task, role, signal);
    } finally {
      release();
    }
  }
  private async prepareLocked(task: Task, role: Role, signal?: AbortSignal): Promise<string> {
    if (!task.revision) throw new Error('A pinned revision is required');
    task.arcWorkspaces ??= {};
    let saved = task.arcWorkspaces[role] as Saved | undefined;
    const journal = join(this.dataDir, 'arc-leases', `${task.id}-${role}.json`);
    if (!saved && existsSync(journal)) saved = JSON.parse(readFileSync(journal, 'utf8')) as Saved;
    if (saved && !saved.ownerId.startsWith(`daddyloop-${task.id}-${role}-`))
      throw new Error('Arc lease journal does not belong to this task');
    if (saved) {
      const owned = (await this.bridge.mounts()).find(
        (m) => m.path === saved!.mount && m.lease_owner_id === saved!.ownerId && m.object_store_ok,
      );
      if (!owned)
        throw new Error(
          'The previous Arc workspace lease is unavailable. Its work was preserved; inspect it before continuing.',
        );
    } else {
      const candidates = (await this.bridge.mounts()).filter(
        (m) =>
          m.claimable &&
          m.object_store_ok &&
          m.path !== task.repoPath &&
          !this.protectedSources().includes(m.path),
      );
      // Leave one mount available for Daddy/review so a full worker pool cannot deadlock.
      if (role === 'author' && candidates.length <= 1) {
        if (
          typeof this.bridge.provision === 'function' &&
          (await this.bridge.provision(task.repoPath))
        )
          return this.prepareLocked(task, role, signal);
        throw new AppError(
          'workspace_capacity',
          'Waiting for an Arc worker slot; one workspace is reserved for daddy and review.',
          503,
        );
      }
      for (const candidate of candidates) {
        let lease: ArcLease;
        try {
          lease = await this.bridge.claim(
            `daddyloop-${task.id}-${role}-${randomUUID()}`,
            candidate.path,
          );
        } catch {
          continue;
        }
        try {
          if (await this.bridge.native(['status', '--short'], lease.mount, signal)) {
            await this.bridge.release(lease);
            continue;
          }
          const info = JSON.parse(
            await this.bridge.native(['info', '--json'], lease.mount, signal),
          ) as { hash: string; branch: string };
          saved = {
            ...lease,
            initialHash: info.hash,
            initialBranch: info.branch,
            baseHead: task.revision.head,
          };
          task.arcWorkspaces[role] = saved;
          privateWrite(journal, JSON.stringify(saved));
          if (role === 'author')
            await this.bridge.native(
              [
                'checkout',
                '-b',
                task.ref.kind === 'ticket'
                  ? `daddyloop/${task.id}`
                  : `daddyloop/${task.id}-g${task.generation}-${randomUUID().slice(0, 8)}`,
                task.revision.head,
              ],
              saved.mount,
              signal,
            );
          else await this.bridge.native(['checkout', task.revision.head], saved.mount, signal);
          break;
        } catch (error) {
          if (!existsSync(journal)) await this.bridge.release(lease);
          throw error;
        }
      }
      if (!saved) {
        if (
          typeof this.bridge.provision === 'function' &&
          (await this.bridge.provision(task.repoPath))
        )
          return this.prepareLocked(task, role, signal);
        throw new AppError(
          'workspace_capacity',
          'Waiting for a free, clean Arc workspace. Existing source checkouts and worker changes are preserved.',
          503,
        );
      }
    }
    const info = JSON.parse(await this.bridge.native(['info', '--json'], saved.mount, signal)) as {
      hash: string;
    };
    if (saved.baseHead !== task.revision.head) {
      if (await this.bridge.native(['status', '--short'], saved.mount, signal))
        throw new Error('Arc workspace has uncommitted changes; it was not switched');
      const ancestor = await this.bridge.native(
        ['merge-base', '--leftmost', info.hash, task.revision.head],
        saved.mount,
        signal,
      );
      if (ancestor !== info.hash)
        throw new Error('Arc workspace contains diverging or unpushed commits; it was preserved');
      if (info.hash !== task.revision.head)
        await this.bridge.native(
          role === 'author'
            ? ['checkout', '-b', `daddyloop/${task.id}-g${task.generation}`, task.revision.head]
            : ['checkout', task.revision.head],
          saved.mount,
          signal,
        );
      saved.baseHead = task.revision.head;
    }
    if (role === 'reviewer') {
      const current = JSON.parse(
        await this.bridge.native(['info', '--json'], saved.mount, signal),
      ) as { hash: string };
      if (
        current.hash !== task.revision.head ||
        (await this.bridge.native(['status', '--short'], saved.mount, signal))
      )
        throw new Error(
          'The reviewer snapshot changed outside its run; it was preserved for inspection',
        );
    } else {
      const current = JSON.parse(
        await this.bridge.native(['info', '--json'], saved.mount, signal),
      ) as { hash: string; branch: string };
      if (
        !current.branch?.startsWith(`daddyloop/${task.id}`) ||
        (await this.bridge.native(
          ['merge-base', '--leftmost', task.revision.head, current.hash],
          saved.mount,
          signal,
        )) !== task.revision.head
      )
        throw new Error(
          'The Arc author checkout was interrupted or changed outside daddyloop. Inspect the saved lease before continuing; no agent was started.',
        );
      if (task.ref.kind === 'ticket') {
        task.revision = { ...task.revision, head: current.hash };
        saved.baseHead = current.hash;
      }
    }
    task.arcWorkspaces[role] = saved;
    privateWrite(journal, JSON.stringify(saved));
    if (role === 'author') {
      task.authorWorktree = saved.mount;
      task.authorBaseHead = task.revision.head;
    } else task.reviewerWorktree = saved.mount;
    return saved.mount;
  }
  async commit(task: Task, message: string, signal?: AbortSignal) {
    const saved = task.arcWorkspaces?.author as Saved | undefined;
    if (!saved || !task.revision) throw new Error('Arc author workspace is not initialized');
    const owned = (await this.bridge.mounts()).some(
      (m) => m.path === saved.mount && m.lease_owner_id === saved.ownerId && m.object_store_ok,
    );
    if (!owned) throw new Error('Arc author lease is no longer owned by this task');
    const before = JSON.parse(
      await this.bridge.native(['info', '--json'], saved.mount, signal),
    ) as { hash: string; branch: string };
    if (
      !before.branch?.startsWith(`daddyloop/${task.id}`) ||
      (await this.bridge.native(
        ['merge-base', '--leftmost', task.revision.head, before.hash],
        saved.mount,
        signal,
      )) !== task.revision.head
    )
      throw new Error(
        'The Arc author branch changed outside daddyloop; no commit or push was performed',
      );
    const status = await this.bridge.native(['status', '--short'], saved.mount, signal);
    if (status) {
      const files = status
        .split('\n')
        .map((line) => line.slice(3))
        .filter(Boolean);
      if (
        files.some(
          (path) =>
            path.includes(' -> ') ||
            path.includes('\\') ||
            path.startsWith('"') ||
            path.startsWith('-') ||
            path.startsWith('/') ||
            path.split('/').includes('..'),
        )
      )
        throw new Error('Ambiguous Arc status paths require manual review before committing');
      for (const path of files) await this.bridge.native(['add', path], saved.mount, signal);
      await this.bridge.native(['commit', '-m', message], saved.mount, signal);
    }
    const head = (
      JSON.parse(await this.bridge.native(['info', '--json'], saved.mount, signal)) as {
        hash: string;
      }
    ).hash;
    return head;
  }
  async submit(task: Task, message: string, signal?: AbortSignal) {
    if (!task.pr || !task.revision || !task.arcWorkspaces?.author)
      throw new Error('Arc author workspace is not initialized');
    const saved = task.arcWorkspaces.author;
    const head = await this.commit(task, message, signal);
    if (head === task.revision.head || !task.policy.autoPush) return { head, pushed: false };
    if (!task.pr.branch.startsWith('users/') || /\s/.test(task.pr.branch))
      throw new Error('Expected an explicit Arc users/<login>/<branch> push target');
    await this.bridge.native(['push', '-u', task.pr.branch], saved.mount, signal);
    return { head, pushed: true };
  }
  async planDocuments(task: Task, cwd: string) {
    const list = await this.bridge.native(
      ['diff', '--name-only', task.revision!.base, task.revision!.head],
      cwd,
    );
    const documents: { path: string; body: string }[] = [];
    let size = 0;
    for (const path of list.split('\n').filter((path) => path.endsWith('.md'))) {
      const body = await this.bridge.native(['show', `${task.revision!.head}:${path}`], cwd);
      size += body.length;
      if (size > 300000) throw new Error('Plan Markdown exceeds the context limit');
      documents.push({ path, body });
    }
    return documents;
  }
  async release(task: Task, role: Role) {
    const saved = task.arcWorkspaces?.[role] as Saved | undefined;
    if (!saved) return { released: false };
    const owned = (await this.bridge.mounts()).some(
      (m) => m.path === saved.mount && m.lease_owner_id === saved.ownerId && m.object_store_ok,
    );
    if (!owned) throw new Error('This task no longer owns the Arc lease');
    const info = JSON.parse(await this.bridge.native(['info', '--json'], saved.mount)) as {
      hash: string;
      branch: string;
    };
    if (
      (await this.bridge.native(['status', '--short'], saved.mount)) ||
      (role === 'reviewer' &&
        info.hash !== saved.baseHead &&
        !(info.hash === saved.initialHash && info.branch === saved.initialBranch)) ||
      (role === 'author' && info.hash !== task.revision?.head)
    )
      throw new Error(
        'Uncommitted or unverified author work was preserved; the lease was not released',
      );
    await this.bridge.native(['checkout', saved.initialBranch || saved.initialHash], saved.mount);
    await this.bridge.release(saved);
    const journal = join(this.dataDir, 'arc-leases', `${task.id}-${role}.json`);
    if (existsSync(journal)) unlinkSync(journal);
    delete task.arcWorkspaces![role];
    if (role === 'author') task.authorWorktree = undefined;
    else task.reviewerWorktree = undefined;
    return { released: true, mount: saved.mount };
  }
}
