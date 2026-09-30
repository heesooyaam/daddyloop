import { afterEach, expect, it, vi } from 'vitest';
import { daddyFixture } from './daddy-fixture.js';
import { TelegramApi } from '../src/integrations/telegram.js';
import { TelegramWorkspace } from '../src/integrations/telegram-workspace.js';
import { TelegramDelivery } from '../src/integrations/telegram-delivery.js';

afterEach(() => vi.restoreAllMocks());

it('updates the initial private-chat card after /new as well', async () => {
  const f = daddyFixture();
  const sent: { method: string; body: Record<string, any> }[] = [];
  const api = new TelegramApi('123456:abcdefghijklmnopqrstuvwxyz123456', async (url, options) => {
    sent.push({ method: String(url).split('/').at(-1)!, body: JSON.parse(String(options?.body)) });
    return new Response(JSON.stringify({ ok: true, result: { message_id: sent.length } }));
  });
  api.delivery = new TelegramDelivery(f.store, api, 'fixture_bot');
  const workspace = new TelegramWorkspace(f.daddy, api, 'fixture_bot', () => 'en');
  f.store.setSetting('telegram.pairing', { chatId: 7, userId: 7 });
  const create = f.daddy.create.bind(f.daddy);
  vi.spyOn(f.daddy, 'create').mockImplementation((input) => {
    const group = create(input);
    group.workspacePreparation = { state: 'preparing' };
    f.store.saveGroup(group);
    return group;
  });
  const message = { chat: { id: 7, type: 'private' }, from: { id: 7 } };
  const click = (data: string, id: number) =>
    workspace.handle({
      update_id: id,
      callback_query: { id: String(id), from: { id: 7 }, data, message },
    });
  try {
    await workspace.handle({ update_id: 1, message: { ...message, text: '/new' } });
    await click(`dad:new:${f.workspace.id}`, 2);
    await click(sent.at(-1)!.body.reply_markup.inline_keyboard[0][0].callback_data, 3);
    const group = f.daddy.sessions()[0];
    const initial = sent.find(
      (item) => item.method === 'sendMessage' && item.body.text.includes(group.title),
    )!;
    const messageId = sent.indexOf(initial) + 1;
    expect(initial.body.text).toContain('Preparing');
    group.workspacePreparation = { state: 'ready' };
    f.store.saveGroup(group);
    workspace.onEvent({
      id: 4,
      taskId: group.id,
      type: 'daddy.workspace_ready',
      data: {},
      at: group.updatedAt,
    });
    await vi.waitFor(() =>
      expect(sent.filter((item) => item.method === 'editMessageText')).toHaveLength(1),
    );
    expect(sent.at(-1)!.body).toMatchObject({
      chat_id: 7,
      message_id: messageId,
      text: expect.stringContaining('ready'),
    });
    expect(
      sent.filter((item) => item.method === 'sendMessage' && item.body.text.includes(group.title)),
    ).toHaveLength(1);
  } finally {
    await workspace.stop();
    await api.delivery.stop();
    await f.close();
  }
});

it.each([false, true])(
  'edits the session card after preparation, including a failed edit and restart (%s)',
  async (failEdit) => {
    const f = daddyFixture(true);
    const sent: { method: string; body: Record<string, any> }[] = [];
    let unavailable = false;
    let clock = Date.now();
    const api = new TelegramApi('123456:abcdefghijklmnopqrstuvwxyz123456', async (url, options) => {
      const method = String(url).split('/').at(-1)!;
      const body = JSON.parse(String(options?.body));
      sent.push({ method, body });
      if (method === 'editMessageText' && unavailable)
        return new Response('unavailable', { status: 503 });
      const result =
        method === 'createForumTopic' ? { message_thread_id: 17 } : { message_id: 101 };
      return new Response(JSON.stringify({ ok: true, result }));
    });
    const delivery = () => new TelegramDelivery(f.store, api, 'fixture_bot', () => clock);
    const integration = () => new TelegramWorkspace(f.daddy, api, 'fixture_bot', () => 'en');
    api.delivery = delivery();
    let workspace = integration();
    f.store.setSetting('telegram.pairing', { chatId: 7, userId: 7 });
    f.store.setSetting('telegram.group', { chatId: -10042, title: 'Work', ownerId: 7 });
    try {
      const group = f.daddy.create({ workspaceId: f.workspace.id });
      group.workspacePreparation = { state: 'preparing' };
      f.store.saveGroup(group);
      workspace.onEvent({
        id: 1,
        taskId: group.id,
        type: 'daddy.created',
        data: {},
        at: group.updatedAt,
      });
      await vi.waitFor(() =>
        expect(sent.filter((item) => item.method === 'sendMessage')).toHaveLength(1),
      );
      expect(sent.find((item) => item.method === 'sendMessage')!.body).toMatchObject({
        chat_id: -10042,
        message_thread_id: 17,
        text: expect.stringContaining('Preparing'),
      });
      group.workspacePreparation = { state: 'ready' };
      group.updatedAt = new Date(Date.now() + 1000).toISOString();
      f.store.saveGroup(group);
      unavailable = failEdit;
      const ready = {
        id: 2,
        taskId: group.id,
        type: 'daddy.workspace_ready',
        data: {},
        at: group.updatedAt,
      };
      workspace.onEvent(ready);
      await vi.waitFor(() =>
        expect(sent.filter((item) => item.method === 'editMessageText')).toHaveLength(1),
      );
      await workspace.stop();
      await api.delivery.stop();
      if (failEdit) expect(api.delivery.status().pending).toBe(1);
      unavailable = false;
      clock += 600000;
      api.delivery = delivery();
      workspace = integration();
      await api.delivery.flush();
      workspace.replay();
      workspace.onEvent(ready);
      await workspace.stop();
      await api.delivery.flush();
      expect(api.delivery.status().pending).toBe(0);
      expect(sent.filter((item) => item.method === 'sendMessage')).toHaveLength(1);
      const edits = sent.filter((item) => item.method === 'editMessageText');
      expect(edits).toHaveLength(failEdit ? 2 : 1);
      expect(edits.at(-1)!.body).toMatchObject({
        chat_id: -10042,
        message_id: 101,
        text: expect.stringContaining('ready'),
      });
    } finally {
      await workspace.stop();
      await api.delivery.stop();
      await f.close();
    }
  },
);
