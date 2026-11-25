import type { SessionInstructions, SkillSnapshot } from '../core/instructions.js';
import { translator, type Locale } from '../i18n/index.js';
import { effectiveInstructions } from '../core/instruction-compose.js';
import { clearInstructionRole } from './presets.js';

export function instructionLines(
  value: SessionInstructions | undefined,
  locale: Locale,
  surface: 'telegram' | 'terminal' = 'telegram',
): string[] {
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
    ...(surface === 'telegram'
      ? [
          '/skill daddy|worker file',
          '/skill daddy|worker local <server path>',
          '/skill daddy|worker text <name> :: <text>',
          '/instructions import',
          '/instructions export',
        ]
      : [t('File import and local or pasted skills run in the paired private Telegram chat.')]),
    '/instructions daddy --clear',
    '/instructions worker --clear',
    '/presets',
    '/preset <name>',
    ...(surface === 'telegram' ? ['/preset remove <name or ID>'] : []),
  ];
}
export async function instructionCommand(
  text: string,
  current: SessionInstructions | undefined,
  importSkill: (url: string) => Promise<SkillSnapshot>,
): Promise<SessionInstructions | undefined> {
  const match = instructionCommandMatch(text);
  if (!match) return undefined;
  const skill = match.kind === 'skill' ? await importSkill(match.value.trim()) : undefined;
  return updateInstructionsFromCommand(text, current, skill);
}
export function updateInstructionsFromCommand(
  text: string,
  current: SessionInstructions | undefined,
  skill?: SkillSnapshot,
): SessionInstructions | undefined {
  if (text.trim() === '/instructions') return undefined;
  const match = instructionCommandMatch(text);
  if (!match)
    throw new Error(
      'Use /instructions daddy <text>, /instructions worker <text>, or /skill <role> <GitHub URL>',
    );
  const role = match.role,
    value = structuredClone(current ?? { daddy: {}, worker: {} });
  if (match.kind === 'instructions') {
    if (match.value.trim() === '--clear') return clearInstructionRole(value, role);
    else value[role].prompt = match.value;
  } else {
    if (!skill) throw new Error('Import the requested skill before updating instructions');
    const skills = value[role].skills ?? [];
    if (!skills.some((item) => item.checksum === skill.checksum))
      value[role].skills = [...skills, skill];
  }
  return value;
}
function instructionCommandMatch(text: string) {
  if (text.trim() === '/instructions') return;
  const match = text.match(/^\/(instructions|skill)\s+(daddy|worker)\s+([\s\S]+)$/);
  if (!match)
    throw new Error(
      'Use /instructions daddy <text>, /instructions worker <text>, or /skill <role> <GitHub URL>',
    );
  return {
    kind: match[1] as 'instructions' | 'skill',
    role: match[2] as 'daddy' | 'worker',
    value: match[3],
  };
}
