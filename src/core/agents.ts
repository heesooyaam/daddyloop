import { z } from 'zod';
export const profileSchema = z
  .object({
    engine: z
      .string()
      .regex(/^[a-z][a-z0-9-]{0,31}$/)
      .default('codex'),
    model: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/)
      .optional(),
    effort: z
      .string()
      .regex(/^[a-z][a-z0-9_-]{0,39}$/)
      .optional(),
  })
  .strict()
  .refine(
    (value) => !value.effort || !!value.model,
    'Choose a model before setting its reasoning effort',
  );
export const profilesSchema = z.object({ worker: profileSchema, daddy: profileSchema }).strict();
export const inheritedProfiles = () => ({
  worker: { engine: 'codex' as const },
  daddy: { engine: 'codex' as const },
});
export interface ModelOption {
  id: string;
  engine: string;
  name: string;
  efforts: string[];
  defaultEffort: string;
  isDefault: boolean;
}
export interface ModelCatalogueInfo {
  source: string;
  modules?: {
    engine: string;
    error?: string;
    source?: string;
    retrievedAt?: string;
    expiresAt?: string;
    cliVersion?: string;
    executable?: string;
  }[];
  retrievedAt?: string;
  expiresAt?: string;
  cliVersion?: string;
  executable?: string;
}
