import { z } from 'zod';
import type { Store } from '../core/store.js';
export const notificationsSchema = z
  .object({ enabled: z.boolean(), mode: z.enum(['attention', 'all']) })
  .strict();
export type NotificationPreferences = z.infer<typeof notificationsSchema>;
export function notificationPreferences(store: Store): NotificationPreferences {
  return (
    store.setting<NotificationPreferences>('notifications.telegram') ?? {
      enabled: !!store.setting('telegram.pairing'),
      mode: 'attention',
    }
  );
}
