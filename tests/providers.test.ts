import { ArcadiaProvider } from '../src/providers/arcadia.js';
import { ArcBridge } from '../src/integrations/arcadia.js';
import { DemoRuntime } from '../src/runtime/demo.js';
import { Worker } from '../src/runtime/worker.js';
import { prRef } from '../src/core/types.js';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git, Workspaces } from '../src/runtime/workspaces.js';
import { allRepositories } from '../src/modules/repositories/index.js';
import { fixture } from './helpers.js';
import { findingVersion } from '../src/core/review-decisions.js';
import { Store } from '../src/core/store.js';
import { describe, it, expect, vi } from 'vitest';
import { GitHubProvider } from '../src/providers/github.js';
import { GitLabProvider } from '../src/providers/gitlab.js';
import { ProviderHttp, type Fetch } from '../src/providers/http.js';
import { parsePR, tag, type ReviewProvider } from '../src/providers/provider.js';
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
  it('uses the pending review comment node for edits and removals on GitHub Enterprise', async () => {
    const review = { id: '33', nodeId: 'PRR_33', marker: 'service', revision };
    const item = { id: '4686809856', nodeId: 'PRRC_opaque', body: 'Original', url: ref.url };
    const recorded: string[] = [];
    const http = transport((path, method, body) => {
      expect([method, path]).toEqual(['POST', '/api/graphql']);
      const input = (body.variables as { input: Record<string, string> }).input;
      recorded.push(String(body.query));
      if (input.body) {
        expect(input.pullRequestReviewCommentId).toBe(item.nodeId);
        return {
          data: {
            updatePullRequestReviewComment: {
              pullRequestReviewComment: { id: item.nodeId, body: input.body, url: item.url },
            },
          },
        };
      }
      expect(input.id).toBe(item.nodeId);
      return {
        data: { deletePullRequestReviewComment: { clientMutationId: input.clientMutationId } },
      };
    });
    const provider = new GitHubProvider('ghe.example', 'fake', http);
    expect(await provider.updateComment(ref, review, item.id, '**Rechecked**', item)).toMatchObject(
      { id: item.id, body: '**Rechecked**' },
    );
    await provider.deleteComment(ref, review, item.id, item);
    expect(recorded[0]).toContain('updatePullRequestReviewComment');
    expect(recorded[1]).toContain('deletePullRequestReviewComment');
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

it('shares GitHub quota deadlines across provider instances and permits ordinary forbidden responses to be handled separately', async () => {
  const store = new Store(':memory:');
  const reset = Math.ceil(Date.now() / 1000) + 120;
  const limited = transport(
    () =>
      new Response('{"message":"API rate limit exceeded"}', {
        status: 403,
        headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) },
      }),
  );
  const normal = transport(
    () => new Response('{"message":"Resource not accessible by integration"}', { status: 403 }),
  );
  try {
    const a = new GitHubProvider('github.com', 'fake', limited, store);
    await expect(a.http.request('GET', '/user')).rejects.toMatchObject({
      code: 'github_rate_limit',
      until: reset * 1000 + 1000,
      refusedWrite: false,
    });
    const b = new GitHubProvider('github.com', 'fake', normal, store);
    await expect(b.http.request('PUT', '/repos/a/b')).rejects.toMatchObject({
      code: 'github_rate_limit',
      refusedWrite: true,
    });
    expect(normal).not.toHaveBeenCalled();
    vi.useFakeTimers();
    vi.setSystemTime(reset * 1000 + 2000);
    await expect(b.http.request('GET', '/user')).rejects.toMatchObject({ code: 'provider_403' });
    expect(normal).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
    store.close();
  }
});

it('persists backoff for transient GitHub reads and does not treat a failed mutation as a safe retry', async () => {
  const store = new Store(':memory:');
  const calls = vi.fn(
    () =>
      new Response('temporarily unavailable', { status: 503, headers: { 'retry-after': '35' } }),
  );
  const p = new GitHubProvider('github.com', 'fake', transport(calls), store);
  try {
    await expect(p.http.request('POST', '/graphql', {})).rejects.toMatchObject({
      code: 'provider_503',
    });
    const start = Date.now();
    await expect(p.http.request('GET', '/repos/test/repo')).rejects.toMatchObject({
      code: 'github_read_unavailable',
      refusedWrite: false,
    });
    const deadline = store.setting<{ until: number }>('github.read-backoff:github.com')!.until;
    expect(deadline).toBeGreaterThanOrEqual(start + 35000);
    const afterRestart = new GitHubProvider('github.com', 'fake', transport(calls), store);
    await expect(afterRestart.http.request('POST', '/graphql', {})).rejects.toMatchObject({
      code: 'github_read_unavailable',
      until: deadline,
      refusedWrite: true,
    });
    expect(calls).toHaveBeenCalledTimes(2);
  } finally {
    store.close();
  }
});

it('keeps the native GitHub range in the version of a published finding', async () => {
  const review = { id: '33', marker: 'review', revision };
  let start = 5;
  const http = transport((path) =>
    path.includes('/comments')
      ? [{ id: 19, body: 'Same finding', path: 'file.ts', line: 10, start_line: start }]
      : { id: 33, state: 'COMMENTED', commit_id: revision.head, user: { id: 7 } },
  );
  const provider = new GitHubProvider(ref.host, 'fake', http);
  const before = (await provider.getReview(ref, review)).comments[0];
  start = 8;
  const after = (await provider.getReview(ref, review)).comments[0];
  expect(before.location).toMatchObject({ startLine: 5, line: 10 });
  expect(after.location).toMatchObject({ startLine: 8, line: 10 });
  expect(findingVersion(after)).not.toBe(findingVersion(before));
});

it('reads a merged GitLab fork with separate source and target clone URLs', async () => {
  const mr = parsePR('https://gitlab.com/team/target/-/merge_requests/9');
  const project = (id: number) => `https://gitlab.com/team/project-${id}.git`;
  let diffHead = revision.base;
  const http = transport((path) => {
    if (path.endsWith('/projects/22')) return { http_url_to_repo: project(22) };
    if (path.endsWith('/projects/33')) return { http_url_to_repo: project(33) };
    return {
      sha: revision.head,
      diff_refs: { head_sha: diffHead, base_sha: revision.base, start_sha: revision.start },
      source_project_id: 22,
      target_project_id: 33,
      state: 'merged',
      source_branch: 'worker',
      target_branch: 'main',
      merge_commit_sha: 'd'.repeat(40),
      head_pipeline: null,
    };
  });
  const provider = new GitLabProvider(mr.host, 'fake', http);
  await expect(provider.getPR(mr)).rejects.toMatchObject({ code: 'diff_unavailable' });
  diffHead = revision.head;
  expect(await provider.getPR(mr)).toMatchObject({
    ...revision,
    cloneUrl: project(22),
    targetCloneUrl: project(33),
    branch: 'worker',
    mergeCommit: 'd'.repeat(40),
  });
});

it('prepares a merged GitLab fork on its source head and fetches the result from the target', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'daddyloop-gitlab-fork-'));
  const source = join(dir, 'source'),
    target = join(dir, 'target');
  mkdirSync(source);
  const f = await fixture();
  try {
    const commit = (cwd: string, subject: string) =>
      git(
        [
          '-c',
          'user.name=Fixture',
          '-c',
          'user.email=test@local',
          'commit',
          '--allow-empty',
          '-m',
          subject,
        ],
        cwd,
      );
    await git(['init'], source);
    await commit(source, 'H1');
    const base = await git(['rev-parse', 'HEAD'], source);
    await commit(source, 'H2');
    const head = await git(['rev-parse', 'HEAD'], source);
    await git(['clone', source, target], dir);
    // The integration object exists only in the target project.
    await commit(target, 'Integrated result');
    const mergeCommit = await git(['rev-parse', 'HEAD'], target);
    await expect(git(['cat-file', '-t', mergeCommit], source)).rejects.toThrow();
    const sourceUrl = 'https://gitlab.com/team/fork.git';
    const targetUrl = 'https://gitlab.com/team/target.git';
    const gitlab = parsePR('https://gitlab.com/team/target/-/merge_requests/9');
    const http = transport((path) => {
      if (path.endsWith('/projects/22')) return { http_url_to_repo: sourceUrl };
      if (path.endsWith('/projects/33')) return { http_url_to_repo: targetUrl };
      return {
        sha: head,
        diff_refs: { head_sha: head, base_sha: base, start_sha: base },
        source_project_id: 22,
        target_project_id: 33,
        state: 'merged',
        source_branch: 'worker',
        target_branch: 'main',
        merge_commit_sha: mergeCommit,
        head_pipeline: null,
      };
    });
    const provider = new GitLabProvider(gitlab.host, 'fake', http);
    const pr = await provider.getPR(gitlab);
    const repositories = allRepositories();
    const transportModule = repositories.get('gitlab').git!;
    const credentials = vi.spyOn(transportModule, 'environment').mockImplementation((remote) => ({
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: `url.file://${remote.url === targetUrl ? target : source}.insteadOf`,
      GIT_CONFIG_VALUE_0: remote.url,
    }));
    try {
      const task = { ...f.task, ref: gitlab, repoPath: source, revision: pr, pr };
      const reviewer = await new Workspaces(join(dir, 'data'), repositories).prepare(
        task,
        'reviewer',
      );
      expect(await git(['rev-parse', 'HEAD'], reviewer)).toBe(head);
      expect(await git(['cat-file', '-t', mergeCommit], reviewer)).toBe('commit');
      expect(pr.cloneUrl).toBe(sourceUrl);
      expect(credentials.mock.calls.map(([remote]) => remote.url)).toEqual([targetUrl]);
    } finally {
      credentials.mockRestore();
    }
  } finally {
    f.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it.each(
  ['gitlab', 'arcadia'].flatMap((vcs) =>
    ['unchanged', 'edited before review', 'edited during review'].map((phase) => ({ vcs, phase })),
  ),
)(
  'checks the previous $vcs publication beside a new draft with the finding $phase',
  async ({ vcs, phase }) => {
    const f = await fixture();
    const workspaces = new Workspaces('/tmp');
    const task = f.store.getTask(f.task.id);
    const target = {
      ...task.revision!,
      head: 'e'.repeat(40),
      ...(vcs === 'arcadia' && { revisionId: '2' }),
    };
    const authorId = vcs === 'arcadia' ? 'worker' : '7';
    const old: ReviewHandle = {
      id: '10',
      authorId,
      marker: 'daddyloop:old',
      nodeId: '1',
      baselineNoteId: 8,
      revision: { ...task.revision!, ...(vcs === 'arcadia' && { revisionId: '1' }) },
    };
    task.ref.provider = vcs;
    const exact = 'Current wording\n\n```ts\ncheck();\n```\n' + tag(old.marker + ':comment:old');
    const edited = 'Replaced Markdown without the marker.\n\n```ts\ncheckAgain();\n```';
    let wording = exact;
    let oldFindingDraft = false;
    let otherDraft = false;
    let next: ReviewHandle | undefined;
    let nextPublished = false;
    const note = (id: number, body: string, draft: boolean) => ({
      id,
      body,
      content: body,
      is_draft: draft,
      author: { id: 7, name: 'worker' },
    });
    const notes = () => [
      note(10, tag(old.marker), false),
      note(11, wording, oldFindingDraft),
      ...(next ? [note(-20, tag(next.marker), !nextPublished)] : []),
      ...(otherDraft ? [note(vcs === 'gitlab' ? 11 : -21, 'Foreign draft', true)] : []),
    ];
    const http = transport((path, method) => {
      if (method === 'PUT' && path.endsWith('/draft_notes/-20/publish')) {
        nextPublished = true;
        return {};
      }
      expect(method).toBe('GET');
      return notes().filter((n) => n.is_draft === path.includes('draft_notes'));
    });
    const bridge = new ArcBridge();
    vi.spyOn(bridge, 'api').mockImplementation(async <T>(args: string[]) => {
      if (args[0] === 'draft-comment' && args[1] === 'publish') {
        expect(args[2]).toBe('--comment-for-review-ids=-20');
        nextPublished = true;
        return {} as T;
      }
      expect(args[1]).toBe('comments');
      return (args[0] === 'pr' ? notes() : []) as T;
    });
    const native =
      vcs === 'arcadia'
        ? new ArcadiaProvider(bridge)
        : new GitLabProvider('gitlab.example.com', 'fake', http);
    const snapshot = await native.getReview(prRef(task), old);
    expect(snapshot.status).toBe('published');
    f.engine.setFeedback(task, snapshot, old);
    f.store.setSetting('demo-pr:1', { ...task.pr, ...target });
    task.revision = target;
    task.pr = { ...task.pr!, ...target };
    f.store.saveTask(task);
    f.store.event(task.id, 'review.published', { reviewId: old.id, handle: old, snapshot });
    vi.spyOn(f.provider as ReviewProvider, 'createReview').mockImplementation(
      async (_ref, revision, marker) => {
        next = { id: '-20', marker, revision, authorId, nodeId: '2', baselineNoteId: 11 };
        return next;
      },
    );
    vi.spyOn(f.provider, 'getReview').mockImplementation(native.getReview.bind(native));
    vi.spyOn(f.provider, 'publish').mockImplementation(native.publish.bind(native));
    vi.spyOn(workspaces, 'prepare').mockResolvedValue('/tmp');
    let runs = 0;
    if (phase === 'edited before review') wording = edited;
    const run = vi.fn(async (input: Parameters<DemoRuntime['run']>[0]) => {
      expect(input.task.revision?.head).toBe(target.head);
      runs++;
      expect(input.task.feedback?.comments).toEqual(
        snapshot.comments.map((comment) => ({ ...comment, body: wording })),
      );
      if (phase === 'edited during review') wording = edited;
      return {
        status: 'completed' as const,
        summary: 'Verified',
        checkedHead: target.head,
        verifiedCommentIds:
          phase === 'unchanged' || runs > 1 ? snapshot.comments.map((c) => c.id) : [],
      };
    });
    const worker = new Worker(f.engine, workspaces, { run }, new DemoRuntime(), () => ({
      ok: true,
      reasons: [],
      diskAvailableGiB: 20,
      diskUsedPercent: 20,
      memoryAvailableGiB: 10,
      memoryTotalGiB: 20,
    }));
    try {
      await worker.tick();
      const changed = phase !== 'unchanged';
      await vi.waitFor(() =>
        expect(f.store.getTask(task.id).state).toBe(
          changed ? 'needs_input' : 'awaiting_publication',
        ),
      );
      expect(run).toHaveBeenCalledOnce();
      if (changed) {
        expect(f.store.getTask(task.id).reviewFinished).toBeFalsy();
        await expect(f.engine.publish(task.id)).rejects.toMatchObject({
          code: 'publication_unavailable',
        });
        await f.engine.review(task.id, true);
        await worker.tick();
        await vi.waitFor(() => expect(f.store.getTask(task.id).state).toBe('awaiting_publication'));
        expect(run).toHaveBeenCalledTimes(2);
        expect(
          f.store
            .decisions(task.id)
            .some(
              (d) =>
                d.outcome === 'verified' &&
                d.commentVersion === findingVersion({ ...snapshot.comments[0], body: edited }),
            ),
        ).toBe(true);
        await f.engine.publish(task.id);
        expect(nextPublished).toBe(true);
        expect(f.store.getTask(task.id).state).toBe('complete');
        return;
      }
      expect(await native.getReview(prRef(task), old, { publishedEvidence: true })).toEqual(
        snapshot,
      );
      oldFindingDraft = true;
      expect((await native.getReview(prRef(task), old, { publishedEvidence: true })).status).toBe(
        'partial',
      );
      oldFindingDraft = false;
      otherDraft = true;
      expect(
        await native.getReview(prRef(task), old, {
          publishedEvidence: true,
          knownCommentIds: snapshot.comments.map((comment) => comment.id),
        }),
      ).toEqual(snapshot);
      await expect(native.publish(prRef(task), next!)).rejects.toMatchObject({
        code: vcs === 'arcadia' ? 'review_not_draft' : 'untracked_drafts',
      });
    } finally {
      await worker.stop();
      f.store.close();
    }
  },
);
