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
    return Object.values(mergeSetting(field, index(base), index(edit), index(current))) as T;
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
