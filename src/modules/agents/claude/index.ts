import { homedir } from 'node:os';
import { join } from 'node:path';
import { claudeCli } from './cli.js';
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
    cli: claudeCli(executable),
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

export const claudePrivatePaths = () =>
  [join(homedir(), '.claude/.credentials.json'), process.env.DADDYLOOP_CLAUDE_API_KEY_FILE].filter(
    (path): path is string => !!path,
  );
