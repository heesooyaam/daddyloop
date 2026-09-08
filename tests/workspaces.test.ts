import { it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { git, Workspaces } from '../src/runtime/workspaces.js';
import { fixture } from './helpers.js';
it('keeps source, author and reviewer checkouts separate and preserves unpushed author work', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'reviewloop-workspace-test-'));
  const f = await fixture();
  try {
    const repo = join(dir, 'source'),
      data = join(dir, 'state');
    mkdirSync(repo);
    mkdirSync(data);
    await git(['init'], repo);
    writeFileSync(join(repo, 'session.ts'), 'const generation = 1;\n');
    await git(['add', '.'], repo);
    await git(
      ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-m', 'Initial'],
      repo,
    );
    const sha = await git(['rev-parse', 'HEAD'], repo);
    const task = f.store.getTask(f.task.id);
    task.repoPath = repo;
    task.revision = { head: sha, base: sha, start: sha };
    task.pr = { ...task.pr!, ...task.revision };
    task.policy.autoPush = false;
    const ws = new Workspaces(data);
    const author = await ws.prepare(task, 'author');
    const reviewer = await ws.prepare(task, 'reviewer');
    expect(author).not.toBe(reviewer);
    expect(await git(['rev-parse', 'HEAD'], reviewer)).toBe(sha);
    writeFileSync(join(author, 'session.ts'), 'const generation = 2;\n');
    const submitted = await ws.submit(task, 'Fix');
    expect(submitted.head).not.toBe(sha);
    expect(submitted.pushed).toBe(false);
    writeFileSync(join(author, 'notes.txt'), 'keep this uncommitted work');
    expect(await ws.prepare(task, 'author')).toBe(author);
    expect(readFileSync(join(author, 'notes.txt'), 'utf8')).toContain('keep this');
    expect(readFileSync(join(repo, 'session.ts'), 'utf8')).toContain('= 1');
    expect(readFileSync(join(reviewer, 'session.ts'), 'utf8')).toContain('= 1');
    expect(await git(['status', '--porcelain'], repo)).toBe('');
  } finally {
    f.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
