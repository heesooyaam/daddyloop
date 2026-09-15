import { existsSync, realpathSync, statSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError, now, type Workspace } from './types.js';
import type { Store } from './store.js';
import { git } from '../runtime/workspaces.js';
import { allRepositories } from '../modules/repositories/index.js';
import type { RepositoryRegistry } from '../modules/repositories/registry.js';
import { isGitAddress, parseGitSource } from '../modules/repositories/git-source.js';
import { ArcBridge } from '../integrations/arcadia.js';

export const workspaceSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    path: z.string().min(1).max(4000),
    scope: z.string().max(1000).optional(),
    base: z.string().max(200).optional(),
    copyMode: z.enum(['session', 'pool']).optional(),
    provider: z
      .string()
      .regex(/^[a-z][a-z0-9-]{0,31}$/)
      .optional(),
  })
  .strict();
export const repositorySelectionSchema = workspaceSchema
  .omit({ name: true })
  .partial({ path: true });
export type RepositorySelection = z.infer<typeof repositorySelectionSchema>;
export function workspaceScope(value: string) {
  if (
    isAbsolute(value) ||
    value.includes('\\') ||
    /[\0\r\n]/.test(value) ||
    value.split('/').some((part) => part === '..' || part === '.')
  )
    throw new AppError('invalid_scope', 'Use a relative directory inside the repository', 400);
  return value.replace(/\/+$/, '');
}
export class WorkspaceRegistry {
  readonly roots: string[];
  constructor(
    readonly store: Store,
    roots = [homedir()],
    private arc = new ArcBridge(),
    private repositories: RepositoryRegistry = allRepositories(),
  ) {
    this.roots = roots.filter(existsSync).map((root) => realpathSync(root));
  }
  private path(value: string) {
    const expanded =
      value === '~' ? homedir() : value.startsWith('~/') ? join(homedir(), value.slice(2)) : value;
    if (!isAbsolute(expanded) || /[\0\r\n]/.test(expanded))
      throw new AppError('invalid_directory', 'Choose an absolute directory on the server', 400);
    const path = realpathSync(expanded);
    if (
      !statSync(path).isDirectory() ||
      !this.roots.some((root) => path === root || path.startsWith(root + sep))
    )
      throw new AppError(
        'directory_outside_roots',
        'Choose a directory inside a configured workspace root',
        403,
      );
    return path;
  }
  async browse(value?: string) {
    if (!value)
      return {
        path: '',
        parent: null,
        directories: this.roots.map((path) => ({ name: path, path })),
        truncated: false,
      };
    const path = this.path(value),
      entries = await readdir(path, { withFileTypes: true });
    const candidates = entries
      .filter(
        (entry) => !entry.name.startsWith('.') && (entry.isDirectory() || entry.isSymbolicLink()),
      )
      .sort((a, b) => a.name.localeCompare(b.name));
    const directories = candidates.slice(0, 150).flatMap((entry) => {
      try {
        const child = this.path(join(path, entry.name));
        return [{ name: entry.name, path: child }];
      } catch {
        return [];
      }
    });
    return {
      path,
      parent: this.roots.includes(path) ? null : dirname(path),
      directories,
      truncated: candidates.length > 150,
    };
  }
  private async inspect(input: z.infer<typeof workspaceSchema>): Promise<Workspace> {
    input = workspaceSchema.parse(input);
    if (isGitAddress(input.path)) {
      const parsed = parseGitSource(input.path);
      const module = this.repositories.forRepository(
        { vcs: 'git', host: parsed.host, remotes: [] },
        input.provider,
      );
      if (!module.git)
        throw new AppError(
          'git_transport_unavailable',
          'The repository module has no Git transport',
          422,
        );
      const source = module.git.parse(input.path);
      if (input.copyMode === 'pool')
        throw new AppError(
          'invalid_copy_mode',
          'The mount pool is available only for Arcadia',
          400,
        );
      if (input.base && (!/^[A-Za-z0-9_./-]+$/.test(input.base) || input.base.startsWith('-')))
        throw new Error('Invalid base branch');
      return {
        id: randomUUID(),
        name: input.name,
        repoPath: source.url,
        scope: workspaceScope(input.scope ?? ''),
        vcs: 'git',
        provider: module.id,
        host: source.host,
        repo: source.repo,
        base: input.base || undefined,
        copyMode: 'session',
        createdAt: now(),
        updatedAt: now(),
      };
    }
    const path = this.path(input.path);
    let root = path,
      vcs: Workspace['vcs'] | undefined;
    let gitRoot: string | undefined;
    for (let at = path; ; at = dirname(at)) {
      // Never invoke Git inside Arcadia, including a selected subdirectory.
      if (
        at !== homedir() &&
        (existsSync(join(at, '.arc')) || existsSync(join(at, '.arcignore')))
      ) {
        root = at;
        vcs = 'arcadia';
        break;
      }
      if (!gitRoot && existsSync(join(at, '.git'))) gitRoot = at;
      if (dirname(at) === at) break;
    }
    if (!vcs && gitRoot) vcs = 'git';
    let host: string, repo: string, provider: Workspace['provider'];
    if (vcs === 'arcadia') {
      this.repositories.forRepository(
        { vcs: 'arcadia', host: 'a.yandex-team.ru', remotes: [] },
        input.provider,
      );
      const mounts = await this.arc.mounts();
      const mount = mounts
        .filter((mount) => path === mount.path || path.startsWith(mount.path + '/'))
        .sort((a, b) => b.path.length - a.path.length)[0];
      const native =
        !mount && typeof this.arc.sourceMounts === 'function'
          ? (await this.arc.sourceMounts())
              .filter(
                (mount) =>
                  mount.status === 'mounted' &&
                  (path === mount.mount || path.startsWith(mount.mount + '/')),
              )
              .sort((a, b) => b.mount.length - a.mount.length)[0]
          : undefined;
      if (!mount)
        if (!native)
          throw new AppError(
            'arcadia_project_unavailable',
            'Choose an existing mounted Arcadia source. The service creates its own working copies.',
            422,
          );
      if (mount?.managed)
        throw new AppError(
          'managed_workspace_source',
          'Choose the original source folder, not a session-owned copy',
          422,
        );
      if (mount && !(mount.mounted || mount.object_store_ok))
        throw new AppError(
          'arcadia_project_unavailable',
          'The selected Arcadia source is not mounted',
          422,
        );
      root = mount?.path ?? native!.mount;
      this.path(root);
      host = 'a.yandex-team.ru';
      repo = 'arcadia';
      provider = this.repositories.forRepository(
        { vcs: 'arcadia', host, remotes: [] },
        input.provider,
      ).id;
    } else if (vcs === 'git') {
      root = realpathSync(await git(['rev-parse', '--show-toplevel'], path));
      this.path(root);
      const remotes = (await git(['remote'], root)).split('\n').filter(Boolean);
      const remote =
        remotes.find((name) => name === 'origin') ??
        remotes.find((name) => name === 'github') ??
        remotes[0];
      if (!remote)
        throw new AppError(
          'project_remote_missing',
          'Add a GitHub or GitLab remote before registering this workspace',
          422,
        );
      const address = await git(['remote', 'get-url', remote], root);
      const parsed = parseGitSource(address);
      const module = this.repositories.forRepository(
        { vcs: 'git', host: parsed.host, remotes },
        input.provider,
      );
      if (!module.git)
        throw new AppError(
          'git_transport_unavailable',
          'The repository module has no Git transport',
          422,
        );
      const source = module.git.parse(address);
      host = source.host;
      repo = source.repo;
      provider = module.id;
      if (input.copyMode === 'pool')
        throw new AppError(
          'invalid_copy_mode',
          'The mount pool is available only for Arcadia',
          400,
        );
    } else
      throw new AppError(
        'project_repository_missing',
        'Choose a Git or mounted Arcadia repository',
        422,
      );
    this.repositories.get(provider);
    const scope = workspaceScope(input.scope ?? relative(root, path).split(sep).join('/'));
    if (scope) {
      const cwd = realpathSync(join(root, scope));
      if (!cwd.startsWith(root + sep) || !statSync(cwd).isDirectory())
        throw new Error('The starting directory is outside the repository');
    }
    if (input.base && (!/^[A-Za-z0-9_./-]+$/.test(input.base) || input.base.startsWith('-')))
      throw new Error('Invalid base branch');
    return {
      id: randomUUID(),
      name: input.name,
      repoPath: root,
      scope,
      vcs,
      provider,
      host,
      repo,
      base: input.base || (vcs === 'arcadia' ? 'trunk' : undefined),
      copyMode: input.copyMode ?? 'session',
      createdAt: now(),
      updatedAt: now(),
    };
  }
  private sameSource(value: string, saved: string) {
    if (isGitAddress(value) || isGitAddress(saved))
      return (
        isGitAddress(value) &&
        isGitAddress(saved) &&
        parseGitSource(value).url === parseGitSource(saved).url
      );
    const path = this.path(value);
    return path === saved || path.startsWith(saved + sep);
  }
  async selection(workspace: Workspace, input?: RepositorySelection): Promise<Workspace> {
    this.repositories.get(workspace.provider);
    if (!input || !Object.keys(input).length)
      return workspace.vcs === 'arcadia'
        ? { ...workspace, copyMode: workspace.copyMode ?? 'session' }
        : { ...workspace };
    input = repositorySelectionSchema.parse(input);
    const sameSource = !input.path || this.sameSource(input.path, workspace.repoPath);
    const selected = await this.inspect({
      provider: input.provider ?? (sameSource ? workspace.provider : undefined),
      name: workspace.name,
      copyMode: input.copyMode ?? (sameSource ? workspace.copyMode : undefined),
      path: input.path ?? workspace.repoPath,
      scope: input.scope ?? (input.path ? undefined : workspace.scope),
      // A different repository must not inherit a branch name from another VCS.
      base: input.base ?? (input.path ? undefined : workspace.base),
    });
    const identity = (value: Workspace) => [
      value.repoPath,
      value.scope,
      value.base ?? '',
      value.host,
      value.repo,
      value.provider,
      ...(value.copyMode ? [value.copyMode] : []),
    ];
    const changed = JSON.stringify(identity(selected)) !== JSON.stringify(identity(workspace));
    const hash = createHash('sha256')
      .update(JSON.stringify([workspace.id, ...identity(selected)]))
      .digest('hex');
    const id = changed
      ? `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`
      : workspace.id;
    return { ...selected, id, createdAt: workspace.createdAt };
  }
  async register(input: z.infer<typeof workspaceSchema>, id?: string): Promise<Workspace> {
    const previous = id ? this.get(id) : undefined;
    const sameSource = previous && this.sameSource(input.path, previous.repoPath);
    const workspace = await this.inspect({
      ...input,
      provider: input.provider ?? (sameSource ? previous.provider : undefined),
      copyMode: input.copyMode ?? (sameSource ? previous.copyMode : undefined),
    });
    const existing = id
      ? this.get(id)
      : this.store
          .workspaces()
          .find(
            (saved) => saved.repoPath === workspace.repoPath && saved.scope === workspace.scope,
          );
    if (existing) {
      workspace.id = existing.id;
      workspace.createdAt = existing.createdAt;
    }
    this.store.saveWorkspace(workspace);
    this.store.event('_system', 'workspace.saved', { id: workspace.id, name: workspace.name });
    return workspace;
  }
  async suggestions() {
    const candidates = new Set<string>();
    for (const root of this.roots) {
      for (const parent of [root, join(root, 'workspaces')]) {
        if (!existsSync(parent)) continue;
        for (const entry of (await readdir(parent, { withFileTypes: true })).slice(0, 200)) {
          const path = join(parent, entry.name);
          if (!entry.name.startsWith('.') && entry.isDirectory() && existsSync(join(path, '.git')))
            candidates.add(path);
        }
      }
    }
    try {
      for (const mount of this.repositories.list().some((module) => module.vcs === 'arcadia')
        ? await this.arc.mounts()
        : [])
        if (!mount.managed && (mount.mounted || mount.object_store_ok)) candidates.add(mount.path);
    } catch {
      /* Git-only installations need no Arc CLI. */
    }
    return [...candidates]
      .filter((path) => {
        try {
          return !!this.path(path);
        } catch {
          return false;
        }
      })
      .map((path) => ({ name: basename(path), path }));
  }
  get(id: string): Workspace {
    const workspace = this.store.workspace(id);
    return workspace.vcs === 'arcadia'
      ? { ...workspace, copyMode: workspace.copyMode ?? 'session' }
      : workspace;
  }
  modules() {
    return this.repositories.list().map(({ id, name, vcs }) => ({ id, name, vcs }));
  }
  list() {
    return this.store
      .workspaces()
      .map((workspace) => this.get(workspace.id))
      .filter((workspace) =>
        this.repositories.list().some((module) => module.id === workspace.provider),
      );
  }
  cwd(root: string, scope = '') {
    const base = realpathSync(root),
      cwd = realpathSync(resolve(root, workspaceScope(scope)));
    if (cwd !== base && !cwd.startsWith(base + sep))
      throw new Error('The starting directory escaped its managed workspace');
    return cwd;
  }
}
