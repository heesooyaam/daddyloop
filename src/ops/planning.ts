import { Command, Option } from 'commander';
import { api as client } from './client.js';
import type { AgentProfiles, AgentProfile } from '../core/types.js';
export function registerPlanningCommands(program: Command) {
  const api = <T>(path: string, body?: unknown) =>
    client<T>(path, body, { dataDir: program.opts().dataDir, url: program.opts().url });
  const print = (value: unknown) => {
    process.stdout.write(JSON.stringify(value, null, 2) + '\n');
  };
  const profile = (
    base: AgentProfile,
    options: Record<string, string | boolean | undefined>,
    role: keyof AgentProfiles,
  ): AgentProfile => ({
    ...base,
    engine: 'codex',
    ...(options[role + 'Model'] ? { model: String(options[role + 'Model']) } : {}),
    ...(options[role + 'Effort']
      ? { effort: options[role + 'Effort'] as AgentProfile['effort'] }
      : {}),
  });
  program
    .command('models')
    .option('--refresh', 'query the Codex model catalogue again')
    .description('List available Codex models and reasoning efforts')
    .action(async (options) => print(await api(options.refresh ? '/agents?refresh=1' : '/agents')));
  const agents = program
    .command('agents')
    .description('Choose independent writer and daddy profiles');
  agents.command('show', { isDefault: true }).action(async () => print(await api('/agents')));
  agents
    .command('defaults')
    .option('--writer-model <model>')
    .option('--writer-effort <effort>')
    .option('--daddy-model <model>')
    .option('--daddy-effort <effort>')
    .option('--max-agents <number>', 'total concurrent agent limit', Number)
    .action(async (options) => {
      const current = await api<{ defaults: AgentProfiles }>('/agents');
      print(
        await api('/agents/defaults', {
          profiles: {
            writer: profile(current.defaults.writer, options, 'writer'),
            daddy: profile(current.defaults.daddy, options, 'daddy'),
          },
          ...(options.maxAgents !== undefined ? { maxConcurrentAgents: options.maxAgents } : {}),
        }),
      );
    });
  program
    .command('notifications')
    .argument('[mode]', 'on or off')
    .addOption(new Option('--events <events>').choices(['attention', 'all']))
    .description('Configure Telegram notifications')
    .action(async (mode, options) => {
      const current = await api<{ telegram: { enabled: boolean; mode: string }; paired: boolean }>(
        '/notifications',
      );
      if (mode === undefined) {
        print(current);
        return;
      }
      if (mode !== 'on' && mode !== 'off') throw new Error('Choose notifications on or off');
      const result = await api<{ paired: boolean }>('/notifications', {
        enabled: mode === 'on',
        mode: options.events ?? current.telegram.mode,
      });
      print(result);
      if (!result.paired && mode === 'on')
        process.stdout.write('Pair your bot with daddy telegram setup to receive notifications.\n');
    });
}
