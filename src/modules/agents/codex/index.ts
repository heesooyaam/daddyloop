import { homedir } from 'node:os';
import { join } from 'node:path';
import { codexCli } from './cli.js';
import { CodexUsage } from './usage.js';
import type { Store } from '../../../core/store.js';
import { CodexRuntime } from './runtime.js';
import { CodexCatalogue } from './models.js';
import type { Executable } from '../../../runtime/executable.js';
import type { AgentModule } from '../../contracts.js';
export function codexModule(executable: Executable, store: Store): AgentModule {
  return {
    id: 'codex',
    cli: codexCli(executable),
    name: 'Codex',
    runtime: new CodexRuntime({ executable, model: process.env.DADDYLOOP_CODEX_MODEL }),
    catalogue: new CodexCatalogue(executable),
    usage: new CodexUsage(store, executable),
  };
}

export const codexPrivatePaths = () => [join(homedir(), '.codex/auth.json')];
