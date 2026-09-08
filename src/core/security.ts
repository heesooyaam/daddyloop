import { timingSafeEqual, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { AppError, type ProviderName } from './types.js';

const knownSecrets = new Set<string>();
export function rememberSecret(value: string) {
  if (value.length >= 8) knownSecrets.add(value);
  return value;
}
export function redact(value: unknown): string {
  let result = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of knownSecrets) result = result.split(secret).join('[REDACTED]');
  return result
    .replace(
      /\b(?:gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]+|glpat-[A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]{16,})\b/g,
      '[REDACTED]',
    )
    .replace(
      /(authorization|private-token|access_token|api_key)(["\s:=]+)([^\s",}]+)/gi,
      '$1$2[REDACTED]',
    );
}
export function safeEqual(a: string, b: string) {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export function accessToken(dir: string) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, 'access-token');
  if (!existsSync(path))
    writeFileSync(path, randomBytes(32).toString('hex'), {
      mode: 0o600,
      flag: 'wx',
    });
  chmodSync(path, 0o600);
  return rememberSecret(readFileSync(path, 'utf8').trim());
}
export function credential(provider: ProviderName, host: string): string {
  if (provider === 'demo') return '';
  const key = provider.toUpperCase();
  const customFile = process.env[`REVIEWLOOP_${key}_TOKEN_FILE`];
  const files = customFile
    ? [customFile]
    : [join(homedir(), '.tokens', `${provider}-${host}`), join(homedir(), '.tokens', provider)];
  const env =
    process.env[`${key}_TOKEN`] || process.env[provider === 'github' ? 'GH_TOKEN' : 'GLAB_TOKEN'];
  // Generic environment tokens are scoped to the configured host, never an arbitrary PR URL.
  const allowedHost =
    process.env[`REVIEWLOOP_${key}_HOST`] || (provider === 'github' ? 'github.com' : 'gitlab.com');
  if (host !== allowedHost && !existsSync(files[0]))
    throw new AppError(
      'credentials_missing',
      `Configure a host-specific ${provider} token for ${host}`,
      422,
    );
  if (env && host === allowedHost) return rememberSecret(env.trim());
  for (const file of files)
    if (existsSync(file) && (host === allowedHost || file.endsWith(`${provider}-${host}`)))
      return rememberSecret(readFileSync(file, 'utf8').trim());
  throw new AppError(
    'credentials_missing',
    `No ${provider} credential for ${host}. Set ${key}_TOKEN or ~/.tokens/${provider}.`,
    422,
  );
}
