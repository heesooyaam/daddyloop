import { Command } from 'commander';
import { DatabaseSync } from 'node:sqlite';
import { delimiter, join } from 'node:path';
import { existsSync } from 'node:fs';
import { api as client } from './client.js';
import { loadConfig, saveConfig, defaultDataDir } from './config.js';
import { ServiceManager } from './service.js';
import { bundledRoot, executablePath, requireExecutable } from '../runtime/executable.js';
import { createAgents } from '../modules/agents/index.js';
import { moduleCatalogue } from '../modules/catalogue.js';
import { Store } from '../core/store.js';
import type { RuntimeUpdaterStatus } from '../core/runtime-updater.js';
import { preferenceInput } from '../core/preferences.js';
import { translator, normalizeLocale } from '../i18n/index.js';
export function registerEnvironmentCommands(program: Command) {
  const api = <T>(path: string, body?: unknown) =>
    client<T>(path, body, { dataDir: program.opts().dataDir, url: program.opts().url });
  const print = (value: unknown): void => {
    process.stdout.write(JSON.stringify(value, null, 2) + '\n');
  };
  const t = (value: string) =>
    translator(normalizeLocale(program.opts().language ?? loadConfig().locale))(value);
  program
    .command('language')
    .argument('[locale]')
    .description('Choose English or Russian')
    .action(async (locale) => {
      if (!locale) {
        print(await api('/preferences'));
        return;
      }
      const input = preferenceInput.parse({ locale });
      print(await api('/preferences', input));
      const config = loadConfig();
      config.locale = input.locale;
      saveConfig(config);
      process.stdout.write(t('Language saved.') + '\n');
    });
  program
    .command('updates')
    .option('--check', 'check the version registries now')
    .description('CLI versions and update notifications')
    .action(async (options) =>
      print(
        await api(options.check ? '/updates/check' : '/updates', options.check ? {} : undefined),
      ),
    );
  const selectEngine = async (engine?: string) => {
    const installed = await api<RuntimeUpdaterStatus[]>('/runtimes');
    if (engine && installed.some((item) => item.engine === engine)) return engine;
    if (!engine && installed.length === 1) return installed[0].engine;
    throw new Error(
      `Choose --engine from: ${installed.map((item) => item.engine).join(', ') || 'no installed CLI adapters'}`,
    );
  };
  const runtime = program
    .command('runtime')
    .description('Inspect or choose an agent CLI used by this service');
  runtime.action(async () => print(await api('/updates/check', {})));
  for (const action of ['update', 'rollback'] as const)
    runtime
      .command(action)
      .option('--engine <id>', 'agent module ID')
      .option('--yes', 'confirm the displayed version and start the operation')
      .description(
        action === 'update'
          ? 'Install the latest stable agent CLI on the service host'
          : 'Restore the previous agent CLI version',
      )
      .action(async (options) => {
        const engine = await selectEngine(options.engine);
        const plan = await api<{ id: string }>(`/runtimes/${engine}/update/prepare`, {
          action: action === 'update' ? 'install' : 'rollback',
        });
        print(plan);
        if (options.yes) print(await api(`/runtimes/${engine}/update/confirm`, { id: plan.id }));
        else
          process.stdout.write(
            t('Run again with --yes to confirm, or use Updates in Telegram.') + '\n',
          );
      });
  runtime
    .command('update-status')
    .description('Inspect server-side agent CLI updates')
    .action(async () => print(await api('/runtimes')));
  runtime
    .command('use')
    .option('--engine <id>', 'agent module ID')
    .argument('<executable>', 'absolute path, system, or bundled')
    .description('Choose an agent executable on the service host; restart when idle')
    .action(async (value, options) => {
      const engine = await selectEngine(options.engine);
      const entry = moduleCatalogue.find(
        (module) => module.id === engine && module.kind === 'agent',
      );
      if (!entry || !('command' in entry))
        throw new Error('This adapter has no executable command');
      const binary = entry.command;
      const local = async () => {
        const status = await api<{
          instanceId: string;
          activeJobs: number;
          queuedJobs: number;
          runtimes: { engine: string; source: string }[];
          updaters: RuntimeUpdaterStatus[];
        }>('/status');
        const config = loadConfig(),
          file = join(program.opts().dataDir ?? defaultDataDir(config), 'daddyloop.sqlite');
        if (!existsSync(file)) throw new Error('Run this command on the service host');
        const db = new DatabaseSync(file, { readOnly: true });
        try {
          const row = db.prepare("SELECT value FROM settings WHERE key='server.instanceId'").get();
          if (!row || JSON.parse(row.value as string) !== status.instanceId)
            throw new Error('This client does not own the connected service installation');
        } finally {
          db.close();
        }
        if (status.activeJobs || status.queuedJobs)
          throw new Error('Wait for running and queued jobs before changing the CLI');
        if (status.updaters.some((item) => item.busy))
          throw new Error('Wait for the agent CLI update before changing the CLI');
        if (status.runtimes.find((item) => item.engine === engine)?.source === 'environment')
          throw new Error(
            'The agent executable is overridden by the service environment; change that setting first',
          );
        return config;
      };
      await local();
      let executable: string | undefined;
      if (value === 'bundled') {
        const root = bundledRoot();
        if (!root)
          throw new Error('This command is not running from an installed daddyloop bundle');
        executable = requireExecutable(join(root, 'modules', engine, 'bin', binary));
      } else if (value === 'system') {
        const root = bundledRoot();
        executable = (process.env.PATH ?? '')
          .split(delimiter)
          .map((directory) => join(directory, binary))
          .find((candidate) => {
            const path = executablePath(candidate);
            return path && (!root || !path.startsWith(root + '/'));
          });
        if (!executable) throw new Error('No external agent CLI executable was found on PATH');
        executable = requireExecutable(executable);
      } else executable = requireExecutable(value);
      const temporary = new Store(':memory:');
      let models;
      try {
        const cli = createAgents([engine], { store: temporary, executable: () => executable }).get(
          engine,
        ).cli;
        if (!cli) throw new Error('This adapter has no CLI validation capability');
        models = (await cli.validate(executable, AbortSignal.timeout(30000))).models;
        if (!models.length) throw new Error('The candidate CLI returned no models');
      } finally {
        temporary.close();
      }
      const previous = await local(),
        next = loadConfig();
      if (value === 'bundled') delete next.executables[engine];
      else next.executables[engine] = executable;
      saveConfig(next);
      try {
        await new ServiceManager().restart();
      } catch (error) {
        const current = loadConfig();
        if (current.executables[engine] === next.executables[engine]) {
          current.executables[engine] = previous.executables[engine];
          if (!previous.executables[engine]) delete current.executables[engine];
          saveConfig(current);
        }
        throw error;
      }
      print({
        executable,
        models: models.length,
        validation: 'adapter CLI and model catalogue',
        agentTurns: 'not run',
      });
      await api('/updates/check', {});
    });
}
