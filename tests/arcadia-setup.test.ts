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
  const journals = vi
    .spyOn(ArcBridge.prototype, 'withValidatedJournals')
    .mockImplementation(async (fn) => fn());
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

    const relative = loadConfig();
    relative.dataDir = 'relative-state';
    saveConfig(relative);
    await expect(
      program().parseAsync(['node', 'daddy', 'arcadia', 'setup', '--lease-helper', candidate]),
    ).rejects.toMatchObject({ code: 'service_data_dir_unknown' });
    expect(doctor).not.toHaveBeenCalled();
    expect(loadConfig().arcadia).toMatchObject({ enabled: true, leaseHelper: previous });
    saveConfig(configured);

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
        source: '/source-arcadia',
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
        source: '/source-arcadia',
      };
    });
    await run();
    expect(loadConfig().arcadia).toMatchObject({ enabled: true, leaseHelper: candidate });
    expect(loadConfig().cache.auto).toBe(true);
  } finally {
    if (originalDataDir === undefined) delete process.env.DADDYLOOP_DATA_DIR;
    else process.env.DADDYLOOP_DATA_DIR = originalDataDir;
    output.mockRestore();
    journals.mockRestore();
    doctor.mockRestore();
    saveConfig(original);
    rmSync(directory, { recursive: true, force: true });
  }
});

it('uses an uncommitted helper candidate for the setup probe', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'daddyloop-arcadia-helper-'));
  const candidate = join(directory, 'candidate-helper');
  const status = JSON.stringify({
    status: 'success',
    data: { mounts: [{ path: '/new-pool', claimable: true, object_store_ok: true }] },
  });
  const config = JSON.stringify({
    status: 'success',
    data: {
      object_store: join(directory, 'shared'),
      lease_root: join(directory, 'leases'),
      store_root: join(directory, 'stores'),
      mount_prefix: join(directory, 'arcadia'),
      mount_start: 1,
      mount_end: 2,
      extra_mounts: '',
      human_reserved_mount_numbers: '1',
    },
  });
  writeFileSync(
    candidate,
    `#!/usr/bin/env bash
if [[ " $* " == *" config "* ]]; then
  printf '%s\n' '${config}'
else
  printf '%s\n' '${status}'
fi
`,
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

it('validates helper config before the first session journal exists', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'daddyloop-arcadia-config-'));
  const status = JSON.stringify({ status: 'success', data: { mounts: [] } });
  const candidate = join(directory, 'candidate-helper');
  try {
    writeFileSync(
      candidate,
      `#!/usr/bin/env bash
if [[ " $* " == *" config "* ]]; then
  exit 7
else
  printf '%s\n' '${status}'
fi
`,
      { mode: 0o600 },
    );
    await expect(new ArcBridge(directory, candidate).mounts()).rejects.toMatchObject({
      code: 'command_failed',
    });

    const invalidConfig = JSON.stringify({
      status: 'success',
      data: {
        object_store: 'relative-object-store',
        lease_root: join(directory, 'leases'),
        store_root: join(directory, 'stores'),
        mount_prefix: join(directory, 'arcadia'),
        mount_start: 1,
        mount_end: 2,
        extra_mounts: '',
        human_reserved_mount_numbers: '1',
      },
    });
    writeFileSync(
      candidate,
      `#!/usr/bin/env bash
if [[ " $* " == *" config "* ]]; then
  printf '%s\n' '${invalidConfig}'
else
  printf '%s\n' '${status}'
fi
`,
      { mode: 0o600 },
    );
    await expect(new ArcBridge(directory, candidate).mounts()).rejects.toThrow('must live outside');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
