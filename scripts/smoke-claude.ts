// Opt-in: two real model calls, confined to a temporary directory; no PR operations.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeRuntime } from '../src/modules/agents/claude/runtime.js';
import { ClaudeCatalogue } from '../src/modules/agents/claude/models.js';
import { moduleExecutable } from '../src/runtime/executable.js';
import { loadConfig } from '../src/ops/config.js';
if (process.env.DADDYLOOP_LIVE_CLAUDE_TEST !== '1')
  throw new Error('This test makes paid API calls. Set DADDYLOOP_LIVE_CLAUDE_TEST=1 to run it.');
const executable = moduleExecutable('claude', loadConfig());
const models = await new ClaudeCatalogue(executable).list();
const model =
  process.env.DADDYLOOP_CLAUDE_SMOKE_MODEL ??
  models.find((model) => model.id === 'haiku')?.id ??
  models[0]?.id;
if (!model || !models.some((item) => item.id === model))
  throw new Error('Choose a model returned by the Claude CLI');
const cwd = await mkdtemp(join(tmpdir(), 'daddyloop-claude-smoke-'));
const runtime = new ClaudeRuntime({ executable, timeoutMs: 120000, maxBudgetUSD: 0.25 });
let native: string | undefined,
  toolCalls = 0;
const common = {
  cwd,
  profile: { engine: 'claude', model },
  signal: AbortSignal.timeout(240000),
  instructions:
    'This is a bounded integration check. Work only in this temporary directory. Return the required JSON result with checkedHead="", question=null and empty verification/dispute arrays. Call smoke_evidence before declaring success.',
  tools: [
    {
      name: 'smoke_evidence',
      description: 'Read the fixed verification marker.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
  ],
  onSession: (id: string) => {
    native = id;
  },
  onEvent: () => {},
  onTool: async (name: string) => {
    if (name !== 'smoke_evidence') throw new Error('Unexpected tool');
    toolCalls++;
    return { expectedText: 'daddy handled it' };
  },
};
try {
  const worker = await runtime.runSession({
    ...common,
    readOnly: false,
    prompt:
      'Create result.txt containing exactly daddy handled it. Read it back, then return the structured result.',
  });
  if (
    worker.status !== 'completed' ||
    (await readFile(join(cwd, 'result.txt'), 'utf8')).trim() !== 'daddy handled it'
  )
    throw new Error('Worker did not produce the expected file');
  const original = native;
  const review = await runtime.runSession({
    ...common,
    threadId: native,
    readOnly: true,
    prompt:
      'Resume this session. Inspect result.txt without changing anything, call smoke_evidence, then report the structured verification result.',
  });
  if (review.status !== 'completed' || native !== original || toolCalls < 2)
    throw new Error('Resume, read-only verification or MCP dispatch failed');
  console.log(
    JSON.stringify({
      model,
      worker: worker.status,
      resumed: true,
      verification: review.status,
      toolCalls,
    }),
  );
} finally {
  await rm(cwd, { recursive: true, force: true });
}
