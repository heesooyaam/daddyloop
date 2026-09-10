import { randomBytes, randomInt } from 'node:crypto';
import type { Daddy } from '../core/daddy.js';
import { AppError, now, type Event, type ReviewGroup, type AgentProfiles } from '../core/types.js';
import { redact } from '../core/security.js';
import type { TelegramApi, Update } from './telegram.js';
import { TelegramText, type TelegramCard } from './telegram-text.js';
import { daddyHome, projectPicker, daddyBoard, poolCard } from './daddy-cards.js';
import { translator, type Locale } from '../i18n/index.js';
import { notificationPreferences } from './notifications.js';
type Pair = { chatId: number; userId: number };
type Room = { chatId: number; title: string; ownerId: number };
type Topic = { chatId: number; threadId: number; groupId: string; ownerId: number };
type Destination = { chatId: number; threadId?: number };
export class TelegramWorkspace {
  private pending = Promise.resolve();
  private stopped = false;
  private topics = new Map<string, Promise<Topic>>();
  constructor(
    readonly daddy: Daddy,
    private api: TelegramApi,
    private username: string,
    private locale: () => Locale,
  ) {}
  private get store() {
    return this.daddy.engine.store;
  }
  private get t() {
    return translator(this.locale());
  }
  private pair() {
    return this.store.setting<Pair>('telegram.pairing');
  }
  room() {
    const room = this.store.setting<Room>('telegram.workspace');
    return room?.ownerId === this.pair()?.userId ? room : undefined;
  }
  private key(room: Room, groupId: string) {
    return `${room.ownerId}:${room.chatId}:${groupId}`;
  }
  private topic(room: Room, groupId: string): Topic | undefined {
    const row = this.store.db
      .prepare('SELECT data FROM telegram_topics WHERE id=?')
      .get(this.key(room, groupId));
    return row ? JSON.parse(row.data as string) : undefined;
  }
  private saveTopic(topic: Topic) {
    this.store.db
      .prepare(
        'INSERT INTO telegram_topics VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',
      )
      .run(
        `${topic.ownerId}:${topic.chatId}:${topic.groupId}`,
        topic.groupId,
        JSON.stringify(topic),
      );
  }
  private groupAt(destination: Destination) {
    const room = this.room();
    if (!room || room.chatId !== destination.chatId || !destination.threadId) return;
    const rows = this.store.db.prepare('SELECT data FROM telegram_topics').all();
    return rows
      .map((row) => JSON.parse(row.data as string) as Topic)
      .find(
        (topic) =>
          topic.chatId === room.chatId &&
          topic.threadId === destination.threadId &&
          topic.ownerId === room.ownerId,
      )?.groupId;
  }
  private link(topic: Topic) {
    return `https://t.me/c/${String(topic.chatId).replace(/^-100/, '')}/${topic.threadId}`;
  }
  async ensureTopic(group: ReviewGroup): Promise<Topic | undefined> {
    const room = this.room();
    if (!room) return;
    const key = this.key(room, group.id),
      existing = this.topic(room, group.id);
    if (existing) return existing;
    const pending = this.topics.get(key);
    if (pending) return pending;
    const operation = `telegram:topic:${key}`;
    const create = this.daddy.engine.broker.outbox
      .perform<Topic>(
        group.id,
        operation,
        { room: room.chatId, groupId: group.id },
        async () => {
          const value = await this.api.call<{ message_thread_id: number }>('createForumTopic', {
            chat_id: room.chatId,
            name: group.title.slice(0, 128),
          });
          if (!Number.isSafeInteger(value.message_thread_id) || value.message_thread_id <= 0)
            throw new Error('Telegram returned an invalid topic ID');
          const topic = {
            chatId: room.chatId,
            threadId: value.message_thread_id,
            groupId: group.id,
            ownerId: room.ownerId,
          };
          this.saveTopic(topic);
          return topic;
        },
        async () => {
          const topic = this.topic(room, group.id);
          return topic ? { found: true, value: topic } : { found: false };
        },
      )
      .catch((error) => {
        if (error instanceof AppError && error.code === 'telegram_error')
          this.store.db
            .prepare("DELETE FROM operations WHERE id=? AND status='pending'")
            .run(operation);
        if (error instanceof AppError && error.code === 'ambiguous_write')
          throw new AppError(
            'topic_uncertain',
            this.t(
              'The topic may already exist. Open it and send /attach {id} to reconnect this session.',
              { id: group.id.slice(0, 8) },
            ),
          );
        throw error;
      })
      .finally(() => this.topics.delete(key));
    this.topics.set(key, create);
    return create;
  }
  async setup() {
    const pair = this.pair();
    if (!pair) throw new Error('Pair the bot first');
    const requestId = randomInt(1, 2147483647);
    this.store.setSetting('telegram.workspaceRequest', {
      id: requestId,
      userId: pair.userId,
      expiresAt: new Date(Date.now() + 10 * 60000).toISOString(),
    });
    const rights = {
      is_anonymous: false,
      can_manage_chat: true,
      can_delete_messages: false,
      can_manage_video_chats: false,
      can_restrict_members: false,
      can_promote_members: false,
      can_change_info: false,
      can_invite_users: false,
      can_post_stories: false,
      can_edit_stories: false,
      can_delete_stories: false,
      can_manage_topics: true,
    };
    await this.api.call('sendMessage', {
      chat_id: pair.chatId,
      text:
        this.t(
          'Create a Telegram group, enable Topics, then choose it below. Telegram can add the bot with permission to manage topics. Each Daddy session will get its own topic.',
        ) +
        '\n\n@' +
        this.username,
      reply_markup: {
        keyboard: [
          [
            {
              text: '🧵 ' + this.t('Choose a group with topics'),
              request_chat: {
                request_id: requestId,
                chat_is_channel: false,
                chat_is_forum: true,
                chat_is_created: true,
                user_administrator_rights: rights,
                bot_administrator_rights: rights,
                request_title: true,
              },
            },
          ],
        ],
        resize_keyboard: true,
        one_time_keyboard: true,
      },
    });
  }
  private async bind(shared: NonNullable<NonNullable<Update['message']>['chat_shared']>) {
    const pair = this.pair()!,
      request = this.store.setting<{ id: number; userId: number; expiresAt: string }>(
        'telegram.workspaceRequest',
      );
    if (
      !request ||
      request.id !== shared.request_id ||
      request.userId !== pair.userId ||
      request.expiresAt <= now()
    )
      throw new Error(this.t('Group selection expired. Send /workspace again.'));
    const botId = this.store.setting<number>('telegram.botId');
    if (!botId) throw new Error('Bot identity is unavailable');
    const [chat, user, bot] = await Promise.all([
      this.api.call<{ type: string; is_forum?: boolean; title: string }>('getChat', {
        chat_id: shared.chat_id,
      }),
      this.api.call<{ status: string; can_manage_topics?: boolean }>('getChatMember', {
        chat_id: shared.chat_id,
        user_id: pair.userId,
      }),
      this.api.call<{ status: string; can_manage_topics?: boolean }>('getChatMember', {
        chat_id: shared.chat_id,
        user_id: botId,
      }),
    ]);
    if (
      chat.type !== 'supergroup' ||
      !chat.is_forum ||
      !['creator', 'administrator'].includes(user.status) ||
      bot.status !== 'administrator' ||
      !bot.can_manage_topics
    )
      throw new Error(
        this.t(
          'Enable Topics and make the bot an administrator with Manage Topics permission, then select the group again.',
        ),
      );
    if (
      this.pair()?.userId !== pair.userId ||
      this.store.setting<{ id: number }>('telegram.workspaceRequest')?.id !== request.id
    )
      throw new Error(this.t('Group selection expired. Send /workspace again.'));
    const room: Room = { chatId: shared.chat_id, title: chat.title, ownerId: pair.userId };
    this.store.transaction(() => {
      this.store.setSetting('telegram.workspace', room);
      this.store.setSetting('telegram.workspaceRequest', null);
    });
    await this.api.call('sendMessage', {
      chat_id: pair.chatId,
      text: this.t('Workspace connected: {name}', { name: room.title }),
      reply_markup: { remove_keyboard: true },
    });
    await this.api.send(pair.chatId, daddyHome(this.locale(), this.daddy.sessions()));
    this.replay();
  }
  private authorize(destination: Destination, groupId: string) {
    const pair = this.pair();
    if (destination.chatId !== pair?.chatId && this.groupAt(destination) !== groupId)
      throw new AppError('wrong_topic', 'Use the topic belonging to this Daddy session', 403);
    return this.daddy.group(groupId);
  }
  async show(groupId: string, destination: Destination) {
    const group = this.authorize(destination, groupId),
      topic = await this.ensureTopic(group);
    if (destination.chatId === this.pair()?.chatId)
      this.store.setSetting('telegram.currentDaddy', group.id);
    await this.api.send(
      destination,
      daddyBoard(
        this.locale(),
        this.daddy.board(group.id),
        destination.chatId === this.pair()?.chatId && topic ? this.link(topic) : undefined,
      ),
    );
  }
  private async home(destination: Destination) {
    const groups = this.daddy.sessions();
    if (destination.chatId === this.pair()?.chatId) {
      await this.api.send(destination, daddyHome(this.locale(), groups));
      return;
    }
    const text = new TelegramText()
      .add('👨‍💻 Daddyloop', 'bold')
      .add('\n\n' + this.t('Open the topic for the session you want to continue.'));
    await this.api.send(destination, {
      ...text,
      buttons: [
        ...groups.slice(0, 15).map((group) => {
          const topic = this.room() ? this.topic(this.room()!, group.id) : undefined;
          return [
            {
              text: group.title,
              ...(topic ? { url: this.link(topic) } : { callback_data: `dad:open:${group.id}` }),
            },
          ];
        }),
        [
          {
            text: this.t('New sessions and settings'),
            url: `https://t.me/${this.username}?start=daddy`,
          },
        ],
      ],
    });
  }
  private async models(groupId: string, destination: Destination, role?: 'author' | 'reviewer') {
    const group = this.authorize(destination, groupId);
    const text = new TelegramText()
      .add('🤖 ' + this.t('Models'), 'bold')
      .add('\n\nDaddy: ')
      .add(group.reviewer.model ?? this.t('Codex configuration'), 'code')
      .add(' / ' + (group.reviewer.effort ?? this.t('Default')))
      .add('\n' + this.t('New writers') + ': ')
      .add(group.writer?.model ?? this.t('Codex configuration'), 'code')
      .add(' / ' + (group.writer?.effort ?? this.t('Default')));
    if (!role) {
      await this.api.send(destination, {
        ...text,
        buttons: [
          [
            { text: 'Daddy', callback_data: `dad:models:${groupId}:reviewer` },
            { text: this.t('New writers'), callback_data: `dad:models:${groupId}:author` },
          ],
          [{ text: this.t('Back'), callback_data: `dad:open:${groupId}` }],
        ],
      });
      return;
    }
    const models = await this.daddy.catalogue.list(true);
    this.authorize(destination, groupId);
    const buttons = models.slice(0, 30).map((model) => {
      const id = 'dad-model:' + randomBytes(12).toString('base64url');
      this.store.db.prepare('INSERT INTO bot_actions(id,data) VALUES(?,?)').run(
        id,
        JSON.stringify({
          groupId,
          role,
          model,
          chatId: destination.chatId,
          threadId: destination.threadId,
          expiresAt: new Date(Date.now() + 10 * 60000).toISOString(),
        }),
      );
      return [{ text: model.name, callback_data: id }];
    });
    await this.api.send(destination, { ...text, buttons });
  }
  private async newSession(projectId: string, destination: Destination) {
    if (destination.threadId)
      throw new Error(this.t('Create a new session from the private bot chat.'));
    const pending = this.store.setting<{ text?: string; expiresAt: string }>(
      'telegram.pendingDaddy',
    );
    if (!pending || pending.expiresAt <= now())
      throw new Error(this.t('This selection expired. Start a new session again.'));
    const text = pending && pending.expiresAt > now() ? pending.text : undefined;
    const group = this.daddy.create({
      projectId,
      title: text?.split('\n')[0].slice(0, 80),
      requirements: text,
    });
    this.store.setSetting('telegram.pendingDaddy', null);
    this.store.setSetting('telegram.currentDaddy', group.id);
    if (text) this.daddy.chat(group.id, text);
    const topic = await this.ensureTopic(group);
    await this.api.send(
      destination,
      daddyBoard(this.locale(), this.daddy.board(group.id), topic ? this.link(topic) : undefined),
    );
  }
  private async discover(destination: Destination) {
    if (destination.chatId !== this.pair()?.chatId)
      throw new Error(this.t('Manage projects in the private bot chat.'));
    const suggestions = (await this.daddy.projects.suggestions()).slice(0, 20);
    const text = new TelegramText().add('📁 ' + this.t('Projects on this server'), 'bold');
    const buttons = suggestions.map((item) => {
      const id = 'dad-project:' + randomBytes(12).toString('base64url');
      this.store.db.prepare('INSERT INTO bot_actions(id,data) VALUES(?,?)').run(
        id,
        JSON.stringify({
          ...item,
          chatId: destination.chatId,
          expiresAt: new Date(Date.now() + 10 * 60000).toISOString(),
        }),
      );
      return [{ text: item.name, callback_data: id }];
    });
    text.add(
      '\n\n' +
        this.t(
          'Choose a repository to register it. You can choose a subdirectory and base branch on the website.',
        ),
    );
    await this.api.send(destination, {
      ...text,
      buttons: [...buttons, [{ text: this.t('Back'), callback_data: 'dad:projects' }]],
    });
  }
  async callback(data: string, destination: Destination): Promise<boolean> {
    const modelAction = data.match(/^dad-model:([A-Za-z0-9_-]{16})(?::([0-9]{1,2}))?$/);
    if (modelAction) {
      const key = 'dad-model:' + modelAction[1],
        row = this.store.db.prepare('SELECT data,consumed FROM bot_actions WHERE id=?').get(key);
      if (!row || row.consumed)
        throw new Error(this.t('This model selection expired. Open Models again.'));
      const action = JSON.parse(row.data as string) as {
        groupId: string;
        role: 'author' | 'reviewer';
        model: { id: string; name: string; efforts: string[]; defaultEffort: string };
        chatId: number;
        threadId?: number;
        expiresAt: string;
      };
      if (
        action.chatId !== destination.chatId ||
        action.threadId !== destination.threadId ||
        action.expiresAt <= now()
      )
        throw new Error(this.t('This model selection expired. Open Models again.'));
      const group = this.authorize(destination, action.groupId);
      if (modelAction[2] === undefined) {
        const text = new TelegramText()
          .add(action.model.name, 'bold')
          .add('\n\n' + this.t('Reasoning effort'));
        await this.api.send(destination, {
          ...text,
          buttons: action.model.efforts.map((effort, index) => [
            { text: effort, callback_data: `${key}:${index}` },
          ]),
        });
      } else {
        const effort = action.model.efforts[Number(modelAction[2])];
        if (!effort) throw new Error('Unsupported reasoning effort');
        const profiles: AgentProfiles = {
          reviewer: group.reviewer,
          author: group.writer ?? { engine: 'codex' },
        };
        profiles[action.role] = { engine: 'codex', model: action.model.id, effort };
        await this.daddy.settings(group.id, { profiles });
        this.store.db.prepare('UPDATE bot_actions SET consumed=1 WHERE id=?').run(key);
        await this.models(group.id, destination);
      }
      return true;
    }
    if (data.startsWith('dad-project:')) {
      if (destination.chatId !== this.pair()?.chatId) throw new Error('Use the private bot chat');
      const row = this.store.db
        .prepare('SELECT data,consumed FROM bot_actions WHERE id=?')
        .get(data);
      if (!row || row.consumed)
        throw new Error(this.t('This selection expired. Open Projects again.'));
      const action = JSON.parse(row.data as string) as {
        name: string;
        path: string;
        chatId: number;
        expiresAt: string;
      };
      if (action.chatId !== destination.chatId || action.expiresAt <= now())
        throw new Error(this.t('This selection expired. Open Projects again.'));
      const project = await this.daddy.projects.register({ name: action.name, path: action.path });
      this.store.db.prepare('UPDATE bot_actions SET consumed=1 WHERE id=?').run(data);
      await this.api.send(destination, projectPicker(this.locale(), [project]));
      return true;
    }
    if (!data.startsWith('dad:')) return false;
    if (data === 'dad:workspace') {
      if (destination.chatId !== this.pair()?.chatId) throw new Error('Use the private bot chat');
      await this.setup();
      return true;
    }
    if (data === 'dad:home') {
      await this.home(destination);
      return true;
    }
    if (data === 'dad:discover') {
      await this.discover(destination);
      return true;
    }
    if (data === 'dad:new' || data === 'dad:projects') {
      if (destination.threadId)
        throw new Error(this.t('Create a new session from the private bot chat.'));
      this.store.setSetting('telegram.pendingDaddy', {
        expiresAt: new Date(Date.now() + 10 * 60000).toISOString(),
      });
      await this.api.send(destination, projectPicker(this.locale(), this.daddy.projects.list()));
      return true;
    }
    const models = data.match(/^dad:models:([a-f0-9-]{36})(?::(author|reviewer))?$/);
    if (models) {
      await this.models(models[1], destination, models[2] as 'author' | 'reviewer' | undefined);
      return true;
    }
    const match = data.match(/^dad:(new|open|add|pause|resume|pool):([a-f0-9-]{36})(?::([1-8]))?$/);
    if (!match) throw new Error('Unknown Daddy action');
    const [, action, id, limit] = match;
    if (action === 'new') {
      await this.newSession(id, destination);
      return true;
    }
    if (
      action === 'open' &&
      destination.chatId !== this.pair()?.chatId &&
      this.groupAt(destination) !== id
    ) {
      const topic = await this.ensureTopic(this.daddy.group(id));
      if (topic)
        await this.api.send(destination, {
          ...new TelegramText().add(this.daddy.group(id).title, 'bold'),
          buttons: [[{ text: this.t('Open session topic'), url: this.link(topic) }]],
        });
      return true;
    }
    const group = this.authorize(destination, id);
    if (action === 'pool') {
      if (limit) await this.daddy.settings(id, { writerLimit: Number(limit) });
      await this.api.send(destination, poolCard(this.locale(), this.daddy.group(id)));
      return true;
    }
    if (action === 'pause') await this.daddy.pause(id);
    if (action === 'resume') await this.daddy.resume(id);
    if (action === 'add') {
      if (destination.chatId === this.pair()?.chatId)
        this.store.setSetting('telegram.currentDaddy', id);
      await this.api.send(
        destination,
        this.t(
          'Send a ticket link, several tickets, or a description of the next task. Daddy will add it to this session.',
        ),
      );
      return true;
    }
    await this.show(group.id, destination);
    return true;
  }
  async handle(update: Update): Promise<boolean> {
    const pair = this.pair(),
      message = update.message,
      callback = update.callback_query;
    const chat = message?.chat ?? callback?.message?.chat,
      from = message?.from ?? callback?.from;
    if (!pair || !chat || from?.id !== pair.userId || from.is_bot) return false;
    const destination = {
      chatId: chat.id,
      threadId: message?.message_thread_id ?? callback?.message?.message_thread_id,
    };
    const privateChat = chat.type === 'private' && chat.id === pair.chatId;
    if (!privateChat && (chat.type !== 'supergroup' || this.room()?.chatId !== chat.id))
      return false;
    try {
      if (callback) {
        if (
          !callback.data?.startsWith('dad:') &&
          !callback.data?.startsWith('dad-project:') &&
          !callback.data?.startsWith('dad-model:')
        )
          return false;
        await this.api.call('answerCallbackQuery', { callback_query_id: callback.id });
        await this.callback(callback.data, destination);
        return true;
      }
      if (privateChat && message?.chat_shared) {
        await this.bind(message.chat_shared);
        return true;
      }
      const text = message?.text?.trim().replace(/^\/(\w+)@\w+(?=\s|$)/, '/$1');
      if (!text) return false;
      if (text === '/workspace' && privateChat) {
        await this.setup();
        return true;
      }
      if (['/sessions', '/tasks', '/start', '/start daddy', '/help'].includes(text)) {
        await this.home(destination);
        return true;
      }
      if (text === '/new' || text === '/projects') {
        return this.callback(text === '/new' ? 'dad:new' : 'dad:projects', destination);
      }
      const attach = text.match(/^\/attach\s+([a-f0-9-]{8,36})$/);
      if (attach && !privateChat && destination.threadId) {
        const groups = this.daddy.sessions().filter((group) => group.id.startsWith(attach[1]));
        if (groups.length !== 1) throw new Error('Choose a unique Daddy session ID');
        const existing = this.topic(this.room()!, groups[0].id);
        if (existing && existing.threadId !== destination.threadId)
          throw new Error('This session already has another topic');
        if (this.groupAt(destination) && this.groupAt(destination) !== groups[0].id)
          throw new Error('This topic belongs to another session');
        const topic = {
          ...destination,
          threadId: destination.threadId,
          groupId: groups[0].id,
          ownerId: pair.userId,
        };
        this.saveTopic(topic);
        this.store.db
          .prepare("UPDATE operations SET status='done',result=? WHERE id=? AND status='pending'")
          .run(JSON.stringify(topic), `telegram:topic:${this.key(this.room()!, groups[0].id)}`);
        await this.show(groups[0].id, destination);
        return true;
      }
      const groupId = privateChat
        ? this.store.setting<string>('telegram.currentDaddy')
        : this.groupAt(destination);
      const pool = text.match(/^\/pool(?:\s+([1-8]))?$/);
      if (text === '/models' && groupId) {
        await this.models(groupId, destination);
        return true;
      }
      if (pool && groupId) {
        return this.callback(`dad:pool:${groupId}${pool[1] ? ':' + pool[1] : ''}`, destination);
      }
      if (text === '/status' && groupId) {
        await this.show(groupId, destination);
        return true;
      }
      if (text === '/pause' && groupId) {
        await this.daddy.pause(groupId);
        await this.show(groupId, destination);
        return true;
      }
      if (text === '/resume' && groupId) {
        await this.daddy.resume(groupId);
        await this.show(groupId, destination);
        return true;
      }
      if (/^\/(author|reviewer)\b/.test(text)) {
        await this.api.send(
          destination,
          this.t('Write to Daddy here. He sends instructions to the writers.'),
        );
        return true;
      }
      if (text.startsWith('/')) return !privateChat;
      const pending = this.store.setting<{ expiresAt: string }>('telegram.pendingDaddy');
      if (privateChat && (!groupId || (pending && pending.expiresAt > now()))) {
        this.store.setSetting('telegram.pendingDaddy', {
          text,
          expiresAt: new Date(Date.now() + 10 * 60000).toISOString(),
        });
        await this.api.send(destination, projectPicker(this.locale(), this.daddy.projects.list()));
        return true;
      }
      if (!groupId) {
        await this.api.send(
          destination,
          this.t('Open a Daddy session topic, or create a new session in the private bot chat.'),
        );
        return true;
      }
      this.authorize(destination, groupId);
      this.daddy.chat(
        groupId,
        text,
        `telegram:${chat.id}:${message?.message_id ?? update.update_id}`,
      );
      return true;
    } catch (error) {
      const message =
        error instanceof AppError && error.code === 'ambiguous_write'
          ? this.t(
              'Telegram may have created the topic. Open that topic and send /attach followed by the Daddy session ID; do not create a duplicate.',
            )
          : this.t(redact((error as Error).message));
      await this.api.send(
        destination,
        new TelegramText()
          .add('⚠️ ' + this.t('Could not complete the action'), 'bold')
          .add('\n\n' + message),
      );
      return true;
    }
  }
  onEvent(event: Event): boolean {
    if (!event.type.startsWith('daddy.')) return false;
    if (event.type === 'daddy.created') {
      this.pending = this.pending
        .then(async () => {
          const room = this.room();
          if (this.stopped || !room) return;
          const group = this.daddy.group(event.taskId),
            topic = await this.ensureTopic(group);
          if (!topic) return;
          if (this.room()?.chatId !== topic.chatId || this.pair()?.userId !== topic.ownerId) return;
          const id = `telegram:daddy-intro:${room.chatId}:${group.id}`;
          if (this.store.db.prepare('SELECT 1 FROM notifications WHERE id=?').get(id)) return;
          this.store.db
            .prepare('INSERT INTO notifications VALUES(?,?,?)')
            .run(id, 'pending', now());
          await this.api.send(
            { chatId: topic.chatId, threadId: topic.threadId },
            daddyBoard(this.locale(), this.daddy.board(group.id)),
          );
          this.store.db.prepare("UPDATE notifications SET status='sent' WHERE id=?").run(id);
        })
        .catch((error) => this.store.setSetting('telegram.error', redact(String(error))));
      return true;
    }
    if (event.type !== 'daddy.message') return true;
    this.pending = this.pending
      .then(async () => {
        const pair = this.pair();
        if (this.stopped || !pair) return;
        const group = this.daddy.group(event.taskId),
          message = this.store
            .messages(group.id)
            .find((message) => message.id === (event.data as { messageId: string }).messageId);
        if (!message || message.sender === 'user') return;
        const job = message.runId
          ? this.store.daddyJobs(group.id).find((job) => job.id === message.runId)
          : undefined;
        const board = this.daddy.board(group.id),
          prefs = notificationPreferences(this.store);
        const attention =
          group.daddyState === 'needs_input' ||
          (board.tasks.length > 0 && board.tasks.every((task) => task.state === 'complete'));
        if (
          job?.trigger !== 'user' &&
          (!prefs.enabled || (prefs.mode === 'attention' && !attention))
        )
          return;
        const id = `telegram:daddy:${message.id}`;
        if (this.store.db.prepare('SELECT 1 FROM notifications WHERE id=?').get(id)) return;
        const topic = await this.ensureTopic(group);
        if (this.pair()?.userId !== pair.userId || (topic && this.room()?.chatId !== topic.chatId))
          return;
        const destination = topic
          ? { chatId: topic.chatId, threadId: topic.threadId }
          : pair.chatId;
        this.store.db.prepare('INSERT INTO notifications VALUES(?,?,?)').run(id, 'pending', now());
        const text = new TelegramText().add('👨‍💻 Daddy', 'bold').add('\n\n').markdown(message.text);
        const card: TelegramCard = {
          ...text,
          buttons: [
            [{ text: this.t('Tasks and writer pool'), callback_data: `dad:open:${group.id}` }],
          ],
        };
        await this.api.send(destination, card);
        this.store.db.prepare("UPDATE notifications SET status='sent' WHERE id=?").run(id);
      })
      .catch((error) => this.store.setSetting('telegram.error', redact(String(error))));
    return true;
  }
  replay() {
    for (const group of this.daddy.sessions()) {
      if (this.room())
        this.onEvent({ id: 0, taskId: group.id, type: 'daddy.created', data: {}, at: now() });
      const message = this.store
        .messages(group.id)
        .filter((message) => message.sender !== 'user')
        .at(-1);
      if (message)
        this.onEvent({
          id: 0,
          taskId: group.id,
          type: 'daddy.message',
          data: { messageId: message.id },
          at: now(),
        });
    }
  }
  async stop() {
    this.stopped = true;
    await this.pending;
    await Promise.allSettled([...this.topics.values()]);
  }
}
