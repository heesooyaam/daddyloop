import { Command, Option } from 'commander';
import { writeFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import type { DaddyApi, DaddySession, DaddyBoard } from '../client/daddy.js';
import {
  sessionInstructionsSchema,
  type SessionInstructions,
  type SkillSnapshot,
} from '../core/instructions.js';
import { api as client } from './client.js';
import { instructionPath, readInstructionText } from './instruction-sources.js';

export function instructionOptions(command: Command) {
  const collect = (value: string, values: string[] = []) => [...values, value];
  return command
    .option('--daddy-instructions <text>', 'instructions for this session’s daddy')
    .option('--worker-instructions <text>', 'instructions shared by this session’s workers')
    .option(
      '--daddy-skill <source>',
      'attach GitHub, local SKILL.md or server:/path (repeatable)',
      collect,
    )
    .option('--worker-skill <source>', 'attach a skill for all workers (repeatable)', collect)
    .option('--instructions-file <file>', 'load both roles from a saved JSON instruction set')
    .addOption(
      new Option(
        '--clear-instructions <role>',
        'clear the selected role’s instructions and skills',
      ).choices(['daddy', 'worker', 'all']),
    );
}
export async function selectedInstructions(
  options: Record<string, any>,
  api: DaddyApi,
  previous?: SessionInstructions,
) {
  const changed = [
    'daddyInstructions',
    'workerInstructions',
    'daddySkill',
    'workerSkill',
    'instructionsFile',
    'clearInstructions',
  ].some((key) => options[key] !== undefined);
  if (!changed) return undefined;
  const result = options.instructionsFile
    ? sessionInstructionsSchema.parse(
        JSON.parse(await readInstructionText(options.instructionsFile, 1048576)),
      )
    : structuredClone(previous ?? { daddy: {}, worker: {} });
  for (const role of ['daddy', 'worker'] as const) {
    if (options.clearInstructions === role || options.clearInstructions === 'all')
      result[role] = {};
    if (options[role + 'Instructions'] !== undefined)
      result[role].prompt = options[role + 'Instructions'];
    for (const source of (options[role + 'Skill'] ?? []) as string[]) {
      let input;
      if (source.startsWith('server:')) input = { kind: 'local', path: source.slice(7) };
      else if (existsSync(instructionPath(source))) {
        const local = instructionPath(source);
        const path = (await stat(local)).isDirectory() ? join(local, 'SKILL.md') : local;
        input = { kind: 'file', name: basename(path), text: await readInstructionText(path) };
      } else input = { kind: 'github', url: source };
      const skill = await api<SkillSnapshot>('/instructions/import', input);
      const skills = result[role].skills ?? [];
      if (!skills.some((item) => item.checksum === skill.checksum))
        result[role].skills = [...skills, skill];
    }
  }
  return sessionInstructionsSchema.parse(result);
}
export function registerInstructionCommands(program: Command) {
  const api: DaddyApi = (path, body, signal) =>
    client(path, body, { dataDir: program.opts().dataDir, url: program.opts().url, signal });
  const command = program
    .command('instructions')
    .argument('<session>', 'session name or ID')
    .description('View or change instructions only for the selected daddy session')
    .option('--export <file>', 'save both roles as a portable JSON file; use - for stdout');
  instructionOptions(command).action(async (name, options) => {
    const sessions = await api<DaddySession[]>('/daddy/sessions');
    const matches = sessions.filter(
      (session) =>
        session.id === name ||
        session.id.startsWith(name) ||
        session.title.toLowerCase() === name.toLowerCase(),
    );
    if (matches.length !== 1)
      throw new Error('Choose a unique session name or ID from daddy sessions');
    const group = matches[0];
    const current = await api<DaddyBoard>(`/daddy/sessions/${group.id}`);
    const instructions = await selectedInstructions(options, api, current.group.instructions);
    if (instructions) await api(`/daddy/sessions/${group.id}/settings`, { instructions });
    const board = await api<DaddyBoard>(`/daddy/sessions/${group.id}`);
    const json =
      JSON.stringify(board.group.instructions ?? { daddy: {}, worker: {} }, null, 2) + '\n';
    if (options.export && options.export !== '-') {
      await writeFile(resolve(options.export), json, { flag: 'wx', mode: 0o600 });
      process.stdout.write('Saved: ' + resolve(options.export) + '\n');
    } else process.stdout.write(json);
  });
}
