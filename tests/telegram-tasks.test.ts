import { expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { daddyFixture } from './daddy-fixture.js';
import { catalogue } from './planning-fixture.js';
import { Telegram, TelegramApi, type Update } from '../src/integrations/telegram.js';
import { UpdateMonitor } from '../src/core/updates.js';
import { setLocale } from '../src/core/preferences.js';
import { registerDaddy } from '../src/server/daddy.js';
import { taskReference } from '../src/core/task-activity.js';

it('shares task IDs, the queue and worker profiles between Telegram and the web API', async () => {
  const f = daddyFixture();
  const app = Fastify();
  registerDaddy(app, f.daddy);
  const sent: { method: string; body: Record<string, unknown> }[] = [];
  const api = new TelegramApi('123456:abcdefghijklmnopqrstuvwxyz123456', async (url, request) => {
    sent.push({ method: String(url).split('/').at(-1)!, body: JSON.parse(String(request?.body)) });
    return Response.json({ ok: true, result: { message_id: sent.length } });
  });
  const bot = new Telegram(f.engine, api, 'fixture_bot');
  bot.configure({ daddy: f.daddy, catalogue, updates: new UpdateMonitor(f.store, { agents: [] }) });
  setLocale(f.store, 'en');
  f.store.setSetting('telegram.pairing', { chatId: 7, userId: 7 });
  f.store.setSetting('telegram.group', { chatId: -10042, title: 'Work', ownerId: 7 });
  const group = f.daddy.create({ workspaceId: f.workspace.id, workerLimit: 2 });
  const session = `/api/daddy/sessions/${group.id}`;
  let updateId = 0;
  const message = (text: string, user = 7, topic = 17): Update => ({
    update_id: ++updateId,
    message: {
      message_id: updateId,
      chat: { id: -10042, type: 'supergroup' },
      message_thread_id: topic,
      from: { id: user },
      text,
    },
  });
  const lastText = () => sent.filter(({ method }) => method === 'sendMessage').at(-1)?.body.text;
  try {
    await bot.handle(message(`/attach ${group.id.slice(0, 8)}`));
    const command =
      '/task@fixture_bot --worker 2 --model gpt-5.6-sol --effort medium -- Fix search\nKeep old filters.';
    await bot.handle(message(command, 7, 18));
    await bot.handle(message(command, 99));
    await bot.handle(message(command.replace('@fixture_bot', '@other_bot')));
    expect(f.store.tasks(group.id)).toHaveLength(0);

    const update = message(command);
    vi.spyOn(f.store, 'enqueue').mockImplementationOnce(() => {
      throw Object.assign(new Error('SQLite write failed'), { code: 'ERR_SQLITE_ERROR' });
    });
    await expect(bot.handle(update)).rejects.toThrow('SQLite write failed');
    expect(f.store.tasks(group.id)).toHaveLength(0);
    expect(
      f.store.db.prepare('SELECT 1 FROM bot_receipts WHERE id=?').get(update.update_id),
    ).toBeUndefined();

    await bot.handle(update);
    await bot.handle(update);
    await bot.handle({ ...update, update_id: ++updateId });
    await api.delivery!.flush();
    const [task] = f.store.tasks(group.id);
    expect(f.store.tasks(group.id)).toHaveLength(1);
    expect(task).toMatchObject({
      requirements: 'Fix search\nKeep old filters.',
      state: 'implementing',
      workerRequest: {
        slot: 2,
        profile: { engine: 'codex', model: 'gpt-5.6-sol', effort: 'medium' },
      },
    });
    expect(f.store.jobs(task!.id)).toMatchObject([{ kind: 'implement', status: 'queued' }]);
    expect(f.store.daddyJobs(group.id)).toHaveLength(0);
    const id = task!.source!.key;
    expect(lastText()).toContain(id);
    expect(sent.filter(({ body }) => String(body.text).startsWith('Task queued'))).toHaveLength(1);

    await bot.handle(message('/queue'));
    expect(lastText()).toContain(`${id}  Fix search\nWaiting for a worker · Worker 2`);
    await bot.handle(message(`/task ${id}`));
    expect(lastText()).toContain('Worker 2\ncodex · gpt-5.6-sol · medium');
    await bot.handle(message('/worker 1 gpt-6-astra max'));
    await bot.handle(message('/workers'));
    expect(lastText()).toContain('Worker 1 · codex · gpt-6-astra · max\nFree');

    const web = (await app.inject(session)).json();
    expect(web.taskQueue).toEqual([task!.id]);
    expect(web.tasks[0]).toMatchObject({ id: task!.id, statusLabel: 'Waiting for a worker' });
    expect(web.workers.slots[0]).toMatchObject({
      profile: { model: 'gpt-6-astra', effort: 'max' },
    });

    const click = (data: string, user = 7, topic = 17): Update => ({
      update_id: ++updateId,
      callback_query: {
        id: String(updateId),
        data,
        from: { id: user },
        message: {
          chat: { id: -10042, type: 'supergroup' },
          message_thread_id: topic,
        },
      },
    });
    await bot.handle(click(`dad:sm:${group.id}:on`, 99));
    expect((await app.inject(session)).json().group.autoMerge).toBe(false);
    await bot.handle(click(`dad:sm:${group.id}:on`));
    expect((await app.inject(session)).json().tasks[0].autoMerge).toMatchObject({
      mode: 'inherit',
      enabled: true,
    });
    await bot.handle(click(`dad:tm:${task!.id}:off`, 7, 18));
    expect((await app.inject(session)).json().tasks[0].autoMerge.mode).toBe('inherit');
    await bot.handle(click(`dad:tm:${task!.id}:off`));
    expect((await app.inject(session)).json().tasks[0].autoMerge).toMatchObject({
      mode: 'off',
      enabled: false,
    });
    const policyResponse = await app.inject({
      method: 'POST',
      url: session + '/tasks/' + task!.id + '/auto-merge',
      payload: { mode: 'inherit' },
    });
    expect(policyResponse.statusCode).toBe(200);
    await bot.handle(message(`/task ${id}`));
    expect(lastText()).toContain('Auto-merge GitHub PRs · On');

    const input = { requirements: 'Task from web', requestId: randomUUID() };
    const enqueue = () => app.inject({ method: 'POST', url: session + '/tasks', payload: input });
    const queuedFromWeb = await enqueue();
    expect(queuedFromWeb.statusCode).toBe(201);
    const webTask = queuedFromWeb.json();
    expect((await enqueue()).json()).toEqual(webTask);
    expect((await app.inject(session)).json().taskQueue).toEqual([task!.id, webTask.id]);
    await bot.handle(message('/queue'));
    expect(lastText()).toContain(taskReference(webTask) + '  Task from web');

    const configured = await app.inject({
      method: 'POST',
      url: session + '/workers/1',
      payload: { profile: { engine: 'codex', model: 'gpt-5.6-sol', effort: 'medium' } },
    });
    expect(configured.statusCode).toBe(200);
    await bot.handle(message('/workers'));
    expect(lastText()).toContain('Worker 1 · codex · gpt-5.6-sol · medium\nFree');
  } finally {
    await app.close();
    await bot.stop();
    await f.close();
  }
});
