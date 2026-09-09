import { z } from 'zod';
import { CodexConnection } from '../runtime/protocol.js';
import { AppError, type AgentProfile } from './types.js';
export const profileSchema = z
  .object({
    engine: z.literal('codex').default('codex'),
    model: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/)
      .optional(),
    effort: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']).optional(),
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
export class ModelCatalogue {
  private cached?: { at: number; models: ModelOption[] };
  private pending?: Promise<ModelOption[]>;
  constructor(private executable?: string) {}
  async list(): Promise<ModelOption[]> {
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
      await rpc.start(process.cwd());
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
