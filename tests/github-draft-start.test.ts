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
              : pathname.endsWith('/123/comments')
                ? comments
                : [],
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
      const pending = saved.mergeVerificationRequest ?? saved.draftStart!;
      expect(pending.retryAt).toBeGreaterThan(Date.now());
      expect(activityStatus({ task: saved })).toMatch(/retry at/);
      pending.retryAt = Date.now() - 1;
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
  const resources = {
    memoryAvailableGiB: 30,
    memoryTotalGiB: 90,
    diskAvailableGiB: 180,
    diskUsedPercent: 77,
    ok: true,
    reasons: [] as string[],
  };
  const worker = new Worker(engine, workspaces, runtime, runtime, () => resources, 0);
  return { worker, workspaces, prepare, prepareConflict, resources, run: runtime.run };
}

it.each(['during recovery', 'during workspace preparation'] as const)(
  'holds the recovered GitHub draft for CI %s',
  async (timing) => {
    const f = await reviewFixture();
    try {
      await f.engine.review(f.task.id);
      const intent = f.store.getTask(f.task.id).draftStart!;
      f.options.hidden = false;
      f.due();
      const before = reviewer(f);
      if (timing === 'during recovery') f.remote.checks = 'pending';
      else
        before.prepare.mockImplementationOnce(async () => {
          f.remote.checks = 'pending';
          return '/tmp';
        });
      try {
        await before.worker.tick();
        await vi.waitFor(() =>
          expect(f.store.getTask(f.task.id)).toMatchObject({ state: 'awaiting_review_checks' }),
        );
        expect(before.run).not.toHaveBeenCalled();
        expect(f.writeAttempts).toEqual(['POST']);
        const held = f.store.getTask(f.task.id);
        if (timing === 'during recovery')
          expect(held.draftStart).toMatchObject({ marker: intent.marker });
        else expect(held.review).toMatchObject({ id: '123', marker: intent.marker });
      } finally {
        await before.worker.stop();
      }
      f.restart();
      f.remote.checks = 'passing';
      const after = reviewer(f);
      try {
        await after.worker.tick();
        await vi.waitFor(() => expect(after.run).toHaveBeenCalledTimes(1));
        expect(after.run.mock.calls[0][0]).toMatchObject({
          job: { kind: 'review' },
          task: { round: 1, review: { id: '123', marker: intent.marker } },
        });
        expect(f.writeAttempts).toEqual(['POST']);
      } finally {
        await after.worker.stop();
      }
    } finally {
      f.close();
    }
  },
);

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
  ['ordinary', 'held by review recovery'],
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
    const admission = vi.spyOn(f.engine, 'admitReviewWork');
    if (scenario === 'held by review recovery') admission.mockResolvedValueOnce(false);
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
      if (
        kind === 'ordinary' &&
        (scenario === 'current' || scenario === 'held by review recovery')
      ) {
        expect(admission).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ kind: 'fix' }),
          expect.objectContaining({
            comments: [expect.objectContaining({ id: '456', body: f.comments[0].body })],
          }),
          expect.objectContaining({ head: f.remote.head, targetBranch: f.remote.targetBranch }),
        );
      } else expect(admission).not.toHaveBeenCalled();
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
      } else if (scenario === 'held by review recovery') {
        expect(run).not.toHaveBeenCalled();
        expect(f.store.jobs(task.id).at(-1)).toMatchObject({ kind: 'fix', status: 'cancelled' });
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

it('does not create a second draft when only the uncertain journal event survives', async () => {
  const f = await reviewFixture();
  try {
    await f.engine.review(f.task.id);
    const intent = f.store.getTask(f.task.id).draftStart!;
    expect(f.store.events(f.task.id)).toContainEqual(
      expect.objectContaining({
        type: 'operation.uncertain',
        data: expect.objectContaining({ operationId: intent.marker }),
      }),
    );
    f.store.db.prepare('DELETE FROM operations WHERE id=?').run(intent.marker);
    f.reviews[0].state = 'COMMENTED';
    f.comments.push({ id: 456, body: '**Original finding**', html_url: f.task.ref.url });
    f.restart();
    const { worker, run } = reviewer(f);
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        f.due();
        await worker.tick();
        expect(f.store.getTask(f.task.id).draftStart?.marker).toBe(intent.marker);
        expect(f.writeAttempts).toEqual(['POST']);
      }
      f.options.hidden = false;
      f.due();
      await worker.tick();
      expect(f.store.getTask(f.task.id)).toMatchObject({
        state: 'needs_input',
        review: { id: '123', marker: intent.marker },
        snapshot: { status: 'published', comments: [{ id: '456', body: f.comments[0].body }] },
      });
      expect(run).not.toHaveBeenCalled();
      expect(f.writeAttempts).toEqual(['POST']);
    } finally {
      await worker.stop();
    }
  } finally {
    f.close();
  }
});

it.each(['verify-merge', 'retry'] as const)(
  'retains %s on the bound review after the first PR read fails',
  async (entry) => {
    const f = await reviewFixture();
    try {
      await f.engine.review(f.task.id);
      f.options.hidden = false;
      f.reviews[0].state = 'COMMENTED';
      f.comments.push({ id: 456, body: 'Earlier Markdown', html_url: f.task.ref.url });
      f.due();
      await f.engine.review(f.task.id);
      expect(f.store.getTask(f.task.id)).toMatchObject({
        state: 'needs_input',
        reviewAdmission: '123',
        review: { id: '123' },
      });
      f.remote.state = 'merged';
      f.remote.mergeCommit = 'f'.repeat(40);
      vi.mocked(f.github.getPR).mockRejectedValueOnce(
        new AppError('provider_503', 'PR read failed'),
      );
      const deferred = await (entry === 'retry'
        ? f.engine.review(f.task.id, true)
        : f.engine.action(f.task.id, 'verify-merge'));
      expect(deferred).toMatchObject({
        state: 'queued',
        mergeVerificationRequest: { retryAt: expect.any(Number) },
      });
      expect(deferred.draftStart).toBeUndefined();
      f.restart();
      f.comments[0].body = '**Updated after the restart**';
      const { worker, run } = reviewer(f);
      run.mockResolvedValue({
        status: 'completed',
        summary: 'Verified merge',
        checkedHead: f.remote.head,
        verifiedCommentIds: ['456'],
      });
      try {
        await worker.tick();
        expect(run).not.toHaveBeenCalled();
        const saved = f.store.getTask(f.task.id);
        saved.mergeVerificationRequest!.retryAt = 0;
        f.store.saveTask(saved);
        await worker.tick();
        await vi.waitFor(() => expect(f.store.getTask(f.task.id).state).toBe('complete'));
        expect(run).toHaveBeenCalledTimes(1);
        expect(run.mock.calls[0][0]).toMatchObject({
          job: { kind: 'verify_merge' },
          task: {
            review: { id: '123' },
            snapshot: { comments: [{ id: '456', body: f.comments[0].body }] },
          },
        });
        expect(f.store.getTask(f.task.id).mergeVerificationRequest).toBeUndefined();
        expect(f.writeAttempts).toEqual(['POST']);
      } finally {
        await worker.stop();
      }
    } finally {
      f.close();
    }
  },
);

it.each([
  'immediate',
  'first PR read only',
  'review 503',
  'account 503',
  'PR recheck 503',
  'review 404',
  'comments 404',
] as const)('preserves a bound retry and its clarification through %s', async (failure) => {
  const f = await reviewFixture();
  try {
    await f.engine.review(f.task.id);
    f.options.hidden = false;
    f.reviews[0].state = 'COMMENTED';
    f.comments.push({ id: 456, body: '**Earlier Markdown**', html_url: f.task.ref.url });
    f.due();
    const held = await f.engine.review(f.task.id);
    expect(held).toMatchObject({ state: 'needs_input', reviewAdmission: '123' });

    const clarification = 'Include the original rollout checklist';
    if (failure !== 'immediate')
      vi.mocked(f.github.getPR).mockRejectedValueOnce(
        new AppError('provider_503', 'First PR read failed'),
      );
    await f.engine.review(f.task.id, true, clarification);
    f.restart();
    f.comments[0].body = '**Current Markdown**';
    const { worker, run } = reviewer(f);
    try {
      if (failure !== 'immediate') {
        f.due();
        if (failure === 'review 503') f.options.directReadFailure = true;
        if (failure === 'account 503')
          vi.spyOn(f.github, 'reviewAccount').mockRejectedValueOnce(
            new AppError('provider_503', 'Account read failed'),
          );
        if (failure === 'PR recheck 503')
          vi.mocked(f.github.getPR)
            .mockResolvedValueOnce({ ...f.remote })
            .mockRejectedValueOnce(new AppError('provider_503', 'PR recheck failed'));
        if (failure === 'review 404' || failure === 'comments 404')
          f.options.missing = failure === 'review 404' ? 'review' : 'comments';
        await worker.tick();
        if (failure !== 'first PR read only') {
          expect(f.store.getTask(f.task.id)).toMatchObject({
            state: 'queued',
            reviewAdmission: '123',
            mergeVerificationRequest: { kind: 'retry', clarification },
          });
          expect(run).not.toHaveBeenCalled();
          expect(f.writeAttempts).toEqual(['POST']);
          f.options.directReadFailure = false;
          f.options.missing = undefined;
          f.due();
          await worker.tick();
        }
      } else await worker.tick();
      await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
      expect(run.mock.calls[0][0]).toMatchObject({
        job: { kind: 'review' },
        task: {
          round: held.round + 1,
          review: { id: '124' },
          latestClarification: { text: clarification },
          feedback: {
            comments: [
              {
                id: '456',
                body: failure === 'immediate' ? '**Earlier Markdown**' : f.comments[0].body,
              },
            ],
          },
        },
      });
      expect(f.store.getTask(f.task.id).mergeVerificationRequest).toBeUndefined();
      expect(f.writeAttempts).toEqual(['POST', 'POST']);
    } finally {
      await worker.stop();
    }
  } finally {
    f.close();
  }
});

it.each(['immediate', 'deferred'] as const)(
  'recovers the next draft after interruption at the archive commit (%s retry)',
  async (entry) => {
    const f = await reviewFixture();
    try {
      await f.engine.review(f.task.id);
      f.options.hidden = false;
      f.reviews[0].state = 'COMMENTED';
      f.comments.push({ id: 456, body: '**Original finding**', html_url: f.task.ref.url });
      f.due();
      const held = await f.engine.review(f.task.id);
      const clarification = 'Include the original rollout checklist after the archive';
      if (entry === 'deferred') {
        vi.mocked(f.github.getPR).mockRejectedValueOnce(
          new AppError('provider_503', 'First read failed'),
        );
        await f.engine.review(f.task.id, true, clarification);
        f.due();
      }

      const interrupted = new Error('Stopped immediately after the archive commit');
      const commit = f.store.transaction.bind(f.store);
      vi.spyOn(f.store, 'transaction').mockImplementationOnce((write) => {
        commit(write);
        throw interrupted;
      });
      const retry =
        entry === 'immediate'
          ? f.engine.review(f.task.id, true, clarification)
          : f.engine.review(f.task.id);
      await expect(retry).rejects.toBe(interrupted);
      f.restart();
      expect(f.store.setting('review.archive:' + f.task.id + ':123')).toBeDefined();
      const staged = f.store.getTask(f.task.id);
      expect.soft(staged.draftStart).toMatchObject({ retry: true, clarification });
      expect(f.writeAttempts).toEqual(['POST']);

      const { worker, run } = reviewer(f);
      try {
        await worker.tick();
        await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
        const input = run.mock.calls[0][0];
        expect(input.task).toMatchObject({
          round: held.round + 1,
          review: { id: '124' },
          feedback: { comments: [{ id: '456', body: '**Original finding**' }] },
          latestClarification: { text: clarification },
        });
        expect(input.prompt).toContain(clarification);
        expect(f.writeAttempts).toEqual(['POST', 'POST']);
      } finally {
        await worker.stop();
      }
    } finally {
      f.close();
    }
  },
);

it.each([
  ['bound', 'immediate'],
  ['bound', 'deferred'],
  ['unbound', 'immediate'],
  ['unbound', 'deferred'],
] as const)(
  'passes retry clarification to verify_merge (%s review, %s request)',
  async (binding, entry) => {
    const f = await reviewFixture();
    try {
      await f.engine.review(f.task.id);
      f.options.hidden = false;
      f.reviews[0].state = 'COMMENTED';
      f.comments.push({ id: 456, body: '**Original finding**', html_url: f.task.ref.url });
      if (binding === 'bound') {
        f.due();
        await f.engine.review(f.task.id);
        expect(f.store.getTask(f.task.id).review?.id).toBe('123');
      }
      f.remote.state = 'merged';
      f.remote.mergeCommit = 'f'.repeat(40);
      const clarification = 'Include the original rollout checklist in the merge verification';
      if (entry === 'deferred')
        vi.mocked(f.github.getPR).mockRejectedValueOnce(
          new AppError('provider_503', 'First read failed'),
        );
      await f.engine.review(f.task.id, true, clarification);
      f.restart();
      if (entry === 'deferred') f.due();
      const { worker, run } = reviewer(f);
      run.mockResolvedValue({
        status: 'completed',
        summary: 'Verified merge',
        checkedHead: f.remote.head,
        verifiedCommentIds: ['456'],
      });
      try {
        await worker.tick();
        await vi.waitFor(() => expect(f.store.getTask(f.task.id).state).toBe('complete'));
        expect(run).toHaveBeenCalledTimes(1);
        const input = run.mock.calls[0][0];
        expect(input).toMatchObject({
          job: { kind: 'verify_merge' },
          task: {
            review: { id: '123' },
            snapshot: { comments: [{ id: '456', body: '**Original finding**' }] },
            latestClarification: { text: clarification },
          },
        });
        expect(input.prompt).toContain(clarification);
        expect(f.writeAttempts).toEqual(['POST']);
      } finally {
        await worker.stop();
      }
    } finally {
      f.close();
    }
  },
);

it.each([
  ['clear', 'immediate'],
  ['conflict', 'immediate'],
  ['clear', 'deferred'],
  ['conflict', 'deferred'],
] as const)('carries retry clarification through %s PR routing (%s)', async (route, timing) => {
  const f = await reviewFixture();
  try {
    f.enableAutoMerge();
    await f.engine.review(f.task.id);
    f.options.hidden = false;
    f.reviews[0].state = 'COMMENTED';
    f.comments.push({ id: 456, body: '**Original finding**', html_url: f.task.ref.url });
    f.due();
    const held = await f.engine.review(f.task.id);
    expect(held).toMatchObject({ state: 'needs_input', reviewAdmission: '123' });

    const needsRepair = route === 'conflict';
    f.remote.mergeConflict = needsRepair;
    f.remote.mergeable = !needsRepair;
    const clarification = 'Inspect the original rollout checklist for the owner';
    if (timing === 'deferred')
      vi.mocked(f.github.getPR).mockRejectedValueOnce(
        new AppError('provider_503', 'First read failed'),
      );
    await f.engine.review(f.task.id, true, clarification);
    f.restart();
    if (timing === 'deferred') f.due();

    if (needsRepair) {
      const repair = reviewer(f);
      const savedHead = 'e'.repeat(40);
      vi.spyOn(repair.workspaces, 'commitFix').mockResolvedValue(savedHead);
      repair.run.mockImplementationOnce(async (input) => {
        expect(input.job.kind).toBe('fix');
        expect(input.task).toMatchObject({
          fixingMergeConflict: true,
          conflictFeedbackReview: { id: '123' },
        });
        expect.soft(input.task.latestClarification).toMatchObject({ text: clarification });
        return {
          status: 'completed',
          summary: 'Resolved the conflict',
          checkedHead: input.task.revision!.head,
        };
      });
      try {
        await repair.worker.tick();
        await vi.waitFor(() =>
          expect(f.store.getTask(f.task.id)).toMatchObject({
            state: 'awaiting_push',
            pendingAuthorHead: savedHead,
          }),
        );
        expect(repair.run).toHaveBeenCalledTimes(1);
        await f.engine.submitSavedFix(f.task.id, async (_task, head) => {
          expect(head).toBe(savedHead);
          Object.assign(f.remote, { head, mergeConflict: false, mergeable: true });
        });
        expect(f.store.getTask(f.task.id)).toMatchObject({
          state: 'queued',
          revision: { head: savedHead },
        });
        expect(f.writeAttempts).toEqual(['POST']);
      } finally {
        await repair.worker.stop();
      }
      f.restart();
    }

    const verification = reviewer(f);
    try {
      await verification.worker.tick();
      await vi.waitFor(() => expect(verification.run).toHaveBeenCalledTimes(1));
      const input = verification.run.mock.calls[0][0];
      expect(input).toMatchObject({
        job: { kind: 'review', role: 'reviewer' },
        task: {
          round: held.round + 1,
          review: { id: '124', revision: { head: f.remote.head } },
          latestClarification: { text: clarification },
          feedback: { comments: [{ id: '456', body: '**Original finding**' }] },
        },
      });
      expect(input.prompt).toContain(clarification);
      expect(f.writeAttempts).toEqual(['POST', 'POST']);
    } finally {
      await verification.worker.stop();
    }
  } finally {
    f.close();
  }
});

it('keeps the clarification of a retry received before the original draft becomes visible', async () => {
  const f = await reviewFixture();
  try {
    await f.engine.review(f.task.id);
    const clarification = 'Include the original rollout checklist';
    await f.engine.review(f.task.id, true, clarification);
    f.restart();
    expect(f.store.getTask(f.task.id).draftStart).toMatchObject({ retry: true, clarification });
    f.options.hidden = false;
    f.due();
    const { worker, run } = reviewer(f);
    try {
      await worker.tick();
      await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
      expect(run.mock.calls[0][0]).toMatchObject({
        job: { kind: 'review' },
        task: { review: { id: '123' }, latestClarification: { text: clarification } },
      });
      expect(f.writeAttempts).toEqual(['POST']);
    } finally {
      await worker.stop();
    }
  } finally {
    f.close();
  }
});

it.each(['ambiguous', 'refused'] as const)(
  'allows open-PR retry after a deferred merge request (%s)',
  async (outcome) => {
    const f = await reviewFixture();
    try {
      if (outcome === 'refused') {
        f.options.firstPostStatus = 422;
        f.options.firstPostAccepted = false;
        await expect(f.engine.review(f.task.id)).rejects.toMatchObject({ code: 'provider_422' });
      } else await f.engine.review(f.task.id);
      const intent = f.store.getTask(f.task.id).draftStart!;
      vi.mocked(f.github.getPR).mockRejectedValueOnce(
        new AppError('provider_503', 'PR read failed'),
      );
      await f.engine.action(f.task.id, 'verify-merge');
      f.restart();
      f.options.hidden = false;
      f.due();
      const { worker, run } = reviewer(f);
      try {
        await worker.tick();
        const held = f.store.getTask(f.task.id);
        expect(held).toMatchObject({ state: 'needs_input', draftStart: { marker: intent.marker } });
        expect(held.draftStart?.mergeVerificationRequested).toBeUndefined();
        expect(run).not.toHaveBeenCalled();
        await f.engine.review(f.task.id, true);
        await worker.tick();
        await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
        expect(run.mock.calls[0][0]).toMatchObject({
          job: { kind: 'review' },
          task: { review: { id: '123', marker: intent.marker } },
        });
        expect(f.writeAttempts).toEqual(outcome === 'refused' ? ['POST', 'POST'] : ['POST']);
      } finally {
        await worker.stop();
      }
    } finally {
      f.close();
    }
  },
);

it.each([
  ['pending', 'verify-merge'],
  ['done', 'verify-merge'],
  ['pending', 'retry'],
  ['done', 'retry'],
  ['pending', 'retarget while waiting'],
  ['pending after refusal', 'retry'],
  ['pending', 'verify first read'],
  ['pending', 'retry first read'],
] as const)(
  'requires the original draft intent before merge verification (%s, %s)',
  async (receipt, entry) => {
    const f = await reviewFixture();
    try {
      if (receipt === 'pending after refusal') {
        f.options.firstPostStatus = 422;
        f.options.firstPostAccepted = false;
        await expect(f.engine.review(f.task.id)).rejects.toMatchObject({ code: 'provider_422' });
        await f.engine.action(f.task.id, 'resume');
        const post = f.github.postReview.bind(f.github);
        vi.spyOn(f.github, 'postReview').mockImplementationOnce(async (...args) => {
          await post(...args);
          throw new AppError('provider_502', 'The second POST succeeded without a response.');
        });
      }
      await f.engine.review(f.task.id);
      if (receipt === 'done') {
        f.options.hidden = false;
        f.options.directReadFailure = true;
        f.due();
        await f.engine.review(f.task.id);
        f.options.directReadFailure = false;
      }
      f.options.owner = 99;
      f.due();
      await expect(f.engine.review(f.task.id)).rejects.toMatchObject({
        code: 'draft_owner_changed',
      });
      const original = f.store.getTask(f.task.id);
      expect(original).toMatchObject({ state: 'needs_input', draftStart: { owner: '12' } });
      expect(original.review).toBeUndefined();
      expect(
        f.store.db
          .prepare('SELECT status FROM operations WHERE id=?')
          .get(original.draftStart!.marker),
      ).toMatchObject({ status: receipt === 'done' ? 'done' : 'pending' });

      f.reviews[0].state = 'COMMENTED';
      f.comments.push({
        id: 456,
        body: '**Published after account switch**',
        html_url: f.task.ref.url,
      });
      f.remote.state = 'merged';
      f.remote.mergeCommit = 'f'.repeat(40);
      f.restart();
      const verify = () => f.engine.action(f.task.id, 'verify-merge');
      await expect(verify()).rejects.toMatchObject({ code: 'draft_owner_changed' });
      f.options.owner = 12;
      f.remote.targetBranch = 'release';
      await expect(verify()).rejects.toMatchObject({ code: 'draft_changed' });
      expect(f.store.getTask(f.task.id)).toEqual(original);
      expect(f.store.activeJobs(f.task.id)).toHaveLength(0);

      f.remote.targetBranch = original.pr!.targetBranch;
      f.options.hidden = true;
      if (receipt === 'done') f.options.missing = 'comments';
      const firstRead = entry === 'verify first read' || entry === 'retry first read';
      if (firstRead)
        vi.mocked(f.github.getPR).mockRejectedValueOnce(
          new AppError('provider_503', 'PR read failed'),
        );
      const deferred = await (entry.startsWith('retry')
        ? f.engine.review(f.task.id, true)
        : verify());
      expect(deferred).toMatchObject({
        state: 'queued',
        draftStart: { marker: original.draftStart!.marker },
      });
      if (firstRead)
        expect(deferred.draftStart?.mergeVerificationRequested).toBe(
          entry === 'verify first read' ? 'verify' : 'retry',
        );
      else
        expect(deferred.draftStart?.mergeVerification).toEqual({
          head: f.remote.head,
          base: f.remote.base,
          start: f.remote.start,
          mergeCommit: f.remote.mergeCommit,
        });
      expect(f.store.activeJobs(f.task.id)).toHaveLength(0);
      f.restart();
      f.options.hidden = receipt === 'done';
      f.options.missing = undefined;
      const { worker, run } = reviewer(f);
      run.mockResolvedValue({
        checkedHead: f.remote.head,
        status: 'completed',
        summary: 'Checked merge',
        verifiedCommentIds: [],
      });
      try {
        await worker.tick();
        expect(run).not.toHaveBeenCalled();
        expect(f.store.activeJobs(f.task.id)).toHaveLength(0);
        if (entry === 'retarget while waiting') f.remote.targetBranch = 'release';
        f.due();
        await worker.tick();
        if (entry === 'retarget while waiting') {
          expect(f.store.getTask(f.task.id)).toMatchObject({
            state: 'needs_input',
            draftStart: { mergeVerification: { mergeCommit: f.remote.mergeCommit } },
            pr: { targetBranch: original.pr!.targetBranch },
          });
          expect(f.store.activeJobs(f.task.id)).toHaveLength(0);
          expect(run).not.toHaveBeenCalled();
          expect(f.writeAttempts).toEqual(['POST']);
          return;
        }
        await vi.waitFor(() => expect(f.store.activeJobs(f.task.id)).toHaveLength(0));
        await worker.tick();
        expect(run).toHaveBeenCalledTimes(1);
        expect(run.mock.calls[0][0]).toMatchObject({
          job: { kind: 'verify_merge' },
          task: { mergedReviewId: '123', review: { id: '123' } },
        });
        expect(f.store.getTask(f.task.id).draftStart).toBeUndefined();
        expect(run.mock.calls[0][0].task.snapshot?.comments).toMatchObject([
          { id: '456', body: f.comments[0].body },
        ]);
        expect(f.store.getTask(f.task.id)).toMatchObject({
          state: 'needs_input',
          reason: expect.stringContaining('verified all previously published findings'),
        });
        expect(f.writeAttempts).toEqual(
          receipt === 'pending after refusal' ? ['POST', 'POST'] : ['POST'],
        );
      } finally {
        await worker.stop();
      }
    } finally {
      f.close();
    }
  },
);

it.each([
  ['verify-merge', 'original'],
  ['retry', 'original'],
  ['resume', 'original'],
  ['verify-merge', 'retargeted'],
  ['retry', 'retargeted'],
  ['resume', 'retargeted'],
  ['verify-merge', 'retargeted during verification'],
] as const)(
  'retains the original target after a definitive refusal (%s, %s)',
  async (entry, target) => {
    const f = await reviewFixture();
    try {
      f.options.firstPostStatus = 422;
      f.options.firstPostAccepted = false;
      await expect(f.engine.review(f.task.id)).rejects.toMatchObject({ code: 'provider_422' });
      const refused = f.store.getTask(f.task.id);
      expect(f.store.events(f.task.id)).toContainEqual(
        expect.objectContaining({
          type: 'operation.refused',
          data: expect.objectContaining({ operationId: refused.draftStart!.marker }),
        }),
      );
      f.remote.state = 'merged';
      f.remote.mergeCommit = 'f'.repeat(40);
      if (target === 'retargeted') f.remote.targetBranch = 'release';
      f.restart();
      const scan = vi.spyOn(f.github, 'inspectReviewStart');
      const { worker, run } = reviewer(f);
      run.mockImplementation(async () => {
        if (target === 'retargeted during verification') f.remote.targetBranch = 'release';
        return { status: 'completed', summary: 'Checked merge', checkedHead: f.remote.head };
      });
      try {
        if (entry === 'resume') {
          await f.engine.action(f.task.id, 'resume');
          await worker.tick();
          expect(f.store.getTask(f.task.id)).toMatchObject({
            state: 'needs_input',
            draftStart: { marker: refused.draftStart!.marker },
            pr: { targetBranch: refused.pr!.targetBranch },
          });
        }
        const verify = () =>
          entry === 'retry'
            ? f.engine.review(f.task.id, true)
            : f.engine.action(f.task.id, 'verify-merge');
        if (target === 'retargeted') {
          await expect(verify()).rejects.toMatchObject({ code: 'draft_changed' });
          expect(f.store.activeJobs(f.task.id)).toHaveLength(0);
          expect(f.store.getTask(f.task.id)).toMatchObject({
            state: 'needs_input',
            draftStart: { marker: refused.draftStart!.marker },
            pr: { targetBranch: refused.pr!.targetBranch },
          });
          expect(run).not.toHaveBeenCalled();
        } else {
          await verify();
          expect(f.store.activeJobs(f.task.id)).toMatchObject([{ kind: 'verify_merge' }]);
          await worker.tick();
          await vi.waitFor(() => expect(f.store.activeJobs(f.task.id)).toHaveLength(0));
          expect(run).toHaveBeenCalledTimes(1);
          expect(run.mock.calls[0][0].task.review).toBeUndefined();
          expect(f.store.getTask(f.task.id)).toMatchObject({
            state: target === 'original' ? 'complete' : 'needs_input',
            pr: { targetBranch: refused.pr!.targetBranch },
          });
        }
        expect(scan).not.toHaveBeenCalled();
        expect(f.writeAttempts).toEqual(['POST']);
      } finally {
        await worker.stop();
      }
    } finally {
      f.close();
    }
  },
);

it.each([
  ['verify-merge', 'unsent'],
  ['retry', 'unsent'],
  ['verify-merge', 'account saved'],
  ['retry', 'account saved'],
  ['verify-merge', 'legacy'],
  ['retry', 'contradictory'],
] as const)(
  'checks durable evidence for a draft without a receipt (%s, %s)',
  async (entry, evidence) => {
    const f = await reviewFixture();
    try {
      if (evidence === 'account saved')
        vi.spyOn(f.engine.broker.outbox, 'perform').mockRejectedValueOnce(
          new AppError('provider_503', 'Interrupted before recording the write'),
        );
      else f.options.readFailure = true;
      await f.engine.review(f.task.id);
      const task = f.store.getTask(f.task.id);
      expect(task.draftStart?.owner).toBe(evidence === 'account saved' ? '12' : undefined);
      const intent = task.draftStart!;
      expect(
        f.store.db.prepare('SELECT 1 FROM operations WHERE id=?').get(intent.marker),
      ).toBeUndefined();
      if (evidence === 'legacy') {
        delete intent.ref;
        delete intent.target;
        f.store.saveTask(task);
      } else if (evidence === 'contradictory') {
        f.store.event(task.id, 'operation.started', { operationId: intent.marker });
      }
      f.remote.state = 'merged';
      f.remote.mergeCommit = 'f'.repeat(40);
      f.restart();
      const verify = () =>
        entry === 'retry'
          ? f.engine.review(task.id, true)
          : f.engine.action(task.id, 'verify-merge');
      const scan = vi.spyOn(f.github, 'inspectReviewStart');
      if (evidence === 'unsent' || evidence === 'account saved') {
        const queued = await verify();
        expect(queued).toMatchObject({ state: 'reviewing', mergeVerificationActive: true });
        expect(queued.review).toBeUndefined();
        expect(f.store.activeJobs(task.id)).toMatchObject([{ kind: 'verify_merge' }]);
        const { worker, run } = reviewer(f);
        run.mockResolvedValue({
          status: 'completed',
          summary: 'Verified merge',
          checkedHead: f.remote.head,
        });
        try {
          await worker.tick();
          await vi.waitFor(() => expect(f.store.getTask(task.id).state).toBe('complete'));
          expect(run).toHaveBeenCalledTimes(1);
        } finally {
          await worker.stop();
        }
      } else {
        await expect(verify()).rejects.toMatchObject({ code: 'draft_owner_unknown' });
        expect(f.store.getTask(task.id).draftStart?.marker).toBe(intent.marker);
        expect(f.store.activeJobs(task.id)).toHaveLength(0);
      }
      expect(scan).not.toHaveBeenCalled();
      expect(f.writeAttempts).toEqual([]);
    } finally {
      f.close();
    }
  },
);

async function verifyAfterRefusedDraft(f: Awaited<ReturnType<typeof reviewFixture>>) {
  f.options.firstPostStatus = 422;
  f.options.firstPostAccepted = false;
  await expect(f.engine.review(f.task.id)).rejects.toMatchObject({ code: 'provider_422' });
  f.remote.state = 'merged';
  f.remote.mergeCommit = 'f'.repeat(40);
  await f.engine.action(f.task.id, 'verify-merge');
}

it.each([
  ['manual', 'current'],
  ['disk', 'current'],
  ['disk', 'legacy'],
  ['shutdown', 'current'],
  ['restart after claim', 'current'],
  ['manual', 'transient'],
  ['disk', 'transient'],
  ['shutdown', 'transient'],
  ['restart after claim', 'transient'],
  ['restart after claim', 'bound transient'],
  ['restart after claim', 'repaused transient'],
] as const)(
  'resumes a merge verifier without a review after %s (%s record)',
  async (pause, record) => {
    const f = await reviewFixture();
    try {
      const bound = record === 'bound transient';
      if (bound) {
        await f.engine.review(f.task.id);
        f.options.hidden = false;
        f.reviews[0].state = 'COMMENTED';
        f.comments.push({ id: 456, body: '**Original Markdown**', html_url: f.task.ref.url });
        f.due();
        await f.engine.review(f.task.id);
        f.remote.state = 'merged';
        f.remote.mergeCommit = 'f'.repeat(40);
        await f.engine.action(f.task.id, 'verify-merge');
      } else await verifyAfterRefusedDraft(f);
      if (pause === 'restart after claim') {
        expect(f.store.claim()).toMatchObject({ kind: 'verify_merge', status: 'running' });
      } else {
        const before = reviewer(f);
        before.prepare.mockImplementationOnce(async (_task, _role, signal) => {
          await new Promise<void>((resolve) =>
            signal!.addEventListener('abort', () => resolve(), { once: true }),
          );
          return '/tmp';
        });
        try {
          await before.worker.tick();
          await vi.waitFor(() => expect(before.prepare).toHaveBeenCalledTimes(1));
          if (pause === 'disk') {
            before.resources.ok = false;
            before.resources.reasons = ['Disk threshold'];
            await before.worker.tick();
          } else if (pause === 'shutdown') await before.worker.stop();
          else await f.engine.action(f.task.id, 'pause');
          expect(f.store.getTask(f.task.id)).toMatchObject({
            state: pause === 'manual' ? 'paused' : 'needs_input',
          });
          expect(before.run).not.toHaveBeenCalled();
        } finally {
          await before.worker.stop();
        }
      }
      if (record === 'legacy') {
        const saved = f.store.getTask(f.task.id);
        delete saved.mergeVerificationActive;
        f.store.saveTask(saved);
      }
      f.restart();
      const transient = record.endsWith('transient');
      if (transient)
        vi.mocked(f.github.getPR).mockRejectedValueOnce(
          new AppError('provider_503', 'Resume PR read failed'),
        );
      await f.engine.action(f.task.id, 'resume');
      if (transient) {
        expect(f.store.getTask(f.task.id)).toMatchObject({
          state: 'queued',
          mergeVerificationRequest: { kind: 'resume' },
        });
        expect(f.store.activeJobs(f.task.id)).toHaveLength(0);
        if (record === 'repaused transient') await f.engine.action(f.task.id, 'pause');
        f.restart();
        if (record === 'repaused transient') await f.engine.action(f.task.id, 'resume');
        else f.due();
      } else expect(f.store.activeJobs(f.task.id)).toMatchObject([{ kind: 'verify_merge' }]);
      const after = reviewer(f);
      after.run.mockResolvedValue({
        status: 'completed',
        summary: 'Verified merge',
        checkedHead: f.remote.head,
        verifiedCommentIds: bound ? ['456'] : [],
      });
      try {
        await after.worker.tick();
        await vi.waitFor(() => expect(f.store.getTask(f.task.id).state).toBe('complete'));
        expect(after.run).toHaveBeenCalledTimes(1);
        expect(after.run.mock.calls[0][0].job.kind).toBe('verify_merge');
        expect(after.run.mock.calls[0][0].task.review?.id).toBe(bound ? '123' : undefined);
        expect(f.writeAttempts).toEqual(['POST']);
      } finally {
        await after.worker.stop();
      }
    } finally {
      f.close();
    }
  },
);

it.each([
  ['awaiting_checks', 'current'],
  ['awaiting_plan_approval', 'current'],
  ['awaiting_checks', 'transient'],
  ['awaiting_plan_approval', 'transient'],
  ['awaiting_checks', 'repaused'],
  ['awaiting_plan_approval', 'repaused'],
  ['awaiting_checks', 'bound repaused'],
  ['awaiting_plan_approval', 'bound repaused'],
] as const)('resumes the %s gate after verification completed (%s)', async (gate, record) => {
  const f = await reviewFixture();
  try {
    const bound = record === 'bound repaused';
    if (bound) {
      await f.engine.review(f.task.id);
      f.options.hidden = false;
      f.reviews[0].state = 'COMMENTED';
      f.comments.push({ id: 456, body: '**Original finding**', html_url: f.task.ref.url });
      f.due();
      await f.engine.review(f.task.id);
      f.remote.state = 'merged';
      f.remote.mergeCommit = 'f'.repeat(40);
      await f.engine.action(f.task.id, 'verify-merge');
    } else await verifyAfterRefusedDraft(f);
    const task = f.store.getTask(f.task.id);
    task.policy.requireChecks = true;
    if (gate === 'awaiting_plan_approval') {
      task.kind = 'plan';
      task.policy.planApproval = 'human';
    }
    f.store.saveTask(task);
    f.remote.checks = gate === 'awaiting_checks' ? 'pending' : 'passing';
    const job = f.store.claim()!;
    await f.engine.completeJob(job, {
      status: 'completed',
      summary: 'Verified merge',
      checkedHead: f.remote.head,
      verifiedCommentIds: bound ? ['456'] : [],
    });
    f.store.saveJob({ ...job, status: 'completed' });
    expect(f.store.getTask(task.id).state).toBe(gate);
    await f.engine.action(task.id, 'pause');
    f.restart();
    if (record !== 'current') {
      vi.mocked(f.github.getPR).mockRejectedValueOnce(
        new AppError('provider_503', 'Resume PR read failed'),
      );
      await f.engine.action(task.id, 'resume');
      expect(f.store.getTask(task.id)).toMatchObject({
        state: 'queued',
        mergeVerificationRequest: { kind: 'resume' },
        resumeState: gate,
      });
      const report = f.store.getTask(task.id).verifiedMerge;
      const repaused = record.endsWith('repaused');
      if (repaused) {
        const paused = await f.engine.action(task.id, 'pause');
        expect.soft(paused.resumeState).toBe(gate);
      }
      f.restart();
      if (repaused) {
        expect((await f.engine.action(task.id, 'resume')).state).toBe(gate);
        expect(f.store.getTask(task.id).verifiedMerge).toEqual(report);
      } else f.due();
      const { worker, run } = reviewer(f);
      try {
        await worker.tick();
        expect(run).not.toHaveBeenCalled();
        expect(f.store.getTask(task.id).state).toBe(gate);
      } finally {
        await worker.stop();
      }
    } else expect((await f.engine.action(task.id, 'resume')).state).toBe(gate);
    expect(f.store.activeJobs(task.id)).toHaveLength(0);
    if (gate === 'awaiting_checks') {
      f.remote.checks = 'passing';
      await f.engine.reconcile(task.id);
    } else await f.engine.action(task.id, 'approve-plan');
    const completed = f.store.getTask(task.id);
    expect(completed.state).toBe('complete');
    expect(completed.mergeVerificationActive).toBeUndefined();
    expect(f.store.jobs(task.id).filter((item) => item.kind === 'verify_merge')).toHaveLength(1);
    expect(f.writeAttempts).toEqual(['POST']);
  } finally {
    f.close();
  }
});

it.each([
  ['review', 'resource'],
  ['verify_merge', 'resource'],
  ['review', 'manual'],
  ['verify_merge', 'manual'],
] as const)(
  'resumes the original %s after a %s pause in workspace preparation',
  async (kind, pause) => {
    const f = await reviewFixture();
    try {
      await f.engine.review(f.task.id);
      f.options.hidden = false;
      if (kind === 'verify_merge') {
        f.reviews[0].state = 'COMMENTED';
        f.comments.push({ id: 456, body: '**Original Markdown**', html_url: f.task.ref.url });
      }
      f.due();
      await f.engine.review(f.task.id);
      if (kind === 'verify_merge') {
        f.remote.state = 'merged';
        f.remote.mergeCommit = 'f'.repeat(40);
        await f.engine.action(f.task.id, 'verify-merge');
      }
      const [first] = f.store.activeJobs(f.task.id);
      const { worker, run, prepare, resources } = reviewer(f);
      prepare.mockImplementationOnce(async (_task, _role, signal) => {
        await new Promise<void>((resolve) =>
          signal!.addEventListener('abort', () => resolve(), { once: true }),
        );
        return '/tmp';
      });
      try {
        await worker.tick();
        await vi.waitFor(() => expect(prepare).toHaveBeenCalledTimes(1));
        if (pause === 'resource') {
          resources.ok = false;
          resources.reasons = ['Disk threshold'];
          await worker.tick();
        } else {
          await f.engine.action(f.task.id, 'pause');
        }
        await vi.waitFor(() => {
          expect(f.store.jobs(f.task.id).find((job) => job.id === first.id)).toMatchObject({
            status: 'cancelled',
            finishedAt: expect.any(String),
          });
        });
        expect(f.store.getTask(f.task.id)).toMatchObject({
          state: pause === 'resource' ? 'needs_input' : 'paused',
          generation: first.generation + 1,
          review: { id: '123' },
        });
        if (pause === 'resource')
          expect(f.store.getTask(f.task.id).resourcePause?.generation).toBe(first.generation + 1);
        expect(run).not.toHaveBeenCalled();
        resources.ok = true;
        resources.reasons = [];
        await f.engine.action(f.task.id, 'resume');
        await worker.tick();
        await vi.waitFor(() => expect(f.store.activeJobs(f.task.id)).toHaveLength(0));
        await worker.tick();
        expect(run).toHaveBeenCalledTimes(1);
        const [input] = run.mock.calls[0];
        expect(input.job.kind).toBe(kind);
        expect(input.task.review?.id).toBe('123');
        if (kind === 'verify_merge')
          expect(input.task.snapshot?.comments).toMatchObject([
            { id: '456', body: f.comments[0].body },
          ]);
        expect(f.store.getTask(f.task.id).resourcePause).toBeUndefined();
        expect(f.writeAttempts).toEqual(['POST']);
      } finally {
        await worker.stop();
      }
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
