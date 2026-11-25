import { Command } from 'commander';
import { expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerOperations } from '../src/ops/commands.js';
import { loadConfig, saveConfig } from '../src/ops/config.js';
import { ArcBridge } from '../src/integrations/arcadia.js';

function program() {
  const value = new Command().option('--data-dir <path>').option('--url <url>');
  registerOperations(value);
  return value;
}

it('keeps the active Arc helper until setup finishes successfully', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'daddyloop-arcadia-setup-'));
  const original = loadConfig();
  const previous = join(directory, 'old-helper');
  const candidate = join(directory, 'new-helper');
  const configured = structuredClone(original);
  configured.modules = [...new Set([...configured.modules, 'arcadia'])];
  configured.dataDir = directory;
  configured.cache.auto = false;
  configured.arcadia.enabled = true;
  configured.arcadia.leaseHelper = previous;
  saveConfig(configured);
  const doctor = vi.spyOn(ArcBridge.prototype, 'doctor');
  const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const originalDataDir = process.env.DADDYLOOP_DATA_DIR;
  const run = (dataDir = directory) =>
    program().parseAsync([
      'node',
      'daddy',
      '--data-dir',
      dataDir,
      'arcadia',
      'setup',
      '--lease-helper',
      candidate,
    ]);
  try {
    await expect(run(join(directory, 'empty-data-dir'))).rejects.toMatchObject({
      code: 'service_data_dir_mismatch',
    });
    expect(doctor).not.toHaveBeenCalled();
    expect(loadConfig().arcadia).toMatchObject({ enabled: true, leaseHelper: previous });

    process.env.DADDYLOOP_DATA_DIR = join(directory, 'environment-data-dir');
    await expect(
      program().parseAsync(['node', 'daddy', 'arcadia', 'setup', '--lease-helper', candidate]),
    ).rejects.toMatchObject({ code: 'service_data_dir_mismatch' });
    expect(doctor).not.toHaveBeenCalled();
    expect(loadConfig().arcadia).toMatchObject({ enabled: true, leaseHelper: previous });
    if (originalDataDir === undefined) delete process.env.DADDYLOOP_DATA_DIR;
    else process.env.DADDYLOOP_DATA_DIR = originalDataDir;

    for (const message of ['Arcanum is temporarily unavailable', 'lease helper failed']) {
      doctor.mockImplementationOnce(async function (this: ArcBridge) {
        expect(Reflect.get(this, 'leaseHelperPath')).toBe(candidate);
        throw new Error(message);
      });
      await expect(run()).rejects.toThrow(message);
      expect(loadConfig().arcadia).toMatchObject({
        enabled: true,
        leaseHelper: previous,
      });
    }

    doctor.mockImplementationOnce(async function (this: ArcBridge) {
      expect(Reflect.get(this, 'leaseHelperPath')).toBe(candidate);
      const changed = loadConfig();
      changed.arcadia.arcanumCli = 'another-arcanum-cli';
      saveConfig(changed);
      return {
        user_login: 'tester',
        hash: 'a'.repeat(40),
        branch: 'trunk',
      };
    });
    await expect(run()).rejects.toMatchObject({ code: 'arcadia_setup_changed' });
    expect(loadConfig().arcadia).toMatchObject({
      arcanumCli: 'another-arcanum-cli',
      enabled: true,
      leaseHelper: previous,
    });

    const reset = loadConfig();
    reset.arcadia.arcanumCli = configured.arcadia.arcanumCli;
    saveConfig(reset);
    doctor.mockImplementationOnce(async function (this: ArcBridge) {
      expect(Reflect.get(this, 'leaseHelperPath')).toBe(candidate);
      const concurrent = loadConfig();
      concurrent.cache.auto = true;
      saveConfig(concurrent);
      return {
        user_login: 'tester',
        hash: 'a'.repeat(40),
        branch: 'trunk',
      };
    });
    await run();
    expect(loadConfig().arcadia).toMatchObject({ enabled: true, leaseHelper: candidate });
    expect(loadConfig().cache.auto).toBe(true);
  } finally {
    if (originalDataDir === undefined) delete process.env.DADDYLOOP_DATA_DIR;
    else process.env.DADDYLOOP_DATA_DIR = originalDataDir;
    output.mockRestore();
    doctor.mockRestore();
    saveConfig(original);
    rmSync(directory, { recursive: true, force: true });
  }
});

it('uses an uncommitted helper candidate for the setup probe', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'daddyloop-arcadia-helper-'));
  const candidate = join(directory, 'candidate-helper');
  writeFileSync(
    candidate,
    '#!/usr/bin/env bash\nprintf \'%s\\n\' \'{"status":"success","data":{"mounts":[{"path":"/new-pool","claimable":true,"object_store_ok":true}]}}\'\n',
    { mode: 0o600 },
  );
  try {
    await expect(new ArcBridge(directory, candidate).mounts()).resolves.toMatchObject([
      { path: '/new-pool' },
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
