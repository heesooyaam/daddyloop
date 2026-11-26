import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/core/store.js';
import { Worker } from '../src/runtime/worker.js';
import { Workspaces } from '../src/runtime/workspaces.js';
import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { fixture } from './helpers.js';
import { Engine } from '../src/core/engine.js';
import { GitHubProvider } from '../src/providers/github.js';
import { GitLabProvider } from '../src/providers/gitlab.js';
import { ArcadiaProvider } from '../src/providers/arcadia.js';
import { ArcBridge } from '../src/integrations/arcadia.js';
import { tag } from '../src/providers/provider.js';
import { AppError, prRef } from '../src/core/types.js';
import { activityStatus } from '../src/core/task-activity.js';

async function reviewFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'daddyloop-draft-'));
  const db = join(dir, 'tasks.db');
  let store = new Store(db);
  const f = await fixture({}, store);
  const task = store.getTask(f.task.id);
  task.ref = {
    provider: 'github',
    host: 'github.com',
    repo: 'test/repo',
    number: 38,
    url: 'https://github.com/test/repo/pull/38',
  };
  const remote = { ...(await f.provider.getPR(prRef(task))), draft: false };
  task.pr = remote;
  task.state = 'queued';
  store.saveTask(task);
  type Native = {
    id: number;
    user: { id: number };
    commit_id: string;
    html_url?: string;
    state: string;
    body: string;
  };
  const reviews: Native[] = [];
  const posts: string[] = [];
  const comments: { id: number; body: string; html_url: string }[] = [];
  const writeAttempts: string[] = [];
  const options = {
    hidden: true,
    pageTwo: false,
    readFailure: false,
    directReadFailure: false,
    missing: undefined as 'review' | 'comments' | undefined,
    firstPostStatus: 502,
    firstPostAccepted: true,
    owner: 12,
  };
  const github = new GitHubProvider('github.com', 'test', async (url, init) => {
    const endpoint = new URL(String(url));
    const { pathname } = endpoint;
    if (init?.method !== 'GET') writeAttempts.push(init?.method ?? 'GET');
    if (pathname.endsWith('/user')) return Response.json({ id: options.owner });
    if (/\/reviews\/\d+$/.test(pathname) && init?.method === 'GET') {
      if (options.directReadFailure) return new Response(null, { status: 503 });
      const review = reviews.find((review) => pathname.endsWith('/' + review.id));
      return review && options.missing !== 'review'
        ? Response.json(review)
        : new Response(null, { status: 404 });
    }
    if (pathname.endsWith('/comments'))
      return options.missing === 'comments'
        ? new Response(null, { status: 404 })
        : Response.json(
            pathname.endsWith('/100/comments')
              ? [{ id: 700, body: 'Unrelated publication', html_url: task.ref.url }]
              : comments,
          );
    if (init?.method === 'GET' && pathname.endsWith('/reviews')) {
      if (options.readFailure) return new Response(null, { status: 503 });
      if (options.hidden) return Response.json([]);
      if (options.pageTwo && endpoint.searchParams.get('page') === '1')
        return Response.json(
          Array.from({ length: 100 }, (_, i) => ({
            ...reviews[0],
            id: 1000 + i,
            body: 'Earlier review',
            state: 'COMMENTED',
          })),
        );
      return Response.json(reviews);
    }
    if (init?.method === 'POST' && pathname.endsWith('/reviews')) {
      const body = JSON.parse(String(init.body));
      posts.push(body.body);
      const review = {
        id: 123 + reviews.length,
        user: { id: options.owner },
        commit_id: body.commit_id,
        state: 'PENDING',
        body: body.body,
      };
      if (posts.length > 1 || options.firstPostAccepted) reviews.push(review);
      if (posts.length === 1)
        return new Response('Create failed', { status: options.firstPostStatus });
      return Response.json(review);
    }
    throw Error(`Unexpected native request ${init?.method} ${pathname}`);
  });
  vi.spyOn(github, 'getPR').mockImplementation(async () => ({ ...remote }));
  vi.spyOn(github, 'targetAdvanced').mockResolvedValue(true);
  let engine = new Engine(store, () => github);
  return {
    task,
    remote,
    reviews,
    comments,
    posts,
    writeAttempts,
    options,
    github,
    get store() {
      return store;
    },
    get engine() {
      return engine;
    },
    enableAutoMerge() {
      const current = store.getTask(task.id);
      current.groupId = 'auto-merge';
      store.saveGroup({
        id: current.groupId,
        title: 'Test',
        requirements: '',
        rootTaskId: task.id,
        daddy: engine.defaultAgents().daddy,
        generation: 1,
        createdAt: current.createdAt,
        updatedAt: current.updatedAt,
        workspace: {
          id: 'test',
          name: 'Test',
          repoPath: '/tmp',
          scope: '',
          vcs: 'git',
          provider: 'github',
          host: 'github.com',
          repo: 'test/repo',
          createdAt: current.createdAt,
          updatedAt: current.updatedAt,
        },
      });
      store.saveTask(current);
      store.setSetting('autoMerge.session:' + current.groupId, true);
    },
    due() {
      const saved = store.getTask(task.id);
      expect(saved.state).toBe('queued');
      expect(saved.draftStart!.retryAt).toBeGreaterThan(Date.now());
      expect(activityStatus({ task: saved })).toMatch(/retry at/);
      saved.draftStart!.retryAt = Date.now() - 1;
      store.saveTask(saved);
    },
    restart() {
      store.close();
      store = new Store(db);
      engine = new Engine(store, () => github);
      engine.recoverInterruptedJobs();
    },
    close() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function reviewer(f: Awaited<ReturnType<typeof reviewFixture>>, engine = f.engine) {
  const workspaces = new Workspaces('/tmp');
  const prepare = vi.spyOn(workspaces, 'prepare').mockResolvedValue('/tmp');
  const prepareConflict = vi.spyOn(workspaces, 'prepareConflict').mockResolvedValue(undefined);
  const runtime = {
    run: vi.fn<ConstructorParameters<typeof Worker>[2]['run']>(async () => ({
      status: 'incomplete' as const,
      summary: 'Offline reviewer',
      checkedHead: f.remote.head,
      verifiedCommentIds: [],
      disputedCommentIds: [],
    })),
  };
  const worker = new Worker(
    engine,
    workspaces,
    runtime,
    runtime,
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
  return { worker, prepare, prepareConflict, run: runtime.run };
}

it('recovers the original paginated draft after restart and starts exactly one reviewer', async () => {
  const f = await reviewFixture();
  try {
    await f.engine.review(f.task.id);
    const original = f.store.getTask(f.task.id).draftStart!;
    expect(original.owner).toBe('12');
    f.due();
    f.options.readFailure = true;
    await f.engine.review(f.task.id);
    f.options.readFailure = false;
    f.restart();
    for (let i = 0; i < 3; i++) {
      f.due();
      await f.engine.review(f.task.id);
      expect(f.store.activeJobs(f.task.id)).toHaveLength(0);
      expect(f.posts).toHaveLength(1);
    }
    await f.engine.action(f.task.id, 'pause');
    await expect(f.engine.review(f.task.id)).rejects.toMatchObject({ code: 'task_paused' });
    await f.engine.action(f.task.id, 'resume');
    f.options.hidden = false;
    f.options.pageTwo = true;
    f.due();
    await Promise.allSettled([f.engine.review(f.task.id), f.engine.review(f.task.id)]);
    expect(f.store.getTask(f.task.id)).toMatchObject({
      state: 'reviewing',
      review: { id: '123', marker: original.marker },
    });
    expect(f.store.activeJobs(f.task.id)).toHaveLength(1);
    const claimed = f.store.claim();
    expect(claimed?.status).toBe('running');
    f.restart();
    expect(f.store.activeJobs(f.task.id)).toMatchObject([{ id: claimed!.id, status: 'queued' }]);
    const { worker, run } = reviewer(f);
    try {
      await worker.tick();
      await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(f.store.activeJobs(f.task.id)).toHaveLength(0));
      await worker.tick();
      expect(run).toHaveBeenCalledTimes(1);
      expect(f.posts).toHaveLength(1);
    } finally {
      await worker.stop();
    }
  } finally {
    f.close();
  }
});

it('retries a confirmed refusal after checking the account and the PR again', async () => {
  const f = await reviewFixture();
  try {
    f.options.firstPostStatus = 422;
    f.options.firstPostAccepted = false;
    await expect(f.engine.review(f.task.id)).rejects.toMatchObject({ code: 'provider_422' });
    f.restart();
    await f.engine.action(f.task.id, 'resume');
    await f.engine.review(f.task.id);
    expect(f.posts).toHaveLength(2);
    expect(new Set(f.posts).size).toBe(1);
    expect(f.store.getTask(f.task.id).review?.id).toBe('123');
  } finally {
    f.close();
  }
});

it('refuses to attribute an old unknown-account operation to the current login', async () => {
  const f = await reviewFixture();
  try {
    const task = f.task;
    task.round = 16;
    task.state = 'needs_input';
    task.reason = 'AppError: POST /repos/test/repo/pulls/38/reviews: HTTP 502 Server Error';
    f.store.saveTask(task);
    const marker = `daddyloop:${task.id}:${task.generation}:17`;
    f.store.db
      .prepare('INSERT INTO operations VALUES (?,?,?,?,NULL)')
      .run(
        marker,
        task.id,
        'pending',
        createHash('sha256').update(JSON.stringify(task.revision)).digest('hex'),
      );
    f.restart();
    expect(f.store.getTask(task.id).draftStart?.marker).toBe(marker);
    await expect(f.engine.review(task.id)).rejects.toMatchObject({ code: 'draft_owner_unknown' });
    expect(f.posts).toHaveLength(0);
  } finally {
    f.close();
  }
});

it('preserves a hidden draft across an account switch and a PR head change', async () => {
  const f = await reviewFixture();
  try {
    await f.engine.review(f.task.id);
    f.due();
    f.options.owner = 23;
    await expect(f.engine.review(f.task.id)).rejects.toMatchObject({ code: 'draft_owner_changed' });
    expect(f.store.getTask(f.task.id).draftStart?.owner).toBe('12');
    f.options.owner = 12;
    f.remote.head = 'e'.repeat(40);
    await f.engine.action(f.task.id, 'resume');
    await f.engine.review(f.task.id);
    expect(f.store.getTask(f.task.id).draftStart?.owner).toBe('12');
    f.options.hidden = false;
    f.due();
    await f.engine.review(f.task.id);
    expect(f.store.getTask(f.task.id)).toMatchObject({
      state: 'needs_input',
      review: { id: '123' },
    });
    expect(f.posts).toHaveLength(1);
    expect(f.store.activeJobs(f.task.id)).toHaveLength(0);
  } finally {
    f.close();
  }
});

it('carries the original draft to a confirmed advance of the same target branch', async () => {
  const f = await reviewFixture();
  try {
    await f.engine.review(f.task.id);
    f.options.hidden = false;
    f.due();
    f.remote.base = 'e'.repeat(40);
    f.remote.start = f.remote.base;
    await f.engine.review(f.task.id);
    expect(f.posts).toHaveLength(1);
    expect(f.store.getTask(f.task.id)).toMatchObject({
      state: 'reviewing',
      review: { id: '123', revision: { base: f.remote.base } },
    });
    expect(f.store.activeJobs(f.task.id)).toHaveLength(1);
  } finally {
    f.close();
  }
});

it.each(['edited', 'published', 'retargeted', 'commented'])(
  'holds a draft that was %s before reviewer launch',
  async (change) => {
    const f = await reviewFixture();
    try {
      await f.engine.review(f.task.id);
      f.options.hidden = false;
      f.due();
      await f.engine.review(f.task.id);
      const { worker, prepare, run } = reviewer(f);
      prepare.mockImplementation(async () => {
        if (change === 'published') f.reviews[0].state = 'COMMENTED';
        if (change === 'edited') f.reviews[0].body = '**Human Markdown**\n\n' + f.reviews[0].body;
        if (change === 'retargeted') f.remote.targetBranch = 'release';
        if (change === 'commented')
          f.comments.push({
            id: 456,
            body: '**Human comment**\nwith Markdown',
            html_url: f.task.ref.url,
          });
        return '/tmp';
      });
      try {
        await worker.tick();
        await vi.waitFor(() => expect(f.store.getTask(f.task.id).state).toBe('needs_input'));
        expect(run).not.toHaveBeenCalled();
        expect(f.posts).toHaveLength(1);
        expect(f.store.getTask(f.task.id)).toMatchObject({
          review: { id: '123' },
          snapshot: { body: f.reviews[0].body },
          reviewFinished: false,
        });
        if (change === 'commented')
          expect(f.store.getTask(f.task.id).snapshot?.comments).toMatchObject([
            { id: '456', body: f.comments[0].body },
          ]);
        expect(f.writeAttempts).toEqual(['POST']);
        expect(f.store.getTask(f.task.id).feedback).toBeUndefined();
      } finally {
        await worker.stop();
      }
    } finally {
      f.close();
    }
  },
);

it('remembers the observed review ID through a failed direct read and a removed marker', async () => {
  const f = await reviewFixture();
  try {
    await f.engine.review(f.task.id);
    f.options.hidden = false;
    f.options.directReadFailure = true;
    f.due();
    await f.engine.review(f.task.id);
    f.restart();
    f.options.hidden = true;
    f.options.directReadFailure = false;
    f.reviews[0].body = '**Updated by the account holder**';
    f.due();
    await f.engine.review(f.task.id);
    expect(f.store.getTask(f.task.id)).toMatchObject({
      state: 'needs_input',
      review: { id: '123' },
      snapshot: { body: f.reviews[0].body },
    });
    expect(f.writeAttempts).toEqual(['POST']);
  } finally {
    f.close();
  }
});

it('finds a submitted review after several empty reads without accepting it as completed', async () => {
  const f = await reviewFixture();
  try {
    await f.engine.review(f.task.id);
    for (let i = 0; i < 2; i++) {
      f.due();
      await f.engine.review(f.task.id);
    }
    f.reviews[0].state = 'COMMENTED';
    f.comments.push({ id: 456, body: '**Original comment**', html_url: f.task.ref.url });
    f.options.hidden = false;
    f.due();
    await f.engine.review(f.task.id);
    await f.engine.reconcile(f.task.id);
    expect(f.store.getTask(f.task.id)).toMatchObject({
      state: 'needs_input',
      review: { id: '123' },
      snapshot: { status: 'published', comments: [{ id: '456', body: f.comments[0].body }] },
      reviewFinished: false,
    });
    expect(f.store.getTask(f.task.id).feedback).toBeUndefined();
    expect(f.store.activeJobs(f.task.id)).toHaveLength(0);
    expect(f.writeAttempts).toEqual(['POST']);
  } finally {
    f.close();
  }
});

it('repins the unstarted reviewer after the target advances while preparing its workspace', async () => {
  const f = await reviewFixture();
  try {
    await f.engine.review(f.task.id);
    f.options.hidden = false;
    f.due();
    await f.engine.review(f.task.id);
    const { worker, prepare, run } = reviewer(f);
    prepare.mockImplementationOnce(async () => {
      f.remote.base = 'e'.repeat(40);
      f.remote.start = f.remote.base;
      return '/tmp';
    });
    try {
      await worker.tick();
      await vi.waitFor(() =>
        expect(f.store.activeJobs(f.task.id)).toMatchObject([{ status: 'queued' }]),
      );
      expect(run).not.toHaveBeenCalled();
      await worker.tick();
      await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
      expect(f.store.getTask(f.task.id).review).toMatchObject({
        id: '123',
        revision: { base: f.remote.base },
      });
      expect(f.writeAttempts).toEqual(['POST']);
    } finally {
      await worker.stop();
    }
  } finally {
    f.close();
  }
});

it.each([
  ['ordinary', 'current'],
  ['ordinary', 'redirected before claim'],
  ['ordinary', 'redirected during preparation'],
  ['ordinary', 'author changed'],
  ['conflict', 'current'],
  ['conflict', 'advanced'],
  ['conflict', 'rewritten'],
  ['conflict', 'legacy'],
  ['conflict', 'legacy edited'],
  ['conflict', 'ambiguous publication'],
  ['conflict', 'redirected during preparation'],
] as const)('checks published feedback before an %s fix (%s)', async (kind, scenario) => {
  const f = await reviewFixture();
  try {
    if (kind === 'conflict') f.enableAutoMerge();
    await f.engine.review(f.task.id);
    f.options.hidden = false;
    f.due();
    await f.engine.review(f.task.id);
    const task = f.store.getTask(f.task.id);
    f.store.cancelJobs(task.id);
    delete task.reviewAdmission;
    task.reviewFinished = true;
    f.reviews[0].state = 'COMMENTED';
    if (scenario === 'legacy edited')
      f.reviews[0].html_url = f.task.ref.url + '#pullrequestreview-123';
    f.comments.push({ id: 456, body: 'Old comment', html_url: f.task.ref.url });
    task.snapshot = task.feedback = await f.github.getReview(prRef(task), task.review!);
    const originalId = task.review!.id;
    const originalRevision = task.revision!;
    if (kind === 'conflict') {
      task.state = 'awaiting_publication';
      f.store.saveTask(task);
      f.remote.mergeConflict = true;
      if (scenario === 'advanced' || scenario === 'rewritten') {
        f.remote.base = f.remote.start = 'e'.repeat(40);
        vi.mocked(f.github.targetAdvanced).mockResolvedValue(scenario === 'advanced');
      }
      await f.engine.reconcile(task.id);
      expect(f.store.getTask(task.id).conflictFeedbackReview?.id).toBe(originalId);
      if (
        scenario === 'legacy' ||
        scenario === 'legacy edited' ||
        scenario === 'ambiguous publication'
      ) {
        const current = f.store.getTask(task.id);
        delete current.conflictFeedbackReview;
        if (scenario === 'legacy edited') {
          f.comments[0].body = 'Edited before the upgrade';
          current.feedback = await f.github.getReview(prRef(task), task.review!);
          f.reviews.push({
            ...f.reviews[0],
            id: 100,
            html_url: f.task.ref.url + '#pullrequestreview-100',
          });
          f.store.event(task.id, 'review.findings_published', {
            reviewId: '100',
            revision: originalRevision,
            comments: 1,
          });
        }
        f.store.saveTask(current);
        f.store.event(task.id, 'review.published', {
          reviewId: originalId,
          snapshot: task.snapshot,
        });
        if (scenario === 'ambiguous publication')
          f.store.event(task.id, 'review.published', { reviewId: '124', snapshot: task.snapshot });
        f.restart();
      }
    } else {
      task.state = 'fixing';
      f.store.saveTask(task);
      f.store.enqueue(task, 'author', 'fix', 'Address published feedback');
    }

    const { worker, prepare, prepareConflict, run } = reviewer(f);
    if (scenario === 'redirected before claim') f.remote.targetBranch = 'release';
    const duringPreparation = () => {
      f.comments[0].body = '**Current comment**\nPreserve this Markdown';
      if (scenario === 'redirected during preparation') f.remote.targetBranch = 'release';
      if (scenario === 'author changed') f.reviews[0].user.id = 99;
    };
    if (kind === 'conflict')
      prepareConflict.mockImplementation(async () => {
        duringPreparation();
      });
    else
      prepare.mockImplementation(async () => {
        duringPreparation();
        return '/tmp';
      });
    try {
      await worker.tick();
      await vi.waitFor(() => expect(f.store.activeJobs(task.id)).toHaveLength(0));
      if (scenario === 'advanced' || scenario === 'rewritten')
        expect(f.github.targetAdvanced).toHaveBeenCalledWith(
          prRef(task),
          originalRevision.base,
          f.remote.base,
        );
      if (
        scenario === 'current' ||
        scenario === 'advanced' ||
        scenario === 'legacy' ||
        scenario === 'legacy edited'
      ) {
        expect(run).toHaveBeenCalledTimes(1);
        expect(run.mock.calls[0][0].task.feedback?.comments).toMatchObject([
          { id: '456', body: f.comments[0].body },
        ]);
      } else {
        expect(run).not.toHaveBeenCalled();
        expect(f.store.getTask(task.id)).toMatchObject({
          state: 'needs_input',
          feedback: { comments: [{ id: '456', body: 'Old comment' }] },
        });
        if (scenario === 'ambiguous publication' || scenario === 'rewritten')
          expect(f.store.getTask(task.id).reason).toContain('Findings awaiting verification: 456');
      }
    } finally {
      await worker.stop();
    }
  } finally {
    f.close();
  }
});

it.each(['gitlab', 'arcadia'] as const)(
  'releases current verified notes from %s to a fix worker',
  async (kind) => {
    const f = await reviewFixture();
    try {
      const task = f.store.getTask(f.task.id);
      task.ref.provider = kind;
      task.state = 'fixing';
      task.reviewFinished = true;
      task.review = {
        id: '5',
        nodeId: '9',
        marker: 'test',
        authorId: '7',
        revision: task.revision!,
      };
      let body = 'Old comment';
      const gitlab = new GitLabProvider('gitlab.com', 'fake', async (url) =>
        Response.json(
          String(url).includes('draft_notes')
            ? []
            : [
                { id: 5, body: tag('test'), author: { id: 7 } },
                { id: 6, body: body + '\n' + tag('test:comment:note'), author: { id: 7 } },
              ],
        ),
      );
      const bridge = new ArcBridge();
      vi.spyOn(bridge, 'api').mockImplementation(async (args) =>
        args[0] === 'pr'
          ? [
              { id: 5, content: tag('test'), author: { name: '7' } },
              { id: 6, content: body + '\n' + tag('test:comment:note'), author: { name: '7' } },
            ]
          : [],
      );
      const provider = kind === 'gitlab' ? gitlab : new ArcadiaProvider(bridge);
      vi.spyOn(provider, 'getPR').mockResolvedValue(f.remote);
      task.snapshot = task.feedback = await provider.getReview(prRef(task), task.review);
      expect(task.feedback.authorId).toBeUndefined();
      f.store.saveTask(task);
      f.store.enqueue(task, 'author', 'fix', 'Address published feedback');
      const { worker, prepare, run } = reviewer(f, new Engine(f.store, () => provider));
      prepare.mockImplementation(async () => {
        body = 'Current **Markdown**';
        return '/tmp';
      });
      try {
        await worker.tick();
        await vi.waitFor(() => expect(f.store.activeJobs(task.id)).toHaveLength(0));
        expect(run).toHaveBeenCalledTimes(1);
        expect(run.mock.calls[0][0].task.feedback?.comments[0].body).toBe(
          body + '\n' + tag('test:comment:note'),
        );
      } finally {
        await worker.stop();
      }
    } finally {
      f.close();
    }
  },
);

it.each(['review', 'comments'] as const)(
  'rechecks the known draft after a transient 404 on %s at admission',
  async (missing) => {
    const f = await reviewFixture();
    try {
      await f.engine.review(f.task.id);
      f.options.hidden = false;
      f.due();
      await f.engine.review(f.task.id);
      const { worker, run } = reviewer(f);
      try {
        const [original] = f.store.activeJobs(f.task.id);
        f.options.missing = missing;
        await worker.tick();
        const [deferred] = await vi.waitFor(() => {
          const jobs = f.store.activeJobs(f.task.id);
          expect(jobs).toMatchObject([
            { id: original.id, status: 'queued', notBefore: expect.any(String) },
          ]);
          return jobs;
        });
        expect(run).not.toHaveBeenCalled();
        expect(f.store.getTask(f.task.id).review?.id).toBe('123');
        f.options.missing = undefined;
        f.store.saveJob({ ...deferred, notBefore: undefined });
        await worker.tick();
        await vi.waitFor(() => expect(f.store.activeJobs(f.task.id)).toHaveLength(0));
        expect(run).toHaveBeenCalledTimes(1);
        expect(f.posts).toHaveLength(1);
      } finally {
        await worker.stop();
      }
    } finally {
      f.close();
    }
  },
);

it.each([
  'open',
  'conflict',
  'merged',
  'merged verified',
  'redirected retry',
  'redirected verify',
  'changed during verification',
] as const)('checks the original publication on explicit retry (%s)', async (scenario) => {
  const f = await reviewFixture();
  try {
    if (scenario === 'conflict') f.enableAutoMerge();
    await f.engine.review(f.task.id);
    f.options.hidden = false;
    f.reviews[0].state = 'COMMENTED';
    f.reviews[0].body = 'Owner published this Markdown\n' + f.reviews[0].body;
    const original = { ...f.reviews[0] };
    f.due();
    await f.engine.review(f.task.id);
    const held = await f.engine.reconcile(f.task.id);
    expect(held).toMatchObject({
      state: 'needs_input',
      reviewFinished: false,
      review: { id: '123' },
    });
    expect(f.store.activeJobs(f.task.id)).toHaveLength(0);
    if (scenario === 'conflict') f.remote.mergeConflict = true;
    else if (scenario !== 'open') {
      f.remote.state = 'merged';
      f.remote.mergeCommit = 'f'.repeat(40);
    }
    if (scenario === 'redirected retry' || scenario === 'redirected verify') {
      f.remote.targetBranch = 'release';
      const result =
        scenario === 'redirected retry'
          ? f.engine.review(f.task.id, true)
          : f.engine.action(f.task.id, 'verify-merge');
      await expect(result).rejects.toMatchObject({ code: 'draft_changed' });
      expect(f.store.activeJobs(f.task.id)).toHaveLength(0);
      expect(f.store.getTask(f.task.id)).toMatchObject({
        state: 'needs_input',
        reviewAdmission: '123',
        review: { id: '123' },
      });
      expect(f.posts).toHaveLength(1);
      return;
    }
    if (scenario !== 'open')
      f.comments.push({ id: 456, body: '**Added after the hold**', html_url: f.task.ref.url });
    const retried = await f.engine.review(f.task.id, true);
    expect(f.reviews[0]).toEqual(original);
    if (scenario === 'open') {
      expect(retried).toMatchObject({
        state: 'reviewing',
        round: held.round + 1,
        review: { id: '124' },
      });
      expect(f.store.setting('review.archive:' + f.task.id + ':123')).toMatchObject({
        body: original.body,
      });
    } else if (scenario === 'conflict') {
      expect(retried).toMatchObject({ state: 'fixing', conflictFeedbackReview: { id: '123' } });
      expect(f.store.activeJobs(f.task.id)).toMatchObject([{ kind: 'fix' }]);
      expect(f.store.setting('review.archive:' + f.task.id + ':123')).toMatchObject({
        body: original.body,
      });
    } else {
      expect(retried.state).toBe('reviewing');
      expect(f.store.activeJobs(f.task.id)).toMatchObject([{ kind: 'verify_merge' }]);
    }
    expect(f.posts).toHaveLength(scenario === 'open' ? 2 : 1);
    const { worker, run, prepare } = reviewer(f);
    if (f.remote.state === 'merged') {
      prepare.mockImplementation(async () => {
        f.comments[0].body += '\nFresh at reviewer admission';
        return '/tmp';
      });
      run.mockImplementation(async ({ task }) => {
        expect(task.snapshot?.comments).toMatchObject([{ id: '456', body: f.comments[0].body }]);
        if (scenario === 'changed during verification')
          f.comments[0].body += '\nEdited during review';
        return {
          status: 'completed',
          checkedHead: f.remote.head,
          summary: 'Checked merged result',
          verifiedCommentIds: scenario === 'merged' ? [] : ['456'],
        };
      });
    }
    try {
      await worker.tick();
      await vi.waitFor(() => expect(f.store.activeJobs(f.task.id)).toHaveLength(0));
      expect(run).toHaveBeenCalledTimes(1);
      expect(run.mock.calls[0][0].job.kind).toBe(
        scenario === 'open' ? 'review' : scenario === 'conflict' ? 'fix' : 'verify_merge',
      );
      if (scenario === 'conflict')
        expect(run.mock.calls[0][0].task.feedback?.comments).toMatchObject([
          { id: '456', body: f.comments[0].body },
        ]);
      if (scenario === 'merged verified') {
        const completed = f.store.getTask(f.task.id);
        expect(completed).toMatchObject({
          state: 'complete',
          verifiedMerge: { head: f.remote.head },
        });
        expect(completed.mergedReviewId).toBeUndefined();
      } else if (f.remote.state === 'merged')
        expect(f.store.getTask(f.task.id)).toMatchObject({
          state: 'needs_input',
          mergedReviewId: '123',
          reason: expect.stringContaining(
            scenario === 'merged'
              ? 'verified all previously published findings'
              : 'review changed during verification',
          ),
        });
      expect(f.reviews[0]).toEqual(original);
    } finally {
      await worker.stop();
    }
  } finally {
    f.close();
  }
});

it.each([
  'pause',
  'missing review',
  'missing comments',
  'draft',
  'closed and same target',
  'closed and retargeted',
] as const)('preserves the merge job and original review across %s', async (scenario) => {
  const f = await reviewFixture();
  try {
    await f.engine.review(f.task.id);
    f.options.hidden = false;
    if (scenario === 'draft') {
      f.remote.state = 'merged';
      f.remote.mergeCommit = 'f'.repeat(40);
    } else {
      f.reviews[0].state = 'COMMENTED';
      f.comments.push({ id: 456, body: '**Current comment**', html_url: f.task.ref.url });
    }
    f.due();
    await f.engine.review(f.task.id);
    const held = f.store.getTask(f.task.id);
    expect(held).toMatchObject({ state: 'needs_input', reviewAdmission: '123' });
    if (scenario.startsWith('closed')) {
      f.remote.state = 'closed';
      await expect(f.engine.review(f.task.id, true)).rejects.toMatchObject({ code: 'pr_closed' });
      expect(f.store.getTask(f.task.id)).toEqual(held);
    }
    f.remote.state = 'merged';
    f.remote.mergeCommit = 'f'.repeat(40);
    if (scenario === 'closed and retargeted') {
      f.remote.targetBranch = 'release';
      await expect(f.engine.review(f.task.id, true)).rejects.toMatchObject({
        code: 'draft_changed',
      });
      expect(f.store.getTask(f.task.id)).toEqual(held);
      expect(f.store.activeJobs(f.task.id)).toHaveLength(0);
      expect(f.writeAttempts).toEqual(['POST']);
      return;
    }
    await f.engine.action(f.task.id, 'verify-merge');
    if (scenario === 'pause') {
      await f.engine.action(f.task.id, 'pause');
      f.restart();
      await f.engine.action(f.task.id, 'resume');
    }
    const [job] = f.store.activeJobs(f.task.id);
    expect(job.kind).toBe('verify_merge');
    const { worker, run } = reviewer(f);
    run.mockResolvedValue({
      status: 'completed',
      summary: 'Verified merged result',
      checkedHead: f.remote.head,
      verifiedCommentIds: scenario === 'draft' ? [] : ['456'],
    });
    try {
      if (scenario === 'missing review' || scenario === 'missing comments') {
        f.options.missing = scenario === 'missing review' ? 'review' : 'comments';
        await worker.tick();
        const deferred = await vi.waitFor(() => {
          const [retry] = f.store.activeJobs(f.task.id);
          expect(retry).toMatchObject({
            id: job.id,
            kind: 'verify_merge',
            status: 'queued',
            notBefore: expect.any(String),
          });
          return retry;
        });
        expect(run).not.toHaveBeenCalled();
        f.options.missing = undefined;
        f.store.saveJob({ ...deferred, notBefore: undefined });
      }
      await worker.tick();
      await vi.waitFor(() => expect(f.store.getTask(f.task.id).state).toBe('complete'));
      expect(run).toHaveBeenCalledTimes(1);
      const observed = run.mock.calls[0][0].task;
      expect(observed.review?.id).toBe('123');
      expect(observed.snapshot?.status).toBe(scenario === 'draft' ? 'draft' : 'published');
      expect(f.reviews[0].state).toBe(scenario === 'draft' ? 'PENDING' : 'COMMENTED');
      expect(f.writeAttempts).toEqual(['POST']);
    } finally {
      await worker.stop();
    }
  } finally {
    f.close();
  }
});

it.each(['CI edit', 'plan edit', 'CI restarted', 'CI unchanged', 'CI waiver edit'] as const)(
  'keeps merge verification tied to the original evidence at completion (%s)',
  async (scenario) => {
    const f = await reviewFixture();
    try {
      await f.engine.review(f.task.id);
      f.options.hidden = false;
      f.reviews[0].state = 'COMMENTED';
      f.comments.push({ id: 456, body: '**Verified text**', html_url: f.task.ref.url });
      f.due();
      await f.engine.review(f.task.id);
      const held = f.store.getTask(f.task.id);
      held.policy.requireChecks = true;
      if (scenario === 'plan edit') {
        held.kind = 'plan';
        held.policy.planApproval = 'human';
      }
      f.store.saveTask(held);
      f.remote.state = 'merged';
      f.remote.mergeCommit = 'f'.repeat(40);
      f.remote.checks =
        scenario === 'CI restarted' || scenario === 'plan edit' ? 'passing' : 'pending';
      // The plan kind only needs to be set for the result gate. The job fixture has no Git diff.
      await f.engine.review(f.task.id, true);
      const job = f.store.claim()!;
      if (scenario === 'CI restarted') {
        vi.mocked(f.github.getPR)
          .mockResolvedValueOnce({ ...f.remote, checks: 'passing' })
          .mockResolvedValueOnce({ ...f.remote, checks: 'pending' });
        f.remote.checks = 'pending';
      }
      await f.engine.completeJob(job, {
        status: 'completed',
        checkedHead: f.remote.head,
        summary: 'Verified',
        verifiedCommentIds: ['456'],
      });
      f.store.saveJob({ ...job, status: 'completed' });
      const waiting = f.store.getTask(f.task.id);
      expect(waiting).toMatchObject({
        state: scenario === 'plan edit' ? 'awaiting_plan_approval' : 'awaiting_checks',
        mergedReviewId: '123',
      });
      if (scenario === 'CI restarted') expect(waiting.pr?.checks).toBe('pending');
      if (scenario.endsWith('edit')) f.comments[0].body = '**Edited after review**';
      f.remote.checks = 'passing';
      if (scenario === 'plan edit') await f.engine.action(f.task.id, 'approve-plan');
      else if (scenario === 'CI waiver edit')
        await f.engine.action(f.task.id, 'waive-checks', 'CI deferred');
      else await f.engine.reconcile(f.task.id);
      const final = f.store.getTask(f.task.id);
      expect(final.state).toBe(scenario.endsWith('edit') ? 'needs_input' : 'complete');
      expect(final.mergedReviewId).toBe(scenario.endsWith('edit') ? '123' : undefined);
      if (scenario.endsWith('edit')) expect(final.verifiedMerge).toBeUndefined();
      expect(f.writeAttempts).toEqual(['POST']);
    } finally {
      f.close();
    }
  },
);

it.each(['refused', 'visible', 'admission'] as const)(
  'respects newly confirmed auto-merge conflict (%s)',
  async (when) => {
    const f = await reviewFixture();
    try {
      f.enableAutoMerge();
      if (when === 'refused') {
        f.options.firstPostAccepted = false;
        f.options.firstPostStatus = 422;
        await expect(f.engine.review(f.task.id)).rejects.toMatchObject({ code: 'provider_422' });
        await f.engine.action(f.task.id, 'resume');
        f.remote.mergeConflict = true;
        await f.engine.review(f.task.id);
        expect(f.store.getTask(f.task.id).draftStart).toBeUndefined();
        await f.engine.review(f.task.id);
        expect(f.store.activeJobs(f.task.id)).toMatchObject([{ kind: 'fix' }]);
      } else {
        await f.engine.review(f.task.id);
        f.options.hidden = false;
        f.due();
        if (when === 'visible') f.remote.mergeConflict = true;
        await f.engine.review(f.task.id);
        if (when === 'admission') {
          const { worker, prepare, run } = reviewer(f);
          prepare.mockImplementation(async () => {
            f.remote.mergeConflict = true;
            return '/tmp';
          });
          try {
            await worker.tick();
            await vi.waitFor(() => expect(f.store.activeJobs(f.task.id)).toHaveLength(0));
            expect(run).not.toHaveBeenCalled();
          } finally {
            await worker.stop();
          }
        }
        expect(f.store.getTask(f.task.id)).toMatchObject({
          state: 'needs_input',
          review: { id: '123' },
        });
        expect(f.store.activeJobs(f.task.id)).toHaveLength(0);
      }
      expect(f.writeAttempts).toEqual(['POST']);
    } finally {
      f.close();
    }
  },
);

it.each(['accepted', 'not accepted', 'edited'] as const)(
  'recovers a transient GitHub publication failure with the original review ID (%s)',
  async (outcome) => {
    const f = await fixture();
    try {
      const task = f.store.getTask(f.task.id);
      task.ref = {
        provider: 'github',
        host: 'github.com',
        repo: 'test/repo',
        number: 39,
        url: 'https://github.com/test/repo/pull/39',
      };
      f.store.saveTask(task);
      await f.engine.review(task.id);
      const inReview = f.store.getTask(task.id);
      inReview.review!.authorId = '12';
      f.store.saveTask(inReview);
      const key = 'demo-review:' + inReview.review!.id;
      f.store.setSetting(key, {
        ...(await f.provider.getReview(prRef(task), inReview.review!)),
        authorId: '12',
      });
      if (outcome === 'not accepted') {
        const job = f.store.claim()!;
        vi.spyOn(f.provider, 'createComment').mockRejectedValueOnce(
          new AppError('provider_502', 'Lost add'),
        );
        await expect(
          f.engine.broker.call(job, 'add_comment', { key: 'absent', body: 'Unconfirmed add' }),
        ).rejects.toThrow();
        vi.spyOn(f.provider, 'updateSummary').mockRejectedValueOnce(
          new AppError('provider_500', 'Lost edit'),
        );
        await expect(
          f.engine.broker.call(job, 'set_summary', { body: 'Unconfirmed summary' }),
        ).rejects.toThrow();
        await f.engine.broker.call(job, 'set_summary', { body: 'Final verified summary' });
        await f.engine.completeJob(job, f.result());
        f.store.saveJob({ ...job, status: 'completed' });
      } else await f.run();
      const publish = f.provider.publish.bind(f.provider);
      const calls = vi.spyOn(f.provider, 'publish').mockImplementationOnce(async (ref, handle) => {
        if (outcome === 'accepted') await publish(ref, handle);
        throw new AppError(
          'provider_500',
          'POST /repos/test/repo/pulls/39/reviews/' + handle.id + '/events: HTTP 500 Server Error',
        );
      });
      const waiting = await f.engine.publish(task.id);
      expect(waiting.state).toBe('awaiting_publication');
      expect(waiting.publicationRetry!.retryAt).toBeGreaterThan(Date.now());
      await f.engine.publish(task.id);
      expect(calls).toHaveBeenCalledTimes(1);
      waiting.publicationRetry!.retryAt = 0;
      if (outcome === 'not accepted') {
        delete waiting.publicationRetry;
        waiting.state = 'needs_input';
        waiting.reason =
          'AppError: POST /repos/test/repo/pulls/39/reviews/' +
          inReview.review!.id +
          '/events: HTTP 500 Server Error';
      }
      f.store.saveTask(waiting);
      const restarted = new Engine(f.store, () => f.provider);
      restarted.recoverInterruptedJobs();
      if (outcome === 'edited') {
        f.store.setSetting(key, {
          ...(await f.provider.getReview(prRef(task), inReview.review!)),
          body: 'Manually edited',
        });
        await expect(restarted.publish(task.id)).rejects.toMatchObject({ code: 'draft_changed' });
        expect(calls).toHaveBeenCalledTimes(1);
      } else {
        await restarted.publish(task.id);
        expect(calls).toHaveBeenCalledTimes(outcome === 'accepted' ? 1 : 2);
        expect(
          f.store.db
            .prepare('SELECT status FROM operations WHERE id=?')
            .get(inReview.review!.marker + ':publish')?.status,
        ).toBe('done');
      }
    } finally {
      f.store.close();
    }
  },
);
