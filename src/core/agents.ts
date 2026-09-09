import { z } from 'zod';
import { CodexConnection } from '../runtime/protocol.js';
import { AppError, type AgentProfile } from './types.js';
import { versionNumber } from '../runtime/executable.js';
export const profileSchema = z
  .object({
    engine: z.literal('codex').default('codex'),
    model: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/)
      .optional(),
    effort: z
      .string()
      .regex(/^[a-z][a-z0-9_-]{0,39}$/)
      .refine(
        (value) => value !== 'ultra',
        'Ultra delegation is not supported by the managed single-reviewer workflow',
      )
      .optional(),
  })
  .strict()
  .refine(
    (value) => !value.effort || !!value.model,
    'Choose a model before setting its reasoning effort',
  );
export const profilesSchema = z.object({ author: profileSchema, reviewer: profileSchema }).strict();
export const inheritedProfiles = () => ({
  author: { engine: 'codex' as const },
  reviewer: { engine: 'codex' as const },
});
export interface ModelOption {
  id: string;
  name: string;
  efforts: string[];
  defaultEffort: string;
  isDefault: boolean;
}
export interface ModelCatalogueInfo {
  source: 'codex-app-server:model/list';
  retrievedAt?: string;
  expiresAt?: string;
  cliVersion?: string;
  executable: string;
}
export class ModelCatalogue {
  private cached?: { at: number; models: ModelOption[] };
  private pending?: Promise<ModelOption[]>;
  private info: ModelCatalogueInfo;
  constructor(private executable?: string) {
    this.info = { source: 'codex-app-server:model/list', executable: executable ?? 'codex' };
  }
  metadata(): ModelCatalogueInfo {
    return { ...this.info };
  }
  async list(refresh = false): Promise<ModelOption[]> {
    if (refresh) this.cached = undefined;
    if (this.cached && Date.now() - this.cached.at < 300000) return this.cached.models;
    if (this.pending) return this.pending;
    this.pending = this.load().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }
  private async load() {
    const rpc = new CodexConnection(this.executable);
    const models: ModelOption[] = [];
    try {
      const initialized = await rpc.start(process.cwd());
      this.info.cliVersion = versionNumber(initialized.userAgent ?? '');
      let cursor: string | undefined;
      for (let page = 0; page < 10; page++) {
        const response = await rpc.request<{
          data: {
            id: string;
            model: string;
            displayName: string;
            defaultReasoningEffort: string;
            supportedReasoningEfforts: { reasoningEffort: string }[];
            isDefault: boolean;
          }[];
          nextCursor?: string;
        }>('model/list', { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) });
        for (const model of response.data)
          models.push({
            id: model.model || model.id,
            name: model.displayName,
            efforts: model.supportedReasoningEfforts
              .map((item) => item.reasoningEffort)
              .filter((effort) => effort !== 'ultra'),
            defaultEffort: model.defaultReasoningEffort,
            isDefault: model.isDefault,
          });
        if (!response.nextCursor) {
          this.cached = { at: Date.now(), models };
          this.info.retrievedAt = new Date(this.cached.at).toISOString();
          this.info.expiresAt = new Date(this.cached.at + 300000).toISOString();
          return models;
        }
        cursor = response.nextCursor;
      }
      throw new Error('Model catalogue exceeds the pagination limit');
    } finally {
      rpc.close();
    }
  }
  async validate(profile: AgentProfile) {
    profileSchema.parse(profile);
    if (!profile.model && !profile.effort) return;
    const models = await this.list(),
      model = profile.model
        ? models.find((item) => item.id === profile.model)
        : models.find((item) => item.isDefault);
    if (!model)
      throw new AppError(
        'model_unavailable',
        'This model is not available to the authenticated Codex account',
        422,
      );
    if (profile.effort && !model.efforts.includes(profile.effort))
      throw new AppError(
        'effort_unavailable',
        `${model.id} supports: ${model.efforts.join(', ')}`,
        422,
      );
  }
}
