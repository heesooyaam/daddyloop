import { claudeModule, claudePrivatePaths } from './claude/index.js';
import type { AgentModule } from '../contracts.js';
import { AgentRegistry } from './registry.js';
import { codexModule, codexPrivatePaths } from './codex/index.js';
import type { Executable } from '../../runtime/executable.js';
export interface AgentModuleContext {
  dataDir?: string;
  store: import('../../core/store.js').Store;
  executable(id: string): Executable;
}
export interface AgentModuleFactory {
  id: string;
  create(context: AgentModuleContext): AgentModule;
  privatePaths?(): string[];
}
/** New engines register here; the scheduler and daddy do not change. */
export const agentFactories: AgentModuleFactory[] = [
  {
    id: 'codex',
    privatePaths: codexPrivatePaths,
    create: (context) => codexModule(context.executable('codex'), context.store),
  },
  { id: 'claude', privatePaths: claudePrivatePaths, create: claudeModule },
];
export function createAgents(enabled: string[], context: AgentModuleContext) {
  return new AgentRegistry(
    agentFactories
      .filter((module) => enabled.includes(module.id))
      .map((module) => module.create(context)),
  );
}
