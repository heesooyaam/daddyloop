import { it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildApp } from '../src/server/app.js';
import { Workspaces } from '../src/runtime/workspaces.js';
import { TicketReader } from '../src/integrations/tickets.js';
import { profiles, catalogue, ticketInput } from './planning-fixture.js';
it('exposes ticket, child, model and Telegram settings with saved effective profiles', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'reviewloop-planning-api-')),
    ws = new Workspaces(dir),
    reader = new TicketReader();
  vi.spyOn(reader, 'read').mockImplementation(async (source) =>
    ticketInput(Number(source.split('/').at(-1))),
  );
  vi.spyOn(ws, 'describeTicket').mockImplementation(async (repoPath, ref) => ({
    ...ticketInput(),
    repoPath,
    ref,
  }));
  const server = await buildApp({
    dataDir: dir,
    token: 'fixture-token',
    startWorker: false,
    workspaces: ws,
    ticketReader: reader,
    catalogue,
  });
  const api = async (url: string, body?: unknown) =>
    server.app.inject({
      method: body ? 'POST' : 'GET',
      url: '/api' + url,
      headers: { authorization: 'Bearer fixture-token' },
      ...(body ? { payload: body as Record<string, unknown> } : {}),
    });
  try {
    expect((await api('/agents/defaults', { profiles, maxConcurrentAgents: 2 })).statusCode).toBe(
      200,
    );
    const created = await api('/tickets', { source: ticketInput().source.url, repoPath: '/tmp' });
    expect(created.statusCode).toBe(201);
    const task = created.json();
    expect(task.policy.publication).toBe('auto');
    expect(task.agents).toEqual(profiles);
    const child = (
      await api('/tickets', { source: ticketInput(43).source.url, parentTaskId: task.id })
    ).json();
    expect(child.groupId).toBe(task.groupId);
    expect(child.agents.reviewer).toEqual(profiles.reviewer);
    expect(
      (await api('/agents/defaults/author', { engine: 'codex' })).json().defaults.reviewer,
    ).toEqual(profiles.reviewer);
    expect((await api(`/tasks/${task.id}`)).json().agents.author).toEqual(profiles.author);
    expect((await api('/groups')).json()[0].tasks).toHaveLength(2);
    expect((await api('/notifications', { enabled: true, mode: 'attention' })).json()).toEqual({
      telegram: { enabled: true, mode: 'attention' },
      paired: false,
    });
    expect((await api('/notifications')).json().telegram.enabled).toBe(true);
    expect((await api('/agents/concurrency', { maxConcurrentAgents: 99 })).statusCode).toBe(400);
    expect(
      (await api(`/tasks/${task.id}/agents`, { role: 'author', profile: profiles.reviewer }))
        .statusCode,
    ).toBe(409);
  } finally {
    await server.app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
