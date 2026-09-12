import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Store } from './store.js';
import { AppError, now } from './types.js';
import {
  instructionPresetSchema,
  flattenInstructions,
  sessionInstructionsSchema,
  type InstructionPreset,
} from './instructions.js';
import { presetParts } from './preset-parts.js';

export const presetInputSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    description: z.string().trim().max(1000).default(''),
    instructions: sessionInstructionsSchema,
    expectedRevision: z.number().int().positive().optional(),
  })
  .strict();
export const presetLibraryKey = 'instructions.presets';
export class InstructionPresets {
  constructor(private store: Store) {}
  all(): InstructionPreset[] {
    return this.store.setting<InstructionPreset[]>(presetLibraryKey) ?? [];
  }
  list() {
    return this.all().map(({ instructions: _, ...preset }) => ({
      ...preset,
      components: presetParts({ ...preset, instructions: _ }),
    }));
  }
  get(id: string) {
    const preset = this.all().find((item) => item.id === id);
    if (!preset) throw new AppError('preset_not_found', 'Preset not found', 404);
    return instructionPresetSchema.parse(preset);
  }
  save(input: z.input<typeof presetInputSchema>, id?: string) {
    const value = presetInputSchema.parse(input);
    return this.store.transaction(() => {
      const library = this.all(),
        prior = id ? this.get(id) : undefined;
      if (prior && value.expectedRevision !== prior.revision)
        throw new AppError('preset_changed', 'This preset changed. Reload it before saving.', 409);
      if (!prior && value.expectedRevision !== undefined)
        throw new AppError('invalid_preset', 'New presets do not have a previous revision', 400);
      if (
        library.some(
          (item) => item.id !== id && item.name.toLowerCase() === value.name.toLowerCase(),
        )
      )
        throw new AppError('preset_name_taken', 'Choose a unique preset name', 409);
      const preset = instructionPresetSchema.parse({
        id: prior?.id ?? randomUUID(),
        name: value.name,
        description: value.description,
        revision: (prior?.revision ?? 0) + 1,
        instructions: flattenInstructions(value.instructions),
        createdAt: prior?.createdAt ?? now(),
        updatedAt: now(),
      });
      const next = prior
        ? library.map((item) => (item.id === prior.id ? preset : item))
        : [...library, preset];
      if (next.length > 50 || Buffer.byteLength(JSON.stringify(next)) > 4194304)
        throw new AppError(
          'preset_library_full',
          'The preset library is limited to 50 presets and 4 MiB',
          422,
        );
      this.store.setSetting(presetLibraryKey, next);
      return preset;
    });
  }
  remove(id: string, expectedRevision: number) {
    return this.store.transaction(() => {
      const current = this.get(id);
      if (current.revision !== expectedRevision)
        throw new AppError(
          'preset_changed',
          'This preset changed. Reload it before deleting.',
          409,
        );
      this.store.setSetting(
        presetLibraryKey,
        this.all().filter((preset) => preset.id !== id),
      );
      return { deleted: true };
    });
  }
}
