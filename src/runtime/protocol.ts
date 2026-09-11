import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import { AppError } from '../core/types.js';
import { redact } from '../core/security.js';
import { VERSION } from '../version.js';

export interface RpcMessage {
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
}
export class CodexConnection extends EventEmitter {
  private process?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<
    number,
    {
      resolve: (x: unknown) => void;
      reject: (e: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private stopped = false;
  constructor(
    private executable = 'codex',
    private args = ['app-server', '--listen', 'stdio://'],
  ) {
    super();
  }
  async start(cwd: string) {
    // Provider credentials stay in the broker process, never in the agent's environment.
    const env = { ...process.env };
    for (const name of Object.keys(env))
      if (
        /^(GITHUB_TOKEN|GITLAB_TOKEN|GH_TOKEN|GLAB_TOKEN|ARC_TOKEN|ARC_OAUTH_TOKEN|TRACKER_TOKEN|TRACKER_OAUTH_TOKEN|TELEGRAM_BOT_TOKEN|DADDYLOOP_.*TOKEN.*|GIT_CONFIG_.*)$/.test(
          name,
        )
      )
        delete env[name];
    this.process = spawn(this.executable, this.args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    const lines = createInterface({
      input: this.process.stdout,
      crlfDelay: Infinity,
    });
    lines.on('line', (line) => {
      if (line.length > 8_000_000) {
        this.fail(new AppError('rpc_too_large', 'Codex emitted an oversized protocol message'));
        return;
      }
      let msg: RpcMessage;
      try {
        msg = JSON.parse(line);
      } catch {
        this.emit('diagnostic', 'Ignored non-JSON stdout from Codex');
        return;
      }
      if (msg.id !== undefined && !msg.method) {
        const pending = this.pending.get(Number(msg.id));
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(Number(msg.id));
        if (msg.error) pending.reject(new AppError('codex_rpc', msg.error.message, 502));
        else pending.resolve(msg.result);
      } else this.emit('message', msg);
    });
    this.process.stderr.on('data', (chunk) =>
      this.emit('diagnostic', redact(chunk.toString()).slice(0, 8000)),
    );
    this.process.stdin.on('error', (error) => this.fail(error));
    this.process.once('error', (error) => this.fail(error));
    this.process.once('exit', (code, signal) => {
      lines.close();
      this.fail(new AppError('codex_exited', `Codex exited (${code ?? signal})`, 502));
    });
    const initialized = await this.request<{ userAgent?: string }>('initialize', {
      clientInfo: { name: 'daddyloop', title: 'daddyloop', version: VERSION },
      capabilities: { experimentalApi: true },
    });
    this.send({ method: 'initialized', params: {} });
    return initialized;
  }
  request<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 60000,
  ): Promise<T> {
    if (this.stopped)
      return Promise.reject(new AppError('codex_stopped', 'Codex connection is closed'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AppError('codex_timeout', `Codex request timed out: ${method}`, 504));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      try {
        this.send({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  send(message: RpcMessage) {
    if (!this.process?.stdin.writable)
      throw new AppError('codex_disconnected', 'Codex stdin is closed');
    this.process.stdin.write(JSON.stringify(message) + '\n');
  }
  respond(id: string | number, result: unknown) {
    this.send({ id, result });
  }
  private fail(error: Error) {
    if (this.stopped) return;
    this.stopped = true;
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this.pending.clear();
    this.emit('closed', error);
  }
  close() {
    const child = this.process;
    if (!child) return;
    this.fail(new AppError('codex_stopped', 'Codex connection was stopped'));
    this.removeAllListeners('message');
    this.removeAllListeners('diagnostic');
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (child.pid && process.platform !== 'win32') process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        /* Already exited. */
      }
    };
    kill('SIGTERM');
    const timer = setTimeout(() => kill('SIGKILL'), 3000);
    timer.unref();
    child.once('exit', () => clearTimeout(timer));
  }
}
