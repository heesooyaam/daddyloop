import { createHash, randomUUID } from 'node:crypto';
import type { Store } from '../core/store.js';
import { redact } from '../core/security.js';
import { splitTelegramText, type TelegramCard, type FormattedText } from './telegram-text.js';

export type TelegramDestination = { chatId: number; threadId?: number };
export interface DeliveryOptions {
  operation?: 'renameTopic';
  key?: string;
  replace?: boolean;
  pin?: boolean;
  preserveNavigation?: boolean;
  order?: string;
  final?: boolean;
  notificationId?: string;
  deletePrevious?: { chatId: number; messageId: number };
}
type DeliveryPin = {
  messageId: number;
  status: 'pinned' | 'failed';
  nextAttemptAt?: number;
  error?: string;
};
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
  pin?: DeliveryPin;
};
type Transport = {
  call<T>(method: string, body?: unknown, signal?: AbortSignal): Promise<T>;
  onCleanupError?: (error: unknown) => void;
};
const prefix = 'telegram.delivery:';
const pinRetryMs = 60 * 60 * 1000;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function deliveryStatus(result: unknown) {
  return (result as { status?: string })?.status ?? 'sent';
}

/** Durable, ordered delivery. Callers choose whether a stable key is replaceable. */
export class TelegramDelivery {
  private pending = new Map<string, Delivery>();
  private pinRetries = new Map<string, Delivery>();
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
      if (value.status === 'sent' && value.pin?.status === 'failed')
        this.pinRetries.set(key, value);
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
    if (value.status === 'sent' && value.pin?.status === 'failed') this.pinRetries.set(key, value);
    else this.pinRetries.delete(key);
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
    let value =
      this.pending.get(key) ?? this.pinRetries.get(key) ?? this.store.setting<Delivery>(key);
    if (value) {
      const needsPin =
        !!options.pin &&
        (!value.options.pin ||
          !value.pin ||
          (value.pin.status === 'failed' && (value.pin.nextAttemptAt ?? 0) <= this.clock()));
      if (
        (value.options.final && !options.final) ||
        (options.order && value.options.order && options.order < value.options.order)
      )
        return { status: 'superseded', deliveryId: value.id };
      if (!options.replace)
        return { status: value.status === 'sent' ? 'sent' : 'queued', deliveryId: value.id };
      if (
        !needsPin &&
        digest([value.content, value.options.final]) === digest([content, options.final])
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
        pin: value.options.pin || options.pin || undefined,
        deletePrevious: value.options.deletePrevious ?? options.deletePrevious,
      };
      value.revision++;
      value.status = 'queued';
      value.nextAttemptAt = this.clock();
    } else
      value = {
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
    this.save(key, value);
    // New text also wakes the oldest buffered message for this conversation. Never bypass retry_after.
    for (const [otherKey, other] of this.pending)
      if (digest(other.destination) === digest(destination) && other.status === 'queued') {
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
  private async pinMessage(value: Delivery, signal: AbortSignal) {
    if (!value.options.pin) return;
    const messageId = value.messages[0]?.id;
    if (!messageId) return;
    if (value.pin?.messageId === messageId) {
      if (value.pin.status === 'pinned') return;
      if ((value.pin.nextAttemptAt ?? 0) > this.clock()) return;
    }
    const previousError = value.pin?.error;
    try {
      await this.api.call(
        'pinChatMessage',
        {
          chat_id: value.destination.chatId,
          message_id: messageId,
          disable_notification: true,
        },
        signal,
      );
      value.pin = { messageId, status: 'pinned' };
      if (previousError && this.store.setting('telegram.error') === previousError)
        this.store.setSetting('telegram.error', null);
    } catch (error) {
      if (signal.aborted) throw error;
      if (/message.*already.*pinned|chat[_ ]not[_ ]modified/i.test(String(error))) {
        value.pin = { messageId, status: 'pinned' };
        if (previousError && this.store.setting('telegram.error') === previousError)
          this.store.setSetting('telegram.error', null);
        return;
      }
      const location = `${value.destination.chatId}${
        value.destination.threadId === undefined ? '' : `, topic ${value.destination.threadId}`
      }`;
      const diagnostic = `Could not pin the Telegram status message in chat ${location}. Give the bot permission to pin messages; the session will continue without the pin.`;
      value.pin = {
        messageId,
        status: 'failed',
        nextAttemptAt: this.clock() + pinRetryMs,
        error: diagnostic,
      };
      this.store.setSetting('telegram.error', diagnostic);
      this.store.event('_system', 'telegram.status_pin_failed', {
        destination: value.destination,
        error: redact(String(error)),
      });
    }
  }
  private async retryPins(limit: number) {
    const attempted = new Set<string>();
    for (let i = 0; i < limit && !this.stopped; i++) {
      if (this.clock() < this.rateLimitUntil) break;
      const ready = [...this.pinRetries.entries()]
        .filter(
          ([key, value]) =>
            !attempted.has(key) &&
            value.status === 'sent' &&
            value.pin?.status === 'failed' &&
            (value.pin.nextAttemptAt ?? 0) <= this.clock(),
        )
        .sort(
          (a, b) =>
            (a[1].pin?.nextAttemptAt ?? 0) - (b[1].pin?.nextAttemptAt ?? 0) ||
            a[1].createdAt - b[1].createdAt,
        )[0];
      if (!ready) break;
      attempted.add(ready[0]);
      await this.retryPin(...ready);
    }
  }
  private async retryPin(key: string, value: Delivery) {
    if (!this.valid(value)) {
      const error = value.pin?.error;
      value.options.pin = undefined;
      value.pin = undefined;
      if (error && this.store.setting('telegram.error') === error)
        this.store.setSetting('telegram.error', null);
      this.save(key, value);
      return;
    }
    this.controller = new AbortController();
    try {
      await this.pinMessage(value, this.controller.signal);
      this.save(key, value);
    } finally {
      this.controller = undefined;
    }
  }
  async flush(limit = 10) {
    if (this.running || this.stopped) return this.running;
    this.running = (async () => {
      const attempted = new Set<string>();
      for (let i = 0; i < limit && !this.stopped; i++) {
        if (this.clock() < this.rateLimitUntil) break;
        const seen = new Set<string>();
        const ready = [...this.pending.entries()]
          .sort((a, b) => a[1].createdAt - b[1].createdAt)
          .filter(([, value]) => {
            const route = digest(value.destination);
            if (seen.has(route)) return false;
            seen.add(route);
            return value.nextAttemptAt <= this.clock();
          })
          .find(([key]) => !attempted.has(key));
        if (!ready) break;
        attempted.add(ready[0]);
        await this.attempt(...ready);
      }
      await this.retryPins(limit);
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
      this.save(key, value);
      return;
    }
    const revision = value.revision,
      content = structuredClone(value.content),
      options = { ...value.options };
    const chunks = splitTelegramText(content);
    value.status = 'sending';
    this.save(key, value);
    this.controller = new AbortController();
    try {
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
        await this.pinMessage(value, this.controller.signal);
        if (value.revision !== revision || !this.valid(value)) {
          value.status = 'queued';
          this.save(key, value);
          return;
        }
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
