import {
  commitTelegramOperation,
  operationDestination,
  resultKey,
  type TelegramOperationResult,
} from './telegram-receipts.js';
import { commandHelp, telegramCommands, normalizeTelegramText } from './telegram-commands.js';
import { requestedMenu, handleMenuRequest, menuDelivery } from './telegram-menu-request.js';
import type { CleanupControls } from '../ops/cleanup-controls.js';
import { cleanupControlCard, cleanupCommand } from './telegram-cleanup.js';
import { randomBytes, createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import type { Engine } from '../core/engine.js';
import { AppError, now, type Event } from '../core/types.js';
import { rememberSecret, redact } from '../core/security.js';
import { notificationPreferences } from './notifications.js';
import {
  splitTelegramText,
  TelegramText,
  type TelegramCard,
  type TelegramButton,
} from './telegram-text.js';
import { notificationsCard, noteCard, errorCard, scheduledCleanupCard } from './telegram-cards.js';
import { preferences, setLocale } from '../core/preferences.js';
import type { Locale } from '../i18n/index.js';
import type { Catalogue } from '../server/planning.js';
import type { UpdateMonitor, UpdateNotice } from '../core/updates.js';
import type { RuntimeUpdaters, RuntimeUpdateOperation } from '../core/runtime-updater.js';
import type { Daddy } from '../core/daddy.js';
import { TelegramWorkspace } from './telegram-workspace.js';
import { TelegramDelivery, deliveryStatus, type DeliveryOptions } from './telegram-delivery.js';
import { daddyHome } from './daddy-cards.js';
import type { Speech } from '../runtime/speech.js';
import type { ResourceStatus } from '../core/types.js';
import { lastScheduledCleanup, type CleanupReport } from '../ops/scheduled-cleanup.js';
import {
  runtimeConfirmationCard,
  runtimeOperationCard,
  languageCard,
  modelsCard,
  updateCard,
  updatesCard,
} from './telegram-meta.js';
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const updateRetentionMs = 24 * 60 * 60 * 1000;
type User = { id: number; is_bot?: boolean; username?: string; first_name?: string };
type Chat = { id: number; type: string; title?: string; is_forum?: boolean };
export interface Update {
  update_id: number;
  message?: {
    text?: string;
    caption?: string;
    document?: { file_id: string; file_size?: number; file_name?: string };
    chat: Chat;
    from?: User;
    message_thread_id?: number;
    message_id?: number;
    reply_to_message?: {
      message_id: number;
      chat: Chat;
      message_thread_id?: number;
      from?: User;
      text?: string;
      caption?: string;
      forum_topic_created?: unknown;
    };
    quote?: { text: string; position: number; is_manual?: boolean };
    external_reply?: { chat?: Chat; message_id?: number };
    voice?: {
      file_id: string;
      file_unique_id: string;
      duration: number;
      file_size?: number;
      mime_type?: string;
    };
    chat_shared?: { request_id: number; chat_id: number; title?: string };
  };
  callback_query?: {
    id: string;
    data?: string;
    from: User;
    message?: { chat: Chat; message_thread_id?: number; message_id?: number };
  };
}
type Pairing = { chatId: number; userId: number; username: string; ownerLabel?: string };
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
  private navigation = new AsyncLocalStorage<{
    chatId: number;
    threadId?: number;
    messageId: number;
    replied: boolean;
    active: boolean;
    deliveryManaged?: boolean;
  }>();
  delivery?: TelegramDelivery;
  onCleanupError?: (error: unknown) => void;
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
      'getFile',
    ].includes(method);
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await this.fetcher(`https://api.telegram.org/bot${this.token}/${method}`, {
          method: 'POST',
          ...(body instanceof FormData
            ? { body }
            : {
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
              }),
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
        let value: {
          ok: boolean;
          result?: T;
          description?: string;
          error_code?: number;
          parameters?: { retry_after?: number };
        };
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
          throw Object.assign(
            new AppError(
              'telegram_error',
              redact(value.description ?? `Telegram HTTP ${response.status}`),
              502,
            ),
            {
              retryAfter: value.parameters?.retry_after,
              telegramStatus: value.error_code ?? response.status,
            },
          );
        const navigation = this.navigation.getStore();
        const outgoing = body as { chat_id?: number; message_thread_id?: number };
        if (
          method === 'sendMessage' &&
          navigation?.active &&
          outgoing?.chat_id === navigation.chatId &&
          outgoing.message_thread_id === navigation.threadId
        )
          navigation.replied = true;
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
  async replaceCard<T>(
    callback: NonNullable<Update['callback_query']>,
    action: () => Promise<T>,
  ): Promise<T> {
    const message = callback.message;
    if (!message?.message_id || !Number.isSafeInteger(message.message_id)) return action();
    const navigation = {
      chatId: message.chat.id,
      threadId: message.message_thread_id,
      messageId: message.message_id,
      replied: false,
      active: true,
      deliveryManaged: false,
    };
    let result: T;
    try {
      result = await this.navigation.run(navigation, action);
    } finally {
      navigation.active = false;
    }
    if (navigation.replied && !navigation.deliveryManaged) {
      try {
        await this.call('deleteMessage', {
          chat_id: navigation.chatId,
          message_id: navigation.messageId,
        });
      } catch (error) {
        // The action already succeeded. A failed cleanup must not repeat it or replace its result with an error.
        try {
          this.onCleanupError?.(error);
        } catch {
          /* Notification cleanup cannot fail the completed action. */
        }
      }
    }
    return result;
  }
  async sendInstructions(chatId: number, value: unknown) {
    const form = new FormData();
    form.set('chat_id', String(chatId));
    form.set(
      'document',
      new Blob([JSON.stringify(value, null, 2) + '\n'], {
        type: 'application/json',
      }),
      'daddy-instructions.json',
    );
    await this.call('sendDocument', form);
  }

  downloadVoice(fileId: string, signal?: AbortSignal) {
    return this.downloadFile(
      fileId,
      10 * 1024 * 1024,
      'Voice messages can be at most 10 MB',
      signal,
    );
  }

  async downloadFile(
    fileId: string,
    limit: number,
    sizeError: string,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    const file = await this.call<{ file_path?: string; file_size?: number }>(
      'getFile',
      { file_id: fileId },
      signal,
    );
    if (
      !file.file_path ||
      !/^[A-Za-z0-9_./-]+$/.test(file.file_path) ||
      file.file_path.split('/').some((part) => part === '..' || part === '.') ||
      file.file_path.startsWith('/')
    )
      throw new AppError(
        'voice_file_invalid',
        limit === 10 * 1024 * 1024
          ? 'Telegram returned an invalid voice file path'
          : 'Telegram returned an invalid file path',
      );
    if (file.file_size && file.file_size > limit) throw new AppError('voice_too_large', sizeError);
    try {
      const response = await this.fetcher(
        `https://api.telegram.org/file/bot${this.token}/${file.file_path}`,
        {
          redirect: 'manual',
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(60000)])
            : AbortSignal.timeout(60000),
        },
      );
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new AppError('voice_download_failed', 'Could not download the Telegram file');
      }
      if (Number(response.headers.get('content-length')) > limit) {
        await response.body.cancel();
        throw new AppError('voice_too_large', sizeError);
      }
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > limit) throw new AppError('voice_too_large', sizeError);
        chunks.push(chunk);
      }
      return Buffer.concat(chunks);
    } catch (error) {
      throw error instanceof AppError ? error : networkFailure(error);
    }
  }
  async send(
    destination: number | { chatId: number; threadId?: number },
    content: string | TelegramCard,
    buttons?: TelegramButton[][],
    delivery?: DeliveryOptions,
  ) {
    const chatId = typeof destination === 'number' ? destination : destination.chatId;
    const value = typeof content === 'string' ? new TelegramText().add(content) : content;
    const chunks = splitTelegramText(value);
    const keyboard = buttons ?? (value as TelegramCard).buttons;
    if (this.delivery) {
      const navigation = this.navigation.getStore();
      const target = typeof destination === 'number' ? { chatId: destination } : destination;
      const cleanup =
        navigation?.active &&
        target.chatId === navigation.chatId &&
        target.threadId === navigation.threadId
          ? { chatId: navigation.chatId, messageId: navigation.messageId }
          : undefined;
      if (cleanup) navigation!.deliveryManaged = true;
      return this.delivery.send(
        target,
        { ...value, ...(keyboard ? { buttons: keyboard } : {}) },
        { ...menuDelivery(this, target, delivery), deletePrevious: cleanup },
      );
    }
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
  private menuSetup?: Promise<void>;
  private menuError?: string;
  private menuController?: AbortController;
  private pollError?: string;
  private notices = Promise.resolve();
  private workspace?: TelegramWorkspace;
  private integrations?: {
    catalogue: Catalogue;
    updates: UpdateMonitor;
    updaters?: RuntimeUpdaters;
    cleanup?: CleanupControls;
    daddy?: Daddy;
    usage?: import('../core/usage.js').UsageBackend;
    voice?: { dataDir: string; speech: Speech; resources: () => ResourceStatus };
  };
  configure(value: {
    catalogue: Catalogue;
    updates: UpdateMonitor;
    updaters?: RuntimeUpdaters;
    cleanup?: CleanupControls;
    daddy?: Daddy;
    usage?: import('../core/usage.js').UsageBackend;
    voice?: { dataDir: string; speech: Speech; resources: () => ResourceStatus };
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
    if (value.voice)
      this.workspace?.configureVoice(
        value.voice.dataDir,
        value.voice.speech,
        value.voice.resources,
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
  ) {
    this.api.delivery = new TelegramDelivery(
      engine.store,
      this.api,
      `${username}:${engine.store.setting('telegram.botId') ?? 'local'}`,
    );
    this.api.onCleanupError = (error) =>
      this.engine.store.event('_system', 'telegram.card_cleanup_failed', {
        error: redact(error instanceof Error ? error.message : String(error)),
      });
  }
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
      delivery: this.api.delivery?.status(),
      group: this.workspace?.room(),
      error:
        this.pollError ?? this.menuError ?? this.engine.store.setting('telegram.error') ?? null,
    };
  }
  unpair() {
    this.engine.store.transaction(() => {
      this.engine.store.setSetting('telegram.pairing', null);
      this.engine.store.setSetting('telegram.currentDaddy', null);
      this.engine.store.setSetting('telegram.pairCode', null);
      this.engine.store.db.prepare('DELETE FROM bot_actions').run();
    });
    return { paired: false };
  }
  private paired() {
    return this.engine.store.setting<Pairing>('telegram.pairing');
  }
  start() {
    this.api.delivery?.start();
    this.engine.store.changes.on('event', this.onEvent);
    this.polling = this.poll();
    this.menuController = new AbortController();
    this.menuSetup = this.installCommandMenus(this.menuController.signal);
    this.currentUpdates();
    this.workspace?.start();
    const cleanup = lastScheduledCleanup(this.engine.store);
    if (cleanup) this.cleanupNotice(cleanup);
  }
  private onEvent = (event: Event) => {
    if (this.workspace?.onEvent(event)) return;
    if (event.type === 'cache.scheduled_finished') {
      this.cleanupNotice(event.data as CleanupReport);
      return;
    }
    if (event.type === 'runtime.update_finished') {
      this.runtimeResult(event.data as RuntimeUpdateOperation);
      return;
    }
    if (['runtime.update_available', 'runtime.version_changed'].includes(event.type)) {
      this.updateNotice(event.data as UpdateNotice);
      return;
    }
  };
  async handle(update: Update) {
    const store = this.engine.store;
    if (update.message) {
      const message = update.message;
      const text = normalizeTelegramText(message.text, this.username);
      const caption = normalizeTelegramText(message.caption, this.username);
      if ((message.text && text === undefined) || (message.caption && caption === undefined))
        return;
      update = { ...update, message: { ...message, text, caption } };
    }
    const pending = resultKey(update.update_id);
    if (store.db.prepare('SELECT 1 FROM bot_receipts WHERE id=?').get(update.update_id)) {
      const result = store.setting<TelegramOperationResult>(pending);
      const source = operationDestination(update);
      const pair = this.paired();
      if (
        result &&
        pair &&
        source?.ownerId === pair.userId &&
        result.ownerId === pair.userId &&
        source.chatId === result.chatId &&
        source.threadId === result.threadId &&
        (source.chatId === pair.chatId || this.workspace?.room()?.chatId === source.chatId)
      ) {
        await this.api.send(
          result,
          this.locale() === 'ru' ? 'Действие уже выполнено.' : 'This action has already completed.',
          undefined,
          { key: pending },
        );
        this.clearOperationResult(pending);
      }
      return;
    }
    const menu = requestedMenu(update, this.username);
    if (menu)
      await handleMenuRequest(this.api, menu, this.workspace?.groupAt(menu), () =>
        this.handleUpdate(update),
      );
    else await this.handleUpdate(update);
    store.db.prepare('INSERT OR IGNORE INTO bot_receipts VALUES(?,?)').run(update.update_id, now());
    this.clearOperationResult(pending);
  }
  private clearOperationResult(key: string) {
    this.engine.store.db.prepare('DELETE FROM settings WHERE key=?').run(key);
  }
  private async handleUpdate(update: Update) {
    const store = this.engine.store;
    const message = update.message;
    const sender = update.callback_query?.from ?? message?.from;
    const ownerLabel = sender?.username ? '@' + sender.username : sender?.first_name;
    const paired = this.paired();
    if (paired && ownerLabel && sender?.id === paired.userId && paired.ownerLabel !== ownerLabel)
      store.setSetting('telegram.pairing', { ...paired, ownerLabel });
    if (
      this.workspace &&
      (message?.voice ||
        (message?.text &&
          (!message.text.trim().startsWith('/') ||
            /^\/(task|worker)(?:@\w+)?(?:\s|$)/.test(message.text.trim()))))
    ) {
      // Persist voice, conversation input and task commands before acknowledging the update.
      const handled = await this.workspace.handle(update);
      if (handled) this.queueAcceptedReaction(message);
      return;
    }
    const callback = update.callback_query;
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
      pair = {
        chatId: chat.id,
        userId: from.id,
        username: this.username,
        ownerLabel: from.username ? '@' + from.username : from.first_name,
      };
      store.transaction(() => {
        if (this.paired()?.userId !== pair!.userId) store.setSetting('telegram.currentDaddy', null);
        store.setSetting('telegram.pairing', pair);
        store.setSetting('telegram.pairCode', null);
        store.db.prepare('DELETE FROM bot_actions').run();
      });
      await this.api.send(
        chat.id,
        daddyHome(
          this.locale(),
          this.engine.store.groups().filter((group) => group.orchestrated),
        ),
      );
      this.currentUpdates();
      return;
    }
    if (!pair || pair.chatId !== chat.id || pair.userId !== from.id) return;
    const cleanupUpdate = hash(
      JSON.stringify([
        store.setting('telegram.botId') ?? this.username,
        pair.userId,
        chat.id,
        update.update_id,
      ]),
    );
    const cleanup = message?.text
      ?.replace(/^\/start cleanup$/, '/cleanup')
      .trim()
      .match(/^\/cleanup(?:@(\w+))?(?:\s+([\s\S]+))?$/i);
    if (cleanup && (!cleanup[1] || cleanup[1].toLowerCase() === this.username.toLowerCase())) {
      try {
        await this.showCleanup(chat.id, cleanupCommand(cleanup[2]), update, cleanupUpdate);
      } catch (error) {
        if (
          store.setting(resultKey(update.update_id)) ||
          this.integrations?.cleanup?.hasTelegramUpdate(cleanupUpdate)
        )
          throw error;
        await this.api.send(chat.id, errorCard(redact((error as Error).message), this.locale()));
      }
      return;
    }
    if (await this.workspace?.handle(update)) return;
    try {
      if (callback) {
        await this.api.replaceCard(callback, async () => {
          await this.api.call('answerCallbackQuery', { callback_query_id: callback.id });
          if (!(await this.navigate(callback.data ?? '', chat.id, update, cleanupUpdate)))
            throw new Error('Unknown action. Open the current menu with /start.');
        });
        return;
      }
      const text = message?.text?.trim();
      if (!text) return;
      const help = /^\/help(?:@(\w+))?(?:\s+([\s\S]+))?$/i.exec(text);
      if (help && (!help[1] || help[1].toLowerCase() === this.username.toLowerCase())) {
        await this.api.send(chat.id, commandHelp(this.locale(), 'private', help[2]));
        return;
      }
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
      if (text === '/updates' || text === '/start updates') {
        await this.showUpdates(chat.id, false);
        return;
      }
      if (/^\/notifications(?:\s+(on|off|all))?$/.test(text)) {
        const mode = text.split(/\s+/)[1];
        if (mode)
          store.transaction(() => {
            store.setSetting('notifications.telegram', {
              enabled: mode !== 'off',
              mode: mode === 'all' ? 'all' : 'attention',
            });
            commitTelegramOperation(store, update.update_id, operationDestination(update));
          });
        await this.api.send(
          chat.id,
          notificationsCard(notificationPreferences(store), this.locale()),
        );
        return;
      }
      if (text === '/web' || text === '/start web') {
        if (!this.publicOrigin)
          throw new Error('Configure a permanent HTTPS address with daddy web first.');
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
      await this.api.send(
        chat.id,
        daddyHome(
          this.locale(),
          this.engine.store.groups().filter((group) => group.orchestrated),
        ),
      );
    } catch (error) {
      if (
        store.setting(resultKey(update.update_id)) ||
        this.integrations?.cleanup?.hasTelegramUpdate(cleanupUpdate)
      )
        throw error;
      await this.api.send(chat.id, errorCard(redact((error as Error).message), this.locale()));
    }
  }
  private async showCleanup(
    chatId: number,
    patch: Record<string, unknown> | undefined,
    update: Update,
    cleanupUpdate: string,
  ) {
    const control = this.integrations?.cleanup;
    if (!control) throw new Error('Disk cleanup is unavailable');
    if (!patch) {
      await this.api.send(chatId, cleanupControlCard(this.locale(), control.status()));
      return;
    }
    const completed = control.hasTelegramUpdate(cleanupUpdate);
    const status = completed ? control.status() : await control.update(patch, cleanupUpdate);
    const store = this.engine.store;
    store.transaction(() =>
      commitTelegramOperation(store, update.update_id, operationDestination(update)),
    );
    await this.api.send(
      chatId,
      completed
        ? this.locale() === 'ru'
          ? 'Действие уже выполнено.'
          : 'This action has already completed.'
        : cleanupControlCard(this.locale(), status),
    );
  }

  private async navigate(
    data: string,
    chatId: number,
    update: Update,
    cleanupUpdate: string,
  ): Promise<boolean> {
    if (['cleanup:show', 'cleanup:on', 'cleanup:off'].includes(data)) {
      await this.showCleanup(
        chatId,
        data === 'cleanup:show' ? undefined : { enabled: data === 'cleanup:on' },
        update,
        cleanupUpdate,
      );
      return true;
    }
    if (data.startsWith('u:')) {
      const match = /^u:([a-z][a-z0-9-]{0,31}):(install|rollback|c)(?::([A-Za-z0-9_-]{24}))?$/.exec(
        data,
      );
      const pair = this.paired();
      if (!match || !pair || !this.integrations?.updaters)
        throw new Error('CLI updates are unavailable');
      const updater = this.integrations.updaters.get(match[1]);
      const audience = `telegram:${pair.chatId}:${pair.userId}`;
      if (match[2] === 'c' && match[3]) {
        await this.api.send(
          chatId,
          runtimeOperationCard(this.locale(), updater.confirm(match[3], audience)),
        );
      } else if ((match[2] === 'install' || match[2] === 'rollback') && !match[3]) {
        const plan = await updater.prepare(match[2], audience);
        await this.api.send(chatId, runtimeConfirmationCard(this.locale(), plan));
      } else throw new Error('Invalid CLI update action');
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
      updatesCard(this.locale(), status, this.integrations.updaters?.status()),
    );
  }
  private currentUpdates() {
    for (const item of this.integrations?.updaters?.status() ?? []) {
      const operation = item.operation;
      if (operation && ['complete', 'failed'].includes(operation.phase))
        this.runtimeResult(operation);
    }
    const status = this.integrations?.updates.status();
    if (!status?.checkedAt) return;
    for (const tool of status.tools) {
      if (tool.updateAvailable)
        this.updateNotice({ kind: 'available', tool, checkedAt: status.checkedAt });
      if (tool.changedFrom)
        this.updateNotice({ kind: 'changed', tool, checkedAt: status.checkedAt });
    }
  }
  private runtimeResult(operation: RuntimeUpdateOperation) {
    const store = this.engine.store;
    this.notices = this.notices
      .then(async () => {
        const pair = this.paired();
        if (this.stopped || !pair) return;
        const id = `telegram:runtime-update:${operation.engine}:${operation.id}`;
        if (
          ['sent', 'superseded'].includes(
            String(store.db.prepare('SELECT status FROM notifications WHERE id=?').get(id)?.status),
          )
        )
          return;
        store.db
          .prepare('INSERT OR IGNORE INTO notifications VALUES(?,?,?)')
          .run(id, 'pending', now());
        const result = await this.api.send(
          pair.chatId,
          runtimeOperationCard(this.locale(), operation),
          undefined,
          { key: id, notificationId: id },
        );
        store.db
          .prepare('UPDATE notifications SET status=? WHERE id=?')
          .run(deliveryStatus(result), id);
      })
      .catch((error) => store.setSetting('telegram.error', redact(String(error))));
    void this.integrations?.updates.check(true).catch(() => {});
  }
  private updateNotice(notice: UpdateNotice) {
    // The managed operation already has its own durable completion message.
    if (notice.kind === 'changed' && notice.tool.managedOperationId) return;
    if (!this.paired()) return;
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
        if (
          ['sent', 'superseded'].includes(
            String(store.db.prepare('SELECT status FROM notifications WHERE id=?').get(id)?.status),
          )
        )
          return;
        store.db
          .prepare('INSERT OR IGNORE INTO notifications VALUES(?,?,?)')
          .run(id, 'pending', now());
        try {
          const result = await this.api.send(
            pair.chatId,
            updateCard(this.locale(), notice),
            undefined,
            { key: id, notificationId: id },
          );
          store.db
            .prepare('UPDATE notifications SET status=? WHERE id=?')
            .run(deliveryStatus(result), id);
        } catch (error) {
          store.setSetting('telegram.error', redact(String(error)));
        }
      })
      .catch((error) => store.setSetting('telegram.error', redact(String(error))));
  }
  private queueAcceptedReaction(message: NonNullable<Update['message']>) {
    const messageId = message.message_id;
    if (!messageId || !Number.isSafeInteger(messageId) || messageId < 1) return;
    if (!message.from || message.from.id !== this.paired()?.userId) return;
    const store = this.engine.store;
    const receipt = `telegram:${message.chat.id}:${messageId}`;
    const accepted =
      store.setting(`daddy.receipt:${receipt}`) ||
      store.db.prepare('SELECT 1 FROM voice_jobs WHERE id=?').get(hash(receipt));
    if (accepted)
      this.api.delivery?.enqueueReaction(
        { chatId: message.chat.id, threadId: message.message_thread_id },
        messageId,
      );
  }
  private cleanupNotice(report: CleanupReport) {
    const store = this.engine.store;
    this.notices = this.notices
      .then(async () => {
        const pair = this.paired();
        if (this.stopped || !pair || !notificationPreferences(store).enabled) return;
        await this.api.send(pair.chatId, scheduledCleanupCard(this.locale(), report), undefined, {
          key: `cache-scheduled:${report.id}`,
        });
      })
      .catch((error) => store.setSetting('telegram.error', redact(String(error))));
  }
  private async installCommandMenus(signal: AbortSignal) {
    for (const scope of ['private', 'group'] as const) {
      for (const language of ['', 'ru', 'en'] as const) {
        const commands = telegramCommands(language || 'en', scope);
        let delayMs = 3000;
        while (!signal.aborted) {
          try {
            await this.api.call(
              'setMyCommands',
              {
                scope: { type: scope === 'private' ? 'all_private_chats' : 'all_group_chats' },
                ...(language ? { language_code: language } : {}),
                commands,
              },
              signal,
            );
            break;
          } catch (error) {
            if (signal.aborted) return;
            this.menuError = redact(String(error));
            await delay(delayMs, undefined, { signal }).catch(() => {});
            delayMs = Math.min(delayMs * 2, 300000);
          }
        }
      }
    }
    if (!signal.aborted) this.menuError = undefined;
  }
  private async poll() {
    const store = this.engine.store;
    while (!this.stopped) {
      this.controller = new AbortController();
      try {
        // Telegram can start a new update ID sequence after a week of inactivity.
        const age = Date.now() - (store.setting<number>('telegram.offsetAt') ?? 0);
        const offset =
          age >= 0 && age < updateRetentionMs ? (store.setting<number>('telegram.offset') ?? 0) : 0;
        const updates = await this.api.call<Update[]>(
          'getUpdates',
          { offset, timeout: 25, allowed_updates: ['message', 'callback_query'] },
          AbortSignal.any([this.controller.signal, AbortSignal.timeout(35000)]),
        );
        for (const update of updates) {
          if (this.stopped) break;
          await this.handle(update);
          store.transaction(() => {
            store.setSetting('telegram.offset', update.update_id + 1);
            store.setSetting('telegram.offsetAt', Date.now());
          });
        }
        this.pollError = undefined;
      } catch (error) {
        if (!this.stopped) {
          this.pollError = redact(String(error));
          await delay(3000, undefined, { signal: this.controller.signal }).catch(() => {});
        }
      }
    }
  }
  async stop() {
    this.stopped = true;
    this.controller?.abort();
    this.menuController?.abort();
    await this.menuSetup;
    await this.api.delivery?.stop();
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
        'This bot already uses a webhook. Configure a dedicated bot; daddyloop will not remove another integration.',
      );
    if (!Number.isSafeInteger(me.id) || !me.username)
      throw new Error('Telegram returned an invalid bot identity');
    const previousBot = engine.store.setting<number>('telegram.botId');
    if (previousBot !== me.id) {
      engine.store.transaction(() => {
        const previousOwner = engine.store.setting<{ userId: number }>('telegram.pairing')?.userId;
        if (
          previousBot !== undefined &&
          previousOwner !== undefined &&
          !engine.store.setting('telegram.legacyQueueOwner')
        )
          engine.store.setSetting('telegram.legacyQueueOwner', {
            bot: previousBot,
            owner: previousOwner,
          });
        engine.store.setSetting('telegram.botId', me.id);
        engine.store.setSetting('telegram.offset', 0);
        engine.store.setSetting('telegram.offsetAt', null);
        engine.store.setSetting('telegram.pairing', null);
        engine.store.setSetting('telegram.pairCode', null);
        engine.store.db.prepare('DELETE FROM bot_receipts').run();
        engine.store.db
          .prepare("DELETE FROM settings WHERE key GLOB 'telegram.operationResult:*'")
          .run();
        engine.store.db.prepare('DELETE FROM bot_actions').run();
      });
    }
    return new Telegram(engine, api, me.username, publicOrigin);
  }
}
