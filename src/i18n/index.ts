import { ru } from './ru.js';
export type Locale = 'en' | 'ru';
export const locales: Locale[] = ['en', 'ru'];
export const localeNames = { en: 'English', ru: 'Русский' };
export function normalizeLocale(value: unknown, fallback: Locale = 'en'): Locale {
  return typeof value === 'string' && /^ru(?:[-_]|$)/i.test(value)
    ? 'ru'
    : typeof value === 'string' && /^en(?:[-_]|$)/i.test(value)
      ? 'en'
      : fallback;
}
type Values = Record<string, unknown>;
const dictionary: Readonly<Record<string, string>> = ru;
const english = new Map(Object.entries(dictionary).map(([key, value]) => [value, key]));
const format = (text: string, values: Values) =>
  text.replace(/\{([A-Za-z0-9_]+)\}/g, (match, name: string) =>
    values[name] === undefined ? match : String(values[name]),
  );
const patterns = Object.entries(dictionary).flatMap(([en, translated]) =>
  [en, translated].flatMap((source) => {
    if (!/\{\w+\}/.test(source)) return [];
    const names: string[] = [];
    const regex = source
      .split(/(\{\w+\})/)
      .map((part) =>
        /^\{\w+\}$/.test(part)
          ? (names.push(part.slice(1, -1)), '([\\s\\S]*?)')
          : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
      )
      .join('');
    return [
      {
        regex: new RegExp('^' + regex + '$'),
        skeleton: source.replace(/\{\w+\}/g, '{}'),
        names,
        en,
        ru: translated,
      },
    ];
  }),
);
/** Only UI copy goes through this function; task and conversation bodies stay original. */
export function translate(locale: Locale, source: string, values: Values = {}): string {
  const match = source.match(/^(\s*)([\s\S]*?)(\s*)$/)!;
  const key = match[2],
    canonical = dictionary[key] === undefined ? (english.get(key) ?? key) : key;
  if (dictionary[canonical] !== undefined)
    return (
      match[1] + format(locale === 'ru' ? dictionary[canonical] : canonical, values) + match[3]
    );
  // Resolve positional template aliases before interpolation, keeping inserted
  // task names and other data out of the translation lookup.
  const inputNames = [...key.matchAll(/\{(\w+)\}/g)].map((match) => match[1]);
  if (inputNames.length && Object.keys(values).length) {
    const skeleton = key.replace(/\{\w+\}/g, '{}');
    for (const pattern of patterns.filter((pattern) => pattern.skeleton === skeleton)) {
      const mapped: Values = {};
      let valid = true;
      pattern.names.forEach((name, i) => {
        const value = values[inputNames[i]];
        if (mapped[name] !== undefined && mapped[name] !== value) valid = false;
        mapped[name] = value;
      });
      if (valid) return match[1] + format(pattern[locale], mapped) + match[3];
    }
  }
  for (const pattern of patterns) {
    if (inputNames.length && Object.keys(values).length) break;
    const found = pattern.regex.exec(key);
    if (found)
      return (
        match[1] +
        format(
          pattern[locale],
          Object.fromEntries(pattern.names.map((name, i) => [name, found[i + 1]])),
        ) +
        match[3]
      );
  }
  const prefix = key.match(/^([^\p{L}\p{N}_/{}]+)([\s\S]+)$/u);
  if (prefix && /[\p{L}\p{N}]/u.test(prefix[2]))
    return match[1] + prefix[1] + translate(locale, prefix[2], values) + match[3];
  if (key.includes(' · '))
    return (
      match[1] +
      key
        .split(' · ')
        .map((part) => translate(locale, part, values))
        .join(' · ') +
      match[3]
    );
  if (/^✓ /.test(key)) return match[1] + '✓ ' + translate(locale, key.slice(2), values) + match[3];
  if (key.includes('\n'))
    return (
      match[1] +
      key
        .split('\n')
        .map((line) => translate(locale, line, values))
        .join('\n') +
      match[3]
    );
  return format(source, values);
}
export const translator = (locale: Locale) => (source: string, values?: Values) =>
  translate(locale, source, values);
