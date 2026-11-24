import { describe, it, expect, vi } from 'vitest';
import { GitHubProvider } from '../src/providers/github.js';
import { GitLabProvider } from '../src/providers/gitlab.js';
import { Engine } from '../src/core/engine.js';
import { Store } from '../src/core/store.js';
import { ProviderHttp, type Fetch } from '../src/providers/http.js';
import { parsePR, tag } from '../src/providers/provider.js';
import type { ReviewHandle } from '../src/core/types.js';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  it.each([
    'regular',
    'unavailable before creation',
    'another pending review',
    'another account has a pending review',
    'pending review appeared before POST',
    'unclear POST rejection',
    'completed review then deleted',
    'completed review then published',
    'completed review then dismissed',
    'pending review then dismissed',
    'dismissed successor to a processed review',
    'reopen after publication',
    'base changed after the second response was lost',
    'base changed before retrying the deleted review',
    'lost response on current revision',
    'lost response',
    'lost response and new base',
    'lost response before reconcile',
    'legacy intent',
    'legacy intent after reconcile',
    'legacy intent with revision history',
  ] as const)('preserves the old GitHub draft when retrying (%s)', async (scenario) => {
    const store = new Store(':memory:');
    const pull = '/repos/acme/service/pulls/12';
    let branch = 'main';
    let base = revision.base;
    let head = revision.head;
    let attempts = 0;
    let summaryEdits = 0;
    const lostSecondResponse =
      scenario === 'base changed after the second response was lost' ||
      scenario === 'base changed before retrying the deleted review';
    let reviewsAvailable = scenario !== 'unavailable before creation';
    let hasOtherReview =
      scenario === 'another pending review' || scenario === 'another account has a pending review';
    const otherReview = {
      id: 90,
      node_id: 'PRR_90',
      body: 'Manual review',
      commit_id: head,
      user: { id: scenario === 'another pending review' ? 7 : 8 },
      state: 'PENDING',
    };
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
    let previousDraft: typeof draft;
    const http = transport((path, method, body) => {
      if (path === pull)
        return {
          state: 'open',
          title: 'Changes',
          head: {
            sha: head,
            ref: 'fix',
            repo: { clone_url: 'https://github.com/acme/service.git' },
          },
          base: { sha: base, ref: branch },
        };
      if (path.startsWith('/repos/acme/service/git/ref/heads/'))
        return { ref: 'refs/heads/' + branch, object: { type: 'commit', sha: base } };
      if (path.includes('/check-runs?')) return { check_runs: [] };
      if (path.includes('/status?')) return { statuses: [] };
      if (path === '/user') return { id: 7 };
      if (path.startsWith(`${pull}/reviews?`)) {
        if (!reviewsAvailable) return new Response('{}', { status: 503 });
        return [
          ...(previousDraft ? [previousDraft] : []),
          ...(draft ? [draft] : []),
          ...(hasOtherReview ? [otherReview] : []),
        ];
      }
      if (path.includes('/comments?')) {
        const dismissedId = scenario === 'dismissed successor to a processed review' ? 2 : 1;
        if (
          ['pending review then dismissed', 'dismissed successor to a processed review'].includes(
            scenario,
          ) &&
          path.startsWith(`${pull}/reviews/${dismissedId}/comments?`)
        )
          return [{ id: 202, body: 'Outstanding finding', html_url: ref.url }];
        if (
          (scenario === 'completed review then published' ||
            scenario === 'completed review then dismissed') &&
          path.startsWith(`${pull}/reviews/1/comments?`)
        )
          return [{ id: 202, body: 'Review this finding on the new base', html_url: ref.url }];
        if (lostSecondResponse && path.startsWith(`${pull}/reviews/2/comments?`))
          return [{ id: 203, body: 'Finding from the second review', html_url: ref.url }];
        return [];
      }
      if (method === 'GET' && previousDraft && path === `${pull}/reviews/${previousDraft.id}`)
        return previousDraft;
      if (method === 'GET' && path.startsWith(`${pull}/reviews/`))
        return draft && path === `${pull}/reviews/${draft.id}`
          ? draft
          : new Response('{}', { status: 404 });
      if (method === 'PUT' && path === `${pull}/reviews/${draft?.id}` && draft) {
        summaryEdits++;
        draft.body = body.body;
        return draft;
      }
      if (method === 'POST' && path === `${pull}/reviews`) {
        attempts++;
        if (attempts === 1 && scenario === 'pending review appeared before POST') {
          hasOtherReview = true;
          otherReview.user.id = 7;
          return new Response(
            JSON.stringify({
              message: 'Validation Failed',
              errors: [
                {
                  resource: 'PullRequestReview',
                  code: 'custom',
                  message: 'User can only have one pending review per pull request',
                },
              ],
            }),
            { status: 422 },
          );
        }
        if (scenario === 'unclear POST rejection')
          return new Response('{"message":"Validation Failed"}', { status: 422 });
        if (
          draft?.state === 'PENDING' ||
          (hasOtherReview && otherReview.user.id === 7 && otherReview.state === 'PENDING')
        )
          return new Response('{}', { status: 422 });
        draft = {
          id: attempts,
          node_id: `PRR_${attempts}`,
          body: body.body,
          commit_id: head,
          user: { id: 7 },
          state: 'PENDING',
        };
        if (
          attempts === 1 &&
          (scenario.startsWith('lost response') ||
            scenario.startsWith('legacy intent') ||
            scenario === 'pending review then dismissed')
        )
          throw new Error('Lost create response');
        if (attempts === 2 && lostSecondResponse) throw new Error('Lost second create response');
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
      if (scenario === 'pending review then dismissed') {
        await expect(engine.review(task.id)).rejects.toThrow('Lost create response');
        draft!.state = 'DISMISSED';
        const next = await new Engine(store, () => provider).review(task.id, true);
        expect(next).toMatchObject({ state: 'reviewing', round: 2 });
        expect(next.feedback?.comments.map(({ id }) => id)).toEqual(['202']);
        expect(store.db.prepare("SELECT id FROM operations WHERE status='pending'").all()).toEqual(
          [],
        );
        return;
      }
      if (
        scenario === 'dismissed successor to a processed review' ||
        scenario === 'reopen after publication'
      ) {
        const initial = await engine.review(task.id);
        store.cancelJobs(task.id);
        draft!.state = 'COMMENTED';
        const snapshot = await provider.getReview(ref, initial.review!);
        store.event(task.id, 'review.published', { reviewId: initial.review!.id, snapshot });
        const original = {
          ...initial,
          snapshot,
          reviewFinished: true,
          state: 'awaiting_checks' as const,
        };
        previousDraft = draft;
        if (scenario === 'reopen after publication') {
          store.saveTask({ ...original, state: 'complete' });
          await engine.action(task.id, 'reopen');
          expect(await engine.review(task.id)).toMatchObject({
            state: 'reviewing',
            review: { id: '2' },
          });
          return;
        }
        store.saveTask(original);
        base = 'e'.repeat(40);
        await engine.review(task.id, true);
        store.cancelJobs(task.id);
        store.saveTask(original);
        draft!.state = 'DISMISSED';
        base = 'f'.repeat(40);
        const next = await new Engine(store, () => provider).review(task.id, true);
        expect(next).toMatchObject({ state: 'reviewing', review: { id: '3' } });
        expect(next.feedback?.comments.map(({ id }) => id)).toEqual(['202']);
        return;
      }
      if (
        scenario === 'completed review then deleted' ||
        scenario === 'completed review then published' ||
        scenario === 'completed review then dismissed' ||
        lostSecondResponse
      ) {
        await engine.review(task.id);
        // Restore the task row as it was before the completed create result was attached.
        store.cancelJobs(task.id);
        store.saveTask(task);
        expect(
          store.db.prepare("SELECT id FROM operations WHERE status='done'").all(),
        ).toHaveLength(1);
        if (scenario === 'completed review then deleted' || lostSecondResponse) draft = undefined;
        else
          draft!.state = scenario === 'completed review then dismissed' ? 'DISMISSED' : 'COMMENTED';
        if (scenario !== 'base changed after the second response was lost') base = 'e'.repeat(40);
        const restarted = new Engine(store, () => provider);
        if (lostSecondResponse) {
          await expect(restarted.review(task.id, true)).rejects.toThrow(
            'Lost second create response',
          );
          expect(store.getTask(task.id).round).toBe(1);
          draft!.state = 'COMMENTED';
          base = 'f'.repeat(40);
          const recovered = new Engine(store, () => provider);
          expect(await recovered.review(task.id, true)).toMatchObject({
            state: 'needs_input',
            review: { id: '2' },
          });
          expect(attempts).toBe(2);
          const next = await recovered.review(task.id, true);
          expect(next).toMatchObject({
            state: 'reviewing',
            review: { id: '3', revision: { base } },
          });
          expect(next.feedback?.comments.map(({ id }) => id)).toEqual(['203']);
          await recovered.completeJob(store.claim()!, {
            status: 'completed',
            summary: 'Review complete',
            checkedHead: head,
          });
          expect(store.getTask(task.id).state).toBe('needs_input');
          return;
        }
        if (scenario === 'completed review then published') {
          expect(await restarted.review(task.id, true)).toMatchObject({
            state: 'needs_input',
            review: { id: '1' },
          });
        }
        const next = await restarted.review(task.id, true);
        expect(next).toMatchObject({ state: 'reviewing', review: { id: '2', revision: { base } } });
        expect(
          http.mock.calls.some(([url]) => new URL(String(url)).pathname === `${pull}/reviews/1`),
        ).toBe(true);
        if (
          scenario === 'completed review then published' ||
          scenario === 'completed review then dismissed'
        )
          expect(next.feedback?.comments.map(({ id }) => id)).toEqual(['202']);
        if (scenario === 'completed review then dismissed') {
          await restarted.completeJob(store.claim()!, {
            status: 'completed',
            summary: 'Review complete',
            checkedHead: head,
          });
          expect(store.getTask(task.id).state).toBe('needs_input');
        }
        expect(attempts).toBe(2);
        return;
      }
      if (
        scenario === 'pending review appeared before POST' ||
        scenario === 'unclear POST rejection'
      ) {
        await expect(engine.review(task.id)).rejects.toMatchObject({
          code: scenario === 'unclear POST rejection' ? 'provider_422' : 'existing_drafts',
        });
        const restarted = new Engine(store, () => provider);
        if (scenario === 'unclear POST rejection') {
          expect(
            store.db.prepare("SELECT id FROM operations WHERE status='pending'").all(),
          ).toHaveLength(1);
          await expect(restarted.review(task.id, true)).rejects.toMatchObject({
            code: 'ambiguous_write',
          });
          expect(attempts).toBe(1);
        } else {
          expect(
            store.db.prepare("SELECT id FROM operations WHERE status='pending'").all(),
          ).toEqual([]);
          otherReview.state = 'COMMENTED';
          base = 'e'.repeat(40);
          expect(await restarted.review(task.id, true)).toMatchObject({
            state: 'reviewing',
            review: { id: '2', revision: { base } },
          });
          expect(attempts).toBe(2);
        }
        return;
      }
      if (hasOtherReview) {
        if (scenario === 'another pending review') {
          await expect(engine.review(task.id)).rejects.toMatchObject({ code: 'existing_drafts' });
          expect(attempts).toBe(0);
          expect(
            store.db.prepare("SELECT id FROM operations WHERE status='pending'").all(),
          ).toEqual([]);
          otherReview.state = 'COMMENTED';
          base = 'e'.repeat(40);
        }
        const next = await new Engine(store, () => provider).review(task.id, true);
        expect(next).toMatchObject({ state: 'reviewing', review: { id: '1', revision: { base } } });
        expect(attempts).toBe(1);
        return;
      }
      if (scenario === 'unavailable before creation') {
        await expect(engine.review(task.id)).rejects.toMatchObject({ code: 'provider_503' });
        expect(attempts).toBe(0);
        expect(store.db.prepare("SELECT id FROM operations WHERE status='pending'").all()).toEqual(
          [],
        );
        reviewsAvailable = true;
        base = 'e'.repeat(40);
        const restarted = new Engine(store, () => provider);
        const next = await restarted.review(task.id, true);
        expect(next).toMatchObject({ state: 'reviewing', review: { id: '1', revision: { base } } });
        expect(store.busy(task.id)).toBe(true);
        expect(attempts).toBe(1);
        return;
      }
      if (scenario !== 'regular') {
        if (scenario === 'legacy intent with revision history')
          store.event(task.id, 'revision.changed', {
            revision: task.revision,
            generation: task.generation,
          });
        await expect(engine.review(task.id)).rejects.toThrow('Lost create response');
        if (scenario === 'lost response on current revision') {
          expect(
            store.db.prepare("SELECT id FROM operations WHERE status='pending'").all(),
          ).toHaveLength(1);
          const restarted = new Engine(store, () => provider);
          const next = await restarted.review(task.id, true);
          expect(next).toMatchObject({
            state: 'reviewing',
            review: { id: '1', targetBranch: 'main' },
          });
          expect(attempts).toBe(1);
          return;
        }
        const legacy = scenario.startsWith('legacy intent');
        if (legacy) {
          store.db
            .prepare(
              "UPDATE events SET data=json_remove(data, '$.targetBranch', '$.revision') WHERE type='operation.started'",
            )
            .run();
        }
        branch = scenario === 'legacy intent' ? 'main' : 'release';
        const movedBase =
          scenario === 'lost response and new base' ||
          scenario === 'lost response before reconcile' ||
          (legacy && scenario !== 'legacy intent');
        if (movedBase) base = 'e'.repeat(40);
        if (scenario === 'legacy intent after reconcile') head = 'f'.repeat(40);
        if (scenario === 'lost response before reconcile' || (legacy && movedBase))
          expect(await engine.reconcile(task.id)).toMatchObject({ revision: { base } });
        const restarted = new Engine(store, () => provider);
        const held = await restarted.review(task.id, true);
        expect(held.state).toBe('needs_input');
        expect(held.review?.id).toBe('1');
        expect(held.review?.targetBranch).toBe(legacy ? undefined : 'main');
        expect(held.review?.revision.base).toBe(
          scenario === 'legacy intent after reconcile' ? '' : revision.base,
        );
        expect(held.reason).toContain(legacy ? 'no recorded target branch' : 'release');
        expect(draft?.state).toBe('PENDING');
        expect(store.busy(task.id)).toBe(false);
        if (movedBase) {
          if (scenario !== 'legacy intent after reconcile') expect(held.reason).toContain(base);
          expect(await restarted.review(task.id, true)).toMatchObject({
            state: 'needs_input',
            review: { id: held.review?.id, revision: held.review?.revision },
          });
          expect(attempts).toBe(1);
        }
        if (scenario === 'legacy intent after reconcile') {
          expect(held.revision?.head).toBe(head);
          expect(held.review?.revision.head).toBe(revision.head);
          await restarted.chat(task.id, 'reviewer', 'Inspect the recovered draft');
          const chat = store.claim()!;
          expect(await restarted.broker.call(chat, 'read_review', {})).toMatchObject({
            status: 'draft',
            revision: { head: revision.head },
          });
          await expect(
            restarted.broker.call(chat, 'set_summary', { body: 'Review of release' }),
          ).rejects.toMatchObject({ code: 'stale_revision' });
          await expect(
            restarted.broker.call(chat, 'record_decision', {
              commentId: '202',
              outcome: 'withdrawn',
              reason: 'Appears resolved',
            }),
          ).rejects.toMatchObject({ code: 'stale_revision' });
          expect(store.decisions(task.id)).toEqual([]);
          expect(summaryEdits).toBe(0);
          store.saveJob({ ...chat, status: 'completed' });
        }
        draft = undefined;
        const retried = await restarted.review(task.id, true);
        expect(retried).toMatchObject({
          state: 'reviewing',
          review: { targetBranch: branch, id: '2', revision: { base } },
        });
        if (scenario === 'legacy intent after reconcile') {
          expect(retried.review?.revision.head).toBe(head);
          const job = store.claim()!;
          await restarted.broker.call(job, 'set_summary', { body: 'Review of release' });
          await expect(
            restarted.broker.call(job, 'record_decision', {
              commentId: '202',
              outcome: 'verified',
              reason: 'Checked on release',
            }),
          ).resolves.toMatchObject({ head, targetBranch: 'release', outcome: 'verified' });
          expect(summaryEdits).toBe(1);
        }
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
  });

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
  it.each([
    [false, 'dirty', true],
    [null, 'unknown', false],
    [true, 'blocked', false],
    [true, 'behind', false],
    [true, 'unstable', false],
  ] as const)(
    'distinguishes GitHub conflict from other merge blockers (%s, %s)',
    async (mergeable, state, conflict) => {
      const http = transport((path) => {
        if (path.includes('/pulls/'))
          return {
            head: { sha: revision.head },
            base: { sha: revision.base, ref: 'main' },
            state: 'open',
            mergeable,
            mergeable_state: state,
          };
        if (path === '/repos/acme/service/git/ref/heads/main')
          return { ref: 'refs/heads/main', object: { type: 'commit', sha: revision.base } };
        return path.includes('/status') ? { statuses: [] } : { check_runs: [] };
      });
      expect((await new GitHubProvider('github.com', 'fake', http).getPR(ref)).mergeConflict).toBe(
        conflict,
      );
    },
  );
  it('pins an open PR to the live target ref and keeps the historical base after closure', async () => {
    const tip = 'c'.repeat(40);
    let state = 'open';
    const http = transport((path) => {
      if (path.includes('/pulls/'))
        return {
          head: { sha: revision.head },
          base: { ref: 'release/v1', sha: revision.base },
          state,
          merged: state === 'closed',
        };
      if (path.endsWith('/git/ref/heads/release/v1'))
        return { ref: 'refs/heads/release/v1', object: { type: 'commit', sha: tip } };
      return path.includes('/status') ? { statuses: [] } : { check_runs: [] };
    });
    const github = new GitHubProvider('github.com', 'fake', http);
    expect(await github.getPR(ref)).toMatchObject({ base: tip, start: tip, head: revision.head });
    state = 'closed';
    expect(await github.getPR(ref)).toMatchObject({
      base: revision.base,
      start: revision.base,
      state: 'merged',
    });
    expect(http.mock.calls.filter(([url]) => String(url).includes('/git/ref/'))).toHaveLength(1);
  });
  it('keeps identically named checks from distinct GitHub workflows', async () => {
    const http = transport((path) => {
      if (path.includes('/pulls/'))
        return {
          head: { sha: revision.head },
          base: { sha: revision.base, ref: 'main' },
          state: 'open',
        };
      if (path === '/repos/acme/service/git/ref/heads/main')
        return { ref: 'refs/heads/main', object: { type: 'commit', sha: revision.base } };
      if (path.includes('/status')) return { statuses: [] };
      return {
        check_runs: [
          { name: 'test', check_suite: { id: 1 }, status: 'completed', conclusion: 'success' },
          { name: 'test', check_suite: { id: 2 }, status: 'in_progress' },
        ],
      };
    });
    expect((await new GitHubProvider('github.com', 'fake', http).getPR(ref)).checks).toBe(
      'pending',
    );
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
      if (path === '/repos/acme/service/git/ref/heads/main')
        return { ref: 'refs/heads/main', object: { type: 'commit', sha: revision.base } };
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
  it.each(['draft read failed', 'writer locked database', 'baseline insert failed'] as const)(
    'starts a review on the current GitLab base after %s',
    async (scenario) => {
      const dir = mkdtempSync(join(tmpdir(), 'daddyloop-review-intent-'));
      const filename = join(dir, 'db.sqlite');
      const store = new Store(filename);
      const writer = new DatabaseSync(filename);
      store.db.exec('PRAGMA busy_timeout=0');
      let locked = false;
      const mr = `/api/v4/projects/${encodeURIComponent(ref.repo)}/merge_requests/${ref.number}`;
      let fail = true;
      let base = revision.base;
      let creates = 0;
      const http = transport((path, method, body) => {
        if (path === mr)
          return {
            title: 'Changes',
            state: 'opened',
            source_branch: 'fix',
            target_branch: 'main',
            source_project_id: 3,
            diff_refs: { head_sha: revision.head, base_sha: base, start_sha: revision.start },
          };
        if (path === '/api/v4/projects/3')
          return { http_url_to_repo: 'https://gitlab.example.com/team/subgroup/service.git' };
        if (path === '/api/v4/user') return { id: 7 };
        if (path.startsWith(`${mr}/draft_notes?`)) {
          if (fail && scenario === 'draft read failed') return new Response('{}', { status: 503 });
          if (fail && scenario === 'writer locked database') {
            writer.exec('BEGIN IMMEDIATE');
            locked = true;
          }
          return [];
        }
        if (path.startsWith(`${mr}/notes?`))
          return [{ id: 103, note: 'Previous finding', author_id: 7 }];
        if (method === 'POST' && path === `${mr}/draft_notes`) {
          expect(
            writer.prepare("SELECT status FROM operations WHERE status='pending'").all(),
          ).toEqual([{ status: 'pending' }]);
          expect(
            writer
              .prepare(
                "SELECT json_extract(data, '$.noteId') AS noteId FROM events WHERE type='review.note_baseline'",
              )
              .all(),
          ).toEqual([{ noteId: 103 }]);
          return { id: ++creates, note: body.note, author_id: 7 };
        }
        throw new Error(`Unexpected fixture request ${method} ${path}`);
      });
      const provider = new GitLabProvider(ref.host, 'fake', http);
      const engine = new Engine(store, () => provider);
      try {
        const task = await engine.create({
          ref,
          repoPath: '/tmp',
          requirements: 'Review the change',
        });
        if (scenario === 'baseline insert failed')
          store.db.exec(`
        CREATE TRIGGER fail_baseline BEFORE INSERT ON events WHEN NEW.type='review.note_baseline'
        BEGIN SELECT RAISE(ABORT, 'baseline insert failed'); END
      `);
        const reason = {
          'draft read failed': /503/,
          'writer locked database': /locked/,
          'baseline insert failed': /baseline insert failed/,
        };
        await expect(engine.review(task.id)).rejects.toThrow(reason[scenario]);
        if (locked) {
          writer.exec('ROLLBACK');
          locked = false;
        }
        if (scenario === 'baseline insert failed') store.db.exec('DROP TRIGGER fail_baseline');
        expect(creates).toBe(0);
        expect(store.db.prepare("SELECT id FROM operations WHERE status='pending'").all()).toEqual(
          [],
        );
        expect(
          store
            .events(task.id)
            .filter(({ type }) => type === 'operation.started' || type === 'review.note_baseline'),
        ).toEqual([]);
        fail = false;
        base = 'e'.repeat(40);
        const next = await new Engine(store, () => provider).review(task.id, true);
        expect(next).toMatchObject({ state: 'reviewing', review: { id: '1', revision: { base } } });
        expect(creates).toBe(1);
      } finally {
        if (locked) writer.exec('ROLLBACK');
        writer.close();
        store.close();
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
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
    ['restore', 'published successor'],
    ['restore', 'deleted'],
    ['restore', 'delete summary'],
    ['restore', 'partial'],
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
      if (status === 'published successor') {
        store.cancelJobs(task.id);
        publishDrafts();
        const snapshot = await provider.getReview(ref, old);
        store.event(task.id, 'review.published', { reviewId: old.id, snapshot });
        const original = {
          ...queued,
          snapshot,
          reviewFinished: true,
          state: 'awaiting_checks' as const,
        };
        store.saveTask(original);
        branch = 'release';
        const second = await engine.review(task.id, true);
        store.cancelJobs(task.id);
        store.saveTask(original);
        drafts = [];
        const published = { ...finding, note: tag(`${second.review!.marker}:comment:R2`) };
        notes.push(published);
        notes.push({ id: 999, note: 'An unrelated note', author_id: 7 });
        const restarted = new Engine(store, () => provider);
        expect(await restarted.review(task.id, true)).toMatchObject({ state: 'needs_input' });
        expect(creates).toBe(2);
        notes.pop();
        const next = await restarted.review(task.id, true);
        expect(next).toMatchObject({ state: 'reviewing', review: { targetBranch: 'release' } });
        expect(next.feedback?.comments.map(({ id }) => id)).toEqual(['107']);
        return;
      }
      if (entry === 'restore') {
        store.cancelJobs(task.id);
        store.saveTask({ ...task, feedback: prior });
        drafts = [];
        if (status !== 'deleted') notes.push(finding);
        const restarted = new Engine(store, () => provider);
        if (status === 'partial') {
          drafts.push({ id: 108, note: tag(`${old.marker}:comment:R3`), author_id: 7 });
          expect(await restarted.review(task.id, true)).toMatchObject({ state: 'needs_input' });
          expect(creates).toBe(1);
          drafts = [];
        }
        const next = await restarted.review(task.id, true);
        expect(next).toMatchObject({ state: 'reviewing', round: 2, review: { revision } });
        expect(next.feedback?.comments.map(({ id }) => id)).toEqual(
          status === 'deleted' ? ['103'] : ['103', '107'],
        );
        expect(creates).toBe(2);
        return;
      }
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
      const expected = status === 'draft' ? ['103'] : ['103', '107'];
      expect(next.feedback?.comments.map(({ id }) => id)).toEqual(expected);
      expect(creates).toBe(2);
      const reviewer = store.claim()!;
      await engine.completeJob(reviewer, {
        status: 'completed',
        summary: 'Reviewed the new target',
        checkedHead: head,
        verifiedCommentIds: [status === 'delete summary' ? '107' : '103'],
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

it('uses a permitted merge method and submits exactly the reviewed head to GitHub', async () => {
  const http = transport((path, method, body) => {
    if (method === 'GET' && path === '/repos/acme/service')
      return { allow_squash_merge: false, allow_merge_commit: false, allow_rebase_merge: true };
    expect([method, path, body]).toEqual([
      'PUT',
      '/repos/acme/service/pulls/12/merge',
      { sha: revision.head, merge_method: 'rebase' },
    ]);
    return { merged: true, sha: 'merged-commit' };
  });
  const write = await new GitHubProvider('github.com', 'fake', http).prepareMerge(ref);
  await expect(write(revision.head)).resolves.toBe('merged-commit');
});
