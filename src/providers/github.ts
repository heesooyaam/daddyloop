import { GitHubQuota, GitHubQuotaError } from './github-quota.js';
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
import { AppError, ProviderWriteNotAttempted } from '../core/types.js';
import { type ReviewProvider, reviewPreparationError, tag } from './provider.js';
import { ProviderHttp, type Fetch } from './http.js';

const pendingReviewMessage =
  'The current GitHub account has a pending review. Publish or discard it before starting a new review.';

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
        if (error instanceof GitHubQuotaError) throw error;
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
  private async readOwnReviews(ref: PRRef): Promise<GHReview[]> {
    const [list, user] = await Promise.all([
      this.http.pages<GHReview>(`${path(ref)}/reviews`),
      this.http.request<{ id: number }>('GET', '/user'),
    ]);
    return list.filter((review) => review.user.id === user.id);
  }
  async findReview(ref: PRRef, marker: string) {
    const reviews = await this.readOwnReviews(ref);
    const review = reviews.find((item) => (item.body ?? '').includes(tag(marker)));
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
  async createReview(ref: PRRef, revision: Revision, marker: string) {
    const reviews = await this.readOwnReviews(ref).catch((error: unknown) => {
      if (error instanceof GitHubQuotaError) throw new GitHubQuotaError(error.until, true);
      throw reviewPreparationError(error, 'GitHub');
    });
    const existing = reviews.find((item) => (item.body ?? '').includes(tag(marker)));
    if (existing) return this.handle(existing, marker, revision);
    if (reviews.some((item) => item.state === 'PENDING'))
      throw new ProviderWriteNotAttempted('existing_drafts', pendingReviewMessage);
    const review = await this.http
      .request<GHReview>('POST', `${path(ref)}/reviews`, {
        commit_id: revision.head,
        body: `Review in progress.\n\n${tag(marker)}`,
      })
      .catch((error: unknown) => {
        if (
          error instanceof AppError &&
          error.code === 'provider_422' &&
          /\b(?:user can only have one pending review per pull request|you already have a pending review|a pending review already exists)\b/i.test(
            error.message,
          )
        )
          throw new ProviderWriteNotAttempted('existing_drafts', pendingReviewMessage);
        throw error;
      });
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
        ...(value.state === 'DISMISSED' ? { dismissed: true as const } : {}),
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
    const query = `mutation($input:AddPullRequestReviewThreadInput!){addPullRequestReviewThread(input:$input){thread{comments(first:1){nodes{databaseId body url path line originalLine}}}}}`;
    const base = this.http.baseUrl.endsWith('/api/v3')
      ? this.http.baseUrl.slice(0, -7) + '/api'
      : this.http.baseUrl;
    const http = new ProviderHttp(base, this.http.headers, this.http.fetcher, this.http.quota);
    const value = await http.request<{
      errors?: { message: string }[];
      data: {
        addPullRequestReviewThread: {
          thread: {
            comments: {
              nodes: {
                databaseId: number;
                body: string;
                url: string;
                path: string;
                line: number;
              }[];
            };
          };
        };
      };
    }>('POST', '/graphql', {
      query,
      variables: {
        input: {
          pullRequestReviewId: review.nodeId,
          path: location.path,
          line: location.line,
          side: location.side,
          body: `${body}\n\n${tag(marker)}`,
          ...(location.startLine
            ? { startLine: location.startLine, startSide: location.side }
            : {}),
        },
      },
    });
    if (value.errors?.length)
      throw new AppError('github_graphql', value.errors.map((e) => e.message).join('; '), 502);
    const item = value.data.addPullRequestReviewThread.thread.comments.nodes[0];
    return {
      id: String(item.databaseId),
      body: item.body,
      url: item.url || ref.url,
      location,
      marker,
    };
  }
  async updateComment(ref: PRRef, _review: ReviewHandle, id: string, body: string) {
    return comment(
      await this.http.request<GHComment>(
        'PATCH',
        `/repos/${ref.repo}/pulls/comments/${encodeURIComponent(id)}`,
        { body },
      ),
    );
  }
  async deleteComment(ref: PRRef, _review: ReviewHandle, id: string) {
    await this.http.request(
      'DELETE',
      `/repos/${ref.repo}/pulls/comments/${encodeURIComponent(id)}`,
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
