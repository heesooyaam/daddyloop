import { createHash, randomBytes, randomInt } from 'node:crypto';
import { commandHelp, normalizeTelegramCommand } from './telegram-commands.js';
import { githubWait } from '../providers/github-quota.js';
import type { Daddy } from '../core/daddy.js';
import {
  sameAgentProfile,
  AppError,
  canSubmitTask,
  now,
  type Event,
  type HumanTaskAction,
  type ReviewGroup,
  type Task,
} from '../core/types.js';
import { redact } from '../core/security.js';
import type { TelegramApi, Update } from './telegram.js';
import { TelegramText, safeLink, type TelegramButton } from './telegram-text.js';
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
import { draftInspectionRequired, taskReference } from '../core/task-activity.js';
import { workerSlots } from '../core/worker-pool.js';
import { profileText, taskActivity } from '../core/task-activity.js';
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
type RepoChoice = {
  destination: Destination;
  controlDestination?: Destination;
  ownerId: number;
  workspace: Workspace;
  groupId?: string;
  input?: RepositorySelection;
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
  kind: 'delete' | 'part' | 'select';
  ownerId: number;
  destination: Destination;
  presetId: string;
  revision: number;
  groupId?: string;
  part?: string;
  enabled?: boolean;
  expiresAt: string;
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
          title: group.title,
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
      await this.addSkill(current, pending.role!, skill, pending, destination);
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
    await this.daddy.updateInstructions(
      group.id,
      {
        generation: pending?.generation ?? group.generation,
        instructionsHash: pending?.instructionsHash ?? this.instructionsHash(group),
      },
      (current) => {
        const instructions = structuredClone(current ?? { daddy: {}, worker: {} });
        const skills = instructions[role].skills ?? [];
        if (!skills.some((item) => item.checksum === skill.checksum))
          instructions[role].skills = [...skills, skill];
        return instructions;
      },
      pending && destination ? () => this.requirePendingDocument(destination, pending) : undefined,
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
    const parts = presetParts(applied.preset);
    await this.api.send(destination, {
      ...new TelegramText()
        .add('🧩 ' + applied.preset.name, 'bold')
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
                : `${part.role}: ${part.name}`),
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
      text.add('\n\n• ' + preset.name);
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
                text: preset.name.slice(0, 60),
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
  private async confirmPresetDelete(name: string, destination: Destination) {
    if (destination.chatId !== this.pair()?.chatId)
      return this.privateStep(
        destination,
        this.t('Preset library changes are available only in the private chat.'),
      );
    const library = new InstructionPresets(this.store),
      preset = library.get(findPreset(library.list(), name).id);
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
            callback_data: this.presetControl({
              kind: 'delete',
              destination,
              presetId: preset.id,
              revision: preset.revision,
            }),
          },
        ],
        [{ text: this.t('Cancel'), callback_data: 'dad:settings' }],
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
        publish: 'Publish review',
        submit: 'Submit for review',
      },
      ru: {
        'approve-plan': 'Принять план',
        'waive-checks': 'Разрешить пропуск CI',
        'verify-merge': 'Проверить merge',
        publish: 'Опубликовать ревью',
        submit: 'Отправить на ревью',
      },
    };
    return labels[this.locale()][action];
  }
  private availableTaskActions(task: Task): HumanTaskAction[] {
    return [
      ...(canSubmitTask(task) && task.policy.autoPush === false ? (['submit'] as const) : []),
      ...(task.state === 'awaiting_publication' && task.policy.publication === 'human'
        ? (['publish'] as const)
        : []),
      ...(task.state === 'awaiting_plan_approval' ? (['approve-plan'] as const) : []),
      ...(task.state === 'awaiting_checks' ? (['waive-checks'] as const) : []),
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
  private taskActionCompleted(task: Task, control: TaskControl) {
    if (control.action === 'approve-plan') return !!task.approvedAt;
    if (control.action === 'waive-checks') return !!task.checksWaivedAt;
    if (control.action === 'publish') return task.snapshot?.status === 'published';
    if (control.action === 'submit')
      return (
        task.ref.kind !== 'ticket' &&
        task.revision?.head === (control.expectedPendingHead ?? control.expectedHead)
      );
    return false;
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
    this.authorizeControl(destination, group.id);
    const tasks = this.store.tasks(group.id),
      pageSize = 20,
      pages = Math.max(1, Math.ceil(tasks.length / pageSize));
    page = Math.max(0, Math.min(page, pages - 1));
    const visible = tasks.slice(page * pageSize, (page + 1) * pageSize);
    const text = new TelegramText()
      .add('📋 ' + (this.locale() === 'ru' ? 'Задачи' : 'Tasks'), 'bold')
      .add('\n' + group.title);
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
            text: `${task.state === 'complete' ? '✅' : '•'} ${task.title}`.slice(0, 60),
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
  private async taskCard(task: Task, destination: Destination) {
    this.authorizeControl(destination, task.groupId!);
    this.store.setSetting(this.selectedTaskKey(destination, task.groupId!), task.id);
    const version = this.taskVersion(task);
    const text = new TelegramText()
      .add(task.title, 'bold')
      .add('\n\n' + this.t(task.state))
      .add('\n' + this.t(task.reason))
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
    const confirmedHead =
      action === 'submit' ? (version.pendingHead ?? version.head) : version.head;
    const text = new TelegramText()
      .add(this.taskActionLabel(action), 'bold')
      .add('\n\n' + task.title)
      .add('\n' + this.daddy.group(task.groupId!).title)
      .add(
        '\n\n' + (this.locale() === 'ru' ? 'Подтверждается версия' : 'Confirming version') + ':\n',
      )
      .add(confirmedHead, 'code')
      .add(
        '\n' + (this.locale() === 'ru' ? 'Поколение' : 'Generation') + ': ' + version.generation,
      );
    if (reason) text.add('\n\n' + (this.locale() === 'ru' ? 'Причина' : 'Reason') + ': ' + reason);
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
    if (control.kind === 'task') {
      if (control.cancels) this.cancelTaskControl(id, control);
      await this.taskCard(task, destination);
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
      await this.taskCard(task, destination);
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
      await this.taskCard(task, destination);
      return true;
    }
    if (control.kind === 'prepare') {
      await this.taskConfirmation(task, destination, control.action!, control.reason);
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
          ...(control.expectedPendingHead ? { pendingHead: control.expectedPendingHead } : {}),
        },
        control.reason,
      );
    } catch (error) {
      task = this.daddy.task(control.groupId, control.taskId);
      if (!this.taskActionCompleted(task, control)) throw error;
    }
    if (!this.taskActionCompleted(task, control)) {
      await this.taskCard(task, destination);
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
    await this.taskCard(task, destination);
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
            ? '/sessions и /session — выбрать сессию\n/new — новая сессия\n/tasks и /task — задачи и ручные действия\n/status, /models, /pool, /repo — управление сессией\n/workspaces и /workspace — репозитории\n/instructions, /skill, /presets, /preset — инструкции и файлы\n/limits, /notifications, /updates — служебные действия\n/group — подключить группу с темами'
            : '/sessions and /session — choose a session\n/new — new session\n/tasks and /task — tasks and manual actions\n/status, /models, /pool, /repo — session controls\n/workspaces and /workspace — repositories\n/instructions, /skill, /presets, /preset — instructions and files\n/limits, /notifications, /updates — service controls\n/group — connect a forum group'),
      );
    else if (topic)
      text.add(
        '\n\n' +
          (this.locale() === 'ru'
            ? 'Эта тема уже привязана к одной сессии. /tasks открывает её задачи; /submit, /approve, /publish и /waive сначала показывают точную версию и только потом дают кнопку подтверждения.'
            : 'This topic is bound to one session. /tasks opens its tasks; /submit, /approve, /publish and /waive show the exact version before offering confirmation.'),
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
    this.store.setSetting(this.selectedTaskKey(destination, groupId), task.id);
    const card = activityTaskCard(this.locale(), activity!, slot, merge);
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
          }),
        },
      ]),
      ...(card.buttons ?? []),
    ];
    await this.api.send(destination, card);
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
      this.selectPrivateSession(destination, group.id);
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
  private repoInputKey(destination: Destination) {
    return `telegram.repoInput:${this.pair()!.userId}:${destination.chatId}`;
  }
  private registrationKey(destination: Destination) {
    return `telegram.addWorkspace:${this.pair()!.userId}:${destination.chatId}:${destination.threadId ?? 0}`;
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
    const pair = this.pair()!;
    const privateChoice = {
      ...choice,
      controlDestination: { chatId: pair.chatId },
    };
    const id = randomBytes(12).toString('base64url');
    this.store.setSetting(`telegram.repo:${id}`, privateChoice);
    await this.api.send(choice.destination, {
      ...new TelegramText()
        .add('📁 ' + this.t('Repository for this request'), 'bold')
        .add('\n\n' + choice.workspace.name)
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
    if (choice.controlDestination && choice.destination.chatId !== controlDestination.chatId)
      this.store.setSetting(this.repoInputKey(controlDestination), choice);
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
          .add('\n\n' + choice.workspace.name);
        if (destination.chatId === this.pair()?.chatId)
          response.add(
            '\n' + selected.repoPath + (selected.scope ? '/' + selected.scope : ''),
            'code',
          );
        response.add(
          '\n\n' + this.t('Send the task now. The following message will use the defaults again.'),
        );
        await this.api.send(destination, response);
      } else await this.newSession(choice.workspace.id, choice.destination, selected);
      if (choice.controlDestination)
        this.store.setSetting(this.repoInputKey(choice.controlDestination), null);
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
        [{ text: '＋ ' + this.t('Add repository'), callback_data: 'dad:add-workspace' }],
        [{ text: this.t('Find on server'), callback_data: 'dad:discover' }],
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
            'Edit one saved value with /workspace <ID> name|path|scope|base|provider|copies <value>. Use root or default to clear scope or base.',
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
  ) {
    if (destination.chatId !== this.pair()?.chatId)
      return this.privateStep(
        destination,
        this.t('Repository paths and defaults are available in the private bot chat.'),
      );
    const value = raw.trim();
    if (!value) throw new Error(this.t('Send a value to save.'));
    if (field === 'copies' && !['session', 'pool'].includes(value))
      throw new Error(this.t('Choose session or pool copy mode.'));
    const saved = await this.daddy.workspaces.register(
      {
        name: field === 'name' ? value : workspace.name,
        path: field === 'path' ? value : workspace.repoPath,
        scope: field === 'scope' ? (value === 'root' ? '' : value) : workspace.scope,
        base: field === 'base' ? (value === 'default' ? undefined : value) : workspace.base,
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
    const workspaceDetails = data.match(/^dad:workspace:([a-f0-9-]{36})$/);
    if (workspaceDetails) {
      await this.workspaceCard(this.daddy.workspaces.get(workspaceDetails[1]), destination);
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
    if (data === 'dad:workspaces') {
      await this.workspacesCard(destination);
      return true;
    }
    if (data === 'dad:new') {
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
      if (message?.document) return await this.handleDocument(update, destination, privateChat);
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
      const text = message?.text
        ? normalizeTelegramCommand(message.text, this.username)
        : undefined;
      if (!text) return false;
      if (text === '/cancel' && this.store.setting(this.documentKey(destination))) {
        this.store.setSetting(this.documentKey(destination), null);
        await this.api.send(destination, this.t('File import cancelled.'));
        return true;
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
      const workspaceEdit = text.match(
        /^\/workspace\s+(\S+)\s+(name|path|scope|base|provider|copies)\s+([\s\S]+)$/,
      );
      const workspaceCommand = text.match(/^\/workspace(?:\s+([\s\S]+))?$/);
      if (workspaceEdit || workspaceCommand) {
        if (!workspaceEdit && !workspaceCommand?.[1]) {
          await this.workspacesCard(destination);
          return true;
        }
        const workspace = this.findWorkspace(
          workspaceEdit ? workspaceEdit[1] : workspaceCommand![1],
        );
        if (!workspaceEdit) await this.workspaceCard(workspace, destination);
        else
          await this.editWorkspace(
            workspace,
            workspaceEdit[2] as 'name' | 'path' | 'scope' | 'base' | 'provider' | 'copies',
            workspaceEdit[3],
            destination,
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
        ? this.store.setting<string>('telegram.currentDaddy')
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
      const actionCommand = text.match(/^\/(submit|approve|publish)(?:\s+([\s\S]+))?$/);
      if (actionCommand) {
        const selected = this.sessionForControl(destination);
        const taskId = actionCommand[2]
          ? this.findTask(selected.id, actionCommand[2]).id
          : this.store.setting<string>(this.selectedTaskKey(destination, selected.id));
        if (!taskId) throw new Error(this.t('Open a task with /task before confirming an action.'));
        const actions = {
          submit: 'submit',
          approve: 'approve-plan',
          publish: 'publish',
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
        const contextual = privateChat
          ? this.store.setting<RepoChoice>(this.repoInputKey(destination))
          : undefined;
        if (contextual) {
          if (contextual.expiresAt <= now())
            this.store.setSetting(this.repoInputKey(destination), null);
          else {
            await this.repository({
              ...contextual,
              input:
                repo[1] === undefined
                  ? contextual.input
                  : repo[1] === 'default'
                    ? undefined
                    : { path: repo[1] },
            });
            return true;
          }
        }
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
        else
          await this.addSkill(
            group,
            localSkill[1] as 'daddy' | 'worker',
            await new InstructionSources().import({ kind: 'local', path: localSkill[2].trim() }),
          );
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
        else
          await this.addSkill(
            group,
            textSkill[1] as 'daddy' | 'worker',
            await new InstructionSources().import({
              kind: 'text',
              name: textSkill[2].trim(),
              text: textSkill[3],
            }),
          );
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
        /^\/preset\s+(save|update|delete|parts|enable|disable)\s+([\s\S]+)$/,
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
              const applied = findPreset(
                (group.instructions?.presets ?? []).map((item) => ({
                  id: item.preset.id,
                  name: item.preset.name,
                })),
                name,
              );
              await this.presetPartsCard(group, applied.id, destination);
            } else {
              const library = new InstructionPresets(this.store),
                preset = library.get(findPreset(library.list(), name).id);
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
            .add(`\n\n${preset.name}${detail}`),
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
      if ((!conversationGroupId && privateChat) || (pending && pending.expiresAt > now())) {
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
      if (!conversationGroupId) {
        await this.api.send(
          destination,
          this.t('Open a session topic, or send /new here to create one.'),
        );
        return true;
      }
      this.authorize(destination, conversationGroupId);
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
          key: replaceTurn ? `turn:${message!.runId}` : id,
          replace: replaceTurn,
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
    await this.progress.stop();
    await this.voice?.stop();
    await this.pending;
    await Promise.allSettled([...this.topics.values()]);
  }
}
