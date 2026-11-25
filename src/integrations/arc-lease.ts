import { accessSync, constants, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { loadConfig } from '../ops/config.js';
import { command } from '../ops/process.js';
import { AppError } from '../core/types.js';

export function runLeaseHelper(
  helper: string,
  args: string[],
  options: Parameters<typeof command>[2] = {},
  run = command,
) {
  const cwd = options.cwd ?? process.cwd();
  const local = resolve(cwd, helper);
  // Bash also checks the current directory before searching PATH for a bare script name.
  const path =
    helper.includes('/') || existsSync(local)
      ? local
      : ((options.env?.PATH ?? process.env.PATH ?? '')
          .split(delimiter)
          .map((directory) => resolve(cwd, directory, helper))
          .find(existsSync) ?? local);
  try {
    accessSync(path, constants.X_OK);
  } catch {
    return run('bash', [helper, ...args], options);
  }
  return run(path, args, options);
}

export function leaseHelper() {
  const configured = loadConfig().arcadia.leaseHelper ?? process.env.DADDYLOOP_ARCADIA_LEASE_HELPER;
  if (configured) return configured;
  const candidates = (process.env.PATH ?? '')
    .split(':')
    .map((path) => join(path, 'arcadia-mount-lease'));
  for (const base of ['.agents', '.codex', '.claude', '.cursor'])
    candidates.push(join(homedir(), base, 'skills/arcadia-mounts/scripts/arcadia-mount-lease'));
  const path = candidates.find(existsSync);
  if (!path)
    throw new AppError(
      'arcadia_lease_helper_missing',
      'Install the company arcadia-mounts skill or configure its helper with daddy arcadia setup --lease-helper <path>',
      422,
    );
  return path;
}
