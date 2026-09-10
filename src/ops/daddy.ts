import { Command } from 'commander';
import { api as client } from './client.js';
import type { Project } from '../core/types.js';
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
    .description('Show remaining Codex quotas and available resets')
    .option('--refresh', 'read fresh limits from Codex')
    .option('--json', 'print structured usage');
  limits.action(async (options) => {
    const view = await api<UsageView>('/usage' + (options.refresh ? '?refresh=1' : ''));
    if (options.json) print(view);
    else process.stdout.write(usageLines(view, loadConfig().locale).join('\n') + '\n');
  });
  limits
    .command('reset')
    .description('Use one earned Codex reset; retry with the same saved request ID')
    .option('--yes', 'confirm using one reset')
    .option('--request <id>', 'retry an existing reset request')
    .action(async (options) => {
      const plan = options.request
        ? { id: options.request }
        : await api<ResetPlan>('/usage/reset/prepare', {});
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
  const project = async (name: string) => {
    const matches = (await api<Project[]>('/projects')).filter(
      (project) =>
        project.id === name ||
        project.id.startsWith(name) ||
        project.name.toLowerCase() === name.toLowerCase(),
    );
    if (matches.length !== 1)
      throw new Error('Choose a unique project name or ID from daddy projects');
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
  const projects = program
    .command('projects')
    .description('Register and choose project folders on the server');
  projects.action(async () => print(await api('/projects')));
  projects
    .command('set')
    .argument('<project>')
    .argument('<path>')
    .option('--scope <directory>')
    .option('--base <branch>')
    .description('Change defaults on this server for future sessions')
    .action(async (name, path, options) => {
      const selected = await project(name);
      print(
        await api(`/projects/${selected.id}/defaults`, { name: selected.name, path, ...options }),
      );
    });
  projects
    .command('discover')
    .description('Find repositories on the server')
    .action(async () => print(await api('/projects/suggestions')));
  projects
    .command('browse')
    .argument('[path]')
    .description('Browse server directories')
    .action(async (path) =>
      print(await api('/projects/directories' + (path ? '?path=' + encodeURIComponent(path) : ''))),
    );
  projects
    .command('add')
    .argument('<path>')
    .requiredOption('--name <name>')
    .option('--scope <directory>')
    .option('--base <branch>')
    .description('Register a project once for phone, web and CLI')
    .action(async (path, options) =>
      print(
        await api('/projects', {
          path,
          name: options.name,
          ...(options.scope !== undefined ? { scope: options.scope } : {}),
          ...(options.base ? { base: options.base } : {}),
        }),
      ),
    );
  program
    .command('sessions')
    .description('List daddy sessions and writer pools')
    .action(async () => print(await api('/daddy/sessions')));
  program
    .command('new')
    .argument('[message]')
    .requiredOption('--project <project>')
    .option('--title <title>')
    .option('--writers <count>', 'maximum simultaneous writers', '1')
    .option('--repo <path>', 'repository for this session only')
    .option('--scope <directory>', 'relative starting directory for this session')
    .option('--base <branch>', 'base branch for this session')
    .description('Give daddy a goal in a registered project')
    .action(async (message, options) => {
      const selected = await project(options.project);
      const board = await api<DaddyBoard>('/daddy/sessions', {
        projectId: selected.id,
        workspace: workspaceOptions(options),
        message,
        title: options.title,
        writerLimit: Number(options.writers),
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
          workspace: workspaceOptions(options),
          requestId: crypto.randomUUID(),
        }),
      ),
    );
  program
    .command('pool')
    .argument('<session>')
    .argument('[writers]')
    .description('Inspect or resize a session’s writer pool')
    .action(async (name, writers) => {
      const group = await session(name);
      print(
        await api(
          `/daddy/sessions/${group.id}${writers ? '/settings' : ''}`,
          writers ? { writerLimit: Number(writers) } : undefined,
        ),
      );
    });
}
function workspaceOptions(options: { repo?: string; scope?: string; base?: string }) {
  if (options.repo === undefined && options.scope === undefined && options.base === undefined)
    return undefined;
  return { path: options.repo, scope: options.scope, base: options.base };
}
