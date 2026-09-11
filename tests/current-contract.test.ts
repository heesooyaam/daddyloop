import { it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/core/store.js';
import { configSchema } from '../src/ops/config.js';
import { profilesSchema } from '../src/core/agents.js';

it('accepts only current configuration and profile names', () => {
  expect(configSchema.parse({}).version).toBe(3);
  expect(
    profilesSchema.parse({ worker: { engine: 'codex' }, daddy: { engine: 'codex' } }),
  ).toHaveProperty('worker');
  expect(() =>
    profilesSchema.parse({ author: { engine: 'codex' }, reviewer: { engine: 'codex' } }),
  ).toThrow();
  expect(() => configSchema.parse({ version: 2 })).toThrow();
  expect(() =>
    profilesSchema.parse({ writer: { engine: 'codex' }, daddy: { engine: 'codex' } }),
  ).toThrow();
  expect(() => configSchema.parse({ projects: { roots: ['/server'] } })).toThrow();
});

it('initializes an empty database and rejects earlier schemas before changing user data', () => {
  const dir = mkdtempSync(join(tmpdir(), 'daddy-contract-'));
  try {
    const current = new Store(join(dir, 'current.sqlite'));
    expect(current.db.prepare('PRAGMA user_version').get()?.user_version).toBe(7);
    expect(
      current.db.prepare("SELECT name FROM sqlite_master WHERE name='workspaces'").get(),
    ).toBeDefined();
    current.close();
    for (const version of [0, 6, 8]) {
      const path = join(dir, `schema-${version}.sqlite`);
      const before = new DatabaseSync(path);
      before.exec(
        `CREATE TABLE user_work (body TEXT); INSERT INTO user_work VALUES ('preserve me'); PRAGMA user_version=${version}`,
      );
      before.close();
      expect(() => new Store(path)).toThrow('schema 7');
      const after = new DatabaseSync(path);
      expect(after.prepare('PRAGMA user_version').get()?.user_version).toBe(version);
      expect(after.prepare('SELECT body FROM user_work').get()?.body).toBe('preserve me');
      expect(
        after.prepare("SELECT name FROM sqlite_master WHERE name='tasks'").get(),
      ).toBeUndefined();
      after.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('exposes the current CLI and rejects retired commands and model flags', () => {
  const dir = mkdtempSync(join(tmpdir(), 'daddy-cli-contract-'));
  const config = join(dir, 'config.json');
  writeFileSync(config, JSON.stringify({ version: 3, dataDir: dir }));
  const cli = (args: string[]) =>
    spawnSync(process.execPath, ['--import', 'tsx', resolve('src/cli.ts'), ...args], {
      encoding: 'utf8',
      timeout: 15000,
      env: {
        ...process.env,
        DADDYLOOP_CONFIG: config,
        DADDYLOOP_DATA_DIR: dir,
        DADDYLOOP_LANG: 'en',
      },
    });
  try {
    const help = cli(['--help']);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('workspaces');
    expect(help.stdout).toContain('sessions');
    for (const args of [
      ['projects'],
      ['start', 'ticket'],
      ['child', 'parent', 'ticket'],
      ['attach', 'url'],
      ['chat', 'id', 'text'],
      ['groups'],
      ['new', '--project', 'Work'],
      ['console', '--role', 'reviewer'],
      ['agents', 'defaults', '--author-model', 'old'],
      ['agents', 'defaults', '--writer-model', 'old'],
      ['new', '--writers', '2'],
    ]) {
      const result = cli(args);
      expect(result.status, args.join(' ')).not.toBe(0);
      expect(result.stderr, args.join(' ')).toMatch(/unknown (command|option)|too many arguments/i);
    }
    const profiles = cli(['agents', 'defaults', '--help']);
    expect(profiles.stdout).toContain('--worker-model');
    expect(profiles.stdout).toContain('--daddy-model');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 20000);
