import { spawn } from 'node:child_process';
import { AppError } from '../core/types.js';
import { redact } from '../core/security.js';

export async function git(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = {},
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(
      'git',
      ['-c', 'core.hooksPath=/dev/null', '-c', 'http.followRedirects=false', ...args],
      {
        cwd,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env },
        signal,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let output = '',
      error = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), 120000);
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
      if (output.length > 8_000_000) child.kill('SIGTERM');
    });
    child.stderr.on('data', (chunk) => {
      if (error.length < 16000) error += chunk.toString();
    });
    child.once('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      code === 0
        ? resolveResult(output.trim())
        : reject(new AppError('git_failed', redact(error || `git exited ${code}`), 422));
    });
  });
}
