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
import { WorkspaceRegistry, workspaceScope } from '../src/core/workspace-registry.js';
import type { ArcBridge } from '../src/integrations/arcadia.js';
import * as workspaces from '../src/runtime/workspaces.js';
afterEach(() => vi.restoreAllMocks());
it('registers a named Git workspace with a relative working directory without changing the source checkout', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'daddy-workspace-'))),
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
    const workspaces = new WorkspaceRegistry(store, [dir], {
      mounts: async () => [],
    } as unknown as ArcBridge);
    const workspace = await workspaces.register({ name: 'My app', path: join(repo, 'src') });
    const selected = await workspaces.selection(workspace, { path: repo, base: 'release' });
    expect(selected).toMatchObject({ repoPath: repo, scope: '', base: 'release' });
    expect(selected.id).not.toBe(workspace.id);
    expect((await workspaces.selection(workspace, { path: repo, base: 'release' })).id).toBe(
      selected.id,
    );
    expect(workspaces.get(workspace.id)).toEqual(workspace);
    expect(workspaces.list()).toHaveLength(1);
    expect(workspace).toMatchObject({
      repoPath: repo,
      scope: 'src',
      provider: 'github',
      repo: 'test/repo',
    });
    expect((await workspaces.register({ name: 'Renamed app', path: join(repo, 'src') })).id).toBe(
      workspace.id,
    );
    run(['remote', 'set-url', 'origin', 'https://github.com/test/repo.git']);
    expect((await workspaces.register({ name: 'HTTPS app', path: join(repo, 'src') })).id).toBe(
      workspace.id,
    );
    expect(run(['rev-parse', 'HEAD'])).toBe(before);
    expect(readFileSync(join(repo, 'src/file.txt'), 'utf8')).toBe('user changes');
    symlinkSync(dir, join(repo, 'escape'));
    await expect(
      workspaces.register({ name: 'Escape', path: repo, scope: 'escape' }),
    ).rejects.toThrow('outside');
    expect(() => workspaceScope('../outside')).toThrow('relative');
    const saved = workspaces.get(workspace.id),
      groupId = randomUUID();
    store.saveGroup({
      id: groupId,
      rootTaskId: '',
      title: 'Existing session',
      requirements: '',
      workspaceId: saved.id,
      workspace: saved,
      orchestrated: true,
      daddy: { engine: 'codex' },
      generation: 1,
      createdAt: saved.createdAt,
      updatedAt: saved.updatedAt,
    });
    await workspaces.register({ name: saved.name, path: repo, base: 'release' }, saved.id);
    expect(store.getGroup(groupId).workspace).toEqual(saved);
    expect(workspaces.get(saved.id)).toMatchObject({ repoPath: repo, scope: '', base: 'release' });
    execFileSync('git', ['remote', 'set-url', 'origin', 'https://code.example.test/team/app.git'], {
      cwd: repo,
    });
    const selfHosted = await workspaces.register(
      { name: saved.name, path: repo, provider: 'gitlab' },
      saved.id,
    );
    expect(selfHosted.provider).toBe('gitlab');
    expect((await workspaces.selection(selfHosted, { scope: 'src' })).provider).toBe('gitlab');
    expect(
      (await workspaces.register({ name: saved.name, path: repo, base: 'release' }, saved.id))
        .provider,
    ).toBe('gitlab');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
it('detects Arcadia before Git and uses the configured shared-store mounts', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'daddy-workspace-arc-'))),
    store = new Store(':memory:');
  mkdirSync(join(dir, 'alice'));
  writeFileSync(join(dir, '.arcignore'), '');
  const git = vi.spyOn(workspaces, 'git'),
    mounts = vi.fn(async () => [{ path: dir, object_store_ok: true, claimable: false }]);
  try {
    const workspaces = new WorkspaceRegistry(store, [dir], { mounts } as unknown as ArcBridge);
    const workspace = await workspaces.register({ name: 'Work', path: join(dir, 'alice') });
    expect(workspace).toMatchObject({
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
    expect(await workspaces.selection(workspace, { path: other })).toMatchObject({
      repoPath: other,
      scope: '',
      base: 'trunk',
    });
    expect(workspaces.get(workspace.id)).toEqual(workspace);
    expect(git).not.toHaveBeenCalled();
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
it('browses directories only inside configured roots and omits hidden directories and escaping symlinks', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'daddy-workspace-browser-'))),
    store = new Store(':memory:');
  mkdirSync(join(dir, 'repo'));
  mkdirSync(join(dir, '.tokens'));
  writeFileSync(join(dir, 'not-a-directory'), 'fixture');
  symlinkSync('/etc', join(dir, 'outside'));
  try {
    const workspaces = new WorkspaceRegistry(store, [dir]);
    const result = await workspaces.browse(dir);
    expect(result.parent).toBeNull();
    expect(result.directories.map((entry) => entry.name)).toEqual(['repo']);
    await expect(workspaces.browse('/etc')).rejects.toThrow('configured workspace root');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
