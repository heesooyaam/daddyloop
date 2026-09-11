import { it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeRuntime, claudeToolGuard } from '../src/modules/agents/claude/runtime.js';
import { ClaudeCatalogue } from '../src/modules/agents/claude/models.js';
import { ClaudeUsage } from '../src/modules/agents/claude/usage.js';
import { Store } from '../src/core/store.js';
import { profileSchema } from '../src/core/agents.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { ClaudeQuery } from '../src/modules/agents/claude/connection.js';
const final = {
  status: 'completed',
  summary: 'Verified',
  checkedHead: 'a'.repeat(40),
  question: null,
  verifiedCommentIds: [],
  disputedCommentIds: [],
};
it('routes Claude tools, structured output, model/effort and native resume through the common runtime', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'daddyloop-claude-test-'));
  const onTool = vi.fn(async () => ({ comments: [] })),
    onSession = vi.fn();
  let closed = false;
  const connect: ClaudeQuery = vi.fn(({ options }) => {
    expect(options?.resume).toBe('native-session');
    expect(options?.model).toBe('sonnet[1m]');
    expect(options?.effort).toBe('max');
    expect(options?.settingSources).toEqual([]);
    expect(options?.sandbox).toMatchObject({
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
    });
    const iterable = (async function* () {
      const server = options!.mcpServers!.daddyloop as any;
      const client = new Client({ name: 'fixture', version: '1' });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.instance.connect(a), client.connect(b)]);
      try {
        expect(await client.callTool({ name: 'read_review', arguments: {} })).toMatchObject({
          content: [{ text: '{"comments":[]}' }],
        });
      } finally {
        await client.close();
      }
      yield {
        type: 'result',
        subtype: 'success',
        is_error: false,
        structured_output: final,
        session_id: 'native-session',
        total_cost_usd: 0.01,
        modelUsage: {},
      };
    })();
    return Object.assign(iterable, {
      close: () => {
        closed = true;
      },
    }) as any;
  });
  try {
    const runtime = new ClaudeRuntime({ connect });
    expect(
      profileSchema.parse({ engine: 'claude', model: 'sonnet[1m]', effort: 'max' }).model,
    ).toBe('sonnet[1m]');
    const result = await runtime.runSession({
      cwd,
      threadId: 'native-session',
      profile: { engine: 'claude', model: 'sonnet[1m]', effort: 'max' },
      prompt: 'Review',
      readOnly: true,
      instructions: 'Scoped task',
      signal: new AbortController().signal,
      onTool,
      onSession,
      onEvent: vi.fn(),
    });
    expect(result.summary).toBe('Verified');
    expect(onTool).toHaveBeenCalledWith('read_review', {}, expect.any(String));
    expect(onSession).toHaveBeenCalledWith('native-session');
    expect(closed).toBe(true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
it('denies native delegation, publication escapes, read-only edits and paths through symlinks', async () => {
  const root = mkdtempSync(join(tmpdir(), 'daddyloop-claude-guard-')),
    cwd = join(root, 'task');
  mkdirSync(cwd);
  writeFileSync(join(root, 'secret'), 'private');
  symlinkSync(join(root, 'secret'), join(cwd, 'escape'));
  const guard = claudeToolGuard(cwd, true, new Set(['mcp__daddyloop__read_review']));
  const call = (name: string, input = {}) =>
    guard({ hook_event_name: 'PreToolUse', tool_name: name, tool_input: input } as any, 'id', {
      signal: new AbortController().signal,
    });
  try {
    for (const [name, input] of [
      ['Read', { file_path: '../secret' }],
      ['Read', { file_path: 'escape' }],
      ['Write', { file_path: 'allowed.txt' }],
      ['Agent', {}],
      ['Bash', { dangerouslyDisableSandbox: true }],
      ['Glob', { pattern: '../*' }],
    ] as const)
      expect(await call(name, input)).toMatchObject({
        hookSpecificOutput: { permissionDecision: 'deny' },
      });
    expect(await call('Read', { file_path: 'normal.txt' })).toEqual({});
    expect(await call('mcp__daddyloop__read_review')).toEqual({});
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
it('never advances a malformed, failed, missing or cancelled Claude result', async () => {
  for (const message of [
    undefined,
    { type: 'result', subtype: 'success', is_error: false, structured_output: { summary: 'done' } },
    { type: 'result', subtype: 'error_max_turns', errors: ['Turn limit'] },
  ]) {
    let closed = false;
    const connect = (() =>
      Object.assign(
        (async function* () {
          if (message) yield message;
        })(),
        {
          close: () => {
            closed = true;
          },
        },
      )) as unknown as ClaudeQuery;
    const runtime = new ClaudeRuntime({ connect });
    await expect(
      runtime.runSession({
        cwd: tmpdir(),
        prompt: '',
        readOnly: true,
        instructions: '',
        signal: new AbortController().signal,
        onSession: vi.fn(),
        onEvent: vi.fn(),
        onTool: vi.fn(),
      }),
    ).rejects.toThrow();
    expect(closed).toBe(true);
  }
  const connect = vi.fn(),
    abort = new AbortController();
  abort.abort();
  await expect(
    new ClaudeRuntime({ connect }).runSession({
      cwd: tmpdir(),
      prompt: '',
      readOnly: true,
      instructions: '',
      signal: abort.signal,
      onSession: vi.fn(),
      onEvent: vi.fn(),
      onTool: vi.fn(),
    }),
  ).rejects.toThrow();
  expect(connect).not.toHaveBeenCalled();
});
it('discovers model aliases and efforts from the CLI without submitting a prompt and refreshes a changed executable', async () => {
  let command = '/old/claude',
    calls = 0;
  const connect = (({ prompt, options }) => {
    expect(typeof prompt).not.toBe('string');
    expect(options?.tools).toEqual([]);
    calls++;
    return {
      supportedModels: async () => [
        { value: command, displayName: 'Provider model', supportedEffortLevels: ['max'] },
      ],
      close: vi.fn(),
    } as any;
  }) as ClaudeQuery;
  const catalogue = new ClaudeCatalogue(() => command, connect);
  expect((await catalogue.list())[0].efforts).toEqual(['max']);
  await catalogue.list();
  expect(calls).toBe(1);
  command = '/new/claude';
  expect((await catalogue.list())[0].id).toBe('/new/claude');
  expect(calls).toBe(2);
});
it('keeps missing Claude usage unknown and preserves future quota names without guessing their duration', async () => {
  const store = new Store(':memory:'),
    usage = new ClaudeUsage(store);
  try {
    expect(await usage.read()).toMatchObject({
      available: false,
      buckets: [],
      resets: { canUse: false },
    });
    usage.observe({
      status: 'rejected',
      rateLimitType: 'future_model_pool',
      utilization: 0.8,
    } as any);
    usage.observe({ status: 'allowed', rateLimitType: 'no_percentage' } as any);
    const view = await usage.read();
    expect(view.buckets[0]).toMatchObject({
      id: 'future_model_pool',
      blocked: 'rejected',
      windows: [{ remainingPercent: 20 }],
    });
    expect(view.buckets[0].windows[0].durationMinutes).toBeUndefined();
    expect(view.buckets[1].windows[0].remainingPercent).toBeNull();
  } finally {
    store.close();
  }
});
it('grants repository and Git metadata reads without granting writes outside the starting directory', async () => {
  const root = mkdtempSync(join(tmpdir(), 'daddyloop-claude-roots-')),
    repo = join(root, 'repo'),
    cwd = join(repo, 'src'),
    metadata = join(root, 'objects.git');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(metadata);
  writeFileSync(join(repo, 'shared.txt'), 'read me');
  writeFileSync(join(metadata, 'HEAD'), 'head');
  const guard = claudeToolGuard(cwd, false, new Set(), repo, [metadata]);
  const call = (tool_name: string, file_path: string) =>
    guard({ hook_event_name: 'PreToolUse', tool_name, tool_input: { file_path } } as any, 'id', {
      signal: new AbortController().signal,
    });
  try {
    expect(await call('Read', '../shared.txt')).toEqual({});
    expect(await call('Read', join(metadata, 'HEAD'))).toEqual({});
    for (const file of ['../shared.txt', join(metadata, 'HEAD')])
      expect(await call('Write', file)).toMatchObject({
        hookSpecificOutput: { permissionDecision: 'deny' },
      });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
it('records API activity without turning cost or tokens into an invented quota', async () => {
  const store = new Store(':memory:'),
    usage = new ClaudeUsage(store);
  try {
    usage.observeActivity({ model: { inputTokens: 2400, outputTokens: 80, costUSD: 0.02 } });
    expect(await usage.read()).toMatchObject({
      available: false,
      buckets: [],
      activity: { inputTokens: 2400, outputTokens: 80, costUSD: 0.02 },
      resets: { canUse: false },
    });
  } finally {
    store.close();
  }
});
