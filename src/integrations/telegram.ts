import { randomBytes, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import type { Engine } from '../core/engine.js';
import { AppError, now, prRef, type Event, type Task } from '../core/types.js';
import { rememberSecret, redact } from '../core/security.js';
import { notificationPreferences } from './notifications.js';
import {
  splitTelegramText,
  TelegramText,
  type TelegramCard,
  type TelegramButton,
} from './telegram-text.js';
import {
  taskCard,
  agentCard,
  tasksCard,
  notificationsCard,
  welcomeCard,
  helpCard,
  noteCard,
  errorCard,
  publishCard,
} from './telegram-cards.js';
import { preferences, setLocale } from '../core/preferences.js';
import type { Locale } from '../i18n/index.js';
import type { Catalogue } from '../server/planning.js';
import type { UpdateMonitor, UpdateNotice } from '../core/updates.js';
import type { CodexUpdater, CodexUpdateOperation } from '../core/codex-updater.js';
import type { Daddy } from '../core/daddy.js';
import { TelegramWorkspace } from './telegram-workspace.js';
import { daddyHome } from './daddy-cards.js';
import {
  codexConfirmationCard,
  codexOperationCard,
  languageCard,
  modelsCard,
  updateCard,
  updatesCard,
} from './telegram-meta.js';
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
type User = { id: number; is_bot?: boolean };
type Chat = { id: number; type: string; title?: string; is_forum?: boolean };
export interface Update {
  update_id: number;
  message?: {
    text?: string;
    chat: Chat;
    from?: User;
    message_thread_id?: number;
    message_id?: number;
    chat_shared?: { request_id: number; chat_id: number; title?: string };
  };
  callback_query?: {
    id: string;
    data?: string;
    from: User;
    message?: { chat: Chat; message_thread_id?: number; message_id?: number };
  };
}
type Pairing = { chatId: number; userId: number; username: string };
type Confirmation = {
  taskId: string;
  generation: number;
  reviewId: string;
  head: string;
  snapshotHash: string;
  expiresAt: string;
  chatId: number;
};
function networkFailure(error: unknown) {
  const codes = new Set<string>();
  const visit = (value: unknown, depth = 0) => {
    if (!value || typeof value !== 'object' || depth > 4) return;
    const item = value as { code?: unknown; cause?: unknown; errors?: unknown[] };
    if (typeof item.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(item.code))
      codes.add(item.code);
    visit(item.cause, depth + 1);
    if (Array.isArray(item.errors)) for (const nested of item.errors) visit(nested, depth + 1);
  };
  visit(error);
  return new AppError(
    'telegram_unreachable',
    `Cannot reach Telegram at api.telegram.org:443${codes.size ? ` (${[...codes].join(', ')})` : ''}. Check this host's connection, DNS and trusted certificates; retry setup or pairing.`,
    502,
  );
}
export async function connectTelegram(
  factory: () => Promise<Telegram>,
  signal: AbortSignal,
  onError: (error: unknown) => void,
  retryDelayMs = 3000,
): Promise<Telegram | undefined> {
  let attempt = 0;
  while (!signal.aborted) {
    try {
      return await factory();
    } catch (error) {
      if (signal.aborted) return;
      onError(error);
      if (!(error instanceof AppError) || error.code !== 'telegram_unreachable') return;
      try {
        await delay(Math.min(30000, retryDelayMs * 2 ** Math.min(attempt++, 5)), undefined, {
          signal,
        });
      } catch {
        return;
      }
    }
  }
}
export class TelegramApi {
  private token: string;
  constructor(
    token: string,
    private fetcher: typeof fetch = fetch,
  ) {
    if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(token))
      throw new Error('Invalid Telegram bot token format');
    this.token = rememberSecret(token);
  }
  async call<T>(method: string, body: unknown = {}, signal?: AbortSignal): Promise<T> {
    const requestSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(40000)])
      : AbortSignal.timeout(40000);
    const readOnly = [
      'getMe',
      'getWebhookInfo',
      'getUpdates',
      'getChat',
      'getChatMember',
      'getChatMemberCount',
    ].includes(method);
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await this.fetcher(`https://api.telegram.org/bot${this.token}/${method}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          redirect: 'manual',
          signal: requestSignal,
        });
        if (response.status >= 300 && response.status < 400) {
          await response.body?.cancel();
          throw new AppError(
            'telegram_redirect',
            'Telegram redirected a bot API request. Check the host network or proxy; the token was not forwarded.',
            502,
          );
        }
        if (response.status >= 500) {
          await response.body?.cancel();
          throw new AppError(
            'telegram_unreachable',
            `Telegram returned HTTP ${response.status}. The API is temporarily unavailable.`,
            502,
          );
        }
        let value: { ok: boolean; result?: T; description?: string };
        try {
          value = (await response.json()) as typeof value;
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
          throw new AppError(
            'telegram_invalid_response',
            `Telegram returned a non-JSON response (HTTP ${response.status}). Check the host network or proxy.`,
            502,
          );
        }
        if (!value || typeof value !== 'object' || typeof value.ok !== 'boolean')
          throw new AppError(
            'telegram_invalid_response',
            `Telegram returned an invalid response (HTTP ${response.status}). Check the host network or proxy.`,
            502,
          );
        if (!response.ok || !value.ok)
          throw new AppError(
            'telegram_error',
            redact(value.description ?? `Telegram HTTP ${response.status}`),
            502,
          );
        return value.result as T;
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        const failure = error instanceof AppError ? error : networkFailure(error);
        // Writes can have succeeded before their response was lost. Only reads
        // are safe to retry; message delivery keeps its existing durable intent.
        if (
          !readOnly ||
          attempt >= 2 ||
          requestSignal.aborted ||
          failure.code !== 'telegram_unreachable'
        )
          throw failure;
        try {
          await delay(250 * (attempt + 1), undefined, { signal: requestSignal });
        } catch {
          if (signal?.aborted) throw signal.reason;
          throw failure;
        }
      }
    }
  }
  async send(
    destination: number | { chatId: number; threadId?: number },
    content: string | TelegramCard,
    buttons?: TelegramButton[][],
  ) {
    const chatId = typeof destination === 'number' ? destination : destination.chatId;
    const value = typeof content === 'string' ? new TelegramText().add(content) : content;
    const chunks = splitTelegramText(value);
    const keyboard = buttons ?? (value as TelegramCard).buttons;
    let result: unknown;
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      result = await this.call('sendMessage', {
        chat_id: chatId,
        ...(typeof destination !== 'number' && destination.threadId !== undefined
          ? { message_thread_id: destination.threadId }
          : {}),
        text: chunk.text,
        ...(chunk.entities.length ? { entities: chunk.entities } : {}),
        link_preview_options: { is_disabled: true },
        ...(keyboard && i === chunks.length - 1
          ? { reply_markup: { inline_keyboard: keyboard } }
          : {}),
      });
    }
    return result;
  }
}
export class Telegram {
  private stopped = false;
  private controller?: AbortController;
  private polling?: Promise<void>;
  private notices = Promise.resolve();
  private workspace?: TelegramWorkspace;
  private integrations?: {
    catalogue: Catalogue;
    updates: UpdateMonitor;
    updater?: CodexUpdater;
    daddy?: Daddy;
    usage?: import('../core/usage.js').UsageBackend;
  };
  configure(value: {
    catalogue: Catalogue;
    updates: UpdateMonitor;
    updater?: CodexUpdater;
    daddy?: Daddy;
    usage?: import('../core/usage.js').UsageBackend;
  }) {
    this.integrations = value;
    if (value.daddy)
      this.workspace = new TelegramWorkspace(
        value.daddy,
        this.api,
        this.username,
        () => this.locale(),
        value.usage,
      );
  }
  private locale(): Locale {
    return this.engine.store.setting('preferences') ? preferences(this.engine.store).locale : 'ru';
  }
  constructor(
    private engine: Engine,
    private api: TelegramApi,
    readonly username: string,
    private publicOrigin?: string,
  ) {}
  pair() {
    const code = randomBytes(24).toString('base64url');
    this.engine.store.setSetting('telegram.pairCode', {
      hash: hash(code),
      expiresAt: new Date(Date.now() + 10 * 60000).toISOString(),
    });
    return { url: `https://t.me/${this.username}?start=${code}`, expiresInSeconds: 600 };
  }
  status() {
    return {
      configured: true,
      bot: this.username,
      paired: !!this.engine.store.setting('telegram.pairing'),
      workspace: this.workspace?.room(),
      error:
        this.engine.store.setting('telegram.error') ??
        this.engine.store.setting('telegram.pollError') ??
        null,
    };
  }
  unpair() {
    this.engine.store.transaction(() => {
      this.engine.store.setSetting('telegram.pairing', null);
      this.engine.store.setSetting('telegram.pairCode', null);
      this.engine.store.db.prepare('DELETE FROM bot_actions').run();
    });
    return { paired: false };
  }
  private paired() {
    return this.engine.store.setting<Pairing>('telegram.pairing');
  }
  start() {
    this.engine.store.changes.on('event', this.onEvent);
    this.polling = this.poll();
    this.currentUpdates();
    this.workspace?.replay();
  }
  private onEvent = (event: Event) => {
    if (this.workspace?.onEvent(event)) return;
    if (event.type === 'runtime.update_finished') {
      this.codexResult(event.data as CodexUpdateOperation);
      return;
    }
    if (['runtime.update_available', 'runtime.version_changed'].includes(event.type)) {
      this.updateNotice(event.data as UpdateNotice);
      return;
    }
    const preferences = notificationPreferences(this.engine.store);
    if (!this.paired() || !preferences.enabled) return;
    const state = (event.data as { state?: string }).state;
    if (event.type !== 'task.state' && event.type !== 'message.created') return;
    const snapshot = this.engine.store.getTask(event.taskId);
    if (snapshot.groupId && this.engine.store.getGroup(snapshot.groupId).orchestrated) return;
    const milestone =
      event.type === 'task.state' &&
      state &&
      [
        'awaiting_publication',
        'awaiting_plan_approval',
        'needs_input',
        'complete',
        'ready_for_review',
        'awaiting_push',
        'awaiting_checks',
      ].includes(state);
    const attention =
      milestone &&
      (['complete', 'needs_input', 'awaiting_plan_approval', 'awaiting_push'].includes(state!) ||
        (state === 'ready_for_review' && !snapshot.policy.autoPush) ||
        (state === 'awaiting_publication' && snapshot.policy.publication === 'human') ||
        (state === 'awaiting_checks' &&
          ['failing', 'missing'].includes(snapshot.pr?.checks ?? '')));
    if (
      preferences.mode === 'attention' ? !attention : !milestone && event.type !== 'message.created'
    )
      return;
    this.notices = this.notices
      .then(async () => {
        if (this.stopped || !notificationPreferences(this.engine.store).enabled) return;
        const store = this.engine.store,
          id =
            event.type === 'message.created'
              ? `telegram:event:${event.id}`
              : `telegram:state:${hash(JSON.stringify([event.taskId, snapshot.generation, snapshot.revision, state, snapshot.reason]))}`;
        if (store.db.prepare('SELECT 1 FROM notifications WHERE id=?').get(id)) return;
        const task = snapshot,
          pair = this.paired();
        if (!pair) return;
        let content: TelegramCard;
        if (event.type === 'message.created') {
          const message = store
            .messages(task.id)
            .find((m) => m.id === (event.data as { messageId: string }).messageId);
          if (!message || message.sender !== 'agent') return;
          content = agentCard(task, message.role, message.text, this.publicOrigin, this.locale());
        } else content = taskCard(task, this.publicOrigin, this.locale());
        // Lost sendMessage responses cannot be conclusively looked up. Keep an
        // uncertain notification instead of repeatedly sending it to the user.
        store.db.prepare('INSERT INTO notifications VALUES(?,?,?)').run(id, 'pending', now());
        try {
          await this.api.send(pair.chatId, content);
          store.db.prepare("UPDATE notifications SET status='sent' WHERE id=?").run(id);
        } catch (error) {
          store.setSetting('telegram.error', redact(String(error)));
        }
      })
      .catch((error) => this.engine.store.setSetting('telegram.error', redact(String(error))));
  };
  async handle(update: Update) {
    const store = this.engine.store;
    if (store.db.prepare('SELECT 1 FROM bot_receipts WHERE id=?').get(update.update_id)) return;
    store.db.prepare('INSERT INTO bot_receipts VALUES(?,?)').run(update.update_id, now());
    const message = update.message,
      callback = update.callback_query;
    const chat = message?.chat ?? callback?.message?.chat,
      from = message?.from ?? callback?.from;
    if (!chat || !from || from.is_bot) return;
    if (chat.type !== 'private') {
      await this.workspace?.handle(update);
      return;
    }
    let pair = this.paired();
    const code = message?.text?.match(/^\/start\s+([A-Za-z0-9_-]+)$/)?.[1];
    const expected = store.setting<{ hash: string; expiresAt: string }>('telegram.pairCode');
    if (code && expected && expected.expiresAt > now() && hash(code) === expected.hash) {
      pair = { chatId: chat.id, userId: from.id, username: this.username };
      store.transaction(() => {
        store.setSetting('telegram.pairing', pair);
        store.setSetting('telegram.pairCode', null);
        store.db.prepare('DELETE FROM bot_actions').run();
      });
      await this.api.send(
        chat.id,
        this.integrations?.daddy
          ? daddyHome(this.locale(), this.integrations.daddy.sessions())
          : welcomeCard(this.locale()),
      );
      this.currentUpdates();
      return;
    }
    if (!pair || pair.chatId !== chat.id || pair.userId !== from.id) return;
    if (await this.workspace?.handle(update)) return;
    try {
      if (callback) {
        await this.api.call('answerCallbackQuery', { callback_query_id: callback.id });
        if (await this.navigate(callback.data ?? '', chat.id)) return;
        const row = store.db
          .prepare('SELECT data,consumed FROM bot_actions WHERE id=?')
          .get(callback.data ?? '');
        if (!row || row.consumed)
          throw new Error('This confirmation expired or was already used. Send /publish again.');
        const action = JSON.parse(row.data as string) as Confirmation;
        if (action.expiresAt <= now() || action.chatId !== chat.id)
          throw new Error('Confirmation expired. Send /publish again.');
        await this.engine.lock(action.taskId, async () => {
          const task = store.getTask(action.taskId);
          if (
            task.generation !== action.generation ||
            task.review?.id !== action.reviewId ||
            task.revision?.head !== action.head ||
            task.state !== 'awaiting_publication' ||
            store.busy(task.id)
          )
            throw new Error('The task changed since this confirmation. Review its current state.');
          const snapshot = await this.engine
            .provider(prRef(task))
            .getReview(prRef(task), task.review);
          if (hash(JSON.stringify(snapshot)) !== action.snapshotHash)
            throw new Error('The review comments changed. Send /publish again.');
          store.db.prepare('UPDATE bot_actions SET consumed=1 WHERE id=?').run(callback.data!);
          await this.engine.broker.publish(task);
        });
        await this.engine.reconcile(action.taskId);
        await this.api.send(
          chat.id,
          noteCard(
            '✅ Ревью опубликовано',
            'Цикл работы продолжается автоматически.',
            this.locale(),
          ),
        );
        return;
      }
      const text = message?.text?.trim();
      if (!text) return;
      const language = text.match(/^\/language(?:\s+(en|ru))?$/i);
      if (language) {
        if (language[1]) setLocale(store, language[1].toLowerCase() as Locale);
        await this.api.send(chat.id, languageCard(this.locale()));
        return;
      }
      if (text === '/models') {
        await this.showModels(chat.id, false);
        return;
      }
      if (text === '/updates') {
        await this.showUpdates(chat.id, false);
        return;
      }
      if (text === '/tasks' || text === '/start') {
        await this.api.send(chat.id, tasksCard(store.tasks(), 0, this.locale()));
        return;
      }
      if (text === '/help') {
        await this.api.send(chat.id, helpCard(this.locale()));
        return;
      }
      if (/^\/notifications(?:\s+(on|off|all))?$/.test(text)) {
        const mode = text.split(/\s+/)[1];
        if (mode)
          store.setSetting('notifications.telegram', {
            enabled: mode !== 'off',
            mode: mode === 'all' ? 'all' : 'attention',
          });
        await this.api.send(
          chat.id,
          notificationsCard(notificationPreferences(store), this.locale()),
        );
        return;
      }
      if (text === '/web') {
        if (!this.publicOrigin)
          throw new Error('Configure a permanent HTTPS address with reviewctl web first.');
        const { Access } = await import('../server/access.js');
        const link = new Access(store, 'unused-telegram-pairing-root').pairing(
          'Telegram browser',
          this.publicOrigin,
        );
        const content = noteCard(
          '🌐 Войти в рабочее пространство',
          'Одноразовая ссылка действует 5 минут. Телефон должен быть подключён к сети сервера.',
          this.locale(),
        );
        content.buttons = [[{ text: 'Открыть рабочее пространство ↗', url: link.url }]];
        await this.api.send(chat.id, content);
        return;
      }
      const match = text.match(
        /^\/(status|reviewer|author|publish|pause|resume|retry)\s+([a-zA-Z0-9-]+)(?:\s+([\s\S]+))?$/,
      );
      if (!match) {
        await this.api.send(chat.id, helpCard(this.locale()));
        return;
      }
      const [, verb, prefix, content] = match,
        matches = store.tasks().filter((t) => t.id.startsWith(prefix));
      if (matches.length !== 1) throw new Error('Task ID is missing or ambiguous. Use /tasks.');
      const task = matches[0];
      if (verb === 'status') {
        await this.api.send(chat.id, taskCard(task, this.publicOrigin, this.locale()));
        return;
      }
      if (verb === 'author' || verb === 'reviewer') {
        if (!content?.trim()) throw new Error('Include a message after the task ID.');
        await this.engine.chat(task.id, verb, content);
        await this.api.send(
          chat.id,
          noteCard(
            verb === 'author' ? '✍️ Сообщение передано автору' : '🔎 Сообщение передано ревьюеру',
            'Сообщение поставлено в очередь. Историю можно открыть в рабочем пространстве.',
            this.locale(),
          ),
        );
        return;
      }
      if (verb === 'publish') {
        await this.confirm(task, chat.id);
        return;
      }
      const result =
        verb === 'retry'
          ? task.ref.kind === 'ticket'
            ? await this.engine.retryTicket(task.id)
            : await this.engine.review(task.id, true)
          : await this.engine.action(task.id, verb as 'pause' | 'resume');
      await this.api.send(chat.id, taskCard(result, this.publicOrigin, this.locale()));
    } catch (error) {
      await this.api.send(chat.id, errorCard(redact((error as Error).message), this.locale()));
    }
  }
  private async confirm(task: Task, chatId: number) {
    if (
      task.state !== 'awaiting_publication' ||
      !task.review ||
      !task.reviewFinished ||
      this.engine.store.busy(task.id)
    )
      throw new Error('A finished, idle draft review is required before publication.');
    const snapshot = await this.engine.provider(prRef(task)).getReview(prRef(task), task.review);
    if (snapshot.status !== 'draft')
      throw new Error('This review is no longer an unpublished draft.');
    const id = randomBytes(18).toString('base64url');
    const action: Confirmation = {
      taskId: task.id,
      generation: task.generation,
      reviewId: task.review.id,
      head: task.revision!.head,
      snapshotHash: hash(JSON.stringify(snapshot)),
      expiresAt: new Date(Date.now() + 5 * 60000).toISOString(),
      chatId,
    };
    this.engine.store.db
      .prepare('INSERT INTO bot_actions(id,data) VALUES(?,?)')
      .run(id, JSON.stringify(action));
    await this.api.send(chatId, publishCard(task, snapshot, id, this.locale()));
  }
  private async navigate(data: string, chatId: number): Promise<boolean> {
    if (data.startsWith('codex:')) {
      const updater = this.integrations?.updater,
        pair = this.paired();
      if (!updater || !pair) throw new Error('Codex updates are unavailable');
      const audience = `telegram:${pair.chatId}:${pair.userId}`;
      if (data === 'codex:install' || data === 'codex:rollback') {
        const plan = await updater.prepare(
          data === 'codex:install' ? 'install' : 'rollback',
          audience,
        );
        await this.api.send(chatId, codexConfirmationCard(this.locale(), plan));
      } else if (/^codex:confirm:[A-Za-z0-9_-]{24}$/.test(data)) {
        const operation = updater.confirm(data.slice('codex:confirm:'.length), audience);
        await this.api.send(chatId, codexOperationCard(this.locale(), operation));
      } else throw new Error('Invalid Codex update action');
      return true;
    }
    const language = data.match(/^language:(en|ru|show)$/);
    if (language) {
      if (language[1] !== 'show') setLocale(this.engine.store, language[1] as Locale);
      await this.api.send(chatId, languageCard(this.locale()));
      return true;
    }
    if (data === 'models:refresh') {
      await this.showModels(chatId, true);
      return true;
    }
    const updates = data.match(/^updates:(show|check|on|off)$/);
    if (updates) {
      if (['on', 'off'].includes(updates[1]))
        this.engine.store.setSetting('updates.notifications', updates[1] === 'on');
      await this.showUpdates(chatId, updates[1] === 'check');
      return true;
    }

    if (data === 'help') {
      await this.api.send(chatId, helpCard(this.locale()));
      return true;
    }
    const list = data.match(/^tasks:(\d{1,8})$/);
    if (list) {
      await this.api.send(
        chatId,
        tasksCard(this.engine.store.tasks(), Number(list[1]), this.locale()),
      );
      return true;
    }
    const task = data.match(/^(task|publish):([a-f0-9-]{36})$/);
    if (task) {
      const current = this.engine.store.getTask(task[2]);
      if (task[1] === 'publish') await this.confirm(current, chatId);
      else await this.api.send(chatId, taskCard(current, this.publicOrigin, this.locale()));
      return true;
    }
    const prefs = data.match(/^notifications:(show|on|off|all)$/);
    if (prefs) {
      if (prefs[1] !== 'show')
        this.engine.store.setSetting('notifications.telegram', {
          enabled: prefs[1] !== 'off',
          mode: prefs[1] === 'all' ? 'all' : 'attention',
        });
      await this.api.send(
        chatId,
        notificationsCard(notificationPreferences(this.engine.store), this.locale()),
      );
      return true;
    }
    return false;
  }

  private async showModels(chatId: number, refresh: boolean) {
    if (!this.integrations) throw new Error('Model catalogue is unavailable');
    const models = await this.integrations.catalogue.list(refresh);
    await this.api.send(
      chatId,
      modelsCard(
        this.locale(),
        this.engine.defaultAgents(),
        models,
        this.integrations.catalogue.metadata?.(),
      ),
    );
  }
  private async showUpdates(chatId: number, refresh: boolean) {
    if (!this.integrations) throw new Error('Update checks are unavailable');
    const status = refresh
      ? await this.integrations.updates.check(true)
      : this.integrations.updates.status();
    await this.api.send(
      chatId,
      updatesCard(this.locale(), status, this.integrations.updater?.status()),
    );
  }
  private currentUpdates() {
    const operation = this.integrations?.updater?.status().operation;
    if (operation && ['complete', 'failed'].includes(operation.phase)) this.codexResult(operation);
    const status = this.integrations?.updates.status();
    if (!status?.checkedAt) return;
    for (const tool of status.tools) {
      if (tool.updateAvailable)
        this.updateNotice({ kind: 'available', tool, checkedAt: status.checkedAt });
      if (tool.changedFrom)
        this.updateNotice({ kind: 'changed', tool, checkedAt: status.checkedAt });
    }
  }
  private codexResult(operation: CodexUpdateOperation) {
    const store = this.engine.store;
    this.notices = this.notices
      .then(async () => {
        const pair = this.paired();
        if (this.stopped || !pair) return;
        const id = `telegram:codex-update:${operation.id}`;
        if (store.db.prepare('SELECT 1 FROM notifications WHERE id=?').get(id)) return;
        store.db.prepare('INSERT INTO notifications VALUES(?,?,?)').run(id, 'pending', now());
        await this.api.send(pair.chatId, codexOperationCard(this.locale(), operation));
        store.db.prepare("UPDATE notifications SET status='sent' WHERE id=?").run(id);
      })
      .catch((error) => store.setSetting('telegram.error', redact(String(error))));
    void this.integrations?.updates.check(true).catch(() => {});
  }
  private updateNotice(notice: UpdateNotice) {
    // The managed operation already has its own durable completion message.
    if (notice.kind === 'changed' && notice.tool.managedOperationId) return;
    if (!notice.tool.supported || !this.paired()) return;
    const store = this.engine.store;
    const enabled = () =>
      notificationPreferences(store).enabled &&
      (store.setting<boolean>('updates.notifications') ?? true);
    if (!enabled()) return;
    this.notices = this.notices
      .then(async () => {
        const pair = this.paired();
        if (this.stopped || !pair || !enabled()) return;
        const id = `telegram:runtime:${notice.kind}:${notice.tool.id}:${notice.tool.installed}:${notice.kind === 'available' ? notice.tool.latest : notice.tool.changedFrom}`;
        if (store.db.prepare('SELECT 1 FROM notifications WHERE id=?').get(id)) return;
        store.db.prepare('INSERT INTO notifications VALUES(?,?,?)').run(id, 'pending', now());
        try {
          await this.api.send(pair.chatId, updateCard(this.locale(), notice));
          store.db.prepare("UPDATE notifications SET status='sent' WHERE id=?").run(id);
        } catch (error) {
          store.setSetting('telegram.error', redact(String(error)));
        }
      })
      .catch((error) => store.setSetting('telegram.error', redact(String(error))));
  }
  private async poll() {
    while (!this.stopped) {
      this.controller = new AbortController();
      try {
        const offset = this.engine.store.setting<number>('telegram.offset') ?? 0;
        const updates = await this.api.call<Update[]>(
          'getUpdates',
          { offset, timeout: 25, allowed_updates: ['message', 'callback_query'] },
          AbortSignal.any([this.controller.signal, AbortSignal.timeout(35000)]),
        );
        this.engine.store.setSetting('telegram.pollError', null);
        for (const update of updates) {
          if (this.stopped) break;
          try {
            await this.handle(update);
          } catch (error) {
            this.engine.store.setSetting('telegram.error', redact(String(error)));
          }
          this.engine.store.setSetting('telegram.offset', update.update_id + 1);
        }
      } catch (error) {
        if (!this.stopped) {
          this.engine.store.setSetting('telegram.pollError', redact(String(error)));
          await delay(3000, undefined, { signal: this.controller.signal }).catch(() => {});
        }
      }
    }
  }
  async stop() {
    this.stopped = true;
    this.controller?.abort();
    this.engine.store.changes.off('event', this.onEvent);
    await this.polling;
    await this.notices;
    await this.workspace?.stop();
  }
  static async create(
    engine: Engine,
    tokenFile: string,
    publicOrigin?: string,
    signal?: AbortSignal,
  ) {
    const api = new TelegramApi(readFileSync(tokenFile, 'utf8').trim());
    const me = await api.call<{ id: number; username: string }>('getMe', {}, signal),
      webhook = await api.call<{ url: string }>('getWebhookInfo', {}, signal);
    if (webhook.url)
      throw new Error(
        'This bot already uses a webhook. Configure a dedicated bot; Reviewloop will not remove another integration.',
      );
    if (!Number.isSafeInteger(me.id) || !me.username)
      throw new Error('Telegram returned an invalid bot identity');
    if (engine.store.setting<number>('telegram.botId') !== me.id) {
      engine.store.transaction(() => {
        engine.store.setSetting('telegram.botId', me.id);
        engine.store.setSetting('telegram.offset', 0);
        engine.store.setSetting('telegram.pairing', null);
        engine.store.setSetting('telegram.pairCode', null);
        engine.store.db.prepare('DELETE FROM bot_receipts').run();
        engine.store.db.prepare('DELETE FROM bot_actions').run();
      });
    }
    return new Telegram(engine, api, me.username, publicOrigin);
  }
}
