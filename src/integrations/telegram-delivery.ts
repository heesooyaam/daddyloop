import {
  privateAgentReplyAllowed,
  reminderOpen,
  type OwnerQuestion,
} from './telegram-reminders.js';
import { createHash, randomUUID } from 'node:crypto';
import type { Message, ReviewGroup } from '../core/types.js';
import type { Store } from '../core/store.js';
import { redact } from '../core/security.js';
import { clipTitle } from '../core/session-title.js';
import { languageCard } from './telegram-meta.js';
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
  mentionDelivered?: boolean;
  queuePosition?: number;
  pinPermissionDenied?: boolean;
  nextAttemptAt: number;
  error?: string;
  messages: ({ id: number; fingerprint: string } | null)[];
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
      ? (content.replyKeyboard ?? { inline_keyboard: content.buttons ?? [] })
      : { inline_keyboard: [] },
});

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
      .prepare(
        `SELECT key,value FROM settings WHERE key GLOB 'telegram.delivery:*'
        ORDER BY COALESCE(json_extract(value,'$.queuePosition'),rowid), rowid`,
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
          this.separateTurnReceipts(value, message, Number(row.position));
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
      }
    });
  }
  private separateTurnReceipts(value: Delivery, latest: Message, position: number) {
    const groupId = value.options.groupId!;
    const notification = this.store.db.prepare('SELECT status,at FROM notifications WHERE id=?');
    const records = (message: Message) =>
      (['progress', 'final', undefined] as const).flatMap((phase) => {
        const row = notification.get(this.legacyDialogId(value, message, phase));
        return row
          ? [{ id: this.legacyDialogId(value, message, phase), status: row.status, at: row.at }]
          : [];
      });
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
      const pending = history.find(({ status }) => status !== 'sent') ?? history[0];
      const key = dialogKey(message.id);
      const storageKey = deliveryKey(this.bot, value.destination, key);
      if (this.store.setting<Delivery>(storageKey)) continue;
      const notificationId = this.legacyDialogId(value, message, message.phase);
      const order =
        index === 0
          ? { createdAt: value.createdAt, queuePosition: position }
          : this.legacyReplacementOrder(value, message, position, pending?.at, index, false);
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
    }
    if (previous.length && value.status !== 'sent') {
      const proposed = notification.get(value.options.notificationId!);
      const firstWasSent = previous.at(-1)?.history.some(({ status }) => status === 'sent');
      Object.assign(
        value,
        this.legacyReplacementOrder(
          value,
          latest,
          position,
          proposed?.at,
          previous.length,
          !!firstWasSent && value.attempts > 0,
        ),
      );
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
    // The released sender overwrote the turn row. A language callback has
    // a separate event that can disambiguate a timestamp tie with a reply.
    const replyEvent = this.store.db
      .prepare(
        `SELECT MIN(id) AS id FROM events WHERE task_id=? AND type='daddy.message'
       AND json_extract(data,'$.messageId')=?`,
      )
      .get(message.taskId, message.id);
    const tied = this.store.db
      .prepare(
        `SELECT rowid AS position,value FROM settings WHERE key GLOB 'telegram.delivery:*'
       AND json_extract(value,'$.bot')=? AND json_extract(value,'$.destination')=?
       AND json_extract(value,'$.createdAt')=?
       AND json_extract(value,'$.status') IN ('queued','sending')
       AND json_extract(value,'$.options.operation') IS NULL ORDER BY rowid`,
      )
      .all(this.bot, JSON.stringify(value.destination), createdAt);
    let earlier = position;
    let later = Infinity;
    for (const row of tied) {
      const menu = JSON.parse(String(row.value)) as Delivery;
      const event = replyEvent?.id != null ? this.legacyLanguageEvent(menu) : undefined;
      const precedes =
        event !== undefined ? event < Number(replyEvent!.id) : !attempted || menu.attempts > 0;
      if (precedes) earlier = Math.max(earlier, Number(row.position));
      else later = Math.min(later, Number(row.position));
    }
    earlier = Math.min(earlier, later - 1);
    return { createdAt, queuePosition: earlier + index / (index + 1) };
  }
  private legacyLanguageEvent(menu: Delivery): number | undefined {
    if (menu.options.key || !menu.options.deletePrevious) return;
    const locale = (['ru', 'en'] as const).find(
      (locale) => digest(menu.content) === digest(languageCard(locale)),
    );
    if (!locale) return;
    // Match only a unique card and a unique compatible event. If the old
    // records cannot establish the pairing, keep the recorded menu slot.
    const cards = this.store.db
      .prepare(
        `SELECT count(*) AS n FROM settings WHERE key GLOB 'telegram.delivery:*'
       AND json_extract(value,'$.bot')=?
       AND json_extract(value,'$.createdAt')=?
       AND json_extract(value,'$.options.key') IS NULL
       AND json_extract(value,'$.options.deletePrevious') IS NOT NULL
       AND json_extract(value,'$.content')=?`,
      )
      .get(this.bot, menu.createdAt, JSON.stringify(menu.content));
    if (Number(cards?.n) !== 1) return;
    const events = this.store.db
      .prepare(
        `SELECT id FROM events WHERE type='preferences.changed' AND task_id='_system'
       AND at=? AND json_extract(data,'$.locale')=?`,
      )
      .all(new Date(menu.createdAt).toISOString(), locale);
    if (events.length === 1) return Number(events[0].id);
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
  private valid(value: Delivery) {
    if (value.options.reminder && !reminderOpen(this.store, value.options.reminder)) return false;
    const pair = this.store.setting<Pairing>('telegram.pairing');
    const room = this.store.setting<Room>('telegram.group');
    if (value.ownerId !== pair?.userId) return false;
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
    if (!this.running && !this.stopped) {
      const sending = this.flush(1);
      if (!this.drainingInBackground) await sending;
    } else if (this.running && !this.stopped)
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
        const retry = await this.attempt(...ready);
        if (retry) attempted.delete(ready[0]);
      }
    })().catch((error) => this.store.setSetting('telegram.deliveryError', redact(String(error))));
    try {
      await this.running;
    } finally {
      this.running = undefined;
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
            await this.api.call(
              'editMessageText',
              { ...body, message_id: existing.id },
              this.controller.signal,
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
        const part = value.messages.at(-1);
        if (!part) {
          value.messages.pop();
          continue;
        }
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
        if (
          options.deletePrevious &&
          !value.messages.some((part) => part?.id === options.deletePrevious!.messageId)
        ) {
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
