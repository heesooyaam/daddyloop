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
    firstPostStatus: 502,
    firstPostAccepted: true,
    owner: 12,
  };
  const github = new GitHubProvider('github.com', 'test', async (url, init) => {
    const endpoint = new URL(String(url));
    const { pathname } = endpoint;
    if (init?.method !== 'GET') writeAttempts.push(init?.method ?? 'GET');
    if (pathname.endsWith('/user')) return Response.json({ id: options.owner });
    if (pathname.endsWith('/reviews/123') && init?.method === 'GET') {
      if (options.directReadFailure) return new Response(null, { status: 503 });
      return reviews.length ? Response.json(reviews[0]) : new Response(null, { status: 404 });
    }
    if (pathname.endsWith('/comments')) return Response.json(comments);
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
        id: 123,
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

function reviewer(f: Awaited<ReturnType<typeof reviewFixture>>) {
  const workspaces = new Workspaces('/tmp');
  const prepare = vi.spyOn(workspaces, 'prepare').mockResolvedValue('/tmp');
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
    f.engine,
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
  return { worker, prepare, run: runtime.run };
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

it.each([false, true])(
  'checks current published feedback before an author run (retargeted: %s)',
  async (retargeted) => {
    const f = await reviewFixture();
    try {
      await f.engine.review(f.task.id);
      f.options.hidden = false;
      f.due();
      await f.engine.review(f.task.id);
      const task = f.store.getTask(f.task.id);
      f.store.cancelJobs(task.id);
      delete task.reviewAdmission;
      task.state = 'fixing';
      task.reviewFinished = true;
      f.reviews[0].state = 'COMMENTED';
      f.comments.push({ id: 456, body: 'Old comment', html_url: f.task.ref.url });
      task.snapshot = task.feedback = await f.github.getReview(prRef(task), task.review!);
      f.store.saveTask(task);
      f.store.enqueue(task, 'author', 'fix', 'Address published feedback');

      const { worker, prepare, run } = reviewer(f);
      prepare.mockImplementation(async () => {
        f.comments[0].body = '**Current comment**\nPreserve this Markdown';
        if (retargeted) f.remote.targetBranch = 'release';
        return '/tmp';
      });
      try {
        await worker.tick();
        await vi.waitFor(() => expect(f.store.activeJobs(task.id)).toHaveLength(0));
        if (retargeted) {
          expect(run).not.toHaveBeenCalled();
          expect(f.store.getTask(task.id).feedback?.comments[0].body).toBe('Old comment');
        } else {
          expect(run).toHaveBeenCalledTimes(1);
          expect(run.mock.calls[0][0].task.feedback?.comments).toMatchObject([
            { id: '456', body: f.comments[0].body },
          ]);
        }
      } finally {
        await worker.stop();
      }
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
