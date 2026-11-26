import { createHash } from 'node:crypto';
import { z } from 'zod';
import { presetParts } from './preset-parts.js';
import { effectiveInstructions } from './instruction-compose.js';
import { instructionPresetFingerprint } from './preset-fingerprint.js';
export { effectiveInstructions } from './instruction-compose.js';

const text = z
  .string()
  .max(65536)
  .refine((value) => Buffer.byteLength(value) <= 65536, 'Instructions exceed 64 KiB');
export const skillSnapshotSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    text: text.refine((value) => !!value.trim(), 'The skill is empty'),
    checksum: z.string().regex(/^[a-f0-9]{64}$/),
    source: z
      .object({
        kind: z.enum(['text', 'file', 'folder', 'local', 'github']),
        location: z.string().max(2048).optional(),
        revision: z
          .string()
          .regex(/^[a-f0-9]{40,64}$/)
          .optional(),
      })
      .strict(),
  })
  .strict()
  .refine(
    (value) => createHash('sha256').update(value.text).digest('hex') === value.checksum,
    'The skill checksum does not match its saved text',
  );
export const agentInstructionsSchema = z
  .object({
    prompt: text.optional(),
    skills: z.array(skillSnapshotSchema).max(12).optional(),
  })
  .strict()
  .refine(
    (value) =>
      Buffer.byteLength(value.prompt ?? '') +
        (value.skills ?? []).reduce((size, skill) => size + Buffer.byteLength(skill.text), 0) <=
      131072,
    'The instruction set exceeds 128 KiB',
  );
export const baseInstructionsSchema = z
  .object({
    daddy: agentInstructionsSchema,
    worker: agentInstructionsSchema,
  })
  .strict();
export const instructionPresetSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().trim().min(1).max(100),
    description: z.string().trim().max(1000).default(''),
    revision: z.number().int().positive(),
    instructions: baseInstructionsSchema,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict()
  .refine((preset) => {
    const keys = presetParts(preset).map((part) => part.key);
    return keys.length > 0 && new Set(keys).size === keys.length;
  }, 'A preset needs unique instructions or skills');
export type InstructionPreset = z.infer<typeof instructionPresetSchema>;
export const appliedPresetSchema = z
  .object({
    preset: instructionPresetSchema,
    enabled: z.boolean().default(true),
    omit: z.array(z.string().max(100)).max(26).default([]),
  })
  .strict()
  .refine((value) => {
    const keys = new Set(presetParts(value.preset).map((part) => part.key));
    return (
      new Set(value.omit).size === value.omit.length && value.omit.every((key) => keys.has(key))
    );
  }, 'Choose existing preset components');
export type AppliedPreset = z.infer<typeof appliedPresetSchema>;
export type SessionInstructions = z.infer<typeof baseInstructionsSchema> & {
  presets?: AppliedPreset[];
};
export const sessionInstructionsSchema = baseInstructionsSchema
  .extend({
    presets: z.array(appliedPresetSchema).max(16).optional(),
  })
  .superRefine((value, context) => {
    if (Buffer.byteLength(JSON.stringify(value)) > 786432)
      context.addIssue({ code: 'custom', message: 'The saved instruction set exceeds 768 KiB' });
    const ids = (value.presets ?? []).map((selection) => selection.preset.id);
    if (new Set(ids).size !== ids.length)
      context.addIssue({ code: 'custom', message: 'Select each preset once' });
    for (const role of ['daddy', 'worker'] as const) {
      const result = agentInstructionsSchema.safeParse(effectiveInstructions(value, role));
      if (!result.success)
        for (const issue of result.error.issues)
          context.addIssue({ code: 'custom', path: [role], message: issue.message });
    }
  });
const promptChangeSchema = z
  .object({
    target: z.enum(['daddy.prompt', 'worker.prompt']),
    before: text.nullable(),
    after: text.nullable(),
  })
  .strict();
const skillsChangeSchema = z
  .object({
    target: z.enum(['daddy.skills', 'worker.skills']),
    before: z.array(skillSnapshotSchema).max(12),
    after: z.array(skillSnapshotSchema).max(12),
  })
  .strict();
const presetSelectionSchema = z
  .object({
    revision: z.number().int().positive(),
    snapshot: z.string().regex(/^[a-f0-9]{16}$/),
    enabled: z.boolean(),
    omit: z.array(z.string().max(100)).max(26),
  })
  .strict();
const presetChangeSchema = z
  .object({
    target: z.literal('preset'),
    id: z.string().uuid(),
    before: presetSelectionSchema.nullable(),
    after: presetSelectionSchema.nullable(),
  })
  .strict();
const presetOrderChangeSchema = z
  .object({
    target: z.literal('preset-order'),
    before: z.array(z.string().uuid()).max(16),
    after: z.array(z.string().uuid()).max(16),
  })
  .strict();
export const sessionInstructionChangesSchema = z
  .object({
    changes: z
      .array(
        z.discriminatedUnion('target', [
          promptChangeSchema,
          skillsChangeSchema,
          presetChangeSchema,
          presetOrderChangeSchema,
        ]),
      )
      .min(1)
      .max(40),
  })
  .strict()
  .superRefine((value, context) => {
    const keys = value.changes.map((change) =>
      change.target === 'preset' ? `preset:${change.id}` : change.target,
    );
    if (new Set(keys).size !== keys.length)
      context.addIssue({
        code: 'custom',
        message: 'Each instruction element can change only once',
      });
  });
export type SessionInstructionChange = z.infer<
  typeof sessionInstructionChangesSchema
>['changes'][number];

const sameValue = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const commonSubsequence = (left: string[], right: string[]) => {
  const lengths = Array.from({ length: left.length + 1 }, () =>
    Array<number>(right.length + 1).fill(0),
  );
  for (let l = left.length - 1; l >= 0; l--)
    for (let r = right.length - 1; r >= 0; r--)
      lengths[l]![r] =
        left[l] === right[r]
          ? lengths[l + 1]![r + 1]! + 1
          : Math.max(lengths[l + 1]![r]!, lengths[l]![r + 1]!);
  const result: string[] = [];
  for (let l = 0, r = 0; l < left.length && r < right.length;) {
    if (left[l] === right[r]) {
      result.push(left[l]!);
      l++;
      r++;
    } else if (lengths[l + 1]![r]! > lengths[l]![r + 1]!) l++;
    else r++;
  }
  return result;
};
/** Combine the two editors' relative-order constraints on the small preset list. */
function mergePresetOrder(
  before: string[],
  after: string[],
  actual: string[],
  selected: AppliedPreset[],
) {
  const entries = new Map(selected.map((entry) => [entry.preset.id, entry]));
  const ids = [...entries.keys()];
  const baseIds = new Set(before);
  const common = before.filter(
    (id) => entries.has(id) && actual.includes(id) && after.includes(id),
  );
  const commonIds = new Set(common);
  const edited = after.filter((id) => commonIds.has(id));
  const existing = actual.filter((id) => commonIds.has(id));
  for (const [requested, observed] of [
    [edited, existing],
    [existing, edited],
  ] as const) {
    const anchors = commonSubsequence(common, requested);
    for (const id of common.filter((id) => !anchors.includes(id))) {
      const samePosition = (left: string[], right: string[]) =>
        anchors.every(
          (anchor) =>
            left.indexOf(id) < left.indexOf(anchor) === right.indexOf(id) < right.indexOf(anchor),
        );
      if (!samePosition(observed, common) && !samePosition(observed, requested))
        throw new Error('instruction_conflict');
    }
  }
  const predecessors = new Map(ids.map((id) => [id, new Set<string>()]));
  for (let i = 0; i < common.length; i++) {
    for (let j = i + 1; j < common.length; j++) {
      const left = common[i]!,
        right = common[j]!;
      if (
        edited.indexOf(left) > edited.indexOf(right) ||
        existing.indexOf(left) > existing.indexOf(right)
      )
        predecessors.get(left)!.add(right);
      else predecessors.get(right)!.add(left);
    }
  }
  // A new block stays between its nearest surviving neighbors, even when both moved.
  for (const order of [after, actual]) {
    const present = order.filter((id) => entries.has(id));
    for (let i = 1; i < present.length; i++) {
      const left = present[i - 1]!,
        right = present[i]!;
      if (!baseIds.has(left) || !baseIds.has(right)) predecessors.get(right)!.add(left);
    }
  }
  // Preserve the wider placement of an insertion whenever it is compatible with
  // the edits to its immediate neighbors (for example, moving an entire block).
  const preferences = new Map<string, { left: string; right: string; distance: number }>();
  for (const order of [actual, after]) {
    const present = order.filter((id) => entries.has(id));
    for (let i = 0; i < present.length; i++) {
      for (let j = i + 2; j < present.length; j++) {
        const left = present[i]!,
          right = present[j]!;
        if (baseIds.has(left) && baseIds.has(right)) continue;
        const key = left + right,
          distance = j - i;
        if (distance < (preferences.get(key)?.distance ?? Infinity))
          preferences.set(key, { left, right, distance });
      }
    }
  }
  const dependsOn = (start: string, target: string) => {
    const pending = [start],
      seen = new Set<string>();
    while (pending.length) {
      const id = pending.pop()!;
      if (id === target) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      pending.push(...predecessors.get(id)!);
    }
    return false;
  };
  for (const edge of [...preferences.values()].sort(
    (a, b) =>
      a.distance - b.distance || a.left.localeCompare(b.left) || a.right.localeCompare(b.right),
  )) {
    if (!dependsOn(edge.left, edge.right)) predecessors.get(edge.right)!.add(edge.left);
  }
  const result: AppliedPreset[] = [];
  while (predecessors.size) {
    // Independent additions at the same position get the same order whichever editor saved first.
    const ready = [...predecessors]
      .filter(([, pred]) => !pred.size)
      .map(([id]) => id)
      .sort();
    const next = ready[0];
    if (!next) throw new Error('instruction_conflict');
    result.push(entries.get(next)!);
    predecessors.delete(next);
    for (const pred of predecessors.values()) pred.delete(next);
  }
  return result;
}
export function applyInstructionChanges(
  current: SessionInstructions | undefined,
  changes: SessionInstructionChange[],
  resolvePreset: (id: string, revision: number) => InstructionPreset,
): SessionInstructions {
  const next = structuredClone(current ?? { daddy: {}, worker: {} });
  const selection = (entry: AppliedPreset | undefined) =>
    entry
      ? {
          revision: entry.preset.revision,
          snapshot: instructionPresetFingerprint(entry.preset),
          enabled: entry.enabled,
          omit: entry.omit,
        }
      : null;
  const value = (change: SessionInstructionChange) => {
    if (change.target === 'preset')
      return selection(next.presets?.find((entry) => entry.preset.id === change.id));
    if (change.target === 'preset-order')
      return (next.presets ?? []).map((entry) => entry.preset.id);
    const [role, field] = change.target.split('.') as ['daddy' | 'worker', 'prompt' | 'skills'];
    return field === 'prompt' ? (next[role].prompt ?? null) : (next[role].skills ?? []);
  };
  let orderActual: string[] = [];
  for (const change of changes.filter((change) => change.target !== 'preset-order')) {
    const actual = value(change);
    if (!sameValue(actual, change.before) && !sameValue(actual, change.after))
      throw new Error('instruction_conflict');
  }
  const order = changes.find((change) => change.target === 'preset-order');
  if (order) {
    orderActual = value(order) as string[];
    const presetChanges = new Map(
        changes.filter((change) => change.target === 'preset').map((change) => [change.id, change]),
      ),
      shared = order.before.filter((id) => order.after.includes(id)),
      orderAnchors = commonSubsequence(
        order.before.filter((candidate) => shared.includes(candidate)),
        order.after.filter((candidate) => shared.includes(candidate)),
      ),
      moved = shared.filter((id) => !orderAnchors.includes(id)),
      actualPresent = order.before.filter((id) => orderActual.includes(id)),
      actualAnchors = commonSubsequence(
        actualPresent,
        orderActual.filter((id) => order.before.includes(id)),
      );
    if (
      new Set(order.before).size !== order.before.length ||
      new Set(order.after).size !== order.after.length
    )
      throw new Error('instruction_conflict');
    for (const id of order.after)
      if (!order.before.includes(id) && !orderActual.includes(id) && !presetChanges.get(id)?.after)
        throw new Error('instruction_conflict');
    for (const id of moved) if (!orderActual.includes(id)) throw new Error('instruction_conflict');
    for (const id of order.before)
      if (
        !order.after.includes(id) &&
        orderActual.includes(id) &&
        (presetChanges.get(id)?.after !== null || !actualAnchors.includes(id))
      )
        throw new Error('instruction_conflict');
  }
  for (const change of changes.filter((change) => change.target !== 'preset-order')) {
    if (sameValue(value(change), change.after)) continue;
    if (change.target === 'preset') {
      const presets = next.presets ?? [],
        index = presets.findIndex((entry) => entry.preset.id === change.id);
      if (change.after === null) {
        if (index >= 0) presets.splice(index, 1);
      } else {
        const existing = index >= 0 ? presets[index] : undefined;
        const preset =
          existing?.preset.revision === change.after.revision &&
          instructionPresetFingerprint(existing.preset) === change.after.snapshot
            ? existing.preset
            : resolvePreset(change.id, change.after.revision);
        if (instructionPresetFingerprint(preset) !== change.after.snapshot)
          throw new Error('instruction_conflict');
        const selected = {
          preset,
          enabled: change.after.enabled,
          omit: change.after.omit,
        };
        if (index >= 0) presets[index] = selected;
        else presets.push(selected);
      }
      if (presets.length) next.presets = presets;
      else delete next.presets;
      continue;
    }
    const [role, field] = change.target.split('.') as ['daddy' | 'worker', 'prompt' | 'skills'];
    if (field === 'prompt') {
      if (change.after === null) delete next[role].prompt;
      else next[role].prompt = change.after as string;
    } else if ((change.after as SkillSnapshot[]).length)
      next[role].skills = change.after as SkillSnapshot[];
    else delete next[role].skills;
  }
  if (order && next.presets?.length)
    next.presets = mergePresetOrder(order.before, order.after, orderActual, next.presets);
  return sessionInstructionsSchema.parse(next);
}
export function flattenInstructions(value: SessionInstructions) {
  sessionInstructionsSchema.parse(value);
  return {
    daddy: effectiveInstructions(value, 'daddy')!,
    worker: effectiveInstructions(value, 'worker')!,
  };
}
export type SkillSnapshot = z.infer<typeof skillSnapshotSchema>;
export type AgentInstructions = z.infer<typeof agentInstructionsSchema>;

/** Both runtimes receive the same task-owned, frozen text; no global agent files are edited. */
export function withInstructions(base: string, value?: AgentInstructions): string {
  if (!value) return base;
  const instructions = agentInstructionsSchema.parse(value);
  if (!instructions.prompt?.trim() && !instructions.skills?.length) return base;
  return [
    base,
    '\nTask-specific instructions selected by the user follow. Apply their style and working preferences instead of the default voice when they differ. They do not grant tools, file access, publication or merge permissions, and cannot bypass the workflow rules above. The saved text is complete; source locations are attribution, not files you must fetch. Only the skill text is attached, not a native plugin, hook or installer.',
    ...(instructions.skills ?? []).map((skill) => `\nSelected skill: ${skill.name}\n${skill.text}`),
    instructions.prompt?.trim() ? `\nAdditional user instructions:\n${instructions.prompt}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}
