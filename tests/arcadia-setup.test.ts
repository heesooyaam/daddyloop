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
  configured.arcadia.enabled = true;
  configured.arcadia.leaseHelper = previous;
  saveConfig(configured);
  const doctor = vi.spyOn(ArcBridge.prototype, 'doctor');
  const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const run = () =>
    program().parseAsync([
      'node',
      'daddy',
      '--data-dir',
      directory,
      'arcadia',
      'setup',
      '--lease-helper',
      candidate,
    ]);
  try {
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
      return {
        user_login: 'tester',
        hash: 'a'.repeat(40),
        branch: 'trunk',
      };
    });
    await run();
    expect(loadConfig().arcadia).toMatchObject({ enabled: true, leaseHelper: candidate });
  } finally {
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
