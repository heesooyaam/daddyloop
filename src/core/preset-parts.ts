import type { AgentInstructions } from './instructions.js';

/** Stable component keys are scoped to a role and the saved skill content. */
export function presetParts(preset: {
  instructions: { daddy: AgentInstructions; worker: AgentInstructions };
}) {
  return (['daddy', 'worker'] as const).flatMap((role) => [
    ...(preset.instructions[role].prompt?.trim()
      ? [{ key: `${role}:prompt`, role, kind: 'prompt' as const, name: '' }]
      : []),
    ...(preset.instructions[role].skills ?? []).map((skill) => ({
      key: `${role}:skill:${skill.checksum}`,
      role,
      kind: 'skill' as const,
      name: skill.name,
    })),
  ]);
}
