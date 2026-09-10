import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync, statSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { command } from './process.js';
import { configPath, loadConfig, type Config } from './config.js';
import { VERSION } from '../version.js';

const name = 'reviewloop.service';
export function cliEntry() {
  return fileURLToPath(new URL('../cli.js', import.meta.url));
}
export function systemdQuote(value: string) {
  if (/[\r\n\0]/.test(value)) throw new Error('Newlines and NUL are not allowed in service paths');
  return JSON.stringify(value.replaceAll('%', '%%'));
}
export function serviceUnit(options: {
  executable: string;
  entry: string;
  dataDir: string;
  configFile: string;
  path: string;
  memoryMax: string;
  port: number;
  user?: { uid: number; gid: number };
  demo?: boolean;
}) {
  const q = systemdQuote;
  for (const path of [options.executable, options.entry, options.dataDir, options.configFile]) {
    q(path);
    if (!isAbsolute(path)) throw new Error('Service paths must be absolute');
  }
  if (!/^\d+(?:[KMGT])?$/.test(options.memoryMax)) throw new Error('Invalid memory limit');
  return `[Unit]\nDescription=Daddyloop orchestration service\n# Legacy ownership: Description=Reviewloop author and reviewer service\nAfter=network-online.target\nWants=network-online.target\nStartLimitIntervalSec=120\nStartLimitBurst=5\n\n[Service]\nType=simple\n${options.user ? `User=${options.user.uid}\nGroup=${options.user.gid}\n` : ''}WorkingDirectory=${options.dataDir.replaceAll('%', '%%')}\nExecStart=:${q(options.executable)} ${q(options.entry)} --data-dir ${q(options.dataDir)} serve --port ${options.port}${options.demo ? ' --demo' : ''}\nEnvironment=${q('PATH=' + options.path)}\nEnvironment=${q('REVIEWLOOP_CONFIG=' + options.configFile)}\nEnvironment=NODE_ENV=production\nEnvironment=NODE_USE_SYSTEM_CA=1\nUMask=0077\nRestart=on-failure\nRestartSec=5\nTimeoutStopSec=90\nKillMode=control-group\nMemoryAccounting=yes\nMemoryHigh=${options.memoryMax}\nMemoryMax=${options.memoryMax}\nTasksMax=512\n\n[Install]\nWantedBy=${options.user ? 'multi-user' : 'default'}.target\n`;
}
export class ServiceManager {
  readonly runtimeDir = `/run/user/${userInfo().uid}`;
  readonly mode =
    loadConfig().serviceMode === 'auto'
      ? existsSync('/sys/fs/cgroup/cgroup.controllers')
        ? 'user'
        : 'system'
      : loadConfig().serviceMode;
  unitName(unit = name) {
    return this.mode === 'system' ? unit.replace('.service', `-${userInfo().uid}.service`) : unit;
  }
  unitFile(unit = name) {
    return this.mode === 'system'
      ? join('/etc/systemd/system', this.unitName(unit))
      : join(homedir(), '.config/systemd/user', unit);
  }
  get unitPath() {
    return this.unitFile();
  }
  private env() {
    return {
      XDG_RUNTIME_DIR: this.runtimeDir,
      DBUS_SESSION_BUS_ADDRESS: `unix:path=${this.runtimeDir}/bus`,
    };
  }
  async ctl(args: string[], allowFailure = false) {
    const mapped = args.map((arg) =>
      arg.endsWith('.service') && arg.startsWith('reviewloop') ? this.unitName(arg) : arg,
    );
    if (this.mode === 'system') {
      const read = ['show', 'status', 'is-active', 'cat'].includes(args[0]);
      return command(read ? 'systemctl' : 'sudo', read ? mapped : ['-n', 'systemctl', ...mapped], {
        allowFailure,
        timeoutMs: 100000,
      });
    }
    return command('systemctl', ['--user', ...mapped], {
      env: this.env(),
      allowFailure,
      timeoutMs: 100000,
    });
  }
  async ensureManager() {
    if (process.platform !== 'linux')
      throw new Error(
        'Managed server installation currently requires Linux with systemd. The CLI can connect from macOS using reviewctl connect.',
      );
    if (this.mode === 'system') {
      await command('sudo', ['-n', 'true']);
      return;
    }
    let linger = await command(
      'loginctl',
      ['show-user', String(userInfo().uid), '-p', 'Linger', '--value'],
      { allowFailure: true },
    );
    if (linger.stdout.trim() !== 'yes') {
      const enable = await command('loginctl', ['enable-linger', String(userInfo().uid)], {
        allowFailure: true,
        timeoutMs: 10000,
      });
      if (enable.code !== 0)
        await command('sudo', ['-n', 'loginctl', 'enable-linger', String(userInfo().uid)]);
    }
    if (!existsSync(`${this.runtimeDir}/bus`))
      await command('sudo', ['-n', 'systemctl', 'start', `user@${userInfo().uid}.service`]);
    linger = await command('loginctl', [
      'show-user',
      String(userInfo().uid),
      '-p',
      'Linger',
      '--value',
    ]);
    if (linger.stdout.trim() !== 'yes')
      throw new Error(
        'User lingering could not be enabled. Do not rely on this service surviving logout.',
      );
    await this.ctl(['show-environment']);
  }
  async install(config: Config, dataDir: string) {
    await this.ensureManager();
    const entry = cliEntry();
    if (!existsSync(entry))
      throw new Error('Run a production build before installing the service.');
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    if (
      existsSync(this.unitPath) &&
      !readFileSync(this.unitPath, 'utf8').includes(
        'Description=Reviewloop author and reviewer service',
      )
    )
      throw new Error(`An unmanaged ${this.unitPath} already exists; it was preserved.`);
    const bundle = resolve(dirname(process.execPath), '../..');
    const path = [
      dirname(process.execPath),
      join(bundle, 'tools/bin'),
      join(bundle, 'tools/node_modules/.bin'),
      join(homedir(), '.local/bin'),
      '/usr/local/bin',
      '/usr/bin',
      '/bin',
    ].join(':');
    const unit = serviceUnit({
      executable: process.execPath,
      entry,
      dataDir: resolve(dataDir),
      configFile: configPath(),
      memoryMax: config.memoryMax,
      port: config.port,
      path,
      user: this.mode === 'system' ? userInfo() : undefined,
      demo: config.demo,
    });
    if (existsSync(this.unitPath) && readFileSync(this.unitPath, 'utf8') !== unit) {
      const state = await this.status();
      if (Number(state.MainPID) > 0 || state.ActiveState === 'active') await this.stop();
    }
    const lock = join(dataDir, 'server.lock');
    if (existsSync(lock)) {
      const pid = Number(readFileSync(lock, 'utf8'));
      if (Number.isInteger(pid) && pid > 1 && existsSync(`/proc/${pid}/cmdline`)) {
        const state = await this.status();
        if (String(state.MainPID) !== String(pid)) {
          const args = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
          if (
            !args.includes(entry) ||
            !args.includes('serve') ||
            statSync(`/proc/${pid}`).uid !== userInfo().uid
          )
            throw new Error('An unrecognized process owns the state directory; it was preserved');
          process.kill(pid, 'SIGTERM');
          for (let i = 0; i < 200 && existsSync(`/proc/${pid}`); i++)
            await new Promise((resolve) => setTimeout(resolve, 100));
          if (existsSync(`/proc/${pid}`))
            throw new Error('Previous foreground server did not stop cleanly');
        }
      }
    }
    await this.writeUnit(name, unit, 'Description=Reviewloop author and reviewer service');
    await this.ctl(['daemon-reload']);
    await this.ctl(['enable', name]);
    return this.unitPath;
  }
  async writeUnit(unit: string, content: string, marker: string) {
    const target = this.unitFile(unit);
    if (existsSync(target) && !readFileSync(target, 'utf8').includes(marker))
      throw new Error(`Unmanaged service preserved: ${target}`);
    if (this.mode === 'system') {
      const temporary = join(dirname(configPath()), `${this.unitName(unit)}.generated`);
      mkdirSync(dirname(temporary), { recursive: true, mode: 0o700 });
      writeFileSync(temporary, content, { mode: 0o600 });
      await command('sudo', ['-n', 'install', '-m', '644', temporary, target]);
      unlinkSync(temporary);
    } else {
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      writeFileSync(target, content, { mode: 0o600 });
    }
  }
  async start() {
    await this.ctl(['start', name]);
    return this.waitReady();
  }
  async stop() {
    return this.ctl(['stop', name]);
  }
  async restart() {
    await this.ctl(['restart', name]);
    return this.waitReady();
  }
  private async waitReady() {
    const config = loadConfig();
    for (let i = 0; i < 100; i++) {
      const status = await this.status();
      if (status.ActiveState === 'failed')
        throw new Error('Service failed to start. Run reviewctl service logs.');
      if (status.ActiveState === 'active') {
        try {
          const r = await fetch(`http://127.0.0.1:${config.port}/api/health`, {
            signal: AbortSignal.timeout(1000),
          });
          const h = (await r.json()) as { version: string; pid: number };
          if (r.ok && h.version === VERSION && h.pid === Number(status.MainPID)) return status;
        } catch {
          /* Start-up in progress. */
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error('Service did not become healthy. Run reviewctl service logs.');
  }
  async status() {
    const result = await this.ctl(
      ['show', name, '-p', 'ActiveState,SubState,MainPID,MemoryCurrent,MemoryMax,FragmentPath'],
      true,
    );
    const values = Object.fromEntries(
      result.stdout
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const i = line.indexOf('=');
          return [line.slice(0, i), line.slice(i + 1)];
        }),
    );
    const linger =
      this.mode === 'system'
        ? 'yes'
        : (
            await command(
              'loginctl',
              ['show-user', String(userInfo().uid), '-p', 'Linger', '--value'],
              { allowFailure: true },
            )
          ).stdout.trim();
    return {
      installed: existsSync(this.unitPath),
      mode: this.mode,
      survivesLogout: linger === 'yes' && values.ActiveState === 'active',
      ...values,
    } as { installed: boolean; mode: string; survivesLogout: boolean } & Record<
      string,
      string | boolean
    >;
  }
  async uninstall() {
    if (!existsSync(this.unitPath)) return;
    if (
      !readFileSync(this.unitPath, 'utf8').includes(
        'Description=Reviewloop author and reviewer service',
      )
    )
      throw new Error('Refusing to remove an unmanaged service');
    await this.ctl(['disable', '--now', name]);
    if (this.mode === 'system') await command('sudo', ['-n', 'rm', '--', this.unitPath]);
    else unlinkSync(this.unitPath);
    await this.ctl(['daemon-reload']);
  }
}
