import { createHash } from 'node:crypto';
import { z } from 'zod';

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
        kind: z.enum(['text', 'file', 'local', 'github']),
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
export const sessionInstructionsSchema = z
  .object({
    daddy: agentInstructionsSchema,
    worker: agentInstructionsSchema,
  })
  .strict();
export type SkillSnapshot = z.infer<typeof skillSnapshotSchema>;
export type AgentInstructions = z.infer<typeof agentInstructionsSchema>;
export type SessionInstructions = z.infer<typeof sessionInstructionsSchema>;

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
