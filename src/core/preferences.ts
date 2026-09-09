import { z } from 'zod';
import type { Store } from './store.js';
import type { Locale } from '../i18n/index.js';
export interface Preferences {
  locale: Locale;
  version: number;
}
export const preferenceInput = z.object({ locale: z.enum(['en', 'ru']) }).strict();
export function preferences(store: Store): Preferences {
  return store.setting<Preferences>('preferences') ?? { locale: 'en', version: 0 };
}
export function setLocale(store: Store, locale: Locale): Preferences {
  const result = { locale, version: preferences(store).version + 1 };
  store.setSetting('preferences', result);
  store.event('_system', 'preferences.changed', result);
  return result;
}
