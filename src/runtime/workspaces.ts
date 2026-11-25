import {
  existsSync,
  mkdirSync,
  realpathSync,
  writeFileSync,
  readFileSync,
  lstatSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { AppError, type Task, type Role, type TicketRef } from '../core/types.js';
import { git } from './git.js';
export { git } from './git.js';
import { isGitAddress } from '../modules/repositories/git-source.js';
import { allRepositories } from '../modules/repositories/index.js';
import type { RepositoryRegistry } from '../modules/repositories/registry.js';
import { ArcWorkspaces } from './arc-workspaces.js';
import { ArcBridge } from '../integrations/arcadia.js';

export class Workspaces {
  private arc: ArcWorkspaces;
  constructor(
    readonly dataDir: string,
    private repositories: RepositoryRegistry = allRepositories(),
  ) {
    this.arc = new ArcWorkspaces(dataDir, new ArcBridge(dataDir));
  }
  protectSources(paths: () => string[]) {
    this.arc.protectedSources = paths;
  }
  async validate(path: string, provider?: string) {
    if (provider === 'arcadia') return this.arc.validate(path);
    if (isGitAddress(path)) {
      const source = provider ? this.remote(path, provider).source : undefined;
      if (!source) throw new AppError('repository_module_required', 'Choose a repository module');
      return source.url;
    }
    if (!path || !existsSync(path))
      throw new AppError(
        'repository_missing',
        'Provide the absolute path of an existing local Git checkout',
        400,
      );
    const absolute = realpathSync(path);
    const root = await git(['rev-parse', '--show-toplevel'], absolute);
    return realpathSync(root);
  }
  private remote(value: string, provider: string, host?: string) {
    const transport = this.repositories.get(provider).git;
    if (!transport)
      throw new AppError('git_transport_unavailable', 'The repository module has no Git transport');
    const source = transport.parse(value);
    if (host && source.host !== host)
      throw new AppError('clone_url_mismatch', 'The repository URL belongs to another host');
    return { source, env: transport.environment(source) };
  }
  private pushAddress(task: Task) {
    const address = task.pr?.cloneUrl ?? task.ticketRepository?.cloneUrl ?? '';
    const target = this.remote(address, task.ref.provider, task.ref.host).source;
    const preferred =
      task.ticketRepository?.cloneUrl ?? (isGitAddress(task.repoPath) ? task.repoPath : undefined);
    if (preferred) {
      const source = this.remote(preferred, task.ref.provider, task.ref.host).source;
      if (source.repo === target.repo) return source.url;
    }
    return address;
  }
  private env(task: Task, address = task.pr?.cloneUrl ?? task.ticketRepository?.cloneUrl ?? '') {
    return this.remote(address, task.ref.provider, task.ref.host).env;
  }
  private sourceEnv(task: Task) {
    return isGitAddress(task.repoPath) ? this.env(task, task.repoPath) : {};
  }
  private async initialize(task: Task, signal?: AbortSignal) {
    if (!/^[A-Za-z0-9_-]+$/.test(task.id)) throw new Error('Invalid task ID');
    const root = resolve(this.dataDir, 'workspaces', task.id),
      bare = join(root, 'objects.git');
    mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    const parent = resolve(this.dataDir, 'workspaces');
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    if (realpathSync(parent) !== join(realpathSync(this.dataDir), 'workspaces'))
      throw new Error('The Git workspace directory was redirected');
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const expected = join(realpathSync(this.dataDir), 'workspaces', task.id);
    if (realpathSync(root) !== expected) throw new Error('The Git workspace was redirected');
    const ownerPath = join(root, 'owner.json');
    if (existsSync(ownerPath)) {
      const owner = JSON.parse(readFileSync(ownerPath, 'utf8'));
      if (
        lstatSync(ownerPath).isSymbolicLink() ||
        owner.application !== 'daddyloop' ||
        owner.taskId !== task.id ||
        owner.source !== task.repoPath ||
        (owner.groupId && owner.groupId !== task.groupId) ||
        (owner.provider && owner.provider !== task.ref.provider)
      )
        throw new Error('Git workspace ownership changed; it was preserved');
    } else {
      if (existsSync(bare))
        throw new Error('The Git workspace has no ownership record; it was preserved');
      writeFileSync(
        ownerPath,
        JSON.stringify({
          application: 'daddyloop',
          taskId: task.id,
          source: task.repoPath,
          groupId: task.groupId,
          provider: task.ref.provider,
        }),
        { mode: 0o600, flag: 'wx' },
      );
    }
    if (
      existsSync(bare) &&
      (realpathSync(bare) !== join(expected, 'objects.git') || lstatSync(bare).isSymbolicLink())
    )
      throw new Error('The Git object store was redirected');
    if (!existsSync(join(bare, 'HEAD'))) await git(['init', '--bare', bare], root, {}, signal);
    return { root, bare };
  }
  private async verifyCopy(target: string, bare: string, signal?: AbortSignal) {
    if (
      lstatSync(target).isSymbolicLink() ||
      realpathSync(target) !== join(realpathSync(resolve(bare, '..')), target.split('/').at(-1)!)
    )
      throw new Error('The Git working copy was redirected; it was preserved');
    const common = await git(['rev-parse', '--git-common-dir'], target, {}, signal);
    if (realpathSync(resolve(target, common)) !== realpathSync(bare))
      throw new Error(
        `The Git working copy belongs to another repository; it was preserved: ${target} (${common})`,
      );
  }
  readPaths(task: Task): string[] {
    return task.ref.provider === 'arcadia'
      ? []
      : [join(this.dataDir, 'workspaces', task.id, 'objects.git')];
  }
  async prepare(task: Task, role: Role, signal?: AbortSignal): Promise<string> {
    if (task.ref.provider === 'arcadia') return this.arc.prepare(task, role, signal);
    const run = (args: string[], cwd: string, env: NodeJS.ProcessEnv = {}) =>
      git(args, cwd, env, signal);
    if (!task.revision || !task.pr)
      throw new AppError('revision_missing', 'Fetch the PR revision before preparing a workspace');
    const { root, bare } = await this.initialize(task, signal);
    const revisions = new Set([task.revision.head, task.revision.base, task.revision.start]);
    if (task.pr.state === 'merged' && task.pr.mergeCommit) revisions.add(task.pr.mergeCommit);
    for (const sha of revisions) {
      if (!/^[a-f0-9]{40,64}$/i.test(sha))
        throw new AppError('invalid_sha', 'Provider returned an invalid commit SHA');
      try {
        await run(['--git-dir', bare, 'cat-file', '-e', `${sha}^{commit}`], root);
      } catch {
        try {
          await run(
            ['--git-dir', bare, 'fetch', '--no-tags', '--', task.repoPath, sha],
            root,
            this.sourceEnv(task),
          );
        } catch {
          const address =
            sha === task.revision.base && task.pr.targetCloneUrl
              ? task.pr.targetCloneUrl
              : task.pr.cloneUrl;
          await run(
            ['--git-dir', bare, 'fetch', '--no-tags', '--', address, sha],
            root,
            this.env(task, address),
          );
        }
      }
    }
    const target =
      role === 'author'
        ? join(root, 'author')
        : join(
            root,
            `reviewer-${task.revision.head.slice(0, 12)}-${task.revision.start.slice(0, 8)}`,
          );
    if (existsSync(target)) await this.verifyCopy(target, bare, signal);
    if (!existsSync(target)) {
      const checkpoint = role === 'author' && task.fixingMergeConflict && task.conflictCheckpoint;
      const start =
        checkpoint &&
        /^[a-f0-9]{40,64}$/.test(checkpoint) &&
        existsSync(join(root, 'author-before-conflict-' + checkpoint))
          ? checkpoint
          : task.revision.head;
      await run(['--git-dir', bare, 'worktree', 'add', '--detach', target, start], root);
    } else if (role === 'author') {
      const current = await run(['rev-parse', 'HEAD'], target);
      if (current !== task.revision.head) {
        if (task.authorBaseHead === task.revision.head) {
          try {
            await run(['merge-base', '--is-ancestor', task.revision.head, current], target);
            task.authorWorktree = target;
            return target;
          } catch {
            /* A genuinely diverging checkout is handled below. */
          }
        }
        const dirty = await run(['status', '--porcelain'], target);
        if (dirty)
          throw new AppError(
            'workspace_dirty',
            `Author workspace contains uncommitted changes: ${target}. Inspect them before updating the revision.`,
          );
        // Preserve unpushed commits. Never reset or force-clean an author workspace.
        try {
          await run(['merge-base', '--is-ancestor', current, task.revision.head], target);
        } catch {
          throw new AppError(
            'workspace_diverged',
            `Author workspace has unpushed or diverging commits: ${target}. Reconcile them manually.`,
          );
        }
        await run(['checkout', '--detach', task.revision.head], target);
      }
    }
    await this.verifyCopy(target, bare, signal);
    if (role === 'author') {
      task.authorWorktree = target;
      task.authorBaseHead = task.revision.head;
    } else task.reviewerWorktree = target;
    return target;
  }
  private async savedConflictMerge(cwd: string, head: string, base: string, signal?: AbortSignal) {
    // A restart can occur between creating the merge commit and recording its SHA.
    const parents = await git(['show', '-s', '--format=%P', 'HEAD'], cwd, {}, signal);
    return (
      parents === head + ' ' + base && !(await git(['status', '--porcelain'], cwd, {}, signal))
    );
  }
  async pendingConflictBase(task: Task) {
    if (!task.authorWorktree || !task.revision || task.ref.provider !== 'github') return;
    const { root, bare } = await this.initialize(task);
    const cwd = task.authorWorktree;
    if (cwd !== join(root, 'author')) return;
    await this.verifyCopy(cwd, bare);
    if ((await git(['rev-parse', 'HEAD'], cwd)) !== (task.conflictCheckpoint ?? task.revision.head))
      return;
    return git(['rev-parse', '--verify', '-q', 'MERGE_HEAD'], cwd).catch(() => undefined);
  }
  async prepareConflict(task: Task, signal?: AbortSignal) {
    if (!task.authorWorktree || !task.revision || task.ref.provider !== 'github')
      throw new AppError(
        'workspace_missing',
        'A GitHub PR working copy is required to resolve conflicts',
      );
    const cwd = task.authorWorktree;
    const { base } = task.revision;
    const head = task.conflictCheckpoint ?? task.revision.head;
    const run = (args: string[]) => git(args, cwd, {}, signal);
    const { root, bare } = await this.initialize(task, signal);
    if (cwd !== join(root, 'author') || !/^[a-f0-9]{40,64}$/.test(head))
      throw new AppError(
        'workspace_invalid',
        'Conflict repair requires the managed author checkout',
      );
    await this.verifyCopy(cwd, bare, signal);
    const preserved = join(root, 'author-before-conflict-' + head);
    if (existsSync(preserved)) await this.verifyCopy(preserved, bare, signal);
    await run(['merge-base', '--is-ancestor', task.revision.head, head]);
    const current = await run(['rev-parse', 'HEAD']);
    const merging = await run(['rev-parse', '--verify', '-q', 'MERGE_HEAD']).catch(() => undefined);
    if (!merging && current !== head && (await this.savedConflictMerge(cwd, head, base, signal)))
      return existsSync(preserved) ? preserved : undefined;
    if (current !== head || (merging && merging !== base))
      throw new AppError(
        'workspace_diverged',
        'The worker copy has a different commit or unfinished merge. Its changes were preserved.',
      );
    if (!merging) {
      if (await run(['status', '--porcelain'])) {
        if (task.scope || existsSync(preserved))
          throw new AppError(
            'workspace_dirty',
            'Conflict repair found additional local changes. The working copies were preserved.',
          );
        // Move the entire worktree, including its index, ignored and untracked files.
        await git(['--git-dir', bare, 'worktree', 'move', cwd, preserved], root, {}, signal);
        await git(['--git-dir', bare, 'worktree', 'add', '--detach', cwd, head], root, {}, signal);
        await this.verifyCopy(cwd, bare, signal);
      }
      try {
        await run([
          '-c',
          'user.name=daddyloop',
          '-c',
          'user.email=daddyloop@localhost',
          'merge',
          '--no-commit',
          '--no-ff',
          base,
        ]);
      } catch (error) {
        // A merge with conflicts exits with status 1 and leaves the index for the worker.
        if (signal?.aborted || !(await run(['ls-files', '--unmerged']))) throw error;
      }
    }
    if ((await run(['rev-parse', '--verify', '-q', 'MERGE_HEAD']).catch(() => undefined)) !== base)
      throw new AppError(
        'merge_target_changed',
        'The worker copy has no pending merge of the expected target commit.',
      );
    if (task.scope) {
      const paths = (await run(['diff', '--name-only', '--diff-filter=U', '-z']))
        .split('\0')
        .filter(Boolean);
      if (paths.some((path) => !path.startsWith(task.scope!.replace(/\/$/, '') + '/')))
        throw new AppError(
          'workspace_scope',
          'The merge conflict includes files outside the task scope. The working copy was preserved.',
        );
    }
    return existsSync(preserved) ? preserved : undefined;
  }
  async commitFix(task: Task, message: string, signal?: AbortSignal): Promise<string> {
    if (task.ref.provider === 'arcadia') return this.arc.commit(task, message, signal);
    if (!task.authorWorktree || !task.revision || !task.pr)
      throw new AppError('workspace_missing', 'Author workspace is not initialized');
    const cwd = resolve(task.authorWorktree);
    const run = (args: string[], env: NodeJS.ProcessEnv = {}) => git(args, cwd, env, signal);
    if (!cwd.startsWith(resolve(this.dataDir, 'workspaces', task.id) + '/'))
      throw new AppError(
        'workspace_invalid',
        'Author workspace is outside the managed task directory',
      );
    await run(['merge-base', '--is-ancestor', task.revision.head, 'HEAD']);
    const merging = await run(['rev-parse', '--verify', '-q', 'MERGE_HEAD']).catch(() => undefined);
    if (task.fixingMergeConflict) {
      if (
        !merging &&
        (await this.savedConflictMerge(
          cwd,
          task.conflictCheckpoint ?? task.revision.head,
          task.revision.base,
          signal,
        ))
      )
        return run(['rev-parse', 'HEAD']);
      if (
        merging !== task.revision.base ||
        (await run(['rev-parse', 'HEAD'])) !== (task.conflictCheckpoint ?? task.revision.head)
      )
        throw new AppError(
          'merge_target_changed',
          'The worker copy has no pending merge of the expected target commit.',
        );
      // Stage the worker's resolutions, including a choice that changes no file from our side.
      const markerCheck = [
        '-c',
        'core.whitespace=-blank-at-eol,-blank-at-eof,-space-before-tab',
        'diff',
        '--check',
      ];
      try {
        await run(markerCheck);
        await run(['add', '--all', '--', '.']);
        await run([...markerCheck, '--cached']);
      } catch (error) {
        if (signal?.aborted) throw error;
        throw new AppError(
          'unresolved_merge',
          'Could not stage a clean conflict resolution. Inspect the working copy for remaining conflict markers.',
        );
      }
    } else {
      if (merging)
        throw new AppError(
          'unexpected_merge',
          'An unfinished merge in the worker copy needs inspection.',
        );
      if (!(await run(['status', '--porcelain']))) return run(['rev-parse', 'HEAD']);
      await run(['diff', '--check']);
      await run(['add', '--all', '--', '.']);
    }
    await run([
      '-c',
      'user.name=daddyloop',
      '-c',
      'user.email=daddyloop@localhost',
      'commit',
      '-m',
      message,
    ]);
    return run(['rev-parse', 'HEAD']);
  }
  async prepareSavedFixPush(task: Task, head: string, signal?: AbortSignal) {
    if (task.ref.provider === 'arcadia') return this.arc.prepareSavedFixPush(task, head, signal);
    if (!/^[A-Za-z0-9_-]+$/.test(task.id)) throw new Error('Invalid task ID');
    if (!task.pr || !task.revision || !/^[a-f0-9]{40,64}$/i.test(head))
      throw new AppError(
        'workspace_missing',
        'A saved author commit and PR workspace are required',
      );
    const root = join(realpathSync(this.dataDir), 'workspaces', task.id);
    const author = task.authorWorktree ?? join(root, 'author');
    if (!existsSync(author))
      throw new AppError('workspace_missing', 'The managed author workspace is missing');
    const cwd = realpathSync(author);
    if (cwd !== join(root, 'author') || realpathSync(root) !== root)
      throw new AppError(
        'workspace_invalid',
        'The author workspace is outside the managed task directory',
      );
    await this.verifyCopy(author, join(root, 'objects.git'), signal);
    const run = (args: string[], env: NodeJS.ProcessEnv = {}) => git(args, cwd, env, signal);
    if ((await run(['rev-parse', 'HEAD'])) !== head)
      throw new AppError(
        'stale_author_head',
        'The author branch changed after the fixes were saved',
      );
    await run(['merge-base', '--is-ancestor', task.revision.head, head]);
    await run(['check-ref-format', `refs/heads/${task.pr.branch}`]);
    const address = this.pushAddress(task);
    const env = this.env(task, address);
    const refspec = `${head}:refs/heads/${task.pr.branch}`;
    // An ordinary push cannot overwrite concurrent remote commits.
    return async () => {
      await run(['push', '--porcelain', '--', address, refspec], env);
    };
  }
  async arcPlanDocuments(task: Task, cwd: string) {
    return this.arc.planDocuments(task, cwd);
  }
  async releaseArc(task: Task, role: Role) {
    return this.arc.release(task, role);
  }
  async parkArc(task: Task, role: Role) {
    return this.arc.park(task, role);
  }
  async describeTicket(
    path: string,
    input: TicketRef,
    base?: string,
    session?: {
      groupId: string;
      taskId?: string;
      copyMode?: 'session' | 'pool';
      signal?: AbortSignal;
    },
  ) {
    if (
      input.provider !== 'arcadia' &&
      ['.arc', '.arcignore'].some((marker) => existsSync(join(path, marker)))
    )
      throw new AppError('repository_mismatch', 'Use a Tracker ticket with an Arcadia checkout');
    const repoPath = await this.validate(path, input.provider);
    if (input.provider === 'arcadia') {
      const name = base ?? 'trunk';
      if (!/^[A-Za-z0-9_./-]+$/.test(name) || name.startsWith('-'))
        throw new Error('Invalid Arc base revision');
      const bridge = new ArcBridge(this.dataDir);
      const owned =
        session?.copyMode === 'session'
          ? await bridge.sessionMount(
              {
                groupId: session.groupId,
                id: session.taskId ?? session.groupId,
              },
              'reviewer',
              session.signal,
            )
          : undefined;
      const baseHead = owned
        ? await bridge.native(
            ['merge-base', '--leftmost', name, name],
            owned.lease.mount,
            session?.signal,
          )
        : await bridge.withMount((mount) =>
            bridge.native(['merge-base', '--leftmost', name, name], mount),
          );
      if (!/^[a-f0-9]{40}$/.test(baseHead))
        throw new Error('Arc returned an invalid base revision');
      return {
        repoPath,
        ref: input,
        repository: {
          baseHead,
          baseBranch: /^[a-f0-9]{40}$/.test(name) ? 'trunk' : name,
          branch: '',
        },
      };
    }
    if (isGitAddress(repoPath)) {
      const { source, env } = this.remote(repoPath, input.provider, input.host);
      if (input.repo && input.repo !== source.repo)
        throw new AppError(
          'remote_mismatch',
          'The ticket and workspace refer to different repositories',
        );
      if (base && (!/^[A-Za-z0-9_./-]+$/.test(base) || base.startsWith('-')))
        throw new Error('Invalid base branch');
      mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
      const output = await git(
        ['ls-remote', '--symref', '--', source.url, 'HEAD', 'refs/heads/*'],
        this.dataDir,
        env,
        session?.signal,
      );
      const defaultBranch = output.match(/^ref: refs\/heads\/(.+)\tHEAD$/m)?.[1];
      const branch = base?.replace(/^refs\/heads\//, '') ?? defaultBranch;
      if (!branch)
        throw new AppError(
          'base_missing',
          'The remote has no default branch; choose a base branch',
        );
      const refs = new Map(
        output
          .split('\n')
          .map((line) => line.split('\t'))
          .filter(([sha]) => /^[a-f0-9]{40,64}$/.test(sha))
          .map(([sha, ref]) => [ref, sha]),
      );
      const baseHead = refs.get(`refs/heads/${branch}`);
      if (!baseHead)
        throw new AppError(
          'base_missing',
          'The selected branch does not exist in the remote repository',
        );
      return {
        repoPath,
        ref: { ...input, repo: source.repo },
        repository: { baseHead, baseBranch: branch, cloneUrl: source.url, branch: '' },
      };
    }
    const remotes = (await git(['remote'], repoPath)).split('\n').filter(Boolean);
    const remote = remotes.includes('origin')
      ? 'origin'
      : remotes.includes('github')
        ? 'github'
        : remotes[0];
    if (!remote)
      throw new AppError(
        'remote_missing',
        'Configure a Git remote in this checkout before starting ticket work',
      );
    const address = await git(['remote', 'get-url', remote], repoPath);
    const { source } = this.remote(address, input.provider, input.host);
    const repo = source.repo;
    if (base && (base.startsWith('-') || /[\r\n\0]/.test(base)))
      throw new Error('Invalid base revision');
    let symbolic: string | undefined;
    try {
      symbolic = await git(['symbolic-ref', '--short', `refs/remotes/${remote}/HEAD`], repoPath);
    } catch {
      /* Locally initialized checkouts may have no remote HEAD. */
    }
    const candidates = base
      ? [base]
      : [symbolic, `${remote}/main`, `${remote}/master`, 'main', 'master', 'HEAD'].filter(
          (value): value is string => !!value,
        );
    for (const candidate of candidates) {
      try {
        const baseHead = await git(['rev-parse', '--verify', `${candidate}^{commit}`], repoPath);
        if (!/^[a-f0-9]{40,64}$/.test(baseHead)) continue;
        let baseBranch = (base ?? symbolic ?? candidate)
          .replace(`refs/remotes/${remote}/`, '')
          .replace(`${remote}/`, '')
          .replace('refs/heads/', '');
        if (baseBranch === 'HEAD' || /^[a-f0-9]{40,64}$/.test(baseBranch))
          baseBranch = await git(['symbolic-ref', '--short', 'HEAD'], repoPath).catch(() => 'main');
        return {
          repoPath,
          ref: { ...input, repo },
          repository: {
            baseHead,
            baseBranch,
            cloneUrl: source.url,
            branch: '',
          },
        };
      } catch {
        /* Read the next local base without changing the user's checkout. */
      }
    }
    throw new AppError(
      'base_missing',
      'No committed base was found; fetch the desired branch and try again',
    );
  }
  async prepareTicket(task: Task, role: Role, signal?: AbortSignal) {
    if (task.ref.provider === 'arcadia') return this.arc.prepare(task, role, signal);
    if (!task.revision || !task.ticketRepository)
      throw new Error('Ticket repository is not initialized');
    const { root, bare } = await this.initialize(task, signal);
    const run = (args: string[], cwd = root, env: NodeJS.ProcessEnv = {}) =>
      git(args, cwd, env, signal);
    try {
      await run(['--git-dir', bare, 'cat-file', '-e', `${task.revision.head}^{commit}`]);
    } catch {
      await run(
        ['--git-dir', bare, 'fetch', '--no-tags', '--', task.repoPath, task.revision.head],
        root,
        this.sourceEnv(task),
      );
    }
    const target =
      role === 'author'
        ? join(root, 'author')
        : join(
            root,
            `reviewer-${task.revision.head.slice(0, 12)}-${task.revision.start.slice(0, 8)}`,
          );
    if (!existsSync(target)) {
      if (role === 'reviewer')
        await run(['--git-dir', bare, 'worktree', 'add', '--detach', target, task.revision.head]);
      else {
        const branch = task.ticketRepository.branch;
        await run(['check-ref-format', `refs/heads/${branch}`]);
        let existing = false;
        try {
          await run(['--git-dir', bare, 'rev-parse', '--verify', `refs/heads/${branch}`]);
          existing = true;
        } catch {
          /* First preparation. */
        }
        await run([
          '--git-dir',
          bare,
          'worktree',
          'add',
          ...(existing ? [] : ['-b', branch]),
          target,
          existing ? branch : task.revision.head,
        ]);
      }
    }
    await this.verifyCopy(target, bare, signal);
    const head = await run(['rev-parse', 'HEAD'], target);
    if (role === 'author') {
      if ((await run(['symbolic-ref', '--short', 'HEAD'], target)) !== task.ticketRepository.branch)
        throw new Error('The author branch changed outside daddyloop; it was preserved');
      await run(['merge-base', '--is-ancestor', task.revision.head, head], target);
      task.authorWorktree = target;
      task.authorBaseHead = head;
      task.revision = { ...task.revision, head };
    } else {
      if (head !== task.revision.head || (await run(['status', '--porcelain'], target)))
        throw new Error('The reviewer snapshot was modified; it was preserved');
      task.reviewerWorktree = target;
    }
    return target;
  }
  async commitTicket(task: Task, message: string, signal?: AbortSignal) {
    if (task.ref.provider === 'arcadia') return this.arc.commit(task, message, signal);
    if (!task.authorWorktree || !task.ticketRepository || !task.revision)
      throw new Error('The author workspace is not initialized');
    const cwd = realpathSync(task.authorWorktree),
      root = realpathSync(join(this.dataDir, 'workspaces', task.id));
    if (cwd !== join(root, 'author'))
      throw new Error('The author workspace is outside its managed directory');
    const run = (args: string[]) => git(args, cwd, {}, signal);
    if (
      realpathSync(await run(['rev-parse', '--git-common-dir'])) !==
      realpathSync(join(root, 'objects.git'))
    )
      throw new Error('The author workspace belongs to another repository');
    if ((await run(['symbolic-ref', '--short', 'HEAD'])) !== task.ticketRepository.branch)
      throw new Error('The author branch changed outside daddyloop');
    await run(['merge-base', '--is-ancestor', task.revision.head, 'HEAD']);
    if (await run(['status', '--porcelain'])) {
      await run(['diff', '--check']);
      await run(['add', '--all', '--', '.']);
      await run([
        '-c',
        'user.name=daddyloop',
        '-c',
        'user.email=daddyloop@localhost',
        'commit',
        '-m',
        message,
      ]);
    }
    return await run(['rev-parse', 'HEAD']);
  }
  async pushTicket(task: Task, signal?: AbortSignal) {
    if (!task.authorWorktree || !task.ticketRepository || !task.pendingAuthorHead)
      throw new Error('No prepared implementation is available');
    if (task.ref.provider === 'arcadia') return;
    const cwd = realpathSync(task.authorWorktree),
      root = realpathSync(join(this.dataDir, 'workspaces', task.id));
    if (cwd !== join(root, 'author'))
      throw new Error('The author workspace is outside its managed directory');
    if (
      (await git(['symbolic-ref', '--short', 'HEAD'], cwd, {}, signal)) !==
      task.ticketRepository.branch
    )
      throw new Error('The author branch changed outside daddyloop');
    const common = realpathSync(await git(['rev-parse', '--git-common-dir'], cwd, {}, signal));
    if (common !== realpathSync(join(root, 'objects.git')))
      throw new Error('The author workspace belongs to another repository');
    if (
      (await git(['status', '--porcelain'], cwd, {}, signal)) ||
      (await git(['rev-parse', 'HEAD'], cwd, {}, signal)) !== task.pendingAuthorHead
    )
      throw new Error('The saved implementation changed; inspect it before submitting');
    await git(
      [
        'push',
        '--porcelain',
        '--',
        task.ticketRepository.cloneUrl!,
        `HEAD:refs/heads/${task.ticketRepository.branch}`,
      ],
      cwd,
      this.env(task),
      signal,
    );
  }
}
