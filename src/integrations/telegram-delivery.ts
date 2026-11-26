import { reminderOpen, type OwnerQuestion } from './telegram-reminders.js';
import { createHash, randomUUID } from 'node:crypto';
import type { Store } from '../core/store.js';
import { redact } from '../core/security.js';
import {
  TelegramText,
  splitTelegramText,
  type TelegramCard,
  type FormattedText,
} from './telegram-text.js';

export type TelegramDestination = { chatId: number; threadId?: number };
export interface DeliveryOptions {
  reminder?: OwnerQuestion;
  groupId?: string;
  operation?: 'renameTopic' | 'reaction' | 'pin';
  reactionMessageId?: number;
  pinMessageId?: number;
  pin?: boolean;
  pinWarning?: string;
  sessionRoute?: boolean;
  mention?: { question: OwnerQuestion; text: FormattedText };
  replyMessageId?: number;
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
  status: 'queued' | 'sending' | 'sent' | 'cancelled';
  attempts: number;
  mentionOnPromotion?: boolean;
  nextAttemptAt: number;
  error?: string;
  messages: { id: number; fingerprint: string }[];
};
type Transport = {
  call<T>(method: string, body?: unknown, signal?: AbortSignal): Promise<T>;
  onCleanupError?: (error: unknown) => void;
};
const prefix = 'telegram.delivery:';
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const isIndependent = ({ options }: Delivery) =>
  options.operation === 'reaction' || options.operation === 'pin';
export const dialogKey = (messageId: string) => `dialog:${messageId}`;
const deliveryKey = (bot: string, route: TelegramDestination, key: string) =>
  prefix + digest([bot, route, key]);

export function deliveryStatus(result: unknown) {
  return (result as { status?: string })?.status ?? 'sent';
}

/** Durable, ordered delivery with one receipt per acknowledged message part. */
export class TelegramDelivery {
  private pending = new Map<string, Delivery>();
  private running?: Promise<void>;
  private controller?: AbortController;
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private rateLimitUntil = 0;
  constructor(
    private store: Store,
    private api: Transport,
    private bot: string,
    private clock = Date.now,
  ) {
    this.migrateDialogDeliveries();
    for (const row of store.db
      .prepare("SELECT key,value FROM settings WHERE key GLOB 'telegram.delivery:*' ORDER BY rowid")
      .all()) {
      const value = JSON.parse(String(row.value)) as Delivery;
      if (!value || value.bot !== bot || !['queued', 'sending'].includes(value.status)) continue;
      value.status = 'queued';
      this.pending.set(String(row.key), value);
    }
    this.rateLimitUntil = store.setting<number>(`telegram.deliveryLimit:${bot}`) ?? 0;
  }
  private migrateDialogDeliveries() {
    const rows = this.store.db
      .prepare(
        `SELECT key,value FROM settings WHERE key GLOB 'telegram.delivery:*'
       AND json_extract(value,'$.bot')=?
       AND json_extract(value,'$.options.key') NOT GLOB 'dialog:*'
       AND json_extract(value,'$.options.notificationId') GLOB 'telegram:dialog:*'
       ORDER BY json_extract(value,'$.options.final') DESC, rowid DESC`,
      )
      .all(this.bot);
    if (!rows.length) return;
    this.store.transaction(() => {
      for (const row of rows) {
        const value = JSON.parse(String(row.value)) as Delivery;
        const { options, destination } = value;
        // Legacy progress and final notifications can share a turn receipt.
        // Its notificationId identifies the content, including an in-flight edit.
        const match = options.notificationId?.match(
          /^telegram:dialog:-?\d+:\d+:([^:]+)(?::(?:progress|final))?$/,
        );
        if (!match) continue;
        if (!options.groupId && options.key?.startsWith('turn:')) {
          const job = this.store.db
            .prepare('SELECT group_id FROM daddy_jobs WHERE id=?')
            .get(options.key.slice(5));
          if (typeof job?.group_id === 'string') options.groupId = job.group_id;
        }
        if (!options.groupId) continue;
        const message = this.store.messageById(options.groupId, match[1]);
        if (message?.sender !== 'agent') continue;
        const key = dialogKey(message.id);
        const storageKey = deliveryKey(this.bot, destination, key);
        if (this.store.setting<Delivery>(storageKey)) {
          // Earlier versions could send a final mention as well as a progress card.
          // Keep the old native receipts for reply routing, but stop queued duplicates.
          if (['queued', 'sending'].includes(value.status)) {
            value.status = 'cancelled';
            this.store.setSetting(String(row.key), value);
          }
          continue;
        }
        options.key = key;
        options.sessionRoute = true;
        const heading = value.content.text.indexOf('👨‍💻 [daddy]');
        if (heading > 0 && message.needsReply) {
          options.mention = {
            question: { groupId: options.groupId, messageId: message.id },
            text: {
              text: value.content.text.slice(0, heading),
              entities: value.content.entities.filter((entity) => entity.offset < heading),
            },
          };
          value.content = {
            text: value.content.text.slice(heading),
            entities: value.content.entities
              .filter((entity) => entity.offset >= heading)
              .map((entity) => ({ ...entity, offset: entity.offset - heading })),
          };
        }
        // Change the key in place to preserve FIFO order for equal timestamps.
        this.store.db
          .prepare('UPDATE settings SET key=?,value=? WHERE key=?')
          .run(storageKey, JSON.stringify(value), row.key);
      }
    });
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
    const pair = this.store.setting<{ chatId: number; userId: number }>('telegram.pairing');
    const room = this.store.setting<{ chatId: number; ownerId: number }>('telegram.group');
    if (value.ownerId !== pair?.userId) return false;
    if (value.options.sessionRoute && value.options.groupId) {
      const groupId = value.options.groupId;
      const row = this.store.db.prepare('SELECT data FROM review_groups WHERE id=?').get(groupId);
      if (!row || JSON.parse(String(row.data)).deletedAt) return false;
      if (room && room.ownerId === pair?.userId) {
        const row = this.store.db
          .prepare('SELECT data FROM telegram_topics WHERE id=?')
          .get(`${room.ownerId}:${room.chatId}:${groupId}`);
        const topic = row && (JSON.parse(String(row.data)) as TelegramDestination);
        return (
          !!topic &&
          topic.chatId === value.destination.chatId &&
          topic.threadId === value.destination.threadId
        );
      }
      return value.destination.chatId === pair?.chatId && value.destination.threadId === undefined;
    }
    return (
      !pair ||
      value.destination.chatId === pair.chatId ||
      (value.destination.chatId === room?.chatId && room.ownerId === pair.userId)
    );
  }
  replySession(chatId: number, messageId: number, ownerId: number): string | undefined {
    // Telegram message IDs are scoped to a chat. Only trust our own delivery receipt.
    const row = this.store.db
      .prepare(
        `SELECT json_extract(value,'$.options.groupId') AS groupId,
      json_extract(value,'$.options.key') AS deliveryKey FROM settings
      WHERE key GLOB 'telegram.delivery:*' AND json_extract(value,'$.bot')=? AND json_extract(value,'$.ownerId')=?
        AND json_extract(value,'$.destination.chatId')=?
        AND EXISTS(SELECT 1 FROM json_each(settings.value,'$.messages') m WHERE json_extract(m.value,'$.id')=?) LIMIT 1`,
      )
      .get(this.bot, ownerId, chatId, messageId);
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
  private enqueuePin(
    destination: TelegramDestination,
    messageId: number,
    options: DeliveryOptions,
  ) {
    const key = prefix + digest([this.bot, 'pin', destination.chatId, messageId]);
    const pinOptions: DeliveryOptions = {
      operation: 'pin',
      pinMessageId: messageId,
      groupId: options.groupId,
      sessionRoute: options.sessionRoute,
      pinWarning: options.pinWarning,
    };
    const existing = this.pending.get(key) ?? this.store.setting<Delivery>(key);
    if (existing) {
      if (existing.status === 'sent') return;
      const staleRoute = existing.status === 'cancelled' && !existing.error;
      const legacy = !existing.options.pinWarning && !!options.pinWarning;
      if (!staleRoute && !legacy) return;
      // Older pin jobs did not carry the status card's route or warning.
      existing.options = pinOptions;
      if (existing.status === 'cancelled') existing.status = 'queued';
      this.save(key, existing);
      return;
    }
    this.save(key, this.createDelivery(destination, new TelegramText(), pinOptions));
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
    const key = deliveryKey(this.bot, destination, options.key ?? randomUUID());
    let value = this.pending.get(key) ?? this.store.setting<Delivery>(key);
    if (value) {
      if (
        value.status !== 'cancelled' &&
        ((value.options.final && !options.final) ||
          (options.order && value.options.order && options.order < value.options.order))
      )
        return { status: 'superseded', deliveryId: value.id };
      if (!options.replace && value.status !== 'cancelled')
        return { status: value.status === 'sent' ? 'sent' : 'queued', deliveryId: value.id };
      if (
        value.status !== 'cancelled' &&
        digest([
          value.content,
          value.options.final,
          value.options.pinWarning,
          value.options.pin,
          value.options.mention,
        ]) === digest([content, options.final, options.pinWarning, options.pin, options.mention])
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
      if (options.mention && options.final && !value.options.final && value.messages.length > 0)
        value.mentionOnPromotion = true;
      value.content = structuredClone(content);
      value.options = {
        ...options,
        deletePrevious: value.options.deletePrevious ?? options.deletePrevious,
      };
      value.revision++;
      value.status = 'queued';
      value.nextAttemptAt = this.clock();
    } else value = this.createDelivery(destination, content, options);
    this.save(key, value);
    // New text also wakes the oldest buffered message for this conversation. Never bypass retry_after.
    for (const [otherKey, other] of this.pending)
      if (
        !isIndependent(other) &&
        digest(other.destination) === digest(destination) &&
        other.status === 'queued'
      ) {
        other.nextAttemptAt = this.clock();
        this.save(otherKey, other);
      }
    if (!this.running && !this.stopped) await this.flush(1);
    else if (this.running && !this.stopped)
      void this.running.then(() => {
        if (!this.stopped) return this.flush(1);
      });
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
    if (this.running || this.stopped) return this.running;
    this.running = (async () => {
      const attempted = new Set<string>();
      for (let i = 0; i < limit && !this.stopped; i++) {
        if (this.clock() < this.rateLimitUntil) break;
        const seen = new Set<string>();
        const ready = [...this.pending.entries()]
          .sort(
            (a, b) =>
              Number(a[1].options.operation === 'pin') - Number(b[1].options.operation === 'pin') ||
              a[1].createdAt - b[1].createdAt,
          )
          .filter(([key, value]) => {
            const route = isIndependent(value) ? key : digest(value.destination);
            if (seen.has(route)) return false;
            seen.add(route);
            return value.nextAttemptAt <= this.clock();
          })
          .find(([key]) => !attempted.has(key));
        if (!ready) break;
        attempted.add(ready[0]);
        await this.attempt(...ready);
      }
    })().catch((error) => this.store.setSetting('telegram.deliveryError', redact(String(error))));
    try {
      await this.running;
    } finally {
      this.running = undefined;
    }
  }
  private async attempt(key: string, value: Delivery) {
    if (!this.valid(value)) {
      value.status = 'cancelled';
      value.error = undefined;
      if (
        value.options.reminder &&
        value.options.notificationId &&
        !reminderOpen(this.store, value.options.reminder)
      )
        this.store.db
          .prepare("UPDATE notifications SET status='superseded',at=? WHERE id=?")
          .run(new Date(this.clock()).toISOString(), value.options.notificationId);

      this.save(key, value);
      return;
    }
    const revision = value.revision,
      original = structuredClone(value.content),
      options = { ...value.options };
    value.status = 'sending';
    this.save(key, value);
    this.controller = new AbortController();
    try {
      if (options.operation === 'reaction' || options.operation === 'pin') {
        const reaction = options.operation === 'reaction';
        await this.api.call(
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
          AbortSignal.any([this.controller.signal, AbortSignal.timeout(4000)]),
        );
        value.status = 'sent';
        value.error = undefined;
        value.attempts = 0;
        this.save(key, value);
        return;
      }
      if (options.operation === 'renameTopic') {
        try {
          await this.api.call(
            'editForumTopic',
            {
              chat_id: value.destination.chatId,
              message_thread_id: value.destination.threadId,
              name: original.text,
            },
            this.controller.signal,
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
      const mention =
        options.mention && reminderOpen(this.store, options.mention.question)
          ? options.mention
          : undefined;
      // Telegram edits do not generate a fresh mention. If the progress was already
      // visible, send the mention as a reply to that message after finalization.
      const mentionAsReply = mention && value.mentionOnPromotion && value.messages.length > 0;
      const content =
        mention && !mentionAsReply
          ? { ...original, ...new TelegramText().append(mention.text).append(original) }
          : original;
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
            await this.api.call(
              'editMessageText',
              { ...body, message_id: existing.id },
              this.controller.signal,
            );
          } catch (error) {
            if (/message to edit not found/i.test(String(error))) existing = undefined;
            else if (!/message is not modified/i.test(String(error))) throw error;
          }
        }
        if (existing) {
          existing.fingerprint = fingerprint;
        } else {
          const result = await this.api.call<{ message_id: number }>(
            'sendMessage',
            {
              ...body,
              ...(options.replyMessageId
                ? {
                    reply_parameters: {
                      message_id: options.replyMessageId,
                      allow_sending_without_reply: true,
                    },
                  }
                : {}),
              ...(value.destination.threadId === undefined
                ? {}
                : { message_thread_id: value.destination.threadId }),
            },
            this.controller.signal,
          );
          if (!Number.isSafeInteger(result?.message_id) || result.message_id <= 0)
            throw new Error('Telegram did not return a message ID');
          value.messages[i] = { id: result.message_id, fingerprint };
          if (!options.final && value.options.final && value.options.mention)
            value.mentionOnPromotion = true;
        }
        this.save(key, value);
      }
      while (
        value.revision === revision &&
        this.valid(value) &&
        value.messages.length > chunks.length
      ) {
        const part = value.messages.at(-1)!;
        try {
          await this.api.call(
            'deleteMessage',
            { chat_id: value.destination.chatId, message_id: part.id },
            this.controller.signal,
          );
        } catch (error) {
          if (!/message to delete not found/i.test(String(error))) throw error;
        }
        value.messages.pop();
        this.save(key, value);
      }
      if (value.revision === revision && this.valid(value)) {
        if (options.pin && value.messages[0])
          this.enqueuePin(value.destination, value.messages[0].id, options);
        if (mentionAsReply && mention && value.messages[0]) {
          const reply = deliveryKey(this.bot, value.destination, `mention:${options.key}`);
          if (!this.store.setting<Delivery>(reply))
            this.save(
              reply,
              this.createDelivery(value.destination, mention.text, {
                groupId: options.groupId,
                sessionRoute: options.sessionRoute,
                reminder: mention.question,
                replyMessageId: value.messages[0].id,
              }),
            );
        }
        value.status = 'sent';
        value.error = undefined;
        value.attempts = 0;
        if (options.notificationId)
          this.store.db
            .prepare("UPDATE notifications SET status='sent',at=? WHERE id=?")
            .run(new Date(this.clock()).toISOString(), options.notificationId);
        if (options.deletePrevious) {
          try {
            await this.api.call(
              'deleteMessage',
              {
                chat_id: options.deletePrevious.chatId,
                message_id: options.deletePrevious.messageId,
              },
              this.controller.signal,
            );
          } catch (error) {
            this.api.onCleanupError?.(error);
          }
          value.options.deletePrevious = undefined;
        }
      } else value.status = 'queued';
      this.save(key, value);
    } catch (error) {
      const status = Number((error as { telegramStatus?: number })?.telegramStatus);
      if (options.operation === 'pin') {
        const description = String(error);
        if (/message.*already.*pinned|chat[_ ]not[_ ]modified/i.test(description)) {
          value.status = 'sent';
          value.error = undefined;
          this.save(key, value);
          return;
        }
        if (
          status === 403 ||
          /not enough rights|CHAT_ADMIN_REQUIRED|not permitted to pin/i.test(description)
        ) {
          value.status = 'cancelled';
          value.error = redact(description);
          if (options.pinWarning) {
            const warning = deliveryKey(
              this.bot,
              value.destination,
              `pin-warning:${options.pinMessageId}`,
            );
            this.store.transaction(() => {
              if (!this.store.setting<Delivery>(warning))
                this.save(
                  warning,
                  this.createDelivery(
                    value.destination,
                    new TelegramText().add(options.pinWarning!),
                    { groupId: options.groupId, sessionRoute: options.sessionRoute },
                  ),
                );
              this.save(key, value);
            });
          } else this.save(key, value);
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
      const retryAfter = Number((error as { retryAfter?: number }).retryAfter);
      if (Number.isFinite(retryAfter) && retryAfter > 0) {
        this.rateLimitUntil = Math.min(8.64e15, this.clock() + retryAfter * 1000);
        this.store.setSetting(`telegram.deliveryLimit:${this.bot}`, this.rateLimitUntil);
      }
      value.nextAttemptAt = Math.max(
        this.rateLimitUntil,
        this.clock() + Math.min(300000, 1000 * 2 ** Math.min(value.attempts - 1, 9)),
      );
      this.save(key, value);
      if (value.revision === revision && options.notificationId)
        this.store.db
          .prepare("UPDATE notifications SET status='queued' WHERE id=?")
          .run(options.notificationId);
    } finally {
      this.controller = undefined;
    }
  }
  async stop() {
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = undefined;
    this.controller?.abort();
    await this.running;
  }
}
