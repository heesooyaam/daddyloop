import { Command } from 'commander';
import { api as client } from './client.js';
import type { Project } from '../core/types.js';
import type { DaddyBoard, DaddySession } from '../client/daddy.js';
export function registerDaddyCommands(program: Command) {
  const api = <T>(path: string, body?: unknown) =>
    client<T>(path, body, { dataDir: program.opts().dataDir, url: program.opts().url });
  const print = (value: unknown) => {
    process.stdout.write(JSON.stringify(value, null, 2) + '\n');
  };
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
    .description('List Daddy sessions and writer pools')
    .action(async () => print(await api('/daddy/sessions')));
  program
    .command('new')
    .argument('[message]')
    .requiredOption('--project <project>')
    .option('--title <title>')
    .option('--writers <count>', 'maximum simultaneous writers', '1')
    .description('Give Daddy a goal in a registered project')
    .action(async (message, options) => {
      const selected = await project(options.project);
      const board = await api<DaddyBoard>('/daddy/sessions', {
        projectId: selected.id,
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
    .description('Send a goal, ticket or question to Daddy')
    .action(async (name, text) =>
      print(
        await api(`/daddy/sessions/${(await session(name)).id}/chat`, {
          text,
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
