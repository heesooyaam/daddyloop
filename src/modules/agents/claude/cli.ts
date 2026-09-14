import type { AgentCli } from '../../contracts.js';
import type { Executable } from '../../../runtime/executable.js';
import { probeCli, latestVersion } from '../cli.js';
import { ClaudeCatalogue } from './models.js';
import { claudeExecutable, connectionOptions, idleInput } from './connection.js';
import { installClaudePackage, latestClaudePackage } from './package.js';
export function claudeCli(value: Executable): AgentCli {
  const executable = () => claudeExecutable(value);
  return {
    name: 'Claude Code',
    executable,
    releaseUrl: 'https://code.claude.com/docs/en/changelog',
    probe: probeCli,
    latestVersion: (signal) => latestVersion('@anthropic-ai/claude-code', signal),
    validate: async (path, signal) => {
      const { version } = await probeCli(path, signal);
      return { version, models: await new ClaudeCatalogue(path).list(true, signal) };
    },
    diagnose: async (signal) => {
      const { query } = await import('@anthropic-ai/claude-agent-sdk');
      const abort = new AbortController(),
        cancel = () => abort.abort();
      signal.throwIfAborted();
      signal.addEventListener('abort', cancel, { once: true });
      const timer = setTimeout(cancel, 20000);
      let session: ReturnType<typeof query> | undefined;
      try {
        session = query({
          prompt: idleInput(abort.signal),
          options: {
            ...connectionOptions(executable()),
            abortController: abort,
            tools: [],
            maxTurns: 1,
          },
        });
        const account = await session.accountInfo();
        abort.signal.throwIfAborted();
        return { connected: true, apiKeySource: account.apiKeySource ?? null };
      } finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', cancel);
        abort.abort();
        session?.close();
      }
    },
    updates: {
      unavailableReason:
        process.platform !== 'linux' ||
        !['x64', 'arm64'].includes(process.arch) ||
        !(process.report.getReport() as { header: { glibcVersionRuntime?: string } }).header
          .glibcVersionRuntime
          ? 'Managed updates require Linux glibc x64 or ARM64'
          : undefined,
      latest: latestClaudePackage,
      install: installClaudePackage,
    },
  };
}
