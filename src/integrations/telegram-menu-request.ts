import { AsyncLocalStorage } from 'node:async_hooks';
import type { Update } from './telegram.js';
import type { DeliveryOptions, TelegramDestination } from './telegram-delivery.js';
import { taskReferenceId } from './telegram-tasks.js';

const views = new Set([
  'start',
  'status',
  'queue',
  'workers',
  'tasks',
  'sessions',
  'pool',
  'models',
  'limits',
  'workspaces',
  'repo',
  'instructions',
  'presets',
  'notifications',
  'language',
  'modules',
  'updates',
  'cleanup',
]);

function opensMenu(text: string, username: string) {
  const cmd = /^\/(\w+)(?:@(\w+))?(?:\s+([\s\S]+))?$/.exec(text.trim());
  if (!cmd || (cmd[2] && cmd[2].toLowerCase() !== username.toLowerCase())) return false;
  if (cmd[1] === 'help') return true;
  if (cmd[1] === 'task') return !cmd[3] || !!taskReferenceId(cmd[3]);
  return !cmd[3] && views.has(cmd[1]);
}
function opensMenuButton(data: string) {
  return (
    /^(?:dad:(?:queue|workers|task|status|settings|instructions|models|arch-task)(?::|$)|dad:pool:[a-f0-9-]{36}$)/.test(
      data,
    ) ||
    /^(?:dad:(?:home|sessions|workspaces|limits(?::refresh)?)|(?:notifications|language|cleanup|updates):show|models:(?:show|refresh)|tasks:\d+|task:[a-f0-9-]{36})$/.test(
      data,
    )
  );
}

interface MenuRequest extends TelegramDestination {
  key: string;
}
export function requestedMenu(update: Update, username: string): MenuRequest | undefined {
  const callback = update.callback_query;
  const message = callback?.message ?? update.message;
  const sender = callback?.from ?? update.message?.from;
  if (!message || !sender || sender.is_bot) return;
  if (
    callback
      ? !opensMenuButton(callback.data ?? '')
      : !opensMenu(update.message?.text ?? '', username)
  )
    return;
  const receipt = callback
    ? 'callback:' + callback.id
    : message.message_id
      ? 'message:' + message.message_id
      : 'update:' + update.update_id;
  return {
    chatId: message.chat.id,
    threadId: message.message_thread_id,
    key: `telegram:menu:${sender.id}:${receipt}`,
  };
}

const scope = new AsyncLocalStorage<
  MenuRequest & { api: object; groupId?: string; active: boolean; part: number }
>();
export async function handleMenuRequest(
  api: object,
  request: MenuRequest,
  groupId: string | undefined,
  handle: () => Promise<void>,
) {
  const current = { ...request, api, groupId, active: true, part: 0 };
  try {
    await scope.run(current, handle);
  } finally {
    current.active = false;
  }
}
export function menuDelivery(
  api: object,
  dest: TelegramDestination,
  options: DeliveryOptions | undefined,
): DeliveryOptions | undefined {
  const current = scope.getStore();
  // Only direct responses to this input. Notifications and background work carry their own delivery identity.
  if (
    !current?.active ||
    current.api !== api ||
    current.chatId !== dest.chatId ||
    current.threadId !== dest.threadId ||
    options?.key ||
    options?.notificationId ||
    options?.operation ||
    options?.reminder
  )
    return options;
  return {
    ...options,
    requestedMenu: true,
    menuTopicGroupId: current.groupId,
    key: `${current.key}:${current.part++}`,
  };
}
