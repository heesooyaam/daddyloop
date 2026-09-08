import { spawn } from 'node:child_process';
import { AppError } from '../core/types.js';
import { redact } from '../core/security.js';

export interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}
export function command(
  executable: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    input?: string;
    timeoutMs?: number;
    maxBytes?: number;
    allowFailure?: boolean;
    signal?: AbortSignal;
  } = {},
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      signal: options.signal,
    });
    let stdout = '',
      stderr = '',
      exceeded = false;
    let killTimer: NodeJS.Timeout | undefined;
    const terminate = () => {
      child.kill('SIGTERM');
      killTimer ??= setTimeout(() => child.kill('SIGKILL'), 3000);
      killTimer.unref();
    };
    const timer = setTimeout(() => {
      exceeded = true;
      terminate();
    }, options.timeoutMs ?? 30000);
    const collect = (kind: 'stdout' | 'stderr', chunk: Buffer) => {
      if (stdout.length + stderr.length + chunk.length > (options.maxBytes ?? 8_000_000)) {
        exceeded = true;
        terminate();
        return;
      }
      if (kind === 'stdout') stdout += chunk.toString();
      else stderr += chunk.toString();
    };
    child.stdout.on('data', (chunk) => collect('stdout', chunk));
    child.stderr.on('data', (chunk) => collect('stderr', chunk));
    child.stdin.on('error', () => {});
    child.stdin.end(options.input);
    child.once('error', (error) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      if (exceeded)
        return reject(
          new AppError('command_limit', `${executable} exceeded its time/output limit`),
        );
      if (code !== 0 && !options.allowFailure)
        return reject(
          new AppError(
            'command_failed',
            redact(stderr || stdout || `${executable} exited ${code}`),
            422,
          ),
        );
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}
