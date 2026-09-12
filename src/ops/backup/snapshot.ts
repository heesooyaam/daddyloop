import { VERSION } from '../../version.js';
import { createRepositories } from '../../modules/repositories/index.js';
import { DatabaseSync, backup } from 'node:sqlite';
import { existsSync } from 'node:fs';
import {
  readdir,
  realpath,
  mkdir,
  mkdtemp,
  rm,
  readFile,
  writeFile,
  open,
  lstat,
  chmod,
  copyFile,
  symlink,
  rename,
} from 'node:fs/promises';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { tmpdir, homedir } from 'node:os';
import {
  ArchiveBuilder,
  readArchive,
  safePath,
  diskBudget,
  type BackupManifest,
} from './archive.js';
import { configSchema, type Config } from '../config.js';
import { command } from '../process.js';
import type { Task, Workspace } from '../../core/types.js';

const gib = 1024 ** 3;
const inside = (parent: string, path: string) => {
  const r = relative(parent, path);
  return !isAbsolute(r) && r !== '..' && !r.startsWith('../');
};
async function walk(
  root: string,
  visit: (path: string, rel: string) => Promise<void>,
  rel = '',
  directory?: (path: string) => void,
) {
  for (const item of await readdir(join(root, rel), { withFileTypes: true })) {
    const path = join(rel, item.name);
    if (item.isDirectory()) {
      directory?.(path);
      await walk(root, visit, path, directory);
    } else await visit(join(root, path), path);
  }
}
const git = async (cwd: string, args: string[]) =>
  (
    await command('git', ['-c', 'core.hooksPath=/dev/null', '-C', cwd, ...args], {
      timeoutMs: 300000,
      maxBytes: 32 * 1024 ** 2,
    })
  ).stdout.trimEnd();
const rows = <T>(db: DatabaseSync, table: string): T[] =>
  db
    .prepare(`SELECT data FROM ${table}`)
    .all()
    .map((row) => JSON.parse(String(row.data)));
function portableRemote(value: string) {
  const scp = value.match(/^git@([^:/\s]+):([^\s]+)$/);
  if (scp) return value;
  try {
    const url = new URL(value);
    if (
      !['https:', 'ssh:'].includes(url.protocol) ||
      url.password ||
      url.search ||
      url.hash ||
      (url.username && !(url.protocol === 'ssh:' && url.username === 'git'))
    )
      return undefined;
    return value;
  } catch {
    return undefined;
  }
}
const idFor = (path: string) => createHash('sha256').update(path).digest('hex').slice(0, 20);

/** Use the same exclusive host lock as serve: no worker can start halfway through a snapshot. */
async function lockData(dataDir: string) {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const path = join(dataDir, 'server.lock');
  if (existsSync(path)) {
    const saved = await readFile(path, 'utf8'),
      pid = Number(saved);
    if (Number.isSafeInteger(pid) && pid > 1) {
      try {
        process.kill(pid, 0);
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code === 'ESRCH' &&
          (await readFile(path, 'utf8')) === saved
        )
          await rm(path);
      }
    }
  }
  const handle = await open(path, 'wx', 0o600).catch(() => {
    throw new Error(
      'Stop daddyloop with daddy down before creating a backup; running work must settle first.',
    );
  });
  await handle.writeFile(String(process.pid));
  return async () => {
    await handle.close();
    await rm(path);
  };
}
function portableConfig(config: Config) {
  return {
    version: config.version,
    modules: config.modules,
    agents: config.agents,
    locale: config.locale,
    maxConcurrentAgents: config.maxConcurrentAgents,
    resources: config.resources,
    cache: config.cache,
    memoryMax: config.memoryMax,
    demo: config.demo,
    port: config.port,
    updates: config.updates,
  };
}
function scrubIdentity(db: DatabaseSync) {
  db.exec('PRAGMA secure_delete=ON');
  for (const table of ['devices', 'pairings', 'bot_receipts', 'bot_actions', 'notifications'])
    db.exec(`DELETE FROM ${table}`);
  db.exec(
    "DELETE FROM settings WHERE key NOT IN ('preferences', 'agents.defaults', 'updates.notifications', 'instructions.presets')",
  );
}
export async function createBackup(dataDir: string, output: string, config: Config, maxGiB = 20) {
  dataDir = resolve(dataDir);
  output = resolve(output);
  if (inside(dataDir, output)) throw new Error('Write the backup outside the live data directory');
  if (existsSync(output)) throw new Error('Backup output already exists');
  const credentialPaths = [
    join(homedir(), '.tokens'),
    join(homedir(), '.codex/auth.json'),
    join(homedir(), '.claude/.credentials.json'),
    join(dataDir, 'access-token'),
    config.clientTokenFile,
    config.telegram.tokenFile,
    process.env.DADDYLOOP_CLAUDE_API_KEY_FILE,
  ]
    .filter((path): path is string => !!path)
    .map((path) => resolve(path));
  const isCredential = (path: string) =>
    credentialPaths.some((secret) => path === secret || inside(secret, path));
  const release = await lockData(dataDir);
  const stage = await mkdtemp(join(tmpdir(), 'daddyloop-backup-')).catch(async (error) => {
    await release();
    throw error;
  });
  try {
    await chmod(stage, 0o700);
    const builder = new ArchiveBuilder(stage, dataDir, maxGiB * gib, config.resources.minDiskGiB);
    builder.manifest.config = portableConfig(config);
    builder.manifest.sourceRealDataDir = await realpath(dataDir);
    const original = new DatabaseSync(join(dataDir, 'daddyloop.sqlite'), { readOnly: true });
    const file = join(stage, 'snapshot.sqlite');
    try {
      await backup(original, file);
    } finally {
      original.close();
    }
    const db = new DatabaseSync(file);
    const tasks = rows<Task>(db, 'tasks'),
      workspaces = rows<Workspace>(db, 'workspaces');
    try {
      // Source repositories may be shared by many tasks. Bundle each once.
      const sources = new Map<string, { vcs: 'git' | 'arcadia'; names: string[] }>();
      for (const workspace of workspaces)
        sources.set(workspace.repoPath, {
          vcs: workspace.vcs,
          names: [...(sources.get(workspace.repoPath)?.names ?? []), workspace.name],
        });
      for (const task of tasks)
        if (task.ref.provider !== 'demo' && !sources.has(task.repoPath))
          sources.set(task.repoPath, {
            vcs: task.ref.provider === 'arcadia' ? 'arcadia' : 'git',
            names: [],
          });
      const collect = (value: unknown) => {
        if (Array.isArray(value)) {
          value.forEach(collect);
          return;
        }
        if (!value || typeof value !== 'object') return;
        const object = value as Record<string, any>;
        if (object.ref?.provider === 'demo') return;
        if (typeof object.repoPath === 'string' && !sources.has(object.repoPath))
          sources.set(object.repoPath, {
            vcs: object.vcs === 'arcadia' || object.ref?.provider === 'arcadia' ? 'arcadia' : 'git',
            names: [],
          });
        Object.values(object).forEach(collect);
      };
      for (const table of ['review_groups', 'messages', 'jobs', 'daddy_jobs'])
        rows(db, table).forEach(collect);
      for (const row of db
        .prepare("SELECT value FROM settings WHERE key LIKE 'daddy.context:%'")
        .all())
        collect(JSON.parse(String(row.value)));
      scrubIdentity(db);
      for (const [path, info] of sources) {
        const id = idFor(path);
        const source: BackupManifest['sources'][number] = { id, path, ...info };
        builder.manifest.sources.push(source);
        if (info.vcs === 'arcadia') {
          source.warning = 'Arcadia source must be mounted and mapped on the destination host.';
          continue;
        }
        if (!existsSync(path)) {
          source.warning =
            'Source repository is missing; restore its workspace mapping before resuming.';
          continue;
        }
        source.remotes = [];
        for (const name of (await git(path, ['remote'])).split('\n').filter(Boolean)) {
          const url = await git(path, ['remote', 'get-url', name]);
          if (!/^[A-Za-z0-9_.-]+$/.test(name) || !portableRemote(url))
            throw new Error(
              'Source remote is not portable; use SSH or HTTPS without embedded credentials',
            );
          source.remotes.push({ name, url });
        }
        const head = await git(path, ['rev-parse', 'HEAD']);
        const before = await git(path, ['status', '--porcelain=v1', '-z']);
        const bundle = join(stage, id + '.bundle');
        const counts = await git(path, ['count-objects', '-v']);
        const estimate = counts
          .split('\n')
          .filter((line) => /^(size|size-pack|size-garbage):/.test(line))
          .reduce((sum, line) => sum + Number(line.split(':')[1].trim()) * 1024, 0);
        if (!Number.isFinite(estimate) || estimate > builder.remainingBytes)
          throw new Error('Git objects exceed the remaining backup size budget');
        await diskBudget(stage, estimate * 1.25, config.resources.minDiskGiB);
        const controller = new AbortController();
        let budgetError: unknown;
        const monitor = setInterval(() => {
          void (async () => {
            const size = await lstat(bundle).then(
              (file) => file.size,
              () => 0,
            );
            if (size > builder.remainingBytes)
              throw new Error('Git bundle exceeds the backup size budget');
            await diskBudget(stage, 0, config.resources.minDiskGiB);
          })().catch((error) => {
            budgetError = error;
            controller.abort();
          });
        }, 1000);
        try {
          await command(
            'git',
            [
              '-c',
              'core.hooksPath=/dev/null',
              '-C',
              path,
              'bundle',
              'create',
              bundle,
              '--all',
              'HEAD',
            ],
            { timeoutMs: 300000, signal: controller.signal },
          );
        } catch (error) {
          throw budgetError ?? error;
        } finally {
          clearInterval(monitor);
        }
        source.bundle = `source-bundles/${id}.bundle`;
        source.head = head;
        source.branch =
          (
            await command('git', ['-C', path, 'symbolic-ref', '-q', 'HEAD'], { allowFailure: true })
          ).stdout.trim() || undefined;
        await builder.add(bundle, source.bundle);
        const files = (
          await command(
            'git',
            ['-C', path, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
            { maxBytes: 32 * 1024 ** 2 },
          )
        ).stdout
          .split('\0')
          .filter(Boolean);
        if (files.some((name) => name.includes('\uFFFD')))
          throw new Error('Non-UTF-8 Git paths cannot be captured safely');
        for (const name of new Set(files)) {
          safePath.parse(name);
          const target = join(path, name);
          if (isCredential(target)) continue;
          if (
            existsSync(target) ||
            (await lstat(target).then(
              () => true,
              () => false,
            ))
          )
            await builder.add(target, `source-files/${id}/${name}`);
        }
        const index = resolve(path, await git(path, ['rev-parse', '--git-path', 'index']));
        if (existsSync(index)) await builder.add(index, `source-index/${id}`);
        for (const name of await readdir(dirname(index)))
          if (/^sharedindex\.[a-f0-9]{40,64}$/.test(name))
            await builder.add(join(dirname(index), name), `source-sharedindex/${id}/${name}`);
        if (
          head !== (await git(path, ['rev-parse', 'HEAD'])) ||
          before !== (await git(path, ['status', '--porcelain=v1', '-z']))
        )
          throw new Error(`Source changed during backup: ${path}`);
      }
      const arcTasks = tasks.filter((task) => Object.values(task.arcWorkspaces ?? {}).length);
      const repositories = createRepositories(config.modules);
      for (const task of arcTasks) {
        const capture = repositories.get(task.ref.provider).backupWorkspace;
        if (!capture)
          throw new Error('This repository module cannot export its external task workspace');
        await capture(task, {
          file: (path, file) => builder.add(file, 'recovery/' + safePath.parse(path)),
          text: async (path, content) => {
            const file = join(stage, 'recovery-text');
            await writeFile(file, content, { mode: 0o600 });
            await builder.add(file, 'recovery/' + safePath.parse(path));
          },
          warning: (message) => builder.manifest.warnings.push(message),
        });
      }
      // Managed Git object stores and all their working files are private to daddyloop.
      for (const name of ['workspaces', 'artifacts', 'voice']) {
        const root = join(dataDir, name);
        if (existsSync(root)) {
          builder.addDirectory(`data/${name}`);
          await walk(
            root,
            (path, rel) => builder.add(path, `data/${name}/${rel}`),
            '',
            (rel) => builder.addDirectory(`data/${name}/${rel}`),
          );
        }
      }
      for (const source of builder.manifest.sources)
        if (source.warning)
          builder.manifest.warnings.push(
            `${source.names.join(', ') || source.path}: ${source.warning}`,
          );
      db.exec('VACUUM');
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } finally {
      db.close();
    }
    await builder.add(file, 'data/daddyloop.sqlite');
    return await builder.finish(output);
  } finally {
    await rm(stage, { recursive: true, force: true });
    await release();
  }
}

function remapData(value: unknown, paths: Map<string, string>, key = ''): unknown {
  if (
    typeof value === 'string' &&
    ['repoPath', 'authorWorktree', 'reviewerWorktree', 'cwd', 'source'].includes(key)
  ) {
    for (const [oldPath, newPath] of [...paths].sort((a, b) => b[0].length - a[0].length))
      if (value === oldPath || value.startsWith(oldPath + '/'))
        return newPath + value.slice(oldPath.length);
  }
  if (Array.isArray(value)) return value.map((item) => remapData(item, paths, key));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [name, remapData(item, paths, name)]),
    );
  return value;
}
export async function restoreBackup(
  archive: string,
  target: string,
  mappings: Record<string, string> = {},
  maxGiB = 20,
  reserveGiB = 10,
) {
  target = resolve(target);
  if (existsSync(target))
    throw new Error('Restore destination must not exist; current data is never overwritten');
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const { stage, manifest } = await readArchive(archive, maxGiB * gib, reserveGiB);
  const destination = await mkdtemp(join(dirname(target), '.daddyloop-restore-')).catch(
    async (error) => {
      await rm(stage, { recursive: true, force: true });
      throw error;
    },
  );
  const dataRoots = [...new Set([manifest.sourceDataDir, manifest.sourceRealDataDir])];
  const paths = new Map(dataRoots.map((root) => [root, target]));
  try {
    await chmod(destination, 0o700);
    if (manifest.appVersion !== VERSION)
      throw new Error(
        `Restore this archive with daddyloop ${manifest.appVersion}; this installation is ${VERSION}`,
      );
    await diskBudget(
      destination,
      manifest.files.reduce((sum, file) => sum + file.size, 0),
      reserveGiB,
    );
    for (const source of manifest.sources) {
      const mapping =
        mappings[source.path] ?? source.names.map((name) => mappings[name]).find(Boolean);
      if (mapping) {
        if (!isAbsolute(mapping) || !existsSync(mapping))
          throw new Error(`Workspace mapping must be an existing absolute path: ${mapping}`);
        paths.set(source.path, resolve(mapping));
      } else if (source.bundle) paths.set(source.path, join(target, 'restored-sources', source.id));
    }
    const outputPath = (path: string) => {
      if (path.startsWith('recovery/')) return join(destination, path);
      if (path.startsWith('data/')) return join(destination, path.slice(5));
      if (path.startsWith('source-files/'))
        return join(destination, 'restored-sources', path.slice(13));
      return join(destination, 'recovery', path);
    };
    for (const directory of manifest.directories)
      await mkdir(outputPath(directory), { recursive: true, mode: 0o700 });
    for (const file of manifest.files.filter((file) => file.blob)) {
      const out = outputPath(file.path);
      await mkdir(dirname(out), { recursive: true, mode: 0o700 });
      await copyFile(join(stage, 'blobs', file.blob!), out);
      await chmod(out, file.mode & 0o777);
    }
    for (const source of manifest.sources.filter((source) => source.bundle)) {
      const cwd = join(destination, 'restored-sources', source.id);
      await mkdir(cwd, { recursive: true, mode: 0o700 });
      await git(destination, [
        'clone',
        '--mirror',
        '--',
        join(destination, 'recovery', source.bundle!),
        join(cwd, '.git'),
      ]);
      await git(cwd, ['config', 'core.bare', 'false']);
      await git(cwd, ['config', '--remove-section', 'remote.origin']);
      for (const remote of source.remotes ?? []) {
        if (!portableRemote(remote.url)) throw new Error('Unsafe remote in backup');
        await git(cwd, ['remote', 'add', remote.name, remote.url]);
      }
      if (source.branch) {
        await git(cwd, ['check-ref-format', source.branch]);
        await git(cwd, ['symbolic-ref', 'HEAD', source.branch]);
      } else await git(cwd, ['update-ref', '--no-deref', 'HEAD', source.head!]);
      const index = join(destination, 'recovery/source-index', source.id);
      if (existsSync(index)) await copyFile(index, join(cwd, '.git/index'));
      const shared = join(destination, 'recovery/source-sharedindex', source.id);
      if (existsSync(shared))
        for (const name of await readdir(shared)) {
          if (!/^sharedindex\.[a-f0-9]{40,64}$/.test(name))
            throw new Error('Invalid shared Git index');
          await copyFile(join(shared, name), join(cwd, '.git', name));
        }
    }
    for (const file of manifest.files.filter((file) => file.link != null)) {
      const out = outputPath(file.path);
      await mkdir(dirname(out), { recursive: true, mode: 0o700 });
      // Check again after translating archive namespaces to destination directories.
      if (!inside(destination, resolve(dirname(out), file.link!)))
        throw new Error('Symlink escapes restored data');
      await symlink(file.link!, out);
    }
    const db = new DatabaseSync(join(destination, 'daddyloop.sqlite'));
    try {
      db.exec('PRAGMA trusted_schema=OFF');
      if (db.prepare('PRAGMA user_version').get()?.user_version !== 7)
        throw new Error('Backup database schema does not match this release');
      if (db.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok')
        throw new Error('Backup database integrity check failed');
      scrubIdentity(db);
      db.exec('DELETE FROM telegram_topics');
      for (const table of [
        'tasks',
        'review_groups',
        'workspaces',
        'messages',
        'jobs',
        'daddy_jobs',
        'voice_jobs',
      ]) {
        for (const row of db.prepare(`SELECT id, data FROM ${table}`).all()) {
          const data = remapData(JSON.parse(String(row.data)), paths) as Record<string, unknown>;
          if (table === 'tasks') {
            delete data.authorThreadId;
            delete data.reviewerThreadId;
            if (data.arcWorkspaces) {
              delete data.arcWorkspaces;
              delete data.authorWorktree;
              delete data.reviewerWorktree;
              data.resumeState = 'needs_input';
            }
            if (data.state !== 'complete') {
              if (
                data.state !== 'paused' &&
                data.ref &&
                (data.ref as { provider: string }).provider !== 'arcadia'
              )
                data.resumeState = data.state;
              data.state = 'paused';
            }
            data.generation = Number(data.generation) + 1;
            data.reason =
              'Restored from backup. Check workspace mappings and credentials, then resume; native agent context will be rebuilt from saved work.';
          }
          if (table === 'review_groups') {
            delete data.daddyThreadId;
            delete data.reviewerThreadId;
            delete data.daddyToolSignature;
            if (data.daddyState !== 'archived') data.daddyState = 'paused';
            data.generation = Number(data.generation) + 1;
          }
          if (
            ['jobs', 'daddy_jobs', 'voice_jobs'].includes(table) &&
            ['queued', 'running'].includes(String(data.status))
          ) {
            data.status = 'cancelled';
            data.finishedAt = new Date().toISOString();
            data.error = 'Paused during portable restore';
          }
          if (['jobs', 'daddy_jobs', 'voice_jobs'].includes(table))
            db.prepare(`UPDATE ${table} SET status=?,data=? WHERE id=?`).run(
              String(data.status),
              JSON.stringify(data),
              row.id!,
            );
          else
            db.prepare(`UPDATE ${table} SET data=? WHERE id=?`).run(JSON.stringify(data), row.id!);
        }
      }
      db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(
        'backup.restored',
        JSON.stringify({
          at: new Date().toISOString(),
          from: manifest.createdAt,
          warnings: manifest.warnings,
        }),
      );
      db.exec('VACUUM');
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } finally {
      db.close();
    }
    // Git's linked-worktree records contain absolute paths. Rewrite only these ownership records.
    const workspaces = join(destination, 'workspaces');
    if (existsSync(workspaces))
      await walk(workspaces, async (file, rel) => {
        if (
          /(^|\/)\.git$/.test(rel) ||
          /objects\.git\/worktrees\/[^/]+\/(?:gitdir|commondir|config.worktree)$/.test(rel) ||
          /(^|\/)owner\.json$/.test(rel)
        ) {
          let body = await readFile(file, 'utf8');
          body = /(^|\/)owner\.json$/.test(rel)
            ? JSON.stringify(remapData(JSON.parse(body), paths))
            : dataRoots.reduce((text, old) => text.split(old + '/').join(target + '/'), body);
          await writeFile(file, body, { mode: 0o600 });
        }
      });
    const config = configSchema.parse({
      ...manifest.config,
      dataDir: target,
      serverUrl: `http://127.0.0.1:${manifest.config.port ?? 4317}`,
      telegram: { enabled: false },
      executables: {},
      arcadia: { enabled: false },
    });
    await writeFile(join(destination, 'restored-config.json'), JSON.stringify(config, null, 2), {
      mode: 0o600,
    });
    await mkdir(join(destination, 'recovery'), { recursive: true });
    await writeFile(
      join(destination, 'recovery/manifest.json'),
      JSON.stringify(manifest, null, 2),
      { mode: 0o600 },
    );
    await writeFile(
      join(destination, 'recovery/README.txt'),
      'Restored tasks are paused. Native agent sessions start fresh with saved task context. Authenticate providers, map missing workspaces, reconnect Telegram, then resume. Original source bundles and uncommitted files are retained here and in restored-sources.\n',
      { mode: 0o600 },
    );
    // Reserve the target name exclusively before publishing the complete restore.
    await mkdir(target, { mode: 0o700 });
    await rename(destination, target);
    return {
      dataDir: target,
      config: join(target, 'restored-config.json'),
      warnings: manifest.warnings,
      workspaceMappings: Object.fromEntries(paths),
      paused: true,
      nativeContexts: manifest.nativeContexts,
    };
  } finally {
    await rm(stage, { recursive: true, force: true });
    await rm(destination, { recursive: true, force: true });
  }
}
export async function inspectBackup(archive: string, maxGiB = 20, reserveGiB = 10) {
  const { stage, manifest } = await readArchive(archive, maxGiB * gib, reserveGiB);
  try {
    return {
      ...manifest,
      files: manifest.files.length,
      bytes: manifest.files.reduce((sum, file) => sum + file.size, 0),
    };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
