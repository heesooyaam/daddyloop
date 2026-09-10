import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { AppError, type Task, type Role, type TicketRef } from '../core/types.js';
import { credential, redact, rememberSecret } from '../core/security.js';
import { ArcWorkspaces } from './arc-workspaces.js';
import { ArcBridge } from '../integrations/arcadia.js';

export async function git(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = {},
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(
      'git',
      ['-c', 'core.hooksPath=/dev/null', '-c', 'http.followRedirects=false', ...args],
      {
        cwd,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env },
        signal,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let output = '',
      error = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), 120000);
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
      if (output.length > 8_000_000) child.kill('SIGTERM');
    });
    child.stderr.on('data', (chunk) => {
      if (error.length < 16000) error += chunk.toString();
    });
    child.once('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      code === 0
        ? resolveResult(output.trim())
        : reject(new AppError('git_failed', redact(error || `git exited ${code}`), 422));
    });
  });
}
export class Workspaces {
  private arc: ArcWorkspaces;
  constructor(readonly dataDir: string) {
    this.arc = new ArcWorkspaces(dataDir);
  }
  protectSources(paths: () => string[]) {
    this.arc.protectedSources = paths;
  }
  async validate(path: string, provider?: string) {
    if (provider === 'arcadia') return this.arc.validate(path);
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
  private env(task: Task) {
    const url = new URL(task.pr?.cloneUrl ?? task.ticketRepository?.cloneUrl ?? '');
    if (
      url.protocol !== 'https:' ||
      url.hostname !== task.ref.host ||
      url.username ||
      url.password ||
      url.port
    )
      throw new AppError(
        'clone_url_mismatch',
        'Provider returned a clone URL outside the configured HTTPS host',
      );
    const token = credential(task.ref.provider, task.ref.host);
    const user = task.ref.provider === 'github' ? 'x-access-token' : 'oauth2';
    return {
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: `http.${url.origin}/.extraHeader`,
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${rememberSecret(Buffer.from(`${user}:${token}`).toString('base64'))}`,
      GIT_CONFIG_KEY_1: 'credential.helper',
      GIT_CONFIG_VALUE_1: '',
    };
  }
  async prepare(task: Task, role: Role, signal?: AbortSignal): Promise<string> {
    if (task.ref.provider === 'arcadia') return this.arc.prepare(task, role, signal);
    const run = (args: string[], cwd: string, env: NodeJS.ProcessEnv = {}) =>
      git(args, cwd, env, signal);
    if (!task.revision || !task.pr)
      throw new AppError('revision_missing', 'Fetch the PR revision before preparing a workspace');
    const root = join(this.dataDir, 'workspaces', task.id),
      bare = join(root, 'objects.git');
    mkdirSync(root, { recursive: true, mode: 0o700 });
    if (!existsSync(bare)) {
      await run(['init', '--bare', bare], root);
      writeFileSync(
        join(root, 'owner.json'),
        JSON.stringify({
          application: 'reviewloop',
          taskId: task.id,
          source: task.repoPath,
        }),
        { mode: 0o600 },
      );
    }
    for (const sha of new Set([task.revision.head, task.revision.base, task.revision.start])) {
      if (!/^[a-f0-9]{40,64}$/i.test(sha))
        throw new AppError('invalid_sha', 'Provider returned an invalid commit SHA');
      try {
        await run(['--git-dir', bare, 'cat-file', '-e', `${sha}^{commit}`], root);
      } catch {
        try {
          await run(['--git-dir', bare, 'fetch', '--no-tags', '--', task.repoPath, sha], root);
        } catch {
          await run(
            ['--git-dir', bare, 'fetch', '--no-tags', '--', task.pr.cloneUrl, sha],
            root,
            this.env(task),
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
    if (!existsSync(target))
      await run(
        ['--git-dir', bare, 'worktree', 'add', '--detach', target, task.revision.head],
        root,
      );
    else if (role === 'author') {
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
    if (role === 'author') {
      task.authorWorktree = target;
      task.authorBaseHead = task.revision.head;
    } else task.reviewerWorktree = target;
    return target;
  }
  async submit(
    task: Task,
    message: string,
    signal?: AbortSignal,
  ): Promise<{ head: string; pushed: boolean }> {
    if (task.ref.provider === 'arcadia') return this.arc.submit(task, message, signal);
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
    const dirty = await run(['status', '--porcelain']);
    if (dirty) {
      await run(['diff', '--check']);
      await run(['add', '--all', '--', '.']);
      await run([
        '-c',
        'user.name=Reviewloop',
        '-c',
        'user.email=reviewloop@localhost',
        'commit',
        '-m',
        message,
      ]);
    }
    const head = await run(['rev-parse', 'HEAD']);
    if (head === task.revision.head) return { head, pushed: false };
    if (!task.policy.autoPush) return { head, pushed: false };
    await run(['check-ref-format', `refs/heads/${task.pr.branch}`]);
    // An ordinary push cannot overwrite concurrent remote commits.
    await run(
      ['push', '--porcelain', '--', task.pr.cloneUrl, `HEAD:refs/heads/${task.pr.branch}`],
      this.env(task),
    );
    return { head, pushed: true };
  }
  async arcPlanDocuments(task: Task, cwd: string) {
    return this.arc.planDocuments(task, cwd);
  }
  async releaseArc(task: Task, role: Role) {
    return this.arc.release(task, role);
  }
  async describeTicket(path: string, input: TicketRef, base?: string) {
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
      const bridge = new ArcBridge(),
        baseHead = await bridge.withMount((mount) =>
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
    const remotes = (await git(['remote'], repoPath)).split('\n').filter(Boolean);
    const remote = remotes.includes('origin')
      ? 'origin'
      : remotes.includes('github')
        ? 'github'
        : remotes[0];
    if (!remote)
      throw new AppError(
        'remote_missing',
        'Configure a GitHub remote in this checkout before starting ticket work',
      );
    const address = await git(['remote', 'get-url', remote], repoPath);
    const scp = address.match(/^(?:git@)?([^:/]+):([^/][^\s]+)$/);
    const url = new URL(scp ? `https://${scp[1]}/${scp[2]}` : address);
    const repo = url.pathname.replace(/^\//, '').replace(/\.git$/, '');
    if (
      !['https:', 'ssh:'].includes(url.protocol) ||
      url.hostname !== input.host ||
      !(
        input.provider === 'gitlab'
          ? /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/
          : /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
      ).test(repo) ||
      url.password ||
      url.port
    )
      throw new AppError(
        'remote_mismatch',
        'The checkout must have a GitHub remote on the ticket’s configured host',
      );
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
            cloneUrl: `https://${url.hostname}/${repo}.git`,
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
    const root = join(this.dataDir, 'workspaces', task.id),
      bare = join(root, 'objects.git');
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const run = (args: string[], cwd = root) => git(args, cwd, {}, signal);
    if (!existsSync(bare)) {
      await run(['init', '--bare', bare]);
      writeFileSync(
        join(root, 'owner.json'),
        JSON.stringify({ application: 'reviewloop', taskId: task.id, source: task.repoPath }),
        { mode: 0o600 },
      );
    }
    try {
      await run(['--git-dir', bare, 'cat-file', '-e', `${task.revision.head}^{commit}`]);
    } catch {
      await run(['--git-dir', bare, 'fetch', '--no-tags', '--', task.repoPath, task.revision.head]);
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
    const head = await run(['rev-parse', 'HEAD'], target);
    if (role === 'author') {
      if ((await run(['symbolic-ref', '--short', 'HEAD'], target)) !== task.ticketRepository.branch)
        throw new Error('The author branch changed outside Reviewloop; it was preserved');
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
      throw new Error('The author branch changed outside Reviewloop');
    await run(['merge-base', '--is-ancestor', task.revision.head, 'HEAD']);
    if (await run(['status', '--porcelain'])) {
      await run(['diff', '--check']);
      await run(['add', '--all', '--', '.']);
      await run([
        '-c',
        'user.name=Reviewloop',
        '-c',
        'user.email=reviewloop@localhost',
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
      throw new Error('The author branch changed outside Reviewloop');
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
