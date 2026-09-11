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
