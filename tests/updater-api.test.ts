import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/server/app.js';
import { loadConfig, saveConfig } from '../src/ops/config.js';
import { CodexCatalogue } from '../src/modules/agents/codex/models.js';
import * as packages from '../src/modules/agents/codex/package.js';
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
it('authenticates update controls, activates atomically without changing the server PID, and persists across restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'daddyloop-updater-api-test-'));
  vi.stubEnv('DADDYLOOP_CONFIG', join(dir, 'config.json'));
  const previous = join(dir, 'old-codex'),
    next = join(dir, 'new-codex');
  writeFileSync(previous, '#!/bin/sh\necho codex-cli 1.0.0\n', { mode: 0o700 });
  writeFileSync(next, '#!/bin/sh\necho codex-cli 2.0.0\n', { mode: 0o700 });
  saveConfig({ ...loadConfig(), dataDir: dir, executables: { codex: previous } });
  vi.spyOn(packages, 'latestCodexPackage').mockResolvedValue({
    version: '2.0.0',
    platform: `linux-${process.arch}`,
    url: 'fixture',
    integrity: 'fixture',
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const install = vi.spyOn(packages, 'installCodexPackage').mockImplementation(async () => {
    await gate;
    // An unrelated configuration update while the download is pending must survive.
    const config = loadConfig();
    config.locale = 'ru';
    saveConfig(config);
    return next;
  });
  vi.spyOn(CodexCatalogue.prototype, 'list').mockResolvedValue([
    {
      id: 'fixture',
      engine: 'codex',
      name: 'Test',
      efforts: ['max'],
      defaultEffort: 'max',
      isDefault: true,
    },
  ]);
  vi.spyOn(CodexCatalogue.prototype, 'metadata').mockReturnValue({
    source: 'codex-app-server:model/list',
    executable: next,
    cliVersion: '2.0.0',
  });
  const options = {
    dataDir: dir,
    token: 'fixture-token',
    startWorker: false,
    resourceCheck: () => ({
      ok: true,
      reasons: [],
      diskAvailableGiB: 200,
      diskUsedPercent: 20,
      memoryAvailableGiB: 10,
      memoryTotalGiB: 20,
    }),
  };
  let server = await buildApp(options);
  const headers = { authorization: 'Bearer fixture-token' };
  try {
    const health = (await server.app.inject('/api/health')).json();
    expect(
      (
        await server.app.inject({
          method: 'POST',
          url: '/api/runtimes/codex/update/prepare',
          payload: { action: 'install' },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await server.app.inject({
          method: 'POST',
          url: '/api/runtimes/codex/update/prepare',
          headers,
          payload: { action: 'install', url: 'https://attacker.example/run' },
        })
      ).statusCode,
    ).toBe(400);
    const plan = (
      await server.app.inject({
        method: 'POST',
        url: '/api/runtimes/codex/update/prepare',
        headers,
        payload: { action: 'install' },
      })
    ).json();
    expect(plan.target.version).toBe('2.0.0');
    expect(install).not.toHaveBeenCalled();
    expect(
      (
        await server.app.inject({
          method: 'POST',
          url: '/api/runtimes/codex/update/confirm',
          headers,
          payload: { id: plan.id },
        })
      ).statusCode,
    ).toBe(202);
    expect(
      (await server.app.inject({ url: '/api/runtimes/codex/update', headers })).json().busy,
    ).toBe(true);
    release();
    await vi.waitFor(async () =>
      expect(
        (await server.app.inject({ url: '/api/runtimes/codex/update', headers })).json().operation
          .phase,
      ).toBe('complete'),
    );
    expect(loadConfig().executables.codex).toBe(next);
    expect(loadConfig().locale).toBe('ru');
    expect(
      (await server.app.inject({ url: '/api/status', headers }))
        .json()
        .runtimes.find((item: { engine: string }) => item.engine === 'codex').executable,
    ).toBe(next);
    expect((await server.app.inject('/api/health')).json().pid).toBe(health.pid);
    expect(
      (
        await server.app.inject({
          method: 'POST',
          url: '/api/runtimes/codex/update/confirm',
          headers,
          payload: { id: plan.id },
        })
      ).statusCode,
    ).toBe(409);
    await server.app.close();
    server = await buildApp(options);
    expect(
      (await server.app.inject({ url: '/api/runtimes/codex/update', headers })).json().rollback,
    ).toBe('1.0.0');
    expect(
      (await server.app.inject({ url: '/api/status', headers }))
        .json()
        .runtimes.find((item: { engine: string }) => item.engine === 'codex').executable,
    ).toBe(next);
    expect(install).toHaveBeenCalledOnce();
  } finally {
    release();
    await server.app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it('preserves the selected CLI when the candidate drops a model frozen in the queue', async () => {
  const { fixture } = await import('./helpers.js');
  const f = await fixture();
  const dir = mkdtempSync(join(tmpdir(), 'daddyloop-updater-queued-profile-'));
  vi.stubEnv('DADDYLOOP_CONFIG', join(dir, 'config.json'));
  const previous = join(dir, 'old'),
    next = join(dir, 'next');
  writeFileSync(previous, '#!/bin/sh\necho 1.0.0\n', { mode: 0o700 });
  writeFileSync(next, '#!/bin/sh\necho 2.0.0\n', { mode: 0o700 });
  saveConfig({ ...loadConfig(), dataDir: dir, executables: { codex: previous } });
  f.task.agents = {
    daddy: { engine: 'codex' },
    worker: { engine: 'codex', model: 'queued-model' },
  };
  const job = f.store.enqueue(f.task, 'author', 'fix', 'Queued before the defaults changed');
  f.task.agents.worker.model = 'current-model';
  f.store.saveTask(f.task);
  vi.spyOn(packages, 'latestCodexPackage').mockResolvedValue({
    version: '2.0.0',
    platform: 'fixture',
    url: 'fixture',
    integrity: 'fixture',
  });
  vi.spyOn(packages, 'installCodexPackage').mockResolvedValue(next);
  vi.spyOn(CodexCatalogue.prototype, 'list').mockResolvedValue([
    {
      id: 'current-model',
      engine: 'codex',
      name: 'Fixture',
      efforts: [],
      defaultEffort: '',
      isDefault: true,
    },
  ]);
  vi.spyOn(CodexCatalogue.prototype, 'metadata').mockReturnValue({
    source: 'fixture',
    cliVersion: '2.0.0',
  });
  const server = await buildApp({
    dataDir: dir,
    token: 'fixture',
    store: f.store,
    provider: () => f.provider,
    startWorker: false,
    resourceCheck: () => ({
      ok: true,
      reasons: [],
      diskAvailableGiB: 200,
      diskUsedPercent: 20,
      memoryAvailableGiB: 10,
      memoryTotalGiB: 20,
    }),
  });
  const headers = { authorization: 'Bearer fixture' };
  try {
    const plan = (
      await server.app.inject({
        method: 'POST',
        url: '/api/runtimes/codex/update/prepare',
        headers,
        payload: { action: 'install' },
      })
    ).json();
    expect(
      (
        await server.app.inject({
          method: 'POST',
          url: '/api/runtimes/codex/update/confirm',
          headers,
          payload: { id: plan.id },
        })
      ).statusCode,
    ).toBe(202);
    await vi.waitFor(async () =>
      expect(
        (await server.app.inject({ url: '/api/runtimes/codex/update', headers })).json().operation
          .phase,
      ).toBe('failed'),
    );
    const operation = (
      await server.app.inject({ url: '/api/runtimes/codex/update', headers })
    ).json().operation;
    expect(operation.error).toContain('queued-model');
    expect(loadConfig().executables.codex).toBe(previous);
    expect(f.store.jobs().find((item) => item.id === job.id)?.profile?.model).toBe('queued-model');
  } finally {
    await server.app.close();
    f.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
