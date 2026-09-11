import { Command } from 'commander';
import { DatabaseSync } from 'node:sqlite';
import { delimiter, join } from 'node:path';
import { existsSync } from 'node:fs';
import { api as client } from './client.js';
import { loadConfig, saveConfig, defaultDataDir } from './config.js';
import { ServiceManager } from './service.js';
import { bundledRoot, executablePath, requireExecutable } from '../runtime/executable.js';
import { CodexCatalogue } from '../modules/agents/codex/models.js';
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
  const runtime = program
    .command('runtime')
    .description('Inspect or choose the Codex CLI used by this service');
  runtime.action(async () => print(await api('/updates/check', {})));
  for (const action of ['update', 'rollback'] as const)
    runtime
      .command(action)
      .option('--yes', 'confirm the displayed version and start the operation')
      .description(
        action === 'update'
          ? 'Install the latest stable Codex on the service host'
          : 'Restore the previous Codex version',
      )
      .action(async (options) => {
        const plan = await api<{ id: string }>('/runtime/update/prepare', {
          action: action === 'update' ? 'install' : 'rollback',
        });
        print(plan);
        if (options.yes) print(await api('/runtime/update/confirm', { id: plan.id }));
        else
          process.stdout.write(
            t('Run again with --yes to confirm, or use Updates in Telegram.') + '\n',
          );
      });
  runtime
    .command('update-status')
    .description('Inspect a server-side Codex update')
    .action(async () => print(await api('/runtime/update')));
  runtime
    .command('use')
    .argument('<executable>', 'absolute path, system, or bundled')
    .description('Choose a Codex executable on the service host; restart when idle')
    .action(async (value) => {
      const local = async () => {
        const status = await api<{
          instanceId: string;
          activeJobs: number;
          queuedJobs: number;
          runtime: { source: string };
          codexUpdater?: { busy: boolean };
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
        if (status.codexUpdater?.busy)
          throw new Error('Wait for the Codex update before changing the CLI');
        if (status.runtime.source === 'environment')
          throw new Error(
            'DADDYLOOP_CODEX_BIN overrides configuration; change that service environment setting first',
          );
        return config;
      };
      await local();
      let executable: string | undefined;
      if (value === 'bundled') {
        const root = bundledRoot();
        if (!root)
          throw new Error('This command is not running from an installed daddyloop bundle');
        executable = requireExecutable(join(root, 'modules/codex/bin/codex'));
      } else if (value === 'system') {
        const root = bundledRoot();
        executable = (process.env.PATH ?? '')
          .split(delimiter)
          .map((directory) => join(directory, 'codex'))
          .find((candidate) => {
            const path = executablePath(candidate);
            return path && (!root || !path.startsWith(root + '/'));
          });
        if (!executable) throw new Error('No external Codex executable was found on PATH');
        executable = requireExecutable(executable);
      } else executable = requireExecutable(value);
      const catalogue = new CodexCatalogue(executable);
      const models = await catalogue.list(true);
      const previous = await local(),
        next = loadConfig();
      if (value === 'bundled') delete next.executables.codex;
      else next.executables.codex = executable;
      saveConfig(next);
      try {
        await new ServiceManager().restart();
      } catch (error) {
        const current = loadConfig();
        if (current.executables.codex === next.executables.codex) {
          current.executables.codex = previous.executables.codex;
          if (!previous.executables.codex) delete current.executables.codex;
          saveConfig(current);
        }
        throw error;
      }
      print({
        executable,
        models: models.length,
        validation: 'app-server initialize + model/list',
        agentTurns: 'not run',
      });
      await api('/updates/check', {});
    });
}
