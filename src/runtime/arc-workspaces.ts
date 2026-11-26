import { realpathSync, existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { privateWrite } from '../ops/config.js';
import { randomUUID } from 'node:crypto';
import type { Task, Role, FixSave } from '../core/types.js';
import { AppError } from '../core/types.js';
import { ArcBridge, type ArcLease } from '../integrations/arcadia.js';
type Saved = ArcLease & {
  initialHash: string;
  initialBranch: string;
  baseHead: string;
  prepared?: boolean;
  targetBranch?: string;
};
type ArcFixIntent = { branch: string; parent: string; title?: string; reportedHead?: string };
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
    if (match && !match.managed && (match.mounted || match.object_store_ok)) return match.path;
    if (!match && typeof this.bridge.sourceMounts === 'function') {
      const native = (await this.bridge.sourceMounts())
        .filter(
          (mount) =>
            mount.status === 'mounted' &&
            (source === mount.mount || source.startsWith(mount.mount + '/')),
        )
        .sort((a, b) => b.mount.length - a.mount.length)[0];
      if (native) return native.mount;
    }
    throw new Error(
      'Choose an existing mounted Arcadia source. The service creates its own working copies.',
    );
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
    let managed: ArcLease | undefined;
    if (
      saved?.managed &&
      (saved.managed.sessionId !== (task.groupId ?? task.id) ||
        saved.managed.taskId !== task.id ||
        saved.managed.role !== role)
    )
      throw new Error('The Arc copy belongs to a different session or task');
    if (saved?.managed || (!saved && task.workspaceIsolation === 'session')) {
      const allocation = await this.bridge.sessionMount(task, role, signal);
      managed = allocation.lease;
      if (saved && saved.ownerId !== managed.ownerId)
        throw new Error('The saved Arc session copy belongs to a different owner');
      if (!saved && allocation.checkpoint) saved = { ...managed, ...allocation.checkpoint };
    }
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
      const candidates = managed
        ? [{ path: managed.mount }]
        : (await this.bridge.mounts()).filter(
            (m) =>
              m.claimable &&
              m.object_store_ok &&
              !m.managed &&
              m.path !== task.repoPath &&
              !this.protectedSources().includes(m.path),
          );
      // Leave one mount available for Daddy/review so a full worker pool cannot deadlock.
      if (!managed && role === 'author' && candidates.length <= 1) {
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
          lease =
            managed ??
            (await this.bridge.claim(
              `daddyloop-${task.id}-${role}-${randomUUID()}`,
              candidate.path,
            ));
        } catch {
          continue;
        }
        try {
          if (await this.bridge.native(['status', '--short'], lease.mount, signal)) {
            if (lease.managed)
              throw new Error('The new session copy already contains changes; they were preserved');
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
            ...(lease.managed ? { prepared: false } : {}),
            targetBranch:
              role === 'author'
                ? task.ref.kind === 'ticket'
                  ? `daddyloop/${task.id}`
                  : `daddyloop/${task.id}-g${task.generation}-${randomUUID().slice(0, 8)}`
                : undefined,
          };
          task.arcWorkspaces[role] = saved;
          privateWrite(journal, JSON.stringify(saved));
          if (saved.managed) this.bridge.saveSessionCheckpoint(saved, saved);
          if (role === 'author')
            await this.bridge.native(
              ['checkout', '-b', saved.targetBranch!, task.revision.head],
              saved.mount,
              signal,
            );
          else await this.bridge.native(['checkout', task.revision.head], saved.mount, signal);
          break;
        } catch (error) {
          if (!existsSync(journal) && !lease.managed) await this.bridge.release(lease);
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
    let info = JSON.parse(await this.bridge.native(['info', '--json'], saved.mount, signal)) as {
      hash: string;
      branch: string;
    };
    if (
      saved.managed &&
      saved.prepared === false &&
      info.hash === saved.initialHash &&
      info.branch === saved.initialBranch
    ) {
      if (await this.bridge.native(['status', '--short'], saved.mount, signal))
        throw new Error('The interrupted Arc preparation contains changes; they were preserved');
      if (role === 'reviewer')
        await this.bridge.native(['checkout', task.revision.head], saved.mount, signal);
      else {
        const target = saved.targetBranch!;
        let existing: string | undefined;
        try {
          existing = await this.bridge.native(
            ['merge-base', '--leftmost', target, target],
            saved.mount,
            signal,
          );
        } catch {
          signal?.throwIfAborted();
        }
        if (existing && existing !== task.revision.head)
          throw new Error('The interrupted Arc branch changed; it was preserved');
        await this.bridge.native(
          existing ? ['checkout', target] : ['checkout', '-b', target, task.revision.head],
          saved.mount,
          signal,
        );
      }
      info = JSON.parse(await this.bridge.native(['info', '--json'], saved.mount, signal));
    }
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
    if (saved.managed) saved.prepared = true;
    privateWrite(journal, JSON.stringify(saved));
    if (saved.managed) this.bridge.saveSessionCheckpoint(saved, saved);
    if (role === 'author') {
      task.authorWorktree = saved.mount;
      task.authorBaseHead = task.revision.head;
    } else task.reviewerWorktree = saved.mount;
    return saved.mount;
  }
  private async checkedAuthor(task: Task, signal?: AbortSignal) {
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
    return { saved, head: before.hash, branch: before.branch };
  }
  private fixReceipt(task: Task, save: FixSave) {
    if (!/^[a-zA-Z0-9_-]+$/.test(save.runId)) throw new Error('Invalid fix run ID');
    return join(this.dataDir, 'workspaces', task.id, 'arc-fixes', save.runId);
  }
  async recoverFix(task: Task, save: FixSave) {
    const path = this.fixReceipt(task, save);
    const intent: ArcFixIntent | undefined = existsSync(path + '.intent')
      ? (JSON.parse(readFileSync(path + '.intent', 'utf8')) as ArcFixIntent)
      : undefined;
    if (existsSync(path)) {
      const head = readFileSync(path, 'utf8');
      if (head === intent?.reportedHead || (!intent && head === save.revision.head)) return head;
    }
    return this.confirmCommit(task, save, intent);
  }
  private async confirmCommit(
    task: Task,
    save: FixSave,
    intent: ArcFixIntent | undefined,
    signal?: AbortSignal,
  ) {
    const head = intent?.reportedHead;
    if (!intent || !head || !/^[a-f0-9]{40}$/.test(head))
      throw new Error(
        'Arc commit did not report an exact SHA for this fix run. The author copy was preserved.',
      );
    const after = await this.checkedAuthor(task, signal);
    if (
      after.branch !== intent.branch ||
      after.head !== head ||
      (intent.title &&
        (head === intent.parent ||
          (await this.bridge.native(
            ['log', '-n', '1', '--no-walk', '--format={title}', head],
            after.saved.mount,
            signal,
          )) !== intent.title))
    )
      throw new Error(
        'Arc did not confirm the commit reported by this fix run. The author copy was preserved.',
      );
    privateWrite(this.fixReceipt(task, save), head);
    return head;
  }
  async commit(task: Task, message: string, signal?: AbortSignal, save?: FixSave) {
    let attempted = false;
    try {
      return await this.commitCorrection(task, message, signal, save, () => {
        attempted = true;
      });
    } catch (error) {
      if (save && !attempted) throw new AppError('fix_before_commit', String(error));
      throw error;
    }
  }
  private async commitCorrection(
    task: Task,
    message: string,
    signal: AbortSignal | undefined,
    save: FixSave | undefined,
    committing: () => void,
  ) {
    const before = await this.checkedAuthor(task, signal);
    const { saved } = before;
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
      const title = save ? `${message.split('\n', 1)[0]} [daddyloop fix ${save.runId}]` : message;
      const intent: ArcFixIntent = { branch: before.branch, parent: before.head, title };
      if (save) privateWrite(this.fixReceipt(task, save) + '.intent', JSON.stringify(intent));
      committing();
      const output = await this.bridge.native(['commit', '-m', title], saved.mount, signal);
      if (!save) return (await this.checkedAuthor(task, signal)).head;

      // Arc prints "[<branch> <full SHA>] <title>" for the commit created by this invocation.
      const prefix = `[${before.branch} `;
      const hashes = new Set(
        output.split(/\r?\n/).flatMap((line) => {
          if (!line.startsWith(prefix)) return [];
          const match = /^([a-f0-9]{40})\] (.*)$/.exec(line.slice(prefix.length));
          return match?.[2] === title ? [match[1]] : [];
        }),
      );
      if (hashes.size === 1) {
        intent.reportedHead = hashes.values().next().value;
        privateWrite(this.fixReceipt(task, save) + '.intent', JSON.stringify(intent));
      }
      return this.confirmCommit(task, save, intent, signal);
    }
    const head = before.head;
    if (save) {
      const path = this.fixReceipt(task, save);
      privateWrite(
        path + '.intent',
        JSON.stringify({ branch: before.branch, parent: head, reportedHead: head }),
      );
      privateWrite(path, head);
    }
    return head;
  }
  async pushSavedFix(task: Task, head: string, signal?: AbortSignal) {
    const { author, branch } = await (async () => {
      const author = await this.checkedAuthor(task, signal);
      if (author.head !== head)
        throw new Error('The Arc author branch changed after the fixes were saved');
      const branch = task.pr?.branch;
      if (!branch?.startsWith('users/') || /[:\s]/.test(branch) || !/^[a-f0-9]{40}$/.test(head))
        throw new Error('Expected an explicit Arc users/<login>/<branch> push target');
      return { author, branch };
    })().catch((error) => {
      throw new AppError('fix_before_push', String(error));
    });
    await this.bridge.native(['push', `${head}:${branch}`], author.saved.mount, signal);
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
  async park(task: Task, role: Role) {
    const lease = task.arcWorkspaces?.[role];
    if (lease?.managed) await this.bridge.parkSessionMount(lease);
  }
  async release(task: Task, role: Role) {
    const saved = task.arcWorkspaces?.[role] as Saved | undefined;
    if (!saved) return { released: false };
    if (saved.managed)
      return {
        released: false,
        retained: true,
        reason: 'The session owns this copy until it is deleted',
      };
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
