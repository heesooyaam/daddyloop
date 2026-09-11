import { it, expect } from 'vitest';
import { serviceUnit, systemdQuote } from '../src/ops/service.js';
import { validateServerUrl } from '../src/ops/config.js';
import { fixture } from './helpers.js';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from '../src/runtime/worker.js';
import { Workspaces } from '../src/runtime/workspaces.js';
import type { AgentRuntime } from '../src/runtime/agent.js';
import type { ResourceStatus } from '../src/core/types.js';
it('generates a service independent of terminals, with a separate user and memory limit', () => {
  const text = serviceUnit({
    executable: '/opt/Node With Space/node',
    entry: '/opt/daddyloop/cli.js',
    dataDir: '/data/daddyloop',
    configFile: '/data/config.json',
    path: '/usr/bin',
    memoryMax: '8G',
    port: 4317,
    user: { uid: 1000, gid: 1000 },
  });
  expect(text).toContain('User=1000');
  expect(text).toContain('MemoryMax=8G');
  expect(text).toContain('KillMode=control-group');
  expect(text).toContain('WantedBy=multi-user.target');
  expect(text).not.toContain('tmux');
  expect(text).toContain('Restart=on-failure');
  expect(systemdQuote('/home/test%user/$file')).toContain('%%user');
  expect(() => systemdQuote('/tmp/a\nExecStart=bad')).toThrow();
});
it('rejects credential-bearing or plaintext remote server URLs', () => {
  expect(validateServerUrl('https://review.example/')).toBe('https://review.example');
  expect(validateServerUrl('http://127.0.0.1:4317')).toBe('http://127.0.0.1:4317');
  for (const url of [
    'http://review.example',
    'https://token@review.example',
    'https://review.example/path',
  ])
    expect(() => validateServerUrl(url)).toThrow();
});
it('recovers interruption between saving cancellation and the task transition', async () => {
  const f = await fixture();
  await f.engine.review(f.task.id);
  const job = f.store.claim()!;
  job.status = 'cancelled';
  f.store.saveJob(job);
  f.engine.recoverInterruptedJobs();
  expect(f.store.getTask(f.task.id).state).toBe('needs_input');
  expect(f.store.getTask(f.task.id).reviewFinished).toBe(false);
  f.store.close();
});
it.skipIf(!existsSync('/usr/bin/systemd-analyze'))(
  'passes the host systemd parser with spaces and percent signs in paths',
  () => {
    const root = mkdtempSync(join(tmpdir(), 'daddyloop-systemd-'));
    try {
      const file = join(root, 'daddyloop-test.service');
      writeFileSync(
        file,
        serviceUnit({
          executable: process.execPath,
          entry: '/opt/Review loop/cli.js',
          dataDir: '/data/Review loop%test',
          configFile: '/data/Review loop/config.json',
          path: '/usr/bin',
          memoryMax: '8G',
          port: 4317,
        }),
      );
      expect(() =>
        execFileSync('systemd-analyze', ['verify', file], { stdio: 'pipe' }),
      ).not.toThrow();
    } finally {
      rmSync(root, { recursive: true });
    }
  },
);
it.each(['shutdown', 'memory pressure'])(
  'preserves incomplete review and cancels the agent on %s',
  async (reason) => {
    const f = await fixture();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    let aborted = false;
    const runtime: AgentRuntime = {
      run: async (input) => {
        started();
        await new Promise<void>((resolve) =>
          input.signal.addEventListener(
            'abort',
            () => {
              aborted = true;
              resolve();
            },
            { once: true },
          ),
        );
        return f.result();
      },
    };
    let resources = { ok: true, reasons: [] } as unknown as ResourceStatus;
    const worker = new Worker(f.engine, new Workspaces('/tmp'), runtime, runtime, () => resources);
    try {
      await worker.tick();
      await ready;
      if (reason === 'memory pressure') {
        resources = { ...resources, ok: false, reasons: ['Memory below the configured reserve'] };
        await worker.tick();
      }
      await worker.stop();
      expect(aborted).toBe(true);
      expect(f.store.getTask(f.task.id)).toMatchObject({
        state: 'needs_input',
        reviewFinished: false,
      });
      expect(f.store.jobs(f.task.id)[0].status).toBe('cancelled');
      f.engine.recoverInterruptedJobs();
      expect(f.store.getTask(f.task.id).state).toBe('needs_input');
    } finally {
      await worker.stop();
      f.store.close();
    }
  },
);
