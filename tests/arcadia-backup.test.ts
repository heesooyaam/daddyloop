import { it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { backupArcadia } from '../src/modules/repositories/arcadia-backup.js';
import { fixture } from './helpers.js';
it('exports committed and untracked Arc files, deletions and patches only from the task-owned lease', async () => {
  const f = await fixture(),
    mount = mkdtempSync(join(tmpdir(), 'daddyloop-arc-backup-'));
  writeFileSync(join(mount, 'committed.bin'), Buffer.from([0, 1, 2]));
  writeFileSync(join(mount, 'notes.txt'), 'untracked');
  const ownerId = `daddyloop-${f.task.id}-author-owner`,
    base = 'a'.repeat(40),
    head = 'b'.repeat(40);
  const task = {
    ...f.task,
    arcWorkspaces: {
      author: {
        mount,
        ownerId,
        objectStore: '/objects',
        baseHead: base,
        initialHash: base,
        initialBranch: 'trunk',
      },
    },
  };
  const sink = {
    file: vi.fn(async (_path: string, _source: string) => {}),
    text: vi.fn(async (_path: string, _content: string) => {}),
    warning: vi.fn(),
  };
  const arc = {
    mounts: vi.fn(async () => [{ path: mount, lease_owner_id: ownerId, object_store_ok: true }]),
    native: vi.fn(async (args: string[]) =>
      args[0] === 'info'
        ? JSON.stringify({ hash: head, branch: 'task' })
        : args[0] === 'status'
          ? '?? notes.txt\n D removed.txt'
          : args.includes('--name-only')
            ? 'committed.bin\nremoved.txt'
            : 'patch',
    ),
  };
  try {
    await backupArcadia(task, sink, arc as any);
    expect(sink.file.mock.calls.map((call) => call[1])).toEqual([
      join(mount, 'committed.bin'),
      join(mount, 'notes.txt'),
    ]);
    const state = sink.text.mock.calls.find((call) => String(call[0]).endsWith('state.json'));
    expect(JSON.parse(String(state?.[1]))).toMatchObject({
      baseHead: base,
      head,
      deleted: ['removed.txt'],
    });
    expect(sink.warning).toHaveBeenCalledOnce();
    arc.mounts.mockResolvedValue([]);
    arc.native.mockClear();
    await expect(backupArcadia(task, sink, arc as any)).rejects.toThrow('ownership changed');
    expect(arc.native).not.toHaveBeenCalled();
  } finally {
    f.store.close();
    rmSync(mount, { recursive: true, force: true });
  }
});
