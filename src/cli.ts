#!/usr/bin/env node
import { registerBackupCommands } from './ops/backup/commands.js';
import { Command, Option, Help } from 'commander';
import { readFileSync, existsSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import type { Locale } from './i18n/index.js';
import { buildApp } from './server/app.js';
import { credential, redact, rememberSecret } from './core/security.js';
import { resources } from './core/resources.js';
import { ProviderHttp } from './providers/http.js';
import { CodexConnection } from './runtime/protocol.js';
import { git } from './runtime/workspaces.js';
import { loadConfig, defaultDataDir, configSchema } from './ops/config.js';
import { api as callApi } from './ops/client.js';
import { registerOperations } from './ops/commands.js';
import { consoleUI } from './ops/console.js';
import { VERSION } from './version.js';
import { registerPlanningCommands } from './ops/planning.js';
import { registerEnvironmentCommands } from './ops/environment.js';
import { registerModuleCommands } from './ops/modules.js';
import { registerDaddyCommands } from './ops/daddy.js';
import { registerInstructionCommands } from './ops/instructions.js';
import { webConnectionText } from './ops/web.js';
import { normalizeLocale, translator } from './i18n/index.js';

const helpOnly = process.argv.some((arg) => ['--help', '-h', '--version', '-V'].includes(arg));
const initialConfig = helpOnly ? configSchema.parse({}) : loadConfig();
const program = new Command()
  .name('daddy')
  .description('One daddy, a pool of workers, and persistent work on your server')
  .version(VERSION)
  .option('--plain', 'use the basic line-oriented console')
  .addOption(
    new Option('--language <locale>', 'interface language for this client').choices(['en', 'ru']),
  )
  .addOption(
    new Option('--theme <theme>', 'terminal appearance').choices(['dark', 'light']).default('dark'),
  )
  .option('--data-dir <path>', 'local state directory', defaultDataDir(initialConfig))
  .option(
    '--url <url>',
    'daddyloop backend URL',
    process.env.DADDYLOOP_URL ?? initialConfig.serverUrl,
  );
const dataDir = () => resolve(program.opts().dataDir);
async function api(path: string, body?: unknown) {
  return callApi(path, body, { dataDir: dataDir(), url: program.opts().url });
}
const print = (value: unknown): void => {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
};
program
  .command('serve')
  .description('Run the local backend, worker and web panel')
  .option('--port <port>', 'loopback port', String(initialConfig.port))
  .option('--demo', 'enable explicitly labeled demo tasks', false)
  .option(
    '--min-disk-gib <size>',
    'stop starting jobs below this disk space',
    String(initialConfig.resources.minDiskGiB),
  )
  .option(
    '--max-disk-percent <percent>',
    'stop starting jobs at this usage',
    String(initialConfig.resources.maxDiskPercent),
  )
  .option(
    '--min-memory-gib <size>',
    'stop starting jobs below available RAM',
    String(initialConfig.resources.minMemoryGiB),
  )
  .action(async (options) => {
    const dir = dataDir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const lock = join(dir, 'server.lock');
    if (existsSync(lock)) {
      const pid = Number(readFileSync(lock, 'utf8'));
      try {
        process.kill(pid, 0);
        throw new Error(`daddyloop is already running (PID ${pid})`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        unlinkSync(lock);
      }
    }
    writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 });
    try {
      const { app } = await buildApp({
        dataDir: dir,
        demo: options.demo,
        minDiskGiB: Number(options.minDiskGib),
        maxDiskPercent: Number(options.maxDiskPercent),
        minMemoryGiB: Number(options.minMemoryGib),
      });
      await app.listen({ host: '127.0.0.1', port: Number(options.port) });
      process.stdout.write(
        `daddyloop: http://127.0.0.1:${options.port}\nAccess token: ${join(dir, 'access-token')} (daddy token)\nMode: ${options.demo ? 'live integrations + demo fixtures' : 'live integrations'}\n`,
      );
      let closing = false;
      const shutdown = async () => {
        if (closing) return;
        closing = true;
        await app.close();
        if (existsSync(lock)) unlinkSync(lock);
        process.exit(0);
      };
      process.on('SIGINT', () => {
        void shutdown();
      });
      process.on('SIGTERM', () => {
        void shutdown();
      });
    } catch (error) {
      unlinkSync(lock);
      throw error;
    }
  });
program
  .command('token')
  .description('Print the local web-panel access token')
  .action(() => {
    process.stdout.write(readFileSync(join(dataDir(), 'access-token'), 'utf8').trim() + '\n');
  });
program.command('status').action(async () => print(await api('/status')));
program
  .command('logs')
  .argument('<task>')
  .option('-f, --follow', 'stream new persisted events')
  .action(async (id, options) => {
    let after = 0;
    do {
      const events = (await api(
        `/tasks/${encodeURIComponent(id)}/events?after=${after}`,
      )) as unknown as { id: number }[];
      for (const event of events) {
        process.stdout.write(JSON.stringify(event) + '\n');
        after = event.id;
      }
      if (!options.follow && events.length < 500) break;
      if (events.length < 500) await new Promise((resolve) => setTimeout(resolve, 1000));
    } while (true);
  });
program
  .command('open')
  .argument('[session]')
  .action((id) => {
    if (
      process.env.SSH_CONNECTION ||
      process.env.SSH_TTY ||
      (process.platform !== 'darwin' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY)
    ) {
      const config = loadConfig();
      process.stdout.write(webConnectionText(config) + '\n');
      if (id)
        process.stdout.write(
          `${config.publicOrigin ?? `http://127.0.0.1:${config.port}`}/#session/${encodeURIComponent(id)}\n`,
        );
      return;
    }
    const url = program.opts().url + (id ? `/#session/${encodeURIComponent(id)}` : '');
    const browser = spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], {
      stdio: 'ignore',
      detached: true,
    });
    browser.on('error', () => process.stdout.write(url + '\n'));
    browser.unref();
  });
program
  .command('doctor')
  .description(
    'Check resources, credentials and the installed Codex protocol without running a model',
  )
  .action(async () => {
    mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
    print({ resources: resources(dataDir()) });
    for (const provider of ['github', 'gitlab'] as const) {
      const host = process.env[`DADDYLOOP_${provider.toUpperCase()}_HOST`] ?? `${provider}.com`;
      try {
        const token = credential(provider, host);
        const http = new ProviderHttp(
          provider === 'github'
            ? host === 'github.com'
              ? 'https://api.github.com'
              : `https://${host}/api/v3`
            : `https://${host}/api/v4`,
          provider === 'github' ? { Authorization: `Bearer ${token}` } : { 'PRIVATE-TOKEN': token },
        );
        const user = await http.request<{ login?: string; username?: string }>('GET', '/user');
        print({
          provider,
          host,
          authenticated: true,
          user: user.login ?? user.username,
        });
      } catch (error) {
        print({
          provider,
          host,
          authenticated: false,
          reason: redact(String(error)),
        });
      }
    }
    const rpc = new CodexConnection(process.env.DADDYLOOP_CODEX_BIN);
    try {
      await rpc.start(process.cwd());
      const result = await rpc.request<{
        account: { type: string } | null;
        requiresOpenaiAuth: boolean;
      }>('account/read', { refreshToken: false });
      print({
        codex: 'connected',
        authType: result.account?.type ?? null,
        requiresOpenaiAuth: result.requiresOpenaiAuth,
      });
    } catch (error) {
      print({ codex: 'unavailable', error: redact(String(error)) });
    } finally {
      rpc.close();
    }
  });
program
  .command('create-remotes')
  .description('Create private GitHub/GitLab workspace repositories when credentials are available')
  .option('--name <name>', 'repository name', 'daddyloop')
  .option('--push', 'push the local main branch after creating remotes', false)
  .action(async (options) => {
    if (!/^[a-zA-Z0-9._-]+$/.test(options.name)) throw new Error('Invalid repository name');
    for (const provider of ['github', 'gitlab'] as const) {
      const host = process.env[`DADDYLOOP_${provider.toUpperCase()}_HOST`] ?? `${provider}.com`;
      try {
        const token = credential(provider, host);
        const http = new ProviderHttp(
          provider === 'github'
            ? host === 'github.com'
              ? 'https://api.github.com'
              : `https://${host}/api/v3`
            : `https://${host}/api/v4`,
          provider === 'github' ? { Authorization: `Bearer ${token}` } : { 'PRIVATE-TOKEN': token },
        );
        const user = await http.request<{ login?: string; username?: string }>('GET', '/user');
        const owner = user.login ?? user.username!;
        const getPath =
          provider === 'github'
            ? `/repos/${owner}/${options.name}`
            : `/projects/${encodeURIComponent(`${owner}/${options.name}`)}`;
        let repo: {
          html_url?: string;
          web_url?: string;
          clone_url?: string;
          http_url_to_repo?: string;
          private?: boolean;
          visibility?: string;
        };
        try {
          repo = await http.request('GET', getPath);
        } catch (error) {
          if (!String(error).includes('HTTP 404')) throw error;
          repo = await http.request(
            'POST',
            provider === 'github' ? '/user/repos' : '/projects',
            provider === 'github'
              ? {
                  name: options.name,
                  private: true,
                  description: 'Persistent author and reviewer workflow',
                }
              : {
                  name: options.name,
                  path: options.name,
                  visibility: 'private',
                  initialize_with_readme: false,
                },
          );
        }
        if (provider === 'github' ? repo.private !== true : repo.visibility !== 'private')
          throw new Error(
            'An existing repository is not private; this command does not publish local code into it',
          );
        const clone = repo.clone_url ?? repo.http_url_to_repo!;
        const cloneUrl = new URL(clone);
        if (cloneUrl.origin !== `https://${host}` || cloneUrl.username || cloneUrl.password)
          throw new Error('Unexpected clone URL returned by the provider');
        const remotes = (await git(['remote'], process.cwd())).split('\n');
        if (!remotes.includes(provider))
          await git(['remote', 'add', provider, clone], process.cwd());
        else if ((await git(['remote', 'get-url', provider], process.cwd())) !== clone)
          throw new Error(`Existing ${provider} remote points somewhere else; preserved it`);
        print({
          provider,
          created: repo.html_url ?? repo.web_url,
          remote: provider,
        });
        if (options.push)
          print({
            provider,
            push: await git(['push', '-u', provider, 'main'], process.cwd(), {
              GIT_CONFIG_COUNT: '2',
              GIT_CONFIG_KEY_0: `http.${cloneUrl.origin}/.extraHeader`,
              GIT_CONFIG_VALUE_0: `Authorization: Basic ${rememberSecret(Buffer.from(`${provider === 'github' ? 'x-access-token' : 'oauth2'}:${token}`).toString('base64'))}`,
              GIT_CONFIG_KEY_1: 'credential.helper',
              GIT_CONFIG_VALUE_1: '',
            }),
          });
      } catch (error) {
        print({ provider, deferred: true, reason: redact(String(error)) });
      }
    }
  });
registerOperations(program);
registerPlanningCommands(program);
registerEnvironmentCommands(program);
registerDaddyCommands(program);
registerInstructionCommands(program);
registerModuleCommands(program);
registerBackupCommands(program);
let cachedCliLocale: Locale | undefined;
const cliText = (value: string) => {
  if (!cachedCliLocale) {
    const config = loadConfig();
    cachedCliLocale = config.locale;
    const file = join(program.opts().dataDir ?? defaultDataDir(config), 'daddyloop.sqlite');
    if (existsSync(file)) {
      let db: DatabaseSync | undefined;
      try {
        db = new DatabaseSync(file, { readOnly: true });
        const row = db.prepare("SELECT value FROM settings WHERE key='preferences'").get();
        if (row)
          cachedCliLocale = normalizeLocale(JSON.parse(String(row.value)).locale, config.locale);
      } catch {
        /* Help remains available without a working service database. */
      } finally {
        db?.close();
      }
    }
  }
  return translator(
    normalizeLocale(program.opts().language ?? process.env.DADDYLOOP_LANG ?? cachedCliLocale),
  )(value);
};
const localizedHelp = {
  optionDescription: (option: Option) => cliText(option.description),
  commandDescription: (command: Command) => cliText(command.description()),
  subcommandDescription: (command: Command) => cliText(command.summary() || command.description()),
  formatHelp(command: Command, helper: Help) {
    return Help.prototype.formatHelp
      .call(helper, command, helper)
      .replace(/^(Usage|Options|Commands|Arguments):/gm, (label) => cliText(label));
  },
};
const configureHelp = (command: Command) => {
  command.configureHelp(localizedHelp);
  for (const child of command.commands) configureHelp(child);
};
configureHelp(program);
const interactive = (options: { id?: string } = {}) =>
  consoleUI(
    <T>(path: string, body?: unknown, signal?: AbortSignal) =>
      callApi<T>(path, body, { dataDir: dataDir(), url: program.opts().url, signal }),
    {
      ...options,
      plain: program.opts().plain,
      theme: program.opts().theme,
      locale:
        program.opts().language ??
        (process.env.DADDYLOOP_LANG ? normalizeLocale(process.env.DADDYLOOP_LANG) : undefined),
    },
  );
program
  .command('console')
  .argument('[session]', 'session ID or unique prefix')
  .description('Open the interactive terminal workspace')
  .action(async (id) => interactive({ id }));
program.action(async () => interactive());
const main = program.parseAsync();
main.catch((error) => {
  process.stderr.write(redact(String(error)) + '\n');
  process.exitCode = 1;
});
