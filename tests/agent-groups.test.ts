import { it, expect, vi } from 'vitest';
import { Engine } from '../src/core/engine.js';
import { Store } from '../src/core/store.js';
import { DemoProvider } from '../src/providers/demo.js';
import { Worker } from '../src/runtime/worker.js';
import { Workspaces } from '../src/runtime/workspaces.js';
import type { AgentInput } from '../src/runtime/agent.js';
import { ticketInput, profiles, healthy } from './planning-fixture.js';
it('runs independent authors together and serializes one persistent reviewer across child tickets', async () => {
  const store = new Store(':memory:'),
    engine = new Engine(store, () => new DemoProvider(store));
  const root = await engine.createTicket(ticketInput()),
    child = await engine.createTicket({
      ...ticketInput(43),
      parentTaskId: root.id,
      agents: { ...profiles, worker: { engine: 'codex', model: 'gpt-5.6-sol', effort: 'medium' } },
    });
  const ws = new Workspaces('/tmp');
  vi.spyOn(ws, 'prepareTicket').mockResolvedValue('/tmp');
  const pending: { input: AgentInput; done: () => void }[] = [],
    seen: AgentInput[] = [];
  const runtime = {
    run: vi.fn(async (input: AgentInput) => {
      seen.push(input);
      input.onSession(
        input.job.role === 'reviewer'
          ? (input.task.reviewerThreadId ?? 'one-shared-reviewer')
          : `author-${input.task.id}`,
      );
      await new Promise<void>((resolve) => pending.push({ input, done: resolve }));
      return {
        status: 'completed' as const,
        summary: 'Read the current ticket.',
        checkedHead: input.task.revision!.head,
      };
    }),
  };
  const worker = new Worker(engine, ws, runtime, runtime, healthy, 0, 2);
  const finish = async () => {
    for (const item of pending.splice(0)) item.done();
    await vi.waitFor(() =>
      expect(store.jobs().some((job) => job.status === 'running')).toBe(false),
    );
  };
  try {
    await worker.tick();
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    expect(seen.map((input) => input.job.profile?.effort).sort()).toEqual(['max', 'medium']);
    await finish();
    expect(store.getTask(root.id).authorThreadId).not.toBe(store.getTask(child.id).authorThreadId);
    store.message(root.id, 'author', 'user', 'private-parent-author-chat');
    await engine.chat(root.id, 'reviewer', 'Discuss parent');
    await engine.chat(child.id, 'reviewer', 'Discuss child');
    await worker.tick();
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    await expect(engine.setTaskAgent(root.id, 'reviewer', profiles.worker)).rejects.toThrow(
      'queue',
    );
    await finish();
    await worker.tick();
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    const second = pending[0].input;
    expect(second.task.reviewerThreadId).toBe('one-shared-reviewer');
    expect(second.job.profile).toEqual(profiles.daddy);
    expect(second.prompt).toContain('one shared reviewer');
    expect(second.prompt).not.toContain('private-parent-author-chat');
    await finish();
    expect(store.getGroup(root.groupId!).reviewerThreadId).toBe('one-shared-reviewer');
    await engine.setTaskAgent(child.id, 'reviewer', profiles.worker);
    expect(engine.effectiveAgents(store.getTask(root.id)).daddy).toEqual(profiles.worker);
  } finally {
    for (const item of pending) item.done();
    await worker.stop();
    store.close();
  }
});
it('records profiles at enqueue, keeps manual policy explicit and rejects competing child reviewers', async () => {
  const store = new Store(':memory:'),
    engine = new Engine(store, () => new DemoProvider(store), profiles);
  try {
    const root = await engine.createTicket(ticketInput());
    expect(root.policy.publication).toBe('auto');
    engine.setDefaultAgents({ worker: { engine: 'codex' }, daddy: { engine: 'codex' } });
    expect(store.jobs(root.id)[0].profile).toEqual(profiles.worker);
    await expect(
      engine.createTicket({
        ...ticketInput(43),
        parentTaskId: root.id,
        agents: { ...profiles, daddy: profiles.worker },
      }),
    ).rejects.toThrow('inherit');
    const child = await engine.createTicket({
      ...ticketInput(44),
      parentTaskId: root.id,
      publication: 'human',
      autoPush: false,
    });
    expect(child.policy).toMatchObject({ publication: 'human', autoPush: false });
    expect(store.groups()).toHaveLength(1);
    const settled = await Promise.allSettled([
      engine.createTicket(ticketInput(45)),
      engine.createTicket(ticketInput(45)),
    ]);
    expect(settled.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
  } finally {
    store.close();
  }
});
