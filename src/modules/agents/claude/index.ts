import type { AgentModule } from '../../contracts.js';
import type { AgentModuleContext } from '../index.js';
import { ClaudeRuntime } from './runtime.js';
import { ClaudeCatalogue } from './models.js';
import { ClaudeUsage } from './usage.js';
export function claudeModule(context: AgentModuleContext): AgentModule {
  const executable = context.executable('claude'),
    usage = new ClaudeUsage(context.store, executable);
  return {
    id: 'claude',
    name: 'Claude',
    catalogue: new ClaudeCatalogue(executable),
    usage,
    runtime: new ClaudeRuntime({
      executable,
      usage,
      protectedPaths: context.dataDir ? [context.dataDir] : [],
    }),
  };
}
