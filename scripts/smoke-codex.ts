// Opt-in live integration check. Does not open a PR, publish comments, or run shell tools.
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CodexRuntime } from '../src/runtime/codex.js';
import { defaultPolicy, type Task, type Job } from '../src/core/types.js';
const dataDir = resolve('.reviewloop');
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const at = new Date().toISOString(),
  phrase = `transport-${randomUUID()}`;
const task: Task = {
  id: randomUUID(),
  title: 'Codex transport self-check',
  requirements: 'Validate dynamic tools and persistent thread resume',
  kind: 'code',
  ref: {
    provider: 'demo',
    host: 'demo.local',
    repo: 'test/transport',
    number: 1,
    url: 'https://demo.local/pull/1',
  },
  repoPath: process.cwd(),
  state: 'reviewing',
  reason: '',
  generation: 1,
  contextVersion: 1,
  round: 1,
  noProgress: 0,
  summary: '',
  createdAt: at,
  updatedAt: at,
  policy: defaultPolicy,
  revision: { head: 'a'.repeat(40), base: 'b'.repeat(40), start: 'b'.repeat(40) },
};
const runtime = new CodexRuntime({ timeoutMs: 180000 });
const events: { type: string; data: unknown }[] = [];
let toolCalls = 0;
async function turn(prompt: string, model?: string) {
  const job: Job = {
    id: randomUUID(),
    taskId: task.id,
    generation: 1,
    role: 'reviewer',
    ...(model ? { profile: { engine: 'codex' as const, model, effort: 'max' as const } } : {}),
    kind: 'chat',
    input: prompt,
    status: 'running',
    createdAt: at,
  };
  return runtime.run({
    task,
    job,
    cwd: process.cwd(),
    prompt,
    signal: new AbortController().signal,
    onSession: (id) => {
      task.reviewerThreadId = id;
    },
    onTool: async (name) => {
      if (name !== 'read_review')
        throw new Error('Only read_review is allowed in the transport test');
      toolCalls++;
      return { status: 'draft', body: 'Transport fixture', comments: [], revision: task.revision };
    },
    onEvent: (type, data) => {
      if (!type.includes('diagnostic')) events.push({ type, data });
    },
  });
}
try {
  const first = await turn(
    `This is a minimal protocol test, not a code review. Do not inspect files, run commands, invoke other agents, or change anything. Remember the phrase ${phrase}. Call read_review exactly once. Then return the required JSON: status completed, summary "Transport verified", checkedHead "${task.revision!.head}", question null, and empty verifiedCommentIds/disputedCommentIds.`,
    process.env.REVIEWLOOP_SMOKE_AUTHOR_MODEL,
  );
  if (first.status !== 'completed' || toolCalls !== 1)
    throw new Error('Live dynamic-tool round trip did not complete');
  const thread = task.reviewerThreadId;
  const second = await turn(
    `Continue the protocol test. Do not use any tools or inspect files. Return the exact phrase I asked you to remember in the previous turn as summary, with status completed, checkedHead "${task.revision!.head}", question null and empty verifiedCommentIds/disputedCommentIds.`,
    process.env.REVIEWLOOP_SMOKE_REVIEWER_MODEL,
  );
  if (second.summary !== phrase || task.reviewerThreadId !== thread)
    throw new Error('The resumed thread did not retain the previous turn');
  writeFileSync(
    join(dataDir, 'codex-smoke.json'),
    JSON.stringify({ ok: true, threadId: thread, toolCalls, at, events }, null, 2),
    { mode: 0o600 },
  );
  console.log(
    'Live Codex check passed: dynamic tool round trip, structured result, and persistent thread resume.',
  );
} catch (error) {
  writeFileSync(
    join(dataDir, 'codex-smoke.json'),
    JSON.stringify({ ok: false, error: String(error), at, events }, null, 2),
    { mode: 0o600 },
  );
  console.error(String(error));
  process.exitCode = 1;
}
