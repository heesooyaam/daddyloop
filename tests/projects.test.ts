import { afterEach, expect, it, vi } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  rmSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/core/store.js';
import { Projects, projectScope } from '../src/core/projects.js';
import type { ArcBridge } from '../src/integrations/arcadia.js';
import * as workspaces from '../src/runtime/workspaces.js';
afterEach(() => vi.restoreAllMocks());
it('registers a named Git project with a relative working directory without changing the source checkout', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'daddy-project-'))),
    repo = join(dir, 'repo'),
    store = new Store(':memory:');
  mkdirSync(join(repo, 'src'), { recursive: true });
  const run = (args: string[]) =>
    execFileSync('git', args, {
      cwd: repo,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  try {
    run(['init']);
    run(['config', 'user.name', 'Fixture']);
    run(['config', 'user.email', 'fixture@example.test']);
    writeFileSync(join(repo, 'src/file.txt'), 'original');
    run(['add', '.']);
    run(['commit', '-m', 'fixture']);
    run(['remote', 'add', 'origin', 'git@github.com:test/repo.git']);
    const before = run(['rev-parse', 'HEAD']);
    writeFileSync(join(repo, 'src/file.txt'), 'user changes');
    const projects = new Projects(store, [dir], { mounts: async () => [] } as unknown as ArcBridge);
    const project = await projects.register({ name: 'My app', path: join(repo, 'src') });
    const selected = await projects.selection(project, { path: repo, base: 'release' });
    expect(selected).toMatchObject({ repoPath: repo, scope: '', base: 'release' });
    expect(selected.id).not.toBe(project.id);
    expect((await projects.selection(project, { path: repo, base: 'release' })).id).toBe(
      selected.id,
    );
    expect(projects.get(project.id)).toEqual(project);
    expect(projects.list()).toHaveLength(1);
    expect(project).toMatchObject({
      repoPath: repo,
      scope: 'src',
      provider: 'github',
      repo: 'test/repo',
    });
    expect((await projects.register({ name: 'Renamed app', path: join(repo, 'src') })).id).toBe(
      project.id,
    );
    run(['remote', 'set-url', 'origin', 'https://github.com/test/repo.git']);
    expect((await projects.register({ name: 'HTTPS app', path: join(repo, 'src') })).id).toBe(
      project.id,
    );
    expect(run(['rev-parse', 'HEAD'])).toBe(before);
    expect(readFileSync(join(repo, 'src/file.txt'), 'utf8')).toBe('user changes');
    symlinkSync(dir, join(repo, 'escape'));
    await expect(
      projects.register({ name: 'Escape', path: repo, scope: 'escape' }),
    ).rejects.toThrow('outside');
    expect(() => projectScope('../outside')).toThrow('relative');
    const saved = projects.get(project.id),
      groupId = randomUUID();
    store.saveGroup({
      id: groupId,
      rootTaskId: '',
      title: 'Old session',
      requirements: '',
      projectId: saved.id,
      orchestrated: true,
      reviewer: { engine: 'codex' },
      generation: 1,
      createdAt: saved.createdAt,
      updatedAt: saved.updatedAt,
    });
    await projects.register({ name: saved.name, path: repo, base: 'release' }, saved.id);
    expect(store.getGroup(groupId).project).toEqual(saved);
    expect(projects.get(saved.id)).toMatchObject({ repoPath: repo, scope: '', base: 'release' });
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
it('detects Arcadia before Git and uses the configured shared-store mounts', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'daddy-project-arc-'))),
    store = new Store(':memory:');
  mkdirSync(join(dir, 'alice'));
  writeFileSync(join(dir, '.arcignore'), '');
  const git = vi.spyOn(workspaces, 'git'),
    mounts = vi.fn(async () => [{ path: dir, object_store_ok: true, claimable: false }]);
  try {
    const projects = new Projects(store, [dir], { mounts } as unknown as ArcBridge);
    const project = await projects.register({ name: 'Work', path: join(dir, 'alice') });
    expect(project).toMatchObject({
      vcs: 'arcadia',
      repoPath: dir,
      scope: 'alice',
      base: 'trunk',
    });
    expect(git).not.toHaveBeenCalled();
    const other = join(dir, 'other');
    mkdirSync(other);
    writeFileSync(join(other, '.arcignore'), '');
    mounts.mockResolvedValue([
      { path: dir, object_store_ok: true, claimable: false },
      { path: other, object_store_ok: true, claimable: false },
    ]);
    expect(await projects.selection(project, { path: other })).toMatchObject({
      repoPath: other,
      scope: '',
      base: 'trunk',
    });
    expect(projects.get(project.id)).toEqual(project);
    expect(git).not.toHaveBeenCalled();
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
it('browses directories only inside configured roots and omits hidden directories and escaping symlinks', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'daddy-project-browser-'))),
    store = new Store(':memory:');
  mkdirSync(join(dir, 'repo'));
  mkdirSync(join(dir, '.tokens'));
  writeFileSync(join(dir, 'not-a-directory'), 'fixture');
  symlinkSync('/etc', join(dir, 'outside'));
  try {
    const projects = new Projects(store, [dir]);
    const result = await projects.browse(dir);
    expect(result.parent).toBeNull();
    expect(result.directories.map((entry) => entry.name)).toEqual(['repo']);
    await expect(projects.browse('/etc')).rejects.toThrow('configured workspace root');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
