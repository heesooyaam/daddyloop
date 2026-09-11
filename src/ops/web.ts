import { hostname, userInfo } from 'node:os';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import type { Config } from './config.js';
import { translator, type Locale } from '../i18n/index.js';

export function webPort(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('Choose a port from 1 to 65535');
  return port;
}
export function tunnelArgs(
  destination: string,
  localPort: number,
  remotePort: number,
  sshPort = 22,
) {
  if (!/^[A-Za-z0-9_\[][A-Za-z0-9_.@:\[\]-]*$/.test(destination) || destination.length > 300)
    throw new Error('Enter an SSH host alias or user@host');
  [localPort, remotePort, sshPort].forEach((port) => webPort(port, 4317));
  return [
    '-N',
    '-o',
    'ExitOnForwardFailure=yes',
    '-o',
    'ServerAliveInterval=30',
    '-o',
    'ServerAliveCountMax=3',
    '-L',
    `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`,
    ...(sshPort === 22 ? [] : ['-p', String(sshPort)]),
    destination,
  ];
}
const quote = (text: string) =>
  /^[a-zA-Z0-9_@%+=:,./-]+$/.test(text) ? text : "'" + text.replace(/'/g, "'\\''") + "'";
export function webConnectionText(
  config: Config,
  options: { host?: string; port?: string; sshPort?: string } = {},
  machine = { user: userInfo().username, host: hostname(), connection: process.env.SSH_CONNECTION },
) {
  const t = translator(config.locale),
    destination = options.host ?? machine.user + '@' + machine.host;
  const localPort = webPort(options.port, config.port);
  const detected = machine.connection?.trim().split(/\s+/)[3];
  const sshPort = webPort(
    options.sshPort ?? (detected && /^\d+$/.test(detected) ? detected : undefined),
    22,
  );
  const command = ['ssh', ...tunnelArgs(destination, localPort, config.port, sshPort)]
    .map(quote)
    .join(' ');
  return [
    ...(config.publicOrigin
      ? [t('Permanent website: {url}', { url: config.publicOrigin }), '']
      : []),
    t('Run this on your laptop, in a new local terminal:'),
    command,
    '',
    t('Then open {url}', { url: `http://127.0.0.1:${localPort}` }),
    t(
      'Keep the tunnel terminal open. Closing it disconnects this browser; daddy and workers keep running on the server.',
    ),
    '',
    t('If daddy is installed on the laptop, use this single command instead:'),
    [
      'daddy',
      'web',
      '--ssh',
      destination,
      '--port',
      String(localPort),
      '--remote-port',
      String(config.port),
      ...(sshPort === 22 ? [] : ['--ssh-port', String(sshPort)]),
    ]
      .map(quote)
      .join(' '),
    '',
    t('For browser login, get the access token on this server with daddy token.'),
    t('If you use an SSH alias or another address, run daddy web --host <your-address>.'),
  ].join('\n');
}
export async function openWebTunnel(
  destination: string,
  options: { port?: string; remotePort?: string; sshPort?: string; open?: boolean },
  locale: Locale,
) {
  const t = translator(locale),
    localPort = webPort(options.port, 4317),
    remotePort = webPort(options.remotePort, 4317),
    sshPort = webPort(options.sshPort, 22);
  const args = tunnelArgs(destination, localPort, remotePort, sshPort);
  await new Promise<void>((resolve, reject) => {
    const probe = createServer();
    probe.once('error', () =>
      reject(
        new Error(t('Local port {port} is busy. Choose another with --port.', { port: localPort })),
      ),
    );
    probe.listen(localPort, '127.0.0.1', () => probe.close(() => resolve()));
  });
  const child = spawn('ssh', args, { stdio: 'inherit' }),
    controller = new AbortController();
  let stopped = false,
    done = false,
    failure: Error | undefined;
  const stop = () => {
    stopped = true;
    child.kill('SIGTERM');
    controller.abort();
  };
  const finished = new Promise<void>((resolve) => {
    child.once('error', (error) => {
      failure = error;
      done = true;
      controller.abort();
      resolve();
    });
    child.once('exit', (code, signal) => {
      if (!stopped && code !== 0) failure = new Error(`SSH exited (${signal ?? code})`);
      done = true;
      controller.abort();
      resolve();
    });
  });
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  const url = `http://127.0.0.1:${localPort}`;
  try {
    process.stdout.write(t('Connecting to {host} over SSH…', { host: destination }) + '\n');
    let ready = false;
    for (let attempt = 0; attempt < 120 && !done && !stopped; attempt++) {
      try {
        const response = await fetch(url + '/api/health', {
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(500)]),
        });
        const health = (await response.json()) as { ok?: boolean; version?: string };
        if (response.ok && health.ok && health.version && !done) {
          ready = true;
          break;
        }
      } catch {
        /* SSH authentication may still be waiting for the user. */
      }
      await delay(500, undefined, { signal: controller.signal }).catch(() => {});
    }
    if (!ready && !stopped)
      throw (
        failure ??
        new Error(
          t('The website did not respond through SSH. Check that daddy is running on the server.'),
        )
      );
    if (ready) {
      process.stdout.write(
        t('Website ready: {url}', { url }) +
          '\n' +
          t('Keep this terminal open. Press Ctrl+C to close only the tunnel.') +
          '\n',
      );
      if (
        options.open !== false &&
        (process.platform === 'darwin' || process.env.DISPLAY || process.env.WAYLAND_DISPLAY)
      ) {
        const browser = spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], {
          detached: true,
          stdio: 'ignore',
        });
        browser.on('error', () => {});
        browser.unref();
      }
      await finished;
      if (failure) throw failure;
    }
  } finally {
    if (!done) {
      child.kill('SIGTERM');
      await finished;
    }
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}
