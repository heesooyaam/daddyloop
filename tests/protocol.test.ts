import { it, expect, vi } from 'vitest';
import { resolve } from 'node:path';
import { CodexRuntime } from '../src/runtime/codex.js';
import { fixture } from './helpers.js';
it.each(['happy', 'tool'])(
  'handles Codex completion ordering and bidirectional tools (%s)',
  async (mode) => {
    const f = await fixture();
    const onTool = vi.fn(async () => ({ status: 'draft', comments: [] }));
    const runtime = new CodexRuntime({
      executable: process.execPath,
      args: [resolve('tests/fixtures/fake-codex.mjs'), mode],
      timeoutMs: 5000,
    });
    const sessions: string[] = [];
    const result = await runtime.run({
      task: f.task,
      job: f.job(),
      cwd: process.cwd(),
      prompt: 'Review',
      signal: new AbortController().signal,
      onSession: (thread) => {
        sessions.push(thread);
      },
      onEvent: () => {},
      onTool,
    });
    expect(result.status).toBe('completed');
    expect(sessions).toContain('thread-fixture');
    if (mode === 'tool') expect(onTool).toHaveBeenCalledWith('read_review', {}, 'call-1');
    f.store.close();
  },
);
it.each(['malformed', 'exit'])(
  'does not convert invalid or interrupted runtime output to success (%s)',
  async (mode) => {
    const f = await fixture();
    const runtime = new CodexRuntime({
      executable: process.execPath,
      args: [resolve('tests/fixtures/fake-codex.mjs'), mode],
      timeoutMs: 5000,
    });
    await expect(
      runtime.run({
        task: f.task,
        job: f.job(),
        cwd: process.cwd(),
        prompt: 'Review',
        signal: new AbortController().signal,
        onSession: () => {},
        onEvent: () => {},
        onTool: async () => ({}),
      }),
    ).rejects.toThrow();
    f.store.close();
  },
);
