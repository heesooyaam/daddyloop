import { GitHubQuota, GitHubRetryError } from './github-quota.js';
import type { Store } from '../core/store.js';
import type {
  PRRef,
  PullRequest,
  ReviewHandle,
  Revision,
  ReviewSnapshot,
  ReviewComment,
  Location,
} from '../core/types.js';
import { AppError } from '../core/types.js';
import { type ReviewProvider, tag } from './provider.js';
import { ProviderHttp, type Fetch } from './http.js';

type GHReview = {
  id: number;
  node_id: string;
  body: string;
  state: string;
  commit_id: string;
  html_url: string;
  user: { id: number };
  submitted_at?: string;
};
type GHComment = {
  id: number;
  node_id?: string;
  body: string;
  html_url: string;
  path?: string;
  line?: number;
  original_line?: number;
  side?: 'LEFT' | 'RIGHT';
  user?: { login: string };
};
const path = (ref: PRRef) => `/repos/${ref.repo}/pulls/${ref.number}`;
const comment = (c: GHComment): ReviewComment => ({
  id: String(c.id),
  nodeId: c.node_id,
  body: c.body,
  url: c.html_url,
  author: c.user?.login,
  ...(c.path && (c.line || c.original_line)
    ? {
        location: {
          path: c.path,
          line: c.line ?? c.original_line!,
          side: c.side ?? 'RIGHT',
        },
      }
    : {}),
});
export class GitHubProvider implements ReviewProvider {
  readonly http: ProviderHttp;
  constructor(host: string, token: string, fetcher?: Fetch, store?: Store) {
    this.http = new ProviderHttp(
      host === 'github.com' ? 'https://api.github.com' : `https://${host}/api/v3`,
      {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'daddyloop/0.1',
      },
      fetcher,
      store ? new GitHubQuota(store, host) : undefined,
    );
  }
  async getPR(ref: PRRef): Promise<PullRequest> {
    const pr = await this.http.request<{
      title: string;
      body: string;
      head: { sha: string; ref: string; repo: { clone_url: string } | null };
      base: { sha: string; ref: string; repo?: { clone_url: string } };
      state: string;
      merged: boolean;
      draft: boolean;
      mergeable: boolean | null;
      mergeable_state?: string;
      merge_commit_sha?: string;
    }>('GET', path(ref));
    const [status, checks, base] = await Promise.all([
      this.http.request<{
        statuses: { context: string; state: string; target_url?: string }[];
      }>('GET', `/repos/${ref.repo}/commits/${pr.head.sha}/status?per_page=100`),
      this.getChecks(ref, pr.head.sha),
      pr.state === 'open' && !pr.merged ? this.targetHead(ref, pr.base.ref) : pr.base.sha,
    ]);
    // The combined status endpoint only exposes one page of contexts. Read all statuses
    // and keep the latest status per context, including reruns of previously failed jobs.
    const statuses =
      status.statuses.length < 100
        ? status.statuses
        : await this.http.pages<{
            context: string;
            state: string;
            target_url?: string;
          }>(`/repos/${ref.repo}/commits/${pr.head.sha}/statuses`);
    const latest = new Map<string, { name: string; status: string; url?: string }>();
    for (const item of statuses)
      if (!latest.has(`status:${item.context}`))
        latest.set(`status:${item.context}`, {
          name: item.context,
          status: item.state,
          url: item.target_url,
        });
    for (const item of checks) {
      const key = `check:${item.check_suite?.id ?? ''}:${item.name}`;
      if (!latest.has(key))
        latest.set(key, {
          name: item.name,
          status: item.status === 'completed' ? (item.conclusion ?? 'failure') : 'pending',
          url: item.html_url,
        });
    }
    const details = [...latest.values()];
    const passing = new Set(['success', 'neutral', 'skipped']);
    const pending = new Set(['pending', 'queued', 'in_progress', 'waiting', 'requested']);
    return {
      head: pr.head.sha,
      draft: pr.draft,
      mergeable: pr.mergeable == null ? null : pr.mergeable && pr.mergeable_state === 'clean',
      mergeConflict: pr.mergeable === false && pr.mergeable_state === 'dirty',
      targetCloneUrl: pr.base.repo?.clone_url,
      mergeCommit: pr.merged ? pr.merge_commit_sha : undefined,
      base,
      start: base,
      title: pr.title,
      body: pr.body ?? '',
      branch: pr.head.ref,
      targetBranch: pr.base.ref,
      cloneUrl: pr.head.repo?.clone_url ?? '',
      state: pr.merged ? 'merged' : pr.state === 'open' ? 'open' : 'closed',
      checkDetails: details,
      checks: !details.length
        ? 'missing'
        : details.some((c) => !passing.has(c.status) && !pending.has(c.status))
          ? 'failing'
          : details.some((c) => pending.has(c.status))
            ? 'pending'
            : 'passing',
    };
  }
  private async targetHead(ref: PRRef, branch: string) {
    // pulls/{number}.base.sha can remain at the PR creation commit after the branch advances.
    const name = branch.split('/').map(encodeURIComponent).join('/');
    const value = await this.http.request<{ ref: string; object: { type: string; sha: string } }>(
      'GET',
      `/repos/${ref.repo}/git/ref/heads/${name}`,
    );
    if (
      value.ref !== 'refs/heads/' + branch ||
      value.object?.type !== 'commit' ||
      !/^[a-f0-9]{40,64}$/.test(value.object.sha)
    )
      throw new AppError('invalid_target_ref', 'GitHub did not confirm the target branch commit');
    return value.object.sha;
  }
  async targetAdvanced(ref: PRRef, before: string, after: string) {
    if (![before, after].every((sha) => /^[a-f0-9]{40,64}$/.test(sha))) return false;
    const comparison = await this.http.request<{
      status: string;
      merge_base_commit: { sha: string };
    }>('GET', `/repos/${ref.repo}/compare/${before}...${after}?per_page=1`);
    return comparison.status === 'ahead' && comparison.merge_base_commit?.sha === before;
  }
  async prepareMerge(ref: PRRef) {
    const repo = await this.http.request<{
      allow_squash_merge: boolean;
      allow_merge_commit: boolean;
      allow_rebase_merge: boolean;
    }>('GET', `/repos/${ref.repo}`);
    const method = repo.allow_squash_merge
      ? 'squash'
      : repo.allow_merge_commit
        ? 'merge'
        : repo.allow_rebase_merge
          ? 'rebase'
          : undefined;
    if (!method)
      throw new AppError(
        'merge_method_missing',
        'No merge method is available for this repository',
      );
    return async (expectedHead: string) => {
      let result: { merged: boolean; sha: string };
      try {
        result = await this.http.request<typeof result>('PUT', `${path(ref)}/merge`, {
          sha: expectedHead,
          merge_method: method,
        });
      } catch (error) {
        if (error instanceof GitHubRetryError) throw error;
        if (error instanceof AppError)
          throw new AppError(
            error.code,
            'GitHub did not confirm the merge request',
            error.statusCode,
          );
        throw error;
      }
      if (!result.merged || !result.sha)
        throw new AppError('merge_unconfirmed', 'GitHub has not confirmed the merge');
      return result.sha;
    };
  }
  private async getChecks(ref: PRRef, head: string) {
    const result: {
      check_suite?: { id: number };
      name: string;
      status: string;
      conclusion: string | null;
      html_url?: string;
    }[] = [];
    for (let page = 1; page <= 100; page++) {
      const value = await this.http.request<{
        total_count: number;
        check_runs: typeof result;
      }>(
        'GET',
        `/repos/${ref.repo}/commits/${head}/check-runs?filter=latest&per_page=100&page=${page}`,
      );
      result.push(...value.check_runs);
      if (value.check_runs.length < 100) return result;
    }
    throw new AppError('pagination_limit', 'Too many check runs', 502);
  }
  private async ownReviews(ref: PRRef) {
    const [list, user] = await Promise.all([
      this.http.pages<GHReview>(`${path(ref)}/reviews`),
      this.http.request<{ id: number }>('GET', '/user'),
    ]);
    return { owner: user.id, reviews: list.filter((r) => r.user.id === user.id) };
  }
  async findReview(ref: PRRef, marker: string) {
    const { reviews } = await this.ownReviews(ref);
    const review = reviews.find((r) => (r.body ?? '').trimEnd().endsWith(tag(marker)));
    return review ? this.handle(review, marker) : undefined;
  }
  private handle(review: GHReview, marker: string, revision?: Revision): ReviewHandle {
    return {
      id: String(review.id),
      nodeId: review.node_id,
      marker,
      revision: revision ?? { head: review.commit_id, base: '', start: '' },
      authorId: String(review.user.id),
    };
  }
  async createReview(
    ref: PRRef,
    revision: Revision,
    marker: string,
    confirmOwner?: (owner: string) => Promise<void>,
  ) {
    const { owner, reviews } = await this.ownReviews(ref).catch((error) => {
      if (error instanceof GitHubRetryError) throw error.beforeWrite();
      throw error;
    });
    await confirmOwner?.(String(owner));
    const matches = reviews.filter((r) => (r.body ?? '').trimEnd().endsWith(tag(marker)));
    const existing = matches[0];
    if (existing) {
      if (
        matches.length !== 1 ||
        existing.commit_id !== revision.head ||
        existing.state !== 'PENDING'
      )
        throw new AppError(
          'draft_changed',
          'The marked review was submitted or its revision changed. Inspect it before continuing.',
        );
      const comments = await this.http.pages<GHComment>(
        `${path(ref)}/reviews/${existing.id}/comments`,
      );
      if (comments.length || existing.body !== `Review in progress.\n\n${tag(marker)}`)
        throw new AppError(
          'draft_changed',
          'The recovered draft has been edited. Its contents have been preserved.',
        );
      return this.handle(existing, marker, revision);
    }
    if (reviews.some((r) => r.state === 'PENDING'))
      throw new AppError(
        'draft_occupied',
        'A different pending GitHub review belongs to this account. Its contents have been preserved.',
      );
    // This POST creates only a draft. GitHub enforces one pending review per account and PR.
    let review: GHReview;
    try {
      review = await this.http.request<GHReview>('POST', `${path(ref)}/reviews`, {
        commit_id: revision.head,
        body: `Review in progress.\n\n${tag(marker)}`,
      });
    } catch (error) {
      if (
        error instanceof AppError &&
        error.code === 'provider_422' &&
        /one pending review/i.test(error.message)
      )
        throw new AppError(
          'draft_creation_race',
          'GitHub has a pending review that is not visible in the review list yet.',
        );
      throw error;
    }
    if (
      review.user?.id !== owner ||
      review.state !== 'PENDING' ||
      review.commit_id !== revision.head ||
      !(review.body ?? '').trimEnd().endsWith(tag(marker))
    )
      throw new AppError('draft_create_unconfirmed', 'GitHub did not confirm the requested draft.');
    return this.handle(review, marker, revision);
  }
  async getReview(ref: PRRef, review: ReviewHandle): Promise<ReviewSnapshot> {
    try {
      const [value, comments] = await Promise.all([
        this.http.request<GHReview>('GET', `${path(ref)}/reviews/${review.id}`),
        this.http.pages<GHComment>(`${path(ref)}/reviews/${review.id}/comments`),
      ]);
      return {
        status:
          value.state === 'PENDING'
            ? 'draft'
            : value.state === 'DISMISSED'
              ? 'missing'
              : 'published',
        body: value.body ?? '',
        authorId: String(value.user.id),
        comments: comments.map(comment),
        url: value.html_url ?? ref.url,
        revision: { ...review.revision, head: value.commit_id },
      };
    } catch (error) {
      if (error instanceof AppError && error.code === 'provider_404')
        return {
          status: 'missing',
          body: '',
          comments: [],
          url: ref.url,
          revision: review.revision,
        };
      throw error;
    }
  }
  async discardSupersededDraft(ref: PRRef, review: ReviewHandle, snapshot: ReviewSnapshot) {
    const url = `${path(ref)}/reviews/${review.id}`;
    const [value, user, comments] = await Promise.all([
      this.http.request<GHReview>('GET', url),
      this.http.request<{ id: number }>('GET', '/user'),
      this.http.pages<GHComment>(url + '/comments'),
    ]);
    if (
      value.state !== 'PENDING' ||
      String(user.id) !== review.authorId ||
      value.user.id !== user.id ||
      value.commit_id !== review.revision.head ||
      value.body !== snapshot.body ||
      !value.body.endsWith(tag(review.marker)) ||
      comments.length
    )
      throw new AppError(
        'draft_changed',
        'The old draft changed. Inspect it before replacing the review.',
      );
    await this.http.request('DELETE', url);
  }
  private async mutation<T>(query: string, input: object): Promise<T> {
    const base = this.http.baseUrl.replace(/\/api\/v3$/, '/api');
    const http = new ProviderHttp(base, this.http.headers, this.http.fetcher, this.http.quota);
    const value = await http.request<{ data?: T; errors?: { message: string }[] }>(
      'POST',
      '/graphql',
      { query, variables: { input } },
    );
    if (value.errors?.length || !value.data)
      throw new AppError(
        'github_graphql',
        value.errors?.map((e) => e.message).join('; ') || 'GitHub returned no mutation result',
        502,
      );
    return value.data;
  }
  private async draftComment(
    ref: PRRef,
    review: ReviewHandle,
    id: string,
    current?: ReviewComment,
  ) {
    if (current?.id === id && current.nodeId) return current;
    const draft = await this.getReview(ref, review);
    const item = draft.status === 'draft' && draft.comments.find((c) => c.id === id);
    if (!item || !item.nodeId)
      throw new AppError(
        'draft_changed',
        'The comment is no longer available in the pending GitHub review',
        409,
      );
    return item;
  }
  async createComment(
    ref: PRRef,
    review: ReviewHandle,
    body: string,
    marker: string,
    location?: Location,
  ) {
    if (!location)
      throw new AppError(
        'location_required',
        'GitHub inline comments require a diff location. Put general observations in the review summary.',
        400,
      );
    const query = `mutation($input:AddPullRequestReviewThreadInput!){addPullRequestReviewThread(input:$input){thread{comments(first:1){nodes{id databaseId body url}}}}}`;
    const data = await this.mutation<{
      addPullRequestReviewThread: {
        thread: {
          comments: { nodes: { id: string; databaseId: number; body: string; url: string }[] };
        };
      };
    }>(query, {
      pullRequestReviewId: review.nodeId,
      path: location.path,
      line: location.line,
      side: location.side,
      body: `${body}\n\n${tag(marker)}`,
      ...(location.startLine ? { startLine: location.startLine, startSide: location.side } : {}),
    });
    const item = data.addPullRequestReviewThread.thread.comments.nodes[0];
    return {
      id: String(item.databaseId),
      nodeId: item.id,
      body: item.body,
      url: item.url || ref.url,
      location,
      marker,
    };
  }
  async updateComment(
    ref: PRRef,
    review: ReviewHandle,
    id: string,
    body: string,
    current?: ReviewComment,
  ) {
    const item = await this.draftComment(ref, review, id, current);
    const result = await this.mutation<{
      updatePullRequestReviewComment: {
        pullRequestReviewComment: { id: string; body: string; url: string };
      };
    }>(
      'mutation($input:UpdatePullRequestReviewCommentInput!){updatePullRequestReviewComment(input:$input){pullRequestReviewComment{id body url}}}',
      { pullRequestReviewCommentId: item.nodeId, body },
    );
    const updated = result.updatePullRequestReviewComment?.pullRequestReviewComment;
    if (updated?.id !== item.nodeId || updated?.body !== body)
      throw new AppError(
        'unconfirmed_comment_edit',
        'GitHub did not confirm the requested draft comment text',
        502,
      );
    return { ...item, body: updated.body, url: updated.url };
  }
  async deleteComment(ref: PRRef, review: ReviewHandle, id: string, current?: ReviewComment) {
    const item = await this.draftComment(ref, review, id, current);
    const result = await this.mutation<{
      deletePullRequestReviewComment: { clientMutationId: string };
    }>(
      'mutation($input:DeletePullRequestReviewCommentInput!){deletePullRequestReviewComment(input:$input){clientMutationId}}',
      { id: item.nodeId, clientMutationId: item.nodeId },
    );
    if (result.deletePullRequestReviewComment?.clientMutationId !== item.nodeId)
      throw new AppError(
        'unconfirmed_comment_removal',
        'GitHub did not confirm the draft comment removal',
        502,
      );
  }
  async updateSummary(ref: PRRef, review: ReviewHandle, body: string) {
    await this.http.request('PUT', `${path(ref)}/reviews/${review.id}`, {
      body: `${body}\n\n${tag(review.marker)}`,
    });
  }
  async publish(ref: PRRef, review: ReviewHandle) {
    await this.http.request('POST', `${path(ref)}/reviews/${review.id}/events`, {
      event: 'COMMENT',
    });
  }
}
