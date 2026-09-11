import { redact } from '../../core/security.js';
import { AppError, type AgentProfile } from '../../core/types.js';
import type {
  AgentInput,
  SessionInput,
  AgentRuntime,
  SessionRuntime,
} from '../../runtime/agent.js';
import type { AgentModule, AgentCatalogue } from '../contracts.js';
import { profileSchema, type ModelCatalogueInfo } from '../../core/agents.js';

/** Thread handles are opaque outside this router and cannot cross engine boundaries. */
export const sessionHandle = (engine: string, id: string) => `${engine}:${id}`;
function nativeSession(engine: string, handle?: string) {
  if (!handle) return undefined;
  if (!handle.startsWith(engine + ':'))
    throw new AppError(
      'session_engine_mismatch',
      'Start a new agent context when changing its engine',
    );
  return handle.slice(engine.length + 1);
}
export class AgentRegistry implements AgentRuntime, SessionRuntime, AgentCatalogue {
  private modules: Map<string, AgentModule>;
  private errors = new Map<string, string>();
  constructor(modules: AgentModule[]) {
    this.modules = new Map();
    for (const module of modules) {
      if (!/^[a-z][a-z0-9-]{0,31}$/.test(module.id) || this.modules.has(module.id))
        throw new Error('Agent module IDs must be unique and stable');
      this.modules.set(module.id, module);
    }
  }
  get(id: string) {
    const module = this.modules.get(id);
    if (!module)
      throw new AppError(
        'agent_module_disabled',
        `Agent module ${id} is not enabled. Choose an installed engine in model settings.`,
        422,
      );
    return module;
  }
  engines = () => [...this.modules.values()].map(({ id, name }) => ({ id, name }));
  async list(refresh = false, signal?: AbortSignal) {
    const modules = [...this.modules.values()];
    const responses = await Promise.allSettled(
      modules.map((module) => module.catalogue.list(refresh, signal)),
    );
    const models = responses.flatMap((response, index) => {
      const module = modules[index];
      if (response.status === 'rejected') {
        this.errors.set(module.id, redact(String(response.reason)).slice(0, 500));
        return [];
      }
      this.errors.delete(module.id);
      return response.value.map((model) => ({ ...model, engine: module.id }));
    });
    if (!models.length && this.errors.size)
      throw new AppError(
        'catalogues_unavailable',
        [...this.errors.entries()].map(([id, error]) => id + ': ' + error).join('; '),
        502,
      );
    return models;
  }
  metadata(): ModelCatalogueInfo {
    return {
      source: 'agent-modules',
      modules: [...this.modules.values()].map((module) => ({
        engine: module.id,
        ...module.catalogue.metadata?.(),
        ...(this.errors.has(module.id) ? { error: this.errors.get(module.id) } : {}),
      })),
    };
  }
  validate(profile: AgentProfile) {
    profileSchema.parse(profile);
    return this.get(profile.engine).catalogue.validate(profile);
  }
  run(input: AgentInput) {
    input.signal.throwIfAborted();
    const engine = input.job.profile?.engine;
    if (!engine) throw new AppError('agent_profile_missing', 'The queued job has no agent profile');
    const module = this.get(engine),
      task = { ...input.task };
    const key = input.job.role === 'author' ? 'authorThreadId' : 'reviewerThreadId';
    task[key] = nativeSession(engine, task[key]);
    return module.runtime.run({
      ...input,
      task,
      onSession: (id, turn) => input.onSession(sessionHandle(engine, id), turn),
    });
  }
  runSession(input: SessionInput) {
    input.signal.throwIfAborted();
    const engine = input.profile?.engine;
    if (!engine) throw new AppError('agent_profile_missing', 'The session has no agent profile');
    return this.get(engine).runtime.runSession({
      ...input,
      threadId: nativeSession(engine, input.threadId),
      onSession: (id, turn) => input.onSession(sessionHandle(engine, id), turn),
    });
  }
}
