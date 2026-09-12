import { it, expect } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  renameSync,
  lstatSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBackup, restoreBackup, inspectBackup } from '../src/ops/backup/snapshot.js';
import { configSchema } from '../src/ops/config.js';
import { Store } from '../src/core/store.js';
import { fixture } from './helpers.js';
import { Workspaces, git as runGit } from '../src/runtime/workspaces.js';
import { InstructionSources } from '../src/ops/instruction-sources.js';
import {
  sessionInstructionsSchema,
  withInstructions,
  effectiveInstructions,
  type SessionInstructions,
} from '../src/core/instructions.js';
import { InstructionPresets } from '../src/core/instruction-presets.js';
const git = (...args: Parameters<typeof runGit>) =>
  runGit(...args).catch((error) => {
    const info: Record<string, unknown> = {};
    const cwd = args[1];
    if (cwd && existsSync(join(cwd, '.git')) && lstatSync(join(cwd, '.git')).isFile()) {
      const marker = readFileSync(join(cwd, '.git'), 'utf8');
      info.marker = marker;
      const directory = marker.replace(/^gitdir: /, '').trim();
      if (existsSync(directory)) {
        info.entries = readdirSync(directory);
        for (const file of ['HEAD', 'commondir', 'gitdir', 'config.worktree'])
          if (existsSync(join(directory, file)))
            info[file] = readFileSync(join(directory, file), 'utf8');
      }
    }
    throw new Error(
      `Fixture Git ${JSON.stringify(args[0])} in ${args[1]}: ${error.message} Metadata: ${JSON.stringify(info)}`,
      {
        cause: error,
      },
    );
  });
const config = configSchema.parse({
  modules: ['codex', 'github'],
  resources: { minDiskGiB: 0, maxDiskPercent: 99, minMemoryGiB: 0 },
});
it('moves a snapshot to a new path with source commits, staged edits, worker files and review history intact', async () => {
  const root = mkdtempSync(join(tmpdir(), 'daddyloop-backup-test-')),
    data = join(root, 'data'),
    repo = join(root, 'repo'),
    archive = join(root, 'snapshot.tar.gz'),
    target = join(root, 'other-host');
  mkdirSync(repo);
  mkdirSync(data);
  const f = await fixture();
  const store = new Store(join(data, 'daddyloop.sqlite'));
  try {
    await git(['init'], repo);
    writeFileSync(join(repo, 'task.txt'), 'base');
    await git(['add', '.'], repo);
    await git(
      ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@local', 'commit', '-m', 'initial'],
      repo,
    );
    await git(['remote', 'add', 'origin', 'https://github.com/fixture/repo.git'], repo);
    const head = await git(['rev-parse', 'HEAD'], repo);
    const task = {
      ...f.task,
      ref: { ...f.task.ref, provider: 'github', host: 'github.com', repo: 'fixture/repo' },
      repoPath: repo,
      revision: { head, base: head, start: head },
      authorThreadId: 'codex:old-private-context',
    };
    task.pr = { ...task.pr!, ...task.revision };
    const workspaces = new Workspaces(data);
    const worker = await workspaces.prepare(task, 'author');
    await workspaces.prepare(task, 'reviewer');
    writeFileSync(join(worker, 'worker-result.txt'), 'unfinished worker result');
    writeFileSync(join(repo, 'task.txt'), 'staged source change');
    await git(['add', 'task.txt'], repo);
    writeFileSync(join(repo, 'notes.txt'), 'untracked source work');
    store.saveTask(task);
    const skillDirectory = join(root, 'local-skills');
    mkdirSync(skillDirectory);
    writeFileSync(
      join(skillDirectory, 'SKILL.md'),
      `---\nname: portable-style\n---\nKeep explanations short. Original source: ${repo}\n`,
    );
    const skill = await new InstructionSources().import({ kind: 'local', path: skillDirectory });
    const instructions: SessionInstructions = {
      daddy: { prompt: 'Explain decisions in Russian.', skills: [skill] },
      worker: { prompt: 'Check the implementation carefully.' },
    };
    const library = new InstructionPresets(store);
    const preset = library.save({
      name: 'Portable preset',
      instructions: {
        daddy: { prompt: 'Preset daddy prompt', skills: [skill] },
        worker: { prompt: 'Do not include this part' },
      },
    });
    instructions.presets = [{ preset, enabled: true, omit: ['worker:prompt'] }];
    const groupId = '839e11c0-f019-49db-b300-184b9697c6a2';
    store.saveGroup({
      id: groupId,
      rootTaskId: task.id,
      title: 'Portable task instructions',
      requirements: '',
      daddy: { engine: 'codex' },
      generation: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      instructions,
    });
    task.groupId = groupId;
    store.saveTask(task);
    const job = store.enqueue(task, 'author', 'chat', 'Continue after moving');
    library.save(
      {
        name: preset.name,
        instructions: { daddy: { prompt: 'New library version' }, worker: {} },
        expectedRevision: preset.revision,
      },
      preset.id,
    );
    store.setSetting('preferences', { locale: 'ru' });
    store.setSetting('telegram.pairing', { secret: 'must-not-transfer' });
    store.event(task.id, 'review.evidence', { markdown: '**Keep this review**' });
    store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    store.close();
    const saved = await createBackup(data, archive, config, 1);
    rmSync(skillDirectory, { recursive: true });
    expect(saved.sha256).toHaveLength(64);
    expect((await inspectBackup(archive, 1, 0)).files).toBeGreaterThan(4);
    const result = await restoreBackup(archive, target, {}, 1, 0);
    expect(result.paused).toBe(true);
    renameSync(data, join(root, 'offline-data'));
    renameSync(repo, join(root, 'offline-source'));
    const restored = new Store(join(target, 'daddyloop.sqlite'));
    try {
      const next = restored.getTask(task.id);
      const savedInstructions = sessionInstructionsSchema.parse(
        restored.getGroup(groupId).instructions,
      );
      expect(savedInstructions).toEqual(instructions);
      expect(new InstructionPresets(restored).get(preset.id).revision).toBe(2);
      expect(savedInstructions.presets?.[0].preset.revision).toBe(1);
      expect(savedInstructions.presets?.[0].omit).toEqual(['worker:prompt']);
      expect(effectiveInstructions(savedInstructions, 'daddy')?.prompt).toContain(
        'Preset daddy prompt',
      );
      expect(effectiveInstructions(savedInstructions, 'daddy')?.prompt).not.toContain(
        'New library version',
      );
      expect(withInstructions('Workflow policy', savedInstructions.daddy)).toContain(skill.text);
      expect(restored.jobs().find((item) => item.id === job.id)?.instructions).toEqual(
        instructions.worker,
      );
      expect(next.state).toBe('paused');
      expect(next.authorThreadId).toBeUndefined();
      expect(next.repoPath).toContain(target);
      expect(next.repoPath).not.toBe(repo);
      expect(readFileSync(join(next.repoPath, 'task.txt'), 'utf8')).toBe('staged source change');
      expect(readFileSync(join(next.repoPath, 'notes.txt'), 'utf8')).toBe('untracked source work');
      expect(await git(['diff', '--cached', '--name-only'], next.repoPath)).toBe('task.txt');
      expect(await git(['remote', 'get-url', 'origin'], next.repoPath)).toBe(
        'https://github.com/fixture/repo.git',
      );
      expect(
        (
          await new Workspaces(target).describeTicket(next.repoPath, {
            ...next.ref,
            kind: 'ticket',
            key: 'fixture',
          })
        ).repository.baseHead,
      ).toBe(head);
      await expect(
        git(['config', '--get', 'remote.origin.mirror'], next.repoPath),
      ).rejects.toThrow();
      expect(await git(['rev-parse', 'HEAD'], next.authorWorktree!)).toBe(head);
      expect(readFileSync(join(next.authorWorktree!, 'worker-result.txt'), 'utf8')).toBe(
        'unfinished worker result',
      );
      expect(restored.setting('telegram.pairing')).toBeUndefined();
      expect(restored.setting('preferences')).toEqual({ locale: 'ru' });
      expect(
        restored.db
          .prepare('SELECT data FROM events')
          .all()
          .some((row) => String(row.data).includes('Keep this review')),
      ).toBe(true);
    } finally {
      restored.close();
    }
    expect(existsSync(join(target, 'access-token'))).toBe(false);
    await expect(restoreBackup(archive, target, {}, 1, 0)).rejects.toThrow('must not exist');
    expect(readFileSync(join(root, 'offline-source', 'task.txt'), 'utf8')).toBe(
      'staged source change',
    );
  } finally {
    try {
      store.close();
    } catch {}
    f.store.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);
it('refuses a live host, oversized archive and an existing output without touching user data', async () => {
  const root = mkdtempSync(join(tmpdir(), 'daddyloop-backup-lock-')),
    data = join(root, 'data');
  mkdirSync(data);
  try {
    writeFileSync(join(data, 'server.lock'), String(process.pid));
    await expect(createBackup(data, join(root, 'save.tar.gz'), config)).rejects.toThrow(
      'daddy down',
    );
    expect(readFileSync(join(data, 'server.lock'), 'utf8')).toBe(String(process.pid));
    writeFileSync(join(root, 'existing'), 'preserve');
    await expect(createBackup(data, join(root, 'existing'), config)).rejects.toThrow(
      'already exists',
    );
    expect(readFileSync(join(root, 'existing'), 'utf8')).toBe('preserve');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
it('rejects tampered blobs and archive symlinks before exposing a restored directory', async () => {
  const { createHash } = await import('node:crypto'),
    tar = await import('tar'),
    { symlinkSync } = await import('node:fs');
  const root = mkdtempSync(join(tmpdir(), 'daddyloop-backup-tamper-')),
    stage = join(root, 'stage');
  mkdirSync(stage);
  mkdirSync(join(stage, 'blobs'));
  const blob = createHash('sha256').update('good').digest('hex');
  writeFileSync(join(stage, 'blobs', blob), 'evil');
  writeFileSync(
    join(stage, 'manifest.json'),
    JSON.stringify({
      format: 1,
      appVersion: '0.13.0',
      createdAt: new Date().toISOString(),
      sourceDataDir: '/old',
      sourceRealDataDir: '/old',
      directories: [],
      nativeContexts: 'restart-from-saved-work',
      config: {},
      sources: [],
      warnings: [],
      files: [{ path: 'data/daddyloop.sqlite', blob, size: 4, mode: 0o600 }],
    }),
  );
  try {
    const archive = join(root, 'tampered.tar.gz'),
      target = join(root, 'restored');
    await tar.c({ cwd: stage, file: archive, gzip: true }, ['manifest.json', 'blobs']);
    await expect(restoreBackup(archive, target, {}, 1, 0)).rejects.toThrow('checksum mismatch');
    expect(existsSync(target)).toBe(false);
    writeFileSync(join(root, 'outside'), 'untouched');
    symlinkSync('../outside', join(stage, 'evil-link'));
    await tar.c({ cwd: stage, file: join(root, 'links.tar.gz'), gzip: true }, ['evil-link']);
    await expect(restoreBackup(join(root, 'links.tar.gz'), target, {}, 1, 0)).rejects.toThrow(
      'Unsafe',
    );
    expect(readFileSync(join(root, 'outside'), 'utf8')).toBe('untouched');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
