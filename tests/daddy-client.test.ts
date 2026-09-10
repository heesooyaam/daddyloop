import { expect, it, vi } from 'vitest';
import { DaddyClient, type DaddyApi } from '../src/client/daddy.js';
import { daddyFixture } from './daddy-fixture.js';
import { healthy } from './planning-fixture.js';
it('fences a late session read and preserves drafts for both conversations', async () => {
  const f = daddyFixture(),
    a = f.daddy.create({ projectId: f.project.id, title: 'A' }),
    b = f.daddy.create({ projectId: f.project.id, title: 'B' });
  let resolveA!: (value: unknown) => void;
  let delayed = false;
  const api: DaddyApi = async <T>(path: string) => {
    if (path === '/projects') return [f.project] as T;
    if (path === '/status')
      return {
        version: '0.7.0',
        preferences: { locale: 'en', version: 1 },
        resources: healthy(),
        telegram: {},
      } as T;
    if (path === '/daddy/sessions')
      return f.daddy.sessions().map((group) => ({
        ...group,
        writers: f.daddy.board(group.id).writers,
        total: 0,
        complete: 0,
        daddyBusy: false,
      })) as T;
    if (path.endsWith(a.id) && delayed)
      return new Promise<T>((resolve) => {
        resolveA = resolve as (value: unknown) => void;
      });
    return f.daddy.board(path.split('/').at(-1)!) as T;
  };
  const model = new DaddyClient(api, a.id);
  try {
    await model.refresh();
    model.draft('Draft A');
    delayed = true;
    const pending = model.select(a.id);
    await model.select(b.id);
    model.draft('Draft B');
    resolveA(f.daddy.board(a.id));
    await pending;
    expect(model.snapshot().board?.group.id).toBe(b.id);
    expect(model.snapshot().drafts).toMatchObject({ [a.id]: 'Draft A', [b.id]: 'Draft B' });
  } finally {
    model.stop();
    await f.close();
  }
});
it('reuses an uncertain message request ID and keeps text edited while a send is pending', async () => {
  const f = daddyFixture(),
    group = f.daddy.create({ projectId: f.project.id });
  const requests: { text: string; requestId: string }[] = [];
  let attempt = 0,
    finish!: () => void;
  const api: DaddyApi = async <T>(path: string, body?: unknown) => {
    if (path.endsWith('/chat')) {
      requests.push(body as { text: string; requestId: string });
      if (attempt++ === 0) throw new Error('response lost');
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return {} as T;
    }
    if (path === '/projects') return [f.project] as T;
    if (path === '/status')
      return {
        version: '0.7.0',
        preferences: { locale: 'en', version: 1 },
        resources: healthy(),
        telegram: {},
      } as T;
    if (path === '/daddy/sessions')
      return [
        {
          ...group,
          writers: { active: 0, limit: 1, hostLimit: 1 },
          total: 0,
          complete: 0,
          daddyBusy: false,
        },
      ] as T;
    return f.daddy.board(group.id) as T;
  };
  const model = new DaddyClient(api, group.id);
  try {
    await model.refresh();
    model.draft('Original');
    await model.send();
    expect(model.snapshot().drafts[group.id]).toBe('Original');
    const pending = model.send();
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    model.draft('Edited while sending');
    finish();
    await pending;
    expect(requests[0].requestId).toBe(requests[1].requestId);
    expect(model.snapshot().drafts[group.id]).toBe('Edited while sending');
  } finally {
    model.stop();
    await f.close();
  }
});
it('can remount after cleanup without reusing an aborted read controller', async () => {
  const signals: AbortSignal[] = [];
  const api: DaddyApi = async <T>(path: string, _body?: unknown, signal?: AbortSignal) => {
    if (signal) signals.push(signal);
    if (path === '/status')
      return {
        version: '0.7.0',
        preferences: { locale: 'en', version: 1 },
        resources: healthy(),
        telegram: {},
      } as T;
    return [] as T;
  };
  const model = new DaddyClient(api);
  model.start();
  model.stop();
  model.start();
  await model.refresh();
  expect(model.snapshot().connected).toBe(true);
  expect(signals.at(-1)?.aborted).toBe(false);
  model.stop();
});
