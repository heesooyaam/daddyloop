import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rename, rm, open } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { SessionWorkspaceBackend, SessionWorkspaceContext } from '../contracts.js';
import type { ReviewGroup } from '../../core/types.js';
import { DaddyWorkspace } from '../../runtime/daddy-workspace.js';
import { ArcBridge } from '../../integrations/arcadia.js';
import { ManagedArcMounts, type ManagedArcRecord } from '../../integrations/arc-managed.js';
import { SessionArchive, verifySessionArchive } from '../../runtime/session-archive.js';
import { backupArcadia } from './arcadia-backup.js';
import { loadConfig } from '../../ops/config.js';

type Receipt = { path: string; digest: string; fingerprints: Record<string, string> };
export class ArcadiaSessionWorkspace implements SessionWorkspaceBackend {
  private arc: ArcBridge;
  private mounts: ManagedArcMounts;
  constructor(
    private context: SessionWorkspaceContext,
    arc?: ArcBridge,
    mounts?: ManagedArcMounts,
  ) {
    this.arc = arc ?? new ArcBridge(context.dataDir);
    this.mounts = mounts ?? new ManagedArcMounts(context.dataDir);
  }
  async prepare(group: ReviewGroup, signal: AbortSignal) {
    const prepared = await new DaddyWorkspace(
      this.context.registry,
      this.context.checkouts,
    ).prepare(group, signal);
    return { path: prepared.context.reviewerWorktree ?? prepared.cwd };
  }
  private async fingerprint(record: ManagedArcRecord) {
    const info = await this.arc.native(['info', '--json'], record.mount);
    const status = await this.arc.native(['status', '--short', '-u', 'all'], record.mount);
    return createHash('sha256').update(info).update('\0').update(status).digest('hex');
  }
  async remove(group: ReviewGroup) {
    const { store, dataDir } = this.context;
    const key = `session.archive:${group.id}:${group.generation}`;
    if (
      store
        .tasks()
        .filter((task) => task.groupId === group.id)
        .some((task) => Object.values(task.arcWorkspaces ?? {}).some((lease) => !lease?.managed))
    )
      throw new Error(
        'Release the borrowed Arc pool copies before deleting this session. They were preserved.',
      );
    if (!this.mounts.records(group.id).length && !store.setting(key)) return {};
    let receipt = store.setting<Receipt>(key);
    if (!receipt) {
      const parent = join(dataDir, 'session-archives', group.id);
      await mkdir(parent, { recursive: true, mode: 0o700 });
      const destination = join(parent, `g${group.generation}`);
      if (existsSync(destination)) {
        // A crash may occur after the directory rename but before the SQLite receipt.
        const verified = await verifySessionArchive(destination, group.id);
        receipt = {
          path: destination,
          digest: verified.digest,
          fingerprints: verified.manifest.fingerprints,
        };
      } else {
        const stage = await mkdtemp(join(parent, `.${group.id}-`));
        try {
          const archive = new SessionArchive(stage, loadConfig().resources.minDiskGiB);
          const tasks = store.tasks().filter((task) => task.groupId === group.id);
          const ids = [group.id, ...tasks.map((task) => task.id)];
          await archive.text(
            'session.json',
            JSON.stringify(
              {
                session: group,
                tasks,
                messages: ids.flatMap((id) => store.messages(id)),
                jobs: tasks.flatMap((task) => store.jobs(task.id)),
                daddyJobs: store.daddyJobs(group.id),
                decisions: tasks.flatMap((task) => store.decisions(task.id)),
              },
              null,
              2,
            ),
          );
          const fingerprints: Record<string, string> = {};
          for (const record of this.mounts.records(group.id)) {
            const allocation = await this.mounts.ensure(
              record.sessionId,
              record.taskId,
              record.role,
            );
            let checkpoint = allocation.checkpoint;
            if (!checkpoint) {
              const info = JSON.parse(await this.arc.native(['info', '--json'], record.mount));
              checkpoint = {
                initialHash: info.hash,
                initialBranch: info.branch,
                baseHead: info.hash,
              };
              this.mounts.checkpoint(allocation.lease, checkpoint);
            }
            const before = await this.fingerprint(record);
            await backupArcadia(
              {
                id: record.taskId,
                arcWorkspaces: {
                  [record.role]: { ...allocation.lease, ...checkpoint },
                },
              },
              archive,
              this.arc,
            );
            if (before !== (await this.fingerprint(record)))
              throw new Error('The session copy changed during export; deletion was stopped');
            fingerprints[record.ownerId] = before;
          }
          await archive.text(
            'ownership.json',
            JSON.stringify(
              {
                format: 1,
                sessionId: group.id,
                fingerprints,
                files: archive.files,
                warnings: archive.warnings,
              },
              null,
              2,
            ),
          );
          await archive.sync();
          await rename(stage, destination);
          const directory = await open(parent, 'r');
          try {
            await directory.sync();
          } finally {
            await directory.close();
          }
          const verified = await verifySessionArchive(destination, group.id);
          receipt = { path: destination, digest: verified.digest, fingerprints };
        } catch (error) {
          await rm(stage, { recursive: true, force: true });
          throw error;
        }
      }
      store.setSetting(key, receipt);
    }
    if (!existsSync(join(receipt.path, 'ownership.json')))
      throw new Error('The saved session archive is missing; working copies were preserved');
    if (receipt.path !== join(dataDir, 'session-archives', group.id, `g${group.generation}`))
      throw new Error('The session archive path changed; working copies were preserved');
    await verifySessionArchive(receipt.path, group.id, receipt.digest);
    for (const record of this.mounts.records(group.id)) {
      if (!(record.ownerId in receipt.fingerprints))
        throw new Error('A session copy was created after export; deletion was stopped');
      const native = (await this.mounts.nativeMounts()).find(
        (mount) => mount.mount === record.mount,
      );
      if (record.state !== 'removing') {
        await this.mounts.ensure(record.sessionId, record.taskId, record.role);
        if ((await this.fingerprint(record)) !== receipt.fingerprints[record.ownerId])
          throw new Error('The session changed after export; its copy was preserved');
      } else if (
        native?.status === 'mounted' &&
        (await this.fingerprint(record)) !== receipt.fingerprints[record.ownerId]
      ) {
        throw new Error('The session changed during removal; its copy was preserved');
      }
      await this.mounts.remove(record);
      const journal = join(dataDir, 'arc-leases', `${record.taskId}-${record.role}.json`);
      await rm(journal, { force: true });
    }
    return { archivePath: receipt.path };
  }
}
