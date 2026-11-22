import { describe, it, expect, vi } from 'vitest';
import { GitHubProvider } from '../src/providers/github.js';
import { GitLabProvider } from '../src/providers/gitlab.js';
import { Engine } from '../src/core/engine.js';
import { Store } from '../src/core/store.js';
import { ProviderHttp, type Fetch } from '../src/providers/http.js';
import { parsePR, tag } from '../src/providers/provider.js';
import type { ReviewHandle } from '../src/core/types.js';
const revision = {
  head: 'a'.repeat(40),
  base: 'b'.repeat(40),
  start: 'c'.repeat(40),
};
const ref = parsePR('https://github.com/acme/service/pull/12');
function transport(
  handler: (path: string, method: string, body: Record<string, unknown>) => unknown,
) {
  const spy = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url)),
      method = init?.method ?? 'GET';
    const result = handler(
      u.pathname + u.search,
      method,
      init?.body ? JSON.parse(String(init.body)) : {},
    );
    return result instanceof Response
      ? result
      : new Response(JSON.stringify(result), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
  });
  return spy as typeof spy & Fetch;
}
describe('GitHub draft review contract', () => {
  it.each(['regular', 'lost response', 'legacy intent'] as const)(
    'preserves the old GitHub draft when retrying (%s)',
    async (scenario) => {
      const store = new Store(':memory:');
      const pull = '/repos/acme/service/pulls/12';
      let branch = 'main';
      let attempts = 0;
      let draft:
        | {
            id: number;
            node_id: string;
            body: unknown;
            commit_id: string;
            user: { id: number };
            state: string;
          }
        | undefined;
      const http = transport((path, method, body) => {
        if (path === pull)
          return {
            state: 'open',
            title: 'Changes',
            head: {
              sha: revision.head,
              ref: 'fix',
              repo: { clone_url: 'https://github.com/acme/service.git' },
            },
            base: { sha: revision.base, ref: branch },
          };
        if (path.includes('/check-runs?')) return { check_runs: [] };
        if (path.includes('/status?')) return { statuses: [] };
        if (path === '/user') return { id: 7 };
        if (path.startsWith(`${pull}/reviews?`)) return draft ? [draft] : [];
        if (path.includes('/comments?')) return [];
        if (method === 'GET' && path.startsWith(`${pull}/reviews/`))
          return draft ?? new Response('{}', { status: 404 });
        if (method === 'POST' && path === `${pull}/reviews`) {
          attempts++;
          if (draft) return new Response('{}', { status: 422 });
          draft = {
            id: attempts,
            node_id: `PRR_${attempts}`,
            body: body.body,
            commit_id: revision.head,
            user: { id: 7 },
            state: 'PENDING',
          };
          if (attempts === 1 && scenario !== 'regular') throw new Error('Lost create response');
          return draft;
        }
        throw new Error(`Unexpected fixture request ${method} ${path}`);
      });
      const provider = new GitHubProvider('github.com', 'fake', http);
      const engine = new Engine(store, () => provider);
      try {
        const task = await engine.create({
          ref,
          repoPath: '/tmp',
          requirements: 'Check the target branch',
        });
        if (scenario !== 'regular') {
          await expect(engine.review(task.id)).rejects.toThrow('Lost create response');
          if (scenario === 'legacy intent') {
            store.db
              .prepare(
                "UPDATE events SET data=json_remove(data, '$.targetBranch') WHERE type='operation.started'",
              )
              .run();
          }
          branch = scenario === 'lost response' ? 'release' : 'main';
          const restarted = new Engine(store, () => provider);
          const held = await restarted.review(task.id, true);
          expect(held.state).toBe('needs_input');
          expect(held.review?.id).toBe('1');
          expect(held.review?.targetBranch).toBe(scenario === 'lost response' ? 'main' : undefined);
          expect(held.reason).toContain(
            scenario === 'lost response' ? 'release' : 'no recorded target branch',
          );
          expect(draft?.state).toBe('PENDING');
          expect(store.busy(task.id)).toBe(false);
          draft = undefined;
          const retried = await restarted.review(task.id, true);
          expect(retried).toMatchObject({
            state: 'reviewing',
            review: { targetBranch: branch, id: '2' },
          });
          return;
        }
        const original = await engine.review(task.id);
        branch = 'release';
        await engine.reconcile(task.id);
        const operations = store.db.prepare('SELECT id, status FROM operations').all();
        const blocked = await engine.review(task.id, true);
        expect(blocked).toMatchObject({
          state: 'needs_input',
          generation: original.generation,
          review: original.review,
        });
        for (const value of ['main', 'release', 'GitHub', 'draft'])
          expect(blocked.reason).toContain(value);
        expect(attempts).toBe(1);
        expect(store.db.prepare('SELECT id, status FROM operations').all()).toEqual(operations);
        expect(await provider.getReview(ref, original.review!)).toMatchObject({ status: 'draft' });

        draft = undefined;
        const next = await engine.review(task.id, true);
        expect(next).toMatchObject({ state: 'reviewing', review: { targetBranch: 'release' } });
        expect(next.review?.id).not.toBe(original.review?.id);
        expect(attempts).toBe(2);
      } finally {
        store.close();
      }
    },
  );

  it('does not adopt another account’s review based only on a matching marker', async () => {
    const http = transport((path) =>
      path === '/user' ? { id: 7 } : [{ id: 44, body: tag('daddyloop:t:1'), user: { id: 999 } }],
    );
    expect(
      await new GitHubProvider('github.com', 'fake', http).findReview(ref, 'daddyloop:t:1'),
    ).toBeUndefined();
  });
  it('creates a pending review on an explicit revision and publishes as COMMENT', async () => {
    const calls: { method: string; body: Record<string, unknown> }[] = [];
    const http = transport((path, method, body) => {
      if (path === '/user') return { id: 7 };
      if (method === 'GET') return [];
      calls.push({ method, body });
      return {
        id: 33,
        node_id: 'PRR_33',
        commit_id: revision.head,
        user: { id: 7 },
        body: body.body,
        state: 'PENDING',
      };
    });
    const provider = new GitHubProvider('github.com', 'fake', http);
    const review = await provider.createReview(ref, revision, 'daddyloop:task:1');
    expect(calls[0].body).toEqual({
      commit_id: revision.head,
      body: 'Review in progress.\n\n<!-- daddyloop:task:1 -->',
    });
    expect(calls[0].body).not.toHaveProperty('event');
    await provider.publish(ref, review);
    expect(calls[1].body).toEqual({ event: 'COMMENT' });
  });
  it('creates inline comments inside the pending review without flattening Markdown', async () => {
    let input: Record<string, unknown> = {};
    const http = transport((_path, _method, body) => {
      input = (body.variables as { input: Record<string, unknown> }).input;
      return {
        data: {
          addPullRequestReviewThread: {
            thread: {
              comments: {
                nodes: [
                  {
                    databaseId: 1,
                    body: input.body,
                    url: ref.url,
                    path: input.path,
                    line: input.line,
                  },
                ],
              },
            },
          },
        },
      };
    });
    const provider = new GitHubProvider('github.com', 'fake', http),
      review: ReviewHandle = {
        id: '33',
        nodeId: 'PRR_33',
        marker: 'daddyloop:task:1',
        revision,
      };
    const body = 'See [contract](https://example.com).\n```suggestion\nreturn null;\n```';
    await provider.createComment(ref, review, body, 'R1', {
      path: 'old name.ts',
      line: 9,
      startLine: 7,
      side: 'LEFT',
    });
    expect(input.pullRequestReviewId).toBe('PRR_33');
    expect(input.body).toBe(`${body}\n\n<!-- R1 -->`);
    expect(input.startSide).toBe('LEFT');
  });
  it('does not infer success from a failed or stale CI run', async () => {
    const http = transport((path) => {
      if (path === '/repos/acme/service/pulls/12')
        return {
          title: 'Fix',
          body: '',
          head: {
            sha: revision.head,
            ref: 'feature',
            repo: { clone_url: 'https://github.com/acme/service.git' },
          },
          base: { sha: revision.base, ref: 'main' },
          state: 'open',
        };
      if (path.includes('/status')) return { statuses: [{ context: 'unit', state: 'failure' }] };
      return {
        check_runs: [{ name: 'lint', status: 'completed', conclusion: 'success' }],
        total_count: 1,
      };
    });
    expect((await new GitHubProvider('github.com', 'fake', http).getPR(ref)).checks).toBe(
      'failing',
    );
  });
});
describe('GitLab draft notes contract', () => {
  const ref = parsePR('https://gitlab.example.com/team/subgroup/service/-/merge_requests/9');
  it.each([
    ['retarget', 'draft'],
    ['retarget', 'partial'],
    ['retarget', 'published'],
    ['retarget', 'delete summary'],
    ['resume', 'draft'],
    ['resume', 'partial'],
    ['resume', 'published'],
    ['resume', 'lost create response'],
    ['resume', 'draft appears before POST'],
  ] as const)('handles the old GitLab review before %s (%s)', async (entry, status) => {
    const store = new Store(':memory:');
    const mr = `/api/v4/projects/${encodeURIComponent(ref.repo)}/merge_requests/${ref.number}`;
    let branch = 'main';
    let head = revision.head;
    const savedHead = 'd'.repeat(40);
    let creates = 0;
    let loseResponse = false;
    let lateDraftRead = 0;
    type Note = { id: number; note: string; author_id: number };
    let drafts: Note[] = [];
    const notes: Note[] = [{ id: 103, note: 'First round finding', author_id: 7 }];
    const http = transport((path, method, body) => {
      if (path === mr)
        return {
          title: 'Changes',
          state: 'opened',
          source_branch: 'fix',
          target_branch: branch,
          source_project_id: 3,
          diff_refs: {
            head_sha: head,
            base_sha: revision.base,
            start_sha: revision.start,
          },
        };
      if (path === '/api/v4/projects/3')
        return { http_url_to_repo: 'https://gitlab.example.com/team/subgroup/service.git' };
      if (path === '/api/v4/user') return { id: 7 };
      if (path.startsWith(`${mr}/draft_notes?`)) {
        if (lateDraftRead && --lateDraftRead === 0)
          return [{ id: 200, note: 'Manual note', author_id: 7 }];
        return drafts;
      }
      if (path.startsWith(`${mr}/notes?`)) return notes;
      if (method === 'POST' && path === `${mr}/draft_notes`) {
        const draft = { id: 104 + 10 * creates++, note: String(body.note), author_id: 7 };
        drafts.push(draft);
        if (loseResponse) throw new Error('Lost create response');
        return draft;
      }
      throw new Error(`Unexpected fixture request ${method} ${path}`);
    });
    const provider = new GitLabProvider(ref.host, 'fake', http);
    const engine = new Engine(store, () => provider);
    const publishDrafts = () => {
      notes.push(...drafts);
      drafts = [];
    };
    try {
      const task = await engine.create({
        ref,
        repoPath: '/tmp',
        requirements: 'Check the target branch',
      });
      const queued = await engine.review(task.id);
      const old = queued.review!;
      const prior = {
        status: 'published' as const,
        body: '',
        revision,
        url: ref.url,
        comments: [{ id: '103', body: 'First round finding', url: ref.url }],
      };
      store.saveTask({ ...queued, feedback: prior });
      const finding = {
        id: 107,
        note: `Second round finding\n\n${tag(`${old.marker}:comment:R2`)}`,
        author_id: 7,
      };
      if (status === 'partial' || status === 'delete summary') notes.push(finding);
      else drafts.push(finding);
      const recovery = status === 'lost create response' || status === 'draft appears before POST';
      if (status === 'published' || recovery) publishDrafts();
      if (entry === 'retarget') {
        branch = 'release';
        await engine.reconcile(task.id);
      } else {
        store.cancelJobs(task.id);
        const author = store.enqueue(queued, 'author', 'fix', 'Fix the first finding');
        store.saveJob({ ...author, status: 'cancelled' });
        store.event(
          task.id,
          'author.feedback_snapshot',
          { ...prior, targetBranch: branch },
          author.id,
        );
        store.event(task.id, 'author.fixes_saved', { head: savedHead, revision }, author.id);
        store.saveTask({
          ...queued,
          state: 'needs_input',
          generation: queued.generation + 1,
          feedback: prior,
        });
        head = savedHead;
      }
      const retry = () =>
        entry === 'resume' ? engine.action(task.id, 'resume') : engine.review(task.id, true);

      const operations = store.db.prepare('SELECT id, status FROM operations').all();
      if (status !== 'published' && !recovery) {
        const blocked = await retry();
        expect(blocked).toMatchObject({ state: 'needs_input', review: old });
        const expected = entry === 'resume' ? ['GitLab', savedHead] : ['main', 'release', 'GitLab'];
        for (const value of expected) expect(blocked.reason).toContain(value);
        expect(creates).toBe(1);
        expect(store.db.prepare('SELECT id, status FROM operations').all()).toEqual(operations);
        if (status === 'draft' || status === 'delete summary') drafts = [];
        else publishDrafts();
      }
      const resumed = await retry();
      if (status === 'lost create response') {
        loseResponse = true;
        await expect(engine.review(task.id)).rejects.toThrow('Lost create response');
        loseResponse = false;
      } else if (status === 'draft appears before POST') {
        lateDraftRead = 2;
        await expect(engine.review(task.id)).rejects.toMatchObject({ code: 'existing_drafts' });
        expect(creates).toBe(1);
        expect(store.db.prepare("SELECT id FROM operations WHERE status='pending'").all()).toEqual(
          [],
        );
      }
      const next = recovery
        ? await new Engine(store, () => provider).review(task.id, true)
        : entry === 'resume'
          ? await engine.review(task.id)
          : resumed;
      expect(next).toMatchObject({
        state: 'reviewing',
        review: { targetBranch: branch, revision: { head } },
      });
      expect(next.feedback?.comments.map(({ id }) => id)).toEqual([
        status === 'draft' ? '103' : '107',
      ]);
      expect(creates).toBe(2);
      const reviewer = store.claim()!;
      await engine.completeJob(reviewer, {
        status: 'completed',
        summary: 'Reviewed the new target',
        checkedHead: head,
        verifiedCommentIds: ['103'],
      });
      expect(store.getTask(task.id).state).toBe(
        status === 'draft' ? 'awaiting_publication' : 'needs_input',
      );
    } finally {
      store.close();
    }
  });

  const review: ReviewHandle = {
    id: '5',
    marker: 'daddyloop:t:1',
    revision,
    authorId: '7',
    baselineNoteId: 100,
  };
  it('encodes nested workspace paths and attaches the correct three diff SHAs', async () => {
    let received: Record<string, unknown> = {},
      url = '';
    const http = transport((path, _method, body) => {
      url = path;
      received = body;
      return { id: 6, note: body.note, position: body.position };
    });
    await new GitLabProvider(ref.host, 'fake', http).createComment(
      ref,
      review,
      'Repro',
      'daddyloop:t:1:comment:R1',
      { path: 'new.ts', oldPath: 'old.ts', line: 4, side: 'LEFT' },
    );
    expect(url).toContain('team%2Fsubgroup%2Fservice');
    expect(received.position).toMatchObject({
      head_sha: revision.head,
      base_sha: revision.base,
      start_sha: revision.start,
      old_line: 4,
      old_path: 'old.ts',
      new_path: 'new.ts',
    });
  });
  it('publishes only tracked notes with summary last, never bulk_publish', async () => {
    const writes: string[] = [];
    const http = transport((path, method) => {
      if (method === 'GET')
        return [
          { id: 5, note: tag(review.marker) },
          { id: 6, note: tag(`${review.marker}:comment:R1`) },
        ];
      writes.push(path);
      return {};
    });
    await new GitLabProvider(ref.host, 'fake', http).publish(ref, review);
    expect(writes.map((p) => p.split('/').slice(-2).join('/'))).toEqual(['6/publish', '5/publish']);
    expect(writes.join()).not.toContain('bulk_publish');
  });
  it('does not publish unrelated human drafts', async () => {
    const http = transport(() => [
      { id: 5, note: tag(review.marker) },
      { id: 9, note: 'unrelated note' },
    ]);
    await expect(
      new GitLabProvider(ref.host, 'fake', http).publish(ref, review),
    ).rejects.toMatchObject({ code: 'untracked_drafts' });
    expect(http).toHaveBeenCalledTimes(1);
  });
  it('detects partial publication and never releases it as a complete review', async () => {
    const http = transport((path) =>
      path.includes('draft_notes')
        ? [{ id: 5, note: tag(review.marker) }]
        : [
            {
              id: 101,
              author: { id: 7 },
              body: tag(`${review.marker}:comment:R1`),
            },
          ],
    );
    const result = await new GitLabProvider(ref.host, 'fake', http).getReview(ref, review);
    expect(result.status).toBe('partial');
  });
  it('stops on untracked native additions rather than silently dropping them', async () => {
    const http = transport((path) =>
      path.includes('draft_notes')
        ? []
        : [
            { id: 101, author: { id: 7 }, body: tag(review.marker) },
            { id: 102, author: { id: 7 }, body: 'An extra human note' },
          ],
    );
    expect((await new GitLabProvider(ref.host, 'fake', http).getReview(ref, review)).status).toBe(
      'partial',
    );
  });
});
it('paginates all comments and never follows a provider redirect with credentials', async () => {
  const http = transport((path) =>
    /[?&]page=1(?:&|$)/.test(path)
      ? Array.from({ length: 100 }, (_, id) => ({ id }))
      : [{ id: 100 }],
  );
  const client = new ProviderHttp('https://api.github.com', { Authorization: 'fake' }, http);
  expect(await client.pages('/comments')).toHaveLength(101);
  expect(http.mock.calls[0][1]?.redirect).toBe('error');
});
it('rejects malformed PR URLs, credentials and path traversal', () => {
  for (const url of [
    'http://github.com/a/b/pull/1',
    'https://token@github.com/a/b/pull/1',
    'https://github.com/a/b/pull/0',
    'https://github.com/a/b/pull/1?token=x',
    'https://github.com/a/b/pull/1#discussion',
  ])
    expect(() => parsePR(url)).toThrow();
  expect(parsePR('https://gitlab.com/a/b/c/-/merge_requests/1').repo).toBe('a/b/c');
});
