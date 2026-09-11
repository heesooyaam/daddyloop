import { moduleCatalogue } from '../modules/catalogue.js';
import { moduleExecutable } from '../runtime/executable.js';
import { checkedModules } from '../modules/catalogue.js';
import type { Command } from 'commander';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { spawn } from 'node:child_process';
import { ServiceManager } from './service.js';
import {
  configPath,
  defaultDataDir,
  loadConfig,
  privateWrite,
  saveConfig,
  validateServerUrl,
} from './config.js';
import { api as client } from './client.js';
import { command } from './process.js';
import { TelegramApi } from '../integrations/telegram.js';
import { setupTailscale } from './network.js';
import { ArcBridge, leaseHelper } from '../integrations/arcadia.js';

export async function promptSecret(label: string): Promise<string> {
  if (!process.stdin.isTTY) throw new Error('Use --token-file for non-interactive setup');
  process.stdout.write(label);
  const wasRaw = process.stdin.isRaw;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolveValue, reject) => {
    let value = '';
    const finish = (error?: Error) => {
      process.stdin.off('data', listener);
      process.stdin.setRawMode(!!wasRaw);
      process.stdin.pause();
      process.stdout.write('\n');
      error ? reject(error) : resolveValue(value);
    };
    const listener = (chunk: Buffer) => {
      for (const char of chunk.toString()) {
        if (char === '\u0003') {
          finish(new Error('Cancelled'));
          return;
        }
        if (char === '\n' || char === '\r') {
          finish();
          return;
        }
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else if (char >= ' ') value += char;
      }
    };
    process.stdin.on('data', listener);
  });
}
export async function interactiveCommand(executable: string, args: string[]) {
  await new Promise<void>((resolveValue, reject) => {
    const child = spawn(executable, args, { stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? resolveValue() : reject(new Error(`${executable} exited ${code}`)),
    );
  });
}
export function registerOperations(program: Command) {
  const dir = () => resolve(program.opts().dataDir ?? defaultDataDir());
  const output = (value: unknown): void => {
    process.stdout.write(
      typeof value === 'string' ? value + '\n' : JSON.stringify(value, null, 2) + '\n',
    );
  };
  const api = <T>(path: string, body?: unknown) =>
    client<T>(path, body, { dataDir: dir(), url: program.opts().url });
  program
    .command('init')
    .description('Set up this host and its background service')
    .option('-y, --yes', 'use defaults without interactive questions')
    .option('--no-service', 'configure only; do not install a service')
    .option('--modules <ids>', 'enable the selected installation modules')
    .action(async (options) => {
      const config = loadConfig();
      if (options.modules !== undefined)
        config.modules = checkedModules(options.modules.split(','));
      config.dataDir = dir();
      mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
      if (!options.yes && process.stdin.isTTY) {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        try {
          output('daddyloop setup · daddy and the workers run on this machine.');
          const port = await rl.question(`Local port [${config.port}]: `);
          if (port.trim()) config.port = Number(port);
          const memory = await rl.question(
            `Maximum memory for the service and its children [${config.memoryMax}]: `,
          );
          if (memory.trim()) config.memoryMax = memory.trim();
          const cache = await rl.question(
            'Automatically remove only safe daddyloop cache artifacts under disk pressure? [y/N]: ',
          );
          config.cache.auto = /^y(es)?$/i.test(cache.trim());
        } finally {
          rl.close();
        }
      }
      config.serverUrl = `http://127.0.0.1:${config.port}`;
      saveConfig(config);
      const gh = config.modules.includes('github')
        ? await command('gh', ['auth', 'token', '--hostname', 'github.com'], {
            allowFailure: true,
          }).catch(() => undefined)
        : undefined;
      const tokenPath = join(homedir(), '.tokens/github');
      if (gh?.code === 0 && gh.stdout.trim() && !existsSync(tokenPath))
        privateWrite(tokenPath, gh.stdout.trim() + '\n');
      if (options.service) {
        const manager = new ServiceManager();
        await manager.install(config, config.dataDir);
        await manager.start();
        output(
          'Background service installed with logout persistence. No terminal or tmux session is required.',
        );
      }
      output(
        `Configuration: ${configPath()}\nWeb panel: ${config.publicOrigin ?? config.serverUrl}\nUse daddy auth agent codex / daddy auth github / daddy auth gitlab to connect accounts.\nUse daddy web and daddy phone to connect your browser and phone.\nUse daddy telegram setup to connect your bot.`,
      );
    });
  program
    .command('up')
    .description('Install/start the persistent background service')
    .action(async () => {
      const config = loadConfig();
      config.dataDir = dir();
      saveConfig(config);
      const manager = new ServiceManager();
      await manager.install(config, dir());
      await manager.start();
      output(await manager.status());
    });
  program
    .command('down')
    .description('Stop the service, preserving state and unfinished work')
    .action(async () => {
      await new ServiceManager().stop();
      output('Service stopped. State and working copies were preserved.');
    });
  program
    .command('restart')
    .description('Restart the background service')
    .action(async () => {
      await new ServiceManager().restart();
      output('Service restarted.');
    });
  const service = program.command('service').description('Manage the operating-system service');
  service.command('status').action(async () => output(await new ServiceManager().status()));
  service
    .command('logs')
    .option('-f, --follow')
    .action(async (options) => {
      const manager = new ServiceManager();
      await interactiveCommand(manager.mode === 'system' ? 'sudo' : 'journalctl', [
        ...(manager.mode === 'system' ? ['-n', 'journalctl'] : ['--user']),
        '-u',
        manager.unitName(),
        '-n',
        '80',
        ...(options.follow ? ['-f'] : []),
      ]);
    });
  service
    .command('uninstall')
    .description('Remove the service; keep data and credentials')
    .action(async () => {
      await new ServiceManager().uninstall();
      output('Service removed. Data and credentials were preserved.');
    });
  program
    .command('connect')
    .argument('<url>')
    .option('--token-file <path>')
    .description('Connect this CLI to a daddyloop server')
    .action(async (url, options) => {
      const origin = validateServerUrl(url),
        token = options.tokenFile
          ? readFileSync(options.tokenFile, 'utf8').trim()
          : await promptSecret('Server access token (hidden): ');
      await client('/status', undefined, { url: origin, token });
      const path = join(dirname(configPath()), 'client-token');
      privateWrite(path, token + '\n');
      const config = loadConfig();
      config.serverUrl = origin;
      config.clientTokenFile = path;
      saveConfig(config);
      output(`Connected to ${origin}`);
    });
  const requireModule = (id: string) => {
    if (!loadConfig().modules.includes(id))
      throw new Error(`Enable the ${id} module in the installer first`);
  };
  const auth = program.command('auth').description('Connect agent and review-provider accounts');
  auth
    .command('agent')
    .argument('<module>', 'agent module ID')
    .option('--browser', 'use browser login if the module supports it')
    .action(async (id, options) => {
      requireModule(id);
      const module = moduleCatalogue.find((module) => module.id === id && module.kind === 'agent');
      if (!module || !('login' in module))
        throw new Error('This module does not provide a CLI login flow');
      await interactiveCommand(moduleExecutable(id, loadConfig()), [
        ...(options.browser ? module.browserLogin : module.login),
      ]);
    });
  auth.command('github').action(async () => {
    requireModule('github');
    await interactiveCommand('gh', [
      'auth',
      'login',
      '--hostname',
      'github.com',
      '--git-protocol',
      'ssh',
      '--web',
    ]);
    const r = await command('gh', ['auth', 'token', '--hostname', 'github.com']);
    privateWrite(join(homedir(), '.tokens/github'), r.stdout.trim() + '\n');
    output('GitHub connected. The service reads this credential without a restart.');
  });
  auth
    .command('gitlab')
    .option('--token-file <path>')
    .option('--host <host>', 'GitLab hostname', 'gitlab.com')
    .action(async (options) => {
      requireModule('gitlab');
      if (!/^[a-z0-9.-]+$/i.test(options.host)) throw new Error('Invalid hostname');
      const token = options.tokenFile
        ? readFileSync(options.tokenFile, 'utf8').trim()
        : await promptSecret('GitLab personal API token (hidden): ');
      const response = await fetch(`https://${options.host}/api/v4/user`, {
        headers: { 'PRIVATE-TOKEN': token },
        signal: AbortSignal.timeout(15000),
        redirect: 'error',
      });
      if (!response.ok) throw new Error(`GitLab authentication failed: HTTP ${response.status}`);
      privateWrite(
        join(
          homedir(),
          '.tokens',
          options.host === 'gitlab.com' ? 'gitlab' : `gitlab-${options.host}`,
        ),
        token + '\n',
      );
      output('GitLab connected.');
    });
  program
    .command('phone')
    .description('Create a short-lived one-use phone login link')
    .action(async () => {
      const result = await api<{ url: string; expiresAt: string }>('/pairings', {
        name: 'Phone',
        kind: 'web',
      });
      output(
        `Open this link on the phone (one use, expires ${result.expiresAt}):\n${result.url}\nThe phone must be able to reach the service network directly; your laptop is not a relay.`,
      );
    });
  const web = program.command('web').description('Configure persistent browser/phone access');
  web.command('status', { isDefault: true }).action(async () => {
    const config = loadConfig();
    output(
      config.publicOrigin
        ? `Permanent address: ${config.publicOrigin}\nThe service runs on the host independently of SSH.`
        : 'Local access only. Configure a permanent HTTPS address with daddy web origin <https-url>, or daddy web tailscale. An SSH tunnel stops when the laptop disconnects.',
    );
  });
  web
    .command('origin')
    .argument('<url>')
    .action(async (url) => {
      const config = loadConfig();
      config.publicOrigin = validateServerUrl(url, true);
      saveConfig(config);
      output(
        `Public origin set to ${config.publicOrigin}. Restart the service after configuring your HTTPS reverse proxy to forward to http://127.0.0.1:${config.port}.`,
      );
    });
  web
    .command('tailscale')
    .description('Install a persistent private HTTPS endpoint on this host')
    .action(async () => output(await setupTailscale(dir())));
  const telegram = program.command('telegram').description('Connect a private Telegram bot chat');
  telegram
    .command('setup')
    .option('--token-file <path>')
    .action(async (options) => {
      const path = options.tokenFile
        ? resolve(options.tokenFile)
        : join(homedir(), '.tokens/daddyloop-telegram');
      let token: string;
      if (existsSync(path)) token = readFileSync(path, 'utf8').trim();
      else {
        output('Create a dedicated bot with @BotFather, then paste its token below.');
        token = await promptSecret('Telegram bot token (hidden): ');
      }
      const bot = new TelegramApi(token),
        me = await bot.call<{ username: string }>('getMe'),
        webhook = await bot.call<{ url: string }>('getWebhookInfo');
      if (webhook.url)
        throw new Error('This bot is already connected through a webhook. Use a dedicated bot.');
      if (!existsSync(path)) privateWrite(path, token + '\n');
      const config = loadConfig();
      config.telegram = { enabled: true, tokenFile: path };
      saveConfig(config);
      output(`Bot @${me.username} configured. Restarting the service to activate it.`);
      await new ServiceManager().restart();
      for (let i = 0; i < 40; i++) {
        try {
          const result = await api<{ url: string }>('/telegram/pair', {});
          output(`Open this private-chat pairing link in Telegram:\n${result.url}`);
          return;
        } catch (error) {
          if (i === 39) throw error;
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }
    });
  telegram.command('pair').action(async () => {
    const result = await api<{ url: string }>('/telegram/pair', {});
    output(result.url);
  });
  telegram
    .command('unpair')
    .description('Revoke the current chat and outstanding confirmations')
    .action(async () => output(await api('/telegram/unpair', {})));
  telegram.command('status').action(async () => {
    const result = await api<{ telegram: unknown }>('/status');
    output(result.telegram);
  });
  program
    .command('devices')
    .description('List paired browser sessions')
    .action(async () => output(await api('/devices')));
  program
    .command('revoke-device')
    .argument('<id>')
    .action(async (id) => output(await api(`/devices/${encodeURIComponent(id)}/revoke`, {})));
  const cache = program
    .command('cache')
    .description('Inspect and prune only verified daddyloop-owned caches');
  cache.command('status', { isDefault: true }).action(async () => output(await api('/cache')));
  cache
    .command('prune')
    .option('--apply', 'remove eligible artifacts; without this flag only show the plan', false)
    .action(async (options) => output(await api('/cache/prune', { apply: options.apply })));
  cache
    .command('auto')
    .argument('<mode>', 'on or off')
    .action(async (mode) => {
      if (!['on', 'off'].includes(mode)) throw new Error('Choose on or off');
      const config = loadConfig();
      config.cache.auto = mode === 'on';
      saveConfig(config);
      output('Cache policy saved. Restart the service to apply it.');
    });
  cache
    .command('arcadia-gc')
    .description('Run native Arc garbage collection; never truncates shared storage')
    .option('--apply', 'perform ordinary arc gc; otherwise use its dry-run', false)
    .action(async (options) => {
      requireModule('arcadia');
      const bridge = new ArcBridge();
      const result = await bridge.withMount(async (mount) =>
        bridge.native(['gc', ...(options.apply ? [] : ['--dry-run'])], mount),
      );
      output(result);
    });
  const arcadia = program
    .command('arcadia')
    .description('Configure the optional Arc/Arcanum integration');
  arcadia
    .command('setup')
    .option('--workspace <path>', 'existing source Arc mount')
    .option('--lease-helper <path>')
    .action(async (options) => {
      const config = loadConfig();
      requireModule('arcadia');
      if (options.leaseHelper) config.arcadia.leaseHelper = resolve(options.leaseHelper);
      saveConfig(config);
      const identity = await new ArcBridge().doctor(options.workspace);
      config.arcadia.enabled = true;
      config.arcadia.leaseHelper = leaseHelper();
      saveConfig(config);
      output({
        connected: true,
        user: identity.user_login,
        revision: identity.hash,
        sourcePreserved: true,
        note: 'Author and reviewer require separate free, clean, leased Arc mounts.',
      });
    });
  arcadia.command('mounts').action(async () => {
    requireModule('arcadia');
    output(await new ArcBridge().mounts());
  });
  arcadia
    .command('release')
    .argument('<task>')
    .option('--role <role>', 'author or reviewer', 'reviewer')
    .action(async (id, options) =>
      output(await api(`/tasks/${encodeURIComponent(id)}/arcadia/release`, { role: options.role })),
    );
}
