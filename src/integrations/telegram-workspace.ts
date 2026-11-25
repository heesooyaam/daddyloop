import { createHash, randomBytes, randomInt } from 'node:crypto';
import { commandHelp, normalizeTelegramCommand } from './telegram-commands.js';
import {
  taskRequestKey,
  reminderOpen,
  nextReminderId,
  type OwnerQuestion,
} from './telegram-reminders.js';
import { githubBackoff } from '../providers/github-quota.js';
import type { Daddy } from '../core/daddy.js';
import {
  sameAgentProfile,
  AppError,
  now,
  type Event,
  type HumanTaskAction,
  type ReviewGroup,
  type Task,
  type TelegramReply,
} from '../core/types.js';
import { redact } from '../core/security.js';
import type { TelegramApi, Update } from './telegram.js';
import { TelegramText, safeLink, type TelegramButton, type TelegramCard } from './telegram-text.js';
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
import { instructionLines, updateInstructionsFromCommand } from '../client/instructions.js';
import { InstructionSources } from '../ops/instruction-sources.js';
import { InstructionPresets } from '../core/instruction-presets.js';
import { sessionInstructionsSchema, type SkillSnapshot } from '../core/instructions.js';
import { presetParts } from '../core/preset-parts.js';
import { findPreset, selectPreset } from '../client/presets.js';
import { isGitAddress, parseGitSource } from '../modules/repositories/git-source.js';
import { clipTitle } from '../core/session-title.js';
import { moduleCatalogue } from '../modules/catalogue.js';
import { deliveryStatus } from './telegram-delivery.js';
import { autoMergeSettings, githubActivityStatus } from '../core/auto-merge.js';
import { taskReference } from '../core/task-activity.js';
import { workerSlots } from '../core/worker-pool.js';
import {
  activityReason,
  activityStatus,
  profileText,
  taskActivity,
} from '../core/task-activity.js';
import {
  parseTaskInput,
  parseWorkerInput,
  queueCard,
  queuedTaskCard,
  taskCard as activityTaskCard,
  taskCommands,
  taskReferenceId,
  workersCard,
} from './telegram-tasks.js';
type Pair = { chatId: number; userId: number; ownerLabel?: string };
type Room = { chatId: number; title: string; ownerId: number };
type Topic = { chatId: number; threadId: number; groupId: string; ownerId: number; title?: string };
type Destination = { chatId: number; threadId?: number };
type NewSessionDraft = {
  id: string;
  text?: string;
  workspaceId?: string;
  expiresAt: string;
};
type RegistrationReply = {
  expiresAt: string;
  messages: {
    destination: Destination;
    content: string | TelegramCard;
    delivered?: boolean;
  }[];
};
type RepoChoice = {
  destination: Destination;
  controlDestination?: Destination;
  inputId?: string;
  ownerId: number;
  workspace: Workspace;
  groupId?: string;
  input?: RepositorySelection;
  browsePage?: number;
  expiresAt: string;
  creationExpiresAt?: string;
};
type TaskControl = {
  kind: 'task' | 'prepare' | 'confirm';
  destination: Destination;
  ownerId: number;
  groupId: string;
  taskId: string;
  action?: HumanTaskAction;
  expectedHead?: string;
  expectedGeneration?: number;
  expectedPendingHead?: string;
  reason?: string;
  queuePage?: number;
  cancels?: string;
  expiresAt: string;
  outcome?: 'completed' | 'stale';
};
type PendingDocument = {
  id: string;
  kind: 'instructions' | 'skill';
  ownerId: number;
  chatId: number;
  groupId: string;
  generation: number;
  instructionsHash: string;
  role?: 'daddy' | 'worker';
  expiresAt: string;
};
type PresetControl = {
  kind: 'delete' | 'part' | 'select' | 'cancel';
  ownerId: number;
  destination: Destination;
  presetId: string;
  revision: number;
  groupId?: string;
  part?: string;
  enabled?: boolean;
  cancels?: string;
  expiresAt: string;
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
    private onRoomChange?: () => void,
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
  private async privateStep(destination: Destination, message: string) {
    await this.api.send(destination, {
      ...new TelegramText().add(message),
      buttons: [[{ text: this.t('Open private chat'), url: `https://t.me/${this.username}` }]],
    });
  }
  private async privateSessionStep(destination: Destination, group: ReviewGroup, message: string) {
    await this.privateStep(
      destination,
      message +
        '\n\n' +
        this.t('In the private chat send /session {id}, then repeat the command for {title}.', {
          id: group.id.slice(0, 8),
          title: this.groupText(destination, group.title),
        }),
    );
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
      const title = clipTitle(redact(group.title));
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
            name: clipTitle(redact(group.title)),
          });
          if (!Number.isSafeInteger(value.message_thread_id) || value.message_thread_id <= 0)
            throw new Error('Telegram returned an invalid topic ID');
          const topic = {
            chatId: room.chatId,
            threadId: value.message_thread_id,
            groupId: group.id,
            ownerId: room.ownerId,
            title: clipTitle(redact(group.title)),
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
    this.onRoomChange?.();
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
    if (destination.chatId === pair?.chatId) return this.daddy.group(groupId);
    const topicGroup = this.groupAt(destination);
    if (topicGroup) {
      if (topicGroup !== groupId)
        throw new AppError('wrong_topic', 'Use the topic belonging to this daddy session', 403);
      return this.daddy.group(groupId);
    }
    if (
      this.room()?.chatId === destination.chatId &&
      this.store.setting<string>(this.selectedSessionKey(destination)) === groupId
    )
      return this.daddy.group(groupId);
    throw new AppError('wrong_topic', 'Use the topic belonging to this daddy session', 403);
  }
  async show(groupId: string, destination: Destination) {
    const group = this.authorize(destination, groupId),
      topic = await this.ensureTopic(group);
    if (destination.chatId === this.pair()?.chatId) {
      this.selectPrivateSession(destination, group.id);
      this.store.setSetting(this.creationKey(destination), null);
    }
    await this.api.send(
      destination,
      daddyBoard(
        this.locale(),
        this.groupBoard(destination, this.daddy.board(group.id)),
        destination.chatId === this.pair()?.chatId && topic ? this.link(topic) : undefined,
      ),
    );
  }
  private async showStatus(groupId: string, destination: Destination) {
    const group = this.authorize(destination, groupId);
    await this.api.send(destination, {
      ...this.progress.card(
        group,
        destination.chatId === this.pair()?.chatId ? (value) => value : redact,
      ),
      buttons: [[{ text: this.t('Back'), callback_data: `dad:open:${group.id}` }]],
    });
  }
  private selectedSessionKey(destination: Destination) {
    return `telegram.selectedSession:${this.pair()!.userId}:${destination.chatId}:${destination.threadId ?? 0}`;
  }
  private selectedTaskKey(destination: Destination, groupId: string) {
    return `telegram.selectedTask:${this.pair()!.userId}:${destination.chatId}:${destination.threadId ?? 0}:${groupId}`;
  }
  private documentKey(destination: Destination) {
    return `telegram.documentImport:${this.pair()!.userId}:${destination.chatId}`;
  }
  private selectPrivateSession(destination: Destination, groupId: string) {
    if (destination.chatId !== this.pair()?.chatId) return;
    const pending = this.store.setting<PendingDocument>(this.documentKey(destination));
    if (pending && pending.groupId !== groupId)
      this.store.setSetting(this.documentKey(destination), null);
    this.store.setSetting(this.repoInputKey(destination), null);
    this.store.setSetting('telegram.currentDaddy', groupId);
  }
  private requirePendingDocument(destination: Destination, pending: PendingDocument) {
    const current = this.store.setting<PendingDocument>(this.documentKey(destination));
    if (
      current?.id !== pending.id ||
      this.store.setting<string>('telegram.currentDaddy') !== pending.groupId
    ) {
      if (current?.id === pending.id) this.store.setSetting(this.documentKey(destination), null);
      throw new Error(this.t('The selected session changed. Start the file import again.'));
    }
  }
  private instructionsHash(group: ReviewGroup) {
    return createHash('sha256')
      .update(JSON.stringify(group.instructions ?? null))
      .digest('hex');
  }
  private async requestDocument(
    destination: Destination,
    group: ReviewGroup,
    kind: PendingDocument['kind'],
    role?: PendingDocument['role'],
  ) {
    if (destination.chatId !== this.pair()?.chatId)
      return this.privateSessionStep(
        destination,
        group,
        this.t('Instruction files are accepted only in the paired private chat.'),
      );
    this.store.setSetting(this.documentKey(destination), {
      id: randomBytes(12).toString('base64url'),
      kind,
      role,
      ownerId: this.pair()!.userId,
      chatId: destination.chatId,
      groupId: group.id,
      generation: group.generation,
      instructionsHash: this.instructionsHash(group),
      expiresAt: new Date(Date.now() + 10 * 60000).toISOString(),
    } satisfies PendingDocument);
    await this.api.send(
      destination,
      kind === 'instructions'
        ? this.t(
            'Send a UTF-8 JSON instruction set up to 1 MiB. The request expires in 10 minutes.',
          )
        : this.t(
            'Send one UTF-8 Markdown or text skill file up to 64 KiB. The request expires in 10 minutes.',
          ),
    );
  }
  private async handleDocument(update: Update, destination: Destination, privateChat: boolean) {
    const document = update.message?.document;
    if (!document) return false;
    if (!privateChat) {
      await this.privateStep(
        destination,
        this.t('Instruction files are accepted only in the paired private chat.'),
      );
      return true;
    }
    const pending = this.store.setting<PendingDocument>(this.documentKey(destination));
    if (
      !pending ||
      pending.expiresAt <= now() ||
      pending.ownerId !== this.pair()?.userId ||
      pending.chatId !== destination.chatId
    )
      throw new Error(
        this.t('Start an instruction or skill import command before sending a file.'),
      );
    this.requirePendingDocument(destination, pending);
    const group = this.daddy.group(pending.groupId);
    if (
      group.generation !== pending.generation ||
      this.instructionsHash(group) !== pending.instructionsHash
    )
      throw new Error(this.t('The session changed. Start the file import again.'));
    const filename = (document.file_name ?? '').split(/[\\/]/).at(-1) || 'instructions.json';
    const limit = pending.kind === 'skill' ? 65536 : 1024 * 1024;
    if (
      (document.file_size ?? 0) > limit ||
      (pending.kind === 'instructions'
        ? !/\.json$/i.test(filename)
        : !/\.(?:md|txt)$/i.test(filename))
    )
      throw new Error(
        this.t(
          pending.kind === 'instructions'
            ? 'Choose a JSON instruction set up to 1 MiB.'
            : 'Choose a Markdown or text skill file up to 64 KiB.',
        ),
      );
    const bytes = await this.api.downloadDocument(document.file_id);
    this.requirePendingDocument(destination, pending);
    const current = this.daddy.group(pending.groupId);
    if (
      current.generation !== pending.generation ||
      this.instructionsHash(current) !== pending.instructionsHash
    )
      throw new Error(this.t('The session changed. Start the file import again.'));
    if (pending.kind === 'instructions') {
      let value: unknown;
      try {
        value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      } catch {
        throw new Error(this.t('Choose a valid UTF-8 JSON instruction set.'));
      }
      const imported = sessionInstructionsSchema.parse(value);
      await this.daddy.updateInstructions(
        current.id,
        { generation: pending.generation, instructionsHash: pending.instructionsHash },
        () => imported,
        () => this.requirePendingDocument(destination, pending),
      );
    } else {
      if (bytes.byteLength > 65536)
        throw new Error(this.t('Choose a Markdown or text skill file up to 64 KiB.'));
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        throw new Error(this.t('Choose a UTF-8 Markdown or text file.'));
      }
      const skill = await new InstructionSources().import({ kind: 'file', name: filename, text });
      const added = await this.addSkill(current, pending.role!, skill, pending, destination);
      this.store.setSetting(this.documentKey(destination), null);
      await this.skillConfirmation(current, pending.role!, skill, added, destination);
      return true;
    }
    this.store.setSetting(this.documentKey(destination), null);
    await this.api.send(
      destination,
      this.t(
        pending.kind === 'instructions'
          ? 'Instruction set imported for {title}.'
          : 'Skill imported for {title}.',
        { title: current.title },
      ),
    );
    return true;
  }
  private async exportInstructions(group: ReviewGroup, destination: Destination) {
    if (destination.chatId !== this.pair()?.chatId)
      return this.privateSessionStep(
        destination,
        group,
        this.t('Instruction exports are available only in the paired private chat.'),
      );
    const body = JSON.stringify(group.instructions ?? { daddy: {}, worker: {} }, null, 2) + '\n';
    await this.api.sendDocument(
      destination,
      `daddy-instructions-${group.id.slice(0, 8)}.json`,
      Buffer.from(body),
      this.t('Instructions for {title}', { title: group.title })
        .replace(/\s+/g, ' ')
        .slice(0, 1024),
    );
  }
  private async addSkill(
    group: ReviewGroup,
    role: 'daddy' | 'worker',
    skill: SkillSnapshot,
    pending?: PendingDocument,
    destination?: Destination,
  ) {
    let added = false;
    await this.daddy.updateInstructions(
      group.id,
      {
        generation: pending?.generation ?? group.generation,
        instructionsHash: pending?.instructionsHash ?? this.instructionsHash(group),
      },
      (current) => {
        const instructions = structuredClone(current ?? { daddy: {}, worker: {} });
        const skills = instructions[role].skills ?? [];
        if (!skills.some((item) => item.checksum === skill.checksum)) {
          added = true;
          instructions[role].skills = [...skills, skill];
        }
        return instructions;
      },
      pending && destination ? () => this.requirePendingDocument(destination, pending) : undefined,
    );
    return added;
  }
  private async skillConfirmation(
    group: ReviewGroup,
    role: 'daddy' | 'worker',
    skill: SkillSnapshot,
    added: boolean,
    destination: Destination,
  ) {
    await this.api.send(
      destination,
      this.t(
        added
          ? 'Skill {name} added to {role} in {title}.'
          : 'Skill {name} is already connected to {role} in {title}.',
        {
          name: skill.name,
          role: role === 'daddy' ? 'daddy' : this.t('All workers'),
          title: this.groupText(destination, group.title),
        },
      ),
    );
  }
  private presetControl(data: Omit<PresetControl, 'ownerId' | 'expiresAt'>) {
    const id = randomBytes(12).toString('base64url');
    this.store.db.prepare('INSERT INTO bot_actions(id,data) VALUES(?,?)').run(
      id,
      JSON.stringify({
        ...data,
        ownerId: this.pair()!.userId,
        expiresAt: new Date(Date.now() + 10 * 60000).toISOString(),
      } satisfies PresetControl),
    );
    return `dad:preset:${id}`;
  }
  private cleanupBotActions() {
    this.store.db
      .prepare("DELETE FROM bot_actions WHERE json_extract(data,'$.expiresAt') <= ?")
      .run(now());
  }
  private readPresetControl(data: string, destination: Destination) {
    const id = /^dad:preset:([A-Za-z0-9_-]{16})$/.exec(data)?.[1];
    if (!id) return;
    const row = this.store.db.prepare('SELECT data,consumed FROM bot_actions WHERE id=?').get(id);
    if (!row) throw new Error(this.t('This preset action expired. Open the preset again.'));
    const control = JSON.parse(String(row.data)) as PresetControl;
    if (
      control.ownerId !== this.pair()?.userId ||
      control.destination.chatId !== destination.chatId ||
      control.destination.threadId !== destination.threadId ||
      control.expiresAt <= now()
    )
      throw new Error(this.t('This preset action expired. Open the preset again.'));
    return { id, control, consumed: !!row.consumed };
  }
  private presetSession(destination: Destination, groupId: string) {
    const group = this.authorize(destination, groupId);
    if (
      destination.chatId === this.pair()?.chatId &&
      this.store.setting<string>('telegram.currentDaddy') !== groupId
    )
      throw new AppError(
        'stale_preset_session',
        'The selected session changed. Open the preset library again.',
        409,
      );
    return group;
  }
  private async presetPartsCard(group: ReviewGroup, presetId: string, destination: Destination) {
    this.presetSession(destination, group.id);
    const applied = group.instructions?.presets?.find((item) => item.preset.id === presetId);
    if (!applied) throw new Error(this.t('Enable this preset in the session first.'));
    const parts = presetParts(applied.preset),
      presetName = this.groupText(destination, applied.preset.name);
    await this.api.send(destination, {
      ...new TelegramText()
        .add('🧩 ' + presetName, 'bold')
        .add(
          '\n\n' + this.t('Choose which saved prompt and skill components apply to this session.'),
        ),
      buttons: [
        ...parts.map((part) => [
          {
            text:
              (applied.omit.includes(part.key) ? '○ ' : '✓ ') +
              (part.kind === 'prompt'
                ? `${part.role}: ${this.t('Prompt')}`
                : `${part.role}: ${this.groupText(destination, part.name)}`),
            callback_data: this.presetControl({
              kind: 'part',
              destination,
              groupId: group.id,
              presetId: applied.preset.id,
              revision: applied.preset.revision,
              part: part.key,
              enabled: applied.omit.includes(part.key),
            }),
          },
        ]),
        [{ text: this.t('Back'), callback_data: `dad:instructions:${group.id}` }],
      ],
    });
  }
  private async presetsCard(group: ReviewGroup | undefined, destination: Destination, page = 0) {
    this.cleanupBotActions();
    if (group) this.presetSession(destination, group.id);
    const presets = new InstructionPresets(this.store).list(),
      pageSize = 10,
      pages = Math.max(1, Math.ceil(presets.length / pageSize));
    page = Math.max(0, Math.min(page, pages - 1));
    const visible = presets.slice(page * pageSize, (page + 1) * pageSize);
    const text = new TelegramText().add('🧩 ' + this.t('Presets'), 'bold');
    if (!presets.length) text.add('\n\n' + this.t('No presets yet.'));
    else if (pages > 1)
      text.add('\n' + this.t('Page {page} of {pages}', { page: page + 1, pages }));
    const showDescriptions = destination.chatId === this.pair()?.chatId;
    for (const preset of visible) {
      text.add('\n\n• ' + this.groupText(destination, preset.name));
      if (showDescriptions && preset.description) text.add('\n' + preset.description);
    }
    const navigation: TelegramButton[] = [],
      route = group?.id ?? 'library';
    if (page > 0) navigation.push({ text: '←', callback_data: `dad:presets:${route}:${page - 1}` });
    if (page + 1 < pages)
      navigation.push({ text: '→', callback_data: `dad:presets:${route}:${page + 1}` });
    await this.api.send(destination, {
      ...text,
      buttons: [
        ...(group
          ? visible.map((preset) => [
              {
                text: this.groupText(destination, preset.name).slice(0, 60),
                callback_data: this.presetControl({
                  kind: 'select',
                  destination,
                  groupId: group.id,
                  presetId: preset.id,
                  revision: preset.revision,
                }),
              },
            ])
          : []),
        ...(navigation.length ? [navigation] : []),
      ],
    });
  }
  private async presetControlCallback(data: string, destination: Destination) {
    const entry = this.readPresetControl(data, destination);
    if (!entry) return false;
    const { id, control } = entry;
    if (entry.consumed) {
      if ((control.kind === 'part' || control.kind === 'select') && control.groupId)
        await this.presetPartsCard(
          this.presetSession(destination, control.groupId),
          control.presetId,
          destination,
        );
      else await this.api.send(destination, this.t('This preset action was already completed.'));
      return true;
    }
    const library = new InstructionPresets(this.store);
    if (control.kind === 'cancel') {
      this.store.transaction(() => {
        const target = this.store.db
          .prepare('SELECT data,consumed FROM bot_actions WHERE id=?')
          .get(control.cancels!);
        if (target && !target.consumed) {
          const deletion = JSON.parse(String(target.data)) as PresetControl;
          if (
            deletion.kind === 'delete' &&
            deletion.presetId === control.presetId &&
            deletion.revision === control.revision
          )
            this.store.db
              .prepare('UPDATE bot_actions SET consumed=1 WHERE id=?')
              .run(control.cancels!);
        }
        this.store.db.prepare('UPDATE bot_actions SET consumed=1 WHERE id=?').run(id);
      });
      await this.callback('dad:settings', destination);
      return true;
    }
    if (control.kind === 'delete') {
      if (destination.chatId !== this.pair()?.chatId)
        throw new Error(this.t('Preset library changes are available only in the private chat.'));
      if (library.all().some((preset) => preset.id === control.presetId))
        library.remove(control.presetId, control.revision);
      this.store.db.prepare('UPDATE bot_actions SET consumed=1 WHERE id=?').run(id);
      await this.api.send(destination, this.t('Preset deleted.'));
      return true;
    }
    const group = this.presetSession(destination, control.groupId!);
    if (control.kind === 'select') {
      const preset = library.get(control.presetId);
      if (preset.revision !== control.revision)
        throw new Error(this.t('This preset selection changed. Open it again.'));
      await this.daddy.updateInstructions(
        group.id,
        { generation: group.generation, instructionsHash: this.instructionsHash(group) },
        (current) => selectPreset(current, preset),
        () => this.presetSession(destination, group.id),
        () => {
          this.store.db.prepare('UPDATE bot_actions SET consumed=1 WHERE id=?').run(id);
        },
      );
      await this.presetPartsCard(this.daddy.group(group.id), preset.id, destination);
      return true;
    }
    if (typeof control.enabled !== 'boolean')
      throw new Error(this.t('This preset action expired. Open the preset again.'));
    await this.daddy.updateInstructions(
      group.id,
      { generation: group.generation, instructionsHash: this.instructionsHash(group) },
      (current) => {
        const instructions = structuredClone(current ?? { daddy: {}, worker: {} });
        const applied = instructions.presets?.find((item) => item.preset.id === control.presetId);
        if (!applied || applied.preset.revision !== control.revision)
          throw new Error(this.t('This preset selection changed. Open it again.'));
        const omitted = new Set(applied.omit);
        if (control.enabled) omitted.delete(control.part!);
        else omitted.add(control.part!);
        applied.omit = [...omitted];
        return instructions;
      },
      () => this.presetSession(destination, group.id),
      () => {
        this.store.db.prepare('UPDATE bot_actions SET consumed=1 WHERE id=?').run(id);
      },
    );
    await this.presetPartsCard(this.daddy.group(group.id), control.presetId, destination);
    return true;
  }
  private async savePreset(
    group: ReviewGroup,
    name: string,
    update: boolean,
    destination: Destination,
  ) {
    if (destination.chatId !== this.pair()?.chatId)
      return this.privateSessionStep(
        destination,
        group,
        this.t('Preset library changes are available only in the private chat.'),
      );
    const library = new InstructionPresets(this.store);
    const prior = update ? library.get(findPreset(library.list(), name).id) : undefined;
    const preset = library.save(
      {
        name: prior?.name ?? name,
        description: prior?.description ?? '',
        instructions: group.instructions ?? { daddy: {}, worker: {} },
        expectedRevision: prior?.revision,
      },
      prior?.id,
    );
    await this.api.send(
      destination,
      this.t(update ? 'Preset updated from this session.' : 'Preset saved from this session.') +
        `\n\n${preset.name} · ${this.t('version')} ${preset.revision}`,
    );
  }
  private appliedPreset(group: ReviewGroup, name: string) {
    const query = name.trim().toLowerCase();
    const matches = (group.instructions?.presets ?? []).filter(
      (item) =>
        item.preset.id === query ||
        item.preset.id.startsWith(query) ||
        item.preset.name.toLowerCase() === query,
    );
    if (matches.length > 1) throw new Error('Choose a unique preset name or ID');
    return matches[0];
  }
  private async confirmPresetDelete(name: string, destination: Destination) {
    if (destination.chatId !== this.pair()?.chatId)
      return this.privateStep(
        destination,
        this.t('Preset library changes are available only in the private chat.'),
      );
    const library = new InstructionPresets(this.store),
      preset = library.get(findPreset(library.list(), name).id);
    const deletion = this.presetControl({
      kind: 'delete',
      destination,
      presetId: preset.id,
      revision: preset.revision,
    });
    await this.api.send(destination, {
      ...new TelegramText()
        .add(this.t('Delete preset') + ': ' + preset.name, 'bold')
        .add(
          '\n\n' +
            this.t('Existing sessions keep their saved copy. This removes the library version.'),
        ),
      buttons: [
        [
          {
            text: this.t('Delete preset'),
            callback_data: deletion,
          },
        ],
        [
          {
            text: this.t('Cancel'),
            callback_data: this.presetControl({
              kind: 'cancel',
              destination,
              presetId: preset.id,
              revision: preset.revision,
              cancels: deletion.slice('dad:preset:'.length),
            }),
          },
        ],
      ],
    });
  }
  private findSession(value: string) {
    const query = value.trim().toLowerCase();
    const matches = this.daddy
      .sessions()
      .filter(
        (group) =>
          group.id === query || group.id.startsWith(query) || group.title.toLowerCase() === query,
      );
    if (matches.length !== 1)
      throw new Error(this.t('Choose one session by its exact name or unique ID prefix.'));
    return matches[0];
  }
  private sessionForControl(destination: Destination, selector?: string) {
    const pair = this.pair()!;
    let id: string | undefined;
    if (selector) id = this.findSession(selector).id;
    const topicGroup = this.groupAt(destination);
    if (topicGroup) {
      if (id && id !== topicGroup)
        throw new AppError('wrong_topic', 'Use the topic belonging to this daddy session', 403);
      return this.daddy.group(topicGroup);
    }
    if (destination.chatId === pair.chatId) {
      id ??= this.store.setting<string>('telegram.currentDaddy');
      if (!id) throw new Error(this.t('Choose a session with /session <name or ID>.'));
      if (selector) this.selectPrivateSession(destination, id);
      return this.daddy.group(id);
    }
    if (this.room()?.chatId !== destination.chatId)
      throw new AppError('wrong_topic', 'Use the connected Telegram group', 403);
    id ??= this.store.setting<string>(this.selectedSessionKey(destination));
    if (!id) throw new Error(this.t('Choose a session with /session <name or ID>.'));
    if (selector) this.store.setSetting(this.selectedSessionKey(destination), id);
    return this.daddy.group(id);
  }
  private authorizeControl(destination: Destination, groupId: string) {
    const pair = this.pair();
    if (!pair) throw new Error('Pair the bot first');
    if (destination.chatId === pair.chatId) return this.daddy.group(groupId);
    const topicGroup = this.groupAt(destination);
    if (topicGroup) {
      if (topicGroup !== groupId)
        throw new AppError('wrong_topic', 'Use the topic belonging to this daddy session', 403);
      return this.daddy.group(groupId);
    }
    if (
      this.room()?.chatId === destination.chatId &&
      this.store.setting<string>(this.selectedSessionKey(destination)) === groupId
    )
      return this.daddy.group(groupId);
    throw new AppError('wrong_topic', 'Use the topic belonging to this daddy session', 403);
  }
  private authorizeModelControl(destination: Destination, groupId: string) {
    const group = this.authorize(destination, groupId);
    if (
      destination.chatId === this.pair()?.chatId &&
      this.store.setting<string>('telegram.currentDaddy') !== groupId
    )
      throw new AppError(
        'stale_model_session',
        'The selected session changed. Open Models again.',
        409,
      );
    return group;
  }
  private groupText(destination: Destination, value: string) {
    return destination.chatId === this.pair()?.chatId ? value : redact(value);
  }
  private groupBoard(destination: Destination, board: ReturnType<Daddy['board']>) {
    if (destination.chatId === this.pair()?.chatId) return board;
    return {
      ...board,
      group: { ...board.group, title: redact(board.group.title) },
      workspace: { ...board.workspace, name: redact(board.workspace.name) },
      tasks: board.tasks.map((task) => ({ ...task, title: redact(task.title) })),
    };
  }
  private workspacePickerCard(destination: Destination, workspaces: Workspace[], page = 0) {
    const draft = this.store.setting<NewSessionDraft>(this.creationKey(destination));
    return workspacePicker(
      this.locale(),
      workspaces.map((workspace) => ({
        ...workspace,
        name: this.groupText(destination, workspace.name),
      })),
      page,
      draft?.id,
    );
  }
  private groupTask(destination: Destination, task: Task): Task {
    if (destination.chatId === this.pair()?.chatId) return task;
    return {
      ...task,
      title: redact(task.title),
      reason: redact(task.reason),
      summary: task.summary ? redact(task.summary) : task.summary,
      pr: task.pr
        ? {
            ...task.pr,
            title: task.pr.title ? redact(task.pr.title) : '',
            body: task.pr.body ? redact(task.pr.body) : '',
            checkDetails: (task.pr.checkDetails ?? []).map((check) => ({
              ...check,
              name: redact(check.name),
            })),
          }
        : task.pr,
    };
  }
  private findTask(groupId: string, value: string) {
    const query = value.trim().toLowerCase();
    const reference = taskReferenceId(query);
    const matches = this.store
      .tasks(groupId)
      .filter(
        (task) =>
          (reference
            ? task.id.startsWith(reference)
            : task.id === query || task.id.startsWith(query)) || task.title.toLowerCase() === query,
      );
    if (matches.length !== 1)
      throw new Error(this.t('Choose one task by its exact name or unique ID prefix.'));
    return matches[0];
  }
  private taskActionLabel(action: HumanTaskAction) {
    const labels: Record<Locale, Record<HumanTaskAction, string>> = {
      en: {
        'approve-plan': 'Approve plan',
        'waive-checks': 'Waive CI checks',
        'verify-merge': 'Verify merge',
      },
      ru: {
        'approve-plan': 'Принять план',
        'waive-checks': 'Разрешить пропуск CI',
        'verify-merge': 'Проверить merge',
      },
    };
    return labels[this.locale()][action];
  }
  private availableTaskActions(task: Task): HumanTaskAction[] {
    return [
      ...(task.state === 'awaiting_plan_approval' ? (['approve-plan'] as const) : []),
      ...(task.state === 'awaiting_checks' ? (['waive-checks'] as const) : []),
      ...(task.state === 'needs_input' && task.ref.kind !== 'ticket' && task.revision
        ? (['verify-merge'] as const)
        : []),
    ];
  }
  private taskControl(data: Omit<TaskControl, 'ownerId' | 'expiresAt'>) {
    const id = randomBytes(12).toString('base64url');
    const value: TaskControl = {
      ...data,
      ownerId: this.pair()!.userId,
      expiresAt: new Date(Date.now() + 10 * 60000).toISOString(),
    };
    this.store.db
      .prepare('INSERT INTO bot_actions(id,data) VALUES(?,?)')
      .run(id, JSON.stringify(value));
    return `dad:task:${id}`;
  }
  private readTaskControl(data: string, destination: Destination) {
    const id = /^dad:task:([A-Za-z0-9_-]{16})$/.exec(data)?.[1];
    if (!id) return;
    const row = this.store.db.prepare('SELECT data,consumed FROM bot_actions WHERE id=?').get(id);
    if (!row) throw new Error(this.t('This task action expired. Open the task again.'));
    const control = JSON.parse(String(row.data)) as TaskControl;
    if (
      control.ownerId !== this.pair()?.userId ||
      control.destination.chatId !== destination.chatId ||
      control.destination.threadId !== destination.threadId ||
      control.expiresAt <= now()
    )
      throw new Error(this.t('This task action expired. Open the task again.'));
    this.authorizeControl(destination, control.groupId);
    if (
      destination.chatId === this.pair()?.chatId &&
      this.store.setting<string>('telegram.currentDaddy') !== control.groupId &&
      !(control.kind === 'task' && control.cancels)
    )
      throw new AppError(
        'stale_task_session',
        'The selected session changed. Open the task again.',
        409,
      );
    this.daddy.task(control.groupId, control.taskId);
    return { id, control, consumed: !!row.consumed };
  }
  private taskVersion(task: Task) {
    return {
      head: task.revision?.head ?? '',
      generation: task.generation,
      pendingHead: task.pendingAuthorHead,
    };
  }
  private safeUrl(value: string) {
    try {
      const url = new URL(value);
      if (
        !['https:', 'http:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        [...url.searchParams.keys()].some((key) =>
          /token|secret|key|auth|signature|credential/i.test(key),
        )
      )
        return;
      return url.href;
    } catch {
      return;
    }
  }
  private sameTaskVersion(task: Task, control: TaskControl) {
    return (
      task.revision?.head === control.expectedHead &&
      task.generation === control.expectedGeneration &&
      task.pendingAuthorHead === control.expectedPendingHead
    );
  }
  private taskActionCompleted(taskId: string, actionId: string) {
    return !!this.store.db
      .prepare("SELECT 1 FROM events WHERE task_id=? AND run_id=? AND type='human.task_action'")
      .get(taskId, actionId);
  }
  private recoverTaskAction(task: Task, control: TaskControl, actionId: string) {
    let recovered = false;
    if (control.action === 'waive-checks')
      recovered =
        !!task.checksWaivedAt &&
        !!this.store.db
          .prepare("SELECT 1 FROM events WHERE task_id=? AND run_id=? AND type='checks.waived'")
          .get(task.id, actionId);
    else if (control.action === 'approve-plan')
      recovered =
        !!task.approvedAt &&
        task.revision?.head === control.expectedHead &&
        !!this.store.db
          .prepare(
            "SELECT 1 FROM events WHERE task_id=? AND run_id=? AND type='human.approve-plan'",
          )
          .get(task.id, actionId);
    else if (control.action === 'verify-merge')
      recovered =
        task.revision?.head === control.expectedHead &&
        this.store
          .jobs(task.id)
          .some(
            (job) =>
              job.kind === 'verify_merge' &&
              job.generation === (control.expectedGeneration ?? 0) + 1 &&
              job.actionId === actionId,
          );
    if (recovered && !this.taskActionCompleted(task.id, actionId))
      this.store.event(
        task.id,
        'human.task_action',
        { action: control.action, reason: control.reason, recovered: true },
        actionId,
      );
    return recovered;
  }
  private finishTaskControl(id: string, control: TaskControl, outcome: 'completed' | 'stale') {
    this.store.db
      .prepare('UPDATE bot_actions SET data=?,consumed=1 WHERE id=?')
      .run(JSON.stringify({ ...control, outcome }), id);
  }
  private cancelTaskControl(id: string, control: TaskControl) {
    this.store.transaction(() => {
      const row = this.store.db
        .prepare('SELECT data,consumed FROM bot_actions WHERE id=?')
        .get(control.cancels!);
      if (row && !row.consumed) {
        const confirmation = JSON.parse(String(row.data)) as TaskControl;
        if (
          confirmation.kind === 'confirm' &&
          confirmation.groupId === control.groupId &&
          confirmation.taskId === control.taskId
        )
          this.finishTaskControl(control.cancels!, confirmation, 'stale');
      }
      this.store.db.prepare('UPDATE bot_actions SET consumed=1 WHERE id=?').run(id);
    });
  }
  private async tasksCard(group: ReviewGroup, destination: Destination, page = 0) {
    this.cleanupBotActions();
    this.authorizeControl(destination, group.id);
    const tasks = this.store.tasks(group.id),
      pageSize = 20,
      pages = Math.max(1, Math.ceil(tasks.length / pageSize));
    page = Math.max(0, Math.min(page, pages - 1));
    const visible = tasks.slice(page * pageSize, (page + 1) * pageSize);
    const text = new TelegramText()
      .add('📋 ' + (this.locale() === 'ru' ? 'Задачи' : 'Tasks'), 'bold')
      .add('\n' + this.groupText(destination, group.title));
    if (!tasks.length)
      text.add(
        '\n\n' +
          (this.locale() === 'ru'
            ? 'В этой сессии пока нет задач.'
            : 'This session has no tasks yet.'),
      );
    else if (pages > 1)
      text.add(
        '\n' +
          this.t('Page {page} of {pages}', {
            page: page + 1,
            pages,
          }),
      );
    const navigation: TelegramButton[] = [];
    if (page > 0)
      navigation.push({ text: '←', callback_data: `dad:tasks:${group.id}:${page - 1}` });
    if (page + 1 < pages)
      navigation.push({ text: '→', callback_data: `dad:tasks:${group.id}:${page + 1}` });
    await this.api.send(destination, {
      ...text,
      buttons: [
        ...visible.map((task) => [
          {
            text: `${task.state === 'complete' ? '✅' : '•'} ${this.groupText(destination, task.title)}`.slice(
              0,
              60,
            ),
            callback_data: this.taskControl({
              kind: 'task',
              destination,
              groupId: group.id,
              taskId: task.id,
            }),
          },
        ]),
        ...(navigation.length ? [navigation] : []),
        [{ text: this.t('Back'), callback_data: `dad:open:${group.id}` }],
      ],
    });
  }
  private appendPrivateTaskDetails(text: TelegramText, task: Task, destination: Destination) {
    if (destination.chatId !== this.pair()?.chatId) return text;
    text
      .add('\n\n' + this.t('Original requirements'), 'bold')
      .add('\n')
      .markdown(task.requirements)
      .add('\n\n' + this.t('Read-only worker reports'), 'bold');
    const reports = this.store
      .messages(task.id)
      .filter((message) => message.sender === 'agent')
      .slice(-8);
    if (!reports.length) return text.add('\n' + this.t('No worker reports yet.'));
    for (const report of reports)
      text
        .add('\n\n' + (report.role === 'reviewer' ? 'daddy' : this.t('Worker')), 'bold')
        .add('\n')
        .markdown(report.text);
    return text;
  }
  private async taskCard(task: Task, destination: Destination) {
    const group = this.authorizeControl(destination, task.groupId!);
    this.store.setSetting(this.selectedTaskKey(destination, task.groupId!), task.id);
    const [activity] = taskActivity(
      [task],
      this.store.activeJobs(task.id),
      (item, job) =>
        githubActivityStatus(
          item,
          autoMergeSettings(this.store, group, item),
          githubBackoff(this.store, item.ref),
          job,
        ),
      workerSlots(this.store, group),
    );
    const statusLabel = activityStatus(activity!),
      reason = this.groupText(destination, activityReason(task));
    task = this.groupTask(destination, task);
    const version = this.taskVersion(task);
    const text = new TelegramText()
      .add(task.title, 'bold')
      .add('\n\n' + this.t(statusLabel))
      .add('\n' + this.t(reason))
      .add(
        '\n\n' +
          (this.locale() === 'ru' ? 'Версия' : 'Version') +
          ': ' +
          (version.head || (this.locale() === 'ru' ? 'ещё не создана' : 'not created yet')),
        version.head ? 'code' : undefined,
      )
      .add(
        '\n' + (this.locale() === 'ru' ? 'Поколение' : 'Generation') + ': ' + version.generation,
      );
    if (version.pendingHead && version.pendingHead !== version.head)
      text
        .add('\n' + (this.locale() === 'ru' ? 'Сохранённый коммит' : 'Saved commit') + ': ')
        .add(version.pendingHead, 'code');
    if (task.pr)
      text.add(
        '\n' +
          (this.locale() === 'ru' ? 'CI-проверки' : 'CI checks') +
          ': ' +
          this.t(task.pr.checks),
      );
    for (const check of task.pr?.checkDetails ?? []) {
      const url =
        destination.chatId === this.pair()?.chatId && check.url
          ? this.safeUrl(check.url)
          : undefined;
      text.add('\n• ');
      if (url) text.add(check.name, 'text_link', { url });
      else text.add(check.name);
      text.add(`: ${check.status}`);
    }
    if (task.summary && destination.chatId === this.pair()?.chatId)
      text
        .add('\n\n' + (this.locale() === 'ru' ? 'Сводка' : 'Summary'), 'bold')
        .add('\n')
        .markdown(task.summary.slice(0, 3000));
    this.appendPrivateTaskDetails(text, task, destination);
    const buttons: TelegramButton[][] = this.availableTaskActions(task).map((action) => [
      {
        text: this.taskActionLabel(action),
        callback_data: this.taskControl({
          kind: 'prepare',
          destination,
          groupId: task.groupId!,
          taskId: task.id,
          action,
          expectedHead: version.head,
          expectedGeneration: version.generation,
          expectedPendingHead: version.pendingHead,
        }),
      },
    ]);
    const reviewUrl = task.ref.kind !== 'ticket' ? this.safeUrl(task.ref.url) : undefined;
    if (reviewUrl) buttons.push([{ text: this.t('Open native review'), url: reviewUrl }]);
    if (destination.chatId !== this.pair()?.chatId)
      buttons.push([
        {
          text: this.t('View task details'),
          url: `https://t.me/${this.username}?start=task_${task.id}`,
        },
      ]);
    buttons.push([
      {
        text: this.locale() === 'ru' ? 'К задачам' : 'Back to tasks',
        callback_data: `dad:tasks:${task.groupId}`,
      },
    ]);
    await this.api.send(destination, { ...text, buttons });
  }
  private async taskConfirmation(
    task: Task,
    destination: Destination,
    action: HumanTaskAction,
    reason?: string,
    queuePage?: number,
  ) {
    const version = this.taskVersion(task);
    if (!this.availableTaskActions(task).includes(action))
      throw new Error(this.t('This action is not available for the current task state.'));
    if (action === 'waive-checks' && !reason?.trim()) {
      await this.api.send(
        destination,
        new TelegramText()
          .add(this.taskActionLabel(action), 'bold')
          .add(
            '\n\n' +
              (this.locale() === 'ru'
                ? 'Укажи причину командой /waive <причина>. Обычное сообщение не считается разрешением.'
                : 'Give a reason with /waive <reason>. An ordinary message is not authorization.'),
          ),
      );
      return;
    }
    task = this.groupTask(destination, task);
    const confirmedHead = version.head;
    const text = new TelegramText()
      .add(this.taskActionLabel(action), 'bold')
      .add('\n\n' + task.title)
      .add('\n' + this.groupText(destination, this.daddy.group(task.groupId!).title))
      .add(
        '\n\n' + (this.locale() === 'ru' ? 'Подтверждается версия' : 'Confirming version') + ':\n',
      )
      .add(confirmedHead, 'code')
      .add(
        '\n' + (this.locale() === 'ru' ? 'Поколение' : 'Generation') + ': ' + version.generation,
      );
    if (reason)
      text.add(
        '\n\n' +
          (this.locale() === 'ru' ? 'Причина' : 'Reason') +
          ': ' +
          this.groupText(destination, reason),
      );
    text.add(
      '\n\n' +
        (this.locale() === 'ru'
          ? 'Сервис ещё раз проверит сессию, задачу и эту точную версию. Изменившееся подтверждение будет отклонено.'
          : 'The service will recheck the session, task and exact version. A changed confirmation will be rejected.'),
    );
    const confirmation = this.taskControl({
      kind: 'confirm',
      destination,
      groupId: task.groupId!,
      taskId: task.id,
      action,
      expectedHead: version.head,
      expectedGeneration: version.generation,
      expectedPendingHead: version.pendingHead,
      reason: reason?.trim(),
      queuePage,
    });
    await this.api.send(destination, {
      ...text,
      buttons: [
        [
          {
            text:
              (this.locale() === 'ru' ? 'Подтвердить: ' : 'Confirm: ') +
              this.taskActionLabel(action).toLowerCase(),
            callback_data: confirmation,
          },
        ],
        [
          {
            text: this.t('Cancel'),
            callback_data: this.taskControl({
              kind: 'task',
              destination,
              groupId: task.groupId!,
              taskId: task.id,
              cancels: confirmation.slice('dad:task:'.length),
              queuePage,
            }),
          },
        ],
      ],
    });
  }
  private async taskControlCallback(data: string, destination: Destination) {
    const entry = this.readTaskControl(data, destination);
    if (!entry) return false;
    const { id, control } = entry;
    let task = this.daddy.task(control.groupId, control.taskId);
    const show = () =>
      control.queuePage === undefined
        ? this.taskCard(task, destination)
        : this.showTask(control.groupId, control.taskId, destination, control.queuePage);
    if (control.kind === 'task') {
      if (control.cancels) this.cancelTaskControl(id, control);
      await show();
      return true;
    }
    if (entry.consumed) {
      await this.api.send(
        destination,
        new TelegramText().add(
          control.outcome === 'completed'
            ? this.locale() === 'ru'
              ? 'Это подтверждение уже выполнено.'
              : 'This confirmation was already completed.'
            : this.locale() === 'ru'
              ? 'Это подтверждение уже устарело.'
              : 'This confirmation is already stale.',
        ),
      );
      await show();
      return true;
    }
    if (!['approve-plan', 'waive-checks', 'verify-merge'].includes(control.action ?? ''))
      throw new Error(this.t('This action is not available for the current task state.'));
    if (this.taskActionCompleted(control.taskId, id) || this.recoverTaskAction(task, control, id)) {
      this.finishTaskControl(id, control, 'completed');
      await this.api.send(
        destination,
        new TelegramText().add(
          this.locale() === 'ru'
            ? 'Это подтверждение уже выполнено.'
            : 'This confirmation was already completed.',
        ),
      );
      await show();
      return true;
    }
    if (!this.sameTaskVersion(task, control)) {
      this.finishTaskControl(id, control, 'stale');
      await this.api.send(
        destination,
        new TelegramText().add(
          this.locale() === 'ru'
            ? 'Задача изменилась. Открой новую версию и подтверди её отдельно.'
            : 'The task changed. Open the new version and confirm it separately.',
        ),
      );
      await show();
      return true;
    }
    if (control.kind === 'prepare') {
      await this.taskConfirmation(
        task,
        destination,
        control.action!,
        control.reason,
        control.queuePage,
      );
      return true;
    }
    try {
      task = await this.daddy.taskAction(
        control.groupId,
        control.taskId,
        control.action!,
        {
          head: control.expectedHead!,
          generation: control.expectedGeneration!,
        },
        control.reason,
        id,
      );
    } catch (error) {
      task = this.daddy.task(control.groupId, control.taskId);
      if (
        !this.taskActionCompleted(control.taskId, id) &&
        !this.recoverTaskAction(task, control, id)
      )
        throw error;
    }
    if (!this.taskActionCompleted(control.taskId, id)) {
      await show();
      return true;
    }
    this.finishTaskControl(id, control, 'completed');
    await this.api.send(
      destination,
      new TelegramText().add(
        (this.locale() === 'ru' ? 'Готово: ' : 'Done: ') +
          this.taskActionLabel(control.action!).toLowerCase(),
        'bold',
      ),
    );
    await show();
    return true;
  }
  private async help(destination: Destination, privateChat: boolean) {
    const topic = !!this.groupAt(destination);
    const text = new TelegramText().add(
      this.locale() === 'ru' ? 'Команды daddyloop' : 'daddyloop commands',
      'bold',
    );
    if (privateChat)
      text.add(
        '\n\n' +
          (this.locale() === 'ru'
            ? '/sessions и /session — выбрать сессию\n/new — новая сессия\n/tasks и /task — задачи, принятие плана и исключения CI\n/status, /models, /pool, /repo — управление сессией\n/workspaces и /workspace — репозитории\n/instructions, /skill, /presets, /preset — инструкции и файлы\n/limits, /notifications, /updates — служебные действия\n/group — подключить группу с темами'
            : '/sessions and /session — choose a session\n/new — new session\n/tasks and /task — tasks, plan approval and CI waivers\n/status, /models, /pool, /repo — session controls\n/workspaces and /workspace — repositories\n/instructions, /skill, /presets, /preset — instructions and files\n/limits, /notifications, /updates — service controls\n/group — connect a forum group'),
      );
    else if (topic)
      text.add(
        '\n\n' +
          (this.locale() === 'ru'
            ? 'Эта тема уже привязана к одной сессии. /tasks открывает её задачи; /approve и /waive сначала показывают точную версию и только потом дают кнопку подтверждения.'
            : 'This topic is bound to one session. /tasks opens its tasks; /approve and /waive show the exact version before offering confirmation.'),
      );
    else
      text.add(
        '\n\n' +
          (this.locale() === 'ru'
            ? 'В общей теме сначала явно выбери сессию: /session <имя или ID>. Обычные сообщения отсюда не попадут ни в одну сессию. Для разговора открой её собственную тему.'
            : 'In the general topic, choose a session explicitly with /session <name or ID>. Ordinary messages here are never routed to a session. Open its own topic for conversation.'),
      );
    text.add(
      '\n\n' +
        (this.locale() === 'ru'
          ? `Можно писать /command@${this.username}. Команды с приватными ссылками и обновлениями выполняются только в личке; бот не показывает группе токены и секреты.`
          : `You can use /command@${this.username}. Commands with private links and updates run only in the private chat; the bot never shows tokens or secrets to the group.`),
    );
    await this.api.send(destination, {
      ...text,
      buttons: [
        [{ text: this.t('Sessions'), callback_data: 'dad:home' }],
        ...(!privateChat
          ? [[{ text: this.t('Open private chat'), url: `https://t.me/${this.username}` }]]
          : []),
      ],
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
      this.store
        .tasks(groupId)
        .reverse()
        .map((task) => this.groupTask(destination, task)),
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
  private async showTask(groupId: string, taskId: string, destination: Destination, queuePage = 0) {
    const group = this.authorize(destination, groupId);
    const original = this.daddy.task(groupId, taskId),
      task = this.groupTask(destination, original);
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
        ? autoMergeSettings(this.store, group, original)
        : undefined;
    this.store.setSetting(this.selectedTaskKey(destination, groupId), task.id);
    const card = activityTaskCard(this.locale(), activity!, slot, merge, queuePage);
    if (destination.chatId === this.pair()?.chatId) {
      const details = this.appendPrivateTaskDetails(
        new TelegramText().append(card),
        original,
        destination,
      );
      card.text = details.text;
      card.entities = details.entities;
    }
    const version = this.taskVersion(task);
    card.buttons = [
      ...this.availableTaskActions(task).map((action) => [
        {
          text: this.taskActionLabel(action),
          callback_data: this.taskControl({
            kind: 'prepare',
            destination,
            groupId,
            taskId,
            action,
            expectedHead: version.head,
            expectedGeneration: version.generation,
            expectedPendingHead: version.pendingHead,
            queuePage,
          }),
        },
      ]),
      ...(card.buttons ?? []),
    ];
    if (destination.chatId !== this.pair()?.chatId)
      card.buttons.push([
        {
          text: this.t('View task details'),
          url: `https://t.me/${this.username}?start=task_${task.id}`,
        },
      ]);
    await this.api.send(destination, card);
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
      replyTo,
      workspace: next?.workspace,
    });
    if (next) this.store.setSetting(nextKey, null);
    await this.api.send(
      destination,
      queuedTaskCard(this.locale(), this.groupTask(destination, task)),
      undefined,
      {
        key: receipt,
      },
    );
  }
  private sessionBoard(groupId: string, destination: Destination, link?: string) {
    const board = this.daddy.board(groupId);
    const id = `telegram:daddy-intro:${destination.chatId}:${groupId}`;
    return this.api.send(
      destination,
      daddyBoard(this.locale(), this.groupBoard(destination, board), link),
      undefined,
      {
        key: id,
        replace: true,
        order: board.group.updatedAt,
        notificationId: id,
      },
    );
  }
  private async home(destination: Destination, page = 0) {
    this.store.setSetting(this.creationKey(destination), null);
    const groups = this.daddy.sessions();
    if (destination.chatId === this.pair()?.chatId) {
      await this.api.send(
        destination,
        daddyHome(this.locale(), groups, this.store.setting<string>('telegram.currentDaddy'), page),
      );
      return;
    }
    const pageSize = 10,
      pages = Math.max(1, Math.ceil(groups.length / pageSize));
    page = Math.max(0, Math.min(page, pages - 1));
    const visible = groups.slice(page * pageSize, (page + 1) * pageSize),
      navigation = [
        ...(page > 0 ? [{ text: '←', callback_data: `dad:sessions-page:${page - 1}` }] : []),
        ...(page + 1 < pages
          ? [{ text: '→', callback_data: `dad:sessions-page:${page + 1}` }]
          : []),
      ];
    const text = new TelegramText()
      .add('👨‍💻 daddyloop', 'bold')
      .add('\n\n' + this.t('Open the topic for the session you want to continue.'))
      .add(pages > 1 ? '\n' + this.t('Page {page} of {pages}', { page: page + 1, pages }) : '');
    await this.api.send(destination, {
      ...text,
      buttons: [
        [{ text: this.t('New task'), callback_data: 'dad:new' }],
        ...visible.map((group) => {
          const topic = this.room() ? this.topic(this.room()!, group.id) : undefined;
          return [
            {
              text: this.groupText(destination, group.title),
              ...(topic ? { url: this.link(topic) } : { callback_data: `dad:open:${group.id}` }),
            },
          ];
        }),
        ...(navigation.length ? [navigation] : []),
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
    role?: 'worker' | 'daddy',
    page = 0,
  ) {
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
    let models: Awaited<ReturnType<typeof this.daddy.catalogue.list>> = [];
    try {
      models = await this.daddy.catalogue.list(true);
    } catch {
      // Engine defaults remain selectable when every model catalogue is unavailable.
    }
    const currentEngine = role === 'daddy' ? group.daddy.engine : defaults.engine;
    const engines =
      this.daddy.catalogue.engines?.() ??
      [...new Set(models.map((model) => model.engine))].map((id) => ({ id, name: id }));
    if (!engines.some((engine) => engine.id === currentEngine))
      engines.unshift({ id: currentEngine, name: currentEngine });
    const pageSize = 10,
      pages = Math.max(1, Math.ceil(models.length / pageSize));
    page = Math.max(0, Math.min(page, pages - 1));
    this.authorize(destination, groupId);
    const buttons = models.slice(page * pageSize, (page + 1) * pageSize).map((model) => {
      const id = 'dad-model:' + randomBytes(12).toString('base64url');
      this.store.db.prepare('INSERT INTO bot_actions(id,data) VALUES(?,?)').run(
        id,
        JSON.stringify({
          groupId,
          role,
          model,
          page,
          chatId: destination.chatId,
          threadId: destination.threadId,
          expiresAt: new Date(Date.now() + 10 * 60000).toISOString(),
        }),
      );
      return [{ text: model.engine + ' · ' + model.name, callback_data: id }];
    });
    const engineDefaults = engines.map((engine) => {
      const id = 'dad-default:' + randomBytes(12).toString('base64url');
      this.store.db.prepare('INSERT INTO bot_actions(id,data) VALUES(?,?)').run(
        id,
        JSON.stringify({
          groupId,
          role,
          engine: engine.id,
          chatId: destination.chatId,
          threadId: destination.threadId,
          expiresAt: new Date(Date.now() + 10 * 60000).toISOString(),
        }),
      );
      return [
        {
          text:
            engine.id === currentEngine
              ? this.t('Use engine defaults')
              : `${engine.name} · ${this.t('Engine configuration')}`,
          callback_data: id,
        },
      ];
    });
    buttons.unshift(...engineDefaults);
    const navigation = [
      ...(page > 0
        ? [{ text: '←', callback_data: `dad:models:${groupId}:${role}:${page - 1}` }]
        : []),
      ...(page + 1 < pages
        ? [{ text: '→', callback_data: `dad:models:${groupId}:${role}:${page + 1}` }]
        : []),
    ];
    if (navigation.length) buttons.push(navigation);
    await this.api.send(destination, { ...text, buttons });
  }
  private async newSession(
    workspaceId: string,
    destination: Destination,
    workspace?: Workspace,
    operation?: { id: string; draft: NewSessionDraft },
  ) {
    const pending =
        operation?.draft ?? this.store.setting<NewSessionDraft>(this.creationKey(destination)),
      saved = operation
        ? this.store.setting<{ groupId: string }>(`daddy.create:${operation.id}`)
        : undefined;
    if (!saved && (!pending || pending.expiresAt <= now()))
      throw new Error(this.t('This selection expired. Start a new session again.'));
    const text = pending?.text,
      group = saved
        ? this.daddy.group(saved.groupId)
        : this.daddy.create({
            workspaceId,
            workspace,
            requirements: text,
            ...(operation ? { message: text, requestId: operation.id } : {}),
          });
    const current = this.store.setting<NewSessionDraft>(this.creationKey(destination));
    if (!operation || current?.id === pending?.id)
      this.store.setSetting(this.creationKey(destination), null);
    if (destination.chatId === this.pair()?.chatId)
      this.selectPrivateSession(destination, group.id);
    if (text && !operation)
      this.daddy.chat(group.id, text, undefined, undefined, {
        channel: 'telegram',
        ...destination,
      });
    const topic = await this.ensureTopic(group);
    if (topic && destination.chatId === topic.chatId && destination.threadId !== topic.threadId) {
      await this.api.send(destination, {
        ...new TelegramText().add(
          this.t('New session created: {title}', {
            title: this.groupText(destination, group.title),
          }),
          'bold',
        ),
        buttons: [[{ text: this.t('Open session topic'), url: this.link(topic) }]],
      });
      return group;
    }
    await this.sessionBoard(group.id, destination, topic ? this.link(topic) : undefined);
    return group;
  }
  private repoKey(destination: Destination, groupId: string) {
    return `telegram.nextRepo:${this.pair()!.userId}:${destination.chatId}:${destination.threadId ?? 0}:${groupId}`;
  }
  private repoInputKey(destination: Destination) {
    return `telegram.repoInput:${this.pair()!.userId}:${destination.chatId}`;
  }
  private repositoryInput(value: string, current?: RepositorySelection): RepositorySelection {
    const input = value.trim();
    let options = '',
      path: string | undefined;
    const separator = input.match(/^([\s\S]*?)\s+--\s+([\s\S]+)$/);
    if (separator) {
      options = separator[1].trim();
      path = separator[2].trim();
    } else if (input.startsWith('--base ') || input.startsWith('--scope ')) options = input;
    else path = input;
    const next = { ...current, ...(path ? { path } : {}) };
    let remaining = options;
    while (remaining) {
      const match = /^--(base|scope)\s+([\s\S]*?)(?=\s+--(?:base|scope)\s+|$)/.exec(remaining);
      if (!match || !match[2].trim())
        throw new Error(this.t('Use --base BRANCH and --scope SUBFOLDER before -- REPOSITORY.'));
      next[match[1] as 'base' | 'scope'] = match[2].trim();
      remaining = remaining.slice(match[0].length).trim();
    }
    return next;
  }
  private registrationKey(destination: Destination) {
    return `telegram.addWorkspace:${this.pair()!.userId}:${destination.chatId}:${destination.threadId ?? 0}`;
  }
  private registrationReplyKey(updateId: number) {
    return `telegram.registrationReply:${updateId}`;
  }
  private saveRegistrationReply(updateId: number, messages: RegistrationReply['messages']) {
    this.store.setSetting(this.registrationReplyKey(updateId), {
      expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
      messages,
    } satisfies RegistrationReply);
  }
  private async sendRegistrationReply(updateId: number) {
    const key = this.registrationReplyKey(updateId),
      reply = this.store.setting<RegistrationReply>(key);
    if (!reply || reply.expiresAt <= now()) return false;
    for (let index = 0; index < reply.messages.length; index++) {
      const message = reply.messages[index]!;
      if (message.delivered) continue;
      await this.api.send(message.destination, message.content, undefined, {
        key: `registration:${updateId}:${index}`,
      });
      message.delivered = true;
      this.store.setSetting(key, reply);
    }
    return true;
  }
  async recoverRegistrationReply(updateId: number) {
    return this.sendRegistrationReply(updateId);
  }
  isRegistrationInput(update: Update) {
    const pair = this.pair(),
      message = update.message;
    if (
      !pair ||
      !message?.text ||
      message.from?.id !== pair.userId ||
      message.chat.type !== 'private' ||
      message.chat.id !== pair.chatId ||
      !this.store.setting(this.registrationKey({ chatId: message.chat.id }))
    )
      return false;
    const text = normalizeTelegramCommand(message.text, this.username);
    return !!text && !/^\/[a-z]+(?:\s|$)/i.test(text);
  }
  isRegistrationStart(update: Update) {
    const pair = this.pair(),
      message = update.message;
    if (
      !pair ||
      !message?.text ||
      message.from?.id !== pair.userId ||
      message.chat.type !== 'private' ||
      message.chat.id !== pair.chatId
    )
      return false;
    return /^\/start\s+workspace_[A-Za-z0-9_-]{16}$/.test(
      normalizeTelegramCommand(message.text, this.username) ?? '',
    );
  }
  private repositoryButton(
    text: string,
    choice: RepoChoice,
    action: 'use' | 'browse' | 'mode' | 'copies' | 'show',
  ) {
    const id = randomBytes(12).toString('base64url');
    this.store.setSetting(`telegram.repo:${id}`, choice);
    return { text, callback_data: `dad:repo:${id}:${action}` };
  }
  private async repositoryEntry(choice: RepoChoice): Promise<void> {
    if (choice.destination.chatId === this.pair()?.chatId) return this.repository(choice);
    const pair = this.pair()!,
      id = randomBytes(12).toString('base64url');
    const privateChoice = {
      ...choice,
      controlDestination: { chatId: pair.chatId },
      inputId: id,
    };
    this.store.setSetting(`telegram.repo:${id}`, privateChoice);
    await this.api.send(choice.destination, {
      ...new TelegramText()
        .add('📁 ' + this.t('Repository for this request'), 'bold')
        .add('\n\n' + this.groupText(choice.destination, choice.workspace.name))
        .add(
          '\n\n' +
            this.t(
              'Repository paths and server folders are available only in the paired private chat.',
            ),
        ),
      buttons: [
        [
          this.repositoryButton(
            this.t(choice.groupId ? 'Use workspace defaults' : 'Start session'),
            { ...choice, input: undefined },
            'use',
          ),
        ],
        [
          {
            text: this.t('Open private chat'),
            url: `https://t.me/${this.username}?start=repo_${id}`,
          },
        ],
      ],
    });
  }
  private async repository(choice: RepoChoice, browse = false, copies = false): Promise<void> {
    if (choice.groupId) this.authorize(choice.destination, choice.groupId);
    const controlDestination = choice.controlDestination ?? choice.destination;
    if (controlDestination.chatId !== this.pair()?.chatId) return this.repositoryEntry(choice);
    if (
      choice.controlDestination &&
      choice.inputId &&
      choice.destination.chatId !== controlDestination.chatId
    )
      this.store.setSetting(this.repoInputKey(controlDestination), {
        id: choice.inputId,
        choice,
      });
    const source = choice.input?.path ?? choice.workspace.repoPath;
    const listing = browse
      ? await this.daddy.workspaces.browse(isGitAddress(source) ? undefined : source)
      : undefined;
    let preview: Workspace | undefined;
    try {
      preview = choice.input
        ? await this.daddy.workspaces.selection(choice.workspace, choice.input)
        : choice.workspace;
    } catch (error) {
      if (!browse) throw error;
    }
    this.store.db
      .prepare(
        "DELETE FROM settings WHERE key LIKE 'telegram.repo:%' AND (value='null' OR json_extract(value,'$.expiresAt') <= ?)",
      )
      .run(now());
    const button = (
      text: string,
      next: RepoChoice,
      action: 'use' | 'browse' | 'mode' | 'copies' | 'show',
    ) => this.repositoryButton(text, next, action);
    const title = new TelegramText()
      .add('📁 ' + this.t('Repository for this request'), 'bold')
      .add('\n\n' + choice.workspace.name);
    if (choice.inputId) {
      const route = choice.groupId
        ? `${this.daddy.group(choice.groupId).title} · ${choice.destination.threadId ? (this.locale() === 'ru' ? 'тема' : 'topic') : this.locale() === 'ru' ? 'общая группа' : 'general group'}`
        : `${this.locale() === 'ru' ? 'новая сессия' : 'new session'} · ${this.room()?.title ?? 'Telegram'}`;
      title.add(`\n${this.locale() === 'ru' ? 'Назначение' : 'Target'}: ${route}`, 'bold');
    }
    title.add(
      '\n' + (preview ? preview.repoPath + (preview.scope ? '/' + preview.scope : '') : source),
      'code',
    );
    if (preview)
      title
        .add('\n' + this.t('Base branch') + ': ')
        .add(preview.base ?? this.t('Default'), 'code')
        .add('\n' + this.t('Scope') + ': ')
        .add(preview.scope || '/', 'code');
    title.add(
      '\n\n' +
        this.t(
          'This selection applies only to this request. Workspace defaults and existing tasks stay as saved.',
        ),
    );
    title.add(
      '\n\n' +
        this.t(
          'For one branch or subfolder, send /repo --base BRANCH --scope SUBFOLDER -- REPOSITORY. Omit either option when it is not needed.',
        ),
    );
    const buttons = preview
      ? [
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
        ]
      : [];
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
        await this.api.send(controlDestination, {
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
      const pageSize = 10,
        pages = Math.max(1, Math.ceil(listing!.directories.length / pageSize)),
        page = Math.max(0, Math.min(choice.browsePage ?? 0, pages - 1));
      if (listing!.parent)
        buttons.push([
          button(
            '↑ ' + this.t('Parent folder'),
            { ...choice, input: { ...choice.input, path: listing!.parent }, browsePage: 0 },
            'browse',
          ),
        ]);
      for (const entry of listing!.directories.slice(page * pageSize, (page + 1) * pageSize))
        buttons.push([
          button(
            entry.name + ' →',
            { ...choice, input: { ...choice.input, path: entry.path }, browsePage: 0 },
            'browse',
          ),
        ]);
      const navigation = [
        ...(page > 0 ? [button('←', { ...choice, browsePage: page - 1 }, 'browse')] : []),
        ...(page + 1 < pages ? [button('→', { ...choice, browsePage: page + 1 }, 'browse')] : []),
      ];
      if (navigation.length) buttons.push(navigation);
      if (pages > 1) title.add('\n' + this.t('Page {page} of {pages}', { page: page + 1, pages }));
      if (listing!.truncated)
        title.add(
          '\n\n' +
            this.t('Only the first 150 folders are shown. Enter a more specific path above.') +
            ' ' +
            this.t('Send /repo followed by the exact server path to continue.'),
        );
      title.add(
        '\n\n' + this.t('You can also send /repo followed by a repository URL or server path.'),
      );
    } else buttons.push([button(this.t('Browse server folders'), choice, 'browse')]);
    if (!choice.groupId && choice.workspace.vcs === 'arcadia')
      buttons.push([button('⚙️ ' + this.t('Working copy settings'), choice, 'copies')]);
    await this.api.send(controlDestination, { ...title, buttons });
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
      (choice.controlDestination ?? choice.destination).chatId !== destination.chatId ||
      (choice.controlDestination ?? choice.destination).threadId !== destination.threadId
    )
      throw new Error(this.t('This selection expired. Choose the repository again.'));
    if (
      choice.groupId &&
      choice.destination.chatId === this.pair()?.chatId &&
      this.store.setting<string>('telegram.currentDaddy') !== choice.groupId
    ) {
      this.store.setSetting(key, null);
      throw new Error(this.t('The selected session changed. Choose the repository again.'));
    }
    if (choice.inputId) {
      const pending = this.store.setting<{ id: string }>(
        this.repoInputKey(choice.controlDestination!),
      );
      if (pending?.id !== choice.inputId)
        throw new Error(this.t('This selection expired. Choose the repository again.'));
    }
    if (choice.groupId) this.authorize(choice.destination, choice.groupId);
    else if (
      !choice.creationExpiresAt ||
      this.store.setting<{ expiresAt: string }>(this.creationKey(choice.destination))?.expiresAt !==
        choice.creationExpiresAt
    )
      throw new Error(this.t('This selection expired. Start a new session again.'));
    if (match[2] !== 'use')
      await this.repository(choice, match[2] === 'browse', match[2] === 'copies');
    else {
      const selected = await this.daddy.workspaces.selection(choice.workspace, choice.input);
      if (choice.groupId) {
        this.store.setSetting(this.repoKey(choice.destination, choice.groupId), {
          workspace: selected,
          expiresAt: choice.expiresAt,
        });
        const response = new TelegramText()
          .add('📁 ' + this.t('Repository for next task'), 'bold')
          .add('\n\n' + this.groupText(destination, choice.workspace.name));
        if (destination.chatId === this.pair()?.chatId)
          response.add(
            '\n' + selected.repoPath + (selected.scope ? '/' + selected.scope : ''),
            'code',
          );
        const buttons: TelegramButton[][] = [];
        if (choice.controlDestination) {
          const group = this.daddy.group(choice.groupId);
          if (choice.destination.threadId) {
            response.add(
              '\n\n' +
                this.t(
                  'Send /task in the original topic for {title}. This folder applies only to that topic.',
                  { title: group.title },
                ),
            );
            buttons.push([
              {
                text: this.t('Open session topic'),
                url: this.link({
                  ...choice.destination,
                  threadId: choice.destination.threadId,
                  groupId: group.id,
                  ownerId: this.pair()!.userId,
                }),
              },
            ]);
          } else
            response.add(
              '\n\n' +
                this.t(
                  'Return to {title} and send /task there. This folder applies only to that group route.',
                  { title: this.room()?.title ?? group.title },
                ),
            );
        } else {
          const group = this.daddy.group(choice.groupId);
          response.add(
            '\n\n' +
              this.t(
                'Send the task now for {title}. The following message will use the defaults again.',
                { title: this.groupText(destination, group.title) },
              ),
          );
        }
        await this.api.send(destination, { ...response, ...(buttons.length ? { buttons } : {}) });
      } else await this.newSession(choice.workspace.id, choice.destination, selected);
      if (choice.controlDestination && choice.inputId) {
        const pending = this.store.setting<{ id: string }>(
          this.repoInputKey(choice.controlDestination),
        );
        if (pending?.id === choice.inputId)
          this.store.setSetting(this.repoInputKey(choice.controlDestination), null);
      }
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
        [{ text: this.t('Add workspace'), callback_data: 'dad:add-workspace:standalone' }],
        [{ text: this.t('Workspaces'), callback_data: 'dad:workspaces' }],
      ],
    });
  }
  private findWorkspace(value: string) {
    const query = value.trim().toLowerCase();
    const matches = this.daddy.workspaces
      .list()
      .filter(
        (workspace) =>
          workspace.id === query ||
          workspace.id.startsWith(query) ||
          workspace.name.toLowerCase() === query,
      );
    if (matches.length !== 1)
      throw new Error(this.t('Choose one workspace by its exact name or unique ID prefix.'));
    return matches[0];
  }
  private async workspacesCard(destination: Destination) {
    if (destination.chatId !== this.pair()?.chatId)
      return this.privateStep(
        destination,
        this.t('Repository paths and defaults are available in the private bot chat.'),
      );
    const workspaces = this.daddy.workspaces.list();
    await this.api.send(destination, {
      ...new TelegramText()
        .add('📁 ' + this.t('Repositories'), 'bold')
        .add(
          '\n\n' +
            this.t(
              'Choose a workspace to inspect or edit its saved name, source, scope, base branch and copy mode.',
            ),
        ),
      buttons: [
        ...workspaces.map((workspace) => [
          {
            text: workspace.name,
            callback_data: `dad:workspace:${workspace.id}`,
          },
        ]),
        [
          {
            text: '＋ ' + this.t('Add repository'),
            callback_data: 'dad:add-workspace:standalone',
          },
        ],
        [{ text: this.t('Find on server'), callback_data: 'dad:discover:standalone' }],
        [{ text: this.t('Back'), callback_data: 'dad:settings' }],
      ],
    });
  }
  private async workspaceCard(workspace: Workspace, destination: Destination) {
    if (destination.chatId !== this.pair()?.chatId)
      return this.privateStep(
        destination,
        this.t('Repository paths and defaults are available in the private bot chat.'),
      );
    const text = new TelegramText()
      .add('📁 ' + workspace.name, 'bold')
      .add('\n\nID: ' + workspace.id, 'code')
      .add('\n' + this.t('Source') + ': ' + workspace.repoPath, 'code')
      .add('\n' + this.t('Scope') + ': ' + (workspace.scope || '/'), 'code')
      .add('\n' + this.t('Base branch') + ': ' + (workspace.base ?? this.t('Default')), 'code')
      .add(
        '\n' +
          this.t('Working copies') +
          ': ' +
          (workspace.copyMode ?? (workspace.vcs === 'arcadia' ? 'session' : 'session')),
        'code',
      )
      .add(
        '\n\n' +
          this.t(
            'Edit one saved value with /workspace <ID> name|path|scope|base|provider|copies <value>. Clear scope or base with /workspace <ID> clear scope|base.',
          ),
      );
    await this.api.send(destination, {
      ...text,
      buttons: [[{ text: this.t('Back'), callback_data: 'dad:workspaces' }]],
    });
  }
  private async editWorkspace(
    workspace: Workspace,
    field: 'name' | 'path' | 'scope' | 'base' | 'provider' | 'copies',
    raw: string,
    destination: Destination,
    clear = false,
  ) {
    if (destination.chatId !== this.pair()?.chatId)
      return this.privateStep(
        destination,
        this.t('Repository paths and defaults are available in the private bot chat.'),
      );
    const value = raw.trim();
    if (!value && !clear) throw new Error(this.t('Send a value to save.'));
    if (field === 'copies' && !['session', 'pool'].includes(value))
      throw new Error(this.t('Choose session or pool copy mode.'));
    const saved = await this.daddy.workspaces.register(
      {
        name: field === 'name' ? value : workspace.name,
        path: field === 'path' ? value : workspace.repoPath,
        scope: field === 'scope' ? (clear ? '' : value) : workspace.scope,
        base: field === 'base' ? (clear ? undefined : value) : workspace.base,
        copyMode:
          field === 'copies'
            ? value === 'session' || value === 'pool'
              ? value
              : undefined
            : workspace.copyMode,
        provider: field === 'provider' ? value : workspace.provider,
      },
      workspace.id,
    );
    await this.workspaceCard(saved, destination);
  }
  private async discover(
    destination: Destination,
    purpose: 'new' | 'standalone',
    draftId?: string,
    page = 0,
  ) {
    if (purpose === 'new') this.creationDraft(destination, draftId ?? 'legacy');
    const suggestions = await this.daddy.workspaces.suggestions(),
      pageSize = 10,
      pages = Math.max(1, Math.ceil(suggestions.length / pageSize));
    page = Math.max(0, Math.min(page, pages - 1));
    const text = new TelegramText().add('📁 ' + this.t('Workspaces on this server'), 'bold');
    const buttons = suggestions.slice(page * pageSize, (page + 1) * pageSize).map((item) => {
      const id = 'dad-workspace:' + randomBytes(12).toString('base64url');
      this.store.db.prepare('INSERT INTO bot_actions(id,data) VALUES(?,?)').run(
        id,
        JSON.stringify({
          ...item,
          purpose,
          draftId,
          chatId: destination.chatId,
          threadId: destination.threadId,
          expiresAt: new Date(Date.now() + 10 * 60000).toISOString(),
        }),
      );
      return [{ text: this.groupText(destination, item.name), callback_data: id }];
    });
    text.add(pages > 1 ? '\n' + this.t('Page {page} of {pages}', { page: page + 1, pages }) : '');
    text.add(
      '\n\n' +
        this.t(
          'Choose a repository to register it. You can choose a subdirectory and base branch on the website.',
        ),
    );
    await this.api.send(destination, {
      ...text,
      buttons: [
        ...buttons,
        [
          ...(page > 0
            ? [
                {
                  text: '←',
                  callback_data:
                    purpose === 'new'
                      ? `dad:discover-page:new:${draftId}:${page - 1}`
                      : `dad:discover-page:standalone:${page - 1}`,
                },
              ]
            : []),
          ...(page + 1 < pages
            ? [
                {
                  text: '→',
                  callback_data:
                    purpose === 'new'
                      ? `dad:discover-page:new:${draftId}:${page + 1}`
                      : `dad:discover-page:standalone:${page + 1}`,
                },
              ]
            : []),
        ],
        [
          {
            text: this.t('Back'),
            callback_data: purpose === 'new' ? `dad:new-page:${draftId}:0` : 'dad:workspaces',
          },
        ],
      ].filter((row) => row.length),
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
  private creationDraft(destination: Destination, id: string) {
    const draft = this.store.setting<NewSessionDraft>(this.creationKey(destination));
    if (!draft || draft.id !== id || draft.expiresAt <= now())
      throw new Error(this.t('This selection expired. Start a new session again.'));
    return draft;
  }
  async callback(data: string, destination: Destination): Promise<boolean> {
    if (await this.presetControlCallback(data, destination)) return true;
    const presetPage = /^dad:presets:(library|[a-f0-9-]{36}):([0-9]+)$/.exec(data);
    if (presetPage) {
      await this.presetsCard(
        presetPage[1] === 'library' ? undefined : this.presetSession(destination, presetPage[1]),
        destination,
        Number(presetPage[2]),
      );
      return true;
    }
    if (await this.taskControlCallback(data, destination)) return true;
    const taskList = /^dad:tasks:([a-f0-9-]{36})(?::([0-9]+))?$/.exec(data);
    if (taskList) {
      await this.tasksCard(
        this.authorizeControl(destination, taskList[1]),
        destination,
        Number(taskList[2] ?? 0),
      );
      return true;
    }
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
      const board = await this.daddy.settings(id, { autoMerge: sessionMerge[2] === 'on' });
      await this.api.send(
        destination,
        sessionSettings(this.locale(), this.groupBoard(destination, board)),
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
    const modelDefault = /^dad-default:([A-Za-z0-9_-]{16})(?::(save|force))?$/.exec(data);
    if (modelDefault) {
      const key = 'dad-default:' + modelDefault[1],
        row = this.store.db.prepare('SELECT data,consumed FROM bot_actions WHERE id=?').get(key);
      if (!row || row.consumed)
        throw new Error(this.t('This model selection expired. Open Models again.'));
      const action = JSON.parse(row.data as string) as {
        groupId: string;
        role: 'worker' | 'daddy';
        engine: string;
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
      const group = this.authorizeModelControl(destination, action.groupId),
        role = action.role,
        profile = { engine: action.engine };
      if (!modelDefault[2]) {
        await this.api.send(destination, {
          ...new TelegramText()
            .add(this.t('Use engine defaults'), 'bold')
            .add('\n' + this.groupText(destination, group.title))
            .add('\n' + action.engine, 'code')
            .add('\n\n' + this.t('Model') + ': ' + this.t('Engine configuration'))
            .add('\n' + this.t('Reasoning effort') + ': ' + this.t('Default')),
          buttons: [
            [
              {
                text: this.t('Use engine defaults'),
                callback_data: `${key}:save`,
              },
              ...(role === 'daddy'
                ? [
                    {
                      text: this.t('Apply now · {effort}', { effort: this.t('Default') }),
                      callback_data: `${key}:force`,
                    },
                  ]
                : []),
            ],
            [{ text: this.t('Back'), callback_data: `dad:models:${group.id}:${role}` }],
          ],
        });
        return true;
      }
      await this.daddy.settings(group.id, {
        profiles: { [role]: profile },
        forceDaddy: role === 'daddy' && modelDefault[2] === 'force',
        applyWorkers: role === 'worker',
      });
      this.store.db.prepare('UPDATE bot_actions SET consumed=1 WHERE id=?').run(key);
      await this.models(group.id, destination);
      return true;
    }
    const modelAction = data.match(
      /^dad-model:([A-Za-z0-9_-]{16})(?::(default|[0-9]{1,2})(:force)?)?$/,
    );
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
        page?: number;
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
      const group = this.authorizeModelControl(destination, action.groupId);
      if (modelAction[2] === undefined) {
        const text = new TelegramText()
          .add(action.model.name, 'bold')
          .add('\n' + this.groupText(destination, group.title))
          .add('\n\n' + this.t('Reasoning effort'));
        await this.api.send(destination, {
          ...text,
          buttons: [
            [
              { text: this.t('Default effort'), callback_data: `${key}:default` },
              ...(action.role === 'daddy'
                ? [
                    {
                      text: this.t('Apply now · {effort}', { effort: this.t('Default') }),
                      callback_data: `${key}:default:force`,
                    },
                  ]
                : []),
            ],
            ...action.model.efforts.map((effort, index) => [
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
            [
              {
                text: this.t('Back'),
                callback_data: `dad:models:${group.id}:${action.role}:${action.page ?? 0}`,
              },
            ],
          ],
        });
      } else {
        const effort =
          modelAction[2] === 'default' ? undefined : action.model.efforts[Number(modelAction[2])];
        if (modelAction[2] !== 'default' && !effort)
          throw new Error('Unsupported reasoning effort');
        await this.daddy.settings(group.id, {
          profiles: {
            [action.role]: {
              engine: action.model.engine,
              model: action.model.id,
              ...(effort ? { effort } : {}),
            },
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
        purpose?: 'new' | 'standalone';
        draftId?: string;
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
      if (!action.purpose)
        throw new Error(this.t('This selection expired. Open Workspaces again.'));
      if (action.purpose === 'new') this.creationDraft(destination, action.draftId ?? 'legacy');
      const workspace = await this.daddy.workspaces.register({
        name: action.name,
        path: action.path,
      });
      this.store.db.prepare('UPDATE bot_actions SET consumed=1 WHERE id=?').run(data);
      if (action.purpose === 'new')
        await this.api.send(destination, this.workspacePickerCard(destination, [workspace]));
      else await this.workspacesCard(destination);
      return true;
    }
    if (data.startsWith('dad-workspace-new:')) {
      const row = this.store.db
        .prepare('SELECT data,consumed FROM bot_actions WHERE id=?')
        .get(data);
      if (!row || row.consumed)
        throw new Error(this.t('This selection expired. Start a new session again.'));
      const action = JSON.parse(String(row.data)) as {
        workspaceId: string;
        destination: Destination;
        creationId?: string;
        creationText?: string;
        creationExpiresAt: string;
        ownerId: number;
        expiresAt: string;
      };
      const draft = this.store.setting<NewSessionDraft>(this.creationKey(destination)),
        saved = this.store.setting<{ groupId: string }>(`daddy.create:${data}`);
      if (
        action.ownerId !== this.pair()?.userId ||
        action.destination.chatId !== destination.chatId ||
        action.destination.threadId !== destination.threadId ||
        !action.creationId ||
        (!saved &&
          (action.expiresAt <= now() ||
            !draft ||
            draft.id !== action.creationId ||
            draft.expiresAt !== action.creationExpiresAt ||
            draft.expiresAt <= now()))
      )
        throw new Error(this.t('The original new-session draft expired. Start /new again.'));
      const group = await this.newSession(action.workspaceId, destination, undefined, {
        id: data,
        draft:
          draft?.id === action.creationId
            ? draft
            : {
                id: action.creationId,
                text: action.creationText,
                expiresAt: action.creationExpiresAt,
              },
      });
      this.store.db
        .prepare('UPDATE bot_actions SET data=?,consumed=1 WHERE id=?')
        .run(JSON.stringify({ ...action, groupId: group.id }), data);
      return true;
    }
    if (!data.startsWith('dad:')) return false;
    if (data === 'dad:modules') {
      await this.modules(destination);
      return true;
    }
    const workspaceDetails = data.match(/^dad:workspace:([a-f0-9-]{36})$/);
    if (workspaceDetails) {
      await this.workspaceCard(this.daddy.workspaces.get(workspaceDetails[1]), destination);
      return true;
    }
    const addWorkspace = /^dad:add-workspace(?::(new|standalone))?(?::([A-Za-z0-9_-]+))?$/.exec(
      data,
    );
    if (addWorkspace) {
      const purpose = addWorkspace[1] ?? 'standalone',
        draftId = addWorkspace[2];
      if (purpose === 'new') this.creationDraft(destination, draftId ?? 'legacy');
      this.store.setSetting(this.registrationKey(destination), null);
      await this.api.send(destination, {
        ...new TelegramText()
          .add('📦 ' + this.t('Add repository'), 'bold')
          .add('\n\n' + this.t('Choose the repository service.')),
        buttons: [
          ...this.daddy.workspaces.modules().map((module) => [
            {
              text: module.name,
              callback_data:
                purpose === 'new'
                  ? `dad:workspace-module:new:${draftId}:${module.id}`
                  : `dad:workspace-module:standalone:${module.id}`,
            },
          ]),
          [{ text: this.t('Cancel'), callback_data: 'dad:workspaces' }],
        ],
      });
      return true;
    }
    const boundWorkspaceModule =
        /^dad:workspace-module:(?:(new):([A-Za-z0-9_-]+)|(standalone)):(.+)$/.exec(data),
      legacyWorkspaceModule = /^dad:workspace-module:(.+)$/.exec(data),
      workspaceModule = boundWorkspaceModule ?? legacyWorkspaceModule;
    if (workspaceModule) {
      const purpose = boundWorkspaceModule?.[1] === 'new' ? 'new' : 'standalone',
        draftId = boundWorkspaceModule?.[2],
        moduleId = boundWorkspaceModule ? boundWorkspaceModule[4] : legacyWorkspaceModule![1];
      const module = this.daddy.workspaces.modules().find((module) => module.id === moduleId);
      if (!module) throw new Error(this.t('Choose an enabled repository service.'));
      const boundDraft = purpose === 'new' ? this.creationDraft(destination, draftId!) : undefined;
      if (destination.chatId !== this.pair()?.chatId) {
        const id = randomBytes(12).toString('base64url');
        this.store.db
          .prepare(
            "DELETE FROM settings WHERE key LIKE 'telegram.workspacePrivate:%' AND (value='null' OR json_extract(value,'$.expiresAt') <= ?)",
          )
          .run(now());
        const creation = boundDraft;
        this.store.setSetting(`telegram.workspacePrivate:${id}`, {
          provider: module.id,
          origin: destination,
          creationBound: !!creation,
          creationId: creation?.id,
          creationText: creation?.text,
          creationExpiresAt: creation?.expiresAt,
          ownerId: this.pair()!.userId,
          expiresAt: new Date(Date.now() + 10 * 60000).toISOString(),
        });
        await this.api.send(destination, {
          ...new TelegramText().add(
            this.t('Repository source and name are entered in the paired private chat.'),
          ),
          buttons: [
            [
              {
                text: this.t('Open private chat'),
                url: `https://t.me/${this.username}?start=workspace_${id}`,
              },
            ],
          ],
        });
        return true;
      }
      const creation = boundDraft;
      this.store.setSetting(this.registrationKey(destination), {
        provider: module.id,
        creationBound: !!creation,
        ...(creation
          ? {
              origin: destination,
              creationBound: true,
              creationId: creation.id,
              creationText: creation.text,
              creationExpiresAt: creation.expiresAt,
            }
          : {}),
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
    const sessionsPage = /^dad:sessions-page:(\d+)$/.exec(data);
    if (sessionsPage) {
      await this.home(destination, Number(sessionsPage[1]));
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
        await this.api.send(
          destination,
          sessionSettings(this.locale(), this.groupBoard(destination, this.daddy.board(id))),
        );
      }
      return true;
    }
    const discover = /^dad:discover:(new|standalone)(?::([A-Za-z0-9_-]+))?$/.exec(data);
    if (discover) {
      await this.discover(destination, discover[1] as 'new' | 'standalone', discover[2]);
      return true;
    }
    if (data === 'dad:discover')
      throw new Error(this.t('This selection expired. Open Workspaces again.'));
    const discoverPage = /^dad:discover-page:(new|standalone)(?::([A-Za-z0-9_-]+))?:(\d+)$/.exec(
      data,
    );
    if (discoverPage) {
      await this.discover(
        destination,
        discoverPage[1] as 'new' | 'standalone',
        discoverPage[2],
        Number(discoverPage[3]),
      );
      return true;
    }
    if (data.startsWith('dad:discover-page:'))
      throw new Error(this.t('This selection expired. Open Workspaces again.'));
    if (data === 'dad:workspaces') {
      await this.workspacesCard(destination);
      return true;
    }
    if (data === 'dad:new') {
      this.store.setSetting(this.creationKey(destination), {
        id: randomBytes(12).toString('base64url'),
        expiresAt: new Date(Date.now() + 10 * 60000).toISOString(),
      });
      await this.api.send(
        destination,
        this.workspacePickerCard(destination, this.daddy.workspaces.list()),
      );
      return true;
    }
    const workspacePage = /^dad:new-page:([A-Za-z0-9_-]+):(\d+)$/.exec(data);
    if (workspacePage) {
      this.creationDraft(destination, workspacePage[1]);
      await this.api.send(
        destination,
        this.workspacePickerCard(
          destination,
          this.daddy.workspaces.list(),
          Number(workspacePage[2]),
        ),
      );
      return true;
    }
    if (data.startsWith('dad:new-page:'))
      throw new Error(this.t('This selection expired. Start a new session again.'));
    const deleting = data.match(/^dad:(delete|del):([a-f0-9-]{36})(?::([0-9]+))?$/);
    if (deleting) {
      const group = this.authorize(destination, deleting[2]);
      if (!this.daddy.board(group.id).canDelete)
        throw new Error(this.t('This repository module does not support managed session deletion'));
      if (deleting[1] === 'delete') {
        await this.api.send(destination, {
          ...new TelegramText()
            .add(this.t('Delete session') + ': ' + this.groupText(destination, group.title), 'bold')
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
        if ('group' in result)
          await this.api.send(
            destination,
            daddyBoard(this.locale(), this.groupBoard(destination, result)),
          );
      }
      return true;
    }
    const models = data.match(/^dad:models:([a-f0-9-]{36})(?::(worker|daddy))?(?::([0-9]+))?$/);
    if (models) {
      await this.models(
        models[1],
        destination,
        models[2] as 'worker' | 'daddy' | undefined,
        Number(models[3] ?? 0),
      );
      return true;
    }
    const instructions = data.match(/^dad:instructions:([a-f0-9-]{36})$/);
    if (instructions) {
      const group = this.authorize(destination, instructions[1]);
      if (destination.chatId !== this.pair()?.chatId) {
        await this.privateSessionStep(
          destination,
          group,
          this.t('Instruction text and skills are managed only in the paired private chat.'),
        );
        return true;
      }
      await this.api.send(
        destination,
        new TelegramText().add(instructionLines(group.instructions, this.locale()).join('\n')),
      );
      return true;
    }
    const boundNew = /^dad:new:([A-Za-z0-9_-]+):([a-f0-9-]{36})$/.exec(data);
    if (boundNew) {
      const pending = this.creationDraft(destination, boundNew[1]),
        workspaceId = boundNew[2];
      this.store.setSetting(this.creationKey(destination), { ...pending, workspaceId });
      await this.repository({
        destination,
        workspace: this.daddy.workspaces.get(workspaceId),
        ownerId: this.pair()!.userId,
        expiresAt: pending.expiresAt,
        creationExpiresAt: pending.expiresAt,
      });
      return true;
    }
    if (data.startsWith('dad:new:'))
      throw new Error(this.t('This selection expired. Start a new session again.'));
    const match = data.match(/^dad:(open|add|pause|resume|pool):([a-f0-9-]{36})(?::([1-8]))?$/);
    if (!match) throw new Error('Unknown daddy action');
    const [, action, id, limit] = match;
    if (
      action === 'open' &&
      destination.chatId !== this.pair()?.chatId &&
      this.groupAt(destination) !== id
    ) {
      const topic = await this.ensureTopic(this.daddy.group(id));
      if (topic)
        await this.api.send(destination, {
          ...new TelegramText().add(
            this.groupText(destination, this.daddy.group(id).title),
            'bold',
          ),
          buttons: [[{ text: this.t('Open session topic'), url: this.link(topic) }]],
        });
      return true;
    }
    const group = this.authorize(destination, id);
    if (action === 'pool') {
      if (limit) await this.daddy.settings(id, { workerLimit: Number(limit) });
      await this.api.send(
        destination,
        poolCard(this.locale(), this.groupBoard(destination, this.daddy.board(id))),
      );
      return true;
    }
    if (action === 'pause') await this.daddy.pause(id);
    if (action === 'resume') await this.daddy.resume(id);
    if (action === 'add') {
      if (destination.chatId === this.pair()?.chatId) this.selectPrivateSession(destination, id);
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
    const replyTo = telegramReply(message);
    const replyGroup =
      privateChat && replyTo?.messageId && !message?.text?.trimStart().startsWith('/')
        ? this.api.delivery?.replySession(chat.id, replyTo.messageId, pair.userId)
        : undefined;
    try {
      if (callback) {
        if (
          !callback.data?.startsWith('dad:') &&
          !callback.data?.startsWith('dad-workspace:') &&
          !callback.data?.startsWith('dad-workspace-new:') &&
          !callback.data?.startsWith('dad-model:') &&
          !callback.data?.startsWith('dad-default:') &&
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
      if (message?.document) return await this.handleDocument(update, destination, privateChat);
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
      const text = message?.text
        ? normalizeTelegramCommand(message.text, this.username)
        : undefined;
      if (!text) return false;
      const privateInput =
        privateChat && (this.isRegistrationInput(update) || !text.startsWith('/'))
          ? update.update_id
          : undefined;
      if (privateInput !== undefined)
        this.store.db
          .prepare(
            "DELETE FROM settings WHERE key LIKE 'telegram.registrationReply:%' AND json_extract(value,'$.expiresAt') <= ?",
          )
          .run(now());
      if (
        this.store.db.prepare('SELECT 1 FROM bot_receipts WHERE id=?').get(update.update_id) &&
        this.store.setting(this.registrationReplyKey(update.update_id))
      ) {
        await this.sendRegistrationReply(update.update_id);
        return true;
      }
      const recordPrivateInput = (messages: RegistrationReply['messages'] = []) => {
        if (privateInput !== undefined) {
          this.store.db
            .prepare('INSERT OR IGNORE INTO bot_receipts VALUES(?,?)')
            .run(privateInput, now());
          if (messages.length) this.saveRegistrationReply(privateInput, messages);
        }
      };
      if (text === '/cancel') {
        const document = this.store.setting(this.documentKey(destination)),
          repository = privateChat ? this.store.setting(this.repoInputKey(destination)) : undefined;
        if (document) this.store.setSetting(this.documentKey(destination), null);
        if (repository) this.store.setSetting(this.repoInputKey(destination), null);
        if (document || repository) {
          await this.api.send(
            destination,
            this.t(document ? 'File import cancelled.' : 'Repository selection cancelled.'),
          );
          return true;
        }
      }
      const help = /^\/help(?:\s+([\s\S]*))?$/i.exec(text);
      if (help) {
        await this.api.send(
          destination,
          commandHelp(this.locale(), privateChat ? 'private' : 'group', help[1]),
        );
        return true;
      }
      const repositoryStart = privateChat
        ? /^\/start\s+repo_([A-Za-z0-9_-]{16})$/.exec(text)
        : undefined;
      const taskStart = privateChat ? /^\/start\s+task_([a-f0-9-]{36})$/.exec(text) : undefined;
      const workspaceStart = privateChat
        ? /^\/start\s+workspace_([A-Za-z0-9_-]{16})$/.exec(text)
        : undefined;
      if (workspaceStart) {
        const key = `telegram.workspacePrivate:${workspaceStart[1]}`,
          pending = this.store.setting<{
            provider: string;
            origin: Destination;
            creationBound?: boolean;
            creationId?: string;
            creationText?: string;
            creationExpiresAt?: string;
            ownerId: number;
            expiresAt: string;
          }>(key);
        if (!pending || pending.ownerId !== pair.userId || pending.expiresAt <= now()) {
          this.store.db.prepare('DELETE FROM settings WHERE key=?').run(key);
          throw new Error(this.t('This selection expired. Open repository registration again.'));
        }
        const content = this.t('Send a repository URL or an absolute server path.');
        this.store.transaction(() => {
          this.store.db.prepare('DELETE FROM settings WHERE key=?').run(key);
          this.store.setSetting(this.registrationKey(destination), {
            provider: pending.provider,
            origin: pending.origin,
            creationBound:
              pending.creationBound ??
              (pending.creationId && pending.creationExpiresAt ? true : undefined),
            creationId: pending.creationId,
            creationText: pending.creationText,
            creationExpiresAt: pending.creationExpiresAt,
            expiresAt: pending.expiresAt,
          });
          this.store.db
            .prepare('INSERT OR IGNORE INTO bot_receipts VALUES(?,?)')
            .run(update.update_id, now());
          this.saveRegistrationReply(update.update_id, [{ destination, content }]);
        });
        await this.sendRegistrationReply(update.update_id);
        return true;
      }
      if (taskStart) {
        const task = this.store.getTask(taskStart[1]);
        if (!task.groupId) throw new Error(this.t('Task not found in this session'));
        this.selectPrivateSession(destination, task.groupId);
        await this.taskCard(task, destination);
        return true;
      }
      if (repositoryStart) {
        const key = `telegram.repo:${repositoryStart[1]}`,
          choice = this.store.setting<RepoChoice>(key);
        if (
          !choice ||
          choice.expiresAt <= now() ||
          choice.ownerId !== pair.userId ||
          choice.controlDestination?.chatId !== pair.chatId
        )
          throw new Error(this.t('This selection expired. Choose the repository again.'));
        await this.repository(choice);
        this.store.setSetting(key, null);
        return true;
      }
      const registrationKey = this.registrationKey(destination);
      const registration = this.store.setting<{
        provider: string;
        path?: string;
        origin?: Destination;
        creationBound?: boolean;
        creationId?: string;
        creationText?: string;
        creationExpiresAt?: string;
        expiresAt: string;
      }>(registrationKey);
      if (registration) {
        if (!privateChat) {
          this.store.setSetting(registrationKey, null);
          await this.privateStep(
            destination,
            this.t('Repository source and name are entered in the paired private chat.'),
          );
          return true;
        }
        const creationBound =
          registration.creationBound ??
          (registration.origin && registration.creationId && registration.creationExpiresAt
            ? true
            : undefined);
        if (creationBound === undefined) {
          const content = this.t('This selection expired. Open repository registration again.');
          this.store.transaction(() => {
            this.store.setSetting(registrationKey, null);
            recordPrivateInput([{ destination, content }]);
          });
          if (privateInput !== undefined) await this.sendRegistrationReply(privateInput);
          else await this.api.send(destination, content);
          return true;
        }
        if (registration.expiresAt <= now()) {
          const content = this.t('Repository registration expired. Start it again.');
          this.store.transaction(() => {
            this.store.setSetting(registrationKey, null);
            recordPrivateInput([{ destination, content }]);
          });
          if (privateInput !== undefined) await this.sendRegistrationReply(privateInput);
          else await this.api.send(destination, content);
          return true;
        }
        if (/^\/[a-z]+(?:\s|$)/i.test(text)) {
          this.store.setSetting(registrationKey, null);
          if (text === '/cancel') {
            if (creationBound) {
              const target = registration.origin ?? destination;
              this.creationDraft(target, registration.creationId ?? 'legacy');
              await this.api.send(
                target,
                this.workspacePickerCard(target, this.daddy.workspaces.list()),
              );
            } else await this.workspacesCard(destination);
            return true;
          }
        } else if (!registration.path) {
          const path = isGitAddress(text) ? parseGitSource(text).url : text;
          if (path.length > 4000 || (!isGitAddress(path) && !/^(\/|~\/)/.test(path)))
            throw new Error(this.t('Send a repository URL or an absolute server path.'));
          const content = {
            ...new TelegramText()
              .add('📦 ' + this.t('Workspace name'), 'bold')
              .add('\n\n' + this.t('Send a short name, for example Work or My app.')),
            buttons: [[{ text: this.t('Cancel'), callback_data: 'dad:workspaces' }]],
          };
          this.store.transaction(() => {
            this.store.setSetting(registrationKey, { ...registration, path });
            recordPrivateInput([{ destination, content }]);
          });
          if (privateInput !== undefined) await this.sendRegistrationReply(privateInput);
          else await this.api.send(destination, content);
          return true;
        } else {
          const target = registration.origin ?? destination;
          let draft: NewSessionDraft | undefined;
          if (registration.origin && creationBound) {
            draft = this.store.setting<NewSessionDraft>(this.creationKey(target));
            if (
              !registration.creationId ||
              !registration.creationExpiresAt ||
              !draft ||
              draft.id !== registration.creationId ||
              draft.expiresAt !== registration.creationExpiresAt ||
              draft.expiresAt <= now()
            ) {
              const content = this.t('The original new-session draft expired. Start /new again.');
              this.store.transaction(() => {
                this.store.setSetting(registrationKey, null);
                recordPrivateInput([{ destination, content }]);
              });
              if (privateInput !== undefined) await this.sendRegistrationReply(privateInput);
              else await this.api.send(destination, content);
              return true;
            }
          }
          const workspace = await this.daddy.workspaces.register({
            name: text,
            path: registration.path,
            provider: registration.provider,
          });
          const actionId = creationBound
              ? 'dad-workspace-new:' + randomBytes(12).toString('base64url')
              : undefined,
            messages: RegistrationReply['messages'] = actionId
              ? [
                  {
                    destination: target,
                    content: {
                      ...new TelegramText().add(this.groupText(target, workspace.name), 'bold'),
                      buttons: [
                        [{ text: this.t('Continue new session'), callback_data: actionId }],
                      ],
                    },
                  },
                  ...(target.chatId !== destination.chatId ||
                  target.threadId !== destination.threadId
                    ? [
                        {
                          destination,
                          content: this.t(
                            'Repository saved. Continue the new session in the original chat.',
                          ),
                        },
                      ]
                    : []),
                ]
              : [
                  {
                    destination: target,
                    content: {
                      ...new TelegramText().add(
                        '📁 ' + this.groupText(target, workspace.name),
                        'bold',
                      ),
                      buttons: [
                        [{ text: this.t('Repositories'), callback_data: 'dad:workspaces' }],
                      ],
                    },
                  },
                ];
          this.store.transaction(() => {
            this.store.setSetting(registrationKey, null);
            recordPrivateInput(messages);
            if (actionId)
              this.store.db.prepare('INSERT INTO bot_actions(id,data) VALUES(?,?)').run(
                actionId,
                JSON.stringify({
                  workspaceId: workspace.id,
                  destination: target,
                  creationId: registration.creationId,
                  creationText: draft!.text,
                  creationExpiresAt: registration.creationExpiresAt,
                  ownerId: pair.userId,
                  expiresAt: registration.creationExpiresAt,
                }),
              );
          });
          if (privateInput !== undefined) await this.sendRegistrationReply(privateInput);
          else
            for (const message of messages)
              await this.api.send(message.destination, message.content);
          return true;
        }
      }

      if (text === '/modules') {
        await this.modules(destination);
        return true;
      }
      if (text === '/help') {
        await this.help(destination, privateChat);
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
      if (text === '/web' && !privateChat) {
        await this.api.send(destination, {
          ...new TelegramText().add(
            this.locale() === 'ru'
              ? 'Приватная ссылка входа доступна только в личном чате с ботом.'
              : 'A private login link is available only in the private bot chat.',
          ),
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
            id: randomBytes(12).toString('base64url'),
            text: text.slice(4).trim() || undefined,
            expiresAt: new Date(Date.now() + 10 * 60000).toISOString(),
          });
          await this.api.send(
            destination,
            this.workspacePickerCard(destination, this.daddy.workspaces.list()),
          );
          return true;
        }
        return this.callback('dad:workspaces', destination);
      }
      const workspaceEdit = text.match(
        /^\/workspace\s+(\S+)\s+(name|path|scope|base|provider|copies)\s+([\s\S]+)$/,
      );
      const workspaceClear = text.match(/^\/workspace\s+(\S+)\s+clear\s+(scope|base)$/);
      const workspaceCommand = text.match(/^\/workspace(?:\s+([\s\S]+))?$/);
      if (workspaceEdit || workspaceClear || workspaceCommand) {
        if (!workspaceEdit && !workspaceCommand?.[1]) {
          await this.workspacesCard(destination);
          return true;
        }
        const workspace = this.findWorkspace(
          workspaceEdit
            ? workspaceEdit[1]
            : workspaceClear
              ? workspaceClear[1]
              : workspaceCommand![1],
        );
        if (!workspaceEdit && !workspaceClear) await this.workspaceCard(workspace, destination);
        else
          await this.editWorkspace(
            workspace,
            (workspaceEdit?.[2] ?? workspaceClear![2]) as
              'name' | 'path' | 'scope' | 'base' | 'provider' | 'copies',
            workspaceEdit?.[3] ?? '',
            destination,
            !!workspaceClear,
          );
        return true;
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
        this.store.transaction(() => {
          this.saveTopic(topic);
          this.store.setSetting(this.selectedSessionKey(destination), null);
          this.store.db
            .prepare("UPDATE operations SET status='done',result=? WHERE id=? AND status='pending'")
            .run(JSON.stringify(topic), `telegram:topic:${this.key(this.room()!, groups[0].id)}`);
        });
        await this.show(groups[0].id, destination);
        return true;
      }
      const conversationGroupId = privateChat
        ? (replyGroup ?? this.store.setting<string>('telegram.currentDaddy'))
        : this.groupAt(destination);
      const groupId =
        conversationGroupId ??
        (!privateChat && this.room()?.chatId === destination.chatId
          ? this.store.setting<string>(this.selectedSessionKey(destination))
          : undefined);
      const session = text.match(/^\/session(?:\s+([\s\S]+))?$/);
      if (session) {
        if (!session[1]) {
          await this.home(destination);
          await this.api.send(
            destination,
            this.locale() === 'ru'
              ? 'Выбери сессию кнопкой или отправь /session <имя или ID>.'
              : 'Choose a session above or send /session <name or ID>.',
          );
          return true;
        }
        const selected = this.sessionForControl(destination, session[1]);
        await this.tasksCard(selected, destination);
        return true;
      }
      const tasks = text.match(/^\/tasks(?:\s+([\s\S]+))?$/);
      if (tasks) {
        const selected = this.sessionForControl(destination, tasks[1]);
        await this.tasksCard(selected, destination);
        return true;
      }
      const actionCommand = text.match(/^\/(approve)(?:\s+([\s\S]+))?$/);
      if (actionCommand) {
        const selected = this.sessionForControl(destination);
        const taskId = actionCommand[2]
          ? this.findTask(selected.id, actionCommand[2]).id
          : this.store.setting<string>(this.selectedTaskKey(destination, selected.id));
        if (!taskId) throw new Error(this.t('Open a task with /task before confirming an action.'));
        const actions = {
          approve: 'approve-plan',
        } as const;
        await this.taskConfirmation(
          this.daddy.task(selected.id, taskId),
          destination,
          actions[actionCommand[1] as keyof typeof actions],
        );
        return true;
      }
      const waiver = text.match(/^\/waive(?:\s+([\s\S]+))?$/);
      if (waiver) {
        const selected = this.sessionForControl(destination);
        const explicit = waiver[1]?.match(/^(\S+)\s+--\s+([\s\S]+)$/);
        const taskId = explicit
          ? this.findTask(selected.id, explicit[1]).id
          : this.store.setting<string>(this.selectedTaskKey(destination, selected.id));
        if (!taskId) throw new Error(this.t('Open a task with /task before confirming an action.'));
        await this.taskConfirmation(
          this.daddy.task(selected.id, taskId),
          destination,
          'waive-checks',
          explicit?.[2] ?? waiver[1],
        );
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
        const board = this.daddy.rename(groupId, rename[1]);
        await this.api.send(
          destination,
          this.t('Session renamed: {title}', {
            title: this.groupText(destination, board.group.title),
          }),
        );
        return true;
      }
      const pool = text.match(/^\/pool(?:\s+([1-8]))?$/);
      const repo = text.match(/^\/repo(?:\s+(.+))?$/);
      if (repo) {
        const contextual = privateChat
          ? this.store.setting<{ id: string; choice: RepoChoice }>(this.repoInputKey(destination))
          : undefined;
        if (contextual) {
          if (contextual.choice.expiresAt <= now()) {
            this.store.setSetting(this.repoInputKey(destination), null);
            throw new Error(this.t('This selection expired. Choose the repository again.'));
          } else {
            await this.repository({
              ...contextual.choice,
              input:
                repo[1] === undefined
                  ? contextual.choice.input
                  : repo[1] === 'default'
                    ? undefined
                    : this.repositoryInput(repo[1], contextual.choice.input),
            });
            return true;
          }
        }
        const pending = this.store.setting<NewSessionDraft>(this.creationKey(destination));
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
          input: repo[1] && repo[1] !== 'default' ? this.repositoryInput(repo[1]) : undefined,
          creationExpiresAt: creating ? pending!.expiresAt : undefined,
          expiresAt: new Date(Date.now() + 10 * 60000).toISOString(),
        });
        return true;
      }
      if (text === '/models' && groupId) {
        await this.models(groupId, destination);
        return true;
      }
      const instructionTransfer = text.match(/^\/instructions\s+(import|export)$/);
      if (instructionTransfer) {
        if (!groupId) throw new Error(this.t('Start a daddy session first.'));
        const group = this.authorize(destination, groupId);
        if (instructionTransfer[1] === 'import')
          await this.requestDocument(destination, group, 'instructions');
        else await this.exportInstructions(group, destination);
        return true;
      }
      const skillFile = text.match(/^\/skill\s+(daddy|worker)(?:\s+file)?$/);
      if (skillFile) {
        if (!groupId) throw new Error(this.t('Start a daddy session first.'));
        await this.requestDocument(
          destination,
          this.authorize(destination, groupId),
          'skill',
          skillFile[1] as 'daddy' | 'worker',
        );
        return true;
      }
      const localSkill = text.match(/^\/skill\s+(daddy|worker)\s+local\s+([\s\S]+)$/);
      if (localSkill) {
        if (!groupId) throw new Error(this.t('Start a daddy session first.'));
        const group = this.authorize(destination, groupId);
        if (!privateChat)
          await this.privateSessionStep(
            destination,
            group,
            this.t('Local instruction paths are accepted only in the paired private chat.'),
          );
        else {
          const role = localSkill[1] as 'daddy' | 'worker',
            skill = await new InstructionSources().import({
              kind: 'local',
              path: localSkill[2].trim(),
            }),
            added = await this.addSkill(group, role, skill);
          await this.skillConfirmation(group, role, skill, added, destination);
        }
        return true;
      }
      const textSkill = text.match(
        /^\/skill\s+(daddy|worker)\s+text\s+([^:\r\n]{1,100})\s+::\s+([\s\S]+)$/,
      );
      if (textSkill) {
        if (!groupId) throw new Error(this.t('Start a daddy session first.'));
        const group = this.authorize(destination, groupId);
        if (!privateChat)
          await this.privateSessionStep(
            destination,
            group,
            this.t('Pasted instruction text is accepted only in the paired private chat.'),
          );
        else {
          const role = textSkill[1] as 'daddy' | 'worker',
            skill = await new InstructionSources().import({
              kind: 'text',
              name: textSkill[2].trim(),
              text: textSkill[3],
            }),
            added = await this.addSkill(group, role, skill);
          await this.skillConfirmation(group, role, skill, added, destination);
        }
        return true;
      }
      if (/^\/(instructions|skill)(?:\s|$)/.test(text)) {
        if (!privateChat && text === '/instructions') {
          if (!groupId) throw new Error(this.t('Start a daddy session first.'));
          await this.privateSessionStep(
            destination,
            this.authorize(destination, groupId),
            this.t('Instruction text and skills are managed only in the paired private chat.'),
          );
          return true;
        }
        if (!groupId) throw new Error(this.t('Start a daddy session first.'));
        const group = this.authorize(destination, groupId);
        const skillUrl = text.match(/^\/skill\s+(?:daddy|worker)\s+([\s\S]+)$/)?.[1];
        const skill = skillUrl
          ? await new InstructionSources().import({ kind: 'github', url: skillUrl.trim() })
          : undefined;
        if (text.trim() !== '/instructions')
          await this.daddy.updateInstructions(
            group.id,
            { generation: group.generation, instructionsHash: this.instructionsHash(group) },
            (current) => updateInstructionsFromCommand(text, current, skill)!,
          );
        await this.api.send(
          destination,
          privateChat
            ? new TelegramText().add(
                instructionLines(this.daddy.group(groupId).instructions, this.locale()).join('\n'),
              )
            : this.t('Session instructions updated. Full text is available in the private chat.'),
        );
        return true;
      }
      if (text === '/presets') {
        await this.presetsCard(
          groupId ? this.authorize(destination, groupId) : undefined,
          destination,
        );
        return true;
      }
      const presetMetadata = text.match(
        /^\/preset\s+(rename|describe)\s+([^:\r\n]+?)\s+::\s*([\s\S]+)$/,
      );
      if (presetMetadata) {
        if (!privateChat) {
          await this.privateStep(
            destination,
            this.t('Preset library changes are available only in the private chat.'),
          );
          return true;
        }
        const library = new InstructionPresets(this.store),
          preset = library.get(findPreset(library.list(), presetMetadata[2]).id),
          renamed = presetMetadata[1] === 'rename';
        const saved = library.save(
          {
            name: renamed ? presetMetadata[3].trim() : preset.name,
            description: renamed ? preset.description : presetMetadata[3].trim(),
            instructions: preset.instructions,
            expectedRevision: preset.revision,
          },
          preset.id,
        );
        await this.api.send(
          destination,
          this.t(renamed ? 'Preset renamed.' : 'Preset description updated.') +
            `\n\n${saved.name} · ${this.t('version')} ${saved.revision}`,
        );
        return true;
      }
      const presetCommand = text.match(
        /^\/preset\s+(save|update|delete|parts|enable|disable|remove)\s+([\s\S]+)$/,
      );
      if (presetCommand) {
        const action = presetCommand[1],
          name = presetCommand[2].trim();
        if (action === 'delete') await this.confirmPresetDelete(name, destination);
        else {
          if (!groupId) throw new Error(this.t('Start a daddy session first.'));
          const group = this.authorize(destination, groupId);
          if (action === 'save' || action === 'update')
            await this.savePreset(group, name, action === 'update', destination);
          else {
            if (action === 'parts') {
              const applied = this.appliedPreset(group, name);
              if (!applied) throw new Error(this.t('Enable this preset in the session first.'));
              await this.presetPartsCard(group, applied.preset.id, destination);
            } else if (action === 'remove') {
              const applied = this.appliedPreset(group, name);
              if (!applied) throw new Error(this.t('Enable this preset in the session first.'));
              await this.daddy.updateInstructions(
                group.id,
                { generation: group.generation, instructionsHash: this.instructionsHash(group) },
                (current) => ({
                  ...(current ?? { daddy: {}, worker: {} }),
                  presets: (current?.presets ?? []).filter(
                    (item) => item.preset.id !== applied.preset.id,
                  ),
                }),
              );
              await this.api.send(destination, this.t('Preset removed from this session.'));
            } else {
              const applied = this.appliedPreset(group, name),
                library = new InstructionPresets(this.store);
              if (!applied && action === 'disable')
                throw new Error(this.t('Enable this preset in the session first.'));
              const preset = applied?.preset ?? library.get(findPreset(library.list(), name).id);
              await this.daddy.updateInstructions(
                group.id,
                { generation: group.generation, instructionsHash: this.instructionsHash(group) },
                (current) => selectPreset(current, preset, action === 'enable'),
              );
              await this.api.send(
                destination,
                this.t(
                  action === 'enable' ? 'Preset enabled for this session' : 'Preset disabled.',
                ),
              );
            }
          }
        }
        return true;
      }
      const presetName = text.match(/^\/preset\s+(.+)$/)?.[1];
      if (presetName) {
        if (!groupId) throw new Error(this.t('Start a daddy session first.'));
        const group = this.authorize(destination, groupId);
        const library = new InstructionPresets(this.store),
          preset = library.get(findPreset(library.list(), presetName).id);
        await this.daddy.updateInstructions(
          groupId,
          { generation: group.generation, instructionsHash: this.instructionsHash(group) },
          (current) => selectPreset(current, preset),
        );
        const detail = privateChat
          ? '\n\n' +
            instructionLines(this.daddy.group(groupId).instructions, this.locale()).join('\n')
          : '';
        await this.api.send(
          destination,
          new TelegramText()
            .add(this.t('Preset enabled for this session'), 'bold')
            .add(`\n\n${this.groupText(destination, preset.name)}${detail}`),
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
      const pending = this.store.setting<NewSessionDraft>(this.creationKey(destination));
      if ((!conversationGroupId && privateChat) || (pending && pending.expiresAt > now())) {
        this.store.setSetting(this.creationKey(destination), {
          id: randomBytes(12).toString('base64url'),
          text,
          expiresAt: new Date(Date.now() + 10 * 60000).toISOString(),
        });
        await this.api.send(
          destination,
          this.workspacePickerCard(destination, this.daddy.workspaces.list()),
        );
        return true;
      }
      if (!conversationGroupId) {
        await this.api.send(
          destination,
          this.t('Open a session topic, or send /new here to create one.'),
        );
        return true;
      }
      this.authorize(destination, conversationGroupId);
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
            this.store.setSetting(this.repoKey(destination, conversationGroupId), null);
        });
        return true;
      }
      const receipt = `telegram:${chat.id}:${message?.message_id ?? update.update_id}`;
      if (this.store.setting(`daddy.receipt:${receipt}`)) return true;
      const nextKey = this.repoKey(destination, conversationGroupId),
        next = this.store.setting<{ workspace: Workspace; expiresAt: string }>(nextKey);
      if (next && next.expiresAt <= now()) {
        this.store.setSetting(nextKey, null);
        throw new Error(this.t('This selection expired. Choose the repository again.'));
      }
      this.daddy.chat(conversationGroupId, text, receipt, next?.workspace, {
        channel: 'telegram',
        messageId: message?.message_id,
        replyTo,
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
    const destination = parent
      ? { chatId: parent.chatId, threadId: parent.threadId }
      : { chatId: pair.chatId };
    if (this.pair()?.userId !== pair.userId || (parent && this.room()?.chatId !== parent.chatId))
      return;
    this.store.db
      .prepare('INSERT OR IGNORE INTO notifications VALUES(?,?,?)')
      .run(id, 'pending', now());
    const result = await this.api.send(
      destination,
      {
        ...new TelegramText().add(
          this.t('New session created: {title}', {
            title: this.groupText(destination, group.title),
          }),
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
            : { chatId: pair.chatId };
          if (group.deletedAt) {
            if (event.type !== 'daddy.deleted') return;
            if (this.store.setting('telegram.currentDaddy') === group.id)
              this.store.setSetting('telegram.currentDaddy', null);
            const text = new TelegramText().add(
              this.t('Session deleted') + ': ' + this.groupText(destination, group.title),
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
          const worker = task.inputRequest?.role === 'author';
          text
            .add(worker ? this.t('Worker') : 'daddy', 'bold')
            .add(' · ')
            .add(taskReference(task), 'code')
            .add('  ' + this.groupText(destination, task.title) + '\n\n')
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
