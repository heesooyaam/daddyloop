import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { AppError, type Task, type Role } from '../core/types.js';
import { credential, redact, rememberSecret } from '../core/security.js';
import { ArcWorkspaces } from './arc-workspaces.js';

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
    const url = new URL(task.pr!.cloneUrl);
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
}
