import { reminderOpen, type OwnerQuestion } from './telegram-reminders.js';
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
  reminder?: OwnerQuestion;
  mention?: OwnerQuestion;
  questionSourceKey?: string;
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
  cancelledForRoute?: boolean;
  cancelledForQuestion?: boolean;
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
const isSeparateQuestion = ({ options }: Delivery) =>
  !!options.mention ||
  (!!options.replacePending && !!options.final && !options.replace) ||
  (!!options.final &&
    !!options.notificationId?.endsWith(':final') &&
    options.key === options.notificationId);
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
  private legacyIdentityByKey = new Map<string, string>();
  private pendingIdentityByKey = new Map<string, string>();
  private redirectedKeys = new Map<string, string>();
  private deferredKeys = new Set<string>();
  private historyDeferredKeys = new Set<string>();
  private deferredValues = new Map<string, Delivery>();
  private retainedDeferredKeys = new Set<string>();
  private storedMessages = new Map<
    string,
    {
      id: string;
      taskId: string;
      runId?: string;
      order: number;
      sender?: string;
      phase?: string;
      needsReply: boolean;
    }
  >();
  private storedTaskGroups = new Map<string, string>();
  private deliveredByRouteRun = new Map<string, Set<string>>();
  private sentNotifications = new Set<string>();
  private cancelledRouteNotifications = new Set<string>();
  private cancelledQuestionNotifications = new Set<string>();
  private detachedQuestionSources = new Map<string, string>();
  private storedQuestionSources = new Map<string, string>();
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
    const unboundProgress = deliveries.filter(
      ({ value }) =>
        !value.options.groupId &&
        (value.options.key?.startsWith('progress:') || value.options.operation === 'pin'),
    );
    if (unboundProgress.length) {
      const progressGroups = new Map<string, string>();
      for (const row of store.db
        .prepare("SELECT key,value FROM settings WHERE key LIKE 'telegram.progress:%'")
        .all()) {
        const parsed = JSON.parse(String(row.value)) as {
          id?: string;
          cards?: { id?: string }[];
        };
        const cards = Array.isArray(parsed.cards) ? parsed.cards : [parsed];
        const groupId = String(row.key).split(':').at(-1)!;
        for (const card of cards) if (card.id) progressGroups.set(card.id, groupId);
      }
      for (const { key, value } of deliveries) {
        const cardId = value.options.key?.startsWith('progress:')
          ? value.options.key.slice('progress:'.length)
          : undefined;
        const groupId = cardId ? progressGroups.get(cardId) : undefined;
        if (groupId && !value.options.groupId) {
          value.options.groupId = groupId;
          store.setSetting(key, value);
        }
      }
      const messageGroups = new Map<string, string>();
      for (const { value } of deliveries)
        if (value.options.groupId && value.options.key?.startsWith('progress:'))
          for (const message of value.messages)
            messageGroups.set(`${value.destination.chatId}:${message.id}`, value.options.groupId);
      for (const { key, value } of deliveries) {
        const groupId = value.options.pinMessageId
          ? messageGroups.get(`${value.destination.chatId}:${value.options.pinMessageId}`)
          : undefined;
        if (groupId && !value.options.groupId) {
          value.options.groupId = groupId;
          store.setSetting(key, value);
        }
      }
      const orphanStatusMessages = new Set<string>();
      for (const { value } of deliveries)
        if (!value.options.groupId && value.options.key?.startsWith('progress:'))
          for (const message of value.messages)
            orphanStatusMessages.add(`${value.destination.chatId}:${message.id}`);
      for (const { key, value } of unboundProgress)
        if (
          !value.options.groupId &&
          ['queued', 'sending'].includes(value.status) &&
          (value.options.key?.startsWith('progress:') ||
            (!!value.options.pinMessageId &&
              orphanStatusMessages.has(
                `${value.destination.chatId}:${value.options.pinMessageId}`,
              )))
        ) {
          value.status = 'cancelled';
          store.setSetting(key, value);
        }
    }
    const recoveryDeliveries = deliveries.filter(
      ({ value }) =>
        ['queued', 'sending'].includes(value.status) &&
        value.options.notificationId?.startsWith('telegram:dialog:'),
    );
    if (recoveryDeliveries.length)
      this.loadRecoveryIndex(recoveryDeliveries.map(({ value }) => value));
    const queuedDialogs = new Map<string, { key: string; value: Delivery }[]>();
    for (const row of deliveries) {
      const notificationId = row.value.options.notificationId;
      if (
        !['queued', 'sending'].includes(row.value.status) ||
        !notificationId?.startsWith('telegram:dialog:')
      )
        continue;
      const identity = digest([row.value.destination, notificationIdentity(notificationId)]);
      const rows = queuedDialogs.get(identity) ?? [];
      rows.push(row);
      queuedDialogs.set(identity, rows);
    }
    for (const rows of queuedDialogs.values()) {
      const question = rows.find(({ value }) => this.isQuestionDelivery(value));
      if (!question) continue;
      const sources = rows
        .filter(
          ({ key, value }) =>
            key !== question.key &&
            (value.options.key?.startsWith('message:') || value.options.key?.startsWith('turn:')),
        )
        .sort(
          (a, b) =>
            b.value.messages.length - a.value.messages.length ||
            Number(!!b.value.options.key?.startsWith('message:')) -
              Number(!!a.value.options.key?.startsWith('message:')),
        );
      if (!sources.length) continue;
      question.value.options.questionSourceKey ??= sources[0].key;
      store.setSetting(question.key, question.value);
      for (const source of sources) {
        source.value.revision++;
        source.value.status = 'cancelled';
        source.value.cancelledForRoute = undefined;
        source.value.cancelledForQuestion = undefined;
        store.setSetting(source.key, source.value);
      }
    }
    const deliveryKeys = new Set(deliveries.map(({ key }) => key));
    const sourceIdentities = new Set(
      deliveries
        .filter(
          ({ value }) =>
            ['queued', 'sending'].includes(value.status) &&
            this.isQuestionDelivery(value) &&
            !value.options.questionSourceKey &&
            !!value.options.notificationId,
        )
        .map(({ value }) =>
          digest([value.destination, notificationIdentity(value.options.notificationId!)]),
        ),
    );
    for (const { key, value } of deliveries) {
      if (
        !sourceIdentities.size ||
        !value.messages.length ||
        !value.options.notificationId ||
        (!value.options.key?.startsWith('message:') && !value.options.key?.startsWith('turn:'))
      )
        continue;
      const identity = digest([
        value.destination,
        notificationIdentity(value.options.notificationId),
      ]);
      if (!sourceIdentities.has(identity)) continue;
      const existing = this.storedQuestionSources.get(identity);
      if (!existing || value.options.key.startsWith('message:'))
        this.storedQuestionSources.set(identity, key);
    }
    const deliveredNotifications = new Set(
      deliveries
        .filter(({ value }) => value.status === 'sent' && !!value.options.notificationId)
        .map(({ value }) => value.options.notificationId!),
    );
    const acknowledgedNotifications = deliveries.filter(
      ({ value }) =>
        ['queued', 'sending'].includes(value.status) &&
        !!value.options.notificationId &&
        this.fullyAcknowledged(value),
    );
    if (acknowledgedNotifications.length) {
      const sentNotification = store.db.prepare(
        "SELECT 1 FROM notifications WHERE id=? AND status='sent'",
      );
      for (const { value } of acknowledgedNotifications) {
        const notificationId = value.options.notificationId;
        if (notificationId && sentNotification.get(notificationId))
          deliveredNotifications.add(notificationId);
      }
    }
    const questionTasks = new Set(
      deliveries
        .filter(
          ({ value }) =>
            ['queued', 'sending'].includes(value.status) &&
            !value.options.reminder &&
            !value.options.groupId,
        )
        .map(({ value }) => /^telegram:question:[^:]+:([^:]+):/.exec(value.options.key ?? '')?.[1])
        .filter((id): id is string => !!id),
    );
    if (questionTasks.size) {
      const taskGroup = store.db.prepare(
        "SELECT json_extract(data,'$.groupId') AS groupId FROM tasks WHERE id=?",
      );
      for (const taskId of questionTasks) {
        const groupId = taskGroup.get(taskId)?.groupId;
        if (typeof groupId === 'string') this.storedTaskGroups.set(taskId, groupId);
      }
    }
    const deletedGroups = new Set(
      store
        .groups()
        .filter((group) => !!group.deletedAt)
        .map((group) => group.id),
    );
    const legacyGroups = new Map<string, string>();
    if (deletedGroups.size)
      for (const row of store.db.prepare('SELECT id,group_id FROM daddy_jobs').all())
        if (typeof row.group_id === 'string') legacyGroups.set(String(row.id), row.group_id);
    this.recovering = recoveryDeliveries.some(
      ({ value }) => this.storedMessage(value) !== undefined,
    );
    for (const [queueOrder, { key, value }] of deliveries.entries()) {
      this.lastCreatedAt = Math.max(this.lastCreatedAt, Number(value.createdAt) || 0);
      value.recoveryOrder = this.messageOrder(value);
      value.queueOrder = queueOrder;
      if (
        ['queued', 'sending'].includes(value.status) &&
        this.restoreQuestionOptions(key, value, deliveryKeys)
      )
        this.store.setSetting(key, value);
      if (
        value.status === 'cancelled' &&
        value.cancelledForRoute &&
        value.options.notificationId &&
        !deliveredNotifications.has(value.options.notificationId)
      )
        this.cancelledRouteNotifications.add(value.options.notificationId);
      if (
        value.status === 'cancelled' &&
        value.cancelledForQuestion &&
        value.options.notificationId &&
        !deliveredNotifications.has(value.options.notificationId)
      )
        this.cancelledQuestionNotifications.add(value.options.notificationId);
      const restoreThroughHistory =
        value.options.notificationId?.startsWith('telegram:dialog:') &&
        this.storedMessage(value) !== undefined;
      if (['queued', 'sending'].includes(value.status)) {
        value.status = 'queued';
        const groupId =
          value.options.groupId ??
          (value.options.key?.startsWith('turn:')
            ? legacyGroups.get(value.options.key.slice(5))
            : undefined);
        if (groupId && deletedGroups.has(groupId)) {
          value.status = 'cancelled';
          this.store.setSetting(key, value);
          continue;
        }
        if (
          value.options.notificationId &&
          (this.sentNotifications.has(value.options.notificationId) ||
            deliveredNotifications.has(value.options.notificationId)) &&
          this.fullyAcknowledged(value)
        ) {
          value.status = 'sent';
          value.attempts = 0;
          value.error = undefined;
          this.store.setSetting(key, value);
          continue;
        }
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
        this.indexLegacyNotification(key, value);
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
        this.indexPendingNotification(key, value);
    }
    this.storedQuestionSources.clear();
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
    if (!this.recovering && !this.deferredKeys.size) return;
    this.recovering = false;
    this.retainedDeferredKeys.clear();
    for (const value of [...this.deferredValues.values()]) this.releaseUnblocked(value.destination);
    await this.flush();
  }
  needsRecovery() {
    return this.recovering || this.deferredKeys.size > 0;
  }
  beginRecoveryAttempt() {
    this.retainedDeferredKeys.clear();
  }
  retainDeferred(destination: TelegramDestination, notificationId: string) {
    const identity = digest([destination, notificationIdentity(notificationId)]);
    const row = this.pendingByNotification.get(identity) ?? this.legacyByNotification.get(identity);
    if (row && this.historyDeferredKeys.has(row.key)) this.retainedDeferredKeys.add(row.key);
  }
  private deliveryGroupId(value: Delivery) {
    if (value.options.groupId) return value.options.groupId;
    if (!value.options.key?.startsWith('turn:')) return;
    const job = this.store.db
      .prepare('SELECT group_id FROM daddy_jobs WHERE id=?')
      .get(value.options.key.slice(5));
    return typeof job?.group_id === 'string' ? job.group_id : undefined;
  }
  discardDeferred(destination: TelegramDestination, notificationId: string, flush = true) {
    const identity = digest([destination, notificationIdentity(notificationId)]);
    const row = this.pendingByNotification.get(identity) ?? this.legacyByNotification.get(identity);
    if (!row || !this.deferredKeys.has(row.key)) return;
    this.cancel(row.key, row.value);
    this.releaseUnblocked(row.value.destination);
    if (flush) void this.flush();
  }
  private cancel(key: string, value: Delivery, forRoute = false) {
    this.historyDeferredKeys.delete(key);
    this.deferredKeys.delete(key);
    this.deferredValues.delete(key);
    this.retainedDeferredKeys.delete(key);
    value.revision++;
    value.status = 'cancelled';
    value.cancelledForRoute = forRoute || undefined;
    value.cancelledForQuestion = undefined;
    if (forRoute && value.options.notificationId)
      this.cancelledRouteNotifications.add(value.options.notificationId);
    if (value.options.notificationId)
      this.store.db
        .prepare("UPDATE notifications SET status='superseded' WHERE id=? AND status!='sent'")
        .run(value.options.notificationId);
    this.save(key, value);
  }
  discardGroup(groupId: string) {
    const routes = new Map<string, TelegramDestination>();
    const values = new Map([...this.pending, ...this.deferredValues]);
    for (const [key, value] of values)
      if (this.deliveryGroupId(value) === groupId) {
        routes.set(this.route(value.destination), value.destination);
        if (value.options.operation === 'pin') this.clearPinError(value.error);
        this.cancel(key, value);
      }
    for (const destination of routes.values()) this.releaseUnblocked(destination);
    if (routes.size) void this.flush();
  }
  reconcileGroupRoute(groupId: string, destination: TelegramDestination) {
    const released = new Map<string, TelegramDestination>();
    const values = new Map([...this.pending, ...this.deferredValues]);
    for (const [key, value] of values) {
      if (
        this.deliveryGroupId(value) !== groupId ||
        this.route(value.destination) === this.route(destination)
      )
        continue;
      released.set(this.route(value.destination), value.destination);
      this.cancel(key, value, true);
    }
    for (const previous of released.values()) this.releaseUnblocked(previous);
    if (released.size) void this.flush();
  }
  private route(destination: TelegramDestination) {
    return digest(destination);
  }
  private obsolete(value: Delivery, revision: number) {
    return value.status === 'cancelled' || value.revision !== revision;
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
  private forgetNotificationIndexes(key: string) {
    const pendingIdentity = this.pendingIdentityByKey.get(key);
    if (pendingIdentity) this.pendingByNotification.delete(pendingIdentity);
    this.pendingIdentityByKey.delete(key);
    const legacyIdentity = this.legacyIdentityByKey.get(key);
    if (legacyIdentity) this.legacyByNotification.delete(legacyIdentity);
    this.legacyIdentityByKey.delete(key);
  }
  private indexPendingNotification(key: string, value: Delivery) {
    const notificationId = value.options.notificationId;
    if (!notificationId) return;
    const identity = digest([value.destination, notificationIdentity(notificationId)]);
    const previous = this.pendingByNotification.get(identity);
    if (previous && previous.key !== key) this.pendingIdentityByKey.delete(previous.key);
    this.pendingByNotification.set(identity, { key, value });
    this.pendingIdentityByKey.set(key, identity);
  }
  private indexLegacyNotification(key: string, value: Delivery) {
    const notificationId = value.options.notificationId;
    if (!notificationId) return;
    const identity = digest([value.destination, notificationIdentity(notificationId)]);
    const previous = this.legacyByNotification.get(identity);
    if (previous && previous.key !== key) this.legacyIdentityByKey.delete(previous.key);
    this.legacyByNotification.set(identity, { key, value });
    this.legacyIdentityByKey.set(key, identity);
  }
  private remember(key: string, value: Delivery) {
    this.forgetNotificationIndexes(key);
    if (['queued', 'sending'].includes(value.status)) this.pending.set(key, value);
    else this.pending.delete(key);
    if (
      ['queued', 'sending'].includes(value.status) &&
      value.options.notificationId?.startsWith('telegram:dialog:')
    )
      this.indexPendingNotification(key, value);
    if (
      value.status !== 'cancelled' &&
      value.options.key?.startsWith('turn:') &&
      value.options.notificationId
    )
      this.indexLegacyNotification(key, value);
  }
  private createdAt() {
    this.lastCreatedAt = Math.max(this.clock(), this.lastCreatedAt + 1);
    return this.lastCreatedAt;
  }
  private routeValid(value: Delivery) {
    const pair = this.store.setting<{ chatId: number; userId: number }>('telegram.pairing');
    const room = this.store.setting<{ chatId: number; ownerId: number }>('telegram.group');
    if (value.ownerId !== pair?.userId) return false;
    return (
      !pair ||
      value.destination.chatId === pair.chatId ||
      (value.destination.chatId === room?.chatId && room.ownerId === pair.userId)
    );
  }
  private valid(value: Delivery) {
    return (
      this.routeValid(value) &&
      this.groupValid(value) &&
      (!value.options.reminder || reminderOpen(this.store, value.options.reminder))
    );
  }
  private groupValid(value: Delivery) {
    const groupId = value.options.groupId;
    if (!groupId) return true;
    const row = this.store.db
      .prepare("SELECT json_extract(data,'$.deletedAt') AS deletedAt FROM review_groups WHERE id=?")
      .get(groupId);
    return !row || !row.deletedAt;
  }
  private isQuestionDelivery(value: Delivery) {
    if (value.options.key?.startsWith('message:') || value.options.key?.startsWith('turn:'))
      return false;
    if (isSeparateQuestion(value)) return true;
    if (!value.options.notificationId || value.options.key !== value.options.notificationId)
      return false;
    const message = this.storedMessage(value);
    return message?.sender === 'agent' && message.phase === 'final' && message.needsReply;
  }
  private restoreQuestionOptions(key: string, value: Delivery, deliveryKeys: Set<string>) {
    let changed = false;
    const deliveryKey = value.options.key;
    if (!value.options.reminder && deliveryKey?.startsWith('telegram:question:')) {
      const match = /^telegram:question:[^:]+:([^:]+):(.*)$/.exec(deliveryKey);
      if (match) {
        const groupId = value.options.groupId ?? this.storedTaskGroups.get(match[1]);
        if (groupId) {
          value.options.groupId = value.options.groupId ?? groupId;
          value.options.reminder = {
            groupId,
            taskId: match[1],
            request: match[2],
          };
          changed = true;
        }
      }
    }
    const messageId = this.notificationMessageId(value);
    if (!value.options.mention && messageId) {
      const message = this.storedMessages.get(messageId);
      if (message) {
        if (message.sender === 'agent' && message.phase === 'final' && message.needsReply) {
          const groupId = value.options.groupId ?? message.taskId;
          value.options.groupId = groupId;
          value.options.mention = { groupId, messageId };
          changed = true;
        }
      }
    }
    if (
      messageId &&
      value.options.mention &&
      !value.options.questionSourceKey &&
      value.options.key !== `message:${messageId}`
    ) {
      const messageSourceKey =
        prefix + digest([this.bot, value.destination, `message:${messageId}`]);
      const identity = value.options.notificationId
        ? digest([value.destination, notificationIdentity(value.options.notificationId)])
        : undefined;
      const sourceKey = deliveryKeys.has(messageSourceKey)
        ? messageSourceKey
        : identity
          ? this.storedQuestionSources.get(identity)
          : undefined;
      if (sourceKey && sourceKey !== key) {
        value.options.questionSourceKey = sourceKey;
        changed = true;
      }
    }
    return changed;
  }
  private restoreQuestionReceipt(value: Delivery) {
    const key = value.options.questionSourceKey;
    if (!key || value.messages.length) return;
    const source = this.store.setting<Delivery>(key);
    if (
      !source?.messages.length ||
      source.bot !== value.bot ||
      source.ownerId !== value.ownerId ||
      this.route(source.destination) !== this.route(value.destination) ||
      !value.options.notificationId ||
      !source.options.notificationId ||
      notificationIdentity(source.options.notificationId) !==
        notificationIdentity(value.options.notificationId)
    )
      return;
    const inherited = this.inheritedPartsBelongToSibling(source);
    const fullyCurrent = source.status === 'sent' && this.fullyAcknowledged(source);
    if (inherited && !fullyCurrent) return;
    value.messages = structuredClone(this.matchingAcknowledgedParts(value, source.messages));
  }
  private removeStaleMention(value: Delivery) {
    const mention = value.options.mention;
    if (mention) {
      if (reminderOpen(this.store, mention) || !('messageId' in mention)) return;
      const message = this.store.messageById(mention.groupId, mention.messageId);
      if (!message || message.sender !== 'agent') return;
      value.content = new TelegramText()
        .add('👨‍💻 [daddy]', 'bold')
        .add('\n\n')
        .markdown(message.text);
      value.options.mention = undefined;
      value.revision++;
    }
    // Replay can pick the ordinary message before the delivery worker ever sees a mention.
    if (value.options.questionSourceKey) {
      this.restoreQuestionReceipt(value);
      value.options.questionSourceKey = undefined;
    }
  }
  private notificationMessageId(value: Delivery) {
    const notificationId = value.options.notificationId;
    if (!notificationId?.startsWith('telegram:dialog:')) return;
    return notificationIdentity(notificationId).split(':').at(-1);
  }
  private loadRecoveryIndex(deliveries: Delivery[]) {
    const neededNotifications = new Set(
      deliveries.map((value) => value.options.notificationId).filter((id): id is string => !!id),
    );
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
        `SELECT id,task_id,json_extract(data,'$.runId') AS runId,
                json_extract(data,'$.sender') AS sender,
                json_extract(data,'$.phase') AS phase,
                json_extract(data,'$.needsReply') AS needsReply
         FROM messages ORDER BY rowid`,
      )
      .all()
      .map((row, index) => ({
        id: String(row.id),
        taskId: String(row.task_id),
        runId: typeof row.runId === 'string' ? row.runId : undefined,
        sender: typeof row.sender === 'string' ? row.sender : undefined,
        phase: typeof row.phase === 'string' ? row.phase : undefined,
        needsReply: !!row.needsReply,
        order: index + 1,
      }));
    for (const message of messages) if (needed.has(message.id)) groups.add(message.taskId);
    for (const message of messages) {
      if (!needed.has(message.id) && !groups.has(message.taskId)) continue;
      const { id, taskId, runId, order, sender, phase, needsReply } = message;
      this.storedMessages.set(id, {
        id,
        taskId,
        ...(runId ? { runId } : {}),
        ...(sender ? { sender } : {}),
        ...(phase ? { phase } : {}),
        needsReply,
        order,
      });
    }
    for (const row of this.store.db
      .prepare("SELECT id FROM notifications WHERE status='sent' AND id LIKE 'telegram:dialog:%'")
      .all()) {
      const notificationId = String(row.id);
      if (neededNotifications.has(notificationId)) this.sentNotifications.add(notificationId);
      const identity = notificationIdentity(notificationId);
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
  private latestDeliveredSibling(value: Delivery) {
    const message = this.storedMessage(value);
    if (!message?.runId) return;
    const routeRun = `telegram:dialog:${value.destination.chatId}:${value.destination.threadId ?? 0}:${message.runId}`;
    const delivered = this.deliveredByRouteRun.get(routeRun);
    if (!delivered) return;
    return [...delivered]
      .filter((id) => id !== message.id)
      .map((id) => this.storedMessages.get(id))
      .filter((entry): entry is NonNullable<typeof entry> => !!entry)
      .sort((a, b) => b.order - a.order)[0];
  }
  private hasDeliveredSibling(value: Delivery) {
    return this.latestDeliveredSibling(value) !== undefined;
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
  private matchingAcknowledgedParts(value: Delivery, messages = value.messages) {
    const chunks = splitTelegramText(value.content);
    const matching: Delivery['messages'] = [];
    for (const [index, message] of messages.entries()) {
      if (
        !chunks[index] ||
        message.fingerprint !==
          digest(this.messageBody(value.destination, value.content, chunks, index))
      )
        break;
      matching.push(message);
    }
    return matching;
  }
  private ownedAcknowledgedParts(value: Delivery) {
    const matching = this.matchingAcknowledgedParts(value);
    if (!matching.length) return matching;
    const fullyCurrent =
      value.status === 'sent' &&
      matching.length === value.messages.length &&
      matching.length === splitTelegramText(value.content).length;
    if (value.options.key?.startsWith('turn:') && this.inheritedPartsBelongToSibling(value))
      return fullyCurrent ? matching : [];
    return matching;
  }
  private fullyAcknowledged(value: Delivery) {
    return (
      value.messages.length === splitTelegramText(value.content).length &&
      this.acknowledgedPartsMatch(value)
    );
  }
  private acknowledgedPartsMatchSibling(value: Delivery) {
    const delivered = this.latestDeliveredSibling(value);
    if (!delivered || !value.messages.length) return false;
    const row = this.store.db.prepare('SELECT data FROM messages WHERE id=?').get(delivered.id);
    if (!row) return false;
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
    return false;
  }
  private inheritedPartsBelongToSibling(value: Delivery) {
    if (!value.options.key?.startsWith('turn:') || !this.hasDeliveredSibling(value)) return false;
    if (!this.acknowledgedPartsMatchSibling(value)) return false;
    return true;
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
  private sentDelivery(destination: TelegramDestination, notificationId: string) {
    const messageId = notificationIdentity(notificationId).split(':').at(-1);
    if (!messageId) return;
    const message = this.store.db
      .prepare("SELECT json_extract(data,'$.runId') AS runId FROM messages WHERE id=?")
      .get(messageId);
    if (typeof message?.runId !== 'string') return;
    const key = prefix + digest([this.bot, destination, `turn:${message.runId}`]);
    const value = this.store.setting<Delivery>(key);
    if (
      value?.status === 'sent' &&
      value.options.notificationId &&
      notificationIdentity(value.options.notificationId) === notificationIdentity(notificationId)
    )
      return { key, value };
  }
  private questionSource(destination: TelegramDestination, notificationId: string) {
    const messageId = notificationIdentity(notificationId).split(':').at(-1);
    if (messageId) {
      const key = prefix + digest([this.bot, destination, `message:${messageId}`]);
      const value = this.store.setting<Delivery>(key);
      if (value?.messages.length) return { key, value };
    }
    return this.sentDelivery(destination, notificationId);
  }
  private migrateByNotification(
    key: string,
    destination: TelegramDestination,
    notificationId: string,
    deliveryKey?: string,
    groupId?: string,
    includeSent = true,
  ) {
    const legacyKey = digest([destination, notificationIdentity(notificationId)]);
    const row =
      this.pendingByNotification.get(legacyKey) ??
      this.legacyByNotification.get(legacyKey) ??
      (includeSent ? this.sentDelivery(destination, notificationId) : undefined);
    if (!row || row.key === key) return;
    if (!includeSent && (row.value.messages.length || row.value.status === 'sending')) {
      this.detachedQuestionSources.set(key, row.key);
      const receipt = this.receiptFor(row.value.messages, row.value);
      row.value.revision++;
      row.value.status = 'cancelled';
      row.value.cancelledForRoute = undefined;
      row.value.cancelledForQuestion = undefined;
      this.store.transaction(() => {
        if (receipt) this.store.setSetting(receipt.key, receipt.value);
        this.store.setSetting(row.key, row.value);
      });
      this.pending.delete(row.key);
      this.deferredKeys.delete(row.key);
      this.historyDeferredKeys.delete(row.key);
      this.deferredValues.delete(row.key);
      this.retainedDeferredKeys.delete(row.key);
      this.remember(row.key, row.value);
      this.releaseUnblocked(row.value.destination);
      return;
    }
    if (row.value.status === 'sending') row.value.status = 'queued';
    let receipt: ReturnType<TelegramDelivery['receiptFor']>;
    if (row.value.options.key?.startsWith('turn:')) {
      const acknowledged = this.ownedAcknowledgedParts(row.value);
      if (acknowledged.length !== row.value.messages.length) {
        receipt = this.receiptFor(row.value.messages, row.value);
        row.value.messages = acknowledged;
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
    this.forgetNotificationIndexes(row.key);
    this.redirectedKeys.set(row.key, key);
    this.remember(key, row.value);
    if (wasHistory) this.releaseUnblocked(row.value.destination);
    return row.value;
  }
  private messageDelivery(destination: TelegramDestination, notificationId: string) {
    const messageId = notificationIdentity(notificationId).split(':').at(-1);
    if (!messageId) return;
    const key = prefix + digest([this.bot, destination, `message:${messageId}`]);
    const value =
      this.pending.get(key) ?? this.deferredValues.get(key) ?? this.store.setting<Delivery>(key);
    return value ? { key, value } : undefined;
  }
  hasAcknowledgedMessage(destination: TelegramDestination, notificationId: string) {
    const message = this.messageDelivery(destination, notificationId);
    if (message && this.ownedAcknowledgedParts(message.value).length) return true;
    const identity = digest([destination, notificationIdentity(notificationId)]);
    const question =
      this.pendingByNotification.get(identity) ?? this.legacyByNotification.get(identity);
    return !!question && this.ownedAcknowledgedParts(question.value).length > 0;
  }
  private notificationWasSent(notificationId: string) {
    return !!this.store.db
      .prepare('SELECT 1 FROM notifications WHERE id=? AND status=?')
      .get(notificationId, 'sent');
  }
  canReactivate(destination: TelegramDestination, deliveryKey: string, notificationId: string) {
    destination = {
      chatId: destination.chatId,
      ...(destination.threadId === undefined ? {} : { threadId: destination.threadId }),
    };
    const key = prefix + digest([this.bot, destination, deliveryKey]);
    const value = this.store.setting<Delivery>(key);
    if (value?.status === 'cancelled' && (value.cancelledForRoute || value.cancelledForQuestion))
      return true;
    return (
      this.cancelledRouteNotifications.has(notificationId) ||
      this.cancelledQuestionNotifications.has(notificationId)
    );
  }
  canReactivateNotification(notificationId: string) {
    return (
      this.cancelledRouteNotifications.has(notificationId) ||
      this.cancelledQuestionNotifications.has(notificationId)
    );
  }
  private clearCancelledNotification(notificationId?: string) {
    if (!notificationId) return;
    this.cancelledRouteNotifications.delete(notificationId);
    this.cancelledQuestionNotifications.delete(notificationId);
  }
  private alternatePending(key: string, destination: TelegramDestination, notificationId: string) {
    const identity = digest([destination, notificationIdentity(notificationId)]);
    const row = this.pendingByNotification.get(identity) ?? this.legacyByNotification.get(identity);
    return !row || row.key === key ? undefined : row;
  }
  private cancelAlternatePending(
    key: string,
    destination: TelegramDestination,
    notificationId: string,
  ) {
    const row = this.alternatePending(key, destination, notificationId);
    if (!row) return;
    this.cancel(row.key, row.value);
    this.releaseUnblocked(row.value.destination);
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
  private async kick() {
    if (!this.recovering && !this.running && !this.stopped) await this.flush(1);
    else if (!this.recovering && this.running && !this.stopped)
      void this.running.then(() => {
        if (!this.stopped) return this.flush(1);
      });
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
  private enqueuePin(destination: TelegramDestination, messageId: number, groupId?: string) {
    const key = prefix + digest([this.bot, 'pin', destination.chatId, messageId]);
    if (this.pending.has(key)) return;
    const existing = this.store.setting<Delivery>(key);
    if (existing) {
      if (existing.status !== 'cancelled' || !existing.cancelledForRoute) return;
      existing.revision++;
      existing.status = 'queued';
      existing.cancelledForRoute = undefined;
      existing.error = undefined;
      existing.nextAttemptAt = this.clock();
      this.save(key, existing);
      return;
    }
    this.save(
      key,
      this.createDelivery(
        destination,
        { text: '', entities: [] },
        { operation: 'pin', pinMessageId: messageId, groupId },
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
    let value =
      this.pending.get(key) ?? this.deferredValues.get(key) ?? this.store.setting<Delivery>(key);
    if (
      !value &&
      !options.replace &&
      !options.questionSourceKey &&
      options.notificationId?.startsWith('telegram:dialog:')
    ) {
      const source = this.questionSource(destination, options.notificationId);
      if (source) options = { ...options, questionSourceKey: source.key };
    }
    if (!value && options.notificationId?.startsWith('telegram:dialog:'))
      value = this.migrateByNotification(
        key,
        destination,
        options.notificationId,
        options.key,
        options.groupId,
        !!options.replace,
      );
    if (!value && !options.questionSourceKey) {
      const questionSourceKey = this.detachedQuestionSources.get(key);
      if (questionSourceKey) {
        options = { ...options, questionSourceKey };
        this.detachedQuestionSources.delete(key);
      }
    }
    if (value && options.replace && options.notificationId?.startsWith('telegram:dialog:')) {
      const alternate = this.alternatePending(key, destination, options.notificationId);
      if (alternate?.value.messages.length) {
        key = alternate.key;
        value = alternate.value;
      } else if (value.status === 'cancelled' || (value.status === 'sent' && options.final))
        this.cancelAlternatePending(key, destination, options.notificationId);
    }
    if (
      value?.status === 'cancelled' &&
      (value.cancelledForRoute ||
        value.cancelledForQuestion ||
        (!!options.replace &&
          !!options.notificationId?.startsWith('telegram:dialog:') &&
          !this.notificationWasSent(options.notificationId)))
    ) {
      value.revision++;
      value.status = 'queued';
      value.cancelledForRoute = undefined;
      value.cancelledForQuestion = undefined;
      this.save(key, value);
    }
    if (value && this.deferredKeys.has(key)) {
      this.activateDeferred(key, value);
    }
    if (value) {
      if (
        (value.options.final && !options.final) ||
        (options.order && value.options.order && options.order < value.options.order)
      )
        return { status: 'superseded', deliveryId: value.id };
      this.clearCancelledNotification(options.notificationId);
      if (
        value.status !== 'sent' &&
        options.reminder &&
        (!value.options.reminder || digest(value.options.reminder) !== digest(options.reminder))
      ) {
        value.options = {
          ...value.options,
          groupId: options.groupId ?? value.options.groupId,
          reminder: structuredClone(options.reminder),
        };
        value.revision++;
        value.status = 'queued';
        this.save(key, value);
      }
      if (!options.replace && !(options.replacePending && value.status !== 'sent')) {
        if (value.status === 'queued') await this.kick();
        return { status: value.status === 'sent' ? 'sent' : 'queued', deliveryId: value.id };
      }
      if (
        digest([value.content, value.options.final, value.options.pin]) ===
        digest([content, options.final, options.pin])
      ) {
        if (value.status === 'sent' && options.pin && value.messages[0])
          this.enqueuePin(value.destination, value.messages[0].id, options.groupId);
        await this.kick();
        return { status: value.status === 'sent' ? 'sent' : 'queued', deliveryId: value.id };
      }
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
        questionSourceKey: options.questionSourceKey ?? value.options.questionSourceKey,
        deletePrevious: value.options.deletePrevious ?? options.deletePrevious,
      };
      value.revision++;
      value.status = 'queued';
      value.cancelledForRoute = undefined;
      value.cancelledForQuestion = undefined;
      value.nextAttemptAt = this.clock();
    } else value = this.createDelivery(destination, content, options);
    this.save(key, value);
    this.clearCancelledNotification(options.notificationId);
    // A new reply may wake one delayed predecessor, but never rewrite a ready backlog
    // or bypass the route-wide retry_after.
    const currentTime = this.clock();
    if (currentTime >= this.rateLimitUntil) {
      const delayed = [...this.pending.entries()]
        .filter(
          ([otherKey, other]) =>
            otherKey !== key &&
            !isIndependent(other) &&
            this.route(other.destination) === this.route(destination) &&
            other.status === 'queued' &&
            other.nextAttemptAt > currentTime,
        )
        .sort((a, b) => this.compareDeliveries(a[1], b[1]))[0];
      if (delayed) {
        delayed[1].nextAttemptAt = currentTime;
        this.save(...delayed);
      }
    }
    await this.kick();
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
    this.removeStaleMention(value);
    if (!this.valid(value)) {
      if (value.options.operation === 'pin') this.clearPinError(value.error);
      const routeValid = this.routeValid(value);
      value.status = 'cancelled';
      value.cancelledForRoute = !routeValid || undefined;
      value.cancelledForQuestion =
        routeValid && !!value.options.reminder && !reminderOpen(this.store, value.options.reminder)
          ? true
          : undefined;
      if (value.cancelledForRoute && value.options.notificationId)
        this.cancelledRouteNotifications.add(value.options.notificationId);
      if (value.cancelledForQuestion && value.options.notificationId)
        this.cancelledQuestionNotifications.add(value.options.notificationId);
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
        if (this.obsolete(value, revision) || !this.valid(value)) break;
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
        if (this.obsolete(value, revision)) return;
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
          this.enqueuePin(value.destination, value.messages[0].id, options.groupId);
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
      } else if (!this.obsolete(value, revision)) value.status = 'queued';
      this.save(key, value);
    } catch (error) {
      const rateLimitUntil = this.applyRateLimit(error);
      if (this.obsolete(value, revision)) return;
      const status = Number((error as { telegramStatus?: number })?.telegramStatus);
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
