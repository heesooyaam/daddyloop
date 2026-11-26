import { isDeepStrictEqual } from 'node:util';
import type { AppliedPreset, SkillSnapshot } from './instructions.js';
import { AppError } from './types.js';

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

export function assertSetting<T>(field: string, base: T, edit: T, current: T) {
  if (!isDeepStrictEqual(base, current) && !isDeepStrictEqual(edit, current))
    throw new AppError(
      'settings_conflict',
      'Settings changed. Reload before editing ' + field,
      409,
    );
}

function entryKey(field: string): ((entry: unknown) => string) | undefined {
  if (field === 'instructions.presets') return (entry) => (entry as AppliedPreset).preset.id;
  if (/^instructions\.(daddy|worker)\.skills$/.test(field))
    return (entry) => (entry as SkillSnapshot).checksum;
  if (/^instructions\.presets\.[^.]+\.omit$/.test(field)) return (entry) => String(entry);
}

// Merge only differences from the editor's snapshot. Related profile fields are checked together.
export function mergeSetting<T>(field: string, base: T, edit: T, current: T): T {
  if (isDeepStrictEqual(edit, base)) return current;
  if (isDeepStrictEqual(current, base) || isDeepStrictEqual(current, edit)) return edit;
  const key = entryKey(field);
  if (key && [base, edit, current].every((value) => value === undefined || Array.isArray(value))) {
    const index = (value: T) =>
      Object.fromEntries(((value ?? []) as unknown[]).map((entry) => [key(entry), entry]));
    const merged = mergeSetting(field, index(base), index(edit), index(current));
    if (field !== 'instructions.presets') return Object.values(merged) as T;
    const ids = (value: T) => ((value ?? []) as unknown[]).map(key);
    const initial = ids(base),
      edited = ids(edit),
      latest = ids(current);
    const shared = new Set(initial.filter((id) => edited.includes(id) && latest.includes(id)));
    const common = (order: string[]) => order.filter((id) => shared.has(id));
    const reordered = !isDeepStrictEqual(common(initial), common(edited));
    if (reordered) assertSetting(field + '.order', common(initial), common(edited), common(latest));
    const order = new Set(reordered ? [...edited, ...latest] : [...latest, ...edited]);
    return [...order].filter((id) => Object.hasOwn(merged, id)).map((id) => merged[id]) as T;
  }
  if (record(base) && record(edit) && record(current)) {
    const keys = new Set([...Object.keys(current), ...Object.keys(edit), ...Object.keys(base)]);
    return Object.fromEntries(
      [...keys]
        .map((key) => [key, mergeSetting(field + '.' + key, base[key], edit[key], current[key])])
        .filter(([, value]) => value !== undefined),
    ) as T;
  }
  assertSetting(field, base, edit, current);
  return edit;
}
