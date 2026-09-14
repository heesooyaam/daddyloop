import { it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildApp } from '../src/server/app.js';
import { configSchema } from '../src/ops/config.js';
import { UpdateMonitor } from '../src/core/updates.js';
import { profileSchema } from '../src/core/agents.js';
import { selectedExecutable } from '../src/runtime/executable.js';
it('starts update monitoring for a Claude-only installation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'daddyloop-claude-monitor-'));
  const start = vi.spyOn(UpdateMonitor.prototype, 'start').mockImplementation(() => {});
  const server = await buildApp({
    dataDir: dir,
    token: 'fixture',
    config: configSchema.parse({
      modules: ['claude'],
      telegram: { enabled: false },
      agents: { worker: { engine: 'claude' }, daddy: { engine: 'claude' } },
    }),
  });
  try {
    await server.app.ready();
    expect(start).toHaveBeenCalledOnce();
    const headers = { authorization: 'Bearer fixture' };
    const status = (await server.app.inject({ url: '/api/runtimes', headers })).json();
    expect(status.map((item: { engine: string }) => item.engine)).toEqual(['claude']);
    expect(
      (await server.app.inject({ url: '/api/runtimes/codex/update', headers })).statusCode,
    ).toBe(422);
  } finally {
    await server.app.close();
    start.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
});
it('requires an explicit profile engine and never defaults an unknown executable to Codex', () => {
  expect(profileSchema.safeParse({ model: 'some-model' }).success).toBe(false);
  expect(
    profileSchema.parse({ engine: 'atlas', model: 'same-model', effort: 'future-effort' }),
  ).toMatchObject({ engine: 'atlas', effort: 'future-effort' });
  expect(() => selectedExecutable(undefined)).toThrow('did not select');
});
