import { it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, symlinkSync, unlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/core/store.js';
import { UpdateMonitor } from '../src/core/updates.js';
import type { AgentCli } from '../src/modules/contracts.js';
import { isNewerVersion, executablePath, requireExecutable } from '../src/runtime/executable.js';
import {
  updateCard,
  runtimeConfirmationCard,
  updatesCard,
} from '../src/integrations/telegram-meta.js';
function fixture(id = 'atlas') {
  const store = new Store(':memory:');
  let version = '1.0.0',
    path = process.execPath;
  const cli: AgentCli = {
    name: id === 'claude' ? 'Claude Code' : 'Atlas',
    executable: () => path,
    releaseUrl: 'https://example.test/releases',
    probe: vi.fn(async (executable) => ({ executable, version })),
    latestVersion: vi.fn(async () => '2.0.0'),
    validate: async () => ({ models: [] }),
  };
  const monitor = new UpdateMonitor(store, { agents: [{ id, cli, managedUpdates: true }] });
  return {
    store,
    cli,
    monitor,
    setVersion: (v: string) => {
      version = v;
    },
    setPath: (v: string) => {
      path = v;
    },
    close: async () => {
      await monitor.stop();
      store.close();
    },
  };
}
it.each(['claude', 'atlas'])(
  'deduplicates only the exact managed transition for %s and preserves later external-change notices',
  async (engine) => {
    const f = fixture(engine);
    try {
      await f.monitor.check(true);
      f.store.setSetting(`runtime.${engine}.update.operation`, {
        engine,
        id: 'managed-update',
        phase: 'complete',
        from: { version: '1.0.0' },
        target: { version: '2.0.0', executable: process.execPath },
        finishedAt: new Date().toISOString(),
      });
      f.setVersion('2.0.0');
      expect((await f.monitor.check(true)).tools[0].managedOperationId).toBe('managed-update');
      f.setVersion('1.0.0');
      await f.monitor.check(true);
      f.setVersion('2.0.0');
      expect((await f.monitor.check(true)).tools[0].managedOperationId).toBeUndefined();
    } finally {
      await f.close();
    }
  },
);
it('caches update checks and marks unavailable registry results unknown', async () => {
  const f = fixture();
  try {
    const first = await f.monitor.check();
    expect(first.tools.map((tool) => tool.id)).toEqual(['atlas']);
    expect(first.tools[0]).toMatchObject({
      installed: '1.0.0',
      latest: '2.0.0',
      updateAvailable: true,
    });
    await f.monitor.check();
    expect(f.cli.latestVersion).toHaveBeenCalledOnce();
    vi.mocked(f.cli.latestVersion).mockRejectedValue(new Error('registry HTTP 503'));
    const failed = (await f.monitor.check(true)).tools[0];
    expect(failed.latest).toBeUndefined();
    expect(failed.error).toContain('503');
    expect(failed.installed).toBe('1.0.0');
  } finally {
    await f.close();
  }
});
it('rechecks a non-Codex selection changed while a registry request was pending', async () => {
  const f = fixture('claude');
  let finish!: (value: string) => void;
  vi.mocked(f.cli.latestVersion).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  try {
    const pending = f.monitor.check(true);
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    f.setPath('/new/claude');
    f.setVersion('2.0.0');
    finish('2.0.0');
    const status = await pending;
    expect(status.tools[0]).toMatchObject({ installed: '2.0.0', updateAvailable: false });
    expect(f.cli.probe).toHaveBeenLastCalledWith('/new/claude', expect.any(AbortSignal));
  } finally {
    await f.close();
  }
});
it('cancels pending adapter requests and never persists an incomplete shutdown check', async () => {
  const f = fixture();
  vi.mocked(f.cli.latestVersion).mockImplementation(
    (signal) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }),
      ),
  );
  try {
    const pending = f.monitor.check();
    await vi.waitFor(() => expect(f.cli.latestVersion).toHaveBeenCalled());
    await f.monitor.stop();
    await pending;
    expect(f.store.setting('updates.status')).toBeUndefined();
  } finally {
    await f.close();
  }
});
it('uses adapter names and actual update capability in every language, independent of installation source', async () => {
  const f = fixture('claude');
  try {
    const status = await f.monitor.check();
    for (const locale of ['en', 'ru'] as const) {
      const card = updateCard(locale, {
        kind: 'available',
        tool: status.tools[0],
        checkedAt: status.checkedAt!,
      });
      expect(card.text).toContain('Claude Code');
      expect(card.text).not.toContain('Codex');
      expect(card.text.match(/Claude Code/g)).toHaveLength(2);
      const manual = updateCard(locale, {
        kind: 'available',
        tool: { ...status.tools[0], managedUpdates: false },
        checkedAt: status.checkedAt!,
      });
      expect(manual.text).not.toMatch(/directly|прямо/);
    }
    const plan = {
      id: 'a'.repeat(24),
      engine: 'a'.repeat(32),
      name: 'Atlas',
      action: 'install' as const,
      from: { version: '1', executable: '/a' },
      target: { version: '2' },
      expiresAt: '',
    };
    expect(
      Buffer.byteLength(runtimeConfirmationCard('ru', plan).buttons![0][0].callback_data!),
    ).toBeLessThanOrEqual(64);
    expect(
      updatesCard('en', status, [
        { engine: 'claude', name: 'Claude Code', enabled: false, busy: false },
      ])
        .buttons?.flat()
        .some((button) => button.callback_data?.startsWith('u:')),
    ).toBe(false);
  } finally {
    await f.close();
  }
});
it('compares numeric versions including stable after prerelease', () => {
  expect(isNewerVersion('0.154.0', '0.153.4')).toBe(true);
  expect(isNewerVersion('1.10.0', '1.9.9')).toBe(true);
  expect(isNewerVersion('1.2.3', '1.2.3-rc.1')).toBe(true);
  expect(isNewerVersion('1.2.3', '1.2.3')).toBe(false);
  expect(isNewerVersion('1.2.2', '1.2.3')).toBe(false);
});
it('keeps the native launcher path and notices a replaced symlink during a pending check', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'daddyloop-cli-link-')),
    f = fixture();
  try {
    const old = join(dir, 'old'),
      next = join(dir, 'next'),
      launcher = join(dir, 'agent');
    writeFileSync(old, '#!/bin/sh\n', { mode: 0o700 });
    writeFileSync(next, '#!/bin/sh\n', { mode: 0o700 });
    symlinkSync(old, launcher);
    expect(requireExecutable(launcher)).toBe(launcher);
    f.setPath(launcher);
    let finish!: (value: string) => void;
    vi.mocked(f.cli.latestVersion).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = f.monitor.check();
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    unlinkSync(launcher);
    symlinkSync(next, launcher);
    f.setVersion('2.0.0');
    finish('2.0.0');
    expect((await pending).tools[0].executable).toBe(executablePath(next));
    expect(f.cli.probe).toHaveBeenCalledTimes(2);
  } finally {
    await f.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
