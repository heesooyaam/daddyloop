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
  constructor(host: string, token: string, fetcher?: Fetch) {
    this.http = new ProviderHttp(
      host === 'github.com' ? 'https://api.github.com' : `https://${host}/api/v3`,
      {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'reviewloop/0.1',
      },
      fetcher,
    );
  }
  async getPR(ref: PRRef): Promise<PullRequest> {
    const pr = await this.http.request<{
      title: string;
      body: string;
      head: { sha: string; ref: string; repo: { clone_url: string } | null };
      base: { sha: string; ref: string };
      state: string;
      merged: boolean;
    }>('GET', path(ref));
    const [status, checks] = await Promise.all([
      this.http.request<{
        statuses: { context: string; state: string; target_url?: string }[];
      }>('GET', `/repos/${ref.repo}/commits/${pr.head.sha}/status?per_page=100`),
      this.getChecks(ref, pr.head.sha),
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
    for (const item of checks)
      if (!latest.has(`check:${item.name}`))
        latest.set(`check:${item.name}`, {
          name: item.name,
          status: item.status === 'completed' ? (item.conclusion ?? 'failure') : 'pending',
          url: item.html_url,
        });
    const details = [...latest.values()];
    const passing = new Set(['success', 'neutral', 'skipped']);
    const pending = new Set(['pending', 'queued', 'in_progress', 'waiting', 'requested']);
    return {
      head: pr.head.sha,
      base: pr.base.sha,
      start: pr.base.sha,
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
  private async getChecks(ref: PRRef, head: string) {
    const result: {
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
  async findReview(ref: PRRef, marker: string) {
    const [list, user] = await Promise.all([
      this.http.pages<GHReview>(`${path(ref)}/reviews`),
      this.http.request<{ id: number }>('GET', '/user'),
    ]);
    const review = list.find((r) => r.user.id === user.id && (r.body ?? '').includes(tag(marker)));
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
    const existing = await this.findReview(ref, marker);
    if (existing) return { ...existing, revision };
    // GitHub itself enforces one pending review per authenticated account. Never adopt
    // or delete the user's unrelated review when that constraint rejects this call.
    const review = await this.http.request<GHReview>('POST', `${path(ref)}/reviews`, {
      commit_id: revision.head,
      body: `Review in progress.\n\n${tag(marker)}`,
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
        body: value.body ?? '',
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
    const http = new ProviderHttp(base, this.http.headers, this.http.fetcher);
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
