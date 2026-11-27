import {
  privateAgentReplyAllowed,
  reminderOpen,
  type OwnerQuestion,
} from './telegram-reminders.js';
import { createHash, randomUUID } from 'node:crypto';
import type { AgentProfile, Message, ReviewGroup } from '../core/types.js';
import type { Store } from '../core/store.js';
import { redact } from '../core/security.js';
import { profileText } from '../core/task-activity.js';
import { clipTitle } from '../core/session-title.js';
import { translator } from '../i18n/index.js';
import {
  TelegramText,
  splitTelegramText,
  type TelegramCard,
  type FormattedText,
} from './telegram-text.js';

export type TelegramDestination = { chatId: number; threadId?: number };
export const groupSelectionKey = 'telegram.pendingGroupSelection';
type GroupSelectionIdentity = { requestId: number; ownerId: number; updateId?: number };
export function groupSelectionHold(selection: GroupSelectionIdentity) {
  return selection.updateId === undefined
    ? selection.requestId
    : `${selection.requestId}:${selection.updateId}`;
}
export interface DeliveryOptions {
  groupSelectionHold?: number | string;
  requestedMenu?: boolean;
  menuTopicGroupId?: string;
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
  firstAttemptAt?: number;
  sentAt?: number;
  status: 'queued' | 'sending' | 'sent' | 'cancelled';
  attempts: number;
  mentionOnPromotion?: boolean;
  mentionDelivered?: boolean;
  queuePosition?: number;
  queuePositionTie?: number;
  pinPermissionDenied?: boolean;
  nextAttemptAt: number;
  error?: string;
  messages: ({ id: number; fingerprint: string } | null)[];
};
type LegacyMenuEvent = {
  id: number;
  at: string;
  subject: string;
  type: string;
  data: Record<string, unknown>;
};
type LegacyOrder = { earliest: number; latest: number };
type LegacyCard = { slot: number; menu: Delivery };
type LegacyObservation = { subject: string; field: string; value: string | number | boolean };
type LegacyCardEvidence = {
  card: LegacyCard;
  choices: LegacyOrder[];
  effect?: boolean;
  observation?: LegacyObservation;
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
export const dialogKey = (messageId: string) => `dialog:${messageId}`;
const deliveryKey = (bot: string, route: TelegramDestination, key: string) =>
  prefix + digest([bot, route, key]);

const legacyDialog = /^telegram:dialog:-?\d+:\d+:([^:]+)(?::(?:progress|final))?$/;
const childSession = 'telegram:child-session:';
type Pairing = { chatId: number; userId: number };
type Room = { chatId: number; ownerId: number };
const sameDestination = (a: TelegramDestination, b: TelegramDestination) =>
  a.chatId === b.chatId && a.threadId === b.threadId;
const pinPermissionDenied = (error: unknown) =>
  Number((error as { telegramStatus?: number })?.telegramStatus) === 403 ||
  /not enough rights|CHAT_ADMIN_REQUIRED|not permitted to pin|forbidden|\b403\b/i.test(
    String(error),
  );
const partBody = (
  destination: TelegramDestination,
  content: TelegramCard,
  chunks: FormattedText[],
  index: number,
) => ({
  chat_id: destination.chatId,
  text: chunks[index].text,
  entities: chunks[index].entities,
  link_preview_options: { is_disabled: true },
  reply_markup:
    index === chunks.length - 1
      ? (content.replyKeyboard ??
        (content.removeKeyboard
          ? { remove_keyboard: true }
          : { inline_keyboard: content.buttons ?? [] }))
      : { inline_keyboard: [] },
});

export function deliveryStatus(result: unknown) {
  return (result as { status?: string })?.status ?? 'sent';
}

/** Durable, ordered delivery with one receipt per acknowledged message part. */
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
    this.migrateDialogDeliveries();
    for (const row of store.db
      .prepare(
        `SELECT key,value FROM settings WHERE key GLOB 'telegram.delivery:*'
        ORDER BY COALESCE(json_extract(value,'$.queuePosition'),rowid),
          COALESCE(json_extract(value,'$.queuePositionTie'),rowid), rowid`,
      )
      .all()) {
      const value = JSON.parse(String(row.value)) as Delivery;
      if (!value || value.bot !== bot || !['queued', 'sending'].includes(value.status)) continue;
      value.status = 'queued';
      const adopted = this.adoptLegacyRoute(value);
      if (!adopted) value.status = 'cancelled';
      const key = adopted ? this.restoreChildDestination(String(row.key), value) : String(row.key);
      this.save(key, value);
    }
    this.rateLimitUntil = store.setting<number>(`telegram.deliveryLimit:${bot}`) ?? 0;
  }
  private migrateDialogDeliveries() {
    const rows = this.store.db
      .prepare(
        `SELECT key,value,rowid AS position FROM settings WHERE key GLOB 'telegram.delivery:*'
       AND json_extract(value,'$.bot')=?
       AND json_extract(value,'$.options.key') NOT GLOB 'dialog:*'
       AND json_extract(value,'$.options.notificationId') GLOB 'telegram:dialog:*'
       ORDER BY (json_extract(value,'$.options.key') GLOB 'turn:*') DESC, rowid`,
      )
      .all(this.bot);
    if (!rows.length) return;
    this.store.transaction(() => {
      const migrated = new Set<string>();
      for (const row of rows) {
        const value = JSON.parse(String(row.value)) as Delivery;
        const { options, destination } = value;
        const match = options.notificationId?.match(legacyDialog);
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
        if (options.key?.startsWith('turn:'))
          this.separateTurnReceipts(value, message, Number(row.position), migrated);
        const prior = this.store.setting<Delivery>(storageKey);
        let sourceKey = String(row.key);
        if (prior) {
          if (!options.final || !message.needsReply || !prior.messages.some(Boolean)) {
            if (value.messages.some(Boolean) && !prior.messages.some(Boolean)) {
              this.store.db.prepare('DELETE FROM settings WHERE key=?').run(storageKey);
            } else {
              value.status = value.status === 'sent' ? 'sent' : 'cancelled';
              this.store.setSetting(sourceKey, value);
              continue;
            }
          } else if (value.messages.some(Boolean)) {
            // The legacy standalone delivery already emitted the mention. Keep
            // its native receipts and finish the single public reply separately.
            const finalNotification = options.notificationId!;
            this.store.setSetting(sourceKey, {
              ...value,
              status: 'sent',
              options: {
                ...options,
                key: `legacy-mention:${message.id}`,
                notificationId: undefined,
              },
            });
            prior.mentionDelivered = true;
            prior.options.final = true;
            prior.options.notificationId = finalNotification;
            if (prior.status === 'sent')
              this.store.db
                .prepare("UPDATE notifications SET status='sent' WHERE id=?")
                .run(finalNotification);
            this.store.setSetting(storageKey, prior);
            continue;
          } else if (value.status !== 'sent') {
            // The standalone mention never obtained a receipt: finish the
            // existing reply and send just the mention as a native reply to it.
            value.messages = prior.messages;
            value.createdAt = prior.createdAt;
            value.queuePosition = prior.queuePosition;
            value.mentionOnPromotion = true;
            this.store.db.prepare('DELETE FROM settings WHERE key=?').run(sourceKey);
            sourceKey = storageKey;
          } else {
            continue;
          }
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
          .run(storageKey, JSON.stringify(value), sourceKey);
        migrated.add(storageKey);
      }
      this.orderMigratedReplies(migrated);
    });
  }
  private separateTurnReceipts(
    value: Delivery,
    latest: Message,
    position: number,
    migrated: Set<string>,
  ) {
    const groupId = value.options.groupId!;
    const notification = this.store.db.prepare('SELECT status,at FROM notifications WHERE id=?');
    const records = (message: Message) =>
      (['progress', 'final', undefined] as const).flatMap((phase) => {
        const row = notification.get(this.legacyDialogId(value, message, phase));
        return row
          ? [{ id: this.legacyDialogId(value, message, phase), status: row.status, at: row.at }]
          : [];
      });
    const firstDelivery = (history: ReturnType<typeof records>) =>
      history.map(({ at }) => String(at)).sort()[0];
    const candidates = this.store
      .messages(groupId)
      .filter((message) => message.sender === 'agent' && message.runId === latest.runId)
      .map((message) => {
        const content =
          message.id === latest.id
            ? value.content
            : new TelegramText().add('👨‍💻 [daddy]', 'bold').add('\n\n').markdown(message.text);
        const chunks = splitTelegramText(content);
        return {
          message,
          history: records(message),
          content,
          chunks,
          fingerprints: chunks.map((_, index) =>
            digest(partBody(value.destination, content, chunks, index)),
          ),
        };
      });
    const latestIndex = candidates.findIndex(({ message }) => message.id === latest.id);
    const represented = candidates.slice(0, latestIndex + 1);
    const latestFingerprint = digest(represented.at(-1)!.fingerprints);
    let end = latestIndex + 1;
    while (end < candidates.length) {
      const candidate = candidates[end];
      if (
        candidate.message.needsReply ||
        !candidate.history.length ||
        digest(candidate.fingerprints) !== latestFingerprint
      )
        break;
      // A trailing duplicate could leave the legacy turn pointing at its predecessor.
      end++;
    }
    const retained = new Map<string, Delivery['messages']>();
    if (value.status !== 'sent')
      value.messages = value.messages.map((part, index) => {
        if (!part) return null;
        const matches = represented.filter(
          (candidate) => candidate.fingerprints[index] === part.fingerprint,
        );
        // A queued edit describes proposed content. An older matching message
        // already recorded as sent is stronger evidence, even for identical text.
        const confirmed = matches.find(
          ({ message, history }) =>
            message.id !== latest.id && history.some(({ status }) => status === 'sent'),
        );
        const owner = confirmed ?? matches[0];
        if (owner?.message.id === latest.id) return part;
        if (owner) {
          const parts = retained.get(owner.message.id) ?? [];
          while (parts.length <= index) parts.push(null);
          parts[index] = part;
          retained.set(owner.message.id, parts);
        } else {
          // An unrecognizable receipt cannot authorize editing the proposed reply.
          this.store.setSetting(
            deliveryKey(this.bot, value.destination, `legacy-receipt:${part.id}`),
            {
              ...value,
              id: randomUUID(),
              status: 'cancelled',
              options: { groupId: value.options.groupId },
              messages: [part],
            },
          );
        }
        return null;
      });
    const previous = candidates.slice(0, latestIndex);
    for (const [index, candidate] of candidates.slice(0, end).entries()) {
      if (index === latestIndex) continue;
      const { message, content, chunks, history } = candidate;
      const parts = retained.get(message.id);
      const superseded = history.find(({ status }) => status === 'superseded');
      const prior = candidates[index - 1];
      // The old equality check returned the previous delivery status without
      // saving a new receipt or superseding an identical independent reply.
      const identicalToPrevious =
        prior &&
        history.length > 0 &&
        digest(prior.fingerprints) === digest(candidate.fingerprints);
      if (
        !parts &&
        !identicalToPrevious &&
        (!superseded || history.some(({ status }) => status === 'sent'))
      )
        continue;
      const key = dialogKey(message.id);
      const storageKey = deliveryKey(this.bot, value.destination, key);
      if (this.store.setting<Delivery>(storageKey)) continue;
      const notificationId = this.legacyDialogId(value, message, message.phase);
      const order =
        index === 0
          ? { createdAt: value.createdAt, queuePosition: position }
          : this.legacyReplacementOrder(
              value,
              message,
              position,
              firstDelivery(history),
              index,
              false,
            );
      const sent = !!parts && chunks.every((_, index) => parts[index]);
      this.store.setSetting(storageKey, {
        ...value,
        ...order,
        id: randomUUID(),
        content,
        options: {
          key,
          groupId,
          sessionRoute: true,
          replace: true,
          final: message.phase !== 'progress',
          order: message.at,
          notificationId,
        },
        status: sent ? 'sent' : 'queued',
        messages: parts ?? [],
      });
      migrated.add(storageKey);
    }
    if (previous.length && value.status !== 'sent') {
      const proposed = notification.get(value.options.notificationId!);
      const first = firstDelivery(records(latest));
      const firstWasSent = previous.at(-1)?.history.some(({ status }) => status === 'sent');
      Object.assign(
        value,
        this.legacyReplacementOrder(
          value,
          latest,
          position,
          first,
          previous.length,
          !!firstWasSent && first === proposed?.at && value.attempts > 0,
        ),
      );
    }
  }
  private orderMigratedReplies(migrated: Set<string>) {
    const groups = new Map<
      string,
      { key: string; value: Delivery; event: number; position: number; tie: number }[]
    >();
    const rows = this.store.db
      .prepare(
        `SELECT key,value,rowid AS position FROM settings WHERE key GLOB 'telegram.delivery:*'
       AND json_extract(value,'$.bot')=? AND json_extract(value,'$.status') IN ('queued','sending')
       ORDER BY COALESCE(json_extract(value,'$.queuePosition'), rowid),
         COALESCE(json_extract(value,'$.queuePositionTie'),rowid), rowid`,
      )
      .all(this.bot);
    const eventId = this.store.db.prepare(
      `SELECT MIN(id) AS id FROM events WHERE task_id=? AND type='daddy.message'
       AND json_extract(data,'$.messageId')=?`,
    );
    for (const row of rows) {
      const key = String(row.key);
      if (!migrated.has(key)) continue;
      const value = JSON.parse(String(row.value)) as Delivery;
      const id = value.options.key?.slice('dialog:'.length);
      const event = eventId.get(value.options.groupId ?? '', id ?? '')?.id;
      if (event == null) continue;
      const group = JSON.stringify([value.ownerId, value.destination, value.createdAt]);
      const replies = groups.get(group) ?? [];
      replies.push({
        key,
        value,
        event: Number(event),
        position: value.queuePosition ?? Number(row.position),
        tie: value.queuePositionTie ?? Number(row.position),
      });
      groups.set(group, replies);
    }
    for (const replies of groups.values()) {
      const chronological = [...replies].sort((a, b) => a.event - b.event);
      if (chronological.every((reply, index) => reply === replies[index])) continue;
      for (const [index, reply] of chronological.entries()) {
        // Keep the existing slots and their tie breakers when moving replies.
        reply.value.queuePosition = replies[index].position;
        reply.value.queuePositionTie = replies[index].tie;
        this.store.setSetting(reply.key, reply.value);
      }
    }
  }
  private legacyReplacementOrder(
    value: Delivery,
    message: Message,
    position: number,
    recordedAt: unknown,
    index: number,
    attempted: boolean,
  ) {
    const queuedAt = Date.parse(String(recordedAt ?? message.at));
    const createdAt = Number.isFinite(queuedAt)
      ? Math.max(value.createdAt, queuedAt)
      : value.createdAt;
    // The released sender overwrote the turn row. A command's journal event
    // can disambiguate a timestamp tie with a reply.
    const replyEvent = this.store.db
      .prepare(
        `SELECT MIN(id) AS id FROM events WHERE task_id=? AND type='daddy.message'
       AND json_extract(data,'$.messageId')=?`,
      )
      .get(message.taskId, message.id);
    const tied = this.store.db
      .prepare(
        `SELECT rowid AS position,value FROM settings WHERE key GLOB 'telegram.delivery:*'
       AND json_extract(value,'$.bot')=? AND json_extract(value,'$.ownerId') IS ?
       AND json_extract(value,'$.createdAt')<=?
       AND json_extract(value,'$.status') IN ('queued','sending','sent')
       AND json_extract(value,'$.options.operation') IS NULL
       AND COALESCE(json_extract(value,'$.options.notificationId'),'') NOT GLOB 'telegram:dialog:*'
       ORDER BY rowid`,
      )
      .all(this.bot, value.ownerId ?? null, createdAt);
    const recorded = tied.map((row) => ({
      menu: JSON.parse(String(row.value)) as Delivery,
      slot: Number(row.position),
    }));
    const time = new Date(createdAt).toISOString();
    const cards = recorded.filter(({ menu }) => menu.createdAt === createdAt);
    const events = this.legacyEvents(new Date(value.createdAt).toISOString(), time);
    const scopes = this.store.db
      .prepare('SELECT group_id,data FROM telegram_topics')
      .all()
      .map((row) => ({
        subject: String(row.group_id),
        route: JSON.parse(String(row.data)) as TelegramDestination,
      }));
    const privateChat = this.store.setting<Pairing>('telegram.pairing')?.chatId;
    const subjectOf = (menu: Delivery) => {
      if (menu.options.groupId) return menu.options.groupId;
      const routes = scopes.filter(({ route }) => sameDestination(menu.destination, route));
      if (routes.length === 1) return routes[0].subject;
      if (menu.destination.chatId === privateChat && menu.destination.threadId === undefined)
        return undefined;
      return null;
    };

    const evidence = recorded.flatMap((card): LegacyCardEvidence[] => {
      const choices = this.legacyConfirmationEvents(card.menu, events, subjectOf);
      if (choices.length) return [{ card, choices, effect: true }];
      if (card.menu.createdAt !== createdAt) return [];
      const observation = this.legacyObservation(card.menu, message.taskId, subjectOf);
      if (!observation) return [];
      const states = this.legacyStateIntervals(
        observation,
        recorded,
        events,
        time,
        message.taskId,
        subjectOf,
      );
      return states.length ? [{ card, choices: states, observation }] : [];
    });
    const earliest = this.legacyCardBounds(evidence, 1);
    const latest = this.legacyCardBounds(evidence, -1);
    let before = position;
    let after = Infinity;
    for (const card of cards) {
      const { menu, slot } = card;
      if (menu.status === 'sent') continue;
      if (sameDestination(menu.destination, value.destination) && menu.attempts > 0) {
        before = Math.max(before, slot);
        continue;
      }
      if (replyEvent?.id == null) continue;
      const first = earliest?.get(slot);
      const last = latest?.get(slot);
      if (first === undefined || last === undefined) continue;
      if (last < Number(replyEvent.id)) before = Math.max(before, slot);
      if (first >= Number(replyEvent.id)) after = Math.min(after, slot);
    }
    // A turn whose first reply still owns its original row can also anchor
    // a moved reply. This preserves its order with both replies and menus.
    if (replyEvent?.id != null)
      for (const row of this.store.db
        .prepare(
          `SELECT rowid AS slot,value FROM settings WHERE key GLOB 'telegram.delivery:*'
         AND json_extract(value,'$.bot')=? AND json_extract(value,'$.ownerId') IS ?
         AND json_extract(value,'$.createdAt')=?
         AND json_extract(value,'$.queuePosition') IS NULL
         AND json_extract(value,'$.options.notificationId') GLOB 'telegram:dialog:*'
         AND json_extract(value,'$.status') IN ('queued','sending')`,
        )
        .all(this.bot, value.ownerId ?? null, createdAt)) {
        const other = JSON.parse(String(row.value)) as Delivery;
        if (other.id === value.id || !sameDestination(other.destination, value.destination))
          continue;
        const id = other.options.notificationId?.match(legacyDialog)?.[1];
        const candidate = id && this.store.messageById(message.taskId, id);
        if (!candidate || candidate.runId === message.runId) continue;
        const fact = this.store.db
          .prepare(
            `SELECT MIN(id) AS first FROM events WHERE task_id=? AND type='daddy.message'
           AND json_extract(data,'$.messageId')=?`,
          )
          .get(message.taskId, id);
        const firstInTurn = this.store.db
          .prepare(
            `SELECT id FROM messages WHERE task_id=? AND json_extract(data,'$.runId')=?
           AND json_extract(data,'$.sender')='agent' ORDER BY rowid LIMIT 1`,
          )
          .get(message.taskId, candidate.runId ?? null);
        if (firstInTurn?.id !== id || fact?.first == null) continue;
        if (Number(fact.first) < Number(replyEvent.id)) before = Math.max(before, Number(row.slot));
        else after = Math.min(after, Number(row.slot));
      }
    if (!attempted)
      for (const { slot, menu } of cards)
        if (
          menu.status !== 'sent' &&
          sameDestination(menu.destination, value.destination) &&
          slot < after
        )
          before = Math.max(before, slot);
    const earlier = Math.min(before, after - 1);
    return { createdAt, queuePosition: earlier + index / (index + 1) };
  }
  private legacyEvents(from: string, time: string): LegacyMenuEvent[] {
    return this.store.db
      .prepare(
        `SELECT id,at,task_id,type,data FROM events WHERE at BETWEEN ? AND ? AND type IN (
        'daddy.renamed','daddy.worker_configured','daddy.settings','preferences.changed',
        'automerge.setting','daddy.paused','daddy.resumed','daddy.created'
      ) ORDER BY id`,
      )
      .all(from, time)
      .map((row) => ({
        id: Number(row.id),
        at: String(row.at),
        subject: String(row.task_id),
        type: String(row.type),
        data: JSON.parse(String(row.data)) ?? {},
      }));
  }
  private legacyConfirmationEvents(
    menu: Delivery,
    events: LegacyMenuEvent[],
    subjectOf: (menu: Delivery) => string | null | undefined,
  ): LegacyOrder[] {
    if (menu.options.key?.startsWith('telegram:task:')) {
      const event = this.store.db
        .prepare(
          `SELECT MIN(e.id) AS id FROM tasks t JOIN events e ON e.task_id=t.id
          WHERE json_extract(t.data,'$.createdByAction')=? AND e.type='ticket.imported'`,
        )
        .get(menu.options.key);
      return event?.id == null ? [] : [{ earliest: Number(event.id), latest: Number(event.id) }];
    }
    const matching = (candidate: Delivery, { type, data, subject }: LegacyMenuEvent) => {
      const scope = subjectOf(candidate);
      if (type !== 'preferences.changed' && scope !== undefined && scope !== subject) return false;
      return (['ru', 'en'] as const).some((locale) => {
        const t = translator(locale);
        const { text } = candidate.content;
        if (candidate.options.key?.startsWith('telegram:worker:'))
          return (
            type === 'daddy.worker_configured' &&
            typeof data.worker === 'number' &&
            !!data.profile &&
            text ===
              t(
                data.restarted
                  ? 'Worker {number} will resume the task · {profile}'
                  : 'Worker {number} model saved · {profile}',
                { number: data.worker, profile: profileText(data.profile as AgentProfile) },
              )
          );
        if (candidate.options.key) return false;
        if (type === 'daddy.renamed')
          return (
            typeof data.title === 'string' &&
            text === t('Session renamed: {title}', { title: data.title })
          );
        if (type === 'daddy.settings')
          return text.startsWith(t('Preset enabled for this session') + '\n');
        return (
          type === 'preferences.changed' &&
          data.locale === locale &&
          !candidate.options.deletePrevious &&
          text === t('Language updated.')
        );
      });
    };
    const time = new Date(menu.createdAt).toISOString();
    return events
      .filter((event) => event.at <= time && matching(menu, event))
      .map(({ id }) => ({ earliest: id, latest: id }));
  }
  private legacyObservation(
    menu: Delivery,
    groupId: string,
    subjectOf: (menu: Delivery) => string | null | undefined,
  ): LegacyObservation | undefined {
    if (menu.options.key) return;
    const buttons = (menu.content as TelegramCard).buttons?.flat() ?? [];
    for (const { text, callback_data: callback } of buttons) {
      const [, action, subject, value] = callback?.split(':') ?? [];
      if (callback?.startsWith('language:') && text.startsWith('✓ '))
        return { subject: '_system', field: 'locale', value: action };
      if (!subject) continue;
      if (action === 'pool' && value && text.startsWith('✓ '))
        return { subject, field: 'pool', value: Number(value) };
      if (action === 'sm') return { subject, field: 'autoMerge', value: value === 'off' };
      if (action === 'tm' && text.startsWith('✓ ')) return { subject, field: 'mode', value };
      if (action === 'pause' || action === 'resume')
        return { subject, field: 'paused', value: action === 'resume' };
    }
    const pool = buttons.find(({ callback_data }) =>
      /^dad:pool:[^:]+:[1-8]$/.test(callback_data ?? ''),
    );
    if (pool?.callback_data) {
      const subject = pool.callback_data.split(':')[2];
      const shown = menu.content.text.match(/(?:^|\n)(?:Pool|Пул): [1-8] → ([1-8])\./);
      if (shown) return { subject, field: 'pool', value: Number(shown[1]) };
      const settled = menu.content.text.match(/(?:^|\n)(?:Pool|Пул): ([1-8])\./);
      if (settled) return { subject, field: 'pool', value: Number(settled[1]) };
    }
    for (const locale of ['ru', 'en'] as const) {
      if (!menu.content.text.startsWith(translator(locale)('Instructions for this session') + '\n'))
        continue;
      // Private instruction cards lack an ID. Use a session only when the
      // topic identifies it or when it is the sole orchestrated session.
      const scope = subjectOf(menu);
      const known =
        scope === undefined &&
        this.store.groups().filter((group) => group.orchestrated).length === 1
          ? groupId
          : scope;
      if (known)
        return { subject: known, field: 'instructions:' + locale, value: menu.content.text };
    }
  }
  private legacyStateIntervals(
    observation: LegacyObservation,
    cards: LegacyCard[],
    events: LegacyMenuEvent[],
    time: string,
    groupId: string,
    subjectOf: (menu: Delivery) => string | null | undefined,
  ): LegacyOrder[] {
    const { field, subject } = observation;
    const types =
      field === 'locale'
        ? ['preferences.changed']
        : field === 'mode'
          ? ['automerge.setting']
          : field === 'paused'
            ? ['daddy.created', 'daddy.paused', 'daddy.resumed']
            : ['daddy.settings'];
    const valueOf = (type: string, data: Record<string, unknown>) => {
      if (field === 'paused') return type === 'daddy.paused';
      if (field === 'pool') return data.requestedWorkerLimit ?? data.workerLimit;
      return data[field];
    };
    const changes = events.filter(
      (event) => event.at === time && event.subject === subject && types.includes(event.type),
    );
    if (!changes.length) return [];
    const prior = this.store.db
      .prepare(
        `SELECT type,data,at FROM events WHERE task_id=?
       AND type IN (SELECT value FROM json_each(?)) AND at<? ORDER BY at DESC,id DESC LIMIT 1`,
      )
      .get(subject, JSON.stringify(types), time);
    let initial = prior && valueOf(String(prior.type), JSON.parse(String(prior.data)) ?? {});
    // The most recent earlier card is another snapshot. Later journal
    // entries supersede it, including entries without a recorded value.
    const tick = Date.parse(time);
    for (let i = cards.length - 1; i >= 0; i--) {
      const earlier = cards[i].menu;
      if (earlier.createdAt >= tick) continue;
      if (prior && earlier.createdAt < Date.parse(String(prior.at))) break;
      const seen = this.legacyObservation(earlier, groupId, subjectOf);
      if (seen?.subject !== subject || seen.field !== field) continue;
      initial =
        prior &&
        earlier.createdAt === Date.parse(String(prior.at)) &&
        initial !== undefined &&
        initial !== seen.value
          ? undefined
          : seen.value;
      break;
    }
    const values = [initial, ...changes.map(({ type, data }) => valueOf(type, data))];
    return values.flatMap((value, index) =>
      value === undefined || value === observation.value
        ? [
            {
              earliest: changes[index - 1]?.id ?? -Infinity,
              latest: index === changes.length ? Infinity : changes[index].id - 1,
            },
          ]
        : [],
    );
  }
  private legacyCardBounds(evidence: LegacyCardEvidence[], step: 1 | -1) {
    const bounds = new Map<number, number>();
    const observations = new Map<
      string,
      { value: LegacyObservation['value']; interval: LegacyOrder }
    >();
    let previous = step === 1 ? -Infinity : Infinity;
    let effect = previous;
    // The old poller queued command responses sequentially. At each step,
    // the extreme feasible choice leaves the most room for the other cards.
    // This applies across command types and across state observations.
    for (let i = step === 1 ? 0 : evidence.length - 1; evidence[i]; i += step) {
      const { card, choices, effect: consumesEvent, observation } = evidence[i];
      let limit = previous;
      if (consumesEvent)
        limit = step === 1 ? Math.max(limit, effect + 1) : Math.min(limit, effect - 1);
      const stateKey = observation && JSON.stringify([observation.subject, observation.field]);
      const seen = stateKey && observations.get(stateKey);
      if (seen && seen.value !== observation?.value)
        limit =
          step === 1
            ? Math.max(limit, seen.interval.latest + 1)
            : Math.min(limit, seen.interval.earliest - 1);
      const interval =
        step === 1
          ? choices.find(({ latest }) => latest >= limit)
          : choices.findLast(({ earliest }) => earliest <= limit);
      if (!interval) return;
      previous = step === 1 ? Math.max(limit, interval.earliest) : Math.min(limit, interval.latest);
      if (consumesEvent) effect = previous;
      if (stateKey && observation)
        observations.set(stateKey, { value: observation.value, interval });
      bounds.set(card.slot, previous);
    }
    return bounds;
  }
  private legacyDialogId(value: Delivery, message: Message, phase: Message['phase']) {
    const { chatId, threadId } = value.destination;
    return `telegram:dialog:${chatId}:${threadId ?? 0}:${message.id}${phase ? ':' + phase : ''}`;
  }
  private adoptLegacyRoute(value: Delivery) {
    const { options, destination } = value;
    const key = options.key ?? '';
    const question = key.match(/^telegram:question:(\d+):([^:]+):(.+?)(?::reminder:\d+)?$/);
    if (question && !options.reminder) {
      const task = this.store.tasks().find((task) => task.id === question[2]);
      const groupId = options.groupId ?? task?.groupId;
      if (!groupId || Number(question[1]) !== value.ownerId) return false;
      options.reminder = { groupId, taskId: question[2], request: question[3] };
    }
    if (options.sessionRoute !== undefined) return true;
    if (key.startsWith(childSession)) {
      const child = this.store
        .groups()
        .find((group) => group.id === key.slice(childSession.length));
      if (!child?.parentGroupId) return false;
      options.groupId = child.parentGroupId;
      options.sessionRoute = true;
      return true;
    }
    const status = key.startsWith('progress:') || options.operation === 'pin';
    const board = key.startsWith('telegram:daddy-intro:');
    const resources = key.startsWith('resources:');
    const rename = options.operation === 'renameTopic';
    const dialog = key.startsWith('telegram:dialog:') || key.startsWith('turn:');
    if (!status && !board && !resources && !rename && !dialog && !options.reminder) return true;
    let groupId = options.groupId ?? options.reminder?.groupId;
    if (!groupId && board) groupId = key.split(':')[3];
    if (!groupId && resources) groupId = key.slice('resources:'.length);
    if (!groupId && status) {
      let progressKey = key;
      if (options.operation === 'pin') {
        const card = this.store.db
          .prepare(
            `SELECT json_extract(value,'$.options.key') AS progressKey FROM settings
           WHERE key GLOB 'telegram.delivery:*' AND json_extract(value,'$.bot')=?
           AND json_extract(value,'$.destination.chatId')=?
           AND json_extract(value,'$.options.key') GLOB 'progress:*'
           AND EXISTS(SELECT 1 FROM json_each(settings.value,'$.messages') m
             WHERE json_extract(m.value,'$.id')=?) LIMIT 1`,
          )
          .get(this.bot, destination.chatId, options.pinMessageId ?? null);
        progressKey = String(card?.progressKey ?? '');
      }
      if (progressKey.startsWith('progress:')) {
        const card = this.store.db
          .prepare(
            "SELECT key FROM settings WHERE key GLOB 'telegram.progress:*' AND json_extract(value,'$.id')=?",
          )
          .get(progressKey.slice('progress:'.length));
        if (card) groupId = String(card.key).split(':')[2];
      }
    }
    if (!groupId && rename) {
      const sources = this.store.db
        .prepare(
          `SELECT DISTINCT task_id FROM operations WHERE id GLOB 'telegram:topic:*' AND status='done'
         AND json_extract(result,'$.chatId')=? AND json_extract(result,'$.threadId')=?
         AND json_extract(result,'$.ownerId')=? AND json_extract(result,'$.groupId')=task_id`,
        )
        .all(destination.chatId, destination.threadId ?? null, value.ownerId ?? null);
      if (sources.length === 1 && options.order) {
        const source = this.store.groups().find((group) => group.id === sources[0].task_id);
        if (source?.updatedAt === options.order && clipTitle(source.title) === value.content.text)
          groupId = source.id;
      }
    }
    if (!groupId) return !rename && destination.threadId === undefined;
    options.groupId = groupId;
    options.sessionRoute = !board || destination.threadId !== undefined;
    return true;
  }
  private sessionDestination(groupId: string, pair: Pairing, room: Room | null | undefined) {
    if (!room || room.ownerId !== pair.userId) return { chatId: pair.chatId };
    const row = this.store.db
      .prepare('SELECT data FROM telegram_topics WHERE id=?')
      .get(`${room.ownerId}:${room.chatId}:${groupId}`);
    if (!row) return;
    const { chatId, threadId } = JSON.parse(String(row.data)) as TelegramDestination;
    return { chatId, threadId };
  }
  private restoreChildDestination(key: string, value: Delivery) {
    const { options } = value;
    if (!options.key?.startsWith(childSession) || !options.groupId || value.messages.some(Boolean))
      return key;
    const acknowledged = this.store.db
      .prepare(
        `SELECT 1 FROM settings WHERE key GLOB 'telegram.delivery:*' AND key<>?
       AND json_extract(value,'$.bot')=? AND json_extract(value,'$.ownerId')=?
       AND json_extract(value,'$.options.key')=?
       AND EXISTS (SELECT 1 FROM json_each(settings.value,'$.messages')
         WHERE json_extract(json_each.value,'$.id') IS NOT NULL) LIMIT 1`,
      )
      .get(key, this.bot, value.ownerId ?? null, options.key);
    if (acknowledged) {
      value.status = 'cancelled';
      return key;
    }
    const pair = this.store.setting<Pairing>('telegram.pairing');
    if (!pair || value.ownerId !== pair.userId) return key;
    const route = this.sessionDestination(
      options.groupId,
      pair,
      this.store.setting<Room>('telegram.group'),
    );
    if (!route || sameDestination(route, value.destination)) return key;
    const replacement = deliveryKey(this.bot, route, options.key);
    const destination = this.store.setting<Delivery>(replacement);
    if (destination) {
      if (destination.status !== 'cancelled' || destination.messages.some(Boolean)) {
        value.status = 'cancelled';
        return key;
      }
      // The earlier route was cancelled before Telegram acknowledged it.
      // Revive its slot with the pending operation and preserve its backoff.
      const revived = { ...value, destination: route };
      this.store.transaction(() => {
        this.store.setSetting(replacement, revived);
        this.store.db.prepare('DELETE FROM settings WHERE key=?').run(key);
      });
      value.destination = route;
      return replacement;
    }
    value.destination = route;
    this.store.db
      .prepare('UPDATE settings SET key=?,value=? WHERE key=?')
      .run(replacement, JSON.stringify(value), key);
    return replacement;
  }
  private currentChildCard(value: Delivery): TelegramCard {
    const content: TelegramCard = structuredClone(value.content);
    const key = value.options.key;
    if (!key?.startsWith(childSession) || value.messages.some(Boolean)) return content;
    const childId = key.slice(childSession.length);
    const pair = this.store.setting<Pairing>('telegram.pairing');
    const route =
      pair && this.sessionDestination(childId, pair, this.store.setting<Room>('telegram.group'));
    content.buttons = content.buttons?.map((row) =>
      row.map(({ text }) =>
        route?.threadId === undefined
          ? { text, callback_data: `dad:open:${childId}` }
          : {
              text,
              url: `https://t.me/c/${String(route.chatId).replace(/^-100/, '')}/${route.threadId}`,
            },
      ),
    );
    return content;
  }
  get drainingInBackground() {
    return this.timer !== undefined;
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
  private pickerRequest(value: Delivery) {
    const keyboard = (value.content as TelegramCard).replyKeyboard;
    if (!keyboard) return;
    const requestId = keyboard.keyboard[0]?.[0]?.request_chat.request_id;
    const current = this.store.setting<{ id: number; userId: number; expiresAt: string }>(
      'telegram.workspaceRequest',
    );
    if (current?.id === requestId && current?.userId === value.ownerId) return current;
  }
  private valid(value: Delivery) {
    // A superseded reservation is removed, never sent as an empty message.
    if (value.options.groupSelectionHold !== undefined) return false;
    if ((value.content as TelegramCard).replyKeyboard && !this.pickerRequest(value)) return false;
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
    const pair = this.store.setting<Pairing>('telegram.pairing');
    const room = this.store.setting<Room>('telegram.group');
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
    if (value.options.sessionRoute && value.options.groupId) {
      const groupId = value.options.groupId;
      const row = this.store.db.prepare('SELECT data FROM review_groups WHERE id=?').get(groupId);
      const group = row && (JSON.parse(String(row.data)) as ReviewGroup);
      if (!group || group.deletedAt) return false;
      const route = pair && this.sessionDestination(groupId, pair, room);
      if (!route || !sameDestination(route, value.destination)) return false;
      if (route.threadId !== undefined) return true;
      const key = value.options.key;
      const id = key?.startsWith('dialog:') ? key.slice('dialog:'.length) : undefined;
      const message = id && this.store.messageById(groupId, id);
      return (
        !message ||
        message.sender !== 'agent' ||
        privateAgentReplyAllowed(this.store, group, message)
      );
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
      const recovering =
        existing.pinPermissionDenied ||
        (existing.status === 'cancelled' && pinPermissionDenied(existing.error));
      if (!staleRoute && !legacy && !recovering) return;
      // Older pin jobs did not carry the status card's route or warning.
      existing.options = pinOptions;
      if (existing.status === 'cancelled' || recovering) {
        existing.status = 'queued';
        existing.nextAttemptAt = this.clock();
      }
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
      if (
        !options.replace &&
        value.status !== 'cancelled' &&
        (value.options.groupSelectionHold === undefined || options.groupSelectionHold !== undefined)
      )
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
      ) {
        if (value.status === 'sent' && options.pin && value.messages[0])
          this.enqueuePin(destination, value.messages[0].id, options);
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
      if (options.mention && options.final && !value.options.final && value.messages.length > 0)
        value.mentionOnPromotion = true;
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
        if (lane === 'ordered' && !this.drainingInBackground) await sending;
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
          const activationReplies = new Set<string>();
          const selection = this.store.setting<GroupSelectionIdentity | null>(groupSelectionKey);
          const ready = [...this.pending.entries()]
            .sort(
              (a, b) =>
                Number(a[1].options.operation === 'pin') -
                  Number(b[1].options.operation === 'pin') || a[1].createdAt - b[1].createdAt,
            )
            .find(([key, value]) => {
              const route = isIndependent(value) ? key : digest(value.destination);
              if (laneFor(value.options) !== lane) {
                // Bot setup has an established order in this destination,
                // including when the earlier message is awaiting its first ID.
                if (lane === 'menu' && this.precedesRequestedMenu(value))
                  activationReplies.add(route);
                return false;
              }
              if (seen.has(route)) return false;
              seen.add(route);
              if (activationReplies.has(route)) return false;
              if (
                selection &&
                value.options.groupSelectionHold === groupSelectionHold(selection) &&
                value.ownerId === selection.ownerId
              )
                return false;
              return value.nextAttemptAt <= this.clock() && !attempted.has(key);
            });
          if (!ready) break;
          attempted.add(ready[0]);
          const heldMenu = lane === 'ordered' && this.precedesRequestedMenu(ready[1]);
          const retry = await this.attempt(...ready);
          if (retry) attempted.delete(ready[0]);
          if (heldMenu && (!this.pending.has(ready[0]) || !this.precedesRequestedMenu(ready[1]))) {
            if (this.running.has('menu')) this.wake.add('menu');
            else void this.flushLane('menu', limit);
          }
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
  private precedesRequestedMenu(value: Delivery) {
    return (
      value.options.groupSelectionHold !== undefined ||
      value.options.key?.startsWith('group-selection:') ||
      (value.destination.threadId !== undefined &&
        value.options.pin &&
        value.options.key?.startsWith('progress:') &&
        !value.messages[0])
    );
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
    const restored = this.restoreChildDestination(key, value);
    if (restored !== key) {
      this.pending.delete(key);
      this.save(restored, value);
      return;
    }
    if (value.status === 'cancelled' || !this.valid(value)) {
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
      original = this.currentChildCard(value),
      options = { ...value.options };
    const picker = this.pickerRequest(value);
    if (picker) {
      // A queued picker receives a full validity window at delivery time.
      const expiresAt = new Date(
        Math.max(Date.parse(picker.expiresAt), this.clock() + 10 * 60000),
      ).toISOString();
      this.store.setSetting('telegram.workspaceRequest', { ...picker, expiresAt });
    }
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
              name: original.text,
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
      const mention =
        !value.mentionDelivered &&
        options.mention &&
        reminderOpen(this.store, options.mention.question)
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
        if (mention && !mentionAsReply && !reminderOpen(this.store, mention.question)) {
          value.status = 'queued';
          this.save(key, value);
          return true;
        }
        const body = partBody(value.destination, content, chunks, i);
        const fingerprint = digest(body);
        const existing = value.messages[i];
        if (existing?.fingerprint === fingerprint) continue;
        if (existing) {
          try {
            await this.call(
              'editMessageText',
              { ...body, message_id: existing.id },
              controller.signal,
            );
          } catch (error) {
            if (/message to edit not found/i.test(String(error))) {
              value.messages[i] = null;
              value.status = 'queued';
              this.save(key, value);
              // Rebuild from current routing and notification state before resending.
              return true;
            }
            if (!/message is not modified/i.test(String(error))) throw error;
          }
        }
        if (existing) {
          existing.fingerprint = fingerprint;
        } else {
          const result = await this.call<{ message_id: number }>(
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
            controller.signal,
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
        const part = value.messages.at(-1);
        if (!part) {
          value.messages.pop();
          continue;
        }
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
        if (options.requestedMenu) value.sentAt ??= this.clock();
        value.error = undefined;
        value.attempts = 0;
        if (options.notificationId)
          this.store.db
            .prepare("UPDATE notifications SET status='sent',at=? WHERE id=?")
            .run(new Date(this.clock()).toISOString(), options.notificationId);
        if (
          options.deletePrevious &&
          !value.messages.some((part) => part?.id === options.deletePrevious!.messageId)
        ) {
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
        if (pinPermissionDenied(error)) {
          value.status = 'queued';
          value.nextAttemptAt = this.clock() + 60000;
          value.pinPermissionDenied = true;
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
        (options.operation === 'reaction' || original.replyKeyboard) &&
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
      if (value.revision === revision && options.notificationId)
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
