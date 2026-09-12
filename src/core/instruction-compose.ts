import type { SessionInstructions, AgentInstructions, SkillSnapshot } from './instructions.js';

export function effectiveInstructions(
  value: SessionInstructions | undefined,
  role: 'daddy' | 'worker',
): AgentInstructions | undefined {
  if (!value) return undefined;
  if (!value.presets?.length) return value[role];
  const prompts: string[] = [],
    skills: SkillSnapshot[] = [];
  for (const selected of value.presets) {
    if (!selected.enabled) continue;
    const part = selected.preset.instructions[role];
    if (part.prompt?.trim() && !selected.omit.includes(`${role}:prompt`)) prompts.push(part.prompt);
    for (const skill of part.skills ?? [])
      if (!selected.omit.includes(`${role}:skill:${skill.checksum}`)) skills.push(skill);
  }
  if (value[role].prompt?.trim()) prompts.push(value[role].prompt!);
  skills.push(...(value[role].skills ?? []));
  const seen = new Set<string>();
  return {
    ...(prompts.length ? { prompt: prompts.join('\n\n') } : {}),
    ...(skills.length
      ? {
          skills: skills.filter((skill) => {
            if (seen.has(skill.checksum)) return false;
            seen.add(skill.checksum);
            return true;
          }),
        }
      : {}),
  };
}
