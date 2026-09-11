import { Command } from 'commander';
import { api as client } from './client.js';
import type { Workspace } from '../core/types.js';
import type { DaddyBoard, DaddySession } from '../client/daddy.js';
import type { ResetPlan, UsageView } from '../core/usage.js';
import { usageLines, resetOutcomeText } from '../client/usage.js';
import { loadConfig } from './config.js';
import { translator } from '../i18n/index.js';
export function registerDaddyCommands(program: Command) {
  const api = <T>(path: string, body?: unknown) =>
    client<T>(path, body, { dataDir: program.opts().dataDir, url: program.opts().url });
  const print = (value: unknown) => {
    process.stdout.write(JSON.stringify(value, null, 2) + '\n');
  };
  const limits = program
    .command('limits')
    .description('Show provider quotas and available resets')
    .option('--refresh', 'refresh readings from agent modules')
    .option('--json', 'print structured usage');
  limits.action(async (options) => {
    const view = await api<UsageView>('/usage' + (options.refresh ? '?refresh=1' : ''));
    if (options.json) print(view);
    else process.stdout.write(usageLines(view, loadConfig().locale).join('\n') + '\n');
  });
  limits
    .command('reset')
    .description('Use one provider quota reset; retry with the same saved request ID')
    .option('--yes', 'confirm using one reset')
    .option('--engine <id>', 'agent module to reset')
    .option('--request <id>', 'retry an existing reset request')
    .action(async (options) => {
      const plan = options.request
        ? { id: options.request }
        : await api<ResetPlan>('/usage/reset/prepare', { engine: options.engine });
      if (!options.yes) {
        print(plan);
        process.stdout.write(`\ndaddy limits reset --request ${plan.id} --yes\n`);
        return;
      }
      process.stdout.write(`Reset request: ${plan.id}\n`);
      const result = await api<{ plan: ResetPlan; usage: UsageView }>(`/usage/reset/${plan.id}`, {
        confirmed: true,
      });
      const locale = loadConfig().locale;
      process.stdout.write(
        translator(locale)(resetOutcomeText[result.plan.outcome!]) +
          '\n' +
          usageLines(result.usage, locale).join('\n') +
          '\n',
      );
    });
  const workspace = async (name: string) => {
    const matches = (await api<Workspace[]>('/workspaces')).filter(
      (workspace) =>
        workspace.id === name ||
        workspace.id.startsWith(name) ||
        workspace.name.toLowerCase() === name.toLowerCase(),
    );
    if (matches.length !== 1)
      throw new Error('Choose a unique workspace name or ID from daddy workspaces');
    return matches[0];
  };
  const session = async (name: string) => {
    const matches = (await api<DaddySession[]>('/daddy/sessions')).filter(
      (group) =>
        group.id === name ||
        group.id.startsWith(name) ||
        group.title.toLowerCase() === name.toLowerCase(),
    );
    if (matches.length !== 1)
      throw new Error('Choose a unique session name or ID from daddy sessions');
    return matches[0];
  };
  const workspaces = program
    .command('workspaces')
    .description('Register and choose workspace folders on the server');
  workspaces.action(async () => print(await api('/workspaces')));
  workspaces
    .command('set')
    .argument('<workspace>')
    .argument('<path>')
    .option('--scope <directory>')
    .option('--base <branch>')
    .description('Change defaults on this server for future sessions')
    .action(async (name, path, options) => {
      const selected = await workspace(name);
      print(
        await api(`/workspaces/${selected.id}/defaults`, { name: selected.name, path, ...options }),
      );
    });
  workspaces
    .command('discover')
    .description('Find repositories on the server')
    .action(async () => print(await api('/workspaces/suggestions')));
  workspaces
    .command('browse')
    .argument('[path]')
    .description('Browse server directories')
    .action(async (path) =>
      print(
        await api('/workspaces/directories' + (path ? '?path=' + encodeURIComponent(path) : '')),
      ),
    );
  workspaces
    .command('add')
    .argument('<path>')
    .requiredOption('--name <name>')
    .option('--provider <module>', 'repository module for this remote')
    .option('--scope <directory>')
    .option('--base <branch>')
    .description('Register a workspace once for phone, web and CLI')
    .action(async (path, options) =>
      print(
        await api('/workspaces', {
          path,
          name: options.name,
          provider: options.provider,
          ...(options.scope !== undefined ? { scope: options.scope } : {}),
          ...(options.base ? { base: options.base } : {}),
        }),
      ),
    );
  program
    .command('sessions')
    .description('List daddy sessions and worker pools')
    .action(async () => print(await api('/daddy/sessions')));
  program
    .command('new')
    .argument('[message]')
    .option('--workspace <name>', 'workspace to use')
    .option('--title <title>')
    .option('--workers <count>', 'maximum simultaneous workers', '1')
    .option('--repo <path>', 'repository for this session only')
    .option('--scope <directory>', 'relative starting directory for this session')
    .option('--base <branch>', 'base branch for this session')
    .description('Give daddy a goal in a registered workspace')
    .action(async (message, options) => {
      if (!options.workspace) throw new Error('Choose a workspace with --workspace');
      const selected = await workspace(options.workspace);
      const board = await api<DaddyBoard>('/daddy/sessions', {
        workspaceId: selected.id,
        repository: workspaceOptions(options),
        message,
        title: options.title,
        workerLimit: Number(options.workers),
        requestId: crypto.randomUUID(),
      });
      print(board);
      process.stdout.write(
        `\ndaddy talk ${board.group.id} "..."\ndaddy console ${board.group.id}\n`,
      );
    });
  program
    .command('talk')
    .argument('<session>')
    .argument('<message>')
    .option('--repo <path>', 'repository for this message only')
    .option('--scope <directory>', 'relative starting directory for this message')
    .option('--base <branch>', 'base branch for this message')
    .description('Send a goal, ticket or question to daddy')
    .action(async (name, text, options) =>
      print(
        await api(`/daddy/sessions/${(await session(name)).id}/chat`, {
          text,
          repository: workspaceOptions(options),
          requestId: crypto.randomUUID(),
        }),
      ),
    );
  program
    .command('pool')
    .argument('<session>')
    .argument('[workers]')
    .description('Inspect or resize a session’s worker pool')
    .action(async (name, workers) => {
      const group = await session(name);
      print(
        await api(
          `/daddy/sessions/${group.id}${workers ? '/settings' : ''}`,
          workers ? { workerLimit: Number(workers) } : undefined,
        ),
      );
    });
}
function workspaceOptions(options: { repo?: string; scope?: string; base?: string }) {
  if (options.repo === undefined && options.scope === undefined && options.base === undefined)
    return undefined;
  return { path: options.repo, scope: options.scope, base: options.base };
}
