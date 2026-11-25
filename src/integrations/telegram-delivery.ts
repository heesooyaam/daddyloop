import { createHash, randomUUID } from 'node:crypto';
import type { Store } from '../core/store.js';
import { redact } from '../core/security.js';
import {
  splitTelegramText,
  TelegramText,
  type TelegramCard,
  type FormattedText,
} from './telegram-text.js';

export type TelegramDestination = { chatId: number; threadId?: number };
export interface DeliveryOptions {
  groupId?: string;
  operation?: 'renameTopic' | 'reaction' | 'pin';
  reactionMessageId?: number;
  pinMessageId?: number;
  pin?: boolean;
  key?: string;
  replace?: boolean;
  replacePending?: boolean;
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
  recoveryOrder?: number;
  queueOrder?: number;
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
  private pendingByNotification = new Map<string, { key: string; value: Delivery }>();
  private redirectedKeys = new Map<string, string>();
  private deferredKeys = new Set<string>();
  private historyDeferredKeys = new Set<string>();
  private deferredValues = new Map<string, Delivery>();
  private storedMessages = new Map<string, { id: string; runId?: string; order: number }>();
  private deliveredByRouteRun = new Map<string, Set<string>>();
  private acknowledgedCurrent = new Set<string>();
  private recovering = false;
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
    const deliveries = store.db
      .prepare("SELECT key,value FROM settings WHERE key LIKE 'telegram.delivery:%' ORDER BY rowid")
      .all()
      .map((row) => ({ key: String(row.key), value: JSON.parse(String(row.value)) as Delivery }))
      .filter(({ value }) => value?.bot === bot);
    const recoveryDeliveries = deliveries.filter(
      ({ value }) =>
        ['queued', 'sending'].includes(value.status) &&
        value.options.notificationId?.startsWith('telegram:dialog:'),
    );
    if (recoveryDeliveries.length)
      this.loadRecoveryIndex(recoveryDeliveries.map(({ value }) => value));
    this.recovering = recoveryDeliveries.some(
      ({ value }) => this.storedMessage(value) !== undefined,
    );
    for (const [queueOrder, { key, value }] of deliveries.entries()) {
      this.lastCreatedAt = Math.max(this.lastCreatedAt, Number(value.createdAt) || 0);
      value.recoveryOrder = this.messageOrder(value);
      value.queueOrder = queueOrder;
      const restoreThroughHistory =
        value.options.notificationId?.startsWith('telegram:dialog:') &&
        this.storedMessage(value) !== undefined;
      if (['queued', 'sending'].includes(value.status)) {
        value.status = 'queued';
        if (this.recovering && !isIndependent(value)) {
          this.deferredKeys.add(key);
          this.deferredValues.set(key, value);
          if (restoreThroughHistory) this.historyDeferredKeys.add(key);
        } else this.pending.set(key, value);
      }
      if (
        ['queued', 'sending'].includes(value.status) &&
        value.options?.key?.startsWith('turn:') &&
        value.options.notificationId
      )
        this.legacyByNotification.set(
          digest([value.destination, notificationIdentity(value.options.notificationId)]),
          { key, value },
        );
      if (
        ['queued', 'sending'].includes(value.status) &&
        value.messages.length &&
        this.acknowledgedPartsMatch(value) &&
        !this.inheritedPartsBelongToSibling(value)
      )
        this.acknowledgedCurrent.add(
          digest([value.destination, notificationIdentity(value.options.notificationId ?? '')]),
        );
      if (
        ['queued', 'sending'].includes(value.status) &&
        value.options.notificationId?.startsWith('telegram:dialog:')
      )
        this.pendingByNotification.set(
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
  async finishRecovery() {
    if (!this.recovering) return;
    this.recovering = false;
    for (const value of [...this.deferredValues.values()]) this.releaseUnblocked(value.destination);
    await this.flush();
  }
  needsRecovery() {
    return this.recovering;
  }
  private route(destination: TelegramDestination) {
    return digest(destination);
  }
  private compareDeliveries(a: Delivery, b: Delivery) {
    const aRecovery = a.recoveryOrder;
    const bRecovery = b.recoveryOrder;
    if (aRecovery !== undefined && bRecovery !== undefined && aRecovery !== bRecovery)
      return aRecovery - bRecovery;
    const aQueue = a.queueOrder;
    const bQueue = b.queueOrder;
    if (aQueue !== undefined && bQueue !== undefined && aQueue !== bQueue) return aQueue - bQueue;
    const aOrder = a.options.order;
    const bOrder = b.options.order;
    if (aOrder && bOrder && aOrder !== bOrder) return aOrder.localeCompare(bOrder);
    return a.createdAt - b.createdAt;
  }
  private hasEarlierDeferred(value: Delivery) {
    const route = this.route(value.destination);
    for (const key of this.historyDeferredKeys) {
      const deferred = this.deferredValues.get(key);
      if (
        deferred &&
        this.route(deferred.destination) === route &&
        this.compareDeliveries(deferred, value) < 0
      )
        return true;
    }
    return false;
  }
  private releaseUnblocked(destination: TelegramDestination) {
    const route = this.route(destination);
    for (const key of this.historyDeferredKeys) {
      const value = this.deferredValues.get(key);
      if (value && this.route(value.destination) === route) return;
    }
    for (const [key, value] of [...this.deferredValues])
      if (this.route(value.destination) === route) {
        this.deferredKeys.delete(key);
        this.deferredValues.delete(key);
        this.remember(key, value);
      }
  }
  private activateDeferred(key: string, value: Delivery) {
    const wasHistory = this.historyDeferredKeys.delete(key);
    this.deferredKeys.delete(key);
    this.deferredValues.delete(key);
    this.remember(key, value);
    if (wasHistory) this.releaseUnblocked(value.destination);
  }
  private resolveKey(key: string) {
    const visited: string[] = [];
    let current = key;
    while (this.redirectedKeys.has(current) && !visited.includes(current)) {
      visited.push(current);
      current = this.redirectedKeys.get(current)!;
    }
    for (const previous of visited) this.redirectedKeys.set(previous, current);
    return current;
  }
  private save(key: string, value: Delivery) {
    const redirected = this.resolveKey(key);
    if (redirected !== key) {
      this.pending.delete(key);
      key = redirected;
    }
    this.store.setSetting(key, value);
    this.remember(key, value);
  }
  private remember(key: string, value: Delivery) {
    for (const [identity, row] of this.pendingByNotification)
      if (row.key === key) this.pendingByNotification.delete(identity);
    for (const [identity, row] of this.legacyByNotification)
      if (row.key === key) this.legacyByNotification.delete(identity);
    if (['queued', 'sending'].includes(value.status)) this.pending.set(key, value);
    else this.pending.delete(key);
    if (
      ['queued', 'sending'].includes(value.status) &&
      value.options.notificationId?.startsWith('telegram:dialog:')
    )
      this.pendingByNotification.set(
        digest([value.destination, notificationIdentity(value.options.notificationId)]),
        { key, value },
      );
    if (
      value.status !== 'cancelled' &&
      value.options.key?.startsWith('turn:') &&
      value.options.notificationId
    )
      this.legacyByNotification.set(
        digest([value.destination, notificationIdentity(value.options.notificationId)]),
        { key, value },
      );
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
  private notificationMessageId(value: Delivery) {
    const notificationId = value.options.notificationId;
    if (!notificationId?.startsWith('telegram:dialog:')) return;
    return notificationIdentity(notificationId).split(':').at(-1);
  }
  private loadRecoveryIndex(deliveries: Delivery[]) {
    const needed = new Set(
      deliveries
        .map((value) => this.notificationMessageId(value))
        .filter((id): id is string => !!id),
    );
    const groups = new Set(
      deliveries.map((value) => value.options.groupId).filter((id): id is string => !!id),
    );
    const legacyRuns = new Set(
      deliveries
        .map((value) => value.options.key)
        .filter((key): key is string => !!key?.startsWith('turn:'))
        .map((key) => key.slice(5)),
    );
    if (legacyRuns.size)
      for (const row of this.store.db.prepare('SELECT id,group_id FROM daddy_jobs').all())
        if (legacyRuns.has(String(row.id)) && typeof row.group_id === 'string')
          groups.add(row.group_id);
    const messages = this.store.db
      .prepare(
        "SELECT id,task_id,json_extract(data,'$.runId') AS runId FROM messages ORDER BY rowid",
      )
      .all()
      .map((row, index) => ({
        id: String(row.id),
        taskId: String(row.task_id),
        runId: typeof row.runId === 'string' ? row.runId : undefined,
        order: index + 1,
      }));
    for (const message of messages) if (needed.has(message.id)) groups.add(message.taskId);
    for (const message of messages) {
      if (!needed.has(message.id) && !groups.has(message.taskId)) continue;
      const { id, runId, order } = message;
      this.storedMessages.set(id, {
        id,
        ...(runId ? { runId } : {}),
        order,
      });
    }
    for (const row of this.store.db
      .prepare("SELECT id FROM notifications WHERE status='sent' AND id LIKE 'telegram:dialog:%'")
      .all()) {
      const identity = notificationIdentity(String(row.id));
      const parts = identity.split(':');
      const messageId = parts.at(-1);
      const message = messageId ? this.storedMessages.get(messageId) : undefined;
      if (!message?.runId) continue;
      const routeRun = parts.slice(0, 4).join(':') + ':' + message.runId;
      const delivered = this.deliveredByRouteRun.get(routeRun) ?? new Set<string>();
      delivered.add(message.id);
      this.deliveredByRouteRun.set(routeRun, delivered);
    }
  }
  private storedMessage(value: Delivery) {
    const id = this.notificationMessageId(value);
    return id ? this.storedMessages.get(id) : undefined;
  }
  private messageOrder(value: Delivery) {
    return this.storedMessage(value)?.order;
  }
  private hasDeliveredSibling(value: Delivery) {
    const message = this.storedMessage(value);
    if (!message?.runId) return false;
    const routeRun = `telegram:dialog:${value.destination.chatId}:${value.destination.threadId ?? 0}:${message.runId}`;
    const delivered = this.deliveredByRouteRun.get(routeRun);
    return !!delivered && (delivered.size > 1 || !delivered.has(message.id));
  }
  private messageBody(
    destination: TelegramDestination,
    content: Delivery['content'],
    chunks: ReturnType<typeof splitTelegramText>,
    index: number,
  ) {
    const chunk = chunks[index];
    return {
      chat_id: destination.chatId,
      text: chunk.text,
      entities: chunk.entities,
      link_preview_options: { is_disabled: true },
      reply_markup: {
        inline_keyboard:
          index === chunks.length - 1 ? ((content as TelegramCard).buttons ?? []) : [],
      },
    };
  }
  private acknowledgedPartsMatch(value: Delivery) {
    const chunks = splitTelegramText(value.content);
    return value.messages.every(
      (message, index) =>
        !!chunks[index] &&
        message.fingerprint ===
          digest(this.messageBody(value.destination, value.content, chunks, index)),
    );
  }
  private acknowledgedPartsMatchSibling(value: Delivery) {
    const message = this.storedMessage(value);
    if (!message?.runId || !value.messages.length) return false;
    for (const row of this.store.db
      .prepare(
        "SELECT data FROM messages WHERE json_extract(data,'$.runId')=? AND id<>? AND json_extract(data,'$.sender')='agent'",
      )
      .all(message.runId, message.id)) {
      const sibling = JSON.parse(String(row.data)) as { text: string };
      const contents = [
        new TelegramText().markdown(sibling.text),
        new TelegramText().add('👨‍💻 [daddy]', 'bold').add('\n\n').markdown(sibling.text),
      ];
      for (const content of contents) {
        const chunks = splitTelegramText(content);
        if (
          value.messages.every(
            (part, index) =>
              !!chunks[index] &&
              part.fingerprint ===
                digest(this.messageBody(value.destination, content, chunks, index)),
          )
        )
          return true;
      }
    }
    return false;
  }
  private inheritedPartsBelongToSibling(value: Delivery) {
    if (!value.options.key?.startsWith('turn:') || !this.hasDeliveredSibling(value)) return false;
    const allPartsAcknowledged = value.messages.length === splitTelegramText(value.content).length;
    return (
      this.acknowledgedPartsMatchSibling(value) && (value.attempts > 0 || allPartsAcknowledged)
    );
  }
  private receiptFor(messages: Delivery['messages'], value: Delivery) {
    if (!messages.length) return;
    let groupId = value.options.groupId;
    if (!groupId && value.options.key?.startsWith('turn:')) {
      const job = this.store.db
        .prepare('SELECT group_id FROM daddy_jobs WHERE id=?')
        .get(value.options.key.slice(5));
      if (typeof job?.group_id === 'string') groupId = job.group_id;
    }
    const receipt = {
      ...structuredClone(value),
      id: randomUUID(),
      options: { ...structuredClone(value.options), groupId },
      status: 'sent' as const,
      messages: structuredClone(messages),
      error: undefined,
    };
    return {
      key: prefix + digest([this.bot, 'receipt', value.destination, messages.map(({ id }) => id)]),
      value: receipt,
    };
  }
  private migrateByNotification(
    key: string,
    destination: TelegramDestination,
    notificationId: string,
    deliveryKey?: string,
    groupId?: string,
  ) {
    const legacyKey = digest([destination, notificationIdentity(notificationId)]);
    const row =
      this.pendingByNotification.get(legacyKey) ?? this.legacyByNotification.get(legacyKey);
    if (!row || row.key === key) return;
    if (row.value.status === 'sending') row.value.status = 'queued';
    let receipt: ReturnType<TelegramDelivery['receiptFor']>;
    if (row.value.options.key?.startsWith('turn:')) {
      const partsMatch = this.acknowledgedPartsMatch(row.value);
      if (!partsMatch || this.inheritedPartsBelongToSibling(row.value)) {
        receipt = this.receiptFor(row.value.messages, row.value);
        row.value.messages = [];
      }
    }
    row.value.options.key = deliveryKey;
    row.value.options.groupId = groupId ?? row.value.options.groupId;
    this.store.transaction(() => {
      if (receipt) this.store.setSetting(receipt.key, receipt.value);
      this.store.setSetting(key, row.value);
      this.store.db.prepare('DELETE FROM settings WHERE key=?').run(row.key);
    });
    this.pending.delete(row.key);
    this.deferredKeys.delete(row.key);
    const wasHistory = this.historyDeferredKeys.delete(row.key);
    this.deferredValues.delete(row.key);
    this.pendingByNotification.delete(legacyKey);
    this.legacyByNotification.delete(legacyKey);
    this.redirectedKeys.set(row.key, key);
    this.remember(key, row.value);
    if (wasHistory) this.releaseUnblocked(row.value.destination);
    return row.value;
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
  hasAcknowledgedParts(destination: TelegramDestination, notificationId: string) {
    const key = digest([destination, notificationIdentity(notificationId)]);
    return this.acknowledgedCurrent.has(key);
  }
  private createDelivery(
    destination: TelegramDestination,
    content: Delivery['content'],
    options: DeliveryOptions,
  ): Delivery {
    const value: Delivery = {
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
    value.recoveryOrder = this.messageOrder(value);
    return value;
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
    let key = prefix + digest([this.bot, destination, options.key ?? randomUUID()]);
    key = this.resolveKey(key);
    let value = this.pending.get(key) ?? this.store.setting<Delivery>(key);
    if (!value && options.notificationId?.startsWith('telegram:dialog:'))
      value = this.migrateByNotification(
        key,
        destination,
        options.notificationId,
        options.key,
        options.groupId,
      );
    if (value && this.deferredKeys.has(key)) {
      this.activateDeferred(key, value);
    }
    if (value) {
      if (
        (value.options.final && !options.final) ||
        (options.order && value.options.order && options.order < value.options.order)
      )
        return { status: 'superseded', deliveryId: value.id };
      if (!options.replace && !(options.replacePending && value.status !== 'sent'))
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
    if (!this.recovering && !this.running && !this.stopped) await this.flush(1);
    else if (!this.recovering && this.running && !this.stopped)
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
          .sort((a, b) => {
            const pinOrder =
              Number(a[1].options.operation === 'pin') - Number(b[1].options.operation === 'pin');
            if (pinOrder) return pinOrder;
            return this.compareDeliveries(a[1], b[1]);
          })
          .filter(([key, value]) => {
            if (!isIndependent(value) && this.hasEarlierDeferred(value)) return false;
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
        const body = this.messageBody(value.destination, content, chunks, i);
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
