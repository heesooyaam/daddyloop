import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { Engine } from '../src/core/engine.js';
import { Store } from '../src/core/store.js';
import { GitHubProvider } from '../src/providers/github.js';
import { parsePR } from '../src/providers/provider.js';
import { DemoRuntime } from '../src/runtime/demo.js';
import { Worker } from '../src/runtime/worker.js';
import { Workspaces } from '../src/runtime/workspaces.js';

const ref = parsePR('https://github.com/acme/service/pull/38');
const revision = { head: 'a'.repeat(40), base: 'b'.repeat(40), start: 'c'.repeat(40) };

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'daddy-draft-'));
  const file = join(dir, 'state.sqlite');
  let store = new Store(file);
  const pr = {
    ...revision,
    ...ref,
    title: 'Draft recovery',
    body: '',
    state: 'open' as const,
    draft: false,
    branch: 'feature',
    targetBranch: 'main',
    cloneUrl: 'https://github.com/acme/service.git',
    checkDetails: [],
    checks: 'missing' as const,
  };
  const gitHub = {
    reviews: [] as unknown[],
    draft: undefined as unknown,
    listStatus: 200,
    createStatus: 502,
    account: 7,
    paginate: false,
    rejectOccupiedSlot: false,
  };
  const transport = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const { pathname: path, searchParams } = new URL(String(url));
    if (path === '/user') return Response.json({ id: gitHub.account });
    if (path.endsWith('/reviews/6060947228/comments')) return Response.json([]);
    if (path.endsWith('/reviews/6060947228')) return Response.json(gitHub.draft);
    expect(path).toBe('/repos/acme/service/pulls/38/reviews');
    if (init?.method === 'GET') {
      const reviews =
        gitHub.paginate && searchParams.get('page') === '1'
          ? Array.from({ length: 100 }, (_, id) => ({ id, user: { id: 8 }, state: 'COMMENTED' }))
          : gitHub.reviews;
      return Response.json(reviews, { status: gitHub.listStatus });
    }
    expect(init?.method).toBe('POST');
    const body = JSON.parse(String(init?.body));
    if (gitHub.rejectOccupiedSlot && gitHub.draft)
      return Response.json(
        { message: 'User can only have one pending review per pull request' },
        { status: 422 },
      );
    gitHub.draft = {
      id: 6060947228,
      node_id: 'draft',
      body: body.body,
      state: 'PENDING',
      commit_id: body.commit_id,
      user: { id: gitHub.account },
    };
    if (gitHub.createStatus === 429)
      return Response.json({}, { status: 429, headers: { 'Retry-After': '1' } });
    return Response.json(gitHub.draft, { status: gitHub.createStatus });
  });
  const connect = () => {
    const provider = new GitHubProvider(ref.host, 'offline', transport, store);
    vi.spyOn(provider, 'getPR').mockImplementation(async () => ({ ...pr }));
    vi.spyOn(provider, 'targetAdvanced').mockResolvedValue(false);
    return new Engine(store, () => provider);
  };
  let engine = connect();
  const task = await engine.create({ ref, requirements: 'Check recovery', repoPath: dir });
  return {
    task,
    pr,
    gitHub,
    get store() {
      return store;
    },
    get engine() {
      return engine;
    },
    posts: () => transport.mock.calls.filter(([, init]) => init?.method === 'POST').length,
    restart() {
      store.close();
      store = new Store(file);
      engine = connect();
      engine.recoverInterruptedJobs();
    },
    ready() {
      const saved = store.getTask(task.id);
      saved.draftStart!.retryAt = 0;
      store.saveTask(saved);
      store.setSetting('github.read-backoff:' + ref.host, null);
      store.setSetting('github.quota:' + ref.host, { until: 0, delay: 0 });
      store.setSetting('github.read-backoff:' + ref.host, { until: 0, delay: 0 });
    },
    close() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

it('resumes the original draft after a 502, a restart, a failed read and an empty list', async () => {
  const f = await fixture();
  const id = f.task.id;
  try {
    const initial = await f.engine.review(id);
    expect(initial.state).toBe('queued');
    expect(initial.inputRequest).toBeUndefined();
    expect(f.posts()).toBe(1);
    expect(f.store.jobs(id)).toHaveLength(0);
    f.restart();
    f.ready();
    f.gitHub.listStatus = 502;
    expect((await f.engine.review(id)).state).toBe('queued');
    f.ready();
    f.gitHub.listStatus = 200;
    expect((await f.engine.review(id)).state).toBe('queued');
    expect(f.posts()).toBe(1);
    await f.engine.action(id, 'pause');
    f.ready();
    f.gitHub.reviews = [f.gitHub.draft];
    f.gitHub.paginate = true;
    await expect(f.engine.review(id)).rejects.toMatchObject({ code: 'task_paused' });
    await f.engine.action(id, 'resume');

    // Leave admission disabled so the test can inspect the queued reviewer job.
    vi.spyOn(f.store, 'claim').mockReturnValue(undefined);
    const worker = new Worker(
      f.engine,
      new Workspaces('/tmp'),
      new DemoRuntime(),
      new DemoRuntime(),
      () => ({
        memoryAvailableGiB: 30,
        memoryTotalGiB: 90,
        diskAvailableGiB: 180,
        diskUsedPercent: 77,
        ok: true,
        reasons: [],
      }),
      0,
    );
    try {
      await worker.tick();
    } finally {
      await worker.stop();
    }

    const recovered = f.store.getTask(id);
    expect(recovered.state).toBe('reviewing');
    expect(recovered.review).toMatchObject({
      id: '6060947228',
      marker: initial.draftStart!.marker,
      revision,
      authorId: '7',
    });
    expect(recovered.draftStart).toBeUndefined();
    expect(recovered.round).toBe(initial.round);
    expect(f.posts()).toBe(1);
    expect(f.store.jobs(id)).toHaveLength(1);
  } finally {
    f.close();
  }
});

it('rechecks an empty list and retries when GitHub explicitly refused the previous POST', async () => {
  const f = await fixture();
  try {
    f.gitHub.createStatus = 429;
    const first = await f.engine.review(f.task.id);
    expect(first.state).toBe('queued');
    expect(f.posts()).toBe(1);
    f.restart();
    f.ready();
    f.gitHub.createStatus = 200;
    const starts = await Promise.allSettled([
      f.engine.review(f.task.id),
      f.engine.review(f.task.id),
    ]);
    expect(starts[0].status).toBe('fulfilled');
    expect(f.store.getTask(f.task.id).review?.marker).toBe(first.draftStart!.marker);
    expect(f.posts()).toBe(2);
    expect(f.store.jobs(f.task.id)).toHaveLength(1);
  } finally {
    f.close();
  }
});

it.each(['revision', 'account', 'draft state', 'draft commit'])(
  'preserves the original intent when the %s changed',
  async (changed) => {
    const f = await fixture();
    try {
      const first = await f.engine.review(f.task.id);
      f.ready();
      f.gitHub.reviews = [f.gitHub.draft];
      if (changed === 'revision') f.pr.base = 'd'.repeat(40);
      if (changed === 'account') f.gitHub.account = 8;
      if (changed === 'draft state')
        Object.assign(f.gitHub.draft as object, { state: 'COMMENTED' });
      if (changed === 'draft commit')
        Object.assign(f.gitHub.draft as object, { commit_id: 'e'.repeat(40) });
      if (changed === 'revision') await f.engine.review(f.task.id);
      else
        await expect(f.engine.review(f.task.id)).rejects.toMatchObject({
          code: changed === 'account' ? 'draft_owner_changed' : 'draft_changed',
        });
      const blocked = f.store.getTask(f.task.id);
      expect(blocked.state).toBe('needs_input');
      expect(blocked.review).toBeUndefined();
      expect(blocked.draftStart?.marker).toBe(first.draftStart?.marker);
      expect(f.store.jobs(f.task.id)).toHaveLength(0);
      expect(f.posts()).toBe(1);
    } finally {
      f.close();
    }
  },
);

it('reconciles the same draft if GitHub rejects a guarded retry before the original becomes visible', async () => {
  const f = await fixture();
  try {
    const id = f.task.id,
      first = await f.engine.review(id);
    f.gitHub.rejectOccupiedSlot = true;
    f.ready();
    await f.engine.review(id);
    expect(f.posts()).toBe(1);
    f.ready();
    await f.engine.review(id);
    expect(f.posts()).toBe(2);
    expect(f.store.getTask(id).state).toBe('queued');
    expect(f.store.activeJobs(id)).toHaveLength(0);
    f.gitHub.reviews = [f.gitHub.draft];
    f.gitHub.paginate = true;
    f.ready();
    const recovered = await f.engine.review(id);
    expect(recovered.review).toMatchObject({
      marker: first.draftStart!.marker,
      id: '6060947228',
      revision,
    });
    expect(f.posts()).toBe(2);
    expect(f.store.activeJobs(id)).toHaveLength(1);
  } finally {
    f.close();
  }
});
