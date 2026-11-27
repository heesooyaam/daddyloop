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
    const order = mergePresetOrder(Object.keys(merged), ids(base), ids(edit), ids(current));
    return order.map((id) => merged[id]) as T;
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

// Each editor contributes changed precedence, including the neighbours of inserted presets.
function mergePresetOrder(ids: string[], base: string[], edit: string[], current: string[]) {
  const compare = (order: string[], a: string, b: string) => {
    const left = order.indexOf(a),
      right = order.indexOf(b);
    return left < 0 || right < 0 ? undefined : left < right;
  };
  const shared = new Set(base.filter((id) => edit.includes(id) && current.includes(id)));
  const common = (order: string[]) => order.filter((id) => shared.has(id));
  const original = common(base),
    proposed = common(edit),
    latest = common(current);
  if (!isDeepStrictEqual(original, proposed))
    assertSetting('instructions.presets.order', original, proposed, latest);
  const before = new Map(ids.map((id) => [id, new Set<string>()]));
  const conflict = () =>
    new AppError(
      'settings_conflict',
      'Settings changed. Reload before editing instructions.presets.order',
      409,
    );
  for (const [index, a] of ids.entries()) {
    for (const b of ids.slice(index + 1)) {
      const prior = compare(base, a, b),
        proposed = compare(edit, a, b),
        latest = compare(current, a, b);
      const changed = proposed !== undefined && proposed !== prior;
      if (changed && latest !== undefined && latest !== prior && latest !== proposed)
        throw conflict();
      const order = changed ? proposed : (latest ?? proposed);
      if (order !== undefined) before.get(order ? b : a)!.add(order ? a : b);
    }
  }
  const result = [];
  while (before.size) {
    const next = [...before].find(([, dependencies]) => !dependencies.size)?.[0];
    if (next === undefined) throw conflict();
    result.push(next);
    before.delete(next);
    for (const dependencies of before.values()) dependencies.delete(next);
  }
  return result;
}
