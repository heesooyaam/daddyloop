import { createHash } from 'node:crypto';
import { z } from 'zod';
import { presetParts } from './preset-parts.js';
import { effectiveInstructions } from './instruction-compose.js';
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
