import type { SessionInstructions, SkillSnapshot } from '../core/instructions.js';
import { translator, type Locale } from '../i18n/index.js';
import { effectiveInstructions } from '../core/instruction-compose.js';
import { clearInstructionRole } from './presets.js';

export function instructionLines(value: SessionInstructions | undefined, locale: Locale): string[] {
  const t = translator(locale),
    current = {
      daddy: effectiveInstructions(value, 'daddy') ?? {},
      worker: effectiveInstructions(value, 'worker') ?? {},
    };
  return [
    t('Instructions for this session'),
    ...(value?.presets?.some((preset) => preset.enabled)
      ? [
          t('Presets') +
            ': ' +
            value.presets
              .filter((preset) => preset.enabled)
              .map((preset) => preset.preset.name)
              .join(', '),
        ]
      : []),
    '',
    ...(['daddy', 'worker'] as const).flatMap((role) => [
      role === 'daddy' ? 'daddy' : t('All workers'),
      current[role].prompt?.slice(0, 900) || t('No additional instructions'),
      ...(current[role].skills ?? []).map((skill) => '• ' + skill.name),
      '',
    ]),
    '/instructions daddy <text>',
    '/instructions worker <text>',
    '/skill daddy <GitHub URL>',
    '/skill worker <GitHub URL>',
    '/instructions daddy --clear',
    '/instructions worker --clear',
    '/presets',
    '/preset <name>',
  ];
}
export async function instructionCommand(
  text: string,
  current: SessionInstructions | undefined,
  importSkill: (url: string) => Promise<SkillSnapshot>,
): Promise<SessionInstructions | undefined> {
  if (text.trim() === '/instructions') return undefined;
  const match = text.match(/^\/(instructions|skill)\s+(daddy|worker)\s+([\s\S]+)$/);
  if (!match)
    throw new Error(
      'Use /instructions daddy <text>, /instructions worker <text>, or /skill <role> <GitHub URL>',
    );
  const role = match[2] as 'daddy' | 'worker',
    value = structuredClone(current ?? { daddy: {}, worker: {} });
  if (match[1] === 'instructions') {
    if (match[3].trim() === '--clear') return clearInstructionRole(value, role);
    else value[role].prompt = match[3];
  } else {
    const skill = await importSkill(match[3].trim()),
      skills = value[role].skills ?? [];
    if (!skills.some((item) => item.checksum === skill.checksum))
      value[role].skills = [...skills, skill];
  }
  return value;
}
