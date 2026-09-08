#!/usr/bin/env node
import { Command, Option } from 'commander';
import { readFileSync, existsSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { buildApp } from './server/app.js';
import { credential, redact, rememberSecret } from './core/security.js';
import { resources } from './core/resources.js';
import { ProviderHttp } from './providers/http.js';
import { CodexConnection } from './runtime/protocol.js';
import { git } from './runtime/workspaces.js';
import { loadConfig, defaultDataDir } from './ops/config.js';
import { api as callApi } from './ops/client.js';
import { registerOperations } from './ops/commands.js';
import { consoleUI } from './ops/console.js';
import { VERSION } from './version.js';

const program = new Command()
  .name('reviewctl')
  .description('Persistent author/reviewer workflow for GitHub, GitLab and Arcadia')
  .version(VERSION)
  .option('--plain', 'use the basic line-oriented console')
  .addOption(
    new Option('--theme <theme>', 'terminal appearance').choices(['dark', 'light']).default('dark'),
  )
  .option('--data-dir <path>', 'local state directory', defaultDataDir())
  .option(
    '--url <url>',
    'Reviewloop backend URL',
    process.env.REVIEWLOOP_URL ?? loadConfig().serverUrl,
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
  .option('--port <port>', 'loopback port', String(loadConfig().port))
  .option('--demo', 'enable explicitly labeled demo tasks', false)
  .option(
    '--min-disk-gib <size>',
    'stop starting jobs below this disk space',
    String(loadConfig().resources.minDiskGiB),
  )
  .option(
    '--max-disk-percent <percent>',
    'stop starting jobs at this usage',
    String(loadConfig().resources.maxDiskPercent),
  )
  .option(
    '--min-memory-gib <size>',
    'stop starting jobs below available RAM',
    String(loadConfig().resources.minMemoryGiB),
  )
  .action(async (options) => {
    const dir = dataDir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const lock = join(dir, 'server.lock');
    if (existsSync(lock)) {
      const pid = Number(readFileSync(lock, 'utf8'));
      try {
        process.kill(pid, 0);
        throw new Error(`Reviewloop is already running (PID ${pid})`);
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
        `Reviewloop: http://127.0.0.1:${options.port}\nAccess token: ${join(dir, 'access-token')} (reviewctl token)\nMode: ${options.demo ? 'live integrations + demo fixtures' : 'live integrations'}\n`,
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
program.command('list').action(async () => print(await api('/tasks')));
program
  .command('show')
  .argument('<task>')
  .action(async (id) => print(await api(`/tasks/${encodeURIComponent(id)}`)));
program
  .command('attach')
  .argument('<pr-url>')
  .requiredOption('--repo <path>', 'existing local Git repository')
  .requiredOption('--requirements <file>', 'original requirements in Markdown')
  .option('--kind <kind>', 'code or plan', 'code')
  .option('--plan <task-id>', 'approved plan task')
  .option('--author-thread <id>', 'existing Codex author thread to resume')
  .option('--auto-publish', 'allow automatic review publication')
  .option('--no-auto-push', 'leave author commits for a manual push')
  .action(async (url, options) =>
    print(
      await api('/tasks', {
        url,
        repoPath: resolve(options.repo),
        requirements: readFileSync(options.requirements, 'utf8'),
        kind: options.kind,
        planTaskId: options.plan,
        authorThreadId: options.authorThread,
        policy: {
          publication: options.autoPublish ? 'auto' : 'human',
          autoPush: options.autoPush,
        },
      }),
    ),
  );
program
  .command('demo')
  .description('Create a clearly labeled demo task')
  .action(async () => print(await api('/demo', {})));
for (const action of [
  'review',
  'retry',
  'reconcile',
  'publish',
  'pause',
  'resume',
  'approve-plan',
  'waive-checks',
  'reopen',
]) {
  program
    .command(action)
    .argument('<task>')
    .option('--reason <text>', 'record the human decision', '')
    .action(async (id, options) =>
      print(
        await api(`/tasks/${encodeURIComponent(id)}/actions`, {
          action,
          reason: options.reason,
        }),
      ),
    );
}
program
  .command('chat')
  .argument('<task>')
  .requiredOption('--role <role>', 'author or reviewer')
  .argument('<message>')
  .action(async (id, text, options) =>
    print(
      await api(`/tasks/${encodeURIComponent(id)}/messages`, {
        role: options.role,
        text,
      }),
    ),
  );
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
  .argument('[task]')
  .action((id) => {
    const url = program.opts().url + (id ? `/#task/${encodeURIComponent(id)}` : '');
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
      const host = process.env[`REVIEWLOOP_${provider.toUpperCase()}_HOST`] ?? `${provider}.com`;
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
    const rpc = new CodexConnection(process.env.REVIEWLOOP_CODEX_BIN);
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
  .description('Create private GitHub/GitLab project repositories when credentials are available')
  .option('--name <name>', 'repository name', 'reviewloop')
  .option('--push', 'push the local main branch after creating remotes', false)
  .action(async (options) => {
    if (!/^[a-zA-Z0-9._-]+$/.test(options.name)) throw new Error('Invalid repository name');
    for (const provider of ['github', 'gitlab'] as const) {
      const host = process.env[`REVIEWLOOP_${provider.toUpperCase()}_HOST`] ?? `${provider}.com`;
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
const interactive = (options: { id?: string; role?: 'author' | 'reviewer' } = {}) =>
  consoleUI(
    <T>(path: string, body?: unknown, signal?: AbortSignal) =>
      callApi<T>(path, body, { dataDir: dataDir(), url: program.opts().url, signal }),
    { ...options, plain: program.opts().plain, theme: program.opts().theme },
  );
program
  .command('console')
  .argument('[task]', 'task ID or unique prefix')
  .addOption(
    new Option('--role <role>', 'conversation to open')
      .choices(['author', 'reviewer'])
      .default('reviewer'),
  )
  .description('Open the interactive terminal workspace')
  .action(async (id, options) => interactive({ id, role: options.role }));
program.action(async () => interactive());
const main = program.parseAsync();
main.catch((error) => {
  process.stderr.write(redact(String(error)) + '\n');
  process.exitCode = 1;
});
