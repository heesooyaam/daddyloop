import { existsSync, realpathSync, statSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError, now, type Project } from './types.js';
import type { Store } from './store.js';
import { git } from '../runtime/workspaces.js';
import { ArcBridge } from '../integrations/arcadia.js';

export const projectInput = z
  .object({
    name: z.string().trim().min(1).max(100),
    path: z.string().min(1).max(4000),
    scope: z.string().max(1000).optional(),
    base: z.string().max(200).optional(),
  })
  .strict();
export function projectScope(value: string) {
  if (
    isAbsolute(value) ||
    value.includes('\\') ||
    /[\0\r\n]/.test(value) ||
    value.split('/').some((part) => part === '..' || part === '.')
  )
    throw new AppError('invalid_scope', 'Use a relative directory inside the repository', 400);
  return value.replace(/\/+$/, '');
}
export class Projects {
  readonly roots: string[];
  constructor(
    readonly store: Store,
    roots = [homedir()],
    private arc = new ArcBridge(),
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
        'Choose a directory inside a configured project root',
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
  async register(input: z.infer<typeof projectInput>): Promise<Project> {
    input = projectInput.parse(input);
    const path = this.path(input.path);
    let root = path,
      vcs: Project['vcs'] | undefined;
    for (let at = path; ; at = dirname(at)) {
      // Never invoke Git inside Arcadia, including a selected subdirectory.
      if (existsSync(join(at, '.arc')) || existsSync(join(at, '.arcignore'))) {
        root = at;
        vcs = 'arcadia';
        break;
      }
      if (existsSync(join(at, '.git'))) {
        vcs = 'git';
        break;
      }
      if (dirname(at) === at) break;
    }
    let host: string, repo: string, provider: Project['provider'];
    if (vcs === 'arcadia') {
      const mount = (await this.arc.mounts()).find(
        (mount) => mount.path === root && mount.object_store_ok,
      );
      if (!mount)
        throw new AppError(
          'arcadia_project_unavailable',
          'Arcadia must use a mounted checkout and the configured shared object store',
          422,
        );
      host = 'a.yandex-team.ru';
      repo = 'arcadia';
      provider = 'arcadia';
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
          'Add a GitHub or GitLab remote before registering this project',
          422,
        );
      const address = await git(['remote', 'get-url', remote], root),
        scp = address.match(/^(?:git@)?([^:/]+):([^/\s][^\s]*)$/);
      const url = new URL(scp ? `ssh://git@${scp[1]}/${scp[2]}` : address);
      if (
        !['ssh:', 'https:'].includes(url.protocol) ||
        url.password ||
        url.port ||
        (url.protocol === 'https:' && url.username)
      )
        throw new AppError(
          'project_remote_invalid',
          'Use an SSH or HTTPS Git remote without embedded credentials',
          422,
        );
      host = url.hostname;
      repo = url.pathname.replace(/^\//, '').replace(/\.git$/, '');
      if (!/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/.test(repo))
        throw new Error('Unsupported repository name');
      provider = host.includes('gitlab') || remotes.includes('gitlab') ? 'gitlab' : 'github';
    } else
      throw new AppError(
        'project_repository_missing',
        'Choose a Git or mounted Arcadia repository',
        422,
      );
    const scope = projectScope(input.scope ?? relative(root, path).split(sep).join('/'));
    if (scope) {
      const cwd = realpathSync(join(root, scope));
      if (!cwd.startsWith(root + sep) || !statSync(cwd).isDirectory())
        throw new Error('The starting directory is outside the repository');
    }
    if (input.base && (!/^[A-Za-z0-9_./-]+$/.test(input.base) || input.base.startsWith('-')))
      throw new Error('Invalid base branch');
    const existing = this.store
      .projects()
      .find((project) => project.repoPath === root && project.scope === scope);
    const project: Project = {
      id: existing?.id ?? randomUUID(),
      name: input.name,
      repoPath: root,
      scope,
      vcs,
      provider,
      host,
      repo,
      base: input.base ?? (vcs === 'arcadia' ? 'trunk' : undefined),
      createdAt: existing?.createdAt ?? now(),
      updatedAt: now(),
    };
    if (existing && this.store.groups().some((group) => group.projectId === existing.id)) {
      if (existing.base !== project.base)
        throw new AppError(
          'project_in_use',
          'Create a separate project to change the base branch of existing sessions',
          409,
        );
    }
    this.store.saveProject(project);
    this.store.event('_system', 'project.saved', { id: project.id, name: project.name });
    return project;
  }
  async suggestions() {
    const candidates = new Set<string>();
    for (const root of this.roots) {
      for (const parent of [root, join(root, 'projects')]) {
        if (!existsSync(parent)) continue;
        for (const entry of (await readdir(parent, { withFileTypes: true })).slice(0, 200)) {
          const path = join(parent, entry.name);
          if (!entry.name.startsWith('.') && entry.isDirectory() && existsSync(join(path, '.git')))
            candidates.add(path);
        }
      }
    }
    try {
      for (const mount of await this.arc.mounts())
        if (mount.object_store_ok) candidates.add(mount.path);
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
  get(id: string) {
    return this.store.project(id);
  }
  list() {
    return this.store.projects();
  }
  cwd(root: string, scope = '') {
    const base = realpathSync(root),
      cwd = realpathSync(resolve(root, projectScope(scope)));
    if (cwd !== base && !cwd.startsWith(base + sep))
      throw new Error('The starting directory escaped its managed workspace');
    return cwd;
  }
}
