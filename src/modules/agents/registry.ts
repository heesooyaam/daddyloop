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
import type { RunProcesses } from '../../runtime/run-processes.js';

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
  constructor(
    modules: AgentModule[],
    private execution: SessionInput['execution'] = 'host',
    private processes?: RunProcesses,
  ) {
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
  all = () => [...this.modules.values()];
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
    input.onEvent('runtime.execution', { engine, mode: input.execution ?? this.execution });
    const key = input.job.role === 'author' ? 'authorThreadId' : 'reviewerThreadId';
    task[key] = nativeSession(engine, task[key]);
    const run = (processScope?: AgentInput['processScope']) =>
      module.runtime.run({
        ...input,
        processScope,
        execution: input.execution ?? this.execution,
        task,
        onSession: (id, turn) => input.onSession(sessionHandle(engine, id), turn),
      });
    return this.processes
      ? this.processes.run(
          {
            runId: input.job.id,
            taskId: input.task.id,
            groupId: input.task.groupId ?? input.task.id,
            kind: 'worker',
          },
          run,
        )
      : run(input.processScope);
  }
  runSession(input: SessionInput) {
    input.signal.throwIfAborted();
    const engine = input.profile?.engine;
    if (!engine) throw new AppError('agent_profile_missing', 'The session has no agent profile');
    if (this.processes && !input.owner)
      throw new AppError('run_owner_missing', 'A managed agent session requires a run owner');
    input.onEvent('runtime.execution', { engine, mode: input.execution ?? this.execution });
    const runtime = this.get(engine).runtime;
    const run = (processScope?: SessionInput['processScope']) =>
      runtime.runSession({
        ...input,
        processScope,
        execution: input.execution ?? this.execution,
        threadId: nativeSession(engine, input.threadId),
        onSession: (id, turn) => input.onSession(sessionHandle(engine, id), turn),
      });
    return this.processes && input.owner
      ? this.processes.run(input.owner, run)
      : run(input.processScope);
  }
}
