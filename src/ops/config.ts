import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { profilesSchema, inheritedProfiles } from '../core/agents.js';

export const configSchema = z
  .object({
    version: z.literal(2).default(2),
    dataDir: z.string().optional(),
    serverUrl: z.string().url().default('http://127.0.0.1:4317'),
    clientTokenFile: z.string().optional(),
    publicOrigin: z.string().url().optional(),
    port: z.number().int().min(1024).max(65535).default(4317),
    memoryMax: z
      .string()
      .regex(/^\d+(?:[KMGT])?$/)
      .default('8G'),
    serviceMode: z.enum(['auto', 'user', 'system']).default('auto'),
    demo: z.boolean().default(true),
    locale: z.enum(['en', 'ru']).default('en'),
    workspaces: z
      .object({ roots: z.array(z.string().min(1)).min(1).max(20).optional() })
      .default({}),
    codex: z.object({ executable: z.string().min(1).optional() }).default({}),
    updates: z
      .object({
        enabled: z.boolean().default(true),
        intervalHours: z.number().int().min(1).max(168).default(6),
      })
      .default({ enabled: true, intervalHours: 6 }),
    agents: profilesSchema.default(inheritedProfiles),
    maxConcurrentAgents: z.number().int().min(1).max(8).default(1),
    resources: z
      .object({
        minDiskGiB: z.number().nonnegative(),
        maxDiskPercent: z.number().min(1).max(100),
        minMemoryGiB: z.number().nonnegative(),
      })
      .default({ minDiskGiB: 10, maxDiskPercent: 90, minMemoryGiB: 2 }),
    cache: z
      .object({
        auto: z.boolean(),
        maxAgeDays: z.number().int().min(1),
        keepReviewerCopies: z.number().int().min(1),
      })
      .default({ auto: false, maxAgeDays: 7, keepReviewerCopies: 1 }),
    telegram: z
      .object({ enabled: z.boolean().default(false), tokenFile: z.string().optional() })
      .default({ enabled: false }),
    arcadia: z
      .object({
        enabled: z.boolean().default(false),
        leaseHelper: z.string().optional(),
        arcanumCli: z.string().default('arcanum-cli'),
      })
      .default({ enabled: false, arcanumCli: 'arcanum-cli' }),
  })
  .strict();
export type Config = z.infer<typeof configSchema>;
export function configPath() {
  return (
    process.env.DADDYLOOP_CONFIG ??
    join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'daddyloop', 'config.json')
  );
}
export function loadConfig(): Config {
  const path = configPath();
  return configSchema.parse(existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {});
}
export function saveConfig(config: Config) {
  const path = configPath();
  privateWrite(path, JSON.stringify(configSchema.parse(config), null, 2) + '\n');
}
export function defaultDataDir(config = loadConfig()) {
  if (process.env.DADDYLOOP_DATA_DIR) return resolve(process.env.DADDYLOOP_DATA_DIR);
  if (config.dataDir) return resolve(config.dataDir);
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'daddyloop', 'data');
}
export function privateWrite(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, content, { mode: 0o600, flag: 'wx' });
  renameSync(temporary, path);
}
export function validateServerUrl(input: string, publicOnly = false) {
  const url = new URL(input);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/')
    throw new Error('Use a server origin without credentials, path, query or fragment');
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && (publicOnly || !local || url.protocol !== 'http:'))
    throw new Error('Remote access requires HTTPS');
  return url.origin;
}
