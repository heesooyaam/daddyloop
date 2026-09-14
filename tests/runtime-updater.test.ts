import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/core/store.js';
import { RuntimeUpdater } from '../src/core/runtime-updater.js';
import type { AgentPackage } from '../src/modules/contracts.js';
afterEach(() => vi.restoreAllMocks());
function updaterFixture(store = new Store(':memory:')) {
  const dir = mkdtempSync(join(tmpdir(), 'daddyloop-updater-test-'));
  let executable = '/previous/atlas';
  const artifact: AgentPackage = {
    version: '2.0.0',
    platform: `linux-${process.arch}`,
    url: 'https://registry.npmjs.org/@fixture/atlas/-/atlas-2.0.0-linux-x64.tgz',
    integrity: 'fixture',
  };
  const options = {
    engine: 'atlas',
    dataDir: dir,
    executable: () => executable,
    activate: vi.fn((expected: string, next: string) => {
      if (expected !== executable) throw new Error('configuration changed');
      executable = next;
    }),
    resourceCheck: vi.fn(),
    cli: {
      name: 'Atlas',
      executable: () => executable,
      releaseUrl: 'https://example.test/releases',
      latestVersion: async () => '2.0.0',
      updates: {
        latest: vi.fn(async () => artifact),
        install: vi.fn(async () => '/managed/atlas'),
      },
      probe: vi.fn(async (path: string) => ({
        executable: path,
        version: path === '/previous/atlas' ? '1.0.0' : '2.0.0',
      })),
      validate: vi.fn(async (path: string) => ({
        version: path === '/previous/atlas' ? '1.0.0' : '2.0.0',
        models: [
          {
            id: 'test-model',
            engine: 'atlas',
            name: 'Test',
            efforts: ['max'],
            defaultEffort: 'max',
            isDefault: true,
          },
        ],
      })),
    },
  };
  const updater = new RuntimeUpdater(store, options);
  return {
    store,
    options,
    updater,
    setExecutable: (path: string) => {
      executable = path;
    },
    async close() {
      await updater.stop();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
async function finished(updater: RuntimeUpdater) {
  await vi.waitFor(() => expect(updater.status().busy).toBe(false));
  return updater.status().operation;
}
it('pins one-use confirmations to the caller and CLI, installs in the background, and rolls back without restarting agents', async () => {
  const f = updaterFixture();
  try {
    const plan = await f.updater.prepare('install', 'telegram:7:7');
    expect(f.options.cli.updates.install).not.toHaveBeenCalled();
    expect(() => f.updater.confirm(plan.id, 'api')).toThrow('expired');
    const operation = f.updater.confirm(plan.id, 'telegram:7:7');
    expect(operation.phase).toBe('installing');
    expect(f.updater.status().busy).toBe(true);
    expect(() => f.updater.confirm(plan.id, 'telegram:7:7')).toThrow('in progress');
    expect((await finished(f.updater))?.phase).toBe('complete');
    expect(f.options.executable()).toBe('/managed/atlas');
    expect(f.options.cli.validate).toHaveBeenCalledOnce();
    expect(f.updater.status().rollback).toBe('1.0.0');
    expect(() => f.updater.confirm(plan.id, 'telegram:7:7')).toThrow('already used');
    const rollback = await f.updater.prepare('rollback', 'api');
    f.updater.confirm(rollback.id, 'api');
    expect((await finished(f.updater))?.phase).toBe('complete');
    expect(f.options.executable()).toBe('/previous/atlas');
    expect(f.options.cli.updates.install).toHaveBeenCalledOnce();
    expect(f.updater.status().rollback).toBe('2.0.0');
  } finally {
    await f.close();
  }
});
it.each(['download', 'version', 'protocol', 'configuration', 'resources'])(
  'preserves the selection after %s failure and permits a fresh retry',
  async (failure) => {
    const f = updaterFixture();
    try {
      const plan = await f.updater.prepare('install', 'api');
      if (failure === 'download')
        f.options.cli.updates.install.mockRejectedValue(new Error('download failed'));
      if (failure === 'version')
        f.options.cli.probe.mockImplementation(async (path) => ({
          executable: path,
          version: '9.9.9',
        }));
      if (failure === 'protocol')
        f.options.cli.validate.mockRejectedValue(new Error('bad protocol'));
      if (failure === 'configuration')
        f.options.activate.mockImplementation(() => {
          throw new Error('configuration changed');
        });
      if (failure === 'resources')
        f.options.resourceCheck.mockImplementation(() => {
          throw new Error('low disk');
        });
      f.updater.confirm(plan.id, 'api');
      expect((await finished(f.updater))?.phase).toBe('failed');
      expect(f.options.executable()).toBe('/previous/atlas');
      expect(f.updater.status().rollback).toBeUndefined();
      expect(() => f.updater.confirm(plan.id, 'api')).toThrow('already used');
      f.options.cli.probe.mockImplementation(async (path) => ({
        executable: path,
        version: '1.0.0',
      }));
      expect((await f.updater.prepare('install', 'api')).id).not.toBe(plan.id);
    } finally {
      await f.close();
    }
  },
);
it('refuses expired plans, up-to-date installations, changed launchers and incompatible saved models', async () => {
  const f = updaterFixture();
  try {
    const first = await f.updater.prepare('install', 'api');
    f.store.setSetting('runtime.atlas.update.plan', {
      ...first,
      audience: 'api',
      expiresAt: '2000-01-01T00:00:00.000Z',
    });
    expect(() => f.updater.confirm(first.id, 'api')).toThrow('expired');
    const second = await f.updater.prepare('install', 'api');
    f.setExecutable('/changed/atlas');
    expect(() => f.updater.confirm(second.id, 'api')).toThrow('expired');
    await expect(f.updater.prepare('install', 'api')).rejects.toThrow('up to date');
    f.setExecutable('/previous/atlas');
    const updater = new RuntimeUpdater(f.store, {
      ...f.options,
      validateModels: () => {
        throw new Error('saved model unavailable');
      },
    });
    const plan = await updater.prepare('install', 'api');
    updater.confirm(plan.id, 'api');
    expect((await finished(updater))?.error).toContain('saved model unavailable');
    expect(f.options.activate).not.toHaveBeenCalled();
    await updater.stop();
  } finally {
    await f.close();
  }
});
it('reconciles a crash around the atomic configuration rename without repeating installation', async () => {
  const f = updaterFixture();
  try {
    const plan = await f.updater.prepare('install', 'api');
    f.store.setSetting('runtime.atlas.update.operation', {
      id: 'fixture',
      phase: 'activating',
      action: 'install',
      from: plan.from,
      target: { executable: '/managed/atlas', version: '2.0.0' },
      startedAt: new Date().toISOString(),
    });
    f.setExecutable('/managed/atlas');
    await f.updater.recover();
    expect(f.updater.status()).toMatchObject({
      rollback: '1.0.0',
      operation: { phase: 'complete' },
    });
    expect(f.options.cli.updates.install).not.toHaveBeenCalled();
    f.store.setSetting('runtime.atlas.update.operation', {
      ...f.updater.status().operation,
      phase: 'validating',
    });
    f.setExecutable('/previous/atlas');
    await f.updater.recover();
    expect(f.updater.status().operation?.phase).toBe('failed');
    expect(f.options.executable()).toBe('/previous/atlas');
  } finally {
    await f.close();
  }
});
it('cancels a download on shutdown and keeps a failed operation for recovery and notification', async () => {
  const f = updaterFixture();
  const updater = new RuntimeUpdater(f.store, {
    ...f.options,
    cli: {
      ...f.options.cli,
      updates: {
        ...f.options.cli.updates,
        install: async (_pkg, _root, signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
          }),
      },
    },
  });
  try {
    const plan = await updater.prepare('install', 'api');
    updater.confirm(plan.id, 'api');
    await updater.stop();
    expect(updater.status().operation?.phase).toBe('failed');
    expect(f.options.activate).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});
it('never removes a candidate selected by a concurrent host configuration edit during crash recovery', async () => {
  const f = updaterFixture();
  try {
    const directory = join(f.options.dataDir, 'runtimes/atlas/test-operation');
    mkdirSync(directory, { recursive: true });
    const executable = join(directory, 'atlas');
    writeFileSync(executable, '#!/bin/sh\n', { mode: 0o700 });
    f.setExecutable(executable);
    f.store.setSetting('runtime.atlas.update.operation', {
      id: 'test-operation',
      phase: 'validating',
      action: 'install',
      from: { executable: '/previous/atlas', version: '1.0.0' },
      target: { executable, version: '2.0.0' },
      startedAt: new Date().toISOString(),
    });
    await f.updater.recover();
    expect(f.updater.status().operation?.phase).toBe('failed');
    expect(existsSync(executable)).toBe(true);
  } finally {
    await f.close();
  }
});
