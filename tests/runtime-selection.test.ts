import { afterEach, it, expect, vi } from 'vitest';
import { Command } from 'commander';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/core/store.js';
import { CodexCatalogue } from '../src/modules/agents/codex/models.js';
import { ServiceManager } from '../src/ops/service.js';
import { registerEnvironmentCommands } from '../src/ops/environment.js';
import { loadConfig, saveConfig } from '../src/ops/config.js';
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'daddyloop-runtime-selection-')),
    config = join(dir, 'config.json'),
    store = new Store(join(dir, 'daddyloop.sqlite'));
  store.setSetting('server.instanceId', 'fixture-installation');
  writeFileSync(join(dir, 'access-token'), 'fixture-token', { mode: 0o600 });
  writeFileSync(config, JSON.stringify({ dataDir: dir, serverUrl: 'http://127.0.0.1:4321' }), {
    mode: 0o600,
  });
  vi.stubEnv('DADDYLOOP_CONFIG', config);
  const target = join(dir, 'codex-version'),
    launcher = join(dir, 'codex');
  writeFileSync(target, '#!/bin/sh\n', { mode: 0o700 });
  symlinkSync(target, launcher);
  let busy = false;
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async (url) =>
        new Response(
          JSON.stringify(
            String(url).endsWith('/status')
              ? {
                  instanceId: 'fixture-installation',
                  activeJobs: busy ? 1 : 0,
                  queuedJobs: 0,
                  runtime: { source: 'path' },
                }
              : { tools: [] },
          ),
        ),
    ),
  );
  vi.spyOn(CodexCatalogue.prototype, 'list').mockResolvedValue([]);
  vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  const program = () => {
    const command = new Command();
    registerEnvironmentCommands(command);
    return command;
  };
  return {
    dir,
    config,
    store,
    launcher,
    program,
    setBusy: () => {
      busy = true;
    },
    close: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
it('validates the CLI before selecting its stable launcher and refuses changes while jobs run', async () => {
  const f = setup(),
    restart = vi
      .spyOn(ServiceManager.prototype, 'restart')
      .mockResolvedValue({ installed: true, mode: 'system', survivesLogout: true });
  try {
    await f.program().parseAsync(['node', 'daddy', 'runtime', 'use', f.launcher]);
    expect(loadConfig().executables.codex).toBe(f.launcher);
    expect(restart).toHaveBeenCalledOnce();
    f.setBusy();
    await expect(
      f.program().parseAsync(['node', 'daddy', 'runtime', 'use', f.launcher]),
    ).rejects.toThrow('Wait for running');
    expect(restart).toHaveBeenCalledOnce();
  } finally {
    f.close();
  }
});
it('restores only the CLI setting if restart fails, preserving other concurrent configuration changes', async () => {
  const f = setup();
  vi.spyOn(ServiceManager.prototype, 'restart').mockImplementation(async () => {
    const config = loadConfig();
    config.locale = 'ru';
    saveConfig(config);
    throw new Error('Restart failed');
  });
  try {
    await expect(
      f.program().parseAsync(['node', 'daddy', 'runtime', 'use', f.launcher]),
    ).rejects.toThrow('Restart failed');
    expect(loadConfig().executables.codex).toBeUndefined();
    expect(loadConfig().locale).toBe('ru');
    expect(readFileSync(f.config, 'utf8')).not.toContain('fixture-token');
  } finally {
    f.close();
  }
});
