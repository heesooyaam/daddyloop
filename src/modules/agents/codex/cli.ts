import { codexExecutable } from './executable.js';
import type { AgentCli } from '../../contracts.js';
import { type Executable } from '../../../runtime/executable.js';
import { probeCli, latestVersion } from '../cli.js';
import { CodexCatalogue } from './models.js';
import { CodexConnection } from './protocol.js';
import { installCodexPackage, latestCodexPackage } from './package.js';
export function codexCli(value: Executable): AgentCli {
  const executable = () => codexExecutable(value ?? 'codex');
  return {
    name: 'Codex CLI',
    executable,
    releaseUrl: 'https://github.com/openai/codex/releases',
    probe: probeCli,
    latestVersion: (signal) => latestVersion('@openai/codex', signal),
    validate: async (path, signal) => {
      const catalogue = new CodexCatalogue(path);
      const models = await catalogue.list(true, signal);
      return { models, version: catalogue.metadata().cliVersion };
    },
    diagnose: async (signal) => {
      const rpc = new CodexConnection(executable());
      const cancel = () => rpc.close();
      signal.throwIfAborted();
      signal.addEventListener('abort', cancel, { once: true });
      try {
        await rpc.start(process.cwd());
        const result = await rpc.request<{
          account: { type: string } | null;
          requiresOpenaiAuth: boolean;
        }>('account/read', { refreshToken: false });
        return {
          connected: true,
          authType: result.account?.type ?? null,
          requiresOpenaiAuth: result.requiresOpenaiAuth,
        };
      } finally {
        signal.removeEventListener('abort', cancel);
        rpc.close();
      }
    },
    updates: {
      unavailableReason:
        process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch)
          ? 'Managed updates require Linux x64 or ARM64'
          : undefined,
      latest: latestCodexPackage,
      install: installCodexPackage,
    },
  };
}
