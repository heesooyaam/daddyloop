import { isGitAddress } from './git-source.js';
import { existsSync, createReadStream, realpathSync } from 'node:fs';
import {
  readdir,
  lstat,
  readFile,
  readlink,
  realpath,
  mkdir,
  mkdtemp,
  rename,
  rm,
  open,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import type { ReviewGroup, Task } from '../../core/types.js';
import type { SessionWorkspaceBackend, SessionWorkspaceContext } from '../contracts.js';
import { DaddyWorkspace } from '../../runtime/daddy-workspace.js';
import { SessionArchive, verifySessionArchive } from '../../runtime/session-archive.js';
import { loadConfig } from '../../ops/config.js';

type Copy = { id: string; path: string };
type Receipt = { path: string; digest: string; fingerprints: Record<string, string> };

/** Preserve the complete Git database, index, ignored files and unpushed commits before removal. */
export class GitSessionWorkspace implements SessionWorkspaceBackend {
  constructor(
    private context: SessionWorkspaceContext,
    private provider: string,
  ) {
    this.context = { ...context, dataDir: realpathSync(context.dataDir) };
  }
  async prepare(group: ReviewGroup, signal: AbortSignal) {
    const result = await new DaddyWorkspace(this.context.registry, this.context.checkouts).prepare(
      group,
      signal,
    );
    return { path: result.context.reviewerWorktree ?? result.cwd };
  }
  private async copies(group: ReviewGroup): Promise<Copy[]> {
    const { store, dataDir } = this.context;
    const contexts = store.db
      .prepare("SELECT value FROM settings WHERE key LIKE 'daddy.context:%'")
      .all()
      .map((row) => JSON.parse(String(row.value)))
      .filter((item): item is Task => !!item?.id);
    const tasks = [...store.tasks(), ...contexts].filter(
      (task) => task.groupId === group.id && task.ref.provider === this.provider,
    );
    const expected = new Map(tasks.map((task) => [task.id, task]));
    const parent = join(dataDir, 'workspaces');
    if (!existsSync(parent)) return [];
    if ((await realpath(parent)) !== resolve(parent))
      throw new Error('The Git workspace directory was redirected; copies were preserved');
    const sources = [
      ...store.workspaces(),
      ...store.groups().flatMap((group) => (group.workspace ? [group.workspace] : [])),
      ...store.daddyJobs().flatMap((job) => (job.workspace ? [job.workspace] : [])),
      ...store.tasks(),
      ...contexts,
    ]
      .map((value) => value.repoPath)
      .filter((value): value is string => !!value && !isGitAddress(value))
      .map((path) => (existsSync(path) ? realpathSync(path) : resolve(path)));
    const result: Copy[] = [];
    for (const entry of await readdir(parent, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        if (expected.has(entry.name))
          throw new Error('Git copy ownership changed; all copies were preserved');
        continue;
      }
      const path = join(parent, entry.name);
      let owner: {
        application?: string;
        taskId?: string;
        groupId?: string;
        provider?: string;
        source?: string;
      };
      try {
        if ((await lstat(join(path, 'owner.json'))).isSymbolicLink())
          throw new Error('The ownership record was redirected');
        owner = JSON.parse(await readFile(join(path, 'owner.json'), 'utf8'));
      } catch (error) {
        if (expected.has(entry.name))
          throw new Error('A task copy has no valid ownership record; it was preserved');
        continue;
      }
      if (
        !expected.has(entry.name) &&
        !(owner.groupId === group.id && owner.provider === this.provider)
      )
        continue;
      if (
        !entry.isDirectory() ||
        entry.isSymbolicLink() ||
        (await realpath(path)) !== resolve(path) ||
        owner.application !== 'daddyloop' ||
        owner.taskId !== entry.name ||
        (owner.groupId && owner.groupId !== group.id) ||
        (owner.provider && owner.provider !== this.provider) ||
        (expected.has(entry.name) && owner.source !== expected.get(entry.name)!.repoPath) ||
        (await lstat(join(path, 'owner.json'))).isSymbolicLink()
      )
        throw new Error('Git copy ownership changed; all copies were preserved');
      if (sources.some((source) => source === path || source.startsWith(path + '/')))
        throw new Error('A session copy is registered as a repository source; it was preserved');
      result.push({ id: entry.name, path });
    }
    return result;
  }
  private async fingerprint(copy: Copy, archive?: SessionArchive) {
    const hash = createHash('sha256');
    const walk = async (relative = '') => {
      for (const name of (await readdir(join(copy.path, relative))).sort()) {
        const rel = relative ? `${relative}/${name}` : name;
        const file = join(copy.path, rel),
          stat = await lstat(file);
        hash.update(JSON.stringify([rel, stat.mode]));
        if (stat.isDirectory()) await walk(rel);
        else if (stat.isSymbolicLink()) {
          hash.update(await readlink(file));
          if (archive) await archive.file(`copies/${copy.id}/${rel}`, file);
        } else if (stat.isFile()) {
          for await (const chunk of createReadStream(file)) hash.update(chunk);
          if (archive) await archive.file(`copies/${copy.id}/${rel}`, file);
        } else throw new Error('A Git copy contains a special file; it was preserved');
      }
    };
    await walk();
    return hash.digest('hex');
  }
  async remove(group: ReviewGroup) {
    const { dataDir, store } = this.context;
    const key = `session.archive:${group.id}:${group.generation}:${this.provider}`;
    let receipt = store.setting<Receipt>(key);
    let copies = await this.copies(group);
    if (!copies.length && !receipt) return {};
    const parent = join(dataDir, 'session-archives', group.id, `git-${this.provider}`);
    const destination = join(parent, `g${group.generation}`);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    if (!receipt) {
      if (!existsSync(destination)) {
        const stage = await mkdtemp(join(parent, '.git-'));
        try {
          const archive = new SessionArchive(stage, loadConfig().resources.minDiskGiB);
          const tasks = store.tasks().filter((task) => task.groupId === group.id);
          await archive.text(
            'session.json',
            JSON.stringify(
              {
                session: group,
                tasks,
                messages: [group.id, ...tasks.map((task) => task.id)].flatMap((id) =>
                  store.messages(id),
                ),
                jobs: tasks.flatMap((task) => store.jobs(task.id)),
                daddyJobs: store.daddyJobs(group.id),
                decisions: tasks.flatMap((task) => store.decisions(task.id)),
              },
              null,
              2,
            ),
          );
          const fingerprints: Record<string, string> = {};
          for (const copy of copies) {
            const before = await this.fingerprint(copy);
            if (
              before !== (await this.fingerprint(copy, archive)) ||
              before !== (await this.fingerprint(copy))
            )
              throw new Error('A Git copy changed during export; it was preserved');
            fingerprints[copy.id] = before;
          }
          await archive.text(
            'ownership.json',
            JSON.stringify({ format: 1, sessionId: group.id, fingerprints, files: archive.files }),
          );
          await archive.sync();
          await rename(stage, destination);
          const dir = await open(parent, 'r');
          try {
            await dir.sync();
          } finally {
            await dir.close();
          }
        } catch (error) {
          await rm(stage, { recursive: true, force: true });
          throw error;
        }
      }
      const verified = await verifySessionArchive(destination, group.id);
      receipt = {
        path: destination,
        digest: verified.digest,
        fingerprints: verified.manifest.fingerprints,
      };
      store.setSetting(key, receipt);
    }
    if (receipt.path !== destination)
      throw new Error('The Git archive path changed; copies were preserved');
    await verifySessionArchive(destination, group.id, receipt.digest);
    copies = await this.copies(group);
    // Check every copy before deleting the first, including newly created or altered copies.
    for (const copy of copies)
      if (receipt.fingerprints[copy.id] !== (await this.fingerprint(copy)))
        throw new Error('A Git copy changed after export; copies were preserved');
    for (const copy of copies) {
      if (receipt.fingerprints[copy.id] !== (await this.fingerprint(copy)))
        throw new Error('A Git copy changed during removal; it was preserved');
      await rm(copy.path, { recursive: true });
    }
    return { archivePath: destination };
  }
}
