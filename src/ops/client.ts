import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, defaultDataDir, validateServerUrl } from './config.js';
export async function api<T = unknown>(
  path: string,
  body?: unknown,
  options: {
    dataDir?: string;
    url?: string;
    tokenFile?: string;
    token?: string;
    signal?: AbortSignal;
  } = {},
): Promise<T> {
  const config = loadConfig(),
    url = validateServerUrl(options.url ?? process.env.REVIEWLOOP_URL ?? config.serverUrl);
  const tokenFile =
    options.tokenFile ??
    config.clientTokenFile ??
    join(options.dataDir ?? defaultDataDir(config), 'access-token');
  const token = options.token ?? readFileSync(tokenFile, 'utf8').trim();
  const response = await fetch(url + '/api' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(120000)])
      : AbortSignal.timeout(120000),
    redirect: 'error',
  });
  const result = (await response.json()) as { error?: { message: string } };
  if (!response.ok) throw new Error(result.error?.message ?? `HTTP ${response.status}`);
  return result as T;
}
