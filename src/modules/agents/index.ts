import type { AgentModule } from '../contracts.js';
import { AgentRegistry } from './registry.js';
import { codexModule } from './codex/index.js';
import type { Executable } from '../../runtime/executable.js';
export interface AgentModuleContext {
  executable(id: string): Executable;
}
export interface AgentModuleFactory {
  id: string;
  create(context: AgentModuleContext): AgentModule;
}
/** New engines register here; the scheduler and daddy do not change. */
export const agentFactories: AgentModuleFactory[] = [
  { id: 'codex', create: (context) => codexModule(context.executable('codex')) },
];
export function createAgents(enabled: string[], context: AgentModuleContext) {
  return new AgentRegistry(
    agentFactories
      .filter((module) => enabled.includes(module.id))
      .map((module) => module.create(context)),
  );
}
