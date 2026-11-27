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
  ['gitlab', 'arcadia', 'github'].flatMap((vcs) =>
    [
      'unchanged',
      'edited before review',
      'edited during review',
      'omitted before review',
      'omitted during review',
      'omitted before publication',
    ].map((phase) => ({ vcs, phase })),
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
    let omitted = false;
    let recovered = false;
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
      ...(omitted ? [] : [note(11, wording, oldFindingDraft)]),
      ...(next ? [note(-20, tag(next.marker), !nextPublished)] : []),
      ...(otherDraft ? [note(vcs === 'gitlab' ? 11 : -21, 'Foreign draft', true)] : []),
    ];
    const http = transport((path, method) => {
      if (vcs === 'github') {
        if (method === 'POST' && path.endsWith('/reviews/20/events')) {
          nextPublished = true;
          return {};
        }
        expect(method).toBe('GET');
        if (path.includes('/reviews/10/comments'))
          return omitted ? [] : [{ ...note(11, wording, false), html_url: task.ref.url }];
        if (path.includes('/reviews/20/comments')) return [];
        const handle = path.endsWith('/reviews/10') ? old : next!;
        return {
          id: Number(handle.id),
          user: { id: 7 },
          commit_id: handle.revision.head,
          state: handle === old || nextPublished ? 'COMMENTED' : 'PENDING',
          body: tag(handle.marker),
        };
      }
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
        : vcs === 'github'
          ? new GitHubProvider('github.com', 'fake', http)
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
        next = {
          id: vcs === 'github' ? '20' : '-20',
          marker,
          revision,
          authorId,
          nodeId: '2',
          baselineNoteId: 11,
        };
        return next;
      },
    );
    vi.spyOn(f.provider, 'getReview').mockImplementation(native.getReview.bind(native));
    vi.spyOn(f.provider, 'publish').mockImplementation(native.publish.bind(native));
    vi.spyOn(workspaces, 'prepare').mockResolvedValue('/tmp');
    if (phase === 'omitted before review') omitted = true;
    if (phase === 'edited before review') wording = edited;
    const run = vi.fn(async (input: Parameters<DemoRuntime['run']>[0]) => {
      expect(input.task.revision?.head).toBe(target.head);
      expect(input.task.feedback?.comments).toEqual(
        snapshot.comments.map((comment) => ({ ...comment, body: wording })),
      );
      if (phase === 'edited during review') wording = edited;
      if (phase === 'omitted during review' && !recovered) omitted = true;
      return {
        status: 'completed' as const,
        summary: 'Verified',
        checkedHead: target.head,
        verifiedCommentIds:
          phase === 'unchanged' || phase === 'omitted before publication' || recovered
            ? snapshot.comments.map((c) => c.id)
            : [],
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
      const omissionBeforePublish = phase === 'omitted before publication';
      await vi.waitFor(() =>
        expect(f.store.getTask(task.id).state).toBe(
          changed && !omissionBeforePublish ? 'needs_input' : 'awaiting_publication',
        ),
      );
      const firstRuns = phase === 'omitted before review' ? 0 : 1;
      expect(run).toHaveBeenCalledTimes(firstRuns);
      if (changed) {
        if (omissionBeforePublish) {
          omitted = true;
          await f.engine.publish(task.id);
          expect(f.store.getTask(task.id).state).toBe('needs_input');
          expect(nextPublished).toBe(false);
        } else {
          expect(f.store.getTask(task.id).reviewFinished).toBeFalsy();
          await expect(f.engine.publish(task.id)).rejects.toMatchObject({
            code: 'publication_unavailable',
          });
        }
        if (phase.startsWith('omitted')) {
          expect(f.store.getTask(task.id).feedback?.comments).toEqual(snapshot.comments);
          omitted = false;
          wording = edited;
        }
        recovered = true;
        await f.engine.review(task.id, true);
        await worker.tick();
        await vi.waitFor(() => expect(f.store.getTask(task.id).state).toBe('awaiting_publication'));
        expect(run).toHaveBeenCalledTimes(firstRuns + 1);
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
      if (vcs === 'github') {
        await f.engine.publish(task.id);
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

async function publicationFixture(provider: string) {
  const f = await fixture({ state: 'awaiting_publication' });
  const workspaces = new Workspaces('/tmp');
  const task = f.store.getTask(f.task.id);
  task.ref.provider = provider;
  const arc = provider === 'arcadia';
  const github = provider === 'github';
  if (arc) {
    task.revision = { ...task.revision!, revisionId: '7' };
    task.pr = { ...task.pr!, ...task.revision, diffHead: task.revision.head };
    f.store.setSetting('demo-pr:1', task.pr);
  }
  const ref = prRef(task);
  const handle: ReviewHandle = {
    id: '10',
    nodeId: '7',
    authorId: arc ? 'worker' : '7',
    marker: 'daddyloop:current',
    baselineNoteId: 9,
    revision: task.revision!,
  };
  task.review = handle;
  task.reviewFinished = true;
  const nativeState = {
    published: false,
    edited: false,
    omitted: -1,
    omitOnce: false,
    remapArc: false,
    sends: 0,
  };
  const markdown = ['Updated general Markdown', 'Updated inline\n\n```ts\ncheckAgain();\n```'];
  const markPublished = (edit = false) => {
    nativeState.published = true;
    nativeState.edited = edit;
  };
  let afterPublish = () => markPublished();
  const note = (index: number) => {
    const base = arc
      ? nativeState.published && nativeState.remapArc
        ? 20
        : 10
      : github || nativeState.published
        ? 10
        : 50;
    const body =
      index === 0
        ? tag(handle.marker)
        : nativeState.edited
          ? markdown[index - 1]
          : 'Initial wording ' + tag(handle.marker + ':comment:' + index);
    return {
      id: base + index,
      body,
      content: body,
      author: { id: 7, name: 'worker' },
      is_draft: !nativeState.published,
      html_url: ref.url,
      ...(index === 2 && {
        path: 'a.ts',
        line: 4,
        side: 'RIGHT',
        position: { new_path: 'a.ts', new_line: 4 },
        anchor: { path: 'a.ts', line: 4 },
      }),
    };
  };
  const readNotes = (indices: number[]) => {
    const result = indices.filter((index) => index !== nativeState.omitted).map(note);
    if (nativeState.omitOnce && indices.includes(nativeState.omitted)) nativeState.omitted = -1;
    return result;
  };
  const http = transport((path, method) => {
    if (github) {
      if (method === 'POST' && path.endsWith('/reviews/10/events')) {
        nativeState.sends++;
        afterPublish();
        return {};
      }
      expect(method).toBe('GET');
      if (path.includes('/reviews/10/comments')) return readNotes([1, 2]);
      expect(path).toMatch(/\/reviews\/10$/);
      return {
        id: 10,
        user: { id: 7 },
        commit_id: handle.revision.head,
        state: nativeState.published ? 'COMMENTED' : 'PENDING',
        body: tag(handle.marker),
      };
    }
    if (method === 'PUT' && /draft_notes\/5[0-2]\/publish$/.test(path)) {
      nativeState.sends++;
      if (path.endsWith('50/publish')) afterPublish();
      return {};
    }
    expect(method).toBe('GET');
    if (path.includes('draft_notes') === nativeState.published) return [];
    return readNotes([0, 1, 2]);
  });
  const bridge = new ArcBridge();
  vi.spyOn(bridge, 'api').mockImplementation(async <T>(args: string[]) => {
    if (args[0] === 'draft-comment' && args[1] === 'publish') {
      nativeState.sends++;
      expect(args).toContain('--comment-for-review-ids=10,11');
      expect(args).toContain('--comment-for-diff-ids=12');
      afterPublish();
      return {} as T;
    }
    expect(args[1]).toBe('comments');
    return readNotes(args[0] === 'pr' ? [0, 1] : [2]) as T;
  });
  const native = arc
    ? new ArcadiaProvider(bridge)
    : github
      ? new GitHubProvider('github.com', 'fake', http)
      : new GitLabProvider('gitlab.example.com', 'fake', http);
  task.snapshot = await native.getReview(ref, handle);
  expect(task.snapshot.status).toBe('draft');
  expect(task.snapshot.comments).toHaveLength(2);
  f.store.saveTask(task);
  vi.spyOn(f.provider, 'getReview').mockImplementation(native.getReview.bind(native));
  vi.spyOn(f.provider, 'publish').mockImplementation(native.publish.bind(native));
  vi.spyOn(workspaces, 'prepare').mockResolvedValue('/tmp');
  const expected = markdown.map((body, i) => ({
    body,
    id: arc ? (i === 0 ? 'pr:11' : 'diff:12') : String(11 + i),
  }));
  const worker = (run: DemoRuntime['run']) =>
    new Worker(f.engine, workspaces, { run }, new DemoRuntime(), () => ({
      ok: true,
      reasons: [],
      diskAvailableGiB: 20,
      diskUsedPercent: 20,
      memoryAvailableGiB: 10,
      memoryTotalGiB: 20,
    }));
  const editDuringPublication = () => {
    afterPublish = () => markPublished(true);
  };
  const omitDuringPublication = () => {
    afterPublish = () => {
      markPublished(true);
      nativeState.omitted = 2;
    };
  };
  return {
    ...f,
    task,
    nativeState,
    expected,
    worker,
    markPublished,
    editDuringPublication,
    omitDuringPublication,
  };
}

it.each(
  ['arcadia', 'gitlab'].flatMap((provider) =>
    ['manual', 'manual via service', 'automatic', 'queued', 'incomplete read after queue'].map(
      (phase) => ({ provider, phase }),
    ),
  ),
)(
  'keeps native $provider findings through $phase publication reconciliation',
  async ({ provider, phase }) => {
    const f = await publicationFixture(provider);
    const { task, nativeState, expected } = f;
    const arc = provider === 'arcadia';
    const beforeConfirmation =
      phase === 'manual' || phase === 'manual via service' || phase === 'automatic';
    if (beforeConfirmation) f.editDuringPublication();
    const run = vi.fn(async (input: Parameters<DemoRuntime['run']>[0]) => {
      expect(input.job.role).toBe('author');
      expect(input.task.feedback?.comments).toMatchObject(expected);
      expect(input.task.feedback?.comments[1].location).toMatchObject({ path: 'a.ts', line: 4 });
      const tool = await input.onTool('read_review', {});
      expect(tool).toMatchObject({ status: 'published', comments: expected });
      return {
        status: 'needs_input' as const,
        summary: 'Author received the findings',
        checkedHead: task.revision!.head,
      };
    });
    const worker = f.worker(run);
    try {
      if (phase === 'manual') {
        f.markPublished(true);
        await f.engine.reconcile(task.id);
      } else if (phase === 'manual via service') {
        await f.engine.publish(task.id, { generation: task.generation, head: task.revision!.head });
        expect(nativeState.sends).toBe(arc ? 1 : 3);
      } else if (!beforeConfirmation) {
        await f.engine.publish(task.id);
        expect(f.store.getTask(task.id).state).toBe('fixing');
        expect(f.store.getTask(task.id).feedback?.comments.map((c) => c.id)).toEqual(
          expected.map((c) => c.id),
        );
        nativeState.edited = true;
        if (phase === 'incomplete read after queue') nativeState.omitted = 2;
      }
      await worker.tick();
      if ((!arc && beforeConfirmation) || nativeState.omitted > 0) {
        await vi.waitFor(() => expect(f.store.getTask(task.id).state).toBe('needs_input'));
        const stopped = f.store.getTask(task.id);
        expect(stopped.reason).toContain('recorded findings');
        expect(stopped.snapshot?.comments).toHaveLength(2);
        expect(run).not.toHaveBeenCalled();
      } else {
        await vi.waitFor(() =>
          expect(f.store.getTask(task.id).reason).toBe('Author received the findings'),
        );
        expect(run).toHaveBeenCalledOnce();
        expect(f.store.getTask(task.id).feedback?.comments).toMatchObject(expected);
      }
      expect(nativeState.sends).toBe(phase === 'manual' ? 0 : arc ? 1 : 3);
    } finally {
      await worker.stop();
      f.store.close();
    }
  },
);

it.each(
  ['arcadia', 'gitlab', 'github'].flatMap((provider) =>
    [
      'edited before confirmation',
      'omitted before confirmation',
      'intact before confirmation',
      'held publication',
      'missing general at completion',
      'missing inline at completion',
    ].map((phase) => ({ provider, phase })),
  ),
)('verifies a merged $provider PR with findings $phase', async ({ provider, phase }) => {
  const f = await publicationFixture(provider);
  const { task, store, engine, nativeState, expected } = f;
  const beforeVerification = async () => {
    if (phase.startsWith('missing')) {
      await engine.publish(task.id);
      expect(store.getTask(task.id).snapshot?.status).toBe('published');
      nativeState.edited = true;
    } else {
      nativeState.remapArc = phase === 'held publication';
      f.markPublished(
        phase !== 'intact before confirmation' &&
          (provider !== 'gitlab' || phase !== 'omitted before confirmation'),
      );
      if (
        phase === 'omitted before confirmation' ||
        (phase === 'held publication' && provider === 'github')
      )
        nativeState.omitted = 2;
      if (phase === 'held publication') {
        await engine.reconcile(task.id);
        expect(store.getTask(task.id).state).toBe('needs_input');
      }
    }
    store.cancelJobs(task.id);
    const current = store.getTask(task.id);
    current.state = 'needs_input';
    store.saveTask(current);
    store.setSetting('demo-pr:1', {
      ...current.pr,
      state: 'merged',
      mergeCommit: 'merged',
      checks: 'passing',
    });
    await engine.action(task.id, 'verify-merge');
  };
  const omitted =
    phase === 'missing general at completion'
      ? 1
      : phase === 'missing inline at completion'
        ? 2
        : -1;
  let interruptRead = omitted > 0;
  const run = vi.fn(async (input: Parameters<DemoRuntime['run']>[0]) => {
    expect(input.job.kind).toBe('verify_merge');
    expect(input.task.snapshot?.status).toBe('published');
    expect(input.task.snapshot?.comments).toMatchObject(
      nativeState.edited
        ? expected
        : expected.map((c) => ({ id: c.id, body: expect.stringContaining('Initial wording') })),
    );
    if (interruptRead) {
      nativeState.omitted = omitted;
      nativeState.omitOnce = true;
    }
    return {
      status: 'completed' as const,
      summary: 'Checked merged result',
      checkedHead: task.revision!.head,
      verifiedCommentIds: interruptRead ? [] : expected.map((c) => c.id),
    };
  });
  const worker = f.worker(run);
  try {
    await beforeVerification();
    const start = store.getTask(task.id);
    await worker.tick();
    const held =
      phase === 'held publication' ||
      phase === 'omitted before confirmation' ||
      (provider === 'gitlab' && phase === 'edited before confirmation');
    if (held || interruptRead) {
      await vi.waitFor(() => expect(store.getTask(task.id).state).toBe('needs_input'));
      const stopped = store.getTask(task.id);
      expect(stopped.verifiedMerge).toBeUndefined();
      if (held) {
        expect(run).not.toHaveBeenCalled();
        expect(stopped.snapshot).toEqual(start.snapshot);
        if (phase === 'omitted before confirmation') {
          nativeState.omitted = -1;
          await engine.action(task.id, 'verify-merge');
          await worker.tick();
          await vi.waitFor(() => expect(store.getTask(task.id).state).toBe('complete'));
          expect(run).toHaveBeenCalledOnce();
        }
      } else {
        expect(run).toHaveBeenCalledOnce();
        expect(stopped.snapshot?.comments).toMatchObject(expected);
        expect(nativeState.omitted).toBe(-1);
        interruptRead = false;
        await engine.action(task.id, 'verify-merge');
        await worker.tick();
        await vi.waitFor(() => expect(store.getTask(task.id).state).toBe('complete'));
        expect(run).toHaveBeenCalledTimes(2);
      }
    } else {
      await vi.waitFor(() => expect(store.getTask(task.id).state).toBe('complete'));
      expect(run).toHaveBeenCalledOnce();
    }
  } finally {
    await worker.stop();
    store.close();
  }
});

it.each(
  ['arcadia', 'gitlab'].flatMap((provider) =>
    ['manual', 'automatic'].map((publication) => ({ provider, publication })),
  ),
)(
  'preserves the held $provider review during chat after $publication publication',
  async ({ provider, publication }) => {
    const f = await publicationFixture(provider);
    const { task, engine, store, nativeState } = f;
    nativeState.remapArc = true;
    f.editDuringPublication();
    const run = vi.fn(async (input: Parameters<DemoRuntime['run']>[0]) => {
      expect(input.job.kind).toBe('chat');
      return {
        status: 'completed' as const,
        summary: 'Discussion finished',
        checkedHead: task.revision!.head,
      };
    });
    const worker = f.worker(run);
    try {
      if (publication === 'manual') {
        f.markPublished(true);
        await engine.reconcile(task.id);
      } else {
        await worker.tick();
      }
      const held = store.getTask(task.id);
      expect(held.state).toBe('needs_input');
      expect(held.snapshot).toEqual(task.snapshot);
      await engine.chat(task.id, 'reviewer', 'Inspect the findings');
      await worker.tick();
      await vi.waitFor(() =>
        expect(store.jobs(task.id).at(-1)).toMatchObject({ kind: 'chat', status: 'completed' }),
      );
      expect(run).toHaveBeenCalledOnce();
      const after = store.getTask(task.id);
      expect(after).toMatchObject({ state: 'needs_input', snapshot: held.snapshot });
      expect(after.reason).toContain('recorded findings');
    } finally {
      await worker.stop();
      store.close();
    }
  },
);

it.each(['manual publication', 'automatic publication', 'queued author'])(
  'holds a GitHub PR when the native list omits a known comment after %s',
  async (phase) => {
    const f = await publicationFixture('github');
    const { task, nativeState, expected, engine, store } = f;
    const run = vi.fn(async (input: Parameters<DemoRuntime['run']>[0]) => {
      expect(input.job.kind).toBe('fix');
      expect(input.task.feedback?.comments).toMatchObject(expected);
      expect(await input.onTool('read_review', {})).toMatchObject({ comments: expected });
      return {
        status: 'needs_input' as const,
        summary: 'Author received restored findings',
        checkedHead: task.revision!.head,
      };
    });
    const worker = f.worker(run);
    try {
      if (phase === 'queued author') {
        await engine.publish(task.id);
        expect(store.getTask(task.id).state).toBe('fixing');
        nativeState.edited = true;
        nativeState.omitted = 2;
      } else if (phase === 'manual publication') {
        f.markPublished(true);
        nativeState.omitted = 2;
      } else f.omitDuringPublication();

      const before = store.getTask(task.id);
      if (phase === 'manual publication') await engine.reconcile(task.id);
      await worker.tick();
      await vi.waitFor(() => expect(store.getTask(task.id).state).toBe('needs_input'));
      expect(run).not.toHaveBeenCalled();
      expect(store.getTask(task.id).snapshot).toEqual(before.snapshot);
      nativeState.omitted = -1;
      await engine.action(task.id, 'resume');
      await worker.tick();
      await vi.waitFor(() =>
        expect(store.getTask(task.id).reason).toBe('Author received restored findings'),
      );
      expect(run).toHaveBeenCalledOnce();
      expect(nativeState.sends).toBe(phase === 'manual publication' ? 0 : 1);
    } finally {
      await worker.stop();
      store.close();
    }
  },
);

it.each(['repeat review', 'external merge'] as const)(
  'requires both findings from a legacy publication and its successor during %s',
  async (entry) => {
    const f = await fixture({ state: entry === 'external merge' ? 'needs_input' : 'queued' });
    const task = f.store.getTask(f.task.id);
    task.ref.provider = 'github';
    const priorRevision = { ...task.revision!, head: 'e'.repeat(40) };
    const old = { id: '10', marker: 'daddyloop:old', revision: priorRevision };
    const latest = { ...old, id: '20', marker: 'daddyloop:latest' };
    const revisedMarkdown = 'Current **Markdown** of the earlier finding';
    let omit = true;
    let verifyBoth = false;
    let newReview: ReviewHandle | undefined;
    let newReviewPublished = false;
    const http = transport((path, method) => {
      if (method === 'POST' && path.endsWith('/reviews/30/events')) {
        newReviewPublished = true;
        return {};
      }
      expect(method).toBe('GET');
      const id = /\/reviews\/(\d+)/.exec(path)?.[1];
      if (path.includes('/comments')) {
        if (id === '30' || (id === '10' && omit)) return [];
        return [
          {
            id: id === '10' ? 11 : 21,
            body: id === '10' ? revisedMarkdown : 'Finding in the next review',
            html_url: task.ref.url,
          },
        ];
      }
      const review = id === '10' ? old : id === '20' ? latest : newReview!;
      return {
        id: Number(review.id),
        user: { id: 7 },
        body: tag(review.marker),
        commit_id: review.revision.head,
        state: id === '30' && !newReviewPublished ? 'PENDING' : 'COMMENTED',
      };
    });
    const github = new GitHubProvider('github.com', 'fake', http);
    vi.spyOn(f.provider, 'getReview').mockImplementation(github.getReview.bind(github));
    vi.spyOn(f.provider, 'publish').mockImplementation(github.publish.bind(github));
    vi.spyOn(f.provider as ReviewProvider, 'createReview').mockImplementation(
      async (_ref, revision, marker) => {
        newReview = { id: '30', revision, marker };
        return newReview;
      },
    );
    const knownLatest = await github.getReview(prRef(task), latest);
    f.engine.setFeedback(task, knownLatest, latest);
    if (entry === 'external merge') {
      task.review = latest;
      task.snapshot = knownLatest;
      f.store.setSetting('demo-pr:1', {
        ...task.pr,
        state: 'merged',
        mergeCommit: 'external',
        checks: 'passing',
      });
    }
    f.store.saveTask(task);
    f.store.event(task.id, 'review.findings_published', {
      reviewId: old.id,
      revision: old.revision,
      comments: 1,
    });
    f.store.event(
      task.id,
      'author.feedback_snapshot',
      {
        status: 'published',
        revision: old.revision,
        comments: [{ id: '11', body: 'Old wording' }],
      },
      'old-author-run',
    );
    f.store.event(task.id, 'review.published', {
      reviewId: latest.id,
      handle: latest,
      snapshot: knownLatest,
    });
    const workspaces = new Workspaces('/tmp');
    vi.spyOn(workspaces, 'prepare').mockResolvedValue('/tmp');
    const seen: string[][] = [];
    const run = vi.fn(async (input: Parameters<DemoRuntime['run']>[0]) => {
      expect(input.task.feedback?.comments[0].id).toBe('21');
      const draft = input.job.reviewFindingIds;
      seen.push(Object.values(draft ?? {}).flat());
      if (!omit) expect(input.prompt).toContain(revisedMarkdown);
      return {
        status: 'completed' as const,
        summary: 'Verified published findings',
        checkedHead: task.revision!.head,
        verifiedCommentIds: verifyBoth ? ['11', '21'] : ['21'],
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
    const queue = async (retry: boolean) => {
      if (entry === 'external merge') await f.engine.action(task.id, 'verify-merge');
      else await f.engine.review(task.id, retry);
    };
    const runQueued = async () => {
      await worker.tick();
      await vi.waitFor(() => expect(f.store.busy(task.id)).toBe(false));
      await worker.tick();
    };
    try {
      await queue(false);
      await runQueued();
      expect(f.store.getTask(task.id).state).toBe('needs_input');
      expect(run).not.toHaveBeenCalled();
      expect(f.store.getTask(task.id).feedback).toEqual(knownLatest);
      omit = false;
      await queue(true);
      await runQueued();
      expect(seen[0]).toEqual(expect.arrayContaining(['11', '21']));
      expect(f.store.getTask(task.id).state).toBe('needs_input');
      verifyBoth = true;
      await queue(true);
      await runQueued();
      expect(seen[1]).toEqual(expect.arrayContaining(['11', '21']));
      expect(f.store.getTask(task.id).state).toBe('complete');
    } finally {
      await worker.stop();
      f.store.close();
    }
  },
);
