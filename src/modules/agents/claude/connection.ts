import { rememberSecret } from '../../../core/security.js';
import type { Options, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Executable } from '../../../runtime/executable.js';
export type ClaudeQuery = typeof import('@anthropic-ai/claude-agent-sdk').query;
export const claudeExecutable = (executable?: Executable) =>
  (typeof executable === 'function' ? executable() : executable) ?? 'claude';

export function claudeEnvironment(host = false) {
  const env: Record<string, string | undefined> = Object.fromEntries(
    Object.keys(process.env).map((key) => [key, undefined]),
  );
  if (host)
    for (const [name, value] of Object.entries(process.env))
      if (!/^(TELEGRAM_BOT_TOKEN|DADDYLOOP_.*TOKEN.*)$/.test(name)) env[name] = value;
  for (const key of [
    'HOME',
    'PATH',
    'TMPDIR',
    'LANG',
    'LC_ALL',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
  ])
    if (process.env[key]) env[key] = process.env[key];
  const keyFile = process.env.DADDYLOOP_CLAUDE_API_KEY_FILE ?? join(homedir(), '.tokens/anthropic');
  const key =
    process.env.ANTHROPIC_API_KEY ??
    (existsSync(keyFile) ? readFileSync(keyFile, 'utf8').trim() : undefined);
  if (key) env.ANTHROPIC_API_KEY = rememberSecret(key);
  for (const [name, value] of Object.entries(env))
    if (value && /(?:_TOKEN|_API_KEY)$/.test(name)) rememberSecret(value);
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
  env.DISABLE_AUTOUPDATER = '1';
  env.GIT_OPTIONAL_LOCKS = '0';
  return env;
}
export function connectionOptions(executable?: Executable, host = false): Options {
  return {
    pathToClaudeCodeExecutable: claudeExecutable(executable),
    env: claudeEnvironment(host),
    settingSources: [],
    strictMcpConfig: true,
    mcpServers: {},
    plugins: [],
  };
}
/** Keep stdin open without sending a prompt: catalogue discovery makes no model turn. */
export function idleInput(signal: AbortSignal): AsyncIterable<SDKUserMessage> {
  return {
    async *[Symbol.asyncIterator]() {
      if (signal.aborted) return;
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true }),
      );
    },
  };
}
