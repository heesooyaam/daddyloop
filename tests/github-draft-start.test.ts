import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { fixture } from './helpers.js';
import { Engine } from '../src/core/engine.js';
import { GitHubProvider } from '../src/providers/github.js';
import { prRef } from '../src/core/types.js';
import { activityStatus } from '../src/core/task-activity.js';

async function reviewFixture() {
  const f = await fixture();
  const task = f.store.getTask(f.task.id);
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
  f.store.saveTask(task);
  type Native = {
    id: number;
    user: { id: number };
    commit_id: string;
    state: string;
    body: string;
  };
  const reviews: Native[] = [];
  const posts: string[] = [];
  let acceptFirst = false;
  const github = new GitHubProvider('github.com', 'test', async (url, init) => {
    if (String(url).endsWith('/user')) return Response.json({ id: 12 });
    if (String(url).endsWith('/reviews/123') && init?.method === 'GET')
      return Response.json(reviews[0]);
    if (String(url).includes('/comments?')) return Response.json([]);
    if (init?.method === 'GET' && String(url).includes('/reviews?')) return Response.json(reviews);
    if (init?.method === 'POST' && String(url).endsWith('/reviews')) {
      const body = JSON.parse(String(init.body));
      posts.push(body.body);
      const r = {
        id: 123,
        user: { id: 12 },
        commit_id: body.commit_id,
        state: 'PENDING',
        body: body.body,
      };
      if (posts.length > 1 || acceptFirst) reviews.push(r);
      if (posts.length === 1) return new Response('Server Error', { status: 502 });
      return Response.json(r);
    }
    throw Error('Unexpected native request');
  });
  vi.spyOn(github, 'getPR').mockImplementation(async () => ({ ...remote }));
  const engine = () => new Engine(f.store, () => github);
  function due() {
    const saved = f.store.getTask(task.id);
    expect(saved.state).toBe('queued');
    expect(saved.draftStart!.retryAt).toBeGreaterThan(Date.now());
    expect(activityStatus({ task: saved })).toMatch(/retry at/);
    saved.draftStart!.retryAt = Date.now() - 1;
    f.store.saveTask(saved);
  }
  return {
    ...f,
    task,
    remote,
    reviews,
    posts,
    engine,
    due,
    accept: () => {
      acceptFirst = true;
    },
  };
}

it.each([true, false])(
  'reconciles a lost draft create across restart (accepted by GitHub: %s)',
  async (accepted) => {
    const f = await reviewFixture();
    try {
      if (accepted) f.accept();
      const e = f.engine();
      await e.review(f.task.id);
      const pending = f.store.getTask(f.task.id);
      expect(pending.inputRequest).toBeUndefined();
      expect(e.coordinationBlocker(pending)).toBeUndefined();
      expect(f.store.activeJobs(f.task.id)).toHaveLength(0);
      await e.review(f.task.id);
      expect(f.posts).toHaveLength(1);
      const restarted = f.engine();
      restarted.recoverInterruptedJobs();
      f.due();
      await Promise.allSettled([restarted.review(f.task.id), restarted.review(f.task.id)]);
      const t = f.store.getTask(f.task.id);
      expect(t).toMatchObject({
        state: 'reviewing',
        round: pending.round,
        review: { id: '123', marker: pending.draftStart!.marker, revision: t.revision },
      });
      expect(t.draftStart).toBeUndefined();
      expect(f.posts).toHaveLength(accepted ? 1 : 2);
      expect(new Set(f.posts).size).toBe(1);
      expect(f.reviews).toHaveLength(1);
      expect(f.store.activeJobs(t.id)).toMatchObject([{ role: 'reviewer', kind: 'review' }]);
      expect(
        f.store.db.prepare('SELECT status FROM operations WHERE id=?').get(t.review!.marker)
          ?.status,
      ).toBe('done');
    } finally {
      f.store.close();
    }
  },
);
it('restores a pre-upgrade 502 only for the recorded request, and preserves another pending draft', async () => {
  const f = await reviewFixture();
  try {
    const t = f.task;
    t.round = 16;
    t.state = 'needs_input';
    t.reason = 'AppError: POST /repos/test/repo/pulls/38/reviews: HTTP 502 Server Error';
    t.resumeState = 'awaiting_push';
    f.store.saveTask(t);
    const marker = `daddyloop:${t.id}:${t.generation}:17`;
    const e = f.engine();
    e.recoverInterruptedJobs();
    expect(f.store.getTask(t.id).state).toBe('needs_input');
    f.store.db
      .prepare('INSERT INTO operations VALUES (?,?,?,?,NULL)')
      .run(
        marker,
        t.id,
        'pending',
        createHash('sha256').update(JSON.stringify(t.revision)).digest('hex'),
      );
    e.recoverInterruptedJobs();
    expect(f.store.getTask(t.id)).toMatchObject({
      state: 'queued',
      round: 17,
      draftStart: { marker },
    });
    const other = {
      id: 99,
      user: { id: 12 },
      state: 'PENDING',
      commit_id: f.remote.head,
      body: 'A human draft',
    };
    f.reviews.push(other);
    await expect(e.review(t.id)).rejects.toMatchObject({ code: 'draft_occupied' });
    expect(f.posts).toHaveLength(0);
    expect(f.reviews).toEqual([other]);
  } finally {
    f.store.close();
  }
});
it('never recreates the old draft after the PR head moves', async () => {
  const f = await reviewFixture();
  try {
    const e = f.engine();
    await e.review(f.task.id);
    f.due();
    f.remote.head = 'e'.repeat(40);
    await e.review(f.task.id);
    expect(f.posts).toHaveLength(1);
    await e.review(f.task.id);
    expect(f.reviews).toMatchObject([{ commit_id: f.remote.head }]);
    expect(f.store.getTask(f.task.id)).toMatchObject({
      state: 'reviewing',
      revision: { head: f.remote.head },
    });
  } finally {
    f.store.close();
  }
});

it('carries the confirmed empty draft to the new base and reviews that exact revision', async () => {
  const f = await reviewFixture();
  try {
    f.accept();
    const e = f.engine();
    await e.review(f.task.id);
    f.due();
    f.remote.base = 'e'.repeat(40);
    f.remote.start = f.remote.base;
    await e.review(f.task.id);
    expect(f.posts).toHaveLength(1);
    expect(f.store.getTask(f.task.id)).toMatchObject({
      state: 'reviewing',
      review: { id: '123', revision: { base: f.remote.base } },
    });
    expect(f.store.activeJobs(f.task.id)).toHaveLength(1);
  } finally {
    f.store.close();
  }
});
