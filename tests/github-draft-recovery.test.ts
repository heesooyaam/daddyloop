import { mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { Engine } from '../src/core/engine.js';
import { Store } from '../src/core/store.js';
import type { PullRequest } from '../src/core/types.js';
import { GitHubProvider } from '../src/providers/github.js';
import { parsePR } from '../src/providers/provider.js';
import { DemoRuntime } from '../src/runtime/demo.js';
import { Worker } from '../src/runtime/worker.js';
import { Workspaces } from '../src/runtime/workspaces.js';

const ref = parsePR('https://github.com/acme/service/pull/38');
const revision = { head: 'a'.repeat(40), base: 'b'.repeat(40), start: 'c'.repeat(40) };

async function fixture(realPRReads = false) {
  const dir = mkdtempSync(join(tmpdir(), 'daddy-draft-'));
  const file = join(dir, 'state.sqlite');
  let store = new Store(file);
  const pr: PullRequest = {
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
    nextId: 6060947228,
    advanced: false,
    createBody: undefined as string | undefined,
    listBody: undefined as string | undefined,
    readComments: () => Response.json([]),
    readPR: () => {},
    override: (_path: string, _method?: string): Response | undefined => undefined,
  };
  const transport = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const { pathname: path, searchParams } = new URL(String(url));
    const override = gitHub.override(path, init?.method);
    if (override) return override;
    if (realPRReads) {
      if (path.endsWith('/pulls/38'))
        return Response.json({
          title: pr.title,
          head: { sha: pr.head, ref: pr.branch, repo: { clone_url: pr.cloneUrl } },
          base: { sha: pr.base, ref: pr.targetBranch },
          state: pr.state,
          draft: pr.draft,
          merged: false,
        });
      if (path.endsWith('/status')) return Response.json({ statuses: [] });
      if (path.endsWith('/check-runs')) return Response.json({ check_runs: [] });
      if (path.includes('/git/ref/heads/'))
        return Response.json({
          ref: 'refs/heads/' + pr.targetBranch,
          object: { type: 'commit', sha: pr.base },
        });
      if (path.includes('/compare/'))
        return Response.json({ status: 'ahead', merge_base_commit: { sha: revision.base } });
    }
    if (path === '/user') return Response.json({ id: gitHub.account });
    if (path.endsWith('/reviews/6060947228/comments')) return gitHub.readComments();
    if (path.endsWith('/reviews/6060947228') && init?.method === 'DELETE') {
      gitHub.draft = undefined;
      gitHub.reviews = [];
      return new Response(null, { status: 204 });
    }
    if (path.endsWith('/reviews/6060947228'))
      return gitHub.draft ? Response.json(gitHub.draft) : new Response(null, { status: 404 });
    expect(path).toBe('/repos/acme/service/pulls/38/reviews');
    if (init?.method === 'GET') {
      if (gitHub.listBody !== undefined) return new Response(gitHub.listBody);
      const reviews =
        gitHub.paginate && searchParams.get('page') === '1'
          ? Array.from({ length: 100 }, (_, id) => ({ id, user: { id: 8 }, state: 'COMMENTED' }))
          : gitHub.reviews;
      return Response.json(reviews, { status: gitHub.listStatus });
    }
    expect(init?.method).toBe('POST');
    const body = JSON.parse(String(init?.body));
    gitHub.draft = {
      id: gitHub.nextId,
      node_id: 'draft',
      body: body.body,
      state: 'PENDING',
      commit_id: body.commit_id,
      user: { id: gitHub.account },
    };
    if (gitHub.createStatus === 429)
      return Response.json({}, { status: 429, headers: { 'Retry-After': '1' } });
    return gitHub.createBody === undefined
      ? Response.json(gitHub.draft, { status: gitHub.createStatus })
      : new Response(gitHub.createBody, { status: gitHub.createStatus });
  });
  const connect = () => {
    const provider = new GitHubProvider(ref.host, 'offline', transport, store);
    if (!realPRReads) {
      vi.spyOn(provider, 'getPR').mockImplementation(async () => {
        gitHub.readPR();
        return { ...pr };
      });
      vi.spyOn(provider, 'targetAdvanced').mockImplementation(async () => gitHub.advanced);
    }
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
    deletes: () => transport.mock.calls.filter(([, init]) => init?.method === 'DELETE').length,
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

it('migrates a pending create from the base version without binding it to the new account', async () => {
  const f = await fixture();
  const id = f.task.id;
  try {
    const first = await f.engine.review(id);
    const marker = first.draftStart!.marker;
    // Before the draft-start migration the worker saved the failed task and outbox row
    // separately, leaving the task at the previous round with no owner or draft-start data.
    f.store.saveTask({
      ...first,
      state: 'needs_input',
      reason: 'AppError: POST /repos/acme/service/pulls/38/reviews: HTTP 502 Bad Gateway',
      round: first.round - 1,
      draftStart: undefined,
    });
    f.gitHub.account = 8;
    f.restart();
    for (let checks = 0; checks < 3; checks++) {
      f.ready();
      const waiting = await f.engine.review(id);
      expect(waiting.draftStart).toMatchObject({ marker });
      expect(waiting.draftStart?.owner).toBeUndefined();
      expect(waiting.state).toBe('queued');
    }
    expect(f.posts()).toBe(1);
    f.gitHub.account = 7;
    f.gitHub.reviews = [f.gitHub.draft];
    f.ready();
    expect((await f.engine.review(id)).review).toMatchObject({ marker, authorId: '7' });
    expect(f.posts()).toBe(1);
    expect(f.store.activeJobs(id)).toHaveLength(1);
  } finally {
    f.close();
  }
});

it('keeps the original owner and marker when the account and PR head change together', async () => {
  const f = await fixture();
  try {
    const first = await f.engine.review(f.task.id);
    f.gitHub.account = 8;
    f.pr.head = 'd'.repeat(40);
    f.ready();
    await expect(f.engine.review(f.task.id)).rejects.toMatchObject({ code: 'draft_owner_changed' });
    expect(f.store.getTask(f.task.id).draftStart).toMatchObject({
      marker: first.draftStart!.marker,
      revision,
      owner: '7',
    });
    expect(f.posts()).toBe(1);
    expect(f.deletes()).toBe(0);
  } finally {
    f.close();
  }
});

it.each(['COMMENTED', 'APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'])(
  'does not recreate a hidden review that was already %s',
  async (state) => {
    const f = await fixture();
    const id = f.task.id;
    try {
      const first = await f.engine.review(id);
      const marker = first.draftStart!.marker;
      Object.assign(f.gitHub.draft as object, { state });
      f.restart();
      for (let i = 0; i < 3; i++) {
        f.ready();
        expect((await f.engine.review(id)).draftStart?.marker).toBe(marker);
      }
      expect(f.posts()).toBe(1);
      f.gitHub.reviews = [f.gitHub.draft];
      f.ready();
      await expect(f.engine.review(id)).rejects.toMatchObject({ code: 'draft_changed' });
      expect(f.store.activeJobs(id)).toHaveLength(0);
      expect(f.posts()).toBe(1);
      expect((await f.engine.review(id, true)).carriedReviewFeedback?.reviews[0]?.id).toBe(
        '6060947228',
      );
    } finally {
      f.close();
    }
  },
);

const changes = {
  head: (pr: PullRequest) => {
    pr.head = 'd'.repeat(40);
  },
  base: (pr: PullRequest) => {
    pr.base = 'd'.repeat(40);
  },
  closed: (pr: PullRequest) => {
    pr.state = 'closed';
  },
  draft: (pr: PullRequest) => {
    pr.draft = true;
  },
  retargeted: (pr: PullRequest) => {
    pr.targetBranch = 'release';
  },
};

it.each(Object.entries(changes))(
  'keeps the intent across a late draft after PR change: %s',
  async (change, changePR) => {
    const f = await fixture();
    const id = f.task.id;
    try {
      const first = await f.engine.review(id);
      const marker = first.draftStart!.marker;
      const prBefore = { ...f.pr };
      f.gitHub.advanced = true;
      changePR(f.pr);
      f.ready();
      expect((await f.engine.review(id)).draftStart?.marker).toBe(marker);
      f.restart();
      f.ready();
      f.gitHub.reviews = [f.gitHub.draft];
      if (change !== 'head' && change !== 'base') {
        expect((await f.engine.review(id)).draftStart?.marker).toBe(marker);
        expect(f.store.activeJobs(id)).toHaveLength(0);
        expect(f.deletes()).toBe(0);
        Object.assign(f.pr, prBefore);
        f.ready();
      }
      if (change === 'head') {
        await expect(f.engine.review(id)).rejects.toMatchObject({ code: 'draft_changed' });
        expect(f.store.getTask(id).draftStart?.marker).toBe(marker);
        expect(f.deletes()).toBe(0);
      } else {
        const settled = await f.engine.review(id);
        expect(settled.review).toMatchObject({
          marker,
          id: '6060947228',
          revision: { base: f.pr.base },
        });
        expect(f.store.activeJobs(id)).toHaveLength(1);
      }
      expect(f.posts()).toBe(1);
    } finally {
      f.close();
    }
  },
);

it('drops an unused intent after the base is rewritten and starts a review of the current PR', async () => {
  const f = await fixture();
  const id = f.task.id;
  try {
    f.gitHub.listStatus = 502;
    const first = await f.engine.review(id);
    expect(f.posts()).toBe(0);
    f.restart();
    f.ready();
    f.gitHub.listStatus = 200;
    changes.base(f.pr);
    expect((await f.engine.review(id, true)).state).toBe('queued');
    f.gitHub.createStatus = 201;
    const started = await f.engine.review(id);
    expect(started.review?.marker).not.toBe(first.draftStart!.marker);
    expect(started.review?.revision.base).toBe(f.pr.base);
    expect(f.posts()).toBe(1);
  } finally {
    f.close();
  }
});

const invalidated = ['closed', 'draft', 'retargeted'] as const;

it.each(invalidated)('rechecks the PR after reading the recovered draft: %s', async (change) => {
  const f = await fixture();
  const id = f.task.id;
  try {
    const first = await f.engine.review(id);
    f.gitHub.advanced = true;
    changes.base(f.pr);
    f.gitHub.reviews = [f.gitHub.draft];
    f.gitHub.readComments = () => {
      changes[change](f.pr);
      return Response.json([]);
    };
    f.ready();
    const waiting = await f.engine.review(id);
    expect(waiting.state).toBe('queued');
    expect(waiting.draftStart?.marker).toBe(first.draftStart!.marker);
    expect(f.store.activeJobs(id)).toHaveLength(0);
    expect(f.deletes()).toBe(0);
  } finally {
    f.close();
  }
});

it.each(invalidated)(
  'rejects a recovered review at worker admission if the PR changes: %s',
  async (change) => {
    const f = await fixture();
    const id = f.task.id;
    try {
      await f.engine.review(id);
      f.gitHub.advanced = true;
      changes.base(f.pr);
      f.gitHub.reviews = [f.gitHub.draft];
      f.ready();
      const started = await f.engine.review(id);
      expect(started.state).toBe('reviewing');
      changes[change](f.pr);
      const workspaces = new Workspaces('/tmp');
      const prepare = vi.spyOn(workspaces, 'prepare').mockResolvedValue('/tmp');
      const runtime = new DemoRuntime();
      const run = vi.spyOn(runtime, 'run');
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
      try {
        await worker.tick();
        await vi.waitFor(() => expect(f.store.jobs(id).at(-1)?.errorCode).toBe('stale_revision'));
      } finally {
        await worker.stop();
      }
      expect(prepare).not.toHaveBeenCalled();
      expect(run).not.toHaveBeenCalled();
      expect(f.store.getTask(id).review?.id).toBe('6060947228');
      expect(f.deletes()).toBe(0);
    } finally {
      f.close();
    }
  },
);

it.each(['COMMENTED', 'APPROVED'])(
  'ignores an unrelated %s review with a null user',
  async (state) => {
    const f = await fixture();
    try {
      f.gitHub.reviews = [{ id: 999, user: null, state }];
      f.gitHub.createStatus = 201;
      expect((await f.engine.review(f.task.id)).state).toBe('reviewing');
      expect(f.posts()).toBe(1);
    } finally {
      f.close();
    }
  },
);

it.each(['PENDING', 'COMMENTED'])(
  'keeps uncertainty when a marked %s review has no known owner',
  async (state) => {
    const f = await fixture();
    try {
      const first = await f.engine.review(f.task.id);
      f.gitHub.reviews = [
        { id: 999, user: null, state, body: `<!-- ${first.draftStart!.marker} -->` },
      ];
      f.ready();
      const waiting = await f.engine.review(f.task.id);
      expect(waiting.state).toBe('queued');
      expect(f.posts()).toBe(1);
    } finally {
      f.close();
    }
  },
);

it.each(['', '{', '{}'])(
  'restores the draft after a successful HTTP response with unreadable body %j',
  async (body) => {
    const f = await fixture();
    try {
      f.gitHub.createStatus = 201;
      f.gitHub.createBody = body;
      const first = await f.engine.review(f.task.id);
      expect(first.state).toBe('queued');
      f.restart();
      f.ready();
      f.gitHub.reviews = [f.gitHub.draft];
      expect((await f.engine.review(f.task.id)).review?.id).toBe('6060947228');
      expect(f.store.activeJobs(f.task.id)).toHaveLength(1);
      expect(f.posts()).toBe(1);
    } finally {
      f.close();
    }
  },
);

it.each(['broken list JSON', 'non-array list', 'non-array comments', 'moved draft comments'])(
  'retries after unreadable data without counting an empty scan: %s',
  async (failure) => {
    const f = await fixture();
    try {
      const first = await f.engine.review(f.task.id);
      if (failure === 'broken list JSON') f.gitHub.listBody = '[';
      if (failure === 'non-array list') f.gitHub.listBody = '{}';
      if (failure.endsWith('comments')) {
        f.gitHub.reviews = [f.gitHub.draft];
        f.gitHub.readComments = () => Response.json({});
      }
      if (failure === 'moved draft comments') {
        f.gitHub.advanced = true;
        changes.base(f.pr);
      }
      f.ready();
      const waiting = await f.engine.review(f.task.id);
      expect(waiting.state).toBe('queued');
      f.ready();
      f.gitHub.listBody = undefined;
      f.gitHub.reviews = [f.gitHub.draft];
      f.gitHub.readComments = () => Response.json([]);
      expect((await f.engine.review(f.task.id)).review?.marker).toBe(first.draftStart!.marker);
      expect(f.store.activeJobs(f.task.id)).toHaveLength(1);
      expect(f.posts()).toBe(1);
    } finally {
      f.close();
    }
  },
);

it.each(['summary', 'comment', 'closed', 'retargeted'])(
  'preserves the recovered draft on an obsolete head during the final reads: %s',
  async (change) => {
    const f = await fixture();
    try {
      const initial = await f.engine.review(f.task.id);
      changes.head(f.pr);
      f.gitHub.reviews = [f.gitHub.draft];
      f.gitHub.override = (path) => {
        if (!path.endsWith('/reviews/6060947228')) return;
        if (change === 'summary')
          Object.assign(f.gitHub.draft as object, { body: 'Owner edited the review' });
        if (change === 'comment')
          f.gitHub.readComments = () => Response.json([{ id: 42, body: 'Owner comment' }]);
        if (change === 'closed' || change === 'retargeted') changes[change](f.pr);
      };
      f.ready();
      await Promise.allSettled([f.engine.review(f.task.id)]);
      expect(f.deletes()).toBe(0);
      expect(f.gitHub.draft).toMatchObject({ id: 6060947228 });
      expect(f.store.getTask(f.task.id).draftStart?.marker).toBe(initial.draftStart!.marker);
      expect(f.store.activeJobs(f.task.id)).toHaveLength(0);
    } finally {
      f.close();
    }
  },
);

it('confirms a legacy pending DELETE only through the review endpoint', async () => {
  const f = await fixture();
  const id = f.task.id;
  try {
    const initial = await f.engine.review(id);
    const marker = initial.draftStart!.marker;
    const body = (f.gitHub.draft as { body: string }).body;
    const deletion = marker + ':retire:6060947228';
    // Main archived the placeholder and completed the create receipt before dispatching DELETE.
    const review = { id: '6060947228', nodeId: 'draft', marker, revision, authorId: '7' };
    f.store.db
      .prepare("UPDATE operations SET status='done', result=? WHERE id=?")
      .run(JSON.stringify(review), marker);
    f.store.setSetting('review.archive:' + id + ':' + review.id, {
      status: 'draft',
      authorId: review.authorId,
      body,
      comments: [],
      revision,
      url: ref.url,
    });
    f.store.db.prepare('INSERT INTO operations VALUES(?,?,?,?,NULL)').run(
      deletion,
      id,
      'pending',
      createHash('sha256')
        .update(JSON.stringify({ review: '6060947228', head: revision.head, body }))
        .digest('hex'),
    );
    changes.head(f.pr);
    f.gitHub.reviews = [f.gitHub.draft];
    f.restart();
    f.ready();
    f.gitHub.readComments = () => new Response(null, { status: 404 });
    expect((await f.engine.review(id)).draftStart?.marker).toBe(marker);
    const receipt = f.store.db.prepare('SELECT status FROM operations WHERE id=?');
    expect(receipt.get(deletion)?.status).toBe('pending');
    f.ready();
    f.gitHub.draft = undefined;
    f.gitHub.reviews = [];
    expect((await f.engine.review(id)).draftStart).toBeUndefined();
    expect(receipt.get(deletion)?.status).toBe('done');
    expect(f.deletes()).toBe(0);
  } finally {
    f.close();
  }
});

it.each(Object.entries(changes))(
  'rechecks a recovered PR after workspace preparation: %s',
  async (_kind, changePR) => {
    const f = await fixture();
    const id = f.task.id;
    try {
      await f.engine.review(id);
      f.gitHub.advanced = true;
      changes.base(f.pr);
      f.gitHub.reviews = [f.gitHub.draft];
      f.ready();
      expect((await f.engine.review(id)).state).toBe('reviewing');
      const workspaces = new Workspaces('/tmp');
      const prepare = vi.spyOn(workspaces, 'prepare').mockImplementation(async () => {
        changePR(f.pr);
        if (f.pr.base === 'd'.repeat(40) && _kind === 'base') f.pr.base = 'e'.repeat(40);
        return '/tmp';
      });
      const runtime = new DemoRuntime();
      const run = vi.spyOn(runtime, 'run');
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
      try {
        await worker.tick();
        await vi.waitFor(() => expect(f.store.jobs(id).at(-1)?.errorCode).toBe('stale_revision'));
      } finally {
        await worker.stop();
      }
      expect(prepare).toHaveBeenCalledOnce();
      expect(run).not.toHaveBeenCalled();
      expect(f.store.getTask(id).review?.id).toBe('6060947228');
      expect(f.deletes()).toBe(0);
    } finally {
      f.close();
    }
  },
);

it.each([
  '/pulls/38',
  '/status',
  '/check-runs',
  '/git/ref/heads/',
  '/compare/',
  '/marked-review',
  '/comments',
])('defers recovery when the GitHub response has missing fields: %s', async (route) => {
  const f = await fixture(true);
  const id = f.task.id;
  try {
    const initial = await f.engine.review(id);
    f.gitHub.reviews = [f.gitHub.draft];
    if (route === '/compare/') changes.base(f.pr);
    if (route === '/marked-review')
      f.gitHub.reviews = [{ ...(f.gitHub.draft as object), commit_id: undefined }];
    else
      f.gitHub.override = (path) =>
        path.includes(route) && (route !== '/pulls/38' || path.endsWith(route))
          ? Response.json(route === '/comments' ? [{}] : {})
          : undefined;
    f.ready();
    const waiting = await f.engine.review(id);
    expect(waiting.state).toBe('queued');
    expect(waiting.draftStart?.marker).toBe(initial.draftStart!.marker);
    f.ready();
    f.gitHub.override = () => undefined;
    f.gitHub.reviews = [f.gitHub.draft];
    expect((await f.engine.review(id)).review?.id).toBe('6060947228');
    expect(f.posts()).toBe(1);
    expect(f.store.activeJobs(id)).toHaveLength(1);
  } finally {
    f.close();
  }
});

it.each(['preflight', 'quota', 'known draft'])(
  'allows explicit retry on a new target after %s',
  async (cause) => {
    const f = await fixture();
    const id = f.task.id;
    try {
      if (cause === 'preflight') f.gitHub.listStatus = 502;
      if (cause === 'quota') f.gitHub.createStatus = 429;
      const initial = await f.engine.review(id);
      changes.retargeted(f.pr);
      f.gitHub.listStatus = 200;
      f.gitHub.createStatus = 201;
      if (cause === 'known draft') f.gitHub.reviews = [f.gitHub.draft];
      f.ready();
      if (cause === 'known draft') {
        expect((await f.engine.review(id)).draftStart?.marker).toBe(initial.draftStart!.marker);
        f.ready();
        expect((await f.engine.review(id, true)).review?.id).toBe('6060947228');
        expect(f.posts()).toBe(1);
      } else {
        expect((await f.engine.review(id, true)).draftStart).toBeUndefined();
        expect((await f.engine.review(id)).review?.marker).not.toBe(initial.draftStart!.marker);
        expect(f.posts()).toBe(cause === 'quota' ? 2 : 1);
      }
      expect(f.store.getTask(id).pr?.targetBranch).toBe('release');
      expect(f.store.activeJobs(id)).toHaveLength(1);
    } finally {
      f.close();
    }
  },
);

it.each(['published', 'dismissed', 'removed'])(
  'starts the current review when the owner has %s an inspected draft',
  async (outcome) => {
    const f = await fixture();
    const id = f.task.id;
    try {
      const initial = await f.engine.review(id);
      const marker = initial.draftStart!.marker;
      changes.head(f.pr);
      f.gitHub.reviews = [f.gitHub.draft];
      Object.assign(f.gitHub.draft as object, { body: 'Edited review\n\n<!-- ' + marker + ' -->' });
      f.ready();
      await expect(f.engine.review(id)).rejects.toMatchObject({ code: 'draft_changed' });
      changes.retargeted(f.pr);
      if (outcome === 'removed') {
        f.gitHub.draft = undefined;
        f.gitHub.reviews = [];
      } else {
        Object.assign(f.gitHub.draft as object, {
          state: outcome === 'dismissed' ? 'DISMISSED' : 'COMMENTED',
        });
        f.gitHub.readComments = () => Response.json([{ id: 42, body: 'Published finding' }]);
      }
      f.restart();
      f.ready();
      expect((await f.engine.review(id, true)).draftStart).toBeUndefined();
      f.gitHub.createStatus = 201;
      const next = await f.engine.review(id);
      expect(next.review?.revision.head).toBe(f.pr.head);
      expect(next.review?.marker).not.toBe(marker);
      if (outcome !== 'removed')
        expect(next.feedback?.comments).toMatchObject([{ id: '42', body: 'Published finding' }]);
      expect(f.deletes()).toBe(0);
      expect(f.posts()).toBe(2);
    } finally {
      f.close();
    }
  },
);

it('does not trust an earlier completed deletion receipt while the review still exists', async () => {
  const f = await fixture();
  const id = f.task.id;
  try {
    const initial = await f.engine.review(id);
    const marker = initial.draftStart!.marker;
    const body = (f.gitHub.draft as { body: string }).body;
    changes.head(f.pr);
    f.gitHub.reviews = [f.gitHub.draft];
    const request = { review: '6060947228', head: revision.head, body };
    f.store.db
      .prepare('INSERT INTO operations VALUES(?,?,?,?,?)')
      .run(
        marker + ':retire:6060947228',
        id,
        'done',
        createHash('sha256').update(JSON.stringify(request)).digest('hex'),
        'null',
      );
    f.ready();
    await expect(f.engine.review(id)).rejects.toMatchObject({ code: 'draft_changed' });
    expect(f.store.getTask(id).draftStart?.marker).toBe(marker);
    expect(f.deletes()).toBe(0);
  } finally {
    f.close();
  }
});

it('remembers an edited draft on the same revision for a later explicit retry', async () => {
  const f = await fixture();
  const id = f.task.id;
  try {
    const initial = await f.engine.review(id);
    f.gitHub.reviews = [f.gitHub.draft];
    f.gitHub.readComments = () => Response.json([{ id: 42, body: 'Review finding' }]);
    f.ready();
    await expect(f.engine.review(id)).rejects.toMatchObject({ code: 'draft_changed' });
    Object.assign(f.gitHub.draft as object, { state: 'COMMENTED' });
    f.restart();
    f.ready();
    const waiting = await f.engine.review(id, true);
    expect(waiting.draftStart).toBeUndefined();
    expect(waiting.feedback?.comments).toMatchObject([{ id: '42' }]);
    f.gitHub.createStatus = 201;
    expect((await f.engine.review(id)).review?.marker).not.toBe(initial.draftStart!.marker);
    expect(f.deletes()).toBe(0);
  } finally {
    f.close();
  }
});

it.each(['short head', 'empty head', 'target sha', 'merge base sha', 'review sha', 'draft node'])(
  'waits for complete GitHub identity before reusing the draft: %s',
  async (change) => {
    const f = await fixture(true);
    const id = f.task.id;
    try {
      const initial = await f.engine.review(id);
      f.gitHub.reviews = [f.gitHub.draft];
      if (change === 'merge base sha') changes.base(f.pr);
      if (change === 'draft node') {
        f.gitHub.reviews = [{ ...(f.gitHub.draft as object), node_id: undefined }];
      } else {
        f.gitHub.override = (path) => {
          if ((change === 'short head' || change === 'empty head') && path.endsWith('/pulls/38'))
            return Response.json({
              head: { sha: change === 'short head' ? f.pr.head.slice(0, 9) : '', ref: f.pr.branch },
              base: { sha: f.pr.base, ref: f.pr.targetBranch },
              state: 'open',
              draft: false,
              merged: false,
            });
          if (change === 'target sha' && path.includes('/git/ref/heads/'))
            return Response.json({ ref: 'refs/heads/main', object: { type: 'commit', sha: '' } });
          if (change === 'merge base sha' && path.includes('/compare/'))
            return Response.json({ status: 'ahead', merge_base_commit: { sha: '' } });
          if (change === 'review sha' && path.endsWith('/reviews/6060947228'))
            return Response.json({ ...(f.gitHub.draft as object), commit_id: '' });
        };
      }
      f.ready();
      const waiting = await f.engine.review(id);
      expect(waiting.state).toBe('queued');
      expect(waiting.draftStart?.marker).toBe(initial.draftStart!.marker);
      expect(f.store.activeJobs(id)).toHaveLength(0);
      f.gitHub.override = () => undefined;
      f.gitHub.reviews = [f.gitHub.draft];
      f.ready();
      expect((await f.engine.review(id)).review?.id).toBe('6060947228');
      expect(f.posts()).toBe(1);
      expect(f.deletes()).toBe(0);
    } finally {
      f.close();
    }
  },
);

function startWorker(
  f: Awaited<ReturnType<typeof fixture>>,
  prepareWorkspace = async () => '/tmp',
) {
  const workspaces = new Workspaces('/tmp');
  const prepare = vi.spyOn(workspaces, 'prepare').mockImplementation(prepareWorkspace);
  const runtime = new DemoRuntime();
  const run = vi.spyOn(runtime, 'run').mockResolvedValue({
    status: 'incomplete',
    checkedHead: f.pr.head,
    summary: 'Runtime test double',
  });
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
  return { worker, run, prepare };
}

it.each([
  ['before', '{}'],
  ['before', '{'],
  ['after', '{}'],
  ['after', '{'],
])('requeues a malformed PR read %s workspace preparation: %s', async (phase, body) => {
  const f = await fixture(true);
  const id = f.task.id;
  try {
    await f.engine.review(id);
    f.gitHub.reviews = [f.gitHub.draft];
    f.ready();
    await f.engine.review(id);
    f.restart();
    let broken = true;
    let reads = 0;
    f.gitHub.override = (path) =>
      path.endsWith('/pulls/38') && broken && ++reads === (phase === 'before' ? 1 : 2)
        ? new Response(body)
        : undefined;
    const { worker, run } = startWorker(f);
    try {
      await worker.tick();
      await vi.waitFor(() =>
        expect(f.store.jobs(id).at(-1)).toMatchObject({
          status: 'queued',
          errorCode: 'provider_shape',
        }),
      );
      expect(run).not.toHaveBeenCalled();
      expect(f.store.getTask(id).state).toBe('reviewing');
      expect(f.store.getTask(id).draftHandoff).toBe('6060947228');
      broken = false;
      const job = f.store.jobs(id).at(-1)!;
      f.store.saveJob({ ...job, notBefore: undefined });
      await worker.tick();
      await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
      expect(run.mock.calls[0][0].task.review?.id).toBe('6060947228');
      expect(f.posts()).toBe(1);
    } finally {
      await worker.stop();
    }
  } finally {
    f.close();
  }
});

const draftChanges = ['published', 'deleted', 'summary', 'comment'] as const;
function changeDraft(
  f: Awaited<ReturnType<typeof fixture>>,
  change: (typeof draftChanges)[number],
) {
  if (change === 'published') Object.assign(f.gitHub.draft as object, { state: 'COMMENTED' });
  if (change === 'deleted') f.gitHub.draft = undefined;
  if (change === 'summary')
    Object.assign(f.gitHub.draft as object, { body: 'Owner edited the draft' });
  if (change === 'comment')
    f.gitHub.readComments = () => Response.json([{ id: 42, body: 'Owner comment' }]);
}

it.each(draftChanges)(
  'rechecks the matched draft by ID after reading the PR: %s',
  async (change) => {
    const f = await fixture();
    const id = f.task.id;
    try {
      const initial = await f.engine.review(id);
      f.gitHub.reviews = [f.gitHub.draft];
      let reads = 0;
      f.gitHub.readPR = () => {
        if (++reads === 2) changeDraft(f, change);
      };
      f.ready();
      const [result] = await Promise.allSettled([f.engine.review(id)]);
      if (change === 'deleted') expect(result.status).toBe('fulfilled');
      else expect(result).toMatchObject({ status: 'rejected', reason: { code: 'draft_changed' } });
      expect(f.store.getTask(id).draftStart?.marker).toBe(initial.draftStart!.marker);
      expect(f.store.activeJobs(id)).toHaveLength(0);
      expect(f.deletes()).toBe(0);
    } finally {
      f.close();
    }
  },
);

it.each(draftChanges)(
  'validates the recovered draft by ID after preparing the workspace: %s',
  async (change) => {
    const f = await fixture();
    const id = f.task.id;
    try {
      await f.engine.review(id);
      f.gitHub.reviews = [f.gitHub.draft];
      f.ready();
      expect((await f.engine.review(id)).draftHandoff).toBe('6060947228');
      const { worker, run } = startWorker(f, async () => {
        changeDraft(f, change);
        return '/tmp';
      });
      try {
        await worker.tick();
        await vi.waitFor(() => expect(f.store.jobs(id).at(-1)?.status).toBe('failed'));
        expect(run).not.toHaveBeenCalled();
        expect(f.store.getTask(id)).toMatchObject({
          state: 'needs_input',
          draftHandoff: '6060947228',
        });
        expect(f.deletes()).toBe(0);
      } finally {
        await worker.stop();
      }
    } finally {
      f.close();
    }
  },
);

it.each(['removed', 'edited', 'unchanged', 'summary only'])(
  'refreshes published feedback by review ID before building the new context: %s',
  async (edit) => {
    const f = await fixture();
    const id = f.task.id;
    try {
      const initial = await f.engine.review(id);
      const original = f.gitHub.draft as { state: string; body: string };
      changes.retargeted(f.pr);
      f.gitHub.reviews = [original];
      original.state = 'COMMENTED';
      original.body = 'Original published summary\n\n<!-- ' + initial.draftStart!.marker + ' -->';
      let comments = edit === 'summary only' ? [] : [{ id: 45, body: 'Original finding' }];
      f.gitHub.readComments = () => Response.json(comments);
      f.ready();
      expect((await f.engine.review(id, true)).carriedReviewFeedback?.reviews[0]?.id).toBe(
        '6060947228',
      );
      f.gitHub.nextId = 6060947229;
      f.gitHub.createStatus = 201;
      expect((await f.engine.review(id)).review?.id).toBe('6060947229');
      f.restart();
      f.gitHub.override = (path) =>
        path.endsWith('/reviews/6060947228') ? Response.json(original) : undefined;
      const { worker, run } = startWorker(f, async () => {
        if (edit === 'removed') comments = [];
        if (edit === 'edited') {
          original.body = 'Updated published summary';
          comments = [{ id: 45, body: 'Updated finding' }];
        }
        return '/tmp';
      });
      try {
        await worker.tick();
        await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
        const { task, prompt } = run.mock.calls[0][0];
        expect(task.feedback?.comments).toMatchObject(
          comments.map(({ id, body }) => ({ id: String(id), body })),
        );
        expect(task.feedback?.comments).toHaveLength(comments.length);
        expect(prompt).toContain(
          edit === 'edited' ? 'Updated published summary' : 'Original published summary',
        );
        if (edit !== 'unchanged') expect(prompt).not.toContain('Original finding');
      } finally {
        await worker.stop();
      }
    } finally {
      f.close();
    }
  },
);

it('retries the same marker after GitHub explicitly refuses to create a second pending draft', async () => {
  const f = await fixture();
  const id = f.task.id;
  try {
    f.gitHub.override = (_path, method) =>
      method === 'POST'
        ? Response.json(
            { message: 'User can only have one pending review per pull request' },
            { status: 422 },
          )
        : undefined;
    const first = await f.engine.review(id);
    expect(first.state).toBe('queued');
    f.ready();
    f.gitHub.override = () => undefined;
    f.gitHub.createStatus = 201;
    expect((await f.engine.review(id)).review?.marker).toBe(first.draftStart!.marker);
    expect(f.posts()).toBe(2);
    expect(f.store.activeJobs(id)).toHaveLength(1);
  } finally {
    f.close();
  }
});
