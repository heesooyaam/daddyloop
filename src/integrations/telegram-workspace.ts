import { commandHelp } from './telegram-commands.js';
import { githubWait } from '../providers/github-quota.js';
import { randomBytes, randomInt } from 'node:crypto';
import type { Daddy } from '../core/daddy.js';
import {
  sameAgentProfile,
  AppError,
  now,
  type Event,
  type ReviewGroup,
  type Task,
} from '../core/types.js';
import { redact } from '../core/security.js';
import type { TelegramApi, Update } from './telegram.js';
import { TelegramText, safeLink } from './telegram-text.js';
import {
  daddyHome,
  workspacePicker,
  daddyBoard,
  poolCard,
  botSettings,
  sessionSettings,
} from './daddy-cards.js';
import { TelegramProgress } from './telegram-progress.js';
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
import { instructionCommand, instructionLines } from '../client/instructions.js';
import { InstructionSources } from '../ops/instruction-sources.js';
import { InstructionPresets } from '../core/instruction-presets.js';
import { findPreset, selectPreset, presetLines } from '../client/presets.js';
import { isGitAddress, parseGitSource } from '../modules/repositories/git-source.js';
import { clipTitle } from '../core/session-title.js';
import { moduleCatalogue } from '../modules/catalogue.js';
import { deliveryStatus } from './telegram-delivery.js';
import { autoMergeSettings, githubActivityStatus } from '../core/auto-merge.js';
import { draftInspectionRequired, taskReference } from '../core/task-activity.js';
import { workerSlots } from '../core/worker-pool.js';
import { profileText, taskActivity } from '../core/task-activity.js';
import {
  parseTaskInput,
  parseWorkerInput,
  queueCard,
  queuedTaskCard,
  taskCard,
  taskCommands,
  taskReferenceId,
  workersCard,
} from './telegram-tasks.js';
type Pair = { chatId: number; userId: number; ownerLabel?: string };
type Room = { chatId: number; title: string; ownerId: number };
type Topic = { chatId: number; threadId: number; groupId: string; ownerId: number; title?: string };
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
  private retryTimer?: NodeJS.Timeout;
  private progress: TelegramProgress;
  constructor(
    readonly daddy: Daddy,
    private api: TelegramApi,
    private username: string,
    private locale: () => Locale,
    private usage?: UsageBackend,
  ) {
    this.progress = new TelegramProgress(
      daddy.engine.store,
      api,
      `telegram.progress:${username}:`,
      locale,
      (groupId, previous) => {
        const pair = this.pair();
        if (!pair) return;
        const room = this.room();
        if (room) return this.topic(room, groupId);
        if (
          this.store.setting<string>('telegram.currentDaddy') === groupId ||
          (previous?.ownerId === pair.userId && previous.chatId === pair.chatId)
        )
          return { chatId: pair.chatId, ownerId: pair.userId };
      },
    );
  }
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
    this.progress.start();
    this.retryTimer = setInterval(() => {
      for (const row of this.store.db
        .prepare("SELECT key,value FROM settings WHERE key LIKE 'telegram.eventRetry:%'")
        .all()) {
        const retry = JSON.parse(String(row.value)) as { groupId: string; nextAt: number } | null;
        if (!retry || retry.nextAt > Date.now() || this.stopped) continue;
        this.store.setSetting(String(row.key), { ...retry, nextAt: Date.now() + 60000 });
        const group = this.daddy.sessions().find((group) => group.id === retry.groupId);
        if (group) this.replayGroup(group, true);
      }
    }, 1000);
    this.retryTimer.unref();
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
    this.daddy.chat(group.id, text, receipt, job.route.workspace, {
      channel: 'telegram',
      chatId: job.route.chatId,
      threadId: job.route.threadId,
    });
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
    if (existing) {
      const title = clipTitle(group.title);
      if (existing.title !== title) {
        if (this.api.delivery) {
          const result = await this.api.delivery.send(existing, new TelegramText().add(title), {
            key: `topic-name:${existing.threadId}`,
            operation: 'renameTopic',
            replace: true,
            order: group.updatedAt,
          });
          if (result.status !== 'sent') return existing;
        } else {
          try {
            await this.api.call('editForumTopic', {
              chat_id: existing.chatId,
              message_thread_id: existing.threadId,
              name: title,
            });
          } catch (error) {
            if (!/topic[_ ](?:is[_ ])?not[_ ]modified/i.test(String(error))) throw error;
          }
        }
        existing.title = title;
        this.saveTopic(existing);
      }
      return existing;
    }
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
            name: clipTitle(group.title),
          });
          if (!Number.isSafeInteger(value.message_thread_id) || value.message_thread_id <= 0)
            throw new Error('Telegram returned an invalid topic ID');
          const topic = {
            chatId: room.chatId,
            threadId: value.message_thread_id,
            groupId: group.id,
            ownerId: room.ownerId,
            title: clipTitle(group.title),
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
      can_pin_messages: true,
    };
    await this.api.call('sendMessage', {
      chat_id: pair.chatId,
      text:
        this.t(
          'Create a Telegram group, enable Topics, then choose it below. The bot needs permission to manage topics and pin messages.',
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
    if (destination.chatId === this.pair()?.chatId) {
      this.store.setSetting('telegram.currentDaddy', group.id);
      this.store.setSetting(this.creationKey(destination), null);
    }
    await this.progress.ensure(group.id);
    await this.api.send(
      destination,
      daddyBoard(
        this.locale(),
        this.daddy.board(group.id),
        destination.chatId === this.pair()?.chatId && topic ? this.link(topic) : undefined,
      ),
    );
  }
  private async showStatus(groupId: string, destination: Destination) {
    const group = this.authorize(destination, groupId);
    await this.api.send(destination, {
      ...this.progress.card(group),
      buttons: [[{ text: this.t('Back'), callback_data: `dad:open:${group.id}` }]],
    });
  }
  private async showTasks(groupId: string, destination: Destination, view: 'queue' | 'workers') {
    const group = this.authorize(destination, groupId);
    const slots = workerSlots(this.store, group);
    const tasks = taskActivity(
      this.store.tasks(groupId).reverse(),
      this.store.activeJobs(),
      (task) =>
        githubActivityStatus(
          task,
          autoMergeSettings(this.store, group, task),
          githubWait(this.store, task.ref),
        ),
      slots,
    );
    const locale = this.locale();
    await this.api.send(
      destination,
      view === 'queue'
        ? queueCard(locale, groupId, tasks)
        : workersCard(
            locale,
            groupId,
            slots,
            tasks,
            group.worker ?? this.daddy.engine.defaultAgents().worker,
          ),
    );
  }
  private async showTask(groupId: string, taskId: string, destination: Destination) {
    const group = this.authorize(destination, groupId);
    const task = this.daddy.task(groupId, taskId);
    const slots = workerSlots(this.store, group);
    const [activity] = taskActivity(
      [task],
      this.store.activeJobs(taskId),
      (t) =>
        githubActivityStatus(
          t,
          autoMergeSettings(this.store, group, t),
          githubWait(this.store, t.ref),
        ),
      slots,
    );
    const slot = slots.find((item) => item.taskId === taskId);
    const merge =
      group.workspace?.provider === 'github' && task.ref.provider === 'github'
        ? autoMergeSettings(this.store, group, task)
        : undefined;
    await this.api.send(destination, taskCard(this.locale(), activity!, slot, merge));
  }
  private async taskCommand(
    command: string,
    args: string,
    groupId: string,
    destination: Destination,
    receipt: string,
  ) {
    const group = this.authorize(destination, groupId);
    const defaults = group.worker ?? this.daddy.engine.defaultAgents().worker;
    if (command === 'queue' || command === 'workers') {
      await this.showTasks(groupId, destination, command);
      return;
    }
    if (command === 'worker') {
      const input = parseWorkerInput(args);
      if (!input) {
        await this.api.send(
          destination,
          this.t('Use /worker NUMBER MODEL [EFFORT] [--force]. See /workers and /models.'),
        );
        return;
      }
      const slot = workerSlots(this.store, group).find((item) => item.number === input.number);
      if (!slot) throw new AppError('unknown_worker', 'Choose a worker from this session', 422);
      const profile = {
        engine: input.engine ?? slot.profile?.engine ?? defaults.engine,
        model: input.model,
        effort: input.effort,
      };
      const result = await this.daddy.configureWorker(groupId, input.number, profile, {
        force: input.force,
      });
      await this.api.send(
        destination,
        this.t(
          result.restarted
            ? 'Worker {number} will resume the task · {profile}'
            : 'Worker {number} model saved · {profile}',
          { number: input.number, profile: profileText(profile) },
        ),
        undefined,
        { key: receipt },
      );
      return;
    }
    const reference = taskReferenceId(args);
    if (reference) {
      const tasks = this.store.tasks(groupId).filter((task) => task.id.startsWith(reference));
      if (tasks.length > 1)
        throw new AppError(
          'ambiguous_task',
          'This ID matches multiple tasks. Open a task from /queue.',
          409,
        );
      if (!tasks[0]) throw new AppError('not_found', 'Task not found in this session', 404);
      await this.showTask(groupId, tasks[0].id, destination);
      return;
    }
    const request = parseTaskInput(args, defaults.engine);
    if (!request) {
      await this.api.send(
        destination,
        this.t(
          'Use /task DESCRIPTION to queue work or /task DADDY-ID to check it. To choose a worker and model, send /task --worker NUMBER --model MODEL --effort EFFORT -- DESCRIPTION.',
        ),
      );
      return;
    }
    const nextKey = this.repoKey(destination, groupId);
    const next = this.store.setting<{ workspace: Workspace; expiresAt: string }>(nextKey);
    if (next && next.expiresAt <= now()) {
      this.store.setSetting(nextKey, null);
      throw new Error(this.t('This selection expired. Choose the repository again.'));
    }
    const task = await this.daddy.createTask(groupId, {
      ...request,
      requestId: receipt,
      workspace: next?.workspace,
    });
    if (next) this.store.setSetting(nextKey, null);
    await this.api.send(destination, queuedTaskCard(this.locale(), task), undefined, {
      key: receipt,
    });
  }
  private sessionBoard(groupId: string, destination: Destination, link?: string) {
    const board = this.daddy.board(groupId);
    const id = `telegram:daddy-intro:${destination.chatId}:${groupId}`;
    return this.api.send(destination, daddyBoard(this.locale(), board, link), undefined, {
      key: id,
      replace: true,
      order: board.group.updatedAt,
      notificationId: id,
    });
  }
  private async home(destination: Destination) {
    this.store.setSetting(this.creationKey(destination), null);
    const groups = this.daddy.sessions();
    if (destination.chatId === this.pair()?.chatId) {
      await this.api.send(
        destination,
        daddyHome(this.locale(), groups, this.store.setting<string>('telegram.currentDaddy')),
      );
      return;
    }
    const text = new TelegramText()
      .add('👨‍💻 daddyloop', 'bold')
      .add('\n\n' + this.t('Open the topic for the session you want to continue.'));
    await this.api.send(destination, {
      ...text,
      buttons: [
        [{ text: this.t('New task'), callback_data: 'dad:new' }],
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
            text: this.t('Settings'),
            url: `https://t.me/${this.username}?start=daddy`,
          },
        ],
      ],
    });
  }
  private async models(groupId: string, destination: Destination, role?: 'worker' | 'daddy') {
    const group = this.authorize(destination, groupId);
    const defaults = group.worker ?? this.daddy.engine.defaultAgents().worker;
    const text = new TelegramText()
      .add('🤖 ' + this.t('Models'), 'bold')
      .add('\n\ndaddy: ')
      .add(group.daddy.model ?? this.t('Engine configuration'), 'code')
      .add(' / ' + (group.daddy.effort ?? this.t('Default')))
      .add('\n' + this.t('All workers') + ': ')
      .add(defaults.model ?? this.t('Engine configuration'), 'code')
      .add(' / ' + (defaults.effort ?? this.t('Default')));
    for (const slot of workerSlots(this.store, group)) {
      if (slot.profile && !sameAgentProfile(slot.profile, defaults))
        text.add(
          '\n' +
            this.t('Worker {number}', { number: slot.number }) +
            ' · ' +
            profileText(slot.profile),
        );
    }
    if (!role) {
      await this.api.send(destination, {
        ...text,
        buttons: [
          [
            { text: 'daddy', callback_data: `dad:models:${groupId}:daddy` },
            { text: this.t('All workers'), callback_data: `dad:models:${groupId}:worker` },
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
      return [{ text: model.engine + ' · ' + model.name, callback_data: id }];
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
      requirements: text,
    });
    this.store.setSetting(this.creationKey(destination), null);
    if (destination.chatId === this.pair()?.chatId)
      this.store.setSetting('telegram.currentDaddy', group.id);
    if (text)
      this.daddy.chat(group.id, text, undefined, undefined, {
        channel: 'telegram',
        ...destination,
      });
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
    await this.progress.ensure(group.id);
    await this.sessionBoard(group.id, destination, topic ? this.link(topic) : undefined);
  }
  private repoKey(destination: Destination, groupId: string) {
    return `telegram.nextRepo:${this.pair()!.userId}:${destination.chatId}:${destination.threadId ?? 0}:${groupId}`;
  }
  private registrationKey(destination: Destination) {
    return `telegram.addWorkspace:${this.pair()!.userId}:${destination.chatId}:${destination.threadId ?? 0}`;
  }
  private async repository(choice: RepoChoice, browse = false, copies = false) {
    if (choice.groupId) this.authorize(choice.destination, choice.groupId);
    this.store.db
      .prepare(
        "DELETE FROM settings WHERE key LIKE 'telegram.repo:%' AND (value='null' OR json_extract(value,'$.expiresAt') <= ?)",
      )
      .run(now());
    const button = (
      text: string,
      next: RepoChoice,
      action: 'use' | 'browse' | 'mode' | 'copies' | 'show',
    ) => {
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
    if (!choice.groupId && choice.workspace.vcs === 'arcadia' && choice.workspace.copyMode) {
      const mode = choice.input?.copyMode ?? choice.workspace.copyMode;
      title.add(
        '\n\n' +
          this.t(
            mode === 'session'
              ? 'The service will create copies for this session and remove them when it is deleted.'
              : 'This session will use the existing Arc pool. Pool copies are kept.',
          ),
      );
      if (copies) {
        await this.api.send(choice.destination, {
          ...new TelegramText()
            .add('⚙️ ' + this.t('Working copy settings'), 'bold')
            .add(
              '\n\n' +
                this.t(
                  'Automatic: daddy creates separate working folders for this session and removes them after saving results when you delete it.',
                ),
            )
            .add(
              '\n\n' +
                this.t(
                  'Prepared copies: an administrator must provide free Arcadia checkouts on this server. Use this only if you manage that pool yourself.',
                ),
            ),
          buttons: [
            [
              button(
                (mode === 'session' ? '✓ ' : '') +
                  this.t('Create copies automatically (recommended)'),
                { ...choice, input: { ...choice.input, copyMode: 'session' } },
                'mode',
              ),
            ],
            [
              button(
                (mode === 'pool' ? '✓ ' : '') + this.t('Use prepared server copies'),
                { ...choice, input: { ...choice.input, copyMode: 'pool' } },
                'mode',
              ),
            ],
            [button(this.t('Back'), choice, 'show')],
          ],
        });
        return;
      }
    }
    if (browse) {
      const source = choice.input?.path ?? choice.workspace.repoPath;
      const listing = await this.daddy.workspaces.browse(isGitAddress(source) ? undefined : source);
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
      title.add(
        '\n\n' + this.t('You can also send /repo followed by a repository URL or server path.'),
      );
    } else buttons.push([button(this.t('Browse server folders'), choice, 'browse')]);
    if (!choice.groupId && choice.workspace.vcs === 'arcadia')
      buttons.push([button('⚙️ ' + this.t('Working copy settings'), choice, 'copies')]);
    await this.api.send(choice.destination, { ...title, buttons });
  }
  private async repositoryCallback(data: string, destination: Destination) {
    const match = data.match(/^dad:repo:([A-Za-z0-9_-]+):(use|browse|mode|copies|show)$/);
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
    if (match[2] !== 'use')
      await this.repository(choice, match[2] === 'browse', match[2] === 'copies');
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
  private async modules(destination: Destination) {
    const enabled = new Set([
      ...this.daddy.workspaces.modules().map((module) => module.id),
      ...(this.daddy.catalogue.engines?.().map((engine) => engine.id) ?? []),
    ]);
    const text = new TelegramText().add('🧩 ' + this.t('Modules on this server'), 'bold');
    for (const module of moduleCatalogue)
      text.add(`\n${enabled.has(module.id) ? '✅' : '○'} ${module.name}`);
    text.add(
      '\n\n' +
        this.t(
          'Modules connect daddy to agents and repository services. A workspace is the repository you want to work on.',
        ),
    );
    text.add(
      '\n\n' +
        this.t(
          'Choose an agent and model with /models inside a session. Use Add workspace to connect a repository.',
        ),
    );
    const missing = moduleCatalogue.filter((module) => !enabled.has(module.id));
    if (missing.length)
      text.add(
        '\n\n' +
          this.t(
            'Missing modules can be added by rerunning the installer on this server. Keep the currently enabled modules selected.',
          ),
      );
    await this.api.send(destination, {
      ...text,
      buttons: [
        [{ text: this.t('Add workspace'), callback_data: 'dad:add-workspace' }],
        [{ text: this.t('Workspaces'), callback_data: 'dad:workspaces' }],
      ],
    });
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
                'Use one available reset for the selected provider account? Existing conversations and files are kept.',
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
    const text = new TelegramText().add('📊 ' + this.t('Agent usage'), 'bold');
    if (result?.plan.outcome) text.add('\n\n' + this.t(resetOutcomeText[result.plan.outcome]));
    text.add('\n\n' + usageLines(usage, this.locale()).join('\n'));
    await this.api.send(destination, {
      ...text,
      buttons: [
        ...(usage.agents.some((agent) => agent.resets.canUse)
          ? [
              [
                {
                  text: this.t(
                    usage.agents.some((agent) => agent.resets.pending)
                      ? 'Resolve pending reset'
                      : 'Use a reset',
                  ),
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
    const queue = data.match(/^dad:(queue|workers):([a-f0-9-]{36})$/);
    if (queue) {
      await this.showTasks(queue[2]!, destination, queue[1] as 'queue' | 'workers');
      return true;
    }
    const sessionMerge = /^dad:sm:([a-f0-9-]{36}):(on|off)$/.exec(data);
    if (sessionMerge) {
      const id = sessionMerge[1]!;
      this.authorize(destination, id);
      const board = await this.daddy.settings(id, { autoMerge: sessionMerge[2] === 'on' });
      await this.api.send(destination, sessionSettings(this.locale(), board));
      return true;
    }
    const taskMerge = /^dad:tm:([a-f0-9-]{36}):(on|off|inherit)$/.exec(data);
    if (taskMerge) {
      const task = this.store.getTask(taskMerge[1]!);
      if (!task.groupId) throw new AppError('wrong_session', 'Task not found in this session', 404);
      this.authorize(destination, task.groupId);
      this.daddy.taskAutoMerge(task.groupId, task.id, taskMerge[2] as 'on' | 'off' | 'inherit');
      await this.showTask(task.groupId, task.id, destination);
      return true;
    }
    const merge = data.match(/^dad:merge:([a-f0-9-]{36}):([0-9]+)$/);
    if (merge) {
      const item = this.store.getTask(merge[1]!);
      if (!item.groupId || !item.revision)
        throw new AppError('wrong_session', 'Task not found in this session', 404);
      this.authorize(destination, item.groupId);
      await this.daddy.engine.action(item.id, 'verify-merge', '', {
        groupId: item.groupId,
        head: item.revision.head,
        generation: Number(merge[2]),
      });
      await this.showTask(item.groupId, item.id, destination);
      return true;
    }
    const task = data.match(/^dad:task:([a-f0-9-]{36})$/);
    if (task) {
      const { groupId } = this.store.getTask(task[1]!);
      if (!groupId) throw new AppError('wrong_session', 'Task not found in this session', 404);
      await this.showTask(groupId, task[1]!, destination);
      return true;
    }
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
    const modelAction = data.match(/^dad-model:([A-Za-z0-9_-]{16})(?::([0-9]{1,2})(:force)?)?$/);
    if (modelAction) {
      const key = 'dad-model:' + modelAction[1],
        row = this.store.db.prepare('SELECT data,consumed FROM bot_actions WHERE id=?').get(key);
      if (!row || row.consumed)
        throw new Error(this.t('This model selection expired. Open Models again.'));
      const action = JSON.parse(row.data as string) as {
        groupId: string;
        role: 'worker' | 'daddy';
        model: {
          id: string;
          engine: string;
          name: string;
          efforts: string[];
          defaultEffort: string;
        };
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
            ...(action.role === 'daddy'
              ? [
                  {
                    text: this.t('Apply now · {effort}', { effort }),
                    callback_data: `${key}:${index}:force`,
                  },
                ]
              : []),
          ]),
        });
      } else {
        const effort = action.model.efforts[Number(modelAction[2])];
        if (!effort) throw new Error('Unsupported reasoning effort');
        await this.daddy.settings(group.id, {
          profiles: {
            [action.role]: { engine: action.model.engine, model: action.model.id, effort },
          },
          forceDaddy: action.role === 'daddy' && modelAction[3] === ':force',
          applyWorkers: action.role === 'worker',
        });
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
    if (data === 'dad:modules') {
      await this.modules(destination);
      return true;
    }
    if (data === 'dad:add-workspace') {
      this.store.setSetting(this.registrationKey(destination), null);
      await this.api.send(destination, {
        ...new TelegramText()
          .add('📦 ' + this.t('Add repository'), 'bold')
          .add('\n\n' + this.t('Choose the repository service.')),
        buttons: [
          ...this.daddy.workspaces
            .modules()
            .map((module) => [
              { text: module.name, callback_data: `dad:workspace-module:${module.id}` },
            ]),
          [{ text: this.t('Cancel'), callback_data: 'dad:workspaces' }],
        ],
      });
      return true;
    }
    if (data.startsWith('dad:workspace-module:')) {
      const module = this.daddy.workspaces
        .modules()
        .find((module) => module.id === data.slice('dad:workspace-module:'.length));
      if (!module) throw new Error(this.t('Choose an enabled repository service.'));
      this.store.setSetting(this.registrationKey(destination), {
        provider: module.id,
        expiresAt: new Date(Date.now() + 10 * 60000).toISOString(),
      });
      await this.api.send(destination, {
        ...new TelegramText()
          .add('📦 ' + module.name, 'bold')
          .add(
            '\n\n' +
              this.t(
                module.vcs === 'arcadia'
                  ? 'Send the path of an existing Arcadia mount, for example ~/arcadia.'
                  : 'Send an HTTPS or SSH repository URL, or an existing server folder.',
              ),
          ),
        buttons: [[{ text: this.t('Cancel'), callback_data: 'dad:workspaces' }]],
      });
      return true;
    }
    this.store.setSetting(this.registrationKey(destination), null);
    if (data === 'dad:group') {
      if (destination.chatId !== this.pair()?.chatId) throw new Error('Use the private bot chat');
      await this.setup();
      return true;
    }
    if (data === 'dad:home' || data === 'dad:sessions') {
      await this.home(destination);
      return true;
    }
    if (data === 'dad:settings') {
      if (destination.chatId === this.pair()?.chatId)
        await this.api.send(destination, botSettings(this.locale()));
      else
        await this.api.send(destination, {
          ...new TelegramText().add(this.t('Bot settings are in the private chat.')),
          buttons: [[{ text: this.t('Open private chat'), url: `https://t.me/${this.username}` }]],
        });
      return true;
    }
    const status = data.match(/^dad:(status|settings):([a-f0-9-]{36})$/);
    if (status) {
      const [, action, id] = status;
      if (action === 'status') await this.showStatus(id, destination);
      else {
        this.authorize(destination, id);
        await this.api.send(destination, sessionSettings(this.locale(), this.daddy.board(id)));
      }
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
    const deleting = data.match(/^dad:(delete|del):([a-f0-9-]{36})(?::([0-9]+))?$/);
    if (deleting) {
      const group = this.authorize(destination, deleting[2]);
      if (!this.daddy.board(group.id).canDelete)
        throw new Error(this.t('This repository module does not support managed session deletion'));
      if (deleting[1] === 'delete') {
        await this.api.send(destination, {
          ...new TelegramText()
            .add(this.t('Delete session') + ': ' + group.title, 'bold')
            .add(
              '\n\n' +
                this.t(
                  'I will stop its agents, save the results in a local archive and remove the session copies. Your source repository stays in place.',
                ),
            ),
          buttons: [
            [
              {
                text: this.t('Delete session'),
                callback_data: `dad:del:${group.id}:${group.generation}`,
              },
            ],
            [{ text: this.t('Cancel'), callback_data: `dad:open:${group.id}` }],
          ],
        });
      } else {
        if (!deleting[3]) throw new Error(this.t('Open the current deletion confirmation'));
        const result = await this.daddy.remove(group.id, Number(deleting[3]));
        if ('group' in result) await this.api.send(destination, daddyBoard(this.locale(), result));
      }
      return true;
    }
    const models = data.match(/^dad:models:([a-f0-9-]{36})(?::(worker|daddy))?$/);
    if (models) {
      await this.models(models[1], destination, models[2] as 'worker' | 'daddy' | undefined);
      return true;
    }
    const instructions = data.match(/^dad:instructions:([a-f0-9-]{36})$/);
    if (instructions) {
      this.authorize(destination, instructions[1]);
      await this.api.send(
        destination,
        new TelegramText().add(
          instructionLines(this.daddy.group(instructions[1]).instructions, this.locale()).join(
            '\n',
          ),
        ),
      );
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
      if (limit) await this.daddy.settings(id, { workerLimit: Number(limit) });
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
          'More work for daddy? Send the ticket or tell me what needs doing. I’ll add it to this crew’s list.',
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
        await this.api.replaceCard(callback, async () => {
          await this.api.call('answerCallbackQuery', { callback_query_id: callback.id });
          await this.callback(callback.data!, destination);
        });
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
      const rawText = message?.text?.trim();
      if (!rawText) return false;
      const addressedTo = /^\/\w+@(\w+)(?=\s|$)/.exec(rawText)?.[1];
      if (addressedTo && addressedTo.toLowerCase() !== this.username.toLowerCase()) return false;
      const text = rawText.replace(/^\/(\w+)@\w+(?=\s|$)/, '/$1');
      const help = /^\/help(?:\s+([\s\S]*))?$/i.exec(text);
      if (help) {
        await this.api.send(
          destination,
          commandHelp(this.locale(), privateChat ? 'private' : 'group', help[1]),
        );
        return true;
      }
      const registrationKey = this.registrationKey(destination);
      const registration = this.store.setting<{
        provider: string;
        path?: string;
        expiresAt: string;
      }>(registrationKey);
      if (registration) {
        if (registration.expiresAt <= now() || /^\/[a-z]+(?:\s|$)/i.test(text)) {
          this.store.setSetting(registrationKey, null);
          if (text === '/cancel') {
            await this.api.send(
              destination,
              workspacePicker(this.locale(), this.daddy.workspaces.list()),
            );
            return true;
          }
        } else if (!registration.path) {
          const path = isGitAddress(text) ? parseGitSource(text).url : text;
          if (path.length > 4000 || (!isGitAddress(path) && !/^(\/|~\/)/.test(path)))
            throw new Error(this.t('Send a repository URL or an absolute server path.'));
          this.store.setSetting(registrationKey, { ...registration, path });
          await this.api.send(destination, {
            ...new TelegramText()
              .add('📦 ' + this.t('Workspace name'), 'bold')
              .add('\n\n' + this.t('Send a short name, for example Work or My app.')),
            buttons: [[{ text: this.t('Cancel'), callback_data: 'dad:workspaces' }]],
          });
          return true;
        } else {
          const workspace = await this.daddy.workspaces.register({
            name: text,
            path: registration.path,
            provider: registration.provider,
          });
          this.store.setSetting(registrationKey, null);
          await this.api.send(destination, workspacePicker(this.locale(), [workspace]));
          return true;
        }
      }

      if (text === '/modules') {
        await this.modules(destination);
        return true;
      }
      if (text === '/language') return await this.callback('language:show', destination);
      const language = text.match(/^\/language\s+(en|ru)$/);
      if (language) {
        setLocale(this.store, language[1] as 'en' | 'ru');
        await this.api.send(destination, this.t('Language updated.'));
        return true;
      }
      if (text === '/notifications') return await this.callback('notifications:show', destination);
      if (/^\/cleanup(?:\s|$)/.test(text) && !privateChat) {
        await this.api.send(destination, {
          ...new TelegramText().add(
            this.t('Send /cleanup in the private bot chat to manage disk cleanup.'),
          ),
          buttons: [[{ text: this.t('Open private chat'), url: `https://t.me/${this.username}` }]],
        });
        return true;
      }
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
      if (['/sessions', '/start', '/start daddy'].includes(text)) {
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
      const task = taskCommands.exec(text);
      if (task) {
        if (!groupId) throw new Error(this.t('Start a daddy session first.'));
        await this.taskCommand(
          task[1]!,
          task[2] ?? '',
          groupId,
          destination,
          `telegram:${task[1]}:${chat.id}:${message?.message_id ?? update.update_id}`,
        );
        return true;
      }
      const rename = text.match(/^\/rename(?:\s+([\s\S]+))?$/);
      if (rename) {
        if (!groupId) throw new Error(this.t('Open the session you want to rename.'));
        this.authorize(destination, groupId);
        if (!rename[1]) {
          await this.api.send(
            destination,
            this.t(
              'Send /rename followed by the new session name. Its Telegram topic will be renamed too.',
            ),
          );
          return true;
        }
        const board = this.daddy.rename(groupId, rename[1]);
        await this.api.send(
          destination,
          this.t('Session renamed: {title}', { title: board.group.title }),
        );
        return true;
      }
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
      if (/^\/(instructions|skill)(?:\s|$)/.test(text)) {
        if (!groupId) throw new Error(this.t('Start a daddy session first.'));
        this.authorize(destination, groupId);
        const instructions = await instructionCommand(
          text,
          this.daddy.group(groupId).instructions,
          (url) => new InstructionSources().import({ kind: 'github', url }),
        );
        if (instructions) await this.daddy.settings(groupId, { instructions });
        await this.api.send(
          destination,
          new TelegramText().add(
            instructionLines(this.daddy.group(groupId).instructions, this.locale()).join('\n'),
          ),
        );
        return true;
      }
      if (text === '/presets') {
        await this.api.send(
          destination,
          new TelegramText()
            .add('🧩 ' + this.t('Presets'), 'bold')
            .add(
              '\n\n' +
                presetLines(new InstructionPresets(this.store).list(), this.locale()).join('\n'),
            ),
        );
        return true;
      }
      const presetName = text.match(/^\/preset\s+(.+)$/)?.[1];
      if (presetName) {
        if (!groupId) throw new Error(this.t('Start a daddy session first.'));
        this.authorize(destination, groupId);
        const library = new InstructionPresets(this.store),
          preset = library.get(findPreset(library.list(), presetName).id);
        await this.daddy.settings(groupId, {
          instructions: selectPreset(this.daddy.group(groupId).instructions, preset),
        });
        await this.api.send(
          destination,
          new TelegramText()
            .add(this.t('Preset enabled for this session'), 'bold')
            .add(
              '\n\n' +
                instructionLines(this.daddy.group(groupId).instructions, this.locale()).join('\n'),
            ),
        );
        return true;
      }
      if (pool && groupId) {
        return this.callback(`dad:pool:${groupId}${pool[1] ? ':' + pool[1] : ''}`, destination);
      }
      if (text === '/status' && groupId) {
        await this.showStatus(groupId, destination);
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
        await this.api.send(destination, this.t('Tell daddy. I’ll deal with the crew.'));
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
      this.daddy.chat(groupId, text, receipt, next?.workspace, {
        channel: 'telegram',
        ...destination,
      });
      if (next) this.store.setSetting(nextKey, null);
      return true;
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ERR_SQLITE_ERROR')
        throw error;
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
    if (
      ['sent', 'superseded'].includes(
        String(
          this.store.db.prepare('SELECT status FROM notifications WHERE id=?').get(id)?.status,
        ),
      )
    )
      return;
    const parent = this.room()
      ? await this.ensureTopic(this.daddy.group(group.parentGroupId))
      : undefined;
    const destination = parent ? { chatId: parent.chatId, threadId: parent.threadId } : pair.chatId;
    if (this.pair()?.userId !== pair.userId || (parent && this.room()?.chatId !== parent.chatId))
      return;
    this.store.db
      .prepare('INSERT OR IGNORE INTO notifications VALUES(?,?,?)')
      .run(id, 'pending', now());
    const result = await this.api.send(
      destination,
      {
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
      },
      undefined,
      { key: id, notificationId: id },
    );
    this.store.db
      .prepare('UPDATE notifications SET status=? WHERE id=?')
      .run(deliveryStatus(result), id);
  }
  private eventDeferred(event: Event) {
    const deferred = this.store.setting<{
      nextAt: number;
      blockedUntil?: number;
      attempts: number;
    }>(`telegram.eventRetry:${event.taskId}`);
    return (
      !!deferred &&
      ((deferred.blockedUntil ?? 0) > Date.now() ||
        (event.id < 0 &&
          deferred.attempts > Number((event.data as { retryAttempt?: number }).retryAttempt ?? 0) &&
          deferred.nextAt > Date.now()) ||
        (event.id === 0 && deferred.nextAt > Date.now()))
    );
  }
  private deferEvent(event: Event, error: unknown) {
    const key = `telegram.eventRetry:${event.taskId}`;
    const previous = this.store.setting<{ attempts: number }>(key);
    const attempts = (previous?.attempts ?? 0) + 1;
    const retryAfter = Number((error as { retryAfter?: number }).retryAfter) || 0;
    const blockedUntil = Date.now() + retryAfter * 1000;
    this.store.setSetting(key, {
      groupId: event.taskId,
      attempts,
      blockedUntil,
      error: redact(String(error)),
      nextAt: Math.max(
        blockedUntil,
        Date.now() + Math.min(300000, 1000 * 2 ** Math.min(attempts - 1, 9)),
      ),
    });
    this.store.setSetting('telegram.error', redact(String(error)));
  }
  private clearDeferred(groupId: string) {
    const key = `telegram.eventRetry:${groupId}`;
    const retry = this.store.setting<{ error?: string }>(key);
    if (retry?.error && this.store.setting('telegram.error') === retry.error)
      this.store.setSetting('telegram.error', null);
    this.store.setSetting(key, null);
  }
  private async ownerMention(pair: Pair) {
    let label = pair.ownerLabel;
    if (!label) {
      // Older pairings only recorded the bot name. The owner's private chat is authoritative.
      try {
        const user = await this.api.call<{ id: number; username?: string; first_name?: string }>(
          'getChat',
          { chat_id: pair.chatId },
        );
        if (user?.id === pair.userId && this.pair()?.userId === pair.userId) {
          label = user.username ? '@' + user.username : user.first_name;
          if (label)
            this.store.setSetting('telegram.pairing', { ...this.pair(), ownerLabel: label });
        }
      } catch {
        /* The numeric mention also works without a display name. */
      }
    }
    return new TelegramText().add(label || this.t('Session owner'), 'text_link', {
      url: `tg://user?id=${pair.userId}`,
    });
  }
  private taskRequestKey(task: Task) {
    if (task.state === 'awaiting_plan_approval')
      return `plan:${task.contextVersion}:${task.revision?.head}:${task.revision?.base}:${task.review?.id ?? ''}`;
    if (
      task.state === 'needs_input' &&
      task.reason === draftInspectionRequired &&
      task.review &&
      !this.store.pendingReviewWrites(task.id, task.review.marker).length
    )
      return 'inspect-draft:' + task.review.id;
    if (task.state === 'needs_input' && task.inputRequest?.generation === task.generation)
      return task.inputRequest.runId;
  }
  private queueTaskRequest(task: Task, event: Event) {
    const request = this.taskRequestKey(task);
    if (!request || !task.groupId) return;
    this.onEvent({
      ...event,
      taskId: task.groupId,
      type: 'daddy.task_question',
      data: { ...(event.data as object), taskId: task.id, request },
    });
  }
  onEvent(event: Event): boolean {
    if (event.type === 'task.state') {
      if (
        ['needs_input', 'awaiting_plan_approval'].includes((event.data as { state: string }).state)
      )
        this.queueTaskRequest(this.store.getTask(event.taskId), event);
      return false;
    }
    if (!event.type.startsWith('daddy.')) return false;
    if (this.eventDeferred(event)) return true;
    if (
      [
        'daddy.workspace_ready',
        'daddy.prepare_failed',
        'daddy.deleted',
        'daddy.delete_failed',
      ].includes(event.type)
    ) {
      this.pending = this.pending
        .then(async () => {
          if (this.eventDeferred(event)) return;
          const pair = this.pair();
          if (this.stopped || !pair) return;
          const group = this.store.getGroup(event.taskId);
          const room = this.room();
          const topic = room ? this.topic(room, group.id) : undefined;
          const destination = topic
            ? { chatId: topic.chatId, threadId: topic.threadId }
            : pair.chatId;
          if (group.deletedAt) {
            if (event.type !== 'daddy.deleted') return;
            if (this.store.setting('telegram.currentDaddy') === group.id)
              this.store.setSetting('telegram.currentDaddy', null);
            const text = new TelegramText().add(
              this.t('Session deleted') + ': ' + group.title,
              'bold',
            );
            if (group.deletion?.archivePath)
              text
                .add('\n\n' + this.t('Results saved in the archive') + '\n')
                .add(group.deletion.archivePath, 'code');
            await this.api.send(destination, {
              ...text,
              buttons: [[{ text: this.t('Sessions'), callback_data: 'dad:home' }]],
            });
            if (topic)
              await this.api.call('closeForumTopic', {
                chat_id: topic.chatId,
                message_thread_id: topic.threadId,
              });
          } else {
            await this.progress.ensure(group.id);
            await this.sessionBoard(
              group.id,
              typeof destination === 'number' ? { chatId: destination } : destination,
            );
          }
        })
        .catch((error) => this.deferEvent(event, error));
      return true;
    }
    if (['daddy.resource_wait', 'daddy.resources_restored'].includes(event.type)) {
      this.pending = this.pending
        .then(async () => {
          if (this.eventDeferred(event)) return;
          const pair = this.pair();
          if (this.stopped || !pair) return;
          const group = this.daddy.group(event.taskId),
            topic = await this.ensureTopic(group);
          const data = event.data as {
            resources: ResourceStatus;
            state?: string;
            canRecover?: boolean;
          };
          const restored = data.resources.ok;
          const text = new TelegramText()
            .add(
              (restored ? '✅ ' : '⚠️ ') +
                this.t(restored ? 'Resources restored' : 'Waiting for server resources'),
              'bold',
            )
            .add(
              '\n\n' +
                this.t('Disk free: {disk} GiB · Used: {percent}% · RAM available: {memory} GiB', {
                  disk: data.resources.diskAvailableGiB.toFixed(1),
                  percent: data.resources.diskUsedPercent.toFixed(1),
                  memory: data.resources.memoryAvailableGiB.toFixed(1),
                }),
            )
            .add(
              '\n\n' +
                this.t(
                  restored
                    ? 'Saved questions will continue. Work paused by the monitor resumes after checking its state.'
                    : data.state === 'blocked'
                      ? 'Safe recovery has not cleared the limit. Your questions and working files are saved; daddy will report what still needs attention.'
                      : data.canRecover === false
                        ? 'There is not enough room to start the maintenance agent. Your questions and working files are saved.'
                        : 'The resource monitor has asked daddy to inspect and repair this. Your questions are saved; ordinary work waits for the resource check.',
                ),
            );
          await this.api.send(topic ?? { chatId: pair.chatId }, text, undefined, {
            key: `resources:${group.id}`,
            replace: true,
            order: event.at,
          });
        })
        .catch((error) => this.deferEvent(event, error));
      return true;
    }
    if (event.type === 'daddy.renamed') {
      this.pending = this.pending
        .then(async () => {
          if (this.eventDeferred(event)) return;
          if (!this.stopped && this.pair()) await this.ensureTopic(this.daddy.group(event.taskId));
        })
        .catch((error) => this.deferEvent(event, error));
      return true;
    }
    if (event.type === 'daddy.created') {
      this.pending = this.pending
        .then(async () => {
          if (this.eventDeferred(event)) return;
          const room = this.room();
          if (this.stopped) return;
          if (this.store.getGroup(event.taskId).deletedAt) return;
          const group = this.daddy.group(event.taskId),
            topic = await this.ensureTopic(group);
          this.clearDeferred(group.id);
          await this.announceChild(group, topic);
          if (!topic || !room) return;
          await this.progress.ensure(group.id);
          if (this.room()?.chatId !== topic.chatId || this.pair()?.userId !== topic.ownerId) return;
          const id = `telegram:daddy-intro:${room.chatId}:${group.id}`;
          // Replay refreshes the current board too: preparation may have completed
          // just before a crash, without reaching the delivery queue. The stable
          // delivery key avoids resending an unchanged card.
          this.store.db
            .prepare('INSERT OR IGNORE INTO notifications VALUES(?,?,?)')
            .run(id, 'pending', now());
          const result = await this.sessionBoard(group.id, {
            chatId: topic.chatId,
            threadId: topic.threadId,
          });
          this.store.db
            .prepare('UPDATE notifications SET status=? WHERE id=?')
            .run(deliveryStatus(result), id);
        })
        .catch((error) => this.deferEvent(event, error));
      return true;
    }
    if (event.type !== 'daddy.message' && event.type !== 'daddy.task_question') return true;
    this.pending = this.pending
      .then(async () => {
        if (this.eventDeferred(event)) return;
        const pair = this.pair();
        if (this.stopped || !pair) return;
        if (this.store.getGroup(event.taskId).deletedAt) return;
        const group = this.daddy.group(event.taskId);
        const { taskId, request, messageId } = event.data as {
          taskId?: string;
          request?: string;
          messageId?: string;
        };
        const task = taskId ? this.store.getTask(taskId) : undefined;
        const message = messageId ? this.store.messageById(group.id, messageId) : undefined;
        if (
          task &&
          (task.groupId !== group.id || !request || this.taskRequestKey(task) !== request)
        )
          return;
        if (!task && (!message || !['user', 'agent'].includes(message.sender))) return;
        const prefs = notificationPreferences(this.store);
        const answered =
          message?.needsReply &&
          this.store
            .messages(group.id)
            .some((entry) => entry.sender === 'user' && entry.at > message.at);
        const ping = prefs.enabled && (!!task || (!!message?.needsReply && !answered));
        if (task && !ping) return;
        const topic = await this.ensureTopic(group);
        const destination = topic
          ? { chatId: topic.chatId, threadId: topic.threadId }
          : { chatId: pair.chatId };
        if (
          message?.origin?.channel === 'telegram' &&
          message.origin.chatId === destination.chatId &&
          message.origin.threadId === destination.threadId
        )
          return;
        if (!topic && !ping && message?.sender === 'agent') {
          const job = message.runId
            ? this.store.daddyJobs(group.id).find((job) => job.id === message.runId)
            : undefined;
          const prefs = notificationPreferences(this.store);
          if (job?.trigger !== 'user') {
            if (!prefs.enabled) return;
            if (prefs.mode === 'attention' && group.daddyState !== 'needs_input') {
              const tasks = this.store.tasks().filter((task) => task.groupId === group.id);
              if (!tasks.length || tasks.some((task) => task.state !== 'complete')) return;
            }
          }
        }
        const id = task
          ? `telegram:question:${pair.userId}:${task.id}:${request}`
          : `telegram:dialog:${destination.chatId}:${destination.threadId ?? 0}:${message!.id}${message!.phase ? ':' + message!.phase : ''}`;
        if (
          ['sent', 'superseded'].includes(
            String(
              this.store.db.prepare('SELECT status FROM notifications WHERE id=?').get(id)?.status,
            ),
          )
        )
          return;
        this.store.db
          .prepare('INSERT OR IGNORE INTO notifications VALUES(?,?,?)')
          .run(id, 'pending', now());
        const text = new TelegramText();
        if (ping)
          text
            .append(await this.ownerMention(pair))
            .add(' · ' + this.t('Your reply is needed') + '\n\n');
        if (this.pair()?.userId !== pair.userId || (topic && this.room()?.chatId !== topic.chatId))
          return;
        if (
          task &&
          (this.taskRequestKey(this.store.getTask(task.id)) !== request ||
            !notificationPreferences(this.store).enabled)
        )
          return;
        if (task) {
          const worker = task.inputRequest?.role === 'author';
          text
            .add(worker ? this.t('Worker') : 'daddy', 'bold')
            .add(' · ')
            .add(taskReference(task), 'code')
            .add('  ' + task.title + '\n\n')
            .markdown(this.t(redact(task.reason)));
        } else if (message) {
          text.add(message.sender === 'user' ? '👤 [user]' : '👨‍💻 [daddy]', 'bold').add('\n\n');
          if (message.sender === 'user') text.add(message.text);
          else text.markdown(message.text);
        }
        // An edit to a progress message does not send a fresh mention notification.
        const replaceMessage = !ping && message?.sender === 'agent';
        const url = task && task.ref.kind !== 'ticket' && safeLink(task.ref.url);
        const card = task
          ? {
              ...text,
              buttons: [
                [
                  { text: this.t('Open task'), callback_data: `dad:task:${task.id}` },
                  ...(url ? [{ text: 'PR', url }] : []),
                ],
              ],
            }
          : text;
        const result = await this.api.send(destination, card, undefined, {
          key: replaceMessage ? `message:${message!.id}` : id,
          replace: replaceMessage,
          replacePending: message?.sender === 'agent',
          order: message?.at ?? event.at,
          final: message?.phase !== 'progress',
          notificationId: id,
        });
        this.store.db
          .prepare('UPDATE notifications SET status=? WHERE id=?')
          .run(deliveryStatus(result), id);
        this.clearDeferred(group.id);
      })
      .catch((error) => this.deferEvent(event, error));
    return true;
  }
  private replayGroup(group: ReviewGroup, retry = false) {
    const retryAttempt = retry
      ? this.store.setting<{ attempts: number }>(`telegram.eventRetry:${group.id}`)?.attempts
      : undefined;
    if (this.room())
      this.onEvent({
        id: retry ? -1 : 0,
        taskId: group.id,
        type: 'daddy.created',
        data: { retryAttempt },
        at: now(),
      });
    for (const task of this.store.tasks(group.id))
      this.queueTaskRequest(task, {
        id: retry ? -1 : 0,
        at: now(),
        taskId: task.id,
        type: 'task.state',
        data: { retryAttempt },
      });
    const messages = this.store.messages(group.id);
    const pair = this.pair();
    const room = this.room();
    const topic = room ? this.topic(room, group.id) : undefined;
    const destination = topic
      ? { chatId: topic.chatId, threadId: topic.threadId }
      : !room && pair && this.store.setting('telegram.currentDaddy') === group.id
        ? { chatId: pair.chatId }
        : undefined;
    const deliveredFinalRuns = new Set(
      messages
        .filter(
          (message) =>
            message.phase === 'final' &&
            message.runId &&
            destination &&
            this.store.db
              .prepare('SELECT 1 FROM notifications WHERE status=? AND id=?')
              .get(
                'sent',
                `telegram:dialog:${destination.chatId}:${destination.threadId ?? 0}:${message.id}:final`,
              ),
        )
        .map((message) => message.runId),
    );
    for (const message of messages.filter(
      (message) =>
        ['user', 'agent'].includes(message.sender) &&
        !(message.phase === 'progress' && deliveredFinalRuns.has(message.runId)),
    ))
      this.onEvent({
        id: retry ? -1 : 0,
        taskId: group.id,
        type: 'daddy.message',
        data: { messageId: message.id, retryAttempt },
        at: now(),
      });
  }
  replay() {
    for (const group of this.daddy.sessions()) this.replayGroup(group);
  }
  async stop() {
    this.stopped = true;
    clearInterval(this.retryTimer);
    await this.progress.stop();
    await this.voice?.stop();
    await this.pending;
    await Promise.allSettled([...this.topics.values()]);
  }
}
