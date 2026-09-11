import { expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../src/server/app.js';
import { daddyFixture } from './daddy-fixture.js';
import { healthy, catalogue } from './planning-fixture.js';
import type { UsageBackend, UsageView } from '../src/core/usage.js';
it('authenticates quota reads and requires explicit reset confirmation', async () => {
  const f = daddyFixture(),
    id = randomUUID();
  const usage: UsageBackend = {
    read: vi.fn(async () => ({ agents: [] }) as UsageView),
    prepare: vi.fn(async () => ({
      id,
      title: 'Full reset',
      status: 'ready' as const,
      availableCount: 1,
      expiresAt: '2099-01-01T00:00:00Z',
    })),
    consume: vi.fn(),
  };
  const server = await buildApp({
    dataDir: f.dir,
    store: f.store,
    workspaces: f.workspaces,
    checkouts: f.checkouts,
    daddyRuntime: f.runtime,
    daddyWorkspace: f.context,
    catalogue,
    resourceCheck: healthy,
    startWorker: false,
    token: 'fixture',
    usage,
  });
  const headers = { authorization: 'Bearer fixture' };
  try {
    expect((await server.app.inject('/api/usage')).statusCode).toBe(401);
    expect(
      (await server.app.inject({ method: 'POST', url: '/api/usage/reset/prepare', payload: {} }))
        .statusCode,
    ).toBe(401);
    expect(
      (
        await server.app.inject({
          method: 'POST',
          url: '/api/usage/reset/prepare',
          headers,
          payload: {},
        })
      ).statusCode,
    ).toBe(200);
    expect(usage.consume).not.toHaveBeenCalled();
    expect(
      (
        await server.app.inject({
          method: 'POST',
          url: '/api/usage/reset/' + id,
          headers,
          payload: { confirmed: false },
        })
      ).statusCode,
    ).toBe(400);
    expect(usage.consume).not.toHaveBeenCalled();
    await server.app.inject({
      method: 'POST',
      url: '/api/usage/reset/' + id,
      headers,
      payload: { confirmed: true },
    });
    expect(usage.consume).toHaveBeenCalledWith(id, 'api');
  } finally {
    await server.app.close();
    await f.close();
  }
});
