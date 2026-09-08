import {
  AppError,
  type PRRef,
  type PullRequest,
  type Revision,
  type ReviewHandle,
  type ReviewSnapshot,
  type ReviewComment,
  type Location,
} from '../core/types.js';
import { type ReviewProvider, tag } from './provider.js';
import { ProviderHttp, type Fetch } from './http.js';
type Note = {
  id: number;
  note?: string;
  body?: string;
  author_id?: number;
  author?: { id: number; username: string };
  system?: boolean;
  created_at?: string;
  position?: {
    new_path?: string;
    old_path?: string;
    new_line?: number;
    old_line?: number;
  };
  resolvable?: boolean;
  resolved?: boolean;
};
const path = (ref: PRRef) =>
  `/projects/${encodeURIComponent(ref.repo)}/merge_requests/${ref.number}`;
const body = (note: Note) => note.note ?? note.body ?? '';
const mapComment = (ref: PRRef, n: Note, draft = false): ReviewComment => ({
  id: String(n.id),
  body: body(n),
  url: draft ? ref.url : `${ref.url}#note_${n.id}`,
  author: n.author?.username,
  resolved: n.resolved,
  ...(n.position?.new_line || n.position?.old_line
    ? {
        location: {
          path: n.position.new_path ?? n.position.old_path ?? '',
          oldPath: n.position.old_path,
          line: n.position.new_line ?? n.position.old_line!,
          side: n.position.new_line ? ('RIGHT' as const) : ('LEFT' as const),
        },
      }
    : {}),
});
export class GitLabProvider implements ReviewProvider {
  readonly http: ProviderHttp;
  constructor(host: string, token: string, fetcher?: Fetch) {
    this.http = new ProviderHttp(`https://${host}/api/v4`, { 'PRIVATE-TOKEN': token }, fetcher);
  }
  async getPR(ref: PRRef): Promise<PullRequest> {
    const mr = await this.http.request<{
      title: string;
      description: string;
      sha: string;
      state: string;
      source_branch: string;
      target_branch: string;
      source_project_id: number;
      diff_refs: { head_sha: string; base_sha: string; start_sha: string };
      head_pipeline: {
        id: number;
        sha: string;
        status: string;
        web_url: string;
      } | null;
    }>('GET', path(ref));
    if (!mr.diff_refs?.head_sha)
      throw new AppError(
        'diff_unavailable',
        'GitLab has not prepared the merge request diff yet',
        503,
      );
    const project = await this.http.request<{ http_url_to_repo: string }>(
      'GET',
      `/projects/${mr.source_project_id}`,
    );
    const pipeline = mr.head_pipeline?.sha === mr.diff_refs.head_sha ? mr.head_pipeline : null;
    const status = pipeline?.status;
    return {
      head: mr.diff_refs.head_sha,
      base: mr.diff_refs.base_sha,
      start: mr.diff_refs.start_sha,
      title: mr.title,
      body: mr.description ?? '',
      cloneUrl: project.http_url_to_repo,
      branch: mr.source_branch,
      targetBranch: mr.target_branch,
      state: mr.state === 'merged' ? 'merged' : mr.state === 'opened' ? 'open' : 'closed',
      checks: !status
        ? 'missing'
        : status === 'success'
          ? 'passing'
          : [
                'created',
                'waiting_for_resource',
                'preparing',
                'pending',
                'running',
                'scheduled',
              ].includes(status)
            ? 'pending'
            : 'failing',
      checkDetails: pipeline
        ? [
            {
              name: `Pipeline #${pipeline.id}`,
              status: pipeline.status,
              url: pipeline.web_url,
            },
          ]
        : [],
    };
  }
  async findReview(ref: PRRef, marker: string) {
    const [drafts, notes, user] = await Promise.all([
      this.http.pages<Note>(`${path(ref)}/draft_notes`),
      this.http.pages<Note>(`${path(ref)}/notes`),
      this.http.request<{ id: number }>('GET', '/user'),
    ]);
    const item = [...drafts, ...notes].find(
      (n) => (n.author_id ?? n.author?.id) === user.id && body(n).includes(tag(marker)),
    );
    return item
      ? {
          id: String(item.id),
          marker,
          authorId: String(item.author_id ?? item.author?.id),
          revision: { head: '', base: '', start: '' },
          // A lost create response also loses the pre-create note baseline. Be
          // conservative: untracked notes need inspection, never silent omission.
          baselineNoteId: 0,
        }
      : undefined;
  }
  async createReview(ref: PRRef, revision: Revision, marker: string): Promise<ReviewHandle> {
    const [drafts, notes, user] = await Promise.all([
      this.http.pages<Note>(`${path(ref)}/draft_notes`),
      this.http.pages<Note>(`${path(ref)}/notes`),
      this.http.request<{ id: number }>('GET', '/user'),
    ]);
    const existing = drafts.find((n) => body(n).includes(tag(marker)));
    if (existing)
      return {
        id: String(existing.id),
        marker,
        revision,
        authorId: String(user.id),
        baselineNoteId: Math.max(0, ...notes.map((n) => n.id)),
      };
    if (drafts.length)
      throw new AppError(
        'existing_drafts',
        'There are existing GitLab draft notes. Publish or discard them before starting this review.',
      );
    const item = await this.http.request<Note>('POST', `${path(ref)}/draft_notes`, {
      note: `Review in progress.\n\n${tag(marker)}`,
      commit_id: revision.head,
    });
    return {
      id: String(item.id),
      marker,
      revision,
      authorId: String(user.id),
      baselineNoteId: Math.max(0, ...notes.map((n) => n.id)),
    };
  }
  async getReview(ref: PRRef, review: ReviewHandle): Promise<ReviewSnapshot> {
    const [drafts, notes] = await Promise.all([
      this.http.pages<Note>(`${path(ref)}/draft_notes`),
      this.http.pages<Note>(`${path(ref)}/notes`),
    ]);
    const isSummary = (n: Note) => body(n).includes(tag(review.marker));
    const isComment = (n: Note) => body(n).includes(`<!-- ${review.marker}:comment:`);
    const ownAuthor = (n: Note) => String(n.author_id ?? n.author?.id) === review.authorId;
    const summary = drafts.find(isSummary) ?? notes.find((n) => isSummary(n) && ownAuthor(n));
    const draftComments = drafts.filter(isComment);
    const published = notes.filter((n) => isComment(n) && ownAuthor(n));
    const unknown =
      drafts.some((n) => !isSummary(n) && !isComment(n)) ||
      notes.some(
        (n) =>
          ownAuthor(n) &&
          !n.system &&
          n.id > (review.baselineNoteId ?? Infinity) &&
          !isSummary(n) &&
          !isComment(n),
      );
    const stillDraft = drafts.some(isSummary);
    return {
      status:
        unknown || (stillDraft && published.length > 0) || (!stillDraft && draftComments.length > 0)
          ? 'partial'
          : !summary
            ? 'missing'
            : stillDraft
              ? 'draft'
              : 'published',
      body: summary ? body(summary) : '',
      comments: [
        ...draftComments.map((n) => mapComment(ref, n, true)),
        ...published.map((n) => mapComment(ref, n)),
      ],
      url: ref.url,
      revision: review.revision,
    };
  }
  async createComment(
    ref: PRRef,
    review: ReviewHandle,
    text: string,
    marker: string,
    location?: Location,
  ) {
    const position = location
      ? {
          position_type: 'text',
          head_sha: review.revision.head,
          base_sha: review.revision.base,
          start_sha: review.revision.start,
          new_path: location.path,
          old_path: location.oldPath ?? location.path,
          ...(location.side === 'RIGHT'
            ? { new_line: location.line }
            : { old_line: location.line }),
        }
      : undefined;
    if (location?.startLine)
      throw new AppError(
        'range_unsupported',
        'Use a single anchor line for GitLab comments; put the full range in the Markdown body.',
        400,
      );
    const item = await this.http.request<Note>('POST', `${path(ref)}/draft_notes`, {
      note: `${text}\n\n${tag(marker)}`,
      commit_id: review.revision.head,
      ...(position ? { position } : {}),
    });
    return { ...mapComment(ref, item, true), marker };
  }
  async updateComment(ref: PRRef, _review: ReviewHandle, id: string, text: string) {
    return mapComment(
      ref,
      await this.http.request<Note>('PUT', `${path(ref)}/draft_notes/${encodeURIComponent(id)}`, {
        note: text,
      }),
      true,
    );
  }
  async deleteComment(ref: PRRef, _review: ReviewHandle, id: string) {
    await this.http.request('DELETE', `${path(ref)}/draft_notes/${encodeURIComponent(id)}`);
  }
  async updateSummary(ref: PRRef, review: ReviewHandle, text: string) {
    await this.http.request('PUT', `${path(ref)}/draft_notes/${review.id}`, {
      note: `${text}\n\n${tag(review.marker)}`,
    });
  }
  async publish(ref: PRRef, review: ReviewHandle) {
    const drafts = await this.http.pages<Note>(`${path(ref)}/draft_notes`);
    const summary = drafts.find((n) => body(n).includes(tag(review.marker)));
    if (!summary)
      throw new AppError(
        'missing_summary',
        'The draft summary disappeared. Reconcile before publication.',
      );
    const comments = drafts.filter((n) => body(n).includes(`<!-- ${review.marker}:comment:`));
    if (comments.length + 1 !== drafts.length)
      throw new AppError(
        'untracked_drafts',
        'There are untracked draft notes; review them in GitLab before publication.',
      );
    // Publish only this review's notes, with the summary last as its completion marker.
    // Never call bulk_publish: it also publishes drafts outside our control.
    for (const note of [...comments, summary])
      await this.http.request('PUT', `${path(ref)}/draft_notes/${note.id}/publish`);
  }
}
