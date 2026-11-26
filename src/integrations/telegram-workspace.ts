import {
  commitTelegramOperation,
  operationDestination,
  resultKey,
  type TelegramOperationResult,
} from './telegram-receipts.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { repositorySelectionSchema, workspaceSchema } from '../core/workspace-registry.js';
import { sessionInstructionsSchema, type SessionInstructions } from '../core/instructions.js';
import { profileSchema } from '../core/agents.js';
import { presetParts } from '../core/preset-parts.js';
import {
  taskRequestKey,
  reminderOpen,
  nextReminderId,
  type OwnerQuestion,
} from './telegram-reminders.js';
import { commandHelp } from './telegram-commands.js';
import { githubBackoff } from '../providers/github-quota.js';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import type { Daddy } from '../core/daddy.js';
import {
  sameAgentProfile,
  sameRevision,
  assertTaskVersion,
  type AgentProfile,
  AppError,
  now,
  type Event,
  type ReviewGroup,
  type Task,
  type ExpectedTask,
  revisionOf,
  type TelegramReply,
} from '../core/types.js';
import { redact } from '../core/security.js';
import type { TelegramApi, Update } from './telegram.js';
import { TelegramText, safeLink, type TelegramCard } from './telegram-text.js';
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
import { InstructionSources, instructionSourceSchema } from '../ops/instruction-sources.js';
import { InstructionPresets } from '../core/instruction-presets.js';
import { findPreset, selectPreset, presetLines } from '../client/presets.js';
import { isGitAddress, parseGitSource } from '../modules/repositories/git-source.js';
import { clipTitle } from '../core/session-title.js';
import { moduleCatalogue } from '../modules/catalogue.js';
import { deliveryStatus } from './telegram-delivery.js';
import { autoMergeSettings, githubActivityStatus, sessionAutoMerge } from '../core/auto-merge.js';
import { taskReference } from '../core/task-activity.js';
import { workerPool, workerSlots } from '../core/worker-pool.js';
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
type InstructionTarget = { id: string; generation: number; instructions?: SessionInstructions };
const guardedCallback = /^dad:(?:pause:|resume:|sm:|tm:|arch-reset:|pool:[a-f0-9-]{36}:)/;
type CardAction = {
  kind: 'card';
  data: string;
  groupId: string;
  generation: number;
  taskId?: string;
  taskGeneration?: number;
  revision?: Task['revision'];
  settings: string;
};
type RepoChoice = {
  destination: Destination;
  ownerId: number;
  workspace: Workspace;
  groupId?: string;
  input?: RepositorySelection;
  expiresAt: string;
  creationExpiresAt?: string;
};
function telegramReply(message: Update['message']): TelegramReply | undefined {
  if (!message) return;
  const parent = message.reply_to_message;
  const quote = message.quote?.text && redact(message.quote.text.slice(0, 4096));
  // External quotes carry only the excerpt Telegram provided in this chat.
  if (
    !parent ||
    parent.chat.id !== message.chat.id ||
    (parent.message_thread_id !== undefined &&
      parent.message_thread_id !== message.message_thread_id)
  )
    return quote ? { quote } : undefined;
  if (parent.forum_topic_created || (parent.message_id === message.message_thread_id && !quote))
    return;
  const author = parent.from?.username ? '@' + parent.from.username : parent.from?.first_name;
  const text = parent.text ?? parent.caption;
  return {
    messageId: parent.message_id,
    author: author && redact(author.slice(0, 128)),
    text: text && redact(text.slice(0, 4096)),
    quote: quote || undefined,
  };
}
export class TelegramWorkspace {
  private pending = Promise.resolve();
  private stopped = false;
  private topics = new Map<string, Promise<Topic>>();
  private voice?: VoiceInbox;
  private reminderTimer?: NodeJS.Timeout;
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
    this.remindOwners();
    this.reminderTimer = setInterval(() => this.remindOwners(), 60000);
    this.reminderTimer.unref();
    this.progress.start();
    this.pruneActions();
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
  private questionForReceipt(
    receipt:
      | { question?: unknown; deliveryKey?: unknown; groupId?: unknown; notificationId?: unknown }
      | undefined,
    ownerId: number,
  ): OwnerQuestion | undefined {
    if (typeof receipt?.question === 'string') return JSON.parse(receipt.question) as OwnerQuestion;
    const key = receipt?.deliveryKey;
    if (typeof key !== 'string') return;
    if (key.startsWith(`telegram:question:${ownerId}:`)) {
      const [, , , taskId, ...parts] = key.split(':');
      const task = this.store.getTask(taskId);
      if (task.groupId)
        return { groupId: task.groupId, taskId, request: parts.join(':').split(':reminder:')[0] };
    }
    const dialogKey = key.startsWith('turn:') ? receipt?.notificationId : key;
    if (typeof dialogKey === 'string' && dialogKey.startsWith('telegram:dialog:')) {
      const messageId = dialogKey.split(':')[4];
      const groupId =
        receipt?.groupId ??
        this.store.db.prepare('SELECT task_id FROM messages WHERE id=?').get(messageId)?.task_id;
      if (typeof groupId === 'string' && this.store.messageById(groupId, messageId)?.needsReply)
        return { groupId, messageId };
    }
  }

  private validateQuestionReply(destination: Destination, messageId: number, ownerId: number) {
    const receipt = this.api.delivery?.replyReceipt(destination.chatId, messageId, ownerId);
    const question = this.questionForReceipt(receipt, ownerId);
    if (!question) return;
    if (
      (receipt?.threadId ?? undefined) !== destination.threadId ||
      !reminderOpen(this.store, question, false)
    )
      throw new Error(this.t('This question has expired or belongs to a different topic.'));
    this.authorize(destination, question.groupId);
    return question;
  }

  private voiceRoute(destination: Destination, replyGroup?: string): VoiceRoute | undefined {
    const pair = this.pair();
    if (!pair) return;
    const id =
      destination.chatId === pair.chatId
        ? (replyGroup ?? this.store.setting<string>('telegram.currentDaddy'))
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
    if (job.replyTo?.messageId)
      this.validateQuestionReply(job.route, job.replyTo.messageId, pair.userId);
    const text = job.fileId ? '🎙️ ' + job.text : job.text!;
    this.daddy.chat(group.id, text, receipt, job.route.workspace, {
      channel: 'telegram',
      messageId: job.messageId,
      replyTo: job.replyTo,
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
  private cardSettings(group: ReviewGroup, data: string, task?: Task) {
    if (data.startsWith('dad:tm:'))
      return JSON.stringify(task && autoMergeSettings(this.store, group, task).mode);
    if (data.startsWith('dad:arch-reset:'))
      return JSON.stringify((task ? task.architectProfile : group.architectProfile) ?? null);
    if (data.startsWith('dad:sm:')) return String(sessionAutoMerge(this.store, group.id));
    if (data.startsWith('dad:pool:')) return String(workerPool(this.store, group).target);
    return String(group.daddyState);
  }
  private scopedCard(
    destination: Destination,
    card: TelegramCard,
    group: ReviewGroup,
    task?: Task,
  ) {
    return {
      ...card,
      buttons: card.buttons?.map((row) =>
        row.map((button) => {
          const data = 'callback_data' in button && button.callback_data;
          if (!data || !guardedCallback.test(data)) return button;
          const action: CardAction = {
            kind: 'card',
            data,
            groupId: group.id,
            generation: group.generation,
            taskId: task?.id,
            taskGeneration: task?.generation,
            revision: task?.revision,
            settings: this.cardSettings(group, data, task),
          };
          return { ...button, callback_data: 'dad:a:' + this.actionKey(destination, action, true) };
        }),
      ),
    };
  }
  async show(groupId: string, destination: Destination) {
    const group = this.authorize(destination, groupId),
      topic = await this.ensureTopic(group);
    if (destination.chatId === this.pair()?.chatId) {
      this.store.setSetting('telegram.currentDaddy', group.id);
      this.store.setSetting(this.creationKey(destination), null);
    }
    await this.api.send(
      destination,
      this.scopedCard(
        destination,
        daddyBoard(
          this.locale(),
          this.daddy.board(group.id),
          destination.chatId === this.pair()?.chatId && topic ? this.link(topic) : undefined,
        ),
        this.daddy.group(group.id),
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
  private async showTasks(
    groupId: string,
    destination: Destination,
    view: 'queue' | 'workers',
    page = 0,
  ) {
    const group = this.authorize(destination, groupId);
    const slots = workerSlots(this.store, group);
    const tasks = taskActivity(
      this.store.tasks(groupId).reverse(),
      this.store.activeJobs(),
      (task, job) =>
        githubActivityStatus(
          task,
          autoMergeSettings(this.store, group, task),
          githubBackoff(this.store, task.ref),
          job,
        ),
      slots,
    );
    const locale = this.locale();
    await this.api.send(
      destination,
      view === 'queue'
        ? queueCard(locale, groupId, tasks, {
            page,
            readFirstStarts: (ids) => this.store.firstTaskStarts(ids),
          })
        : workersCard(
            locale,
            groupId,
            slots,
            tasks,
            group.worker ?? this.daddy.engine.defaultAgents().worker,
          ),
    );
  }
  private findSession(prefix: string) {
    const groups = this.daddy.sessions().filter((group) => group.id.startsWith(prefix));
    if (groups.length !== 1) throw new Error('Choose a unique daddy session ID');
    return groups[0];
  }

  private async instructionFile(message: NonNullable<Update['message']>, destination: Destination) {
    const owner = this.pair()!;
    const caption = message.caption?.trim() ?? '';
    const session = /^\/import ([a-f0-9-]{8,36})$/.exec(caption);
    const skill = /^\/skill_file ([a-f0-9-]{8,36}) (daddy|worker)(?: (.+))?$/.exec(caption);
    const create = /^\/preset_create ([^\n]+)(?:\n([\s\S]+))?$/.exec(caption);
    const update = /^\/preset_edit ([a-f0-9-]{8,36}) (\d+) ([^\n]+)(?:\n([\s\S]+))?$/.exec(caption);
    if (!session && !skill && !create && !update)
      throw new Error(
        'Use the caption /import SESSION_ID, /skill_file SESSION_ID ROLE, /preset_create NAME or /preset_edit ID REVISION NAME.',
      );
    const target = session ?? skill;
    const shown = this.update.getStore()?.instructionTarget;
    const group =
      target && this.authorize(destination, shown?.id ?? this.findSession(target[1]).id);
    if (group && shown && group.generation !== shown.generation)
      throw new AppError('stale_session', 'The session changed. Open a fresh confirmation.', 409);
    const baseline = shown ? shown.instructions : group ? group.instructions : undefined;
    const library = new InstructionPresets(this.store);
    const preset = update && findPreset(library.list(), update[1]);
    const limit = skill ? 65536 : 1048576;
    const sizeError = 'The instruction set file is too large';
    if ((message.document!.file_size ?? 0) > limit) throw new Error(sizeError);
    const bytes = await this.api.downloadFile(message.document!.file_id, limit, sizeError);
    const current = this.pair();
    if (current?.userId !== owner.userId || current.chatId !== owner.chatId)
      throw new Error(this.t('This action expired. Open a fresh card.'));
    const body = new TextDecoder().decode(bytes);
    let instructions;
    if (skill && group) {
      instructions = await instructionCommand('/skill ' + skill[2] + ' file', baseline, () =>
        new InstructionSources().import({
          kind: 'file',
          name: message.document!.file_name ?? 'SKILL.md',
          path: skill[3],
          text: body,
        }),
      );
    } else {
      let value: unknown;
      try {
        value = JSON.parse(body);
      } catch {
        throw new Error('Invalid instruction set JSON');
      }
      instructions = sessionInstructionsSchema.parse(value);
    }
    if (!instructions) throw new Error('Invalid instructions');
    if (group) {
      await this.settings(group.id, {
        instructions,
        expectedGeneration: group.generation,
        baseline: { instructions: baseline ?? null },
      });
    } else {
      library.save(
        {
          name: create?.[1] ?? update![3],
          description: create?.[2] ?? update?.[4] ?? (preset ? preset.description : ''),
          instructions,
          expectedRevision: update ? Number(update[2]) : undefined,
        },
        preset ? preset.id : undefined,
        this.receipt,
      );
    }
    await this.api.send(destination, this.t('Instructions saved.'));
  }

  private async offerPrivateOperation(
    source: Destination,
    text: string,
    readOnly: boolean,
    document?: NonNullable<Update['message']>['document'],
  ) {
    const key = this.actionKey(
      { chatId: this.pair()!.chatId },
      {
        kind: 'private-operation',
        source,
        text,
        document,
        groupId: this.groupAt(source),
        readOnly,
      },
    );
    await this.privateLink(source, 'operation_' + key);
  }

  private async privateLink(destination: Destination, command: string) {
    await this.api.send(destination, {
      ...new TelegramText().add(this.t('Continue in the private bot chat.')),
      buttons: [
        [
          {
            text: this.t('Open private chat'),
            url: `https://t.me/${this.username}?start=${command}`,
          },
        ],
      ],
    });
  }
  private lastActionPrune = 0;
  private pruneActions() {
    const at = Date.now();
    if (at - this.lastActionPrune < 60_000) return;
    this.store.db
      .prepare(
        "DELETE FROM bot_actions WHERE typeof(json_extract(data,'$.expiresAt'))='integer' AND json_extract(data,'$.expiresAt') <= ?",
      )
      .run(at);
    this.lastActionPrune = at;
  }
  private actionKey<T extends object>(destination: Destination, action: T, reusable = false) {
    this.pruneActions();
    const data = { ...action, destination, ownerId: this.pair()!.userId };
    let fingerprint: string | undefined;
    if (reusable) {
      // Replaying an unchanged session card should preserve its keyboard and delivery receipt.
      fingerprint = createHash('sha256').update(JSON.stringify(data)).digest('hex');
      const prior = this.store.db
        .prepare(
          "SELECT id FROM bot_actions WHERE consumed=0 AND json_extract(data,'$.fingerprint')=? AND json_extract(data,'$.expiresAt')>? LIMIT 1",
        )
        .get(fingerprint, Date.now());
      if (prior) return String(prior.id);
    }
    const key = randomBytes(12).toString('base64url');
    this.store.db
      .prepare('INSERT INTO bot_actions(id,data) VALUES(?,?)')
      .run(key, JSON.stringify({ ...data, fingerprint, expiresAt: Date.now() + 600_000 }));
    return key;
  }
  private readAction<T>(key: string, destination: Destination) {
    const row = this.store.db.prepare('SELECT data,consumed FROM bot_actions WHERE id=?').get(key);
    const action =
      row &&
      (JSON.parse(String(row.data)) as T & {
        destination: Destination;
        ownerId: number;
        expiresAt: number;
      });
    if (
      !action ||
      row.consumed ||
      action.ownerId !== this.pair()?.userId ||
      action.destination?.chatId !== destination.chatId ||
      action.destination.threadId !== destination.threadId ||
      action.expiresAt <= Date.now()
    )
      throw new Error(this.t('This action expired. Open a fresh card.'));
    return action;
  }
  private finishAction(key: string) {
    this.store.db.prepare('UPDATE bot_actions SET consumed=1 WHERE id=?').run(key);
  }
  private async confirmTask(key: string, destination: Destination, reason?: string) {
    return this.daddy.engine.lock('telegram:' + key, async () => {
      const action = this.readAction<{
        kind: 'task-confirm';
        taskId: string;
        expected: ExpectedTask & { groupId: string };
        command: 'verify-merge' | 'approve-plan' | 'waive-checks';
        page: number;
        source: Destination;
      }>(key, destination);
      if (action.kind !== 'task-confirm' || (reason && action.command !== 'waive-checks'))
        throw new Error('Invalid task confirmation');
      const checkRoute = () => {
        this.readAction(key, destination);
        this.authorize(action.source, action.expected.groupId);
        this.authorize(destination, action.expected.groupId);
      };
      checkRoute();
      const task = this.daddy.task(action.expected.groupId, action.taskId);
      assertTaskVersion(task, action.expected);
      if (action.command === 'waive-checks' && !reason) {
        if (task.state !== 'awaiting_checks')
          throw new Error(this.t('This action expired. Open a fresh card.'));
        await this.api.send(
          destination,
          new TelegramText()
            .add(taskReference(task) + ' · ' + task.title + '\n')
            .add(action.expected.head.slice(0, 12), 'code')
            .add('\n\n' + this.t('Reason for waiving CI checks') + '\n')
            .add('/waive ' + key + ' ', 'code'),
        );
        return;
      }
      await this.daddy.engine.action(
        action.taskId,
        action.command,
        reason ?? '',
        action.expected,
        checkRoute,
      );
      this.finishAction(key);
      await this.showTask(action.expected.groupId, action.taskId, destination, action.page);
    });
  }
  private async showTask(groupId: string, taskId: string, destination: Destination, queuePage = 0) {
    const group = this.authorize(destination, groupId);
    const task = this.daddy.task(groupId, taskId);
    const slots = workerSlots(this.store, group);
    const [activity] = taskActivity(
      [task],
      this.store.activeJobs(taskId),
      (t, job) =>
        githubActivityStatus(
          t,
          autoMergeSettings(this.store, group, t),
          githubBackoff(this.store, t.ref),
          job,
        ),
      slots,
    );
    const slot = slots.find((item) => item.taskId === taskId);
    const merge =
      group.workspace?.provider === 'github' && task.ref.provider === 'github'
        ? autoMergeSettings(this.store, group, task)
        : undefined;
    const card = taskCard(this.locale(), activity!, slot, merge, queuePage);
    const command =
      task.state === 'needs_input'
        ? 'verify-merge'
        : task.state === 'awaiting_plan_approval'
          ? 'approve-plan'
          : task.state === 'awaiting_checks'
            ? 'waive-checks'
            : undefined;
    if (command && task.ref.kind !== 'ticket' && task.revision) {
      const target = command === 'waive-checks' ? { chatId: this.pair()!.chatId } : destination;
      const key = this.actionKey(target, {
        kind: 'task-confirm',
        source: destination,
        command,
        taskId,
        expected: {
          groupId,
          head: task.revision.head,
          revision: revisionOf(task.revision),
          generation: task.generation,
        },
        page: queuePage,
      });
      const text = this.t(
        command === 'verify-merge'
          ? 'Verify merge'
          : command === 'approve-plan'
            ? 'Approve plan'
            : 'Waive CI checks',
      );
      card.buttons?.unshift([
        target.chatId === destination.chatId
          ? { text, callback_data: `dad:vm:${key}` }
          : {
              text: text + ' · ' + this.t('Open private chat'),
              url: `https://t.me/${this.username}?start=waive_${key}`,
            },
      ]);
    }
    await this.api.send(destination, this.scopedCard(destination, card, group, task));
  }
  private async taskCommand(
    command: string,
    args: string,
    groupId: string,
    destination: Destination,
    receipt: string,
    replyTo?: TelegramReply,
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
      const baseline = slot.profile ?? defaults;
      const engine = input.engine ?? baseline.engine;
      const inheritedEffort = input.effort === undefined && engine === baseline.engine;
      const profile = {
        engine,
        model: input.model,
        effort: inheritedEffort ? baseline.effort : input.effort,
      };
      if (input.force && slot.taskId) {
        const task = this.daddy.task(groupId, slot.taskId);
        const key = this.actionKey(destination, {
          kind: 'force-worker',
          groupId,
          number: input.number,
          profile,
          baseline,
          inheritedEffort,
          groupGeneration: group.generation,
          taskId: task.id,
          expected: {
            groupId,
            generation: task.generation,
            head: task.revision?.head ?? '',
            revision: task.revision,
          },
        });
        await this.api.send(destination, {
          ...new TelegramText()
            .add(this.t('Confirm') + ' · ' + taskReference(task) + ' · ' + task.title)
            .add('\n' + profileText(profile)),
          buttons: [[{ text: this.t('Confirm'), callback_data: 'dad:force:' + key }]],
        });
        return;
      }
      const owner = this.pair()?.userId;
      const result = await this.daddy.configureWorker(groupId, input.number, profile, {
        baseline,
        inheritedEffort,
        expectedGeneration: this.update.getStore()?.expectedGeneration ?? group.generation,
        check: () => {
          if (this.pair()?.userId !== owner)
            throw new Error(this.t('This action expired. Open a fresh card.'));
          this.authorize(destination, groupId);
        },
        onCommit: this.receipt,
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
    const request = parseTaskInput(
      args,
      defaults.engine,
      (group.architectProfile ?? group.daddy).engine,
    );
    if (!request) {
      await this.api.send(
        destination,
        this.t(
          'Use /task DESCRIPTION to queue work or /task DADDY-ID to check it. Plan checking is on by default. Use /task --no-plan -- DESCRIPTION to skip it. To choose a worker and model, send /task --worker NUMBER --model MODEL --effort EFFORT -- DESCRIPTION.',
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
      replyTo,
      expectedGeneration: this.update.getStore()?.expectedGeneration,
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
    return this.api.send(
      destination,
      this.scopedCard(destination, daddyBoard(this.locale(), board, link), board.group),
      undefined,
      {
        key: id,
        replace: true,
        order: board.group.updatedAt,
        notificationId: id,
      },
    );
  }
  private async showSessionChoices(update: Update, destination: Destination) {
    const groups = this.daddy.sessions();
    const pendingKey = this.creationKey(destination) + ':command';
    const generations = Object.fromEntries(groups.map((group) => [group.id, group.generation]));
    this.store.setSetting(pendingKey, { update, expiresAt: Date.now() + 600_000, generations });
    await this.api.send(destination, {
      ...new TelegramText().add(this.t('Choose a session')),
      buttons: groups.slice(0, 15).map((group) => [
        {
          text: group.title,
          callback_data:
            'dad:choose:' +
            this.actionKey(destination, {
              kind: 'choose-session',
              groupId: group.id,
              generation: group.generation,
              update,
              pendingKey,
            }),
        },
      ]),
    });
  }

  private async runSelected(
    update: Update,
    id: string,
    source: Destination,
    shownGeneration?: number,
  ) {
    const pendingKey = this.creationKey(source) + ':command';
    await this.daddy.engine.lock(pendingKey, async () => {
      const pending = this.store.setting<{
        update: Update;
        expiresAt: number;
        selected?: string;
        generations?: Record<string, number>;
      }>(pendingKey);
      if (
        !pending ||
        pending.expiresAt <= Date.now() ||
        pending.update.update_id !== update.update_id ||
        (pending.selected && pending.selected !== id)
      )
        throw new Error(this.t('This action expired. Open a fresh card.'));
      const group = this.daddy.group(id);
      const expectedGeneration = shownGeneration ?? pending.generations?.[id];
      if (
        expectedGeneration !== group.generation ||
        pending.generations?.[id] !== expectedGeneration
      ) {
        await this.api.send(source, this.t('This action expired. Open a fresh card.'));
        await this.showSessionChoices(update, source);
        return;
      }
      const pair = this.pair()!;
      const target = source.chatId === pair.chatId ? source : await this.ensureTopic(group);
      if (!target) throw new Error(this.t('Open the topic for the session you want to continue.'));
      if (this.authorize(target, id).generation !== expectedGeneration) {
        await this.showSessionChoices(update, source);
        return;
      }
      this.store.setSetting(pendingKey, { ...pending, selected: id });
      if (source.chatId === pair.chatId) this.store.setSetting('telegram.currentDaddy', id);
      const message = update.message!;
      const context = this.update.getStore();
      const selected = {
        ...update,
        message: {
          ...message,
          chat: { ...message.chat, id: target.chatId },
          message_thread_id: target.threadId,
        },
      };
      try {
        if (context)
          await this.update.run({ ...context, pendingKey, expectedGeneration }, () =>
            this.handleMessage(selected),
          );
        else await this.handleMessage(selected);
      } catch (error) {
        if (!(error instanceof AppError) || error.code !== 'stale_session') throw error;
        await this.showSessionChoices(update, source);
        return;
      }
      this.store.setSetting(pendingKey, null);
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
  private async models(
    groupId: string,
    destination: Destination,
    role?: 'worker' | 'daddy' | 'architect',
    taskId?: string,
    page = 0,
  ) {
    const group = this.authorize(destination, groupId);
    const defaults = group.worker ?? this.daddy.engine.defaultAgents().worker;
    const task = taskId ? this.store.getTask(taskId) : undefined;
    if (task && task.groupId !== groupId)
      throw new AppError('task_scope', 'Task does not belong to this session', 403);
    const architect = task?.architectProfile ?? group.architectProfile ?? group.daddy;
    const text = new TelegramText()
      .add('🤖 ' + this.t('Models'), 'bold')
      .add('\n\ndaddy: ')
      .add(group.daddy.model ?? this.t('Engine configuration'), 'code')
      .add(' / ' + (group.daddy.effort ?? this.t('Default')))
      .add('\n' + this.t('All workers') + ': ')
      .add(defaults.model ?? this.t('Engine configuration'), 'code')
      .add(' / ' + (defaults.effort ?? this.t('Default')));
    text.add('\n' + this.t('Architect') + ' · ' + profileText(architect));
    if (task) text.add(' · ' + taskReference(task));
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
          [{ text: this.t('Architect'), callback_data: `dad:models:${groupId}:architect` }],
          [{ text: this.t('Back'), callback_data: `dad:open:${groupId}` }],
        ],
      });
      return;
    }
    const models = await this.daddy.catalogue.list(page === 0);
    this.authorize(destination, groupId);
    const pageSize = 30;
    page = Math.min(page, Math.max(0, Math.ceil(models.length / pageSize) - 1));
    const buttons = models.slice(page * pageSize, (page + 1) * pageSize).map((model) => {
      const id = 'dad-model:' + randomBytes(12).toString('base64url');
      this.store.db.prepare('INSERT INTO bot_actions(id,data) VALUES(?,?)').run(
        id,
        JSON.stringify({
          groupId,
          role,
          taskId,
          ownerId: this.pair()!.userId,
          generation: group.generation,
          baseline:
            role === 'architect'
              ? task
                ? task.architectProfile
                : group.architectProfile
              : role === 'daddy'
                ? group.daddy
                : defaults,
          ...(task
            ? {
                expectedTask: {
                  head: task.revision?.head ?? '',
                  revision: task.revision,
                  generation: task.generation,
                  groupId,
                },
              }
            : {}),
          model,
          chatId: destination.chatId,
          threadId: destination.threadId,
          expiresAt: new Date(Date.now() + 10 * 60000).toISOString(),
        }),
      );
      return [{ text: model.engine + ' · ' + model.name, callback_data: id }];
    });
    if (role === 'architect')
      buttons.unshift([
        {
          text: this.t(
            task ? 'Use the session architect profile' : 'Use the shared reviewer profile',
          ),
          callback_data: `dad:arch-reset:${task ? 't' : 'g'}:${task?.id ?? groupId}`,
        },
      ]);
    if (models.length > pageSize) {
      const prefix = task ? `dad:arch-task:${task.id}` : `dad:models:${groupId}:${role}`;
      const pages = [];
      if (page > 0)
        pages.push({ text: this.t('Previous page'), callback_data: `${prefix}:${page - 1}` });
      if ((page + 1) * pageSize < models.length)
        pages.push({ text: this.t('Next page'), callback_data: `${prefix}:${page + 1}` });
      buttons.push(pages);
    }
    await this.api.send(
      destination,
      this.scopedCard(destination, { ...text, buttons }, group, task),
    );
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
      const groupId = choice.groupId;
      if (groupId) {
        this.authorize(destination, groupId);
        this.mutate(() => {
          this.store.setSetting(key, null);
          this.store.setSetting(this.repoKey(destination, groupId), {
            workspace: selected,
            expiresAt: choice.expiresAt,
          });
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
    const match = data.match(/^dad:limits(?::(refresh|prepare|consume)(?::([a-z0-9_-]{1,42}))?)?$/);
    if (!match) throw new Error('Unknown limits action');
    if (destination.chatId !== this.pair()?.chatId && match[1] === 'prepare') {
      const key = this.actionKey(
        { chatId: this.pair()!.chatId },
        {
          kind: 'reset-engine',
          engine: match[2],
          source: destination,
          groupId: this.groupAt(destination),
        },
      );
      await this.privateLink(destination, 'reset_' + key);
      return;
    }
    if (destination.chatId !== this.pair()?.chatId && match[1] === 'consume')
      throw new Error(this.t('This action expired. Open a fresh card.'));
    const owner = `telegram:${this.pair()!.userId}:${destination.chatId}:${destination.threadId ?? 0}`;
    if (match[1] === 'prepare') {
      const engine = match[2];
      const provider =
        engine && (await this.usage.read()).agents.find((agent) => agent.engine === engine);
      const plan = await this.usage.prepare(owner, engine);
      await this.api.send(destination, {
        ...new TelegramText()
          .add('↻ ' + this.t('Use a reset'), 'bold')
          .add('\n\n' + (provider ? provider.name + ' · ' : '') + this.t(plan.title))
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
        ...usage.agents
          .filter((agent) => agent.resets.canUse)
          .map((agent) => [
            {
              text:
                agent.name +
                ' · ' +
                this.t(agent.resets.pending ? 'Resolve pending reset' : 'Use a reset'),
              callback_data: 'dad:limits:prepare:' + agent.engine,
            },
          ]),
        [{ text: this.t('Refresh limits'), callback_data: 'dad:limits:refresh' }],
      ],
    });
  }
  private creationKey(destination: Destination) {
    const pair = this.pair()!,
      key = `telegram.newSession:${pair.userId}:${destination.chatId}:${destination.threadId ?? 0}`;
    return key;
  }
  async callback(
    data: string,
    destination: Destination,
    verified?: CardAction,
    deleteSource?: Destination,
  ): Promise<boolean> {
    const scoped = /^dad:a:([A-Za-z0-9_-]{16})$/.exec(data);
    if (scoped) {
      const key = scoped[1];
      return this.daddy.engine.lock('telegram:' + key, async () => {
        const action = this.readAction<CardAction>(key, destination);
        if (action.kind !== 'card') throw new Error('Invalid card action');
        const group = this.authorize(destination, action.groupId);
        const task = action.taskId ? this.daddy.task(group.id, action.taskId) : undefined;
        if (
          group.generation !== action.generation ||
          (task &&
            (task.generation !== action.taskGeneration ||
              ((task.revision || action.revision) &&
                !sameRevision(task.revision, action.revision)))) ||
          this.cardSettings(group, action.data, task) !== action.settings
        )
          throw new Error(this.t('This action expired. Open a fresh card.'));
        const handled = await this.callback(action.data, destination, action);
        if (handled) this.finishAction(key);
        return handled;
      });
    }
    if (!verified && guardedCallback.test(data))
      throw new Error(this.t('This action expired. Open a fresh card.'));

    const language = data.match(/^language:(en|ru|show)$/);
    if (language) {
      if (language[1] !== 'show')
        this.mutate(() => setLocale(this.store, language[1] as 'en' | 'ru'));
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
      if (notification[1] !== 'show')
        this.mutate(() => this.store.setSetting('notifications.telegram', value));
      await this.api.send(destination, notificationsCard(value, this.locale()));
      return true;
    }
    if (data.startsWith('dad:limits')) {
      await this.limits(destination, data);
      return true;
    }
    if (await this.repositoryCallback(data, destination)) return true;
    const queue = data.match(/^dad:(queue|workers):([a-f0-9-]{36})(?::(\d{1,10}))?$/);
    if (queue) {
      await this.showTasks(
        queue[2]!,
        destination,
        queue[1] as 'queue' | 'workers',
        Number(queue[3] ?? 0),
      );
      return true;
    }
    const sessionMerge = /^dad:sm:([a-f0-9-]{36}):(on|off)$/.exec(data);
    if (sessionMerge) {
      const id = sessionMerge[1]!;
      this.authorize(destination, id);
      const board = await this.settings(id, {
        autoMerge: sessionMerge[2] === 'on',
        expectedGeneration: verified?.generation,
        baseline: { autoMerge: verified?.settings === 'true' },
      });
      await this.api.send(
        destination,
        this.scopedCard(destination, sessionSettings(this.locale(), board), board.group),
      );
      return true;
    }
    const taskMerge = /^dad:tm:([a-f0-9-]{36}):(on|off|inherit)(?::(\d{1,10}))?$/.exec(data);
    if (taskMerge) {
      const task = this.store.getTask(taskMerge[1]!);
      if (!task.groupId) throw new AppError('wrong_session', 'Task not found in this session', 404);
      this.authorize(destination, task.groupId);
      this.daddy.taskAutoMerge(task.groupId, task.id, taskMerge[2] as 'on' | 'off' | 'inherit');
      await this.showTask(task.groupId, task.id, destination, Number(taskMerge[3] ?? 0));
      return true;
    }
    const confirmation = /^dad:vm:([A-Za-z0-9_-]{16})$/.exec(data);
    if (confirmation) {
      await this.confirmTask(confirmation[1], destination);
      return true;
    }
    const task = data.match(/^dad:task:([a-f0-9-]{36})(?::(\d{1,10}))?$/);
    if (task) {
      const { groupId } = this.store.getTask(task[1]!);
      if (!groupId) throw new AppError('wrong_session', 'Task not found in this session', 404);
      await this.showTask(groupId, task[1]!, destination, Number(task[2] ?? 0));
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
        role: 'worker' | 'daddy' | 'architect';
        taskId?: string;
        ownerId: number;
        generation: number;
        baseline?: AgentProfile;
        expectedTask?: ExpectedTask;
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
        action.ownerId !== this.pair()?.userId ||
        action.chatId !== destination.chatId ||
        action.threadId !== destination.threadId ||
        action.expiresAt <= now()
      )
        throw new Error(this.t('This model selection expired. Open Models again.'));
      const group = this.authorize(destination, action.groupId);
      if (action.generation !== group.generation)
        throw new Error(this.t('This model selection expired. Open Models again.'));
      if (modelAction[2] === undefined) {
        const text = new TelegramText()
          .add(action.model.name, 'bold')
          .add('\n\n' + this.t('Reasoning effort'));
        await this.api.send(destination, {
          ...text,
          buttons: (action.model.efforts.length ? action.model.efforts : [this.t('Default')]).map(
            (effort, index) => [
              { text: effort, callback_data: `${key}:${index}` },
              ...(action.role === 'daddy'
                ? [
                    {
                      text: this.t('Apply now · {effort}', { effort }),
                      callback_data: `${key}:${index}:force`,
                    },
                  ]
                : []),
            ],
          ),
        });
      } else {
        const effort = action.model.efforts[Number(modelAction[2])];
        if (!effort && (action.model.efforts.length || modelAction[2] !== '0'))
          throw new Error('Unsupported reasoning effort');
        const profile = { engine: action.model.engine, model: action.model.id, effort };
        if (action.role === 'architect') {
          if (action.taskId) {
            if (!action.expectedTask)
              throw new Error(this.t('This model selection expired. Open Models again.'));
            await this.daddy.taskArchitect(group.id, action.taskId, profile, undefined, {
              task: action.expectedTask,
              groupGeneration: action.generation,
              architectProfile: action.baseline ?? null,
            });
          } else
            await this.settings(group.id, {
              architectProfile: profile,
              expectedGeneration: action.generation,
              baseline: { architectProfile: action.baseline ?? null },
            });
        } else
          await this.settings(group.id, {
            expectedGeneration: action.generation,
            baseline: { profiles: { [action.role]: action.baseline } },
            profiles: {
              [action.role]: profile,
            },
            forceDaddy: action.role === 'daddy' && modelAction[3] === ':force',
            applyWorkers: action.role === 'worker',
          });
        this.store.db.prepare('UPDATE bot_actions SET consumed=1 WHERE id=?').run(key);
        if (action.taskId) await this.showTask(group.id, action.taskId, destination);
        else await this.models(group.id, destination);
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
        const board = this.daddy.board(id);
        await this.api.send(
          destination,
          this.scopedCard(destination, sessionSettings(this.locale(), board), board.group),
        );
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
    const force = /^dad:force:([A-Za-z0-9_-]{16})$/.exec(data);
    if (force) {
      const key = force[1];
      const action = this.readAction<{
        kind: string;
        groupId: string;
        number: number;
        profile: AgentProfile;
        baseline?: AgentProfile;
        inheritedEffort?: boolean;
        taskId: string;
        groupGeneration: number;
        expected: ExpectedTask;
      }>(key, destination);
      if (action.kind !== 'force-worker' || !action.baseline)
        throw new Error(this.t('This action expired. Open a fresh card.'));
      await this.daddy.configureWorker(action.groupId, action.number, action.profile, {
        force: true,
        expectedTaskId: action.taskId,
        expectedGeneration: action.groupGeneration,
        baseline: action.baseline,
        inheritedEffort: action.inheritedEffort,
        onCommit: () => {
          this.finishAction(key);
          this.receipt();
        },
        check: () => {
          this.authorize(destination, action.groupId);
          this.readAction(key, destination);
          assertTaskVersion(this.daddy.task(action.groupId, action.taskId), action.expected);
        },
      });
      await this.showTasks(action.groupId, destination, 'workers');
      return true;
    }
    const deleteConfirmation = /^dad:dc:([A-Za-z0-9_-]{16})$/.exec(data);
    if (deleteConfirmation) {
      const key = deleteConfirmation[1];
      const action = this.readAction<{
        kind: string;
        groupId: string;
        generation: number;
        source: Destination;
      }>(key, destination);
      if (action.kind !== 'delete-confirm') throw new Error('Invalid deletion confirmation');
      this.authorize(destination, action.groupId);
      await this.daddy.remove(
        action.groupId,
        action.generation,
        () => {
          const current = this.readAction<typeof action>(key, destination);
          this.authorize(current.source, current.groupId);
        },
        () => {
          this.finishAction(key);
          this.receipt();
        },
      );
      await this.api.send(destination, this.t('Session deletion requested.'));
      return true;
    }
    const deleting = data.match(/^dad:delete:([a-f0-9-]{36})$/);
    if (deleting) {
      const group = this.authorize(destination, deleting[1]);
      if (destination.chatId !== this.pair()?.chatId) {
        const key = this.actionKey(
          { chatId: this.pair()!.chatId },
          {
            kind: 'delete-handoff',
            source: destination,
            groupId: group.id,
            generation: group.generation,
          },
        );
        await this.privateLink(destination, 'delete_' + key);
        return true;
      }
      if (!this.daddy.board(group.id).canDelete)
        throw new Error(this.t('This repository module does not support managed session deletion'));
      {
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
                callback_data:
                  'dad:dc:' +
                  this.actionKey(destination, {
                    kind: 'delete-confirm',
                    source: deleteSource ?? destination,
                    groupId: group.id,
                    generation: group.generation,
                  }),
              },
            ],
            [{ text: this.t('Cancel'), callback_data: `dad:open:${group.id}` }],
          ],
        });
      }
      return true;
    }
    const taskArchitect = data.match(/^dad:arch-task:([a-f0-9-]{36})(?::(\d{1,8}))?$/);
    if (taskArchitect) {
      const task = this.store.getTask(taskArchitect[1]);
      if (!task.groupId) throw new Error('Task has no session');
      await this.models(
        task.groupId,
        destination,
        'architect',
        task.id,
        Number(taskArchitect[2] ?? 0),
      );
      return true;
    }
    const resetArchitect = data.match(/^dad:arch-reset:(t|g):([a-f0-9-]{36})$/);
    if (resetArchitect) {
      const task = resetArchitect[1] === 't' ? this.store.getTask(resetArchitect[2]) : undefined;
      const group = this.authorize(destination, task?.groupId ?? resetArchitect[2]);
      if (task) {
        await this.daddy.taskArchitect(group.id, task.id, null, undefined, {
          task: {
            groupId: group.id,
            generation: task.generation,
            head: task.revision?.head ?? '',
            revision: task.revision,
          },
          groupGeneration: group.generation,
          architectProfile: task.architectProfile ?? null,
        });
        await this.showTask(group.id, task.id, destination);
      } else {
        await this.settings(group.id, {
          architectProfile: null,
          expectedGeneration: group.generation,
          baseline: { architectProfile: group.architectProfile ?? null },
        });
        await this.models(group.id, destination);
      }
      return true;
    }
    const models = data.match(
      /^dad:models:([a-f0-9-]{36})(?::(worker|daddy|architect)(?::(\d{1,8}))?)?$/,
    );
    if (models) {
      await this.models(
        models[1],
        destination,
        models[2] as 'worker' | 'daddy' | 'architect' | undefined,
        undefined,
        Number(models[3] ?? 0),
      );
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
      if (limit)
        await this.settings(id, {
          workerLimit: Number(limit),
          expectedGeneration: verified?.generation,
          baseline: { workerLimit: Number(verified?.settings) },
        });
      const board = this.daddy.board(id);
      await this.api.send(
        destination,
        this.scopedCard(destination, poolCard(this.locale(), board), board.group),
      );
      return true;
    }
    if (action === 'pause') await this.daddy.pause(id, verified?.generation, this.receipt);
    if (action === 'resume') await this.daddy.resume(id, verified?.generation, this.receipt);
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
  private readonly update = new AsyncLocalStorage<{
    id: number;
    destination?: TelegramOperationResult;
    action?: string;
    pendingKey?: string;
    expectedGeneration?: number;
    expectedConcurrency?: number;
    instructionTarget?: InstructionTarget;
    expectedAgent?: { role: 'daddy' | 'worker'; profile: AgentProfile };
    checkRoute?: () => void;
  }>();

  private receipt = () => {
    const context = this.update.getStore();
    if (!context) return;
    context.checkRoute?.();
    commitTelegramOperation(this.store, context.id, context.destination);
    if (context.action) this.finishAction(context.action);
    if (context.pendingKey) this.store.setSetting(context.pendingKey, null);
  };

  private mutate<T>(change: () => T): T {
    return this.store.transaction(() => {
      const result = change();
      this.receipt();
      return result;
    });
  }

  private settings(groupId: string, input: Parameters<Daddy['settings']>[1]) {
    return this.daddy.settings(
      groupId,
      { expectedGeneration: this.update.getStore()?.expectedGeneration, ...input },
      this.receipt,
    );
  }

  async handle(update: Update): Promise<boolean> {
    return this.update.run(
      { id: update.update_id, destination: operationDestination(update) },
      () => this.handleMessage(update),
    );
  }

  private async handleMessage(update: Update): Promise<boolean> {
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
    const replyTo = telegramReply(message);
    let replyGroup =
      privateChat && replyTo?.messageId && !message?.text?.trimStart().startsWith('/')
        ? this.api.delivery?.replySession(chat.id, replyTo.messageId, pair.userId)
        : undefined;
    try {
      const parent = message?.reply_to_message;
      if (parent?.chat.id === chat.id && !message?.text?.trimStart().startsWith('/')) {
        const question = this.validateQuestionReply(destination, parent.message_id, pair.userId);
        if (question && privateChat) replyGroup = question.groupId;
        if (question && 'taskId' in question && replyTo) replyTo.taskId = question.taskId;
      }
      const external = message?.external_reply;
      if (external?.chat && external.message_id && !message?.text?.trimStart().startsWith('/')) {
        const receipt = this.api.delivery?.replyReceipt(
          external.chat.id,
          external.message_id,
          pair.userId,
        );
        if (this.questionForReceipt(receipt, pair.userId))
          throw new Error(this.t('This question has expired or belongs to a different topic.'));
      }
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
          const operation = /^dad:private:([A-Za-z0-9_-]{16})$/.exec(callback.data!);
          const choice = /^dad:choose:([A-Za-z0-9_-]{16})$/.exec(callback.data!);
          if (operation && privateChat)
            await this.handleMessage({
              update_id: update.update_id,
              message: { chat, from, text: '/start confirm_' + operation[1] },
            });
          else if (choice) {
            const action = this.readAction<{
              kind: string;
              groupId: string;
              update: Update;
              pendingKey: string;
              generation: number;
            }>(choice[1], destination);
            if (
              action.kind !== 'choose-session' ||
              this.store.setting<{ update: Update }>(action.pendingKey)?.update.update_id !==
                action.update.update_id
            )
              throw new Error(this.t('This action expired. Open a fresh card.'));
            await this.runSelected(action.update, action.groupId, destination, action.generation);
            this.finishAction(choice[1]);
          } else await this.callback(callback.data!, destination);
        });
        return true;
      }
      if (privateChat && message?.chat_shared) {
        await this.bind(message.chat_shared);
        return true;
      }
      if (message?.document) {
        if (!privateChat)
          await this.offerPrivateOperation(
            destination,
            message.caption ?? '',
            false,
            message.document,
          );
        else await this.instructionFile(message, destination);
        return true;
      }
      if (message?.voice) {
        if (!this.voice)
          throw new Error(this.t('Voice recognition is unavailable on this server.'));
        const pending = this.store.setting<{ expiresAt: string }>(this.creationKey(destination));
        const route = this.voiceRoute(destination, replyGroup);
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
            {
              fileId: message.voice!.file_id,
              duration: message.voice!.duration,
              replyTo,
              messageId: message.message_id,
            },
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
      const text = message?.text?.trim();
      if (!text) return false;
      const help = /^\/help(?:\s+([\s\S]*))?$/i.exec(text);
      if (help) {
        await this.api.send(
          destination,
          commandHelp(this.locale(), privateChat ? 'private' : 'group', help[1]),
        );
        return true;
      }
      const waiver = /^\/waive ([A-Za-z0-9_-]{16}) ([\s\S]{1,2000})$/.exec(text);
      const handoff = /^\/start waive_([A-Za-z0-9_-]{16})$/.exec(text);
      if (privateChat && (waiver || handoff)) {
        await this.confirmTask((waiver ?? handoff)![1], destination, waiver?.[2].trim());
        return true;
      }
      const deleteHandoff = /^\/start delete_([A-Za-z0-9_-]{16})$/.exec(text);
      if (privateChat && deleteHandoff) {
        const key = deleteHandoff[1];
        const action = this.readAction<{
          kind: string;
          groupId: string;
          generation: number;
          source: Destination;
        }>(key, destination);
        if (
          action.kind !== 'delete-handoff' ||
          this.daddy.group(action.groupId).generation !== action.generation
        )
          throw new Error(this.t('This action expired. Open a fresh card.'));
        this.authorize(action.source, action.groupId);
        await this.callback('dad:delete:' + action.groupId, destination, undefined, action.source);
        this.finishAction(key);
        return true;
      }
      const sensitive =
        /^\/(export|agents|concurrency|preset_remove|preset_export|workspace_defaults|skill_source)(?:\s|$)/.exec(
          text,
        );
      const reset = /^\/start reset_([A-Za-z0-9_-]{16})$/.exec(text);
      if (privateChat && reset) {
        const action = this.readAction<{
          kind: string;
          engine?: string;
          source: Destination;
          groupId?: string;
        }>(reset[1], destination);
        if (
          action.kind !== 'reset-engine' ||
          this.room()?.chatId !== action.source.chatId ||
          this.groupAt(action.source) !== action.groupId
        )
          throw new Error(this.t('This action expired. Open a fresh card.'));
        await this.limits(
          destination,
          'dad:limits:prepare' + (action.engine ? ':' + action.engine : ''),
        );
        this.finishAction(reset[1]);
        return true;
      }
      const privateOperation = /^\/start (operation|confirm)_([A-Za-z0-9_-]{16})$/.exec(text);
      if (privateChat && privateOperation) {
        const [, step, key] = privateOperation;
        const action = this.readAction<{
          kind: string;
          source: Destination;
          text: string;
          groupId?: string;
          readOnly: boolean;
          document?: NonNullable<Update['message']>['document'];
          confirmation?: boolean;
          expectedConcurrency?: number;
          instructionTarget?: InstructionTarget;
          expectedAgent?: { role: 'daddy' | 'worker'; profile: AgentProfile };
        }>(key, destination);
        if (action.kind !== 'private-operation')
          throw new Error(this.t('This action expired. Open a fresh card.'));
        const checkRoute = () => {
          this.readAction(key, destination);
          if (
            this.room()?.chatId !== action.source.chatId ||
            this.groupAt(action.source) !== action.groupId
          )
            throw new Error(this.t('This action expired. Open a fresh card.'));
        };
        checkRoute();
        if (step === 'operation' && !action.readOnly) {
          const expectedConcurrency = /^\/concurrency [1-8]$/.test(action.text)
            ? this.daddy.maxConcurrentAgents()
            : undefined;
          const id =
            action.document &&
            /^\/(?:import|skill_file) ([a-f0-9-]{8,36})(?:\s|$)/.exec(action.text)?.[1];
          const group = id ? this.findSession(id) : undefined;
          const instructionTarget = group
            ? { id: group.id, generation: group.generation, instructions: group.instructions }
            : undefined;
          const role = /^\/agents (daddy|worker)\s/.exec(action.text)?.[1] as
            'daddy' | 'worker' | undefined;
          const expectedAgent = role
            ? { role, profile: this.daddy.engine.defaultAgents()[role] }
            : undefined;
          const confirmKey = this.actionKey(destination, {
            ...action,
            confirmation: true,
            expectedConcurrency,
            instructionTarget,
            expectedAgent,
          });
          this.finishAction(key);
          const card = new TelegramText().add(action.text, 'code');
          if (expectedAgent) card.add('\n' + profileText(expectedAgent.profile));
          if (group) card.add('\n' + group.title);
          if (action.document?.file_name) card.add('\n' + action.document.file_name);
          if (expectedConcurrency !== undefined)
            card.add('\n' + this.t('Agent concurrency') + ' · ' + expectedConcurrency);
          await this.api.send(destination, {
            ...card,
            buttons: [[{ text: this.t('Confirm'), callback_data: 'dad:private:' + confirmKey }]],
          });
          return true;
        }
        if (!action.readOnly && !action.confirmation)
          throw new Error(this.t('This action expired. Open a fresh card.'));
        await this.update.run(
          {
            ...this.update.getStore(),
            id: update.update_id,
            action: key,
            expectedConcurrency: action.expectedConcurrency,
            instructionTarget: action.instructionTarget,
            expectedAgent: action.expectedAgent,
            checkRoute,
          },
          () =>
            this.handleMessage({
              ...update,
              message: {
                ...message!,
                text: action.document ? undefined : action.text,
                caption: action.document ? action.text : undefined,
                document: action.document,
              },
            }),
        );
        this.finishAction(key);
        return true;
      }
      if (!privateChat && sensitive) {
        await this.offerPrivateOperation(
          destination,
          text,
          /^(export|preset_export)$/.test(sensitive[1]) || text === '/' + sensitive[1],
        );
        return true;
      }
      const workspaceSnapshots = 'telegram.workspaceDefaults:' + pair.userId;
      if (privateChat && ['/workspace_defaults', '/start workspace_defaults'].includes(text)) {
        const workspaces = this.daddy.workspaces.list();
        this.store.setSetting(workspaceSnapshots, workspaces);
        await this.api.send(
          destination,
          [
            '/workspace_defaults ID UPDATED_AT {"base":"main"}',
            ...workspaces.map(
              (workspace) => `${workspace.name} · ${workspace.id} · ${workspace.updatedAt}`,
            ),
          ].join('\n'),
        );
        return true;
      }
      const defaultsEdit = /^\/workspace_defaults ([a-f0-9-]{36}) (\S+) ([\s\S]+)$/.exec(text);
      if (privateChat && defaultsEdit) {
        const current = this.daddy.workspaces.get(defaultsEdit[1]);
        const snapshot =
          this.store
            .setting<Workspace[]>(workspaceSnapshots)
            ?.find((item) => item.id === current.id && item.updatedAt === defaultsEdit[2]) ??
          (current.updatedAt === defaultsEdit[2] ? current : undefined);
        if (!snapshot) throw new Error('This workspace changed. Reload it before saving.');
        const baseline = this.daddy.workspaces.defaults(snapshot);
        const input = workspaceSchema.partial().parse(JSON.parse(defaultsEdit[3]));
        const saved = await this.daddy.workspaces.register(
          { ...baseline, ...input },
          current.id,
          baseline,
          this.receipt,
        );
        await this.api.send(destination, this.t('Settings saved.') + ' · ' + saved.updatedAt);
        return true;
      }
      if (privateChat && text === '/start instructions') {
        await this.api.send(
          destination,
          this.t('Use /help export and /help presets in the private bot chat.'),
        );
        return true;
      }
      if (privateChat && (text === '/agents' || text === '/start agents')) {
        const defaults = this.daddy.engine.defaultAgents();
        await this.api.send(
          destination,
          [
            'daddy · ' + profileText(defaults.daddy),
            this.t('Worker') + ' · ' + profileText(defaults.worker),
            this.t('Agent concurrency') + ' · ' + this.daddy.maxConcurrentAgents(),
            '/agents daddy|worker ENGINE [MODEL [EFFORT]]',
            '/concurrency 1..8',
          ].join('\n'),
        );
        return true;
      }
      const agent = /^\/agents (daddy|worker) (\S+)(?: (\S+)(?: (\S+))?)?$/.exec(text);
      if (privateChat && agent) {
        const role = agent[1] as 'daddy' | 'worker';
        const profile = profileSchema.parse({
          engine: agent[2],
          model: agent[3],
          effort: agent[4],
        });
        const shown = this.update.getStore()?.expectedAgent;
        const baseline =
          shown?.role === role ? shown.profile : this.daddy.engine.defaultAgents()[role];
        await this.daddy.catalogue.validate(profile);
        const current = this.daddy.engine.defaultAgents();
        if (!sameAgentProfile(baseline, current[role]))
          throw new AppError(
            'settings_conflict',
            'Agent settings changed. Open a fresh confirmation.',
            409,
          );
        this.mutate(() => this.daddy.engine.setDefaultAgents({ ...current, [role]: profile }));
        await this.api.send(destination, this.t('Settings saved.'));
        return true;
      }
      const concurrency = /^\/concurrency ([1-8])$/.exec(text);
      if (privateChat && concurrency) {
        this.mutate(() => {
          const expected = this.update.getStore()?.expectedConcurrency;
          const next = Number(concurrency[1]);
          const current = this.daddy.maxConcurrentAgents();
          if (expected !== undefined && expected !== current && next !== current)
            throw new AppError(
              'settings_conflict',
              'Settings changed. Reload before editing agent concurrency',
              409,
            );
          this.store.setSetting('worker.maxAgents', next);
        });
        await this.api.send(destination, this.t('Settings saved.'));
        return true;
      }
      const session = /^\/session(?: ([a-f0-9-]{8,36}))?$/.exec(text);
      if (session) {
        const pendingKey = this.creationKey(destination) + ':command';
        const pending = this.store.setting<{ update: Update; expiresAt: number }>(pendingKey);
        if (session[1] && pending && pending.expiresAt > Date.now()) {
          await this.runSelected(pending.update, this.findSession(session[1]).id, destination);
          return true;
        }
        if (!session[1]) await this.home(destination);
        else if (privateChat) await this.show(this.findSession(session[1]).id, destination);
        else await this.callback('dad:open:' + this.findSession(session[1]).id, destination);
        return true;
      }
      const exported = /^\/export ([a-f0-9-]{8,36})$/.exec(text);
      if (privateChat && exported) {
        const group = this.authorize(destination, this.findSession(exported[1]).id);
        await this.api.sendInstructions(
          destination.chatId,
          group.instructions ?? { daddy: {}, worker: {} },
        );
        return true;
      }
      const presetAdmin = /^\/preset_(export|remove) ([a-f0-9-]{8,36})(?: (\d+))?$/.exec(text);
      if (privateChat && presetAdmin) {
        const library = new InstructionPresets(this.store);
        const preset = findPreset(library.list(), presetAdmin[2]);
        if (presetAdmin[1] === 'export')
          await this.api.sendInstructions(destination.chatId, library.get(preset.id).instructions);
        else {
          if (!presetAdmin[3]) throw new Error('Provide the preset revision shown in /presets.');
          library.remove(preset.id, Number(presetAdmin[3]), this.receipt);
          await this.api.send(destination, this.t('Preset deleted.'));
        }
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
        this.mutate(() => setLocale(this.store, language[1] as 'en' | 'ru'));
        await this.api.send(destination, this.t('Language updated.'));
        return true;
      }
      const notifications = /^\/notifications(?: (on|off|all))?$/.exec(text);
      if (notifications)
        return await this.callback('notifications:' + (notifications[1] ?? 'show'), destination);
      const privateCommand = /^\/(cleanup|updates|group|web)(?:\s|$)/.exec(text);
      if (privateCommand && !privateChat) {
        await this.privateLink(destination, privateCommand[1]);
        return true;
      }
      if (text === '/limits' || (privateChat && text === '/start limits')) {
        await this.limits(destination);
        return true;
      }
      if (privateChat && ['/group', '/start group'].includes(text)) {
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
        ? (replyGroup ?? this.store.setting<string>('telegram.currentDaddy'))
        : this.groupAt(destination);
      const creation = this.store.setting<{ workspaceId?: string; expiresAt: string }>(
        this.creationKey(destination),
      );
      if (
        !groupId &&
        !(text.startsWith('/repo') && creation?.workspaceId && creation.expiresAt > now()) &&
        /^\/(task|queue|workers|worker|rename|pool|repo|instructions|skill|preset|preset_parts|status|pause|resume)(?:\s|$)/.test(
          text,
        )
      ) {
        await this.showSessionChoices(update, destination);
        return true;
      }
      const task = taskCommands.exec(text);
      if (task) {
        if (!groupId) throw new Error(this.t('Start a daddy session first.'));
        await this.taskCommand(
          task[1]!,
          task[2] ?? '',
          groupId,
          destination,
          `telegram:${task[1]}:${chat.id}:${message?.message_id ?? update.update_id}`,
          replyTo,
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
        const board = this.mutate(() => this.daddy.rename(groupId, rename[1]));
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
          this.mutate(() => this.store.setSetting(this.repoKey(destination, groupId), null));
          await this.api.send(destination, this.t('Using workspace defaults'));
          return true;
        }
        if (!creating && !groupId) throw new Error(this.t('Start a daddy session first.'));
        if (!creating) this.authorize(destination, groupId!);
        const supplied = repo[1]?.trim();
        const input =
          supplied && supplied !== 'default'
            ? supplied.startsWith('{')
              ? repositorySelectionSchema.parse(JSON.parse(supplied))
              : { path: supplied }
            : undefined;
        await this.repository({
          destination,
          ownerId: pair.userId,
          groupId: creating ? undefined : groupId,
          workspace: creating
            ? this.daddy.workspaces.get(creating)
            : this.daddy.board(groupId!).workspace!,
          input,
          creationExpiresAt: creating ? pending!.expiresAt : undefined,
          expiresAt: new Date(Date.now() + 10 * 60000).toISOString(),
        });
        return true;
      }
      if (text === '/models' && groupId) {
        await this.models(groupId, destination);
        return true;
      }
      const skillSource = /^\/skill_source ([a-f0-9-]{8,36}) (daddy|worker) ([\s\S]+)$/.exec(text);
      if (skillSource && privateChat) {
        const group = this.authorize(destination, this.findSession(skillSource[1]).id);
        const source = instructionSourceSchema.parse(JSON.parse(skillSource[3]));
        const instructions = await instructionCommand(
          '/skill ' + skillSource[2] + ' source',
          group.instructions,
          () => new InstructionSources().import(source),
        );
        await this.settings(group.id, {
          instructions,
          expectedGeneration: group.generation,
          baseline: { instructions: group.instructions ?? null },
        });
        await this.api.send(destination, this.t('Instructions saved.'));
        return true;
      }
      if (/^\/(instructions|skill)(?:\s|$)/.test(text)) {
        if (!groupId) throw new Error(this.t('Start a daddy session first.'));
        this.authorize(destination, groupId);
        const baseline = this.daddy.group(groupId).instructions;
        const instructions = await instructionCommand(text, baseline, (url) =>
          new InstructionSources().import({ kind: 'github', url }),
        );
        if (instructions)
          await this.settings(groupId, {
            instructions,
            baseline: { instructions: baseline ?? null },
          });
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
          new TelegramText().add('🧩 ' + this.t('Presets'), 'bold').add(
            '\n\n' +
              (privateChat
                ? new InstructionPresets(this.store)
                    .list()
                    .map((item) => `${item.name} · ${item.id} · ${item.revision}`)
                    .join('\n')
                : presetLines(new InstructionPresets(this.store).list(), this.locale()).join('\n')),
          ),
        );
        return true;
      }
      const components = /^\/preset_parts ([a-f0-9-]{8,36})(?: ([0-9,]+|all|off))?$/.exec(text);
      if (components) {
        if (!groupId) throw new Error(this.t('Start a daddy session first.'));
        const group = this.authorize(destination, groupId);
        const selected = findPreset(
          group.instructions?.presets?.map((item) => item.preset) ?? [],
          components[1],
        );
        const parts = presetParts(selected);
        if (!components[2]) {
          await this.api.send(
            destination,
            parts
              .map((part, index) => `${index + 1}. ${part.role} · ${part.name || part.kind}`)
              .join('\n'),
          );
          return true;
        }
        const indexes =
          components[2] === 'all' || components[2] === 'off'
            ? []
            : components[2].split(',').map(Number);
        if (indexes.some((index) => index < 1 || index > parts.length))
          throw new Error('Choose existing preset components');
        const instructions = group.instructions!;
        await this.settings(group.id, {
          baseline: { instructions },
          instructions: {
            ...instructions,
            presets: instructions.presets!.map((item) =>
              item.preset.id !== selected.id
                ? item
                : {
                    ...item,
                    enabled: components[2] !== 'off',
                    omit:
                      components[2] === 'off'
                        ? item.omit
                        : indexes.length
                          ? parts
                              .filter((_, index) => !indexes.includes(index + 1))
                              .map((part) => part.key)
                          : [],
                  },
            ),
          },
        });
        await this.api.send(destination, this.t('Settings saved.'));
        return true;
      }
      const presetName = text.match(/^\/preset\s+(.+)$/)?.[1];
      if (presetName) {
        if (!groupId) throw new Error(this.t('Start a daddy session first.'));
        this.authorize(destination, groupId);
        const library = new InstructionPresets(this.store),
          preset = library.get(findPreset(library.list(), presetName).id);
        const baseline = this.daddy.group(groupId).instructions;
        await this.settings(groupId, {
          instructions: selectPreset(baseline, preset),
          baseline: { instructions: baseline ?? null },
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
        this.authorize(destination, groupId);
        if (pool[1]) await this.settings(groupId, { workerLimit: Number(pool[1]) });
        return await this.callback(`dad:pool:${groupId}`, destination);
      }
      if (text === '/status' && groupId) {
        await this.showStatus(groupId, destination);
        return true;
      }
      if (text === '/pause' && groupId) {
        await this.daddy.pause(groupId, this.update.getStore()?.expectedGeneration, this.receipt);
        await this.show(groupId, destination);
        return true;
      }
      if (text === '/resume' && groupId) {
        await this.daddy.resume(groupId, this.update.getStore()?.expectedGeneration, this.receipt);
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
      const route = this.voiceRoute(destination, replyGroup);
      if (route && this.voice?.pending(route)) {
        this.store.transaction(() => {
          if (
            this.voice!.enqueue(
              `telegram:${chat.id}:${message?.message_id ?? update.update_id}`,
              route,
              { text, replyTo, messageId: message?.message_id },
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
        messageId: message?.message_id,
        replyTo,
        ...destination,
      });
      if (next) this.store.setSetting(nextKey, null);
      return true;
    } catch (error) {
      const context = this.update.getStore();
      if (context && this.store.setting(resultKey(context.id))) throw error;
      if (context?.pendingKey && error instanceof AppError && error.code === 'stale_session')
        throw error;
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
  private queueTaskRequest(task: Task, event: Event) {
    const request = taskRequestKey(this.store, task);
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
        const { taskId, request, messageId, reminder } = event.data as {
          reminder?: boolean;
          taskId?: string;
          request?: string;
          messageId?: string;
        };
        const task = taskId ? this.store.getTask(taskId) : undefined;
        const message = messageId ? this.store.messageById(group.id, messageId) : undefined;
        if (
          task &&
          (task.groupId !== group.id || !request || taskRequestKey(this.store, task) !== request)
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
        const question: OwnerQuestion | undefined = reminder
          ? task && request
            ? { groupId: group.id, taskId: task.id, request }
            : message
              ? { groupId: group.id, messageId: message.id }
              : undefined
          : undefined;
        if (reminder && (!ping || !question || !reminderOpen(this.store, question))) return;
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
        const originalId = task
          ? `telegram:question:${pair.userId}:${task.id}:${request}`
          : `telegram:dialog:${destination.chatId}:${destination.threadId ?? 0}:${message!.id}${message!.phase ? ':' + message!.phase : ''}`;
        const id = reminder ? nextReminderId(this.store, originalId, Date.now()) : originalId;
        if (!id) return;
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
            .add(
              ' · ' +
                this.t(reminder ? 'Reminder: your reply is still needed' : 'Your reply is needed') +
                '\n\n',
            );
        if (this.pair()?.userId !== pair.userId || (topic && this.room()?.chatId !== topic.chatId))
          return;
        if (
          task &&
          (taskRequestKey(this.store, this.store.getTask(task.id)) !== request ||
            !notificationPreferences(this.store).enabled)
        )
          return;
        if (question && !reminderOpen(this.store, question)) return;
        if (task) {
          const worker =
            task.inputRequest?.role === 'author' && task.inputRequest.reviewDispute !== 'owner';
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
        // An edit to a progress card does not send a fresh mention notification.
        const replaceTurn = !ping && message?.sender === 'agent' && !!message.runId;
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
          groupId: group.id,
          key: replaceTurn ? `turn:${message!.runId}` : id,
          replace: replaceTurn,
          order: message?.at ?? event.at,
          final: message?.phase !== 'progress',
          notificationId: id,
          question:
            task && request
              ? { groupId: group.id, taskId: task.id, request }
              : message?.needsReply
                ? { groupId: group.id, messageId: message.id }
                : undefined,
          reminder: question,
        });
        this.store.db
          .prepare('UPDATE notifications SET status=? WHERE id=?')
          .run(deliveryStatus(result), id);
        this.clearDeferred(group.id);
      })
      .catch((error) => this.deferEvent(event, error));
    return true;
  }
  remindOwners() {
    if (this.stopped || !this.pair() || !notificationPreferences(this.store).enabled) return;
    for (const group of this.daddy.sessions()) {
      if (
        group.deletion ||
        group.deletedAt ||
        group.daddyState === 'paused' ||
        group.daddyState === 'archived'
      )
        continue;
      const event = {
        id: 0,
        at: now(),
        type: 'daddy.message',
        taskId: group.id,
        data: { reminder: true },
      };
      for (const task of this.store.tasks(group.id)) this.queueTaskRequest(task, event);
      const row = this.store.db
        .prepare(
          "SELECT id FROM messages WHERE task_id=? AND json_extract(data,'$.sender')='agent' AND json_extract(data,'$.phase')='final' ORDER BY rowid DESC LIMIT 1",
        )
        .get(group.id);
      if (typeof row?.id === 'string' && this.store.messageById(group.id, row.id)?.needsReply)
        this.onEvent({ ...event, data: { messageId: row.id, reminder: true } });
    }
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
    const completedRuns = new Set(
      messages.filter((message) => message.phase === 'final').map((message) => message.runId),
    );
    for (const message of messages.filter(
      (message) =>
        ['user', 'agent'].includes(message.sender) &&
        !(message.phase === 'progress' && completedRuns.has(message.runId)),
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
    clearInterval(this.reminderTimer);
    await this.progress.stop();
    await this.voice?.stop();
    await this.pending;
    await Promise.allSettled([...this.topics.values()]);
  }
}
