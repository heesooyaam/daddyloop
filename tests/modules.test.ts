import { it, expect, vi } from 'vitest';
import { AgentRegistry, sessionHandle } from '../src/modules/agents/registry.js';
import { RepositoryRegistry } from '../src/modules/repositories/registry.js';
import { githubModule } from '../src/modules/repositories/github.js';
import { gitlabModule } from '../src/modules/repositories/gitlab.js';
import { agentFactories } from '../src/modules/agents/index.js';
import { repositoryModules } from '../src/modules/repositories/index.js';
import { moduleCatalogue } from '../src/modules/catalogue.js';
import type { AgentModule } from '../src/modules/contracts.js';
import type { SessionInput, AgentInput } from '../src/runtime/agent.js';
import { daddyFixture } from './daddy-fixture.js';
import { TicketReader } from '../src/modules/repositories/tickets.js';
import { TicketWorkflow } from '../src/core/ticket-workflow.js';
import { RunProcesses } from '../src/runtime/run-processes.js';
const result = { status: 'completed' as const, summary: 'Checked.', checkedHead: '' };
function module(id: string): AgentModule {
  return {
    id,
    name: id,
    catalogue: {
      list: async () => [
        {
          engine: id,
          id: 'same-model',
          name: 'Same model',
          efforts: ['deep'],
          defaultEffort: 'deep',
          isDefault: true,
        },
      ],
      validate: async () => {},
    },
    runtime: {
      run: vi.fn(async (input: AgentInput) => {
        input.onSession('task-context');
        return result;
      }),
      runSession: vi.fn(async (input: SessionInput) => {
        input.onSession('native-context');
        await input.onTool('read_task', { id: 1 }, 'call-1');
        return result;
      }),
    },
  };
}
const session = (engine: string): SessionInput => ({
  cwd: '/fixture',
  prompt: 'Do the job',
  instructions: 'Stay scoped',
  profile: { engine, model: 'same-model', effort: 'deep' },
  readOnly: true,
  signal: new AbortController().signal,
  onSession: vi.fn(),
  onEvent: vi.fn(),
  onTool: vi.fn(async () => ({ ok: true })),
});
it('dispatches through engine modules without interpreting identical model names', async () => {
  const first = module('first'),
    second = module('second'),
    registry = new AgentRegistry([first, second]);
  const input = session('second');
  await registry.runSession(input);
  expect(first.runtime.runSession).not.toHaveBeenCalled();
  expect(second.runtime.runSession).toHaveBeenCalledOnce();
  expect(input.onTool).toHaveBeenCalledWith('read_task', { id: 1 }, 'call-1');
  expect(input.onSession).toHaveBeenCalledWith('second:native-context', undefined);
  const next = { ...input, threadId: sessionHandle('second', 'native-context') };
  await registry.runSession(next);
  expect(second.runtime.runSession).toHaveBeenLastCalledWith(
    expect.objectContaining({ threadId: 'native-context', profile: input.profile }),
  );
  expect((await registry.list()).map((model) => model.engine)).toEqual(['first', 'second']);
  expect(() => registry.runSession({ ...input, threadId: 'first:native-context' })).toThrow(
    'changing its engine',
  );
});
it('rejects disabled engines and cancelled turns before invoking any runtime', async () => {
  const available = module('available'),
    registry = new AgentRegistry([available]);
  expect(() => registry.runSession(session('missing'))).toThrow('not enabled');
  const input = session('available'),
    abort = new AbortController();
  abort.abort();
  expect(() => registry.runSession({ ...input, signal: abort.signal })).toThrow();
  expect(available.runtime.runSession).not.toHaveBeenCalled();
});

it('gives a third-party engine the common process scope and closes ownership before returning', async () => {
  const f = daddyFixture(),
    adapter = module('third'),
    processes = new RunProcesses(f.store, f.dir);
  const registry = new AgentRegistry([adapter], 'host', processes);
  try {
    expect(() => registry.runSession(session('third'))).toThrow('run owner');
    const owner = {
      runId: 'scope-fixture-run',
      groupId: 'scope-fixture-group',
      kind: 'daddy' as const,
    };
    vi.mocked(adapter.runtime.runSession).mockImplementation(async (input) => {
      expect(input.processScope?.env.DADDYLOOP_RUN_SCOPE).toMatch(/^[a-f0-9-]{36}$/);
      expect(input.processScope?.env.DADDYLOOP_RUN_CACHE).toBe(input.processScope?.cacheDir);
      expect(processes.inspect(owner.groupId)).toMatchObject([
        { runId: owner.runId, active: true },
      ]);
      return result;
    });
    expect(await registry.runSession({ ...session('third'), owner, cwd: f.dir })).toEqual(result);
    expect(processes.inspect(owner.groupId)).toEqual([]);
  } finally {
    await f.close();
  }
});
it('keeps repository parsing and matching inside registered modules', () => {
  const custom = {
    ...githubModule,
    id: 'mirror',
    name: 'Mirror',
    matchesRepository: () => 20,
    parsePR: (url: URL) => ({
      provider: 'mirror',
      host: url.hostname,
      repo: 'team/repo',
      number: 9,
      url: url.href,
    }),
  };
  const registry = new RepositoryRegistry([githubModule, custom]);
  expect(registry.forRepository({ vcs: 'git', host: 'mirror.test', remotes: ['origin'] }).id).toBe(
    'mirror',
  );
  expect(registry.parse(new URL('https://mirror.test/change/9'), 'mirror').provider).toBe('mirror');
  expect(() => registry.get('gitlab')).toThrow('not enabled');
});
it('blocks ticket network access when its repository module is not enabled', async () => {
  const f = daddyFixture(),
    reader = new TicketReader(),
    read = vi.spyOn(reader, 'read');
  const workflow = new TicketWorkflow(
    f.engine,
    f.checkouts,
    reader,
    undefined,
    new RepositoryRegistry([gitlabModule]),
  );
  try {
    await expect(
      workflow.start({ source: 'https://github.com/test/repo/issues/42', repoPath: f.dir }),
    ).rejects.toThrow('enabled repository module');
    expect(read).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});
it('keeps installer IDs aligned with the runtime and repository registrations', () => {
  expect(
    moduleCatalogue
      .filter((module) => module.kind === 'agent')
      .map((module) => module.id)
      .sort(),
  ).toEqual(agentFactories.map((module) => module.id).sort());
  expect(
    moduleCatalogue
      .filter((module) => module.kind === 'repository')
      .map((module) => module.id)
      .sort(),
  ).toEqual(
    repositoryModules()
      .map((module) => module.id)
      .sort(),
  );
});
it('keeps a healthy engine catalogue usable when another enabled engine is offline', async () => {
  const broken = module('broken'),
    healthy = module('healthy');
  broken.catalogue.list = async () => {
    throw new Error('CLI offline');
  };
  const registry = new AgentRegistry([broken, healthy]);
  expect((await registry.list()).map((model) => model.engine)).toEqual(['healthy']);
  expect(
    registry.metadata().modules?.find((module) => module.engine === 'broken')?.error,
  ).toContain('CLI offline');
});

it('selects a task thread for the current engine and keeps the reviewer independent', async () => {
  const first = module('first'),
    second = module('second'),
    router = new AgentRegistry([first, second]);
  const f = daddyFixture();
  try {
    const group = f.daddy.create({ workspaceId: f.workspace.id });
    const task = await f.daddy.createTask(group.id, {
      requirements: 'Keep existing filters',
      requestId: 'threads',
    });
    task.authorThreadId = sessionHandle('first', 'development');
    task.planning = { threadId: sessionHandle('second', 'architecture'), sharedThread: true };
    task.reviewerThreadId = sessionHandle('first', 'review');
    const plan = f.store.jobs(task.id)[0];
    const run = (kind: 'plan' | 'implement', engine: string) =>
      router.run({
        task,
        job: { ...plan, kind, profile: { engine, model: 'same-model' } },
        cwd: f.dir,
        prompt: 'Check the plan',
        signal: new AbortController().signal,
        onSession: () => {},
        onEvent: () => {},
        onTool: async () => ({}),
      });
    await run('plan', 'second');
    expect(vi.mocked(second.runtime.run).mock.calls.at(-1)?.[0].task.planning?.threadId).toBe(
      'architecture',
    );
    await run('implement', 'first');
    expect(vi.mocked(first.runtime.run).mock.calls.at(-1)?.[0].task.authorThreadId).toBe(
      'development',
    );
    await run('plan', 'first');
    expect(vi.mocked(first.runtime.run).mock.calls.at(-1)?.[0].task.planning?.threadId).toBe(
      'development',
    );
    task.authorThreadId = undefined;
    await run('implement', 'first');
    expect(vi.mocked(first.runtime.run).mock.calls.at(-1)?.[0].task.authorThreadId).toBeUndefined();
    await run('implement', 'second');
    expect(vi.mocked(second.runtime.run).mock.calls.at(-1)?.[0].task.authorThreadId).toBe(
      'architecture',
    );
    expect(task.reviewerThreadId).toBe('first:review');
  } finally {
    await f.close();
  }
});
