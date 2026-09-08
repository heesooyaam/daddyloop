import { afterEach, beforeEach, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/server/app.js';
let server: Awaited<ReturnType<typeof buildApp>>;
let dir: string;
const token = 'test-only-token-not-a-real-secret';
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'reviewloop-server-test-'));
  server = await buildApp({
    dataDir: dir,
    token,
    startWorker: false,
    demo: true,
  });
});
afterEach(async () => {
  await server.app.close();
  rmSync(dir, { recursive: true, force: true });
});
it('requires authentication and blocks cross-origin control requests', async () => {
  expect((await server.app.inject('/api/tasks')).statusCode).toBe(401);
  expect(
    (
      await server.app.inject({
        url: '/api/tasks',
        headers: { Authorization: `Bearer ${token}` },
      })
    ).statusCode,
  ).toBe(200);
  const evil = await server.app.inject({
    method: 'POST',
    url: '/api/demo',
    headers: {
      origin: 'https://attacker.example',
      Authorization: `Bearer ${token}`,
    },
    payload: {},
  });
  expect(evil.statusCode).toBe(403);
});
it('uses an HttpOnly session cookie and requires CSRF headers for cookie-authenticated writes', async () => {
  const login = await server.app.inject({
    method: 'POST',
    url: '/api/session',
    payload: { token },
  });
  expect(login.statusCode).toBe(200);
  expect(login.headers['set-cookie']).toContain('HttpOnly');
  expect(login.headers['set-cookie']).toContain('SameSite=Strict');
  const cookie = String(login.headers['set-cookie']).split(';')[0];
  expect(
    (
      await server.app.inject({
        method: 'POST',
        url: '/api/demo',
        headers: { cookie },
        payload: {},
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await server.app.inject({
        method: 'POST',
        url: '/api/demo',
        headers: { cookie, 'x-reviewloop-request': '1' },
        payload: {},
      })
    ).statusCode,
  ).toBe(201);
});
it('rejects invalid workflow actions and returns a clear error envelope', async () => {
  const result = await server.app.inject({
    method: 'POST',
    url: '/api/tasks/none/actions',
    headers: { Authorization: `Bearer ${token}` },
    payload: { action: 'merge_everything' },
  });
  expect(result.statusCode).toBe(400);
  expect(result.json().error.code).toBe('validation_error');
});
it('keeps demo mode explicit and records human policy changes', async () => {
  const create = await server.app.inject({
    method: 'POST',
    url: '/api/demo',
    headers: { Authorization: `Bearer ${token}` },
    payload: {},
  });
  const task = create.json();
  expect(task.ref.provider).toBe('demo');
  const change = await server.app.inject({
    method: 'POST',
    url: `/api/tasks/${task.id}/policy`,
    headers: { Authorization: `Bearer ${token}` },
    payload: { policy: { publication: 'auto' } },
  });
  expect(change.statusCode).toBe(200);
  expect(server.store.events(task.id).some((e) => e.type === 'human.policy_changed')).toBe(true);
});
it('rejects a DNS-rebinding Host header even with a correct token', async () => {
  expect(
    (
      await server.app.inject({
        url: '/api/tasks',
        headers: { host: 'attacker.example', Authorization: `Bearer ${token}` },
      })
    ).statusCode,
  ).toBe(403);
});
it('closes open browser event streams during graceful shutdown', async () => {
  await server.app.listen({ host: '127.0.0.1', port: 0 });
  const address = server.app.server.address() as { port: number };
  const response = await fetch(`http://127.0.0.1:${address.port}/api/events`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const reader = response.body!.getReader();
  expect((await reader.read()).done).toBe(false);
  await server.app.close();
  expect((await reader.read()).done).toBe(true);
});
