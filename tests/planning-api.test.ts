import { it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildApp } from '../src/server/app.js';
import { catalogue } from './planning-fixture.js';
it('persists language preferences and exposes model provenance and an explicit refresh', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'daddyloop-language-api-'));
  const list = vi.fn(catalogue.list);
  const server = await buildApp({
    dataDir: dir,
    token: 'fixture',
    startWorker: false,
    catalogue: {
      ...catalogue,
      list,
      metadata: () => ({
        source: 'codex-app-server:model/list',
        executable: '/fixture/codex',
        cliVersion: '1.0.0',
        retrievedAt: '2026-09-09T00:00:00Z',
      }),
    },
  });
  const api = async (url: string, body?: unknown) =>
    server.app.inject({
      method: body ? 'POST' : 'GET',
      url: '/api' + url,
      headers: { authorization: 'Bearer fixture' },
      ...(body ? { payload: body as Record<string, unknown> } : {}),
    });
  try {
    const first = (await api('/preferences')).json();
    const changed = await api('/preferences', { locale: 'ru' });
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toEqual({ locale: 'ru', version: first.version + 1 });
    expect((await api('/status')).json().preferences.locale).toBe('ru');
    expect((await api('/preferences', { locale: 'de' })).statusCode).toBe(400);
    const models = await api('/agents?refresh=1');
    expect(models.json().catalogue.cliVersion).toBe('1.0.0');
    expect(list).toHaveBeenCalledWith(true);
  } finally {
    await server.app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
