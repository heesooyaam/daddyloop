import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/server/app.js';
import { loadConfig, saveConfig } from '../src/ops/config.js';
import { ModelCatalogue } from '../src/core/agents.js';
import * as packages from '../src/ops/codex-package.js';
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
it('authenticates update controls, activates atomically without changing the server PID, and persists across restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'reviewloop-updater-api-test-'));
  vi.stubEnv('REVIEWLOOP_CONFIG', join(dir, 'config.json'));
  const previous = join(dir, 'old-codex'),
    next = join(dir, 'new-codex');
  writeFileSync(previous, '#!/bin/sh\necho codex-cli 1.0.0\n', { mode: 0o700 });
  writeFileSync(next, '#!/bin/sh\necho codex-cli 2.0.0\n', { mode: 0o700 });
  saveConfig({ ...loadConfig(), dataDir: dir, codex: { executable: previous } });
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
  vi.spyOn(ModelCatalogue.prototype, 'list').mockResolvedValue([
    { id: 'fixture', name: 'Test', efforts: ['max'], defaultEffort: 'max', isDefault: true },
  ]);
  vi.spyOn(ModelCatalogue.prototype, 'metadata').mockReturnValue({
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
          url: '/api/runtime/update/prepare',
          payload: { action: 'install' },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await server.app.inject({
          method: 'POST',
          url: '/api/runtime/update/prepare',
          headers,
          payload: { action: 'install', url: 'https://attacker.example/run' },
        })
      ).statusCode,
    ).toBe(400);
    const plan = (
      await server.app.inject({
        method: 'POST',
        url: '/api/runtime/update/prepare',
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
          url: '/api/runtime/update/confirm',
          headers,
          payload: { id: plan.id },
        })
      ).statusCode,
    ).toBe(202);
    expect((await server.app.inject({ url: '/api/runtime/update', headers })).json().busy).toBe(
      true,
    );
    release();
    await vi.waitFor(async () =>
      expect(
        (await server.app.inject({ url: '/api/runtime/update', headers })).json().operation.phase,
      ).toBe('complete'),
    );
    expect(loadConfig().codex.executable).toBe(next);
    expect(loadConfig().locale).toBe('ru');
    expect(
      (await server.app.inject({ url: '/api/status', headers })).json().runtime.executable,
    ).toBe(next);
    expect((await server.app.inject('/api/health')).json().pid).toBe(health.pid);
    expect(
      (
        await server.app.inject({
          method: 'POST',
          url: '/api/runtime/update/confirm',
          headers,
          payload: { id: plan.id },
        })
      ).statusCode,
    ).toBe(409);
    await server.app.close();
    server = await buildApp(options);
    expect((await server.app.inject({ url: '/api/runtime/update', headers })).json().rollback).toBe(
      '1.0.0',
    );
    expect(
      (await server.app.inject({ url: '/api/status', headers })).json().runtime.executable,
    ).toBe(next);
    expect(install).toHaveBeenCalledOnce();
  } finally {
    release();
    await server.app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
