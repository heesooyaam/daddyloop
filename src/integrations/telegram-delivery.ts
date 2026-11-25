import { createHash, randomUUID } from 'node:crypto';
import type { Store } from '../core/store.js';
import { redact } from '../core/security.js';
import { splitTelegramText, type TelegramCard, type FormattedText } from './telegram-text.js';

export type TelegramDestination = { chatId: number; threadId?: number };
export interface DeliveryOptions {
  operation?: 'renameTopic' | 'reaction' | 'pin';
  reactionMessageId?: number;
  pinMessageId?: number;
  pin?: boolean;
  key?: string;
  replace?: boolean;
  preserveNavigation?: boolean;
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
  nextAttemptAt: number;
  error?: string;
  messages: { id: number; fingerprint: string }[];
};
type Transport = {
  call<T>(method: string, body?: unknown, signal?: AbortSignal): Promise<T>;
  onCleanupError?: (error: unknown) => void;
};
const prefix = 'telegram.delivery:';
const pinRetryMs = 60 * 60 * 1000;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const notificationIdentity = (value: string) => value.replace(/:(?:progress|final)$/, '');
const isIndependent = ({ options }: Delivery) =>
  options.operation === 'reaction' || options.operation === 'pin';
export function deliveryStatus(result: unknown) {
  return (result as { status?: string })?.status ?? 'sent';
}

/** Durable, ordered delivery. Callers choose whether a stable key is replaceable. */
export class TelegramDelivery {
  private pending = new Map<string, Delivery>();
  // Older releases used one turn:<runId> delivery for every agent message in a turn.
  // Keep a one-time lookup so replay can move that durable state to message:<messageId>.
  private legacyByNotification = new Map<string, { key: string; value: Delivery }>();
  private redirectedKeys = new Map<string, string>();
  private running?: Promise<void>;
  private controller?: AbortController;
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private rateLimitUntil = 0;
  private lastCreatedAt = 0;
  constructor(
    private store: Store,
    private api: Transport,
    private bot: string,
    private clock = Date.now,
  ) {
    for (const row of store.db
      .prepare("SELECT key,value FROM settings WHERE key LIKE 'telegram.delivery:%' ORDER BY rowid")
      .all()) {
      const value = JSON.parse(String(row.value)) as Delivery;
      if (!value || value.bot !== bot) continue;
      const key = String(row.key);
      if (['queued', 'sending'].includes(value.status)) {
        value.status = 'queued';
        this.lastCreatedAt = Math.max(this.lastCreatedAt, Number(value.createdAt) || 0);
        this.pending.set(key, value);
      }
      if (
        value.status !== 'cancelled' &&
        value.options?.key?.startsWith('turn:') &&
        value.options.notificationId
      )
        this.legacyByNotification.set(
          digest([value.destination, notificationIdentity(value.options.notificationId)]),
          { key, value },
        );
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
    const redirected = this.redirectedKeys.get(key);
    if (redirected) {
      this.pending.delete(key);
      key = redirected;
    }
    this.store.setSetting(key, value);
    this.remember(key, value);
  }
  private remember(key: string, value: Delivery) {
    if (['queued', 'sending'].includes(value.status)) this.pending.set(key, value);
    else this.pending.delete(key);
  }
  private createdAt() {
    this.lastCreatedAt = Math.max(this.clock(), this.lastCreatedAt + 1);
    return this.lastCreatedAt;
  }
  private valid(value: Delivery) {
    const pair = this.store.setting<{ chatId: number; userId: number }>('telegram.pairing');
    const room = this.store.setting<{ chatId: number; ownerId: number }>('telegram.group');
    if (value.ownerId !== pair?.userId) return false;
    return (
      !pair ||
      value.destination.chatId === pair.chatId ||
      (value.destination.chatId === room?.chatId && room.ownerId === pair.userId)
    );
  }
  private migrateByNotification(
    key: string,
    destination: TelegramDestination,
    notificationId: string,
    deliveryKey?: string,
  ) {
    const legacyKey = digest([destination, notificationIdentity(notificationId)]);
    const row = this.legacyByNotification.get(legacyKey);
    if (!row || row.key === key) return;
    if (row.value.status === 'sending') row.value.status = 'queued';
    row.value.options.key = deliveryKey;
    this.store.transaction(() => {
      this.store.setSetting(key, row.value);
      this.store.db.prepare('DELETE FROM settings WHERE key=?').run(row.key);
    });
    this.pending.delete(row.key);
    this.legacyByNotification.delete(legacyKey);
    this.redirectedKeys.set(row.key, key);
    this.remember(key, row.value);
    return row.value;
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
      createdAt: this.createdAt(),
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
    if (!value && options.notificationId && options.key?.startsWith('message:'))
      value = this.migrateByNotification(key, destination, options.notificationId, options.key);
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
  private clearPinError(error?: string) {
    if (error && this.store.setting('telegram.error') === error)
      this.store.setSetting('telegram.error', null);
  }
  private applyRateLimit(error: unknown) {
    const retryAfter = Number((error as { retryAfter?: number }).retryAfter);
    if (!Number.isFinite(retryAfter) || retryAfter <= 0) return;
    this.rateLimitUntil = Math.min(8.64e15, this.clock() + retryAfter * 1000);
    this.store.setSetting(`telegram.deliveryLimit:${this.bot}`, this.rateLimitUntil);
    return this.rateLimitUntil;
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
      if (value.options.operation === 'pin') this.clearPinError(value.error);
      value.status = 'cancelled';
      this.save(key, value);
      return;
    }
    const revision = value.revision,
      content = structuredClone(value.content),
      options = { ...value.options };
    value.status = 'sending';
    this.save(key, value);
    this.controller = new AbortController();
    try {
      if (options.operation === 'reaction' || options.operation === 'pin') {
        const reaction = options.operation === 'reaction';
        const previousError = value.error;
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
        if (!reaction) this.clearPinError(previousError);
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
              name: content.text,
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
              ...(value.destination.threadId === undefined
                ? {}
                : { message_thread_id: value.destination.threadId }),
            },
            this.controller.signal,
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
          this.enqueuePin(value.destination, value.messages[0].id);
        value.status = 'sent';
        value.error = undefined;
        value.attempts = 0;
        if (options.notificationId)
          this.store.db
            .prepare("UPDATE notifications SET status='sent' WHERE id=?")
            .run(options.notificationId);
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
      const rateLimitUntil = this.applyRateLimit(error);
      if (options.operation === 'pin') {
        const description = String(error);
        const previousError = value.error;
        if (/message.*already.*pinned|chat[_ ]not[_ ]modified/i.test(description)) {
          value.status = 'sent';
          value.error = undefined;
          this.clearPinError(previousError);
          this.save(key, value);
          return;
        }
        if (/message to pin not found|message[_ ]id[_ ]invalid|chat not found/i.test(description)) {
          value.status = 'cancelled';
          value.error = redact(description);
          this.clearPinError(previousError);
          this.save(key, value);
          return;
        }
        const permissionDenied =
          !rateLimitUntil &&
          /not enough rights|chat[_ ]admin[_ ]required|administrator rights|right to pin|can_pin_messages|pin messages/i.test(
            description,
          );
        if (permissionDenied) {
          const location = `${value.destination.chatId}${
            value.destination.threadId === undefined ? '' : `, topic ${value.destination.threadId}`
          }`;
          const diagnostic = `Could not pin the Telegram status message in chat ${location}. Give the bot permission to pin messages; the session will continue without the pin.`;
          value.status = 'queued';
          value.attempts++;
          value.error = diagnostic;
          value.nextAttemptAt = this.clock() + pinRetryMs;
          this.store.setSetting('telegram.error', diagnostic);
          this.store.event('_system', 'telegram.status_pin_failed', {
            destination: value.destination,
            error: redact(description),
          });
          this.save(key, value);
          return;
        }
        this.clearPinError(previousError);
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
