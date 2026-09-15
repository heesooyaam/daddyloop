import { afterEach, expect, it, vi } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WorkspaceRegistry } from '../src/core/workspace-registry.js';
import { Workspaces, git } from '../src/runtime/workspaces.js';
import { SessionWorkspaces } from '../src/runtime/session-workspaces.js';
import { allRepositories } from '../src/modules/repositories/index.js';
import { parseGitSource } from '../src/modules/repositories/git-source.js';
import { githubModule } from '../src/modules/repositories/github.js';
import { gitlabModule } from '../src/modules/repositories/gitlab.js';
import { Store } from '../src/core/store.js';
import { fixture } from './helpers.js';
import type { ReviewGroup, Task } from '../src/core/types.js';
import { createBackup, restoreBackup } from '../src/ops/backup/snapshot.js';
import { configSchema } from '../src/ops/config.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
it('registers HTTPS/SSH and nested GitLab sources without a local clone, and keeps per-session overrides separate', async () => {
  const store = new Store(':memory:');
  try {
    const registry = new WorkspaceRegistry(store, []);
    const github = await registry.register({ name: 'App', path: 'git@github.com:team/app.git' });
    expect(github).toMatchObject({
      repoPath: 'ssh://git@github.com/team/app.git',
      provider: 'github',
      copyMode: 'session',
    });
    const selected = await registry.selection(github, {
      path: 'https://gitlab.com/team/sub/app',
      scope: 'src',
      base: 'release',
    });
    expect(selected).toMatchObject({
      provider: 'gitlab',
      repo: 'team/sub/app',
      scope: 'src',
      base: 'release',
    });
    expect(registry.get(github.id)).toEqual(github);
    expect(
      (await registry.register({ name: 'Again', path: 'ssh://git@github.com/team/app' })).id,
    ).toBe(github.id);
    const company = await registry.register({
      name: 'Company',
      path: 'ssh://git@code.example.test:2222/team/sub/app.git',
      provider: 'gitlab',
    });
    expect((await registry.selection(company, { base: 'release' })).provider).toBe('gitlab');
    await expect(registry.selection(github, { copyMode: 'pool' })).rejects.toThrow(
      'only for Arcadia',
    );
    for (const value of [
      'file:///tmp/repo',
      'ext::sh -c bad',
      'https://token@github.com/a/b',
      'https://github.com/a/../b',
      'https://github.com/a/%2e%2e/b',
      'https://github.com/a/b?token=x',
      'ssh://git:secret@github.com/a/b',
    ])
      expect(() => parseGitSource(value)).toThrow();
    expect(() => githubModule.git!.parse('https://github.com/team/sub/app')).toThrow();
    expect(gitlabModule.git!.parse('https://gitlab.com/team/sub/app').repo).toBe('team/sub/app');
    await expect(
      registry.register({ name: 'Unknown', path: 'https://code.example.test/team/app' }),
    ).rejects.toThrow('explicitly');
    expect(
      (
        await registry.selection(
          { ...github, copyMode: 'pool' },
          { path: 'https://gitlab.com/other/app' },
        )
      ).copyMode,
    ).toBe('session');
  } finally {
    store.close();
  }
});

it('uses the hosting module token username without putting secrets in a repository URL', async () => {
  vi.stubEnv('GITHUB_TOKEN', 'fixture-github-token');
  vi.stubEnv('GITLAB_TOKEN', 'fixture-gitlab-token');
  for (const [module, address, username, token] of [
    [githubModule, 'https://github.com/team/app', 'x-access-token', 'fixture-github-token'],
    [gitlabModule, 'https://gitlab.com/team/app', 'oauth2', 'fixture-gitlab-token'],
  ] as const) {
    const source = module.git!.parse(address),
      env = module.git!.environment(source);
    expect(source.url).not.toContain(token);
    expect(env.GIT_CONFIG_PARAMETERS).toContain(
      Buffer.from(`${username}:${token}`).toString('base64'),
    );
    expect(
      module.git!.environment(module.git!.parse('git@example.test:team/app')),
    ).not.toHaveProperty('GIT_CONFIG_PARAMETERS');
  }
});

async function remoteFixture(provider: 'github' | 'gitlab', ssh = false) {
  const root = mkdtempSync(join(tmpdir(), 'daddy-git-source-')),
    repo = join(root, 'remote'),
    data = join(root, 'data');
  mkdirSync(repo);
  mkdirSync(data);
  await git(['init'], repo);
  await git(['symbolic-ref', 'HEAD', 'refs/heads/develop'], repo);
  mkdirSync(join(repo, 'src'));
  writeFileSync(join(repo, 'src/base.txt'), 'remote base');
  await git(['add', '.'], repo);
  await git(
    ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-m', 'Base'],
    repo,
  );
  const url = `${ssh ? 'ssh://git@' : 'https://'}${provider}.example.test/team/${provider === 'gitlab' ? 'sub/' : ''}app.git`;
  const config = join(root, 'git-config');
  writeFileSync(config, `[url "${repo}"]\n\tinsteadOf = ${url}\n`);
  vi.stubEnv('GIT_CONFIG_PARAMETERS', "'url." + repo + '.insteadOf=' + url + "'");
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
  const f = await fixture();
  const store = new Store(join(data, 'daddyloop.sqlite'));
  const registry = new WorkspaceRegistry(store, []);
  const workspace = await registry.register({ name: 'Remote', path: url, provider });
  const checkouts = new Workspaces(data);
  const group: ReviewGroup = {
    id: randomUUID(),
    title: 'Remote work',
    requirements: '',
    rootTaskId: '',
    workspaceId: workspace.id,
    workspace,
    daddy: { engine: 'codex' },
    generation: 1,
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
  };
  store.saveGroup(group);
  const lifecycle = new SessionWorkspaces(allRepositories(), {
    dataDir: data,
    store,
    registry,
    checkouts,
  });
  const task = async () => {
    const ref = {
      kind: 'ticket' as const,
      provider,
      host: workspace.host,
      repo: workspace.repo,
      number: 0,
      key: 'local',
      url,
    };
    const description = await checkouts.describeTicket(url, ref);
    const task: Task = {
      ...f.task,
      id: randomUUID(),
      groupId: group.id,
      ref,
      repoPath: url,
      pr: undefined,
      ticketRepository: { ...description.repository, branch: `daddyloop/task-${randomUUID()}` },
      revision: {
        head: description.repository.baseHead,
        base: description.repository.baseHead,
        start: description.repository.baseHead,
      },
    };
    store.saveTask(task);
    return task;
  };
  return {
    root,
    repo,
    data,
    store,
    registry,
    workspace,
    checkouts,
    group,
    lifecycle,
    task,
    url,
    close() {
      store.close();
      f.store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

it.each(['github', 'gitlab'] as const)(
  'clones %s task copies independently, pins the default branch, preserves edits and archives before deleting',
  async (provider) => {
    const f = await remoteFixture(provider, provider === 'github');
    try {
      expect(f.lifecycle.supports(f.group)).toBe(true);
      const context = await f.lifecycle.prepare(f.group, new AbortController().signal);
      const a = await f.task(),
        b = await f.task();
      const [first, second] = await Promise.all([
        f.checkouts.prepareTicket(a, 'author'),
        f.checkouts.prepareTicket(b, 'author'),
      ]);
      f.store.saveTask(a);
      f.store.saveTask(b);
      expect(a.ticketRepository!.baseBranch).toBe('develop');
      expect(first).not.toBe(second);
      expect(first).not.toBe(context!.path);
      writeFileSync(join(first, 'src/base.txt'), 'worker A');
      const head = await f.checkouts.commitTicket(a, 'Local commit');
      a.pendingAuthorHead = head;
      await f.checkouts.pushTicket(a);
      expect(await git(['rev-parse', `refs/heads/${a.ticketRepository!.branch}`], f.repo)).toBe(
        head,
      );
      writeFileSync(join(first, 'draft.txt'), 'untracked work');
      expect(await f.checkouts.prepareTicket(a, 'author')).toBe(first);
      f.store.saveTask(a);
      expect(readFileSync(join(second, 'src/base.txt'), 'utf8')).toBe('remote base');
      expect(readFileSync(join(f.repo, 'src/base.txt'), 'utf8')).toBe('remote base');
      expect(a.ticketRepository!.cloneUrl).toBe(f.url);
      const removed = await f.lifecycle.remove(f.group);
      expect(existsSync(first)).toBe(false);
      expect(existsSync(second)).toBe(false);
      expect(existsSync(context!.path)).toBe(false);
      expect(existsSync(f.repo)).toBe(true);
      expect(
        readFileSync(join(removed.archivePath!, 'copies', a.id, 'author/draft.txt'), 'utf8'),
      ).toBe('untracked work');
      const bare = join(removed.archivePath!, 'copies', a.id, 'objects.git');
      expect(await git(['--git-dir', bare, 'show', `${head}:src/base.txt`], f.root)).toBe(
        'worker A',
      );
      expect(await f.lifecycle.remove(f.group)).toEqual(removed);
    } finally {
      f.close();
    }
  },
);

it('preserves Git copies when an archive fails, and refuses changed ownership', async () => {
  const f = await remoteFixture('github');
  try {
    const task = await f.task(),
      copy = await f.checkouts.prepareTicket(task, 'author');
    f.store.saveTask(task);
    symlinkSync('/etc/passwd', join(copy, 'external'));
    await expect(f.lifecycle.remove(f.group)).rejects.toThrow('outside its archive');
    expect(existsSync(copy)).toBe(true);
    rmSync(join(copy, 'external'));
    const owner = join(f.data, 'workspaces', task.id, 'owner.json');
    const record = JSON.parse(readFileSync(owner, 'utf8'));
    writeFileSync(owner, JSON.stringify({ ...record, groupId: randomUUID() }));
    await expect(f.checkouts.prepareTicket(task, 'author')).rejects.toThrow('ownership');
    await expect(f.lifecycle.remove(f.group)).rejects.toThrow('ownership');
    expect(existsSync(copy)).toBe(true);
  } finally {
    f.close();
  }
});

it('backs up a URL workspace with unfinished Git work and restores it without a source-folder mapping', async () => {
  const f = await remoteFixture('gitlab');
  try {
    const task = await f.task(),
      copy = await f.checkouts.prepareTicket(task, 'author');
    writeFileSync(join(copy, 'draft.txt'), 'portable result');
    f.store.saveTask(task);
    const config = configSchema.parse({
      modules: ['codex', 'gitlab'],
      resources: { minDiskGiB: 0, maxDiskPercent: 99, minMemoryGiB: 0 },
    });
    const archive = join(f.root, 'snapshot.tar.gz'),
      target = join(f.root, 'restored');
    await createBackup(f.data, archive, config);
    await restoreBackup(archive, target, {}, 20, 0);
    const restored = new Store(join(target, 'daddyloop.sqlite'));
    try {
      expect(restored.workspace(f.workspace.id).repoPath).toBe(f.url);
      const saved = restored.getTask(task.id);
      expect(readFileSync(join(saved.authorWorktree!, 'draft.txt'), 'utf8')).toBe(
        'portable result',
      );
      expect(await new Workspaces(target).prepareTicket(saved, 'author')).toBe(
        saved.authorWorktree,
      );
    } finally {
      restored.close();
    }
  } finally {
    f.close();
  }
});

it('checks archived bytes before removing Git copies and keeps other sessions intact', async () => {
  const f = await remoteFixture('github');
  try {
    const task = await f.task(),
      copy = await f.checkouts.prepareTicket(task, 'author');
    f.store.saveTask(task);
    const other = { ...(await f.task()), groupId: randomUUID() };
    const otherCopy = await f.checkouts.prepareTicket(other, 'author');
    f.store.saveTask(other);
    let archiveFile = '';
    const original = f.store.setSetting.bind(f.store);
    const record = vi.spyOn(f.store, 'setSetting').mockImplementation((key, value) => {
      original(key, value);
      if (key.startsWith('session.archive:') && value) {
        archiveFile = join(
          (value as { path: string }).path,
          'copies',
          task.id,
          'author/src/base.txt',
        );
        writeFileSync(archiveFile, 'corrupted archive');
      }
    });
    await expect(f.lifecycle.remove(f.group)).rejects.toThrow('archive file changed');
    expect(existsSync(copy)).toBe(true);
    expect(existsSync(otherCopy)).toBe(true);
    record.mockRestore();
    writeFileSync(archiveFile, 'remote base');
    await f.lifecycle.remove(f.group);
    expect(existsSync(copy)).toBe(false);
    expect(existsSync(otherCopy)).toBe(true);
  } finally {
    f.close();
  }
});
