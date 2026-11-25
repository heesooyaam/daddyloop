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
const relativePosition = (order: string[], id: string, anchors: string[]) =>
  anchors.map((anchor) => order.indexOf(id) < order.indexOf(anchor));
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
  let orderMoves = new Set<string>(),
    orderActual: string[] = [],
    orderTarget: string[] = [];
  for (const change of changes.filter((change) => change.target !== 'preset-order')) {
    const actual = value(change);
    if (!sameValue(actual, change.before) && !sameValue(actual, change.after))
      throw new Error('instruction_conflict');
  }
  const order = changes.find((change) => change.target === 'preset-order');
  if (order) {
    const actualOrder = value(order) as string[],
      presetChanges = new Map(
        changes.filter((change) => change.target === 'preset').map((change) => [change.id, change]),
      ),
      shared = order.before.filter((id) => order.after.includes(id)),
      beforeShared = order.before.filter((id) => shared.includes(id)),
      afterShared = order.after.filter((id) => shared.includes(id)),
      anchors = commonSubsequence(beforeShared, afterShared),
      presentAnchors = anchors.filter((id) => actualOrder.includes(id));
    orderActual = actualOrder;
    orderTarget = [...order.after];
    orderMoves = new Set(
      order.after.filter((id) => !order.before.includes(id) && !actualOrder.includes(id)),
    );
    for (const id of shared.filter((id) => !anchors.includes(id) && actualOrder.includes(id))) {
      const before = relativePosition(order.before, id, presentAnchors),
        after = relativePosition(order.after, id, presentAnchors),
        actual = relativePosition(actualOrder, id, presentAnchors);
      if (sameValue(actual, after)) continue;
      if (!sameValue(actual, before)) throw new Error('instruction_conflict');
      orderMoves.add(id);
    }
    for (const id of order.after.filter((id) => !order.before.includes(id))) {
      if (!actualOrder.includes(id)) {
        if (!presetChanges.get(id)?.after) throw new Error('instruction_conflict');
      }
    }
    for (const id of order.before.filter((id) => !order.after.includes(id)))
      if (actualOrder.includes(id) && presetChanges.get(id)?.after !== null)
        throw new Error('instruction_conflict');
    const base = new Set(order.before),
      added = new Set(order.after.filter((id) => !base.has(id))),
      concurrent = (id: string) => !base.has(id) && !added.has(id);
    for (let start = 0; start < actualOrder.length;) {
      if (!concurrent(actualOrder[start]!)) {
        start++;
        continue;
      }
      let end = start;
      while (end + 1 < actualOrder.length && concurrent(actualOrder[end + 1]!)) end++;
      const previous = actualOrder
          .slice(0, start)
          .reverse()
          .find((id) => base.has(id)),
        following = actualOrder.slice(end + 1).find((id) => base.has(id));
      if (
        previous &&
        following &&
        orderMoves.has(previous) &&
        orderMoves.has(following) &&
        order.after.indexOf(previous) < order.after.indexOf(following)
      ) {
        const carried = actualOrder.slice(start, end + 1),
          at = orderTarget.indexOf(following);
        carried.forEach((id) => orderMoves.add(id));
        orderTarget.splice(at, 0, ...carried);
      }
      start = end + 1;
    }
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
  if (order) {
    const presets = next.presets ?? [],
      byId = new Map(presets.map((entry) => [entry.preset.id, entry])),
      current = presets.filter((entry) => !orderMoves.has(entry.preset.id));
    for (const id of orderTarget.filter((id) => orderMoves.has(id))) {
      const entry = byId.get(id);
      if (!entry) continue;
      const at = orderTarget.indexOf(id),
        preceding = orderTarget
          .slice(0, at)
          .reverse()
          .find((candidate) => current.some((preset) => preset.preset.id === candidate)),
        precedingIndex = preceding
          ? current.findIndex((preset) => preset.preset.id === preceding)
          : -1,
        following = new Set(orderTarget.slice(at + 1)),
        followingIndexes = current.flatMap((preset, index) =>
          following.has(preset.preset.id) && index > precedingIndex ? [index] : [],
        ),
        followingIndex = followingIndexes.length ? Math.min(...followingIndexes) : -1,
        insertion =
          at === 0
            ? 0
            : at === orderTarget.length - 1
              ? current.length
              : followingIndex >= 0 && (precedingIndex < 0 || precedingIndex < followingIndex)
                ? followingIndex
                : precedingIndex >= 0
                  ? precedingIndex + 1
                  : current.length;
      current.splice(insertion, 0, entry);
    }
    const candidate = current.map((entry) => entry.preset.id),
      shared = order.before.filter(
        (id) => order.after.includes(id) && orderActual.includes(id) && candidate.includes(id),
      ),
      precedes = (items: string[], left: string, right: string) =>
        items.indexOf(left) < items.indexOf(right);
    for (let left = 0; left < shared.length; left++)
      for (let right = left + 1; right < shared.length; right++) {
        const a = shared[left]!,
          b = shared[right]!,
          before = precedes(order.before, a, b),
          after = precedes(order.after, a, b),
          expected = before === after ? precedes(orderActual, a, b) : after;
        if (precedes(candidate, a, b) !== expected) throw new Error('instruction_conflict');
      }
    const added = new Set(order.after.filter((id) => !order.before.includes(id)));
    for (let start = 0; start < order.after.length;) {
      if (!added.has(order.after[start]!)) {
        start++;
        continue;
      }
      let end = start;
      while (end + 1 < order.after.length && added.has(order.after[end + 1]!)) end++;
      const chain = [
        ...order.after
          .slice(0, start)
          .reverse()
          .filter((id) => !added.has(id))
          .slice(0, 1),
        ...order.after.slice(start, end + 1),
        ...order.after
          .slice(end + 1)
          .filter((id) => !added.has(id))
          .slice(0, 1),
      ].filter((id) => candidate.includes(id));
      for (let index = 1; index < chain.length; index++)
        if (!precedes(candidate, chain[index - 1]!, chain[index]!))
          throw new Error('instruction_conflict');
      start = end + 1;
    }
    const base = new Set(order.before),
      concurrent = (id: string) => !base.has(id) && !added.has(id);
    for (let start = 0; start < orderActual.length;) {
      if (!concurrent(orderActual[start]!)) {
        start++;
        continue;
      }
      let end = start;
      while (end + 1 < orderActual.length && concurrent(orderActual[end + 1]!)) end++;
      const chain = [
        ...orderActual
          .slice(0, start)
          .reverse()
          .filter((id) => base.has(id))
          .slice(0, 1),
        ...orderActual.slice(start, end + 1),
        ...orderActual
          .slice(end + 1)
          .filter((id) => base.has(id))
          .slice(0, 1),
      ].filter((id) => candidate.includes(id));
      for (let index = 1; index < chain.length; index++)
        if (!precedes(candidate, chain[index - 1]!, chain[index]!))
          throw new Error('instruction_conflict');
      start = end + 1;
    }
    next.presets = current;
  }
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
