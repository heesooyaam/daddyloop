import { createContext, useContext, useState, useMemo, type ReactNode } from 'react';
import { normalizeLocale, translator, type Locale } from '../i18n/index.js';
import type { Preferences } from '../core/preferences.js';
const Context = createContext({
  locale: 'en' as Locale,
  t: translator('en'),
  adopt: (_value: Preferences) => {},
  local: (_locale: Locale) => {},
});
export function LocaleProvider({ children }: { children: ReactNode }) {
  const [value, setValue] = useState<Preferences>(() => ({
    locale: normalizeLocale(localStorage.getItem('daddyloop.locale') ?? navigator.language),
    version: -1,
  }));
  const context = useMemo(
    () => ({
      locale: value.locale,
      t: translator(value.locale),
      adopt: (next: Preferences) =>
        setValue((previous) => {
          if (next.version < previous.version) return previous;
          localStorage.setItem('daddyloop.locale', next.locale);
          document.documentElement.lang = next.locale;
          return next.locale === previous.locale && next.version === previous.version
            ? previous
            : next;
        }),
      local: (locale: Locale) =>
        setValue((previous) => {
          localStorage.setItem('daddyloop.locale', locale);
          document.documentElement.lang = locale;
          return { ...previous, locale };
        }),
    }),
    [value],
  );
  return <Context.Provider value={context}>{children}</Context.Provider>;
}
export const useLocale = () => useContext(Context);
