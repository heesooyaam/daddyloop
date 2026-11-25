import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join } from 'node:path';
import { loadConfig } from '../ops/config.js';
import { command } from '../ops/process.js';
import { AppError } from '../core/types.js';

function isFile(path: string) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function under(directory: string, path: string) {
  // Keep ".." for the filesystem to resolve after following any symlinks.
  return isAbsolute(path) ? path : `${directory}/${path}`;
}

export function resolveLeaseHelperPath(
  helper: string,
  { cwd: workingDirectory, env }: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
) {
  const cwd = workingDirectory ? under(process.cwd(), workingDirectory) : process.cwd();
  const local = under(cwd, helper);
  // Bash also checks the current directory before searching PATH for a bare script name.
  const path =
    helper.includes('/') || isFile(local)
      ? local
      : (env?.PATH ?? process.env.PATH ?? '')
          .split(delimiter)
          .map((directory) => under(under(cwd, directory || '.'), helper))
          .find(isFile);
  // Resolve the parent before the interpreter normalizes the path. Keep the launch name.
  return path?.split('/').includes('..')
    ? join(realpathSync.native(dirname(path)), basename(path))
    : path;
}

export function runLeaseHelper(
  helper: string,
  args: string[],
  options: Parameters<typeof command>[2] = {},
  run = command,
) {
  const path = resolveLeaseHelperPath(helper, options);
  if (!path) return run('bash', [helper, ...args], options);
  try {
    accessSync(path, constants.X_OK);
  } catch {
    return run('bash', [path, ...args], options);
  }
  return run(path, args, options);
}

export function leaseHelper() {
  const configured = loadConfig().arcadia.leaseHelper ?? process.env.DADDYLOOP_ARCADIA_LEASE_HELPER;
  if (configured) return configured;
  const candidates = (process.env.PATH ?? '')
    .split(':')
    .map((path) => under(path || '.', 'arcadia-mount-lease'));
  for (const base of ['.agents', '.codex', '.claude', '.cursor'])
    candidates.push(join(homedir(), base, 'skills/arcadia-mounts/scripts/arcadia-mount-lease'));
  const path = candidates.find(isFile);
  if (!path)
    throw new AppError(
      'arcadia_lease_helper_missing',
      'Install the company arcadia-mounts skill or configure its helper with daddy arcadia setup --lease-helper <path>',
      422,
    );
  return path;
}
