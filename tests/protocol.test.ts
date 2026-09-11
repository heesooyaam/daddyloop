import { it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CodexRuntime } from '../src/runtime/codex.js';
import { fixture } from './helpers.js';
it('captures the executable for a running turn and reads the new selection only on the next turn', async () => {
  const f = await fixture();
  let executable = process.execPath,
    entered!: () => void,
    finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const runtime = new CodexRuntime({
    executable: () => executable,
    args: [resolve('tests/fixtures/fake-codex.mjs'), 'tool'],
    timeoutMs: 5000,
  });
  const input = {
    task: f.task,
    job: f.job(),
    cwd: process.cwd(),
    prompt: 'Test',
    signal: new AbortController().signal,
    onSession: (thread: string) => {
      f.task.reviewerThreadId = thread;
    },
    onEvent: () => {},
    onTool: async () => {
      entered();
      await gate;
      return {};
    },
  };
  try {
    const running = runtime.run(input);
    await ready;
    executable = '/nonexistent/new-codex';
    finish();
    expect((await running).status).toBe('completed');
    expect(f.task.reviewerThreadId).toBe('thread-fixture');
    await expect(runtime.run(input)).rejects.toThrow();
  } finally {
    finish();
    f.store.close();
  }
});
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

it('applies separate role models and efforts on thread start, resume and every turn', async () => {
  const f = await fixture(),
    dir = mkdtempSync(join(tmpdir(), 'daddyloop-protocol-test-'));
  try {
    for (const role of ['author', 'reviewer'] as const) {
      const model = role === 'author' ? 'gpt-5.6-sol' : 'gpt-6-astra',
        log = join(dir, role + '.jsonl');
      const runtime = new CodexRuntime({
        executable: process.execPath,
        args: [resolve('tests/fixtures/fake-codex.mjs'), 'happy', log],
        timeoutMs: 5000,
      });
      const task = {
        ...f.task,
        ...(role === 'reviewer' ? { reviewerThreadId: 'thread-fixture' } : {}),
      };
      const job = {
        ...f.job(),
        role,
        profile: { engine: 'codex' as const, model, effort: 'max' as const },
      };
      await runtime.run({
        task,
        job,
        cwd: process.cwd(),
        prompt: 'Test',
        signal: new AbortController().signal,
        onSession: () => {},
        onEvent: () => {},
        onTool: async () => ({}),
      });
      const packets = readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(
        packets.find(
          (packet) => packet.method === (role === 'reviewer' ? 'thread/resume' : 'thread/start'),
        ).params.model,
      ).toBe(model);
      expect(packets.find((packet) => packet.method === 'turn/start').params).toMatchObject({
        model,
        effort: 'max',
      });
    }
  } finally {
    f.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
