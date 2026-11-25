import { Command } from 'commander';
import { expect, it, vi } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
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

it.each(['non-executable Bash script', 'executable Node script'])(
  'validates the inventory and journals with a %s',
  async (helperType) => {
    const directory = mkdtempSync(join(tmpdir(), 'daddyloop-arcadia-helper-'));
    const candidate = join(directory, 'candidate helper');
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
    try {
      const executable = helperType === 'executable Node script';
      const script = executable
        ? `#!/usr/bin/env node
if (process.argv[2] !== '--json') process.exit(7);
if (process.argv[3] === 'config') console.log(${JSON.stringify(config)});
else if (process.argv[3] === 'status') console.log(${JSON.stringify(status)});
else process.exit(7);
`
        : `#!/usr/bin/env bash
if [[ "$1" != --json ]]; then
  exit 7
elif [[ "$2" == config ]]; then
  printf '%s\n' '${config}'
elif [[ "$2" == status ]]; then
  printf '%s\n' '${status}'
else
  exit 7
fi
`;
      writeFileSync(candidate, script, { mode: executable ? 0o700 : 0o600 });
      const bridge = new ArcBridge(directory, candidate);
      await expect(bridge.mounts()).resolves.toMatchObject([{ path: '/new-pool' }]);
      await expect(bridge.withValidatedJournals(async () => undefined)).resolves.toBeUndefined();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

it('resolves a symlink before traversing the parent of a lease helper path', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'daddyloop-arcadia-helper-'));
  try {
    const target = join(directory, 'target');
    mkdirSync(join(target, 'bin'), { recursive: true });
    symlinkSync(join(target, 'bin'), join(directory, 'current'));
    writeFileSync(join(directory, 'helper'), '#!/bin/sh\nexit 7\n', { mode: 0o700 });
    const response = JSON.stringify({
      status: 'success',
      data: { mounts: [{ path: '/target-pool' }] },
    });
    writeFileSync(
      join(target, 'helper'),
      `#!/usr/bin/env node\nconsole.log(${JSON.stringify(response)});\n`,
      {
        mode: 0o700,
      },
    );
    const bridge = new ArcBridge(directory, `${directory}/current/../helper`);
    await expect(bridge.mounts()).resolves.toMatchObject([{ path: '/target-pool' }]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it('skips directories in PATH when looking for a named lease helper', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'daddyloop-arcadia-helper-'));
  try {
    const name = 'fixture-arcadia-mount-lease';
    const first = join(directory, 'first');
    const second = join(directory, 'second');
    mkdirSync(join(first, name), { recursive: true });
    mkdirSync(second);
    const response = JSON.stringify({
      status: 'success',
      data: { mounts: [{ path: '/path-pool' }] },
    });
    const script = join(directory, 'helper');
    writeFileSync(script, `#!/usr/bin/env node\nconsole.log(${JSON.stringify(response)});\n`, {
      mode: 0o700,
    });
    symlinkSync(script, join(second, name));
    vi.stubEnv('PATH', [first, second, process.env.PATH].join(delimiter));
    await expect(new ArcBridge(directory, name).mounts()).resolves.toMatchObject([
      { path: '/path-pool' },
    ]);
  } finally {
    vi.unstubAllEnvs();
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
    const missingConfig = new ArcBridge(directory, candidate);
    chmodSync(directory, 0o500);
    await expect(missingConfig.mounts()).resolves.toEqual([]);
    expect(existsSync(join(directory, 'arcadia-session-leases.env'))).toBe(false);
    chmodSync(directory, 0o700);
    await expect(missingConfig.withValidatedJournals(async () => undefined)).rejects.toMatchObject({
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
    await expect(
      new ArcBridge(directory, candidate).withValidatedJournals(async () => undefined),
    ).rejects.toThrow('must live outside');
  } finally {
    chmodSync(directory, 0o700);
    rmSync(directory, { recursive: true, force: true });
  }
});

it('rejects data directories with whitespace or symlink aliases before setup validation', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'daddyloop-arcadia-root-'));
  const spaced = join(directory, 'data with spaces');
  const target = join(directory, 'target');
  const alias = join(directory, 'alias');
  mkdirSync(spaced);
  mkdirSync(target);
  symlinkSync(target, alias);
  try {
    await expect(
      new ArcBridge(spaced, '/unused-helper').withValidatedJournals(async () => undefined),
    ).rejects.toThrow('without whitespace');
    await expect(
      new ArcBridge(alias, '/unused-helper').withValidatedJournals(async () => undefined),
    ).rejects.toThrow('without symlink aliases');
    expect(existsSync(join(spaced, 'arcadia-session-journals.lock'))).toBe(false);
    expect(existsSync(join(target, 'arcadia-session-journals.lock'))).toBe(false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
