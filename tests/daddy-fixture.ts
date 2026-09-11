import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { vi } from 'vitest';
import { Store } from '../src/core/store.js';
import { Engine } from '../src/core/engine.js';
import { WorkspaceRegistry } from '../src/core/workspace-registry.js';
import { Daddy } from '../src/core/daddy.js';
import { TicketWorkflow } from '../src/core/ticket-workflow.js';
import { Workspaces } from '../src/runtime/workspaces.js';
import { Worker } from '../src/runtime/worker.js';
import { DemoProvider } from '../src/providers/demo.js';
import type { AgentInput, SessionInput } from '../src/runtime/agent.js';
import type { AgentResult, Workspace, Task } from '../src/core/types.js';
import { healthy, catalogue, profiles } from './planning-fixture.js';
export function daddyFixture(persist = false) {
  const dir = mkdtempSync(join(tmpdir(), 'daddyloop-test-')),
    store = new Store(persist ? join(dir, 'state.sqlite') : ':memory:');
  const engine = new Engine(store, () => new DemoProvider(store), profiles),
    workspaces = new WorkspaceRegistry(store, [dir]);
  const workspace: Workspace = {
    id: randomUUID(),
    name: 'Fixture',
    repoPath: dir,
    scope: '',
    vcs: 'git',
    provider: 'github',
    host: 'github.com',
    repo: 'test/repo',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  store.saveWorkspace(workspace);
  const checkouts = new Workspaces(dir);
  vi.spyOn(checkouts, 'describeTicket').mockImplementation(async (path, ref) => ({
    repoPath: path,
    ref,
    repository: {
      baseHead: 'a'.repeat(40),
      baseBranch: 'main',
      branch: '',
      cloneUrl: 'https://github.com/test/repo.git',
    },
  }));
  vi.spyOn(checkouts, 'prepareTicket').mockResolvedValue(dir);
  vi.spyOn(checkouts, 'commitTicket').mockResolvedValue('b'.repeat(40));
  const tickets = new TicketWorkflow(engine, checkouts);
  const agentRuntime = {
    run: vi.fn(async (input: AgentInput): Promise<AgentResult> => {
      input.onSession(`agentRuntime-${input.task.id}`);
      return {
        status: 'completed',
        summary: 'Implemented and verified.',
        checkedHead: input.task.revision!.head,
      };
    }),
  };
  const runtime = {
    runSession: vi.fn(async (input: SessionInput): Promise<AgentResult> => {
      input.onSession('daddy-thread');
      return { status: 'completed', summary: 'Ready.', checkedHead: '' };
    }),
  };
  const worker = new Worker(engine, checkouts, agentRuntime, agentRuntime, healthy, 30000, 1);
  const context = {
    prepare: vi.fn(async () => ({ cwd: dir, context: {} as Task })),
    release: vi.fn(async () => {}),
  };
  const daddy = new Daddy(
    engine,
    workspaces,
    tickets,
    worker,
    runtime,
    healthy,
    catalogue,
    context,
  );
  return {
    dir,
    store,
    engine,
    workspaces,
    workspace,
    checkouts,
    tickets,
    agentRuntime,
    runtime,
    worker,
    daddy,
    context,
    async close() {
      await daddy.stop();
      await worker.stop();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
