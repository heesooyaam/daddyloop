import { Command, Option } from 'commander';
import { writeFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import type { DaddyApi, DaddySession, DaddyBoard } from '../client/daddy.js';
import {
  sessionInstructionsSchema,
  type SessionInstructions,
  type SkillSnapshot,
  type InstructionPreset,
} from '../core/instructions.js';
import { api as client } from './client.js';
import { instructionPath, readInstructionText } from './instruction-sources.js';
import { findPreset, selectPreset, clearInstructionRole } from '../client/presets.js';

export function instructionOptions(command: Command) {
  const collect = (value: string, values: string[] = []) => [...values, value];
  return command
    .option('--preset <name>', 'enable a saved preset for this session (repeatable)', collect)
    .option(
      '--preset-off <name>',
      'disable a selected preset without losing its component choices (repeatable)',
      collect,
    )
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
    'preset',
    'presetOff',
  ].some((key) => options[key] !== undefined);
  if (!changed) return undefined;
  let result: SessionInstructions = options.instructionsFile
    ? sessionInstructionsSchema.parse(
        JSON.parse(await readInstructionText(options.instructionsFile, 1048576)),
      )
    : structuredClone(previous ?? { daddy: {}, worker: {} });
  if (options.preset?.length) {
    const library = await api<{ id: string; name: string }[]>('/instructions/presets');
    for (const name of options.preset as string[]) {
      const snapshots = result.presets?.map((item) => item.preset) ?? [];
      const choice = findPreset(
        [
          ...snapshots,
          ...library.filter((item) => !snapshots.some((snapshot) => snapshot.id === item.id)),
        ],
        name,
      );
      const preset =
        snapshots.find((item) => item.id === choice.id) ??
        (await api<InstructionPreset>('/instructions/presets/' + choice.id));
      result = selectPreset(result, preset);
    }
  }
  for (const name of (options.presetOff ?? []) as string[]) {
    const preset = findPreset(result.presets?.map((item) => item.preset) ?? [], name);
    result = selectPreset(result, preset, false);
  }
  for (const role of ['daddy', 'worker'] as const) {
    if (options.clearInstructions === role || options.clearInstructions === 'all')
      result = clearInstructionRole(result, role);
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
  const presets = program
    .command('presets')
    .description('Manage reusable instruction presets for this daddy installation');
  const print = (value: unknown): void => {
    process.stdout.write(JSON.stringify(value, null, 2) + '\n');
  };
  const lookup = async (name: string) =>
    findPreset(
      await api<{ id: string; name: string; revision: number }[]>('/instructions/presets'),
      name,
    );
  presets.action(async () => print(await api('/instructions/presets')));
  presets
    .command('show')
    .argument('<preset>')
    .action(async (name) => print(await api('/instructions/presets/' + (await lookup(name)).id)));
  presets
    .command('save')
    .argument('<name>')
    .option('--instructions-file <file>', 'JSON instruction set')
    .option('--from-session <session>', 'copy active settings from a session')
    .option('--description <text>', 'preset description')
    .action(async (name, options) => {
      if (!!options.instructionsFile === !!options.fromSession)
        throw new Error('Choose --instructions-file or --from-session');
      let instructions: SessionInstructions;
      if (options.instructionsFile)
        instructions = sessionInstructionsSchema.parse(
          JSON.parse(await readInstructionText(options.instructionsFile, 1048576)),
        );
      else {
        const sessions = await api<DaddySession[]>('/daddy/sessions');
        const matches = sessions.filter(
          (session) =>
            session.id === options.fromSession ||
            session.id.startsWith(options.fromSession) ||
            session.title.toLowerCase() === options.fromSession.toLowerCase(),
        );
        if (matches.length !== 1)
          throw new Error('Choose a unique session name or ID from daddy sessions');
        instructions = (await api<DaddyBoard>('/daddy/sessions/' + matches[0].id)).group
          .instructions ?? { daddy: {}, worker: {} };
      }
      const library =
        await api<{ id: string; name: string; revision: number; description: string }[]>(
          '/instructions/presets',
        );
      const prior = library.find((preset) => preset.name.toLowerCase() === name.toLowerCase());
      print(
        await api('/instructions/presets' + (prior ? '/' + prior.id : ''), {
          name,
          description: options.description ?? prior?.description ?? '',
          instructions,
          ...(prior ? { expectedRevision: prior.revision } : {}),
        }),
      );
    });
  presets
    .command('delete')
    .argument('<preset>')
    .action(async (name) => {
      const preset = await lookup(name);
      print(
        await api('/instructions/presets/' + preset.id + '/delete', {
          expectedRevision: preset.revision,
        }),
      );
    });
}
