import { connectionOptions, claudeExecutable, idleInput, type ClaudeQuery } from './connection.js';
import type { Executable } from '../../../runtime/executable.js';
import type { AgentCatalogue } from '../../contracts.js';
import { profileSchema, type ModelOption, type ModelCatalogueInfo } from '../../../core/agents.js';
import { AppError, type AgentProfile } from '../../../core/types.js';

export class ClaudeCatalogue implements AgentCatalogue {
  private cache?: { at: number; executable: string; models: ModelOption[] };
  private pending?: Promise<ModelOption[]>;
  constructor(
    private executable?: Executable,
    private connect?: ClaudeQuery,
  ) {}
  metadata(): ModelCatalogueInfo {
    return {
      source: 'claude-agent-sdk:supportedModels',
      executable: claudeExecutable(this.executable),
      ...(this.cache
        ? {
            retrievedAt: new Date(this.cache.at).toISOString(),
            expiresAt: new Date(this.cache.at + 300000).toISOString(),
          }
        : {}),
    };
  }
  async list(refresh = false, signal?: AbortSignal): Promise<ModelOption[]> {
    signal?.throwIfAborted();
    const executable = claudeExecutable(this.executable);
    if (!refresh && this.cache?.executable === executable && Date.now() - this.cache.at < 300000)
      return this.cache.models;
    this.pending ??= this.load(executable, signal).finally(() => {
      this.pending = undefined;
    });
    const models = await this.pending;
    return executable === claudeExecutable(this.executable) ? models : this.list(true, signal);
  }
  private async load(executable: string, signal?: AbortSignal) {
    const abort = new AbortController();
    const cancel = () => abort.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(cancel, 20000);
    let session: ReturnType<ClaudeQuery> | undefined;
    try {
      const connect = this.connect ?? (await import('@anthropic-ai/claude-agent-sdk')).query;
      abort.signal.throwIfAborted();
      session = connect({
        prompt: idleInput(abort.signal),
        options: {
          ...connectionOptions(executable),
          abortController: abort,
          tools: [],
          maxTurns: 1,
        },
      });
      const rows = await session.supportedModels();
      abort.signal.throwIfAborted();
      const models = rows.map((row) => ({
        engine: 'claude',
        id: row.value,
        name: row.displayName,
        efforts: row.supportedEffortLevels ?? [],
        defaultEffort: '',
        isDefault: false,
      }));
      if (!models.length)
        throw new AppError('models_unavailable', 'Claude returned an empty model catalogue');
      this.cache = { executable, at: Date.now(), models };
      return models;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      abort.abort();
      session?.close();
    }
  }
  async validate(profile: AgentProfile) {
    profileSchema.parse(profile);
    if (profile.engine !== 'claude')
      throw new AppError('unsupported_profile', 'This profile is not a Claude profile', 422);
    if (!profile.model && !profile.effort) return;
    const model = (await this.list()).find((model) => model.id === profile.model);
    if (!model)
      throw new AppError(
        'model_unavailable',
        'Choose a model returned by the installed Claude CLI',
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
