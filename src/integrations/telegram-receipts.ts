import type { Store } from '../core/store.js';
import { now } from '../core/types.js';
import type { Update } from './telegram.js';

export type TelegramOperationResult = { chatId: number; threadId?: number; ownerId: number };

export function resultKey(id: number) {
  return 'telegram.operationResult:' + id;
}

export function operationDestination(update: Update): TelegramOperationResult | undefined {
  const message = update.message ?? update.callback_query?.message;
  const owner = update.message?.from ?? update.callback_query?.from;
  if (message && owner)
    return { chatId: message.chat.id, threadId: message.message_thread_id, ownerId: owner.id };
}

// The caller includes this receipt in the transaction that applies the change.
export function commitTelegramOperation(
  store: Store,
  id: number,
  destination?: TelegramOperationResult,
) {
  store.db.prepare('INSERT OR IGNORE INTO bot_receipts VALUES(?,?)').run(id, now());
  if (destination) store.setSetting(resultKey(id), destination);
}
