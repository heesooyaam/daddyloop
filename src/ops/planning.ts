import { Command, Option } from 'commander';
import { resolve } from 'node:path';
import { api as client } from './client.js';
import type { AgentProfiles, AgentProfile, Role, Task } from '../core/types.js';
export function registerPlanningCommands(program: Command) {
  const api = <T>(path: string, body?: unknown) =>
    client<T>(path, body, { dataDir: program.opts().dataDir, url: program.opts().url });
  const print = (value: unknown) => {
    process.stdout.write(JSON.stringify(value, null, 2) + '\n');
  };
  const profile = (
    base: AgentProfile,
    options: Record<string, string | boolean | undefined>,
    role: Role,
  ): AgentProfile => ({
    ...base,
    engine: 'codex',
    ...(options[role + 'Model'] ? { model: String(options[role + 'Model']) } : {}),
    ...(options[role + 'Effort']
      ? { effort: options[role + 'Effort'] as AgentProfile['effort'] }
      : {}),
  });
  const flags = (command: Command) =>
    command
      .option('--repo <path>', 'repository path on the service host')
      .option('--base <revision>', 'base branch or revision in the local checkout')
      .option('--author-model <model>')
      .option('--author-effort <effort>')
      .option('--reviewer-model <model>')
      .option('--reviewer-effort <effort>')
      .option('--manual-publish', 'wait before publishing review comments')
      .option('--no-auto-push', 'save implementation locally until explicit submit');
  const start = async (source: string, options: Record<string, string | boolean | undefined>) => {
    const settings = await api<{ defaults: AgentProfiles }>('/agents');
    let reviewer = settings.defaults.reviewer;
    if (options.parent)
      reviewer = (
        await api<{ agents: AgentProfiles }>(`/tasks/${encodeURIComponent(String(options.parent))}`)
      ).agents.reviewer;
    const task = await api<Task>('/tickets', {
      source,
      ...(options.repo ? { repoPath: resolve(String(options.repo)) } : {}),
      ...(options.parent ? { parentTaskId: options.parent } : {}),
      ...(options.base ? { base: options.base } : {}),
      agents: {
        author: profile(settings.defaults.author, options, 'author'),
        reviewer: profile(reviewer, options, 'reviewer'),
      },
      publication: options.manualPublish ? 'human' : 'auto',
      autoPush: options.autoPush !== false,
    });
    print(task);
    process.stdout.write(
      `\nContinue the author conversation: reviewctl console ${task.id} --role author\nStart implementation: reviewctl implement ${task.id}\n`,
    );
  };
  flags(
    program
      .command('start')
      .argument('<issue-or-ticket>')
      .option('--parent <task-id>', 'share the parent task’s reviewer'),
  )
    .description('Start a conversation from a GitHub issue or Tracker ticket')
    .action(start);
  flags(program.command('child').argument('<parent-task>').argument('<issue-or-ticket>'))
    .description('Give a child ticket its own author and the parent’s shared reviewer')
    .action((parent, source, options) => start(source, { ...options, parent }));
  program
    .command('models')
    .option('--refresh', 'query the Codex model catalogue again')
    .description('List available Codex models and reasoning efforts')
    .action(async (options) => print(await api(options.refresh ? '/agents?refresh=1' : '/agents')));
  const agents = program
    .command('agents')
    .description('Choose independent author and reviewer profiles');
  agents.command('show', { isDefault: true }).action(async () => print(await api('/agents')));
  agents
    .command('defaults')
    .option('--author-model <model>')
    .option('--author-effort <effort>')
    .option('--reviewer-model <model>')
    .option('--reviewer-effort <effort>')
    .option('--max-agents <number>', 'total concurrent agent limit', Number)
    .action(async (options) => {
      const current = await api<{ defaults: AgentProfiles }>('/agents');
      print(
        await api('/agents/defaults', {
          profiles: {
            author: profile(current.defaults.author, options, 'author'),
            reviewer: profile(current.defaults.reviewer, options, 'reviewer'),
          },
          ...(options.maxAgents !== undefined ? { maxConcurrentAgents: options.maxAgents } : {}),
        }),
      );
    });
  agents
    .command('set')
    .argument('<task>')
    .addOption(new Option('--role <role>').choices(['author', 'reviewer']).makeOptionMandatory())
    .option('--model <model>')
    .option('--effort <effort>')
    .option('--inherit', 'use the Codex configuration defaults')
    .action(async (id, options) => {
      const current = await api<{ agents: AgentProfiles }>(`/tasks/${encodeURIComponent(id)}`);
      const value = options.inherit
        ? { engine: 'codex' }
        : {
            ...current.agents[options.role as Role],
            ...(options.model ? { model: options.model } : {}),
            ...(options.effort ? { effort: options.effort } : {}),
          };
      print(
        await api(`/tasks/${encodeURIComponent(id)}/agents`, {
          role: options.role,
          profile: value,
        }),
      );
    });
  program
    .command('groups')
    .description('List large tasks, their authors and shared reviewers')
    .action(async () => print(await api('/groups')));
  program
    .command('link-pr')
    .argument('<task>')
    .argument('<pr-url>')
    .action(async (id, url) =>
      print(await api(`/tasks/${encodeURIComponent(id)}/link-pr`, { url })),
    );
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
        process.stdout.write(
          'Pair your bot with reviewctl telegram setup to receive notifications.\n',
        );
    });
}
