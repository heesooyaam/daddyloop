import { AppError } from '../src/core/types.js';
import { it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  TicketReader,
  parseTicket,
  parseTrackerJson,
} from '../src/modules/repositories/tickets.js';
import { Store } from '../src/core/store.js';
import { Engine } from '../src/core/engine.js';
import { DemoProvider } from '../src/providers/demo.js';
import { Workspaces, git } from '../src/runtime/workspaces.js';
import { TicketWorkflow } from '../src/core/ticket-workflow.js';
import { ticketInput } from './planning-fixture.js';
const response = (value: unknown) => new Response(JSON.stringify(value));
it('canonicalizes ticket links and rejects unsafe or invalid addresses', () => {
  expect(parseTicket('https://github.com/Test/Repo/issues/42#comment').url).toBe(
    ticketInput().source.url,
  );
  expect(parseTicket('QUEUE-123').kind).toBe('tracker');
  for (const value of [
    'no ticket',
    'http://github.com/test/repo/issues/1',
    'https://user:pass@github.com/test/repo/issues/1',
    'https://evil.example/test/repo/issues/1',
    'https://github.com/test/repo/pull/1',
    'QUEUE-999999999999999999999',
  ])
    expect(() => parseTicket(value)).toThrow();
});
it('imports exact Markdown and comments read-only, keeping credentials scoped to their host', async () => {
  const requests: { url: string; options?: RequestInit }[] = [];
  const markdown = 'A description\n\n```ts\nreturn 42;\n```\n';
  const reader = new TicketReader(
    async (url, options) => {
      requests.push({ url: String(url), options });
      if (String(url).includes('/comments'))
        return response(
          String(url).includes('st-api')
            ? [{ id: 2, text: markdown, createdBy: { id: 'alice' } }]
            : [{ id: 1, body: markdown, user: { login: 'alice' } }],
        );
      return response(
        String(url).includes('st-api')
          ? { summary: 'Ticket', description: markdown }
          : { title: 'Issue', body: markdown, state: 'open' },
      );
    },
    () => 'tracker-fixture',
    () => 'github-fixture',
  );
  for (const url of [ticketInput().source.url, 'QUEUE-123']) {
    const result = await reader.read(url);
    expect(result.source.body).toBe(markdown);
    expect(result.source.comments?.[0].body).toBe(markdown);
  }
  expect(requests).toHaveLength(4);
  for (const request of requests) {
    expect(request.options?.method ?? 'GET').toBe('GET');
    expect(request.options?.redirect).toBe('error');
    expect(new Headers(request.options?.headers).get('authorization')).toBe(
      request.url.includes('st-api') ? 'OAuth tracker-fixture' : 'Bearer github-fixture',
    );
  }
  expect(parseTrackerJson('{"description":"hello\nworld"}')).toEqual({
    description: 'hello\nworld',
  });
});
it('does not mistake pull requests for issues or silently truncate huge comments', async () => {
  const reader = new TicketReader(
    async () => response({ pull_request: {} }),
    () => '',
    () => '',
  );
  await expect(reader.read(ticketInput().source.url)).rejects.toThrow('Attach PR');
  const large = new TicketReader(
    async (url) =>
      response(
        String(url).includes('comments')
          ? [{ id: 1, body: 'x'.repeat(260000) }]
          : { title: 'Large', body: '' },
      ),
    () => '',
    () => '',
  );
  await expect(large.read(ticketInput().source.url)).rejects.toThrow('context limit');
});
it('preserves dirty source files, commits only the isolated author and verifies ownership before push', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'daddyloop-ticket-test-')),
    store = new Store(':memory:');
  try {
    const repo = join(dir, 'source');
    mkdirSync(repo);
    await git(['init'], repo);
    await git(['symbolic-ref', 'HEAD', 'refs/heads/main'], repo);
    writeFileSync(join(repo, 'code.txt'), 'base\n');
    await git(['add', '.'], repo);
    await git(
      ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-m', 'Base'],
      repo,
    );
    await git(['remote', 'add', 'origin', 'git@github.com:test/repo.git'], repo);
    writeFileSync(join(repo, 'code.txt'), 'user edit\n');
    writeFileSync(join(repo, 'private.txt'), 'user notes');
    const engine = new Engine(store, () => new DemoProvider(store)),
      ws = new Workspaces(join(dir, 'state'));
    const described = await ws.describeTicket(repo, ticketInput().ref);
    const task = await engine.createTicket({ ...ticketInput(), ...described });
    const author = await ws.prepareTicket(task, 'author');
    expect(readFileSync(join(author, 'code.txt'), 'utf8')).toBe('base\n');
    writeFileSync(join(author, 'code.txt'), 'implementation\n');
    const head = await ws.commitTicket(task, 'Implement');
    task.pendingAuthorHead = head;
    expect(head).not.toBe(described.repository.baseHead);
    const localRemote = join(dir, 'remote.git');
    await git(['init', '--bare', localRemote], dir);
    task.ticketRepository!.cloneUrl = localRemote;
    vi.spyOn(ws as unknown as { env: () => Record<string, string> }, 'env').mockReturnValue({});
    await ws.pushTicket(task);
    expect(
      await git(
        ['--git-dir', localRemote, 'rev-parse', `refs/heads/${task.ticketRepository!.branch}`],
        dir,
      ),
    ).toBe(head);
    await git(['checkout', '-b', 'unexpected'], author);
    await expect(ws.pushTicket(task)).rejects.toThrow('branch changed');
    expect(readFileSync(join(repo, 'code.txt'), 'utf8')).toBe('user edit\n');
    expect(readFileSync(join(repo, 'private.txt'), 'utf8')).toBe('user notes');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
it('recovers a lost PR-create response once, verifies the owner and binds the exact submitted head', async () => {
  const store = new Store(':memory:'),
    provider = new DemoProvider(store),
    engine = new Engine(store, () => provider),
    ws = new Workspaces('/tmp');
  const task = await engine.createTicket(ticketInput());
  for (const job of store.jobs()) {
    job.status = 'completed';
    store.saveJob(job);
  }
  task.pendingAuthorHead = 'b'.repeat(40);
  task.state = 'ready_for_review';
  store.saveTask(task);
  let writes = 0,
    correctOwner = false,
    draft: boolean | undefined;
  const reader = new TicketReader(
    async (url, options) => {
      if (String(url).endsWith('/user')) return response({ id: 7 });
      if (options?.method === 'POST') {
        writes++;
        draft = JSON.parse(String(options.body)).draft;
        throw new Error('Lost response after creation');
      }
      return response([
        {
          number: 20,
          html_url: 'https://github.com/test/repo/pull/20',
          body: `<!-- daddyloop:ticket:${task.id} -->`,
          user: { id: correctOwner ? 7 : 8 },
          head: { ref: task.ticketRepository!.branch, repo: { full_name: 'test/repo' } },
        },
      ]);
    },
    () => '',
    () => 'test-token',
  );
  vi.spyOn(ws, 'pushTicket').mockResolvedValue(undefined);
  vi.spyOn(provider, 'getPR').mockResolvedValue({
    ...(await provider.getPR({ ...task.ref, kind: undefined })),
    branch: task.ticketRepository!.branch,
    targetBranch: task.ticketRepository!.baseBranch,
    head: task.pendingAuthorHead,
  });
  const workflow = new TicketWorkflow(engine, ws, reader);
  try {
    await expect(workflow.submit(task.id)).rejects.toThrow('Lost response');
    await expect(engine.implement(task.id)).rejects.toThrow('Reconcile');
    await expect(workflow.submit(task.id)).rejects.toThrow('uncertain');
    correctOwner = true;
    const linked = await workflow.submit(task.id);
    expect(linked.ref.number).toBe(20);
    expect(linked.state).toBe('queued');
    expect(linked.revision?.head).toBe(task.pendingAuthorHead);
    expect(writes).toBe(1);
    expect(draft).toBe(false);
  } finally {
    store.close();
  }
});

it('looks up an uncertain GitHub create on the retry queue without sending a second POST', async () => {
  const store = new Store(':memory:'),
    provider = new DemoProvider(store),
    engine = new Engine(store, () => provider),
    ws = new Workspaces('/tmp');
  try {
    const task = await engine.createTicket(ticketInput());
    store.cancelJobs(task.id);
    task.pendingAuthorHead = 'e'.repeat(40);
    task.state = 'ready_for_review';
    store.saveTask(task);
    let visible = false,
      creates = 0;
    const reader = new TicketReader(
      async (url, opts) => {
        if (String(url).endsWith('/user')) return response({ id: 7 });
        if (opts?.method === 'POST') {
          creates++;
          return new Response('unavailable', { status: 503 });
        }
        return response(
          visible
            ? [
                {
                  number: 20,
                  html_url: 'https://github.com/test/repo/pull/20',
                  user: { id: 7 },
                  head: { ref: task.ticketRepository!.branch, repo: { full_name: task.ref.repo } },
                  body: '<!-- daddyloop:ticket:' + task.id + ' -->',
                },
              ]
            : [],
        );
      },
      () => '',
      () => 'token',
    );
    const native = await provider.getPR({ ...task.ref, kind: undefined });
    vi.spyOn(provider, 'getPR').mockResolvedValue({
      ...native,
      head: task.pendingAuthorHead,
      branch: task.ticketRepository!.branch,
      targetBranch: task.ticketRepository!.baseBranch,
    });
    const push = vi.spyOn(ws, 'pushTicket').mockResolvedValue(undefined),
      flow = new TicketWorkflow(engine, ws, reader);
    await expect(flow.submit(task.id)).rejects.toMatchObject({ code: 'provider_503' });
    const expire = () => {
      const t = store.getTask(task.id);
      expect(t.state).toBe('submitting');
      t.prLink!.retryAt = 0;
      store.saveTask(t);
    };
    expire();
    await expect(flow.submit(task.id, undefined, true)).rejects.toMatchObject({
      code: 'ambiguous_write',
    });
    visible = true;
    expire();
    expect((await flow.submit(task.id, undefined, true)).ref.number).toBe(20);
    expect(creates).toBe(1);
    expect(push).toHaveBeenCalledOnce();
  } finally {
    store.close();
  }
});
it('runs ticket discussion, isolated implementation, PR creation and automatic review to completion', async () => {
  const { Worker } = await import('../src/runtime/worker.js');
  const { healthy } = await import('./planning-fixture.js');
  const dir = mkdtempSync(join(tmpdir(), 'daddyloop-ticket-cycle-')),
    store = new Store(':memory:');
  const provider = new DemoProvider(store),
    engine = new Engine(store, () => provider),
    ws = new Workspaces(join(dir, 'state'));
  let worker: InstanceType<typeof Worker> | undefined;
  try {
    const repo = join(dir, 'source');
    mkdirSync(repo);
    await git(['init'], repo);
    await git(['symbolic-ref', 'HEAD', 'refs/heads/main'], repo);
    writeFileSync(join(repo, 'code.txt'), 'base\n');
    await git(['add', '.'], repo);
    await git(
      ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-m', 'Base'],
      repo,
    );
    await git(['remote', 'add', 'origin', 'git@github.com:test/repo.git'], repo);
    const base = await git(['rev-parse', 'HEAD'], repo),
      input = ticketInput();
    const task = await engine.createTicket({
      ...input,
      ...(await ws.describeTicket(repo, input.ref)),
    });
    const native = await provider.getPR({ ...input.ref, kind: undefined });
    vi.spyOn(provider, 'getPR').mockImplementation(async () => ({
      ...native,
      branch: task.ticketRepository!.branch,
      targetBranch: task.ticketRepository!.baseBranch,
      head: store.getTask(task.id).pendingAuthorHead ?? base,
      base,
      start: base,
      checks: 'passing',
    }));
    vi.spyOn(ws, 'pushTicket').mockResolvedValue(undefined);
    const reader = new TicketReader(
      async (_url, options) =>
        response(
          options?.method === 'POST'
            ? { number: 77, html_url: 'https://github.com/test/repo/pull/77' }
            : { id: 7 },
        ),
      () => '',
      () => 'fixture',
    );
    const workflow = new TicketWorkflow(engine, ws, reader);
    const runtime = {
      run: vi.fn(async (input: import('../src/runtime/agent.js').AgentInput) => {
        input.onSession(`${input.job.role}-${task.id}`);
        if (input.job.kind === 'implement')
          writeFileSync(join(input.cwd, 'code.txt'), 'implemented\n');
        if (input.job.kind === 'review')
          await input.onTool('set_summary', {
            body: 'Inspected the complete diff and checked the fixture. No findings.',
          });
        return {
          status: 'completed' as const,
          summary: 'Completed current work',
          checkedHead: input.task.revision!.head,
        };
      }),
    };
    worker = new Worker(engine, ws, runtime, runtime, healthy, 0);
    worker.autoSubmit = (id) => workflow.submit(id);
    const turn = async () => {
      await worker!.tick();
      await vi.waitFor(() =>
        expect(store.jobs().some((job) => job.status === 'running')).toBe(false),
      );
    };
    await turn();
    expect(store.getTask(task.id).state).toBe('discussing');
    await engine.implement(task.id);
    await turn();
    expect(store.getTask(task.id).state).toBe('ready_for_review');
    await turn();
    await vi.waitFor(() => expect(store.getTask(task.id).ref.kind).not.toBe('ticket'));
    await turn();
    await turn();
    expect(store.getTask(task.id).state).toBe('complete');
    expect(store.getTask(task.id).ref.url).toContain('/pull/77');
    expect(store.getTask(task.id).snapshot?.status).toBe('published');
    expect(runtime.run.mock.calls.map(([input]) => input.job.kind)).toEqual([
      'chat',
      'implement',
      'review',
    ]);
    expect(readFileSync(join(repo, 'code.txt'), 'utf8')).toBe('base\n');
  } finally {
    await worker?.stop();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it('follows Tracker comment ID cursors and rejects repeated pages', async () => {
  const paths: string[] = [];
  const reader = new TicketReader(
    async (url) => {
      const address = new URL(String(url));
      paths.push(address.pathname + address.search);
      return response(
        !address.pathname.endsWith('/comments')
          ? { summary: 'Ticket' }
          : address.searchParams.get('id') === '100'
            ? [{ id: '101', text: 'Last comment' }]
            : Array.from({ length: 100 }, (_, i) => ({ id: String(i + 1), text: 'Comment' })),
      );
    },
    () => 'fixture',
    () => '',
  );
  const result = await reader.read('QUEUE-123');
  expect(result.source.comments).toHaveLength(101);
  expect(paths.at(-1)).toBe('/v3/issues/QUEUE-123/comments?perPage=100&id=100');
  const repeated = new TicketReader(
    async (url) =>
      response(
        String(url).includes('/comments')
          ? Array.from({ length: 100 }, (_, i) => ({ id: String(i + 1) }))
          : { summary: 'Ticket' },
      ),
    () => 'fixture',
    () => '',
  );
  await expect(repeated.read('QUEUE-123')).rejects.toThrow('did not advance');
});

it('retries a confirmed PR link after a temporary CI read failure, without pushing or creating twice', async () => {
  const store = new Store(':memory:'),
    provider = new DemoProvider(store),
    engine = new Engine(store, () => provider),
    ws = new Workspaces('/tmp');
  try {
    const task = await engine.createTicket(ticketInput());
    store.cancelJobs(task.id);
    task.state = 'ready_for_review';
    task.pendingAuthorHead = 'e'.repeat(40);
    store.saveTask(task);
    let creates = 0;
    const reader = new TicketReader(
      async (url, opts) => {
        if (String(url).endsWith('/user')) return response({ id: 7 });
        if (opts?.method === 'POST') {
          creates++;
          return response({ number: 19, html_url: 'https://github.com/test/repo/pull/19' });
        }
        throw Error('Unexpected request');
      },
      () => '',
      () => 'token',
    );
    const push = vi.spyOn(ws, 'pushTicket').mockResolvedValue(undefined);
    const ref = { ...task.ref, kind: undefined };
    const native = await provider.getPR(ref);
    const get = vi
      .spyOn(provider, 'getPR')
      .mockRejectedValueOnce(new AppError('provider_500', 'GET check-runs: HTTP 500', 502))
      .mockResolvedValue({
        ...native,
        head: task.pendingAuthorHead,
        branch: task.ticketRepository!.branch,
        targetBranch: task.ticketRepository!.baseBranch,
      });
    const workflow = new TicketWorkflow(engine, ws, reader);
    await expect(workflow.submit(task.id)).rejects.toMatchObject({ code: 'provider_500' });
    const saved = store.getTask(task.id);
    expect(saved).toMatchObject({
      state: 'submitting',
      prLink: { ref: { number: 19 }, head: task.pendingAuthorHead },
    });
    engine.recoverInterruptedJobs();
    await workflow.submit(task.id, undefined, true);
    expect(get).toHaveBeenCalledTimes(1);
    saved.prLink!.retryAt = Date.now() - 1;
    store.saveTask(saved);
    await workflow.submit(task.id, undefined, true);
    expect(store.getTask(task.id)).toMatchObject({ state: 'queued', ref: { number: 19 } });
    expect(store.getTask(task.id).prLink).toBeUndefined();
    expect(creates).toBe(1);
    expect(push).toHaveBeenCalledOnce();
  } finally {
    store.close();
  }
});
