import { it, expect, vi } from 'vitest';
import { Store } from '../src/core/store.js';
import { UpdateMonitor } from '../src/core/updates.js';
import { isNewerVersion } from '../src/runtime/executable.js';
it('marks the exact managed version transition once while retaining notices for later external changes', async () => {
  const store = new Store(':memory:');
  let installed = '1.0.0';
  const monitor = new UpdateMonitor(store, {
    probe: async (command) =>
      command === 'codex'
        ? { source: 'managed', path: process.execPath, version: installed }
        : { source: 'missing' },
    fetcher: async () => new Response('{"version":"2.0.0"}'),
  });
  try {
    await monitor.check(true);
    store.setSetting('codex.update.operation', {
      id: 'managed-update',
      action: 'install',
      phase: 'complete',
      from: { version: '1.0.0', executable: '/old' },
      target: { version: '2.0.0', executable: process.execPath },
      finishedAt: new Date().toISOString(),
    });
    installed = '2.0.0';
    const managed = await monitor.check(true);
    expect(managed.tools[0].managedOperationId).toBe('managed-update');
    installed = '1.0.0';
    await monitor.check(true);
    installed = '2.0.0';
    expect((await monitor.check(true)).tools[0].managedOperationId).toBeUndefined();
  } finally {
    await monitor.stop();
    store.close();
  }
});
it('compares numeric CLI versions and recognizes a stable release after a prerelease', () => {
  expect(isNewerVersion('0.154.0', '0.153.4')).toBe(true);
  expect(isNewerVersion('1.10.0', '1.9.9')).toBe(true);
  expect(isNewerVersion('1.2.3', '1.2.3-rc.1')).toBe(true);
  expect(isNewerVersion('1.2.3', '1.2.3')).toBe(false);
  expect(isNewerVersion('1.2.2', '1.2.3')).toBe(false);
});
it('checks the selected CLI, caches registry queries and records an externally changed version', async () => {
  const store = new Store(':memory:');
  let installed = '1.0.0';
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ version: '1.1.0' })));
  const monitor = new UpdateMonitor(store, {
    codex: '/custom/codex',
    probe: async (command) =>
      command === '/custom/codex'
        ? { path: command, version: installed, source: 'external' }
        : { source: 'missing' },
    fetcher,
  });
  try {
    const first = await monitor.check();
    expect(first.tools[0]).toMatchObject({
      installed: '1.0.0',
      latest: '1.1.0',
      updateAvailable: true,
      executable: '/custom/codex',
    });
    expect(first.tools[1].supported).toBe(true);
    expect(first.tools[1].source).toBe('missing');
    await monitor.check();
    expect(fetcher).toHaveBeenCalledTimes(1);
    installed = '1.1.0';
    const next = await monitor.check(true);
    expect(next.tools[0]).toMatchObject({
      changedFrom: '1.0.0',
      installed: '1.1.0',
      updateAvailable: false,
    });
    expect(store.events('_system').some((event) => event.type === 'runtime.version_changed')).toBe(
      true,
    );
    store.setSetting('updates.notifications', false);
    expect(monitor.status().notifications).toBe(false);
  } finally {
    await monitor.stop();
    store.close();
  }
});
it('reports a failed registry check as unknown rather than up to date', async () => {
  const store = new Store(':memory:'),
    monitor = new UpdateMonitor(store, {
      probe: async (command) =>
        command === 'codex'
          ? { source: 'bundled', path: '/bundle/codex', version: '1.0.0' }
          : { source: 'missing' },
      fetcher: async () => new Response('', { status: 503 }),
    });
  try {
    const status = await monitor.check();
    expect(status.tools[0].latest).toBeUndefined();
    expect(status.tools[0].error).toContain('503');
    expect(status.tools[0].installed).toBe('1.0.0');
  } finally {
    await monitor.stop();
    store.close();
  }
});
it('cancels pending registry requests and does not persist incomplete checks after shutdown', async () => {
  const store = new Store(':memory:');
  const fetcher = vi.fn(
    (_url, options) =>
      new Promise<Response>((_resolve, reject) =>
        options.signal.addEventListener('abort', () => reject(new Error('cancelled')), {
          once: true,
        }),
      ),
  );
  const monitor = new UpdateMonitor(store, {
    probe: async (command) =>
      command === 'codex'
        ? { source: 'external', path: '/codex', version: '1.0.0' }
        : { source: 'missing' },
    fetcher,
  });
  try {
    const pending = monitor.check();
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalled());
    await monitor.stop();
    await pending;
    expect(store.setting('updates.status')).toBeUndefined();
  } finally {
    store.close();
  }
});

it('keeps a stable executable symlink so native updater replacements take effect', async () => {
  const { mkdtempSync, writeFileSync, symlinkSync, unlinkSync, rmSync, realpathSync } =
    await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { requireExecutable, executablePath } = await import('../src/runtime/executable.js');
  const dir = mkdtempSync(join(tmpdir(), 'daddyloop-cli-link-'));
  try {
    const launcher = join(dir, 'codex'),
      old = join(dir, 'old-version'),
      next = join(dir, 'new-version');
    writeFileSync(old, '#!/bin/sh\n', { mode: 0o700 });
    writeFileSync(next, '#!/bin/sh\n', { mode: 0o700 });
    symlinkSync(old, launcher);
    const configured = requireExecutable(launcher);
    expect(configured).toBe(launcher);
    expect(executablePath(configured)).toBe(realpathSync(old));
    unlinkSync(launcher);
    symlinkSync(next, launcher);
    expect(executablePath(configured)).toBe(realpathSync(next));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
