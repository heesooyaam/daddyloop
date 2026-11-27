import { AppError } from '../core/types.js';
import { reminderOpen, type OwnerQuestion } from './telegram-reminders.js';
import { createHash, randomUUID } from 'node:crypto';
import type { Store } from '../core/store.js';
import { redact } from '../core/security.js';
import { splitTelegramText, type TelegramCard, type FormattedText } from './telegram-text.js';

export type TelegramDestination = { chatId: number; threadId?: number };
export interface DeliveryOptions {
  question?: OwnerQuestion;
  requestedMenu?: boolean;
  menuTopicGroupId?: string;
  reminder?: OwnerQuestion;
  groupId?: string;
  operation?: 'renameTopic' | 'reaction' | 'pin';
  reactionMessageId?: number;
  pinMessageId?: number;
  pin?: boolean;
  key?: string;
  replace?: boolean;
  order?: string;
  final?: boolean;
  notificationId?: string;
  deletePrevious?: { chatId: number; messageId: number };
}
type Delivery = {
  id: string;
  bot: string;
  ownerId?: number;
  destination: TelegramDestination;
  content: TelegramCard | FormattedText;
  options: DeliveryOptions;
  revision: number;
  createdAt: number;
  firstAttemptAt?: number;
  sentAt?: number;
  status: 'queued' | 'sending' | 'sent' | 'cancelled';
  attempts: number;
  nextAttemptAt: number;
  error?: string;
  messages: { id: number; fingerprint: string }[];
};
type Transport = {
  call<T>(method: string, body?: unknown, signal?: AbortSignal): Promise<T>;
  onCleanupError?: (error: unknown) => void;
};
type Lane = 'ordered' | 'menu';
const laneFor = (options: DeliveryOptions): Lane => (options.requestedMenu ? 'menu' : 'ordered');
const waitForTelegram = Symbol('wait for the shared Telegram retry deadline');
const prefix = 'telegram.delivery:';
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const isIndependent = ({ options }: Delivery) =>
  options.operation === 'reaction' || options.operation === 'pin';
export function deliveryStatus(result: unknown) {
  return (result as { status?: string })?.status ?? 'sent';
}

/** Durable, ordered delivery. Text for a running turn is replaced, not appended to a backlog. */
export class TelegramDelivery {
  private pending = new Map<string, Delivery>();
  private running = new Map<Lane, Promise<void>>();
  private wake = new Set<Lane>();
  private controllers = new Set<AbortController>();
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private rateLimitUntil = 0;
  constructor(
    private store: Store,
    private api: Transport,
    private bot: string,
    private clock = Date.now,
  ) {
    for (const row of store.db
      .prepare("SELECT key,value FROM settings WHERE key LIKE 'telegram.delivery:%'")
      .all()) {
      const value = JSON.parse(String(row.value)) as Delivery;
      if (!value || value.bot !== bot || !['queued', 'sending'].includes(value.status)) continue;
      value.status = 'queued';
      this.pending.set(String(row.key), value);
    }
    this.rateLimitUntil = store.setting<number>(`telegram.deliveryLimit:${bot}`) ?? 0;
  }
  start() {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => {
      void this.flush();
    }, 1000);
    this.timer.unref();
    void this.flush();
  }
  private save(key: string, value: Delivery) {
    this.store.setSetting(key, value);
    if (['queued', 'sending'].includes(value.status)) this.pending.set(key, value);
    else this.pending.delete(key);
  }
  private valid(value: Delivery) {
    if (value.options.reminder && !reminderOpen(this.store, value.options.reminder)) return false;
    // Older queued first mentions have only their notification key. Check it again on delivery or replay.
    const taskQuestion = value.options.key?.match(
      /^telegram:question:(\d+):([^:]+):(.+?)(?::reminder:\d+)?$/,
    );
    if (taskQuestion && !value.options.reminder) {
      const [, ownerId, taskId, request] = taskQuestion;
      const groupId =
        value.options.groupId ?? this.store.tasks().find((task) => task.id === taskId)?.groupId;
      if (
        Number(ownerId) !== value.ownerId ||
        !groupId ||
        !reminderOpen(this.store, { groupId, taskId, request })
      )
        return false;
    }
    const pair = this.store.setting<{ chatId: number; userId: number }>('telegram.pairing');
    const room = this.store.setting<{ chatId: number; ownerId: number }>('telegram.group');
    if (value.ownerId !== pair?.userId) return false;
    if (
      value.options.menuTopicGroupId &&
      !this.store.db
        .prepare(
          `SELECT 1 FROM telegram_topics
      WHERE group_id=? AND json_extract(data,'$.ownerId')=? AND json_extract(data,'$.chatId')=?
        AND json_extract(data,'$.threadId')=? LIMIT 1`,
        )
        .get(
          value.options.menuTopicGroupId,
          value.ownerId!,
          value.destination.chatId,
          value.destination.threadId ?? null,
        )
    )
      return false;
    return (
      !pair ||
      value.destination.chatId === pair.chatId ||
      (value.destination.chatId === room?.chatId && room.ownerId === pair.userId)
    );
  }
  replyReceipt(chatId: number, messageId: number, ownerId: number) {
    // Telegram message IDs are scoped to a chat. Only trust our own delivery receipt.
    return this.store.db
      .prepare(
        `SELECT json_extract(value,'$.options.groupId') AS groupId,
      json_extract(value,'$.options.key') AS deliveryKey, json_extract(value,'$.options.notificationId') AS notificationId, json_extract(value,'$.options.question') AS question, json_extract(value,'$.destination.threadId') AS threadId FROM settings
      WHERE key GLOB 'telegram.delivery:*' AND json_extract(value,'$.bot')=? AND json_extract(value,'$.ownerId')=?
        AND json_extract(value,'$.destination.chatId')=?
        AND EXISTS(SELECT 1 FROM json_each(settings.value,'$.messages') m WHERE json_extract(m.value,'$.id')=?) LIMIT 1`,
      )
      .get(this.bot, ownerId, chatId, messageId);
  }
  replySession(chatId: number, messageId: number, ownerId: number): string | undefined {
    const row = this.replyReceipt(chatId, messageId, ownerId);
    if (typeof row?.groupId === 'string') return row.groupId;
    // Receipts from older installs identify the task or turn in the delivery key.
    const key = String(row?.deliveryKey ?? '');
    const task = key.startsWith('telegram:question:' + ownerId + ':')
      ? key.split(':')[3]
      : undefined;
    if (task) return this.store.tasks().find((t) => t.id === task)?.groupId;
    if (key.startsWith('turn:')) {
      const job = this.store.db
        .prepare('SELECT group_id FROM daddy_jobs WHERE id=?')
        .get(key.slice(5));
      if (typeof job?.group_id === 'string') return job.group_id;
    }
  }
  private createDelivery(
    destination: TelegramDestination,
    content: Delivery['content'],
    options: DeliveryOptions,
  ): Delivery {
    return {
      id: randomUUID(),
      bot: this.bot,
      ownerId: this.store.setting<{ userId: number }>('telegram.pairing')?.userId,
      destination,
      content: structuredClone(content),
      options,
      revision: 1,
      createdAt: this.clock(),
      status: 'queued',
      attempts: 0,
      nextAttemptAt: this.clock(),
      messages: [],
    };
  }
  enqueueReaction(destination: TelegramDestination, messageId: number) {
    const key = prefix + digest([this.bot, 'reaction', destination.chatId, messageId]);
    if (this.pending.has(key) || this.store.setting<Delivery>(key)) return;
    this.save(
      key,
      this.createDelivery(
        destination,
        { text: '', entities: [] },
        {
          operation: 'reaction',
          reactionMessageId: messageId,
        },
      ),
    );
  }
  private enqueuePin(destination: TelegramDestination, messageId: number) {
    const key = prefix + digest([this.bot, 'pin', destination.chatId, messageId]);
    if (this.pending.has(key) || this.store.setting<Delivery>(key)) return;
    this.save(
      key,
      this.createDelivery(
        destination,
        { text: '', entities: [] },
        { operation: 'pin', pinMessageId: messageId },
      ),
    );
  }
  // Older task and job action IDs carry the chat and message but no bot or owner.
  // Use a receipt for this request first. Without one, require a single known identity.
  legacyTaskOwner(requestId: string): 'current' | 'other' | 'unknown' | 'conflict' {
    const owner = this.store.setting<{ userId: number }>('telegram.pairing')?.userId;
    if (owner === undefined) return 'unknown';
    const botId = this.store.setting<number>('telegram.botId');
    const identities = (key?: string) =>
      this.store.db
        .prepare(
          `SELECT DISTINCT
      json_extract(value,'$.bot') AS bot, json_extract(value,'$.ownerId') AS owner
      FROM settings WHERE key GLOB 'telegram.delivery:*' AND json_extract(value,'$.ownerId') IS NOT NULL
      AND (? IS NULL OR json_extract(value,'$.options.key')=?)`,
        )
        .all(key ?? null, key ?? null);
    const sameBot = (row: { bot?: unknown }) =>
      row.bot === this.bot ||
      (botId !== undefined && typeof row.bot === 'string' && row.bot.endsWith(':' + botId));
    const ours = (row: { bot?: unknown; owner?: unknown }) => sameBot(row) && row.owner === owner;
    const specific = identities(requestId);
    if (specific.length) {
      if (specific.every(ours)) return 'current';
      return specific.some(sameBot) ? 'conflict' : 'other';
    }
    const original = this.store.setting<{ bot: number; owner: number }>(
      'telegram.legacyQueueOwner',
    );
    if (original) {
      if (original.bot !== botId) return 'other';
      return original.owner === owner ? 'current' : 'conflict';
    }
    const known = identities();
    return known.length && known.every(ours) ? 'current' : 'unknown';
  }
  queuedTaskReceipt(destination: TelegramDestination, requestId: string) {
    const ownerId = this.store.setting<{ userId: number }>('telegram.pairing')?.userId;
    if (ownerId === undefined) return;
    const botId = this.store.setting<number>('telegram.botId');
    const rows = this.store.db
      .prepare(
        `SELECT DISTINCT substr(button.value, 10) AS taskId
       FROM settings, json_tree(settings.value, '$.content.buttons') AS button
       WHERE settings.key GLOB 'telegram.delivery:*'
         AND (json_extract(settings.value, '$.bot') = ?
           OR json_extract(settings.value, '$.bot') LIKE '%:' || ?)
         AND json_extract(settings.value, '$.ownerId') = ?
         AND json_extract(settings.value, '$.destination.chatId') = ?
         AND (COALESCE(json_extract(settings.value, '$.destination.threadId'), 0) = ?
           OR EXISTS (SELECT 1 FROM tasks JOIN telegram_topics
             ON telegram_topics.group_id=json_extract(tasks.data,'$.groupId')
             WHERE tasks.id=substr(button.value,10)
               AND json_extract(telegram_topics.data,'$.ownerId')=?
               AND json_extract(telegram_topics.data,'$.chatId')=json_extract(settings.value,'$.destination.chatId')
               AND json_extract(telegram_topics.data,'$.threadId')=json_extract(settings.value,'$.destination.threadId')))
         AND json_extract(settings.value, '$.options.key') = ?
         AND button.key = 'callback_data' AND button.value GLOB 'dad:task:*'
       LIMIT 2`,
      )
      .all(
        this.bot,
        botId ?? null,
        ownerId,
        destination.chatId,
        destination.threadId ?? 0,
        ownerId,
        requestId,
      );
    if (rows.length > 1)
      throw new AppError(
        'ambiguous_queue_result',
        'Telegram receipts identify multiple tasks for the same command.',
      );
    if (rows.length === 1) return String(rows[0]!.taskId);
  }

  async send(
    destination: TelegramDestination,
    content: TelegramCard | FormattedText,
    options: DeliveryOptions = {},
  ) {
    destination = {
      chatId: destination.chatId,
      ...(destination.threadId === undefined ? {} : { threadId: destination.threadId }),
    };
    const key = prefix + digest([this.bot, destination, options.key ?? randomUUID()]);
    let value = this.pending.get(key) ?? this.store.setting<Delivery>(key);
    if (value) {
      if (
        (value.options.final && !options.final) ||
        (options.order && value.options.order && options.order < value.options.order)
      )
        return { status: 'superseded', deliveryId: value.id };
      if (!options.replace)
        return { status: value.status === 'sent' ? 'sent' : 'queued', deliveryId: value.id };
      if (
        digest([value.content, value.options.final, value.options.pin]) ===
        digest([content, options.final, options.pin])
      )
        return { status: value.status === 'sent' ? 'sent' : 'queued', deliveryId: value.id };
      if (
        value.options.notificationId &&
        value.options.notificationId !== options.notificationId &&
        value.status !== 'sent'
      )
        this.store.db
          .prepare("UPDATE notifications SET status='superseded' WHERE id=?")
          .run(value.options.notificationId);
      value.content = structuredClone(content);
      value.options = {
        ...options,
        requestedMenu: value.options.requestedMenu,
        menuTopicGroupId: value.options.menuTopicGroupId,
        deletePrevious: value.options.deletePrevious ?? options.deletePrevious,
      };
      value.revision++;
      value.status = 'queued';
      value.nextAttemptAt = this.clock();
    } else value = this.createDelivery(destination, content, options);
    this.save(key, value);
    const lane = laneFor(value.options);
    // A new reply can wake earlier entries in its own stream without retrying unrelated agent output.
    for (const [otherKey, other] of this.pending)
      if (
        laneFor(other.options) === lane &&
        !isIndependent(other) &&
        digest(other.destination) === digest(destination) &&
        other.status === 'queued'
      ) {
        other.nextAttemptAt = this.clock();
        this.save(otherKey, other);
      }
    if (!this.stopped) {
      const active = this.running.get(lane);
      if (active) this.wake.add(lane);
      else {
        const sending = this.flushLane(lane, 1);
        // A menu request is acknowledged once its response is durable. Polling can accept the next update.
        if (lane === 'ordered') await sending;
      }
    }
    return {
      status: value.status === 'sent' ? 'sent' : 'queued',
      deliveryId: value.id,
      message_id: value.messages.at(-1)?.id,
    };
  }
  status() {
    const values = [...this.pending.values()];
    return {
      pending: values.length,
      nextAttemptAt: values.length
        ? new Date(
            Math.max(this.rateLimitUntil, Math.min(...values.map((v) => v.nextAttemptAt))),
          ).toISOString()
        : null,
      error: values.find((value) => value.error)?.error ?? null,
    };
  }
  async flush(limit = 10) {
    await Promise.all([this.flushLane('ordered', limit), this.flushLane('menu', limit)]);
  }
  private flushLane(lane: Lane, limit: number): Promise<void> {
    const active = this.running.get(lane);
    if (active) return active;
    if (this.stopped || !this.pending.size) return Promise.resolve();
    const sending = Promise.resolve()
      .then(async () => {
        const attempted = new Set<string>();
        for (let i = 0; i < limit && !this.stopped; ++i) {
          if (this.clock() < this.rateLimitUntil) break;
          const seen = new Set<string>();
          const ready = [...this.pending.entries()]
            .filter(([, value]) => laneFor(value.options) === lane)
            .sort(
              (a, b) =>
                Number(a[1].options.operation === 'pin') -
                  Number(b[1].options.operation === 'pin') || a[1].createdAt - b[1].createdAt,
            )
            .find(([key, value]) => {
              const route = isIndependent(value) ? key : digest(value.destination);
              if (seen.has(route)) return false;
              seen.add(route);
              return value.nextAttemptAt <= this.clock() && !attempted.has(key);
            });
          if (!ready) break;
          attempted.add(ready[0]);
          await this.attempt(...ready);
        }
      })
      .catch((error) => this.store.setSetting('telegram.deliveryError', redact(String(error))))
      .finally(() => {
        this.running.delete(lane);
        if (this.wake.delete(lane) && !this.stopped) void this.flushLane(lane, 10);
      });
    this.running.set(lane, sending);
    return sending;
  }
  private async call<T>(method: string, body: unknown, signal: AbortSignal): Promise<T> {
    if (this.clock() < this.rateLimitUntil) throw waitForTelegram;
    signal.throwIfAborted();
    try {
      return await this.api.call<T>(method, body, signal);
    } catch (error) {
      const seconds = Number((error as { retryAfter?: number })?.retryAfter);
      if (Number.isFinite(seconds) && seconds > 0) {
        this.rateLimitUntil = Math.max(
          this.rateLimitUntil,
          Math.min(8.64e15, this.clock() + seconds * 1000),
        );
        this.store.setSetting(`telegram.deliveryLimit:${this.bot}`, this.rateLimitUntil);
      }
      throw error;
    }
  }
  private async attempt(key: string, value: Delivery) {
    if (!this.valid(value)) {
      value.status = 'cancelled';
      if (value.options.reminder && value.options.notificationId)
        this.store.db
          .prepare("UPDATE notifications SET status='superseded',at=? WHERE id=?")
          .run(new Date(this.clock()).toISOString(), value.options.notificationId);

      this.save(key, value);
      return;
    }
    const revision = value.revision,
      content = structuredClone(value.content),
      options = { ...value.options };
    value.status = 'sending';
    if (options.requestedMenu) value.firstAttemptAt ??= this.clock();
    this.save(key, value);
    const controller = new AbortController();
    this.controllers.add(controller);
    try {
      if (options.operation === 'reaction' || options.operation === 'pin') {
        const reaction = options.operation === 'reaction';
        await this.call(
          reaction ? 'setMessageReaction' : 'pinChatMessage',
          reaction
            ? {
                chat_id: value.destination.chatId,
                message_id: options.reactionMessageId,
                reaction: [{ type: 'emoji', emoji: '👀' }],
              }
            : {
                chat_id: value.destination.chatId,
                message_id: options.pinMessageId,
                disable_notification: true,
              },
          AbortSignal.any([controller.signal, AbortSignal.timeout(4000)]),
        );
        value.status = 'sent';
        value.error = undefined;
        value.attempts = 0;
        this.save(key, value);
        return;
      }
      if (options.operation === 'renameTopic') {
        try {
          await this.call(
            'editForumTopic',
            {
              chat_id: value.destination.chatId,
              message_thread_id: value.destination.threadId,
              name: content.text,
            },
            controller.signal,
          );
        } catch (error) {
          if (!/topic[_ ](?:is[_ ])?not[_ ]modified/i.test(String(error))) throw error;
        }
        value.status = value.revision === revision ? 'sent' : 'queued';
        value.error = undefined;
        value.attempts = 0;
        this.save(key, value);
        return;
      }
      const chunks = splitTelegramText(content);
      for (let i = 0; i < chunks.length; i++) {
        if (value.revision !== revision || !this.valid(value)) break;
        const chunk = chunks[i];
        const body = {
          chat_id: value.destination.chatId,
          text: chunk.text,
          entities: chunk.entities,
          link_preview_options: { is_disabled: true },
          reply_markup: {
            inline_keyboard:
              i === chunks.length - 1 ? ((content as TelegramCard).buttons ?? []) : [],
          },
        };
        const fingerprint = digest(body);
        let existing: Delivery['messages'][number] | undefined = value.messages[i];
        if (existing?.fingerprint === fingerprint) continue;
        if (existing) {
          try {
            await this.call(
              'editMessageText',
              { ...body, message_id: existing.id },
              controller.signal,
            );
          } catch (error) {
            if (/message to edit not found/i.test(String(error))) existing = undefined;
            else if (!/message is not modified/i.test(String(error))) throw error;
          }
        }
        if (existing) {
          existing.fingerprint = fingerprint;
        } else {
          const result = await this.call<{ message_id: number }>(
            'sendMessage',
            {
              ...body,
              ...(value.destination.threadId === undefined
                ? {}
                : { message_thread_id: value.destination.threadId }),
            },
            controller.signal,
          );
          if (!Number.isSafeInteger(result?.message_id) || result.message_id <= 0)
            throw new Error('Telegram did not return a message ID');
          value.messages[i] = { id: result.message_id, fingerprint };
        }
        this.save(key, value);
      }
      while (value.revision === revision && value.messages.length > chunks.length) {
        const part = value.messages.at(-1)!;
        try {
          await this.call(
            'deleteMessage',
            { chat_id: value.destination.chatId, message_id: part.id },
            controller.signal,
          );
        } catch (error) {
          if (!/message to delete not found/i.test(String(error))) throw error;
        }
        value.messages.pop();
        this.save(key, value);
      }
      if (value.revision === revision && this.valid(value)) {
        if (options.pin && value.messages[0])
          this.enqueuePin(value.destination, value.messages[0].id);
        value.status = 'sent';
        if (options.requestedMenu) value.sentAt ??= this.clock();
        value.error = undefined;
        value.attempts = 0;
        if (options.notificationId)
          this.store.db
            .prepare("UPDATE notifications SET status='sent',at=? WHERE id=?")
            .run(new Date(this.clock()).toISOString(), options.notificationId);
        if (options.deletePrevious) {
          try {
            await this.call(
              'deleteMessage',
              {
                chat_id: options.deletePrevious.chatId,
                message_id: options.deletePrevious.messageId,
              },
              controller.signal,
            );
          } catch (error) {
            if (
              error === waitForTelegram ||
              Number((error as { retryAfter?: number })?.retryAfter) > 0
            )
              throw error;
            this.api.onCleanupError?.(error);
          }
          value.options.deletePrevious = undefined;
        }
      } else value.status = 'queued';
      this.save(key, value);
    } catch (error) {
      if (error === waitForTelegram) {
        value.status = 'queued';
        value.nextAttemptAt = Math.max(value.nextAttemptAt, this.rateLimitUntil);
        this.save(key, value);
        return;
      }
      const status = Number((error as { telegramStatus?: number })?.telegramStatus);
      if (options.operation === 'pin') {
        const description = String(error);
        if (/message.*already.*pinned|chat[_ ]not[_ ]modified/i.test(description)) {
          value.status = 'sent';
          value.error = undefined;
          this.save(key, value);
          return;
        }
        if (/message to pin not found|message[_ ]id[_ ]invalid|chat not found/i.test(description)) {
          value.status = 'cancelled';
          value.error = redact(description);
          this.save(key, value);
          return;
        }
      }
      if (
        options.operation === 'reaction' &&
        status >= 400 &&
        status < 500 &&
        status !== 408 &&
        status !== 429
      ) {
        value.status = 'cancelled';
        value.error = redact(String(error));
        this.save(key, value);
        return;
      }
      value.status = 'queued';
      value.attempts++;
      value.error = redact(String(error));
      value.nextAttemptAt = Math.max(
        this.rateLimitUntil,
        this.clock() + Math.min(300000, 1000 * 2 ** Math.min(value.attempts - 1, 9)),
      );
      this.save(key, value);
      if (options.notificationId)
        this.store.db
          .prepare("UPDATE notifications SET status='queued' WHERE id=?")
          .run(options.notificationId);
    } finally {
      this.controllers.delete(controller);
    }
  }
  async stop() {
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = undefined;
    for (const controller of this.controllers) controller.abort();
    await Promise.all(this.running.values());
  }
}
