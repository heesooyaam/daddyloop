import { expect, it, vi } from 'vitest';
import { daddyFixture } from './daddy-fixture.js';
import { taskSession } from '../src/runtime/agent.js';
import { ProviderHttp } from '../src/providers/http.js';
import { profiles } from './planning-fixture.js';
import { parseTaskInput } from '../src/integrations/telegram-tasks.js';
import type { AgentResult } from '../src/core/types.js';

it('validates the supplied design before implementation and passes the checked plan onward', async () => {
  const f = daddyFixture();
  try {
    const group = f.daddy.create({ workspaceId: f.workspace.id });
    const request = {
      requirements: 'Existing design: keep a durable per-message receipt.',
      requestId: 'direct',
    };
    const task = await f.daddy.createTask(group.id, request);
    expect((await f.daddy.createTask(group.id, request)).id).toBe(task.id);
    expect(f.store.jobs(task.id).map((j) => j.kind)).toEqual(['plan']);
    const summary =
      'Preserve the receipt before advancing the cursor. Check both restart orderings.';
    f.agentRuntime.run.mockImplementationOnce(async (input) => {
      expect(input.prompt).toContain(request.requirements);
      expect(input.tools).toEqual([]);
      expect(taskSession(input)).toMatchObject({
        readOnly: true,
        execution: 'sandbox',
        profile: profiles.daddy,
      });
      input.onSession('planner-thread');
      return { status: 'completed', summary, checkedHead: input.task.revision!.head };
    });
    await f.worker.tick();
    await vi.waitFor(() =>
      expect(f.store.jobs(task.id).map((j) => [j.kind, j.status])).toEqual([
        ['plan', 'completed'],
        ['implement', 'queued'],
      ]),
    );
    expect(f.checkouts.commitTicket).not.toHaveBeenCalled();
    expect(f.store.getTask(task.id).authorThreadId).toBe('planner-thread');
    await f.worker.tick();
    await vi.waitFor(() => expect(f.checkouts.commitTicket).toHaveBeenCalledOnce());
    const implementation = f.agentRuntime.run.mock.calls[1][0];
    expect(implementation.prompt).toContain(summary);
    expect(taskSession(implementation)).toMatchObject({
      readOnly: false,
      threadId: 'planner-thread',
      profile: profiles.worker,
    });
    expect(f.store.getTask(task.id).planning?.result?.revision.head).toBe(task.revision!.head);
  } finally {
    await f.close();
  }
});

it('preserves the planning gate on pause, stale completion, explicit clarification and duplicate completion', async () => {
  const f = daddyFixture();
  try {
    const group = f.daddy.create({ workspaceId: f.workspace.id });
    const task = await f.daddy.createTask(group.id, {
      requirements: 'Fix search.',
      requestId: 'question',
    });
    const result: AgentResult = {
      status: 'completed',
      summary: 'Keep the old filter and test both paths.',
      checkedHead: task.revision!.head,
    };
    const first = f.store.claim()!;
    await f.engine.action(task.id, 'pause');
    await f.engine.completeJob(first, result);
    expect(f.store.getTask(task.id).planning?.result).toBeUndefined();
    await f.engine.action(task.id, 'resume');
    const second = f.store.claim()!;
    expect(second.kind).toBe('plan');
    await f.engine.completeJob(second, {
      ...result,
      status: 'needs_input',
      question: 'Keep old filters?',
    });
    f.store.saveJob({ ...second, status: 'completed' });
    expect(f.store.activeJobs(task.id)).toEqual([]);
    await f.engine.chat(task.id, 'author', 'Keep the old filters.');
    await f.engine.completeJob(second, result);
    expect(f.store.jobs(task.id).some((j) => j.kind === 'implement')).toBe(false);
    const answer = f.store.claim()!;
    expect(answer.kind).toBe('plan');
    expect(f.store.getTask(task.id).latestClarification?.text).toBe('Keep the old filters.');
    await f.engine.completeJob(answer, result);
    await f.engine.completeJob(answer, result);
    expect(f.store.jobs(task.id).filter((j) => j.kind === 'implement')).toHaveLength(1);
  } finally {
    await f.close();
  }
});

it('accepts a per-task Telegram override and preserves ordinary descriptions', () => {
  expect(parseTaskInput('Use --no-plan literally', 'codex')).toEqual({
    requirements: 'Use --no-plan literally',
  });
  expect(parseTaskInput('--no-plan Fix search', 'codex')).toMatchObject({
    requirements: 'Fix search',
    validatePlan: false,
  });
  expect(parseTaskInput('--worker 2 --no-plan -- Fix search', 'codex')).toMatchObject({
    workerRequest: { slot: 2 },
    validatePlan: false,
  });
  expect(parseTaskInput('--plan --no-plan -- Fix search', 'codex')).toBeUndefined();
});

it.each([false, true])(
  'records the coordinator brief in GitHub before dispatch (existing issue: %s)',
  async (existing) => {
    const f = daddyFixture();
    const title = 'Fix search',
      plan = 'Read the existing index, keep both filters and test a restart.';
    const url = 'https://github.com/test/repo/issues/61';
    const initialBody = 'Original owner description';
    const issue = {
      id: 92,
      number: 61,
      user: { id: 7 },
      body: initialBody,
      title,
      state: 'open',
      updated_at: '2026-01-01T00:00:00Z',
    };
    const notes: { id: number; body: string; user: { id: number; login: string } }[] = [];
    let posts = 0,
      lost = true;
    const http = new ProviderHttp('https://api.github.com', {}, async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === '/user') return Response.json({ id: 7 });
      if (init?.method === 'POST') {
        const data = JSON.parse(String(init.body));
        posts++;
        if (existing) {
          expect(path).toBe('/repos/test/repo/issues/61/comments');
          notes.push({ id: 500, body: data.body, user: { id: 7, login: 'fixture' } });
        } else {
          expect(path).toBe('/repos/test/repo/issues');
          issue.body = data.body;
        }
        if (lost) {
          lost = false;
          return new Response('upstream error', { status: 502 });
        }
        throw Error('duplicate write');
      }
      if (path.endsWith('/comments')) return Response.json(notes);
      if (path.endsWith('/issues/61')) return Response.json(issue);
      if (path === '/repos/test/repo/issues') return Response.json([issue]);
      throw Error('Unexpected request');
    });
    vi.spyOn(f.tickets.reader, 'github').mockReturnValue(http);
    try {
      const group = f.daddy.create({
        workspaceId: f.workspace.id,
        message: 'Discuss search and assign work.',
      });
      const job = f.store.daddyJobs(group.id)[0],
        signal = new AbortController().signal;
      const input = {
        title,
        requirements: 'Keep old filters',
        architecturePlan: plan,
        ...(existing && { source: url }),
        validatePlan: existing,
      };
      await expect(f.daddy.call(job, 'create_task', input, 'create', signal)).rejects.toThrow(
        '502',
      );
      expect(f.store.tasks(group.id)).toHaveLength(0);
      const created = (await f.daddy.call(job, 'create_task', input, 'create', signal)) as {
        taskId: string;
        source: string;
      };
      expect(created.source).toBe(url);
      expect(posts).toBe(1);
      if (existing) {
        expect(issue.body).toBe(initialBody);
        expect(notes[0].body).toContain(plan);
      } else expect(issue.body).toContain(plan);
      expect(f.store.jobs(created.taskId)).toHaveLength(0);
      await f.daddy.call(job, 'dispatch', { taskId: created.taskId }, 'dispatch', signal);
      expect(f.store.jobs(created.taskId).map((j) => j.kind)).toEqual([
        existing ? 'plan' : 'implement',
      ]);
      expect(f.store.getTask(created.taskId).requirements).toContain(plan);
    } finally {
      await f.close();
    }
  },
);

it('revalidates the plan if preparing the implementation reveals a different checkout revision', async () => {
  const f = daddyFixture();
  try {
    const group = f.daddy.create({ workspaceId: f.workspace.id });
    const t = await f.daddy.createTask(group.id, {
      requirements: 'Keep the index consistent.',
      requestId: 'changed-head',
    });
    await f.worker.tick();
    await vi.waitFor(() => expect(f.store.activeJobs(t.id)).toMatchObject([{ kind: 'implement' }]));
    const changed = 'e'.repeat(40);
    vi.mocked(f.checkouts.prepareTicket).mockImplementationOnce(async (task) => {
      task.revision = { ...task.revision!, head: changed };
      return f.dir;
    });
    await f.worker.tick();
    await vi.waitFor(() =>
      expect(f.store.activeJobs(t.id)).toMatchObject([{ kind: 'plan', status: 'queued' }]),
    );
    expect(f.agentRuntime.run.mock.calls.map(([input]) => input.job.kind)).toEqual(['plan']);
    expect(f.checkouts.commitTicket).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

it('resolves planning profiles independently from slot selection, queued updates and paused work', async () => {
  const f = daddyFixture();
  const developer = { ...profiles.worker, effort: 'medium' };
  const architect = { ...profiles.daddy, effort: 'medium' };
  const override = { engine: 'claude', model: 'test-architect' };
  try {
    const group = f.daddy.create({ workspaceId: f.workspace.id });
    await f.daddy.configureWorker(group.id, 1, developer);
    const first = await f.daddy.createTask(group.id, {
      requirements: 'Implement the filter.',
      requestId: 'inherit',
    });
    const other = await f.daddy.createTask(group.id, {
      requirements: 'Implement a library.',
      requestId: 'override',
      architectProfile: override,
    });
    const profile = (id: string) => f.store.activeJobs(id).find((j) => j.kind === 'plan')?.profile;
    expect(profile(first.id)).toEqual(profiles.daddy);
    await f.daddy.settings(group.id, { architectProfile: architect });
    expect(profile(first.id)).toEqual(architect);
    expect(profile(other.id)).toEqual(override);
    await f.daddy.settings(group.id, { profiles: { worker: developer }, applyWorkers: true });
    expect(profile(first.id)).toEqual(architect);
    await f.daddy.pause(group.id);
    await f.daddy.settings(group.id, { architectProfile: null, profiles: { daddy: override } });
    await f.daddy.taskArchitect(group.id, other.id, architect);
    await f.daddy.resume(group.id);
    expect(profile(first.id)).toEqual(override);
    expect(profile(other.id)).toEqual(architect);
    await f.daddy.taskArchitect(group.id, other.id, null);
    expect(profile(other.id)).toEqual(override);
    await f.worker.tick();
    await vi.waitFor(() =>
      expect(f.store.activeJobs(first.id)).toMatchObject([
        { kind: 'implement', profile: developer },
      ]),
    );
    expect(f.agentRuntime.run.mock.calls[0][0].job.profile).toEqual(override);
    expect(f.store.getTask(first.id).authorThreadId).toBeUndefined();
  } finally {
    await f.close();
  }
});

it('uses the architect engine independently in a Telegram queue request', () => {
  expect(
    parseTaskInput(
      '--model dev --architect-model design --architect-effort high -- Fix search',
      'claude',
      'codex',
    ),
  ).toMatchObject({
    workerRequest: { profile: { engine: 'claude', model: 'dev' } },
    architectProfile: { engine: 'codex', model: 'design', effort: 'high' },
  });
  expect(parseTaskInput('--architect-effort high -- Fix search', 'codex')).toBeUndefined();
  expect(
    parseTaskInput('--no-plan --architect-model design -- Fix search', 'codex'),
  ).toBeUndefined();
});
