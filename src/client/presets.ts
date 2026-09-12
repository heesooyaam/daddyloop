import type { InstructionPreset, SessionInstructions } from '../core/instructions.js';
import { presetParts } from '../core/preset-parts.js';
import { translator, type Locale } from '../i18n/index.js';
export function presetLines(presets: { name: string; description?: string }[], locale: Locale) {
  const t = translator(locale);
  return [
    t('Preset library'),
    '',
    ...presets.slice(0, 20).map((preset) => '• ' + preset.name),
    ...(!presets.length ? [t('Create reusable sets in Presets in the sidebar.')] : []),
    ...(presets.length > 20 ? [t('Open the website or CLI for the full preset list.')] : []),
    '',
    '/preset <name>',
    t('Choose individual preset components in the session settings on the website.'),
  ];
}
export function clearInstructionRole(
  value: SessionInstructions,
  role: 'daddy' | 'worker',
): SessionInstructions {
  return {
    ...value,
    [role]: {},
    ...(value.presets
      ? {
          presets: value.presets.map((item) => ({
            ...item,
            omit: [
              ...new Set([
                ...item.omit,
                ...presetParts(item.preset)
                  .filter((part) => part.role === role)
                  .map((part) => part.key),
              ]),
            ],
          })),
        }
      : {}),
  };
}
export function findPreset<T extends { id: string; name: string }>(presets: T[], name: string): T {
  name = name.trim();
  if (!name) throw new Error('Choose a unique preset name or ID');
  const matches = presets.filter(
    (preset) =>
      preset.id === name ||
      preset.id.startsWith(name) ||
      preset.name.toLowerCase() === name.toLowerCase(),
  );
  if (matches.length !== 1) throw new Error('Choose a unique preset name or ID');
  return matches[0];
}
export function selectPreset(
  value: SessionInstructions | undefined,
  preset: InstructionPreset,
  enabled = true,
): SessionInstructions {
  const current = value ?? { daddy: {}, worker: {} },
    prior = current.presets?.find((item) => item.preset.id === preset.id);
  return {
    ...current,
    presets: prior
      ? current.presets!.map((item) => (item === prior ? { ...item, enabled } : item))
      : [...(current.presets ?? []), { preset, enabled, omit: [] }],
  };
}
