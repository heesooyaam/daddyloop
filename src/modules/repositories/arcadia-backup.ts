import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Task } from '../../core/types.js';
import type { WorkspaceBackupSink } from '../contracts.js';
import { ArcBridge } from '../../integrations/arcadia.js';
/** Export task-owned changes; never copy a virtual monorepo or transfer a live lease. */
export async function backupArcadia(task: Task, sink: WorkspaceBackupSink, arc = new ArcBridge()) {
  for (const [role, lease] of Object.entries(task.arcWorkspaces ?? {})) {
    const owner = (await arc.mounts()).find(
      (mount) =>
        mount.path === lease.mount &&
        mount.lease_owner_id === lease.ownerId &&
        mount.object_store_ok,
    );
    if (!owner || !lease.ownerId.startsWith(`daddyloop-${task.id}-${role}-`))
      throw new Error('Cannot back up an Arc workspace whose lease ownership changed');
    const prefix = `arcadia/${task.id}/${role}`;
    const before = await arc.native(['info', '--json'], lease.mount);
    const status = await arc.native(['status', '--short', '-u', 'all'], lease.mount);
    const info = JSON.parse(before) as { hash: string; branch: string };
    if (!/^[a-f0-9]{40}$/.test(info.hash) || !/^[a-f0-9]{40}$/.test(lease.baseHead))
      throw new Error('Arc backup requires full commit hashes');
    const committed = await arc.native(
      ['diff', '--name-only', lease.baseHead, info.hash],
      lease.mount,
    );
    const files = [
      ...new Set([
        ...committed.split('\n').filter(Boolean),
        ...status
          .split('\n')
          .filter(Boolean)
          .map((line) => line.slice(3)),
      ]),
    ];
    if (
      files.some(
        (path) =>
          !path ||
          path.startsWith('/') ||
          path.startsWith('"') ||
          path.includes(' -> ') ||
          path.includes('\\') ||
          path.split('/').includes('..'),
      )
    )
      throw new Error(
        'Arc status contains ambiguous paths. Resolve or commit the rename before creating a portable backup.',
      );
    await sink.text(
      `${prefix}/state.json`,
      JSON.stringify(
        {
          baseHead: lease.baseHead,
          head: info.hash,
          branch: info.branch,
          status,
          files,
          deleted: files.filter((path) => !existsSync(join(lease.mount, path))),
        },
        null,
        2,
      ),
    );
    await sink.text(
      `${prefix}/committed.patch`,
      await arc.native(['diff', '--git', '--binary', lease.baseHead, info.hash], lease.mount),
    );
    await sink.text(
      `${prefix}/index.patch`,
      await arc.native(['diff', '--git', '--binary', '--cached'], lease.mount),
    );
    await sink.text(
      `${prefix}/working.patch`,
      await arc.native(['diff', '--git', '--binary'], lease.mount),
    );
    for (const path of files)
      if (existsSync(join(lease.mount, path)))
        await sink.file(`${prefix}/files/${path}`, join(lease.mount, path));
    if (
      before !== (await arc.native(['info', '--json'], lease.mount)) ||
      status !== (await arc.native(['status', '--short', '-u', 'all'], lease.mount))
    )
      throw new Error('Arc workspace changed during backup; retry when idle');
    sink.warning(
      `Arcadia task ${task.id}: patches and changed files were saved under recovery/${prefix}; apply them to a newly leased mount before resuming.`,
    );
  }
}
