import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../ops/config.js';
import { AppError } from '../core/types.js';

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
      'Configure the company arcadia-mount-lease helper with daddy arcadia setup --lease-helper <path>',
      422,
    );
  return path;
}
