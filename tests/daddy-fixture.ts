import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { vi } from 'vitest';
import { Store } from '../src/core/store.js';
import { Engine } from '../src/core/engine.js';
import { Projects } from '../src/core/projects.js';
import { Daddy } from '../src/core/daddy.js';
import { TicketWorkflow } from '../src/core/ticket-workflow.js';
import { Workspaces } from '../src/runtime/workspaces.js';
import { Worker } from '../src/runtime/worker.js';
import { DemoProvider } from '../src/providers/demo.js';
import type { AgentInput, SessionInput } from '../src/runtime/agent.js';
import type { AgentResult, Project, Task } from '../src/core/types.js';
import { healthy, catalogue, profiles } from './planning-fixture.js';
export function daddyFixture(persist = false) {
  const dir = mkdtempSync(join(tmpdir(), 'daddyloop-test-')),
    store = new Store(persist ? join(dir, 'state.sqlite') : ':memory:');
  const engine = new Engine(store, () => new DemoProvider(store), profiles),
    projects = new Projects(store, [dir]);
  const project: Project = {
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
  store.saveProject(project);
  const workspaces = new Workspaces(dir);
  vi.spyOn(workspaces, 'describeTicket').mockImplementation(async (path, ref) => ({
    repoPath: path,
    ref,
    repository: {
      baseHead: 'a'.repeat(40),
      baseBranch: 'main',
      branch: '',
      cloneUrl: 'https://github.com/test/repo.git',
    },
  }));
  vi.spyOn(workspaces, 'prepareTicket').mockResolvedValue(dir);
  vi.spyOn(workspaces, 'commitTicket').mockResolvedValue('b'.repeat(40));
  const tickets = new TicketWorkflow(engine, workspaces);
  const writer = {
    run: vi.fn(async (input: AgentInput): Promise<AgentResult> => {
      input.onSession(`writer-${input.task.id}`);
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
  const worker = new Worker(engine, workspaces, writer, writer, healthy, 30000, 1);
  const context = {
    prepare: vi.fn(async () => ({ cwd: dir, context: {} as Task })),
    release: vi.fn(async () => {}),
  };
  const daddy = new Daddy(engine, projects, tickets, worker, runtime, healthy, catalogue, context);
  return {
    dir,
    store,
    engine,
    projects,
    project,
    workspaces,
    tickets,
    writer,
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
