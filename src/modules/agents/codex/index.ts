import { CodexRuntime } from '../../../runtime/codex.js';
import { CodexCatalogue } from './models.js';
import type { Executable } from '../../../runtime/executable.js';
import type { AgentModule } from '../../contracts.js';
export function codexModule(executable: Executable): AgentModule {
  return {
    id: 'codex',
    name: 'Codex',
    runtime: new CodexRuntime({ executable, model: process.env.DADDYLOOP_CODEX_MODEL }),
    catalogue: new CodexCatalogue(executable),
  };
}
