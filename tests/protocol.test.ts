import { it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CodexRuntime } from '../src/modules/agents/codex/runtime.js';
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
        instructions: { prompt: `Custom ${role} instructions for this task.` },
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
      expect(
        packets.find(
          (packet) => packet.method === (role === 'reviewer' ? 'thread/resume' : 'thread/start'),
        ).params.developerInstructions,
      ).toContain(job.instructions.prompt);
      const injected = packets.find((packet) => packet.method === 'thread/inject_items');
      if (role === 'reviewer') {
        expect(injected.params.threadId).toBe('thread-fixture');
        expect(injected.params.items[0]).toMatchObject({
          type: 'message',
          role: 'developer',
          content: [{ type: 'input_text', text: expect.stringContaining(job.instructions.prompt) }],
        });
        expect(injected.params.items[0].content[0].text).toContain('~/.tokens');
        expect(packets.indexOf(injected)).toBeLessThan(
          packets.findIndex((packet) => packet.method === 'turn/start'),
        );
      } else expect(injected).toBeUndefined();
    }
  } finally {
    f.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it('does not run a resumed Codex turn when refreshing its policy fails', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'daddyloop-policy-'));
  try {
    const log = join(dir, 'packets.jsonl');
    const runtime = new CodexRuntime({
      executable: process.execPath,
      args: [resolve('tests/fixtures/fake-codex.mjs'), 'policy-error', log],
      timeoutMs: 5000,
    });
    await expect(
      runtime.runSession({
        threadId: 'thread-fixture',
        cwd: dir,
        prompt: 'Continue',
        instructions: 'Updated policy',
        readOnly: false,
        signal: new AbortController().signal,
        onSession: () => {},
        onEvent: () => {},
        onTool: async () => ({}),
      }),
    ).rejects.toThrow('Policy update failed');
    const packets = readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(packets.some((packet) => packet.method === 'turn/start')).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('exposes only Codex commentary through the public assistant callback', async () => {
  const onAssistantMessage = vi.fn();
  const runtime = new CodexRuntime({
    executable: process.execPath,
    args: [resolve('tests/fixtures/fake-codex.mjs'), 'messages'],
    timeoutMs: 5000,
  });
  const result = await runtime.runSession({
    cwd: process.cwd(),
    prompt: 'Fixture',
    instructions: '',
    readOnly: true,
    signal: new AbortController().signal,
    onSession: () => {},
    onEvent: () => {},
    onTool: async () => ({}),
    onAssistantMessage,
  });
  expect(result.summary).toBe('Verified callback ordering');
  expect(onAssistantMessage.mock.calls).toEqual([
    [{ id: 'comment-1', text: 'Checking the implementation.' }],
  ]);
});

it.each(['host', 'sandbox'] as const)(
  'uses the shared %s execution mode for Codex start and turns',
  async (execution) => {
    const dir = mkdtempSync(join(tmpdir(), 'daddyloop-execution-'));
    try {
      const path = join(dir, 'packets.jsonl');
      const runtime = new CodexRuntime({
        executable: process.execPath,
        args: [resolve('tests/fixtures/fake-codex.mjs'), 'happy', path],
        timeoutMs: 5000,
      });
      await runtime.runSession({
        execution,
        processScope: {
          cacheDir: dir,
          env: { DADDYLOOP_RUN_SCOPE: 'fixture-owned-run', DADDYLOOP_RUN_CACHE: dir },
        },
        cwd: dir,
        prompt: 'Fixture',
        readOnly: false,
        instructions: 'Fixture',
        signal: new AbortController().signal,
        onSession: () => {},
        onEvent: () => {},
        onTool: async () => ({}),
      });
      const packets = readFileSync(path, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      const start = packets.find((packet) => packet.method === 'thread/start').params;
      const turn = packets.find((packet) => packet.method === 'turn/start').params;
      expect(start.approvalPolicy).toBe('never');
      expect(start.sandbox).toBe(execution === 'host' ? 'danger-full-access' : 'workspace-write');
      expect(turn.sandboxPolicy.type).toBe(
        execution === 'host' ? 'dangerFullAccess' : 'workspaceWrite',
      );
      expect(start.config['shell_environment_policy.inherit']).toBe(
        execution === 'host' ? 'all' : 'core',
      );
      expect(start.config['shell_environment_policy.set']).toEqual({
        DADDYLOOP_RUN_SCOPE: 'fixture-owned-run',
        DADDYLOOP_RUN_CACHE: dir,
      });
      expect(start.developerInstructions.includes('inspect filenames under ~/.tokens')).toBe(
        execution === 'host',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
