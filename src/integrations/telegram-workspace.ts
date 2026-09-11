import { randomBytes, randomInt } from 'node:crypto';
import type { Daddy } from '../core/daddy.js';
import { AppError, now, type Event, type ReviewGroup, type AgentProfiles } from '../core/types.js';
import { redact } from '../core/security.js';
import type { TelegramApi, Update } from './telegram.js';
import { TelegramText, type TelegramCard } from './telegram-text.js';
import { daddyHome, workspacePicker, daddyBoard, poolCard } from './daddy-cards.js';
import { translator, type Locale } from '../i18n/index.js';
import { notificationPreferences } from './notifications.js';
import type { Workspace } from '../core/types.js';
import type { RepositorySelection } from '../core/workspace-registry.js';
import type { UsageBackend, ResetPlan } from '../core/usage.js';
import { usageLines, resetOutcomeText } from '../client/usage.js';
import { VoiceInbox, type VoiceRoute, type VoiceJob } from './voice-inbox.js';
import type { Speech } from '../runtime/speech.js';
import type { ResourceStatus } from '../core/types.js';
import { setLocale } from '../core/preferences.js';
import { notificationsCard } from './telegram-cards.js';
import { languageCard } from './telegram-meta.js';
type Pair = { chatId: number; userId: number };
type Room = { chatId: number; title: string; ownerId: number };
type Topic = { chatId: number; threadId: number; groupId: string; ownerId: number };
type Destination = { chatId: number; threadId?: number };
type RepoChoice = {
  destination: Destination;
  ownerId: number;
  workspace: Workspace;
  groupId?: string;
  input?: RepositorySelection;
  expiresAt: string;
  creationExpiresAt?: string;
};
export class TelegramWorkspace {
  private pending = Promise.resolve();
  private stopped = false;
  private topics = new Map<string, Promise<Topic>>();
  private voice?: VoiceInbox;
  constructor(
    readonly daddy: Daddy,
    private api: TelegramApi,
    private username: string,
    private locale: () => Locale,
    private usage?: UsageBackend,
  ) {}
  configureVoice(dataDir: string, speech: Speech, resources: () => ResourceStatus) {
    this.voice = new VoiceInbox(
      this.store,
      dataDir,
      speech,
      (id, signal) => this.api.downloadVoice(id, signal),
      (job, signal) => this.deliverVoice(job, signal),
      async (job) => {
        const pair = this.pair();
        if (!pair || pair.userId !== job.route.ownerId) return;
        const destination =
          job.route.chatId === pair.chatId || this.room()?.chatId === job.route.chatId
            ? job.route
            : pair.chatId;
        await this.api.send(
          destination,
          new TelegramText()
            .add('🎙️ ' + this.t('Voice message was not sent to daddy'), 'bold')
            .add('\n\n' + this.t(job.error ?? 'Voice recognition failed'))
            .add(job.text ? '\n\n' + job.text : ''),
        );
      },
      resources,
    );
  }
  start() {
    this.voice?.start();
    this.replay();
  }
  private voiceRoute(destination: Destination): VoiceRoute | undefined {
    const pair = this.pair();
    if (!pair) return;
    const id =
      destination.chatId === pair.chatId
        ? this.store.setting<string>('telegram.currentDaddy')
        : this.groupAt(destination);
    if (!id) return;
    const group = this.authorize(destination, id),
      next = this.store.setting<{ workspace: Workspace; expiresAt: string }>(
        this.repoKey(destination, id),
      );
    if (next && next.expiresAt <= now())
      throw new Error(this.t('This selection expired. Choose the repository again.'));
    return {
      ...destination,
      ownerId: pair.userId,
      groupId: id,
      generation: group.generation,
      workspace: next?.workspace ?? this.daddy.board(id).workspace!,
      locale: this.locale(),
    };
  }
  private async deliverVoice(job: VoiceJob, signal: AbortSignal) {
    const receipt = job.receipt;
    if (this.store.setting(`daddy.receipt:${receipt}`)) return;
    signal.throwIfAborted();
    const pair = this.pair();
    if (
      !pair ||
      pair.userId !== job.route.ownerId ||
      (job.route.chatId !== pair.chatId && this.room()?.chatId !== job.route.chatId)
    )
      throw new Error('The voice message belongs to a previous Telegram connection.');
    const group = this.authorize(job.route, job.route.groupId);
    if (group.generation !== job.route.generation)
      throw new Error(
        'The session changed while recognizing the voice. Send it again to continue.',
      );
    const text = job.fileId ? '🎙️ ' + job.text : job.text!;
    this.daddy.chat(group.id, text, receipt, job.route.workspace);
    if (job.fileId)
      await this.api
        .send(
          job.route,
          new TelegramText()
            .add('🎙️ ' + this.t('Recognized voice message'), 'bold')
            .add('\n\n' + job.text),
        )
        .catch(() => {});
  }
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
    const room = this.store.setting<Room>('telegram.group');
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
          'Create a Telegram group, enable Topics, then choose it below. Telegram can add the bot with permission to manage topics. Each daddy session will get its own topic.',
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
      throw new Error(this.t('Group selection expired. Send /group again.'));
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
      throw new Error(this.t('Group selection expired. Send /group again.'));
    const room: Room = { chatId: shared.chat_id, title: chat.title, ownerId: pair.userId };
    this.store.transaction(() => {
      this.store.setSetting('telegram.group', room);
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
      throw new AppError('wrong_topic', 'Use the topic belonging to this daddy session', 403);
    return this.daddy.group(groupId);
  }
  async show(groupId: string, destination: Destination) {
    const group = this.authorize(destination, groupId),
      topic = await this.ensureTopic(group);
    if (destination.chatId === this.pair()?.chatId)
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
    this.store.setSetting(this.creationKey(destination), null);
    const groups = this.daddy.sessions();
    if (destination.chatId === this.pair()?.chatId) {
      await this.api.send(destination, daddyHome(this.locale(), groups));
      return;
    }
    const text = new TelegramText()
      .add('👨‍💻 daddyloop', 'bold')
      .add('\n\n' + this.t('Open the topic for the session you want to continue.'));
    await this.api.send(destination, {
      ...text,
      buttons: [
        [{ text: this.t('New session'), callback_data: 'dad:new' }],
        [{ text: this.t('Workspaces'), callback_data: 'dad:workspaces' }],
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
            text: this.t('Private setup and CLI updates'),
            url: `https://t.me/${this.username}?start=daddy`,
          },
        ],
      ],
    });
  }
  private async models(groupId: string, destination: Destination, role?: 'writer' | 'daddy') {
    const group = this.authorize(destination, groupId);
    const text = new TelegramText()
      .add('🤖 ' + this.t('Models'), 'bold')
      .add('\n\nDaddy: ')
      .add(group.daddy.model ?? this.t('Codex configuration'), 'code')
      .add(' / ' + (group.daddy.effort ?? this.t('Default')))
      .add('\n' + this.t('New writers') + ': ')
      .add(group.writer?.model ?? this.t('Codex configuration'), 'code')
      .add(' / ' + (group.writer?.effort ?? this.t('Default')));
    if (!role) {
      await this.api.send(destination, {
        ...text,
        buttons: [
          [
            { text: 'daddy', callback_data: `dad:models:${groupId}:daddy` },
            { text: this.t('New writers'), callback_data: `dad:models:${groupId}:writer` },
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
  private async newSession(workspaceId: string, destination: Destination, workspace?: Workspace) {
    const pending = this.store.setting<{ text?: string; expiresAt: string }>(
      this.creationKey(destination),
    );
    if (!pending || pending.expiresAt <= now())
      throw new Error(this.t('This selection expired. Start a new session again.'));
    const text = pending && pending.expiresAt > now() ? pending.text : undefined;
    const group = this.daddy.create({
      workspaceId,
      workspace,
      title: text?.split('\n')[0].slice(0, 80),
      requirements: text,
    });
    this.store.setSetting(this.creationKey(destination), null);
    if (destination.chatId === this.pair()?.chatId)
      this.store.setSetting('telegram.currentDaddy', group.id);
    if (text) this.daddy.chat(group.id, text);
    const topic = await this.ensureTopic(group);
    if (topic && destination.chatId === topic.chatId && destination.threadId !== topic.threadId) {
      await this.api.send(destination, {
        ...new TelegramText().add(
          this.t('New session created: {title}', { title: group.title }),
          'bold',
        ),
        buttons: [[{ text: this.t('Open session topic'), url: this.link(topic) }]],
      });
      return;
    }
    await this.api.send(
      destination,
      daddyBoard(this.locale(), this.daddy.board(group.id), topic ? this.link(topic) : undefined),
    );
  }
  private repoKey(destination: Destination, groupId: string) {
    return `telegram.nextRepo:${this.pair()!.userId}:${destination.chatId}:${destination.threadId ?? 0}:${groupId}`;
  }
  private async repository(choice: RepoChoice, browse = false) {
    if (choice.groupId) this.authorize(choice.destination, choice.groupId);
    this.store.db
      .prepare(
        "DELETE FROM settings WHERE key LIKE 'telegram.repo:%' AND (value='null' OR json_extract(value,'$.expiresAt') <= ?)",
      )
      .run(now());
    const button = (text: string, next: RepoChoice, action: 'use' | 'browse') => {
      const id = randomBytes(12).toString('base64url');
      this.store.setSetting(`telegram.repo:${id}`, next);
      return { text, callback_data: `dad:repo:${id}:${action}` };
    };
    const title = new TelegramText()
      .add('📁 ' + this.t('Repository for this request'), 'bold')
      .add('\n\n' + choice.workspace.name)
      .add(
        '\n' +
          (choice.input?.path ??
            choice.workspace.repoPath +
              (choice.workspace.scope ? '/' + choice.workspace.scope : '')),
        'code',
      )
      .add(
        '\n\n' +
          this.t(
            'This selection applies only to this request. Workspace defaults and existing tasks stay as saved.',
          ),
      );
    const buttons = [
      [
        button(
          this.t(
            choice.groupId
              ? choice.input
                ? 'Use this folder once'
                : 'Use workspace defaults'
              : 'Start session',
          ),
          choice,
          'use',
        ),
      ],
      ...(choice.input
        ? [[button(this.t('Use workspace defaults'), { ...choice, input: undefined }, 'use')]]
        : []),
    ];
    if (browse) {
      const listing = await this.daddy.workspaces.browse(
        choice.input?.path ?? choice.workspace.repoPath,
      );
      if (listing.parent)
        buttons.push([
          button(
            '↑ ' + this.t('Parent folder'),
            { ...choice, input: { path: listing.parent } },
            'browse',
          ),
        ]);
      for (const entry of listing.directories.slice(0, 30))
        buttons.push([
          button(entry.name + ' →', { ...choice, input: { path: entry.path } }, 'browse'),
        ]);
      title.add('\n\n' + this.t('You can also send /repo followed by an absolute server path.'));
    } else buttons.push([button(this.t('Browse server folders'), choice, 'browse')]);
    await this.api.send(choice.destination, { ...title, buttons });
  }
  private async repositoryCallback(data: string, destination: Destination) {
    const match = data.match(/^dad:repo:([A-Za-z0-9_-]+):(use|browse)$/);
    if (!match) return false;
    const key = `telegram.repo:${match[1]}`,
      choice = this.store.setting<RepoChoice>(key);
    if (
      !choice ||
      choice.expiresAt <= now() ||
      choice.ownerId !== this.pair()?.userId ||
      choice.destination.chatId !== destination.chatId ||
      choice.destination.threadId !== destination.threadId
    )
      throw new Error(this.t('This selection expired. Choose the repository again.'));
    if (choice.groupId) this.authorize(destination, choice.groupId);
    else if (
      !choice.creationExpiresAt ||
      this.store.setting<{ expiresAt: string }>(this.creationKey(destination))?.expiresAt !==
        choice.creationExpiresAt
    )
      throw new Error(this.t('This selection expired. Start a new session again.'));
    if (match[2] === 'browse') await this.repository(choice, true);
    else {
      const selected = await this.daddy.workspaces.selection(choice.workspace, choice.input);
      if (choice.groupId) {
        this.store.setSetting(this.repoKey(destination, choice.groupId), {
          workspace: selected,
          expiresAt: choice.expiresAt,
        });
        await this.api.send(
          destination,
          new TelegramText()
            .add('📁 ' + this.t('Repository for next task'), 'bold')
            .add('\n\n' + selected.repoPath + (selected.scope ? '/' + selected.scope : ''), 'code')
            .add(
              '\n\n' +
                this.t('Send the task now. The following message will use the defaults again.'),
            ),
        );
      } else await this.newSession(choice.workspace.id, destination, selected);
      this.store.setSetting(key, null);
    }
    return true;
  }
  private async discover(destination: Destination) {
    const suggestions = (await this.daddy.workspaces.suggestions()).slice(0, 20);
    const text = new TelegramText().add('📁 ' + this.t('Workspaces on this server'), 'bold');
    const buttons = suggestions.map((item) => {
      const id = 'dad-workspace:' + randomBytes(12).toString('base64url');
      this.store.db.prepare('INSERT INTO bot_actions(id,data) VALUES(?,?)').run(
        id,
        JSON.stringify({
          ...item,
          chatId: destination.chatId,
          threadId: destination.threadId,
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
      buttons: [...buttons, [{ text: this.t('Back'), callback_data: 'dad:workspaces' }]],
    });
  }
  private async limits(destination: Destination, data = 'dad:limits') {
    if (!this.usage) throw new Error(this.t('Usage controls are unavailable on this server.'));
    const match = data.match(/^dad:limits(?::(refresh|prepare|consume)(?::([a-f0-9-]{36}))?)?$/);
    if (!match) throw new Error('Unknown limits action');
    const owner = `telegram:${this.pair()!.userId}:${destination.chatId}:${destination.threadId ?? 0}`;
    if (match[1] === 'prepare') {
      const plan = await this.usage.prepare(owner);
      await this.api.send(destination, {
        ...new TelegramText()
          .add('↻ ' + this.t('Use a reset'), 'bold')
          .add('\n\n' + this.t(plan.title))
          .add('\n' + this.t('Available resets: {count}', { count: plan.availableCount }))
          .add(
            '\n\n' +
              this.t(
                'Use one available reset for the Codex account on this server? Existing conversations and files are kept.',
              ),
          )
          .add(
            '\n\n' +
              this.t(
                'If the response is lost, retry this same operation. It will not spend a second reset.',
              ),
          ),
        buttons: [
          [
            {
              text: this.t('Confirm: use one reset'),
              callback_data: `dad:limits:consume:${plan.id}`,
            },
          ],
          [{ text: this.t('Cancel'), callback_data: 'dad:limits' }],
        ],
      });
      return;
    }
    let result: { plan: ResetPlan; usage: Awaited<ReturnType<UsageBackend['read']>> } | undefined;
    if (match[1] === 'consume') {
      if (!match[2]) throw new Error('Reset request not found.');
      result = await this.usage.consume(match[2], owner);
    }
    const usage = result?.usage ?? (await this.usage.read(true));
    const text = new TelegramText().add('📊 ' + this.t('Codex limits'), 'bold');
    if (result?.plan.outcome) text.add('\n\n' + this.t(resetOutcomeText[result.plan.outcome]));
    text.add('\n\n' + usageLines(usage, this.locale()).join('\n'));
    await this.api.send(destination, {
      ...text,
      buttons: [
        ...(usage.resets.canUse
          ? [
              [
                {
                  text: this.t(usage.resets.pending ? 'Resolve pending reset' : 'Use a reset'),
                  callback_data: 'dad:limits:prepare',
                },
              ],
            ]
          : []),
        [{ text: this.t('Refresh limits'), callback_data: 'dad:limits:refresh' }],
      ],
    });
  }
  private creationKey(destination: Destination) {
    const pair = this.pair()!,
      key = `telegram.newSession:${pair.userId}:${destination.chatId}:${destination.threadId ?? 0}`;
    return key;
  }
  async callback(data: string, destination: Destination): Promise<boolean> {
    const language = data.match(/^language:(en|ru|show)$/);
    if (language) {
      if (language[1] !== 'show') setLocale(this.store, language[1] as 'en' | 'ru');
      await this.api.send(destination, languageCard(this.locale()));
      return true;
    }
    const notification = data.match(/^notifications:(show|on|off|all)$/);
    if (notification) {
      const before = notificationPreferences(this.store);
      const value =
        notification[1] === 'show'
          ? before
          : {
              enabled: notification[1] !== 'off',
              mode: notification[1] === 'all' ? ('all' as const) : ('attention' as const),
            };
      if (notification[1] !== 'show') this.store.setSetting('notifications.telegram', value);
      await this.api.send(destination, notificationsCard(value, this.locale()));
      return true;
    }
    if (data.startsWith('dad:limits')) {
      await this.limits(destination, data);
      return true;
    }
    if (await this.repositoryCallback(data, destination)) return true;
    const repo = data.match(/^dad:repository:([a-f0-9-]{36})$/);
    if (repo) {
      this.authorize(destination, repo[1]);
      await this.repository({
        destination,
        ownerId: this.pair()!.userId,
        groupId: repo[1],
        workspace: this.daddy.board(repo[1]).workspace!,
        expiresAt: new Date(Date.now() + 10 * 60000).toISOString(),
      });
      return true;
    }
    const modelAction = data.match(/^dad-model:([A-Za-z0-9_-]{16})(?::([0-9]{1,2}))?$/);
    if (modelAction) {
      const key = 'dad-model:' + modelAction[1],
        row = this.store.db.prepare('SELECT data,consumed FROM bot_actions WHERE id=?').get(key);
      if (!row || row.consumed)
        throw new Error(this.t('This model selection expired. Open Models again.'));
      const action = JSON.parse(row.data as string) as {
        groupId: string;
        role: 'writer' | 'daddy';
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
          daddy: group.daddy,
          writer: group.writer ?? { engine: 'codex' },
        };
        profiles[action.role] = { engine: 'codex', model: action.model.id, effort };
        await this.daddy.settings(group.id, { profiles });
        this.store.db.prepare('UPDATE bot_actions SET consumed=1 WHERE id=?').run(key);
        await this.models(group.id, destination);
      }
      return true;
    }
    if (data.startsWith('dad-workspace:')) {
      const row = this.store.db
        .prepare('SELECT data,consumed FROM bot_actions WHERE id=?')
        .get(data);
      if (!row || row.consumed)
        throw new Error(this.t('This selection expired. Open Workspaces again.'));
      const action = JSON.parse(row.data as string) as {
        name: string;
        path: string;
        chatId: number;
        threadId?: number;
        expiresAt: string;
      };
      if (
        action.chatId !== destination.chatId ||
        action.threadId !== destination.threadId ||
        action.expiresAt <= now()
      )
        throw new Error(this.t('This selection expired. Open Workspaces again.'));
      const workspace = await this.daddy.workspaces.register({
        name: action.name,
        path: action.path,
      });
      this.store.db.prepare('UPDATE bot_actions SET consumed=1 WHERE id=?').run(data);
      await this.api.send(destination, workspacePicker(this.locale(), [workspace]));
      return true;
    }
    if (!data.startsWith('dad:')) return false;
    if (data === 'dad:group') {
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
    if (data === 'dad:new' || data === 'dad:workspaces') {
      if (data === 'dad:new')
        this.store.setSetting(this.creationKey(destination), {
          expiresAt: new Date(Date.now() + 10 * 60000).toISOString(),
        });
      await this.api.send(
        destination,
        workspacePicker(this.locale(), this.daddy.workspaces.list()),
      );
      return true;
    }
    const models = data.match(/^dad:models:([a-f0-9-]{36})(?::(writer|daddy))?$/);
    if (models) {
      await this.models(models[1], destination, models[2] as 'writer' | 'daddy' | undefined);
      return true;
    }
    const match = data.match(/^dad:(new|open|add|pause|resume|pool):([a-f0-9-]{36})(?::([1-8]))?$/);
    if (!match) throw new Error('Unknown daddy action');
    const [, action, id, limit] = match;
    if (action === 'new') {
      const prior = this.store.setting<{ expiresAt: string }>(this.creationKey(destination));
      const pending =
        prior && prior.expiresAt > now()
          ? prior
          : { expiresAt: new Date(Date.now() + 10 * 60000).toISOString() };
      this.store.setSetting(this.creationKey(destination), { ...pending, workspaceId: id });
      await this.repository({
        destination,
        workspace: this.daddy.workspaces.get(id),
        ownerId: this.pair()!.userId,
        expiresAt: pending.expiresAt,
        creationExpiresAt: pending.expiresAt,
      });
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
      await this.api.send(destination, poolCard(this.locale(), this.daddy.board(id)));
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
          'Send a ticket link, several tickets, or a description of the next task. daddy will add it to this session.',
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
          !callback.data?.startsWith('dad-workspace:') &&
          !callback.data?.startsWith('dad-model:') &&
          !callback.data?.startsWith('notifications:') &&
          !callback.data?.startsWith('language:')
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
      if (message?.voice) {
        if (!this.voice)
          throw new Error(this.t('Voice recognition is unavailable on this server.'));
        const pending = this.store.setting<{ expiresAt: string }>(this.creationKey(destination));
        const route = this.voiceRoute(destination);
        if (!route || (pending && pending.expiresAt > now()))
          throw new Error(
            this.t('Start a daddy session in a workspace, then send the voice message.'),
          );
        if (message.voice.duration > 300 || (message.voice.file_size ?? 0) > 10 * 1024 * 1024)
          throw new Error(this.t('Voice messages can be at most 5 minutes and 10 MB.'));
        if (['paused', 'archived'].includes(this.daddy.group(route.groupId).daddyState ?? ''))
          throw new Error(this.t('Resume daddy before sending another message'));
        const created = this.store.transaction(() => {
          const created = this.voice!.enqueue(
            `telegram:${chat.id}:${message.message_id ?? update.update_id}`,
            route,
            { fileId: message.voice!.file_id, duration: message.voice!.duration },
          );
          if (created) this.store.setSetting(this.repoKey(destination, route.groupId), null);
          return created;
        });
        if (!created) return true;
        await this.api
          .send(
            destination,
            this.t('Voice message queued. Recognition language: {language}.', {
              language: route.locale === 'ru' ? 'русский' : 'English',
            }),
          )
          .catch((error) => this.store.setSetting('telegram.error', redact(String(error))));
        return true;
      }
      const text = message?.text?.trim().replace(/^\/(\w+)@\w+(?=\s|$)/, '/$1');
      if (!text) return false;
      if (text === '/language') return await this.callback('language:show', destination);
      const language = text.match(/^\/language\s+(en|ru)$/);
      if (language) {
        setLocale(this.store, language[1] as 'en' | 'ru');
        await this.api.send(destination, this.t('Language updated.'));
        return true;
      }
      if (text === '/notifications') return await this.callback('notifications:show', destination);
      if (text === '/updates' && !privateChat) {
        await this.api.send(destination, {
          ...new TelegramText().add(this.t('Open the private bot chat for CLI updates.')),
          buttons: [[{ text: this.t('Open private chat'), url: `https://t.me/${this.username}` }]],
        });
        return true;
      }
      if (text === '/group' && !privateChat) {
        await this.api.send(
          destination,
          this.t('Send /group in the private bot chat to connect a Telegram group.'),
        );
        return true;
      }
      if (text === '/limits') {
        await this.limits(destination);
        return true;
      }
      if (text === '/group' && privateChat) {
        await this.setup();
        return true;
      }
      if (['/sessions', '/start', '/start daddy', '/help'].includes(text)) {
        await this.home(destination);
        return true;
      }
      if (/^\/new(?:\s|$)/.test(text) || text === '/workspaces') {
        if (text.startsWith('/new')) {
          this.store.setSetting(this.creationKey(destination), {
            text: text.slice(4).trim() || undefined,
            expiresAt: new Date(Date.now() + 10 * 60000).toISOString(),
          });
          await this.api.send(
            destination,
            workspacePicker(this.locale(), this.daddy.workspaces.list()),
          );
          return true;
        }
        return this.callback('dad:workspaces', destination);
      }
      const attach = text.match(/^\/attach\s+([a-f0-9-]{8,36})$/);
      if (attach && !privateChat && destination.threadId) {
        const groups = this.daddy.sessions().filter((group) => group.id.startsWith(attach[1]));
        if (groups.length !== 1) throw new Error('Choose a unique daddy session ID');
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
      const repo = text.match(/^\/repo(?:\s+(.+))?$/);
      if (repo) {
        const pending = this.store.setting<{ workspaceId?: string; expiresAt: string }>(
          this.creationKey(destination),
        );
        const creating = pending && pending.expiresAt > now() && pending.workspaceId;
        if (repo[1] === 'default' && groupId && !creating) {
          this.authorize(destination, groupId);
          this.store.setSetting(this.repoKey(destination, groupId), null);
          await this.api.send(destination, this.t('Using workspace defaults'));
          return true;
        }
        if (!creating && !groupId) throw new Error(this.t('Start a daddy session first.'));
        if (!creating) this.authorize(destination, groupId!);
        await this.repository({
          destination,
          ownerId: pair.userId,
          groupId: creating ? undefined : groupId,
          workspace: creating
            ? this.daddy.workspaces.get(creating)
            : this.daddy.board(groupId!).workspace!,
          input: repo[1] && repo[1] !== 'default' ? { path: repo[1] } : undefined,
          creationExpiresAt: creating ? pending!.expiresAt : undefined,
          expiresAt: new Date(Date.now() + 10 * 60000).toISOString(),
        });
        return true;
      }
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
          this.t('Write to daddy here. He sends instructions to the writers.'),
        );
        return true;
      }
      if (text.startsWith('/')) return !privateChat;
      const pending = this.store.setting<{ expiresAt: string }>(this.creationKey(destination));
      if ((!groupId && privateChat) || (pending && pending.expiresAt > now())) {
        this.store.setSetting(this.creationKey(destination), {
          text,
          expiresAt: new Date(Date.now() + 10 * 60000).toISOString(),
        });
        await this.api.send(
          destination,
          workspacePicker(this.locale(), this.daddy.workspaces.list()),
        );
        return true;
      }
      if (!groupId) {
        await this.api.send(
          destination,
          this.t('Open a session topic, or send /new here to create one.'),
        );
        return true;
      }
      this.authorize(destination, groupId);
      const route = this.voiceRoute(destination);
      if (route && this.voice?.pending(route)) {
        this.store.transaction(() => {
          if (
            this.voice!.enqueue(
              `telegram:${chat.id}:${message?.message_id ?? update.update_id}`,
              route,
              { text },
            )
          )
            this.store.setSetting(this.repoKey(destination, groupId), null);
        });
        return true;
      }
      const receipt = `telegram:${chat.id}:${message?.message_id ?? update.update_id}`;
      if (this.store.setting(`daddy.receipt:${receipt}`)) return true;
      const nextKey = this.repoKey(destination, groupId),
        next = this.store.setting<{ workspace: Workspace; expiresAt: string }>(nextKey);
      if (next && next.expiresAt <= now()) {
        this.store.setSetting(nextKey, null);
        throw new Error(this.t('This selection expired. Choose the repository again.'));
      }
      this.daddy.chat(groupId, text, receipt, next?.workspace);
      if (next) this.store.setSetting(nextKey, null);
      return true;
    } catch (error) {
      const message =
        error instanceof AppError && error.code === 'ambiguous_write'
          ? this.t(
              'Telegram may have created the topic. Open that topic and send /attach followed by the daddy session ID; do not create a duplicate.',
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
  private async announceChild(group: ReviewGroup, topic?: Topic) {
    const pair = this.pair();
    if (!pair || !group.parentGroupId) return;
    const id = `telegram:child-session:${group.id}`;
    if (this.store.db.prepare('SELECT 1 FROM notifications WHERE id=?').get(id)) return;
    const parent = this.room()
      ? await this.ensureTopic(this.daddy.group(group.parentGroupId))
      : undefined;
    const destination = parent ? { chatId: parent.chatId, threadId: parent.threadId } : pair.chatId;
    if (this.pair()?.userId !== pair.userId || (parent && this.room()?.chatId !== parent.chatId))
      return;
    this.store.db.prepare('INSERT INTO notifications VALUES(?,?,?)').run(id, 'pending', now());
    await this.api.send(destination, {
      ...new TelegramText().add(
        this.t('New session created: {title}', { title: group.title }),
        'bold',
      ),
      buttons: [
        [
          topic
            ? { text: this.t('Open session topic'), url: this.link(topic) }
            : { text: this.t('Open session'), callback_data: `dad:open:${group.id}` },
        ],
      ],
    });
    this.store.db.prepare("UPDATE notifications SET status='sent' WHERE id=?").run(id);
  }
  onEvent(event: Event): boolean {
    if (!event.type.startsWith('daddy.')) return false;
    if (event.type === 'daddy.created') {
      this.pending = this.pending
        .then(async () => {
          const room = this.room();
          if (this.stopped) return;
          const group = this.daddy.group(event.taskId),
            topic = await this.ensureTopic(group);
          await this.announceChild(group, topic);
          if (!topic || !room) return;
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
        const text = new TelegramText().add('👨‍💻 daddy', 'bold').add('\n\n').markdown(message.text);
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
    await this.voice?.stop();
    await this.pending;
    await Promise.allSettled([...this.topics.values()]);
  }
}
