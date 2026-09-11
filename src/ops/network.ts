import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync, lstatSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { command } from './process.js';
import { ServiceManager, systemdQuote } from './service.js';
import { loadConfig, saveConfig } from './config.js';

export async function setupTailscale(dataDir: string) {
  if (process.platform !== 'linux')
    throw new Error(
      'Run this command on the Linux service host; install the Tailscale app normally on the phone/laptop.',
    );
  const manager = new ServiceManager();
  await manager.ensureManager();
  const root = join(dataDir, 'network');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const bin = join(root, 'tailscale'),
    daemon = join(root, 'tailscaled'),
    socket = join(root, 'tailscaled.sock');
  if (!existsSync(bin) || !existsSync(daemon)) {
    const version = '1.102.3',
      arch = process.arch === 'x64' ? 'amd64' : process.arch === 'arm64' ? 'arm64' : undefined;
    if (!arch) throw new Error('Unsupported Tailscale architecture');
    const filename = `tailscale_${version}_${arch}.tgz`,
      base = 'https://pkgs.tailscale.com/stable/';
    const [archive, checksum] = await Promise.all([
      fetch(base + filename, { signal: AbortSignal.timeout(120000) }),
      fetch(base + filename + '.sha256', { signal: AbortSignal.timeout(30000) }),
    ]);
    if (!archive.ok || !checksum.ok)
      throw new Error('Could not download the verified Tailscale release');
    const bytes = Buffer.from(await archive.arrayBuffer());
    if (bytes.length > 150 * 1024 * 1024)
      throw new Error('Tailscale archive exceeds the size limit');
    const expected = (await checksum.text()).trim().split(/\s/)[0];
    if (createHash('sha256').update(bytes).digest('hex') !== expected)
      throw new Error('Tailscale checksum mismatch');
    const path = join(root, 'download.tgz');
    writeFileSync(path, bytes, { mode: 0o600 });
    const prefix = filename.slice(0, -4);
    await command('tar', [
      '-xzf',
      path,
      '-C',
      root,
      '--strip-components=1',
      `${prefix}/tailscale`,
      `${prefix}/tailscaled`,
    ]);
    if (!lstatSync(bin).isFile() || !lstatSync(daemon).isFile())
      throw new Error('Unexpected Tailscale binary layout');
    const { unlinkSync } = await import('node:fs');
    unlinkSync(path);
  }
  const q = systemdQuote,
    identity = manager.mode === 'system' ? `User=${userInfo().uid}\nGroup=${userInfo().gid}\n` : '';
  await manager.writeUnit(
    'daddyloop-network.service',
    `[Unit]\nDescription=daddyloop private web network\nAfter=network-online.target\n\n[Service]\nType=simple\n${identity}ExecStart=:${q(daemon)} --tun=userspace-networking --state=${q(join(root, 'state'))} --socket=${q(socket)} --port=0\nRestart=always\nRestartSec=5\nUMask=0077\nMemoryMax=512M\n\n[Install]\nWantedBy=${manager.mode === 'system' ? 'multi-user' : 'default'}.target\n`,
    'Description=daddyloop private web network',
  );
  await manager.ctl(['daemon-reload']);
  await manager.ctl(['enable', '--now', 'daddyloop-network.service']);
  const args = ['--socket', socket];
  let status: { BackendState: string; Self?: { DNSName?: string }; AuthURL?: string } | undefined;
  for (let i = 0; i < 20; i++) {
    try {
      status = JSON.parse((await command(bin, [...args, 'status', '--json'])).stdout);
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  if (!status) throw new Error('Tailscale daemon did not start');
  if (status.BackendState !== 'Running') {
    process.stdout.write(
      'Authorize this service host in your Tailscale account. The network daemon will remain running after SSH disconnects.\n',
    );
    const { interactiveCommand } = await import('./commands.js');
    await interactiveCommand(bin, [
      ...args,
      'up',
      '--accept-dns=false',
      '--accept-routes=false',
      '--hostname=daddyloop',
    ]);
  }
  status = JSON.parse((await command(bin, [...args, 'status', '--json'])).stdout);
  const dns = status?.Self?.DNSName?.replace(/\.$/, '');
  if (!dns || !/^[a-zA-Z0-9.-]+\.ts\.net$/.test(dns))
    throw new Error('Tailscale did not return a usable HTTPS hostname');
  const config = loadConfig();
  await command(bin, [...args, 'serve', '--bg', '--yes', `http://127.0.0.1:${config.port}`], {
    timeoutMs: 60000,
  });
  config.publicOrigin = `https://${dns}`;
  saveConfig(config);
  await manager.restart();
  return {
    url: config.publicOrigin,
    phone:
      'Install Tailscale on the phone and sign in to the same network, then run daddy phone to pair the browser.',
    survivesLogout: true,
  };
}
