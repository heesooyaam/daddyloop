import type {
  PRRef,
  PullRequest,
  ReviewHandle,
  ReviewSnapshot,
  ReviewComment,
  Revision,
  Location,
} from '../core/types.js';
import { AppError } from '../core/types.js';
import { ArcBridge } from '../integrations/arcadia.js';
import { type ReviewProvider, tag, assertDraft } from './provider.js';
type Note = {
  id: number;
  content: string;
  author?: { name?: string };
  is_draft?: boolean;
  deleted_at?: string | null;
  anchor?: { path?: string; file_path?: string; line?: number; side?: string; size?: number };
};
export class ArcadiaProvider implements ReviewProvider {
  constructor(private bridge = new ArcBridge()) {}
  async getPR(ref: PRRef): Promise<PullRequest> {
    const { pr, base } = await this.bridge.metadata(ref.number),
      diffId = await this.bridge.activeDiff(ref.number);
    const checks: {
      name: string;
      status: string;
      url?: string;
      satisfied: boolean;
      required: boolean;
    }[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 100; page++) {
      const result = await this.bridge.api<{
        checks: {
          key?: { system?: string; type?: string };
          status: string;
          satisfied: boolean;
          required: boolean;
          uri?: string;
        }[];
        next_page_cursor?: string;
        next_cursor?: string;
      }>([
        'diff',
        'checks',
        '--pr',
        String(ref.number),
        diffId,
        '--limit',
        '100',
        ...(cursor ? ['--cursor', cursor] : []),
      ]);
      if (!Array.isArray(result.checks))
        throw new Error('Arcanum returned an incomplete checks response');
      checks.push(
        ...result.checks.map((c) => ({
          name: `${c.key?.system ?? 'check'}: ${c.key?.type ?? ''}`,
          status: c.status,
          satisfied: c.satisfied,
          required: c.required,
          url: c.uri,
        })),
      );
      cursor = result.next_page_cursor || result.next_cursor;
      if (!cursor) break;
      if (page === 99) throw new Error('Arcanum check pagination limit reached');
    }
    const required = checks.filter((c) => c.required);
    return {
      head: pr.from_id,
      base,
      start: base,
      revisionId: diffId,
      title: pr.summary,
      body: pr.description ?? '',
      branch: pr.from_branch,
      targetBranch: pr.to_branch,
      cloneUrl: '',
      state:
        pr.status === 'merged'
          ? 'merged'
          : ['discarded', 'closed'].includes(pr.status)
            ? 'closed'
            : 'open',
      checkDetails: checks,
      checks: !required.length
        ? 'missing'
        : required.every((c) => c.satisfied)
          ? 'passing'
          : required.some(
                (c) => ['failure', 'error', 'cancelled'].includes(c.status) && !c.satisfied,
              )
            ? 'failing'
            : 'pending',
    };
  }
  private notes(ref: PRRef, diffId: string) {
    return Promise.all([
      this.bridge.api<Note[]>(['pr', 'comments', String(ref.number)]),
      this.bridge.api<Note[]>(['diff', 'comments', '--pr', String(ref.number), diffId]),
    ]);
  }
  private map(ref: PRRef, note: Note, kind: 'pr' | 'diff'): ReviewComment {
    const anchor = note.anchor;
    return {
      id: `${kind}:${note.id}`,
      body: note.content,
      url: `${ref.url}#comment-${note.id}`,
      author: note.author?.name,
      ...(anchor?.line && (anchor.file_path || anchor.path)
        ? {
            location: {
              path: anchor.file_path ?? anchor.path!,
              line: anchor.line,
              side: anchor.side === 'old' ? ('LEFT' as const) : ('RIGHT' as const),
            },
          }
        : {}),
    };
  }
  async findReview(ref: PRRef, marker: string) {
    const { user } = await this.bridge.metadata(ref.number),
      diffId = await this.bridge.activeDiff(ref.number);
    const [notes] = await this.notes(ref, diffId),
      summary = notes.find(
        (n) => n.author?.name === user && n.content.includes(tag(marker)) && !n.deleted_at,
      );
    return summary
      ? {
          id: String(summary.id),
          marker,
          nodeId: diffId,
          authorId: user,
          revision: { head: '', base: '', start: '', revisionId: diffId },
        }
      : undefined;
  }
  async createReview(ref: PRRef, revision: Revision, marker: string): Promise<ReviewHandle> {
    const { user } = await this.bridge.metadata(ref.number),
      diffId = revision.revisionId ?? (await this.bridge.activeDiff(ref.number));
    const [notes, inline] = await this.notes(ref, diffId);
    if ([...notes, ...inline].some((n) => n.author?.name === user && n.is_draft && !n.deleted_at))
      throw new AppError(
        'existing_drafts',
        'Existing Arcanum drafts were preserved. Publish or discard them before starting a new review.',
      );
    const note = await this.bridge.api<Note>(
      [
        'pr',
        'create-comment',
        String(ref.number),
        '--content',
        `Review in progress.\n\n${tag(marker)}`,
        '--is-draft',
      ],
      true,
    );
    if (!Number.isSafeInteger(note.id))
      throw new Error('Arcanum did not confirm the created draft ID');
    return {
      id: String(note.id),
      nodeId: diffId,
      marker,
      authorId: note.author?.name ?? user,
      revision,
    };
  }
  async getReview(ref: PRRef, review: ReviewHandle): Promise<ReviewSnapshot> {
    const [general, inline] = await this.notes(ref, review.nodeId!);
    const owned = (note: Note) => !note.deleted_at && note.author?.name === review.authorId;
    const summary = general.find((n) => owned(n) && n.content.includes(tag(review.marker)));
    const isFinding = (n: Note) => owned(n) && n.content.includes(`<!-- ${review.marker}:comment:`);
    const notes = [...general.filter(isFinding), ...inline.filter(isFinding)];
    const unknown = [...general, ...inline].some(
      (n) => owned(n) && n.is_draft && !n.content.includes(`<!-- ${review.marker}`),
    );
    const partial =
      unknown || (!!summary && notes.some((n) => !!n.is_draft !== !!summary.is_draft));
    return {
      status: partial ? 'partial' : !summary ? 'missing' : summary.is_draft ? 'draft' : 'published',
      body: summary?.content ?? '',
      comments: [
        ...general.filter(isFinding).map((n) => this.map(ref, n, 'pr')),
        ...inline.filter(isFinding).map((n) => this.map(ref, n, 'diff')),
      ],
      url: ref.url,
      revision: review.revision,
    };
  }
  async createComment(
    ref: PRRef,
    review: ReviewHandle,
    body: string,
    marker: string,
    location?: Location,
  ) {
    const content = `${body}\n\n${tag(marker)}`;
    const args = location
      ? [
          'diff',
          'create-comment',
          '--pr',
          String(ref.number),
          review.nodeId!,
          '--content',
          content,
          '--is-draft',
          '--file-path',
          location.path,
          '--line',
          String(location.startLine ?? location.line),
          '--side',
          location.side === 'LEFT' ? 'old' : 'new',
          '--size',
          String(location.startLine ? location.line - location.startLine + 1 : 1),
        ]
      : ['pr', 'create-comment', String(ref.number), '--content', content, '--is-draft'];
    const note = await this.bridge.api<Note>(args, true);
    if (!Number.isSafeInteger(note.id)) throw new Error('Arcanum did not confirm the comment ID');
    const snapshot = await this.getReview(ref, review);
    const actual = snapshot.comments.find((c) => c.body.includes(tag(marker)));
    if (!actual) throw new Error('The newly created Arcanum draft could not be read back');
    return { ...actual, location, marker };
  }
  private id(value: string) {
    const match = value.match(/^(pr|diff):(-?\d+)$/);
    if (!match) throw new Error('Invalid Arcanum comment identity');
    return { kind: match[1], id: match[2] };
  }
  async updateComment(ref: PRRef, review: ReviewHandle, id: string, body: string) {
    const item = this.id(id),
      args =
        item.kind === 'pr'
          ? ['pr', 'update-comment', String(ref.number), item.id, '--content', body]
          : ['diff', 'update-comment', item.id, '--diff-id', review.nodeId!, '--content', body];
    await this.bridge.api(args, true);
    const snapshot = await this.getReview(ref, review);
    const actual = snapshot.comments.find((c) => c.id === id);
    if (!actual) throw new Error('Updated Arcanum comment could not be read back');
    return actual;
  }
  async deleteComment(ref: PRRef, review: ReviewHandle, id: string) {
    const item = this.id(id);
    await this.bridge.api(
      item.kind === 'pr'
        ? ['pr', 'delete-comment', String(ref.number), item.id]
        : ['diff', 'delete-comment', item.id, '--diff-id', review.nodeId!],
      true,
    );
  }
  async updateSummary(ref: PRRef, review: ReviewHandle, body: string) {
    await this.bridge.api(
      [
        'pr',
        'update-comment',
        String(ref.number),
        review.id,
        '--content',
        `${body}\n\n${tag(review.marker)}`,
      ],
      true,
    );
  }
  async publish(ref: PRRef, review: ReviewHandle) {
    const snapshot = await this.getReview(ref, review);
    assertDraft(snapshot);
    const general = [review.id],
      inline: string[] = [];
    for (const note of snapshot.comments) {
      const item = this.id(note.id);
      (item.kind === 'pr' ? general : inline).push(item.id);
    }
    await this.bridge.api(
      [
        'draft-comment',
        'publish',
        `--comment-for-review-ids=${general.join(',')}`,
        ...(inline.length ? [`--comment-for-diff-ids=${inline.join(',')}`] : []),
      ],
      true,
    );
  }
}
