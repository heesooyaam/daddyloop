import { z } from 'zod';
import { createHash, randomUUID } from 'node:crypto';
import {
  AppError,
  prRef,
  sameRevision,
  type Task,
  type Job,
  type PRRef,
  type ReviewSnapshot,
} from './types.js';
import type { Store } from './store.js';
import { Outbox } from './outbox.js';
import { assertDraft, tag, type ReviewProvider } from '../providers/provider.js';

const body = z.string().min(1).max(60000);
const schemas = {
  read_review: z.object({}).strict(),
  add_comment: z
    .object({
      key: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
      body,
      path: z.string().min(1).optional(),
      line: z.number().int().positive().optional(),
      side: z.enum(['LEFT', 'RIGHT']).default('RIGHT'),
      oldPath: z.string().optional(),
      startLine: z.number().int().positive().optional(),
    })
    .strict(),
  edit_comment: z.object({ id: z.string().min(1), body }).strict(),
  remove_comment: z
    .object({
      id: z.string().min(1),
      reason: body,
      outcome: z.enum(['withdrawn', 'deferred', 'rejected']),
    })
    .strict(),
  set_summary: z.object({ body }).strict(),
  record_decision: z
    .object({
      commentId: z.string().optional(),
      outcome: z.enum(['withdrawn', 'deferred', 'rejected', 'accepted', 'verified', 'disputed']),
      reason: body,
    })
    .strict(),
};
const descriptions: Record<keyof typeof schemas, string> = {
  read_review:
    'Read this task’s current native review and exact Markdown comments. Author access is limited to published feedback.',
  add_comment:
    'Create a native DRAFT comment. Use a stable key such as R1; preserve Markdown, code blocks, links and suggestions. Cite a concrete failure scenario. This does not publish anything.',
  edit_comment:
    'Edit a comment belonging to the current draft review after rechecking its evidence. Preserve the full explanation and links.',
  remove_comment:
    'Withdraw a draft comment with an explicit recorded reason. Distinguish disproven problems from issues deferred by the human.',
  set_summary:
    'Update the current draft review summary: coverage, checks, limitations and decisions. Do not maintain a second list of requirements outside the actual comments.',
  record_decision:
    'Persist a decision about a finding across review rounds. The author cannot verify their own fixes. Do not invent human decisions.',
};
export const dynamicTools = Object.entries(schemas).map(([name, schema]) => ({
  type: 'function',
  name,
  description: descriptions[name as keyof typeof schemas],
  inputSchema: z.toJSONSchema(schema, { target: 'draft-7' }),
}));

export class Broker {
  readonly outbox: Outbox;
  constructor(
    private store: Store,
    private provider: (ref: PRRef) => ReviewProvider,
  ) {
    this.outbox = new Outbox(store);
  }
  async ensureReview(task: Task) {
    if (task.review) return task.review;
    const marker = `reviewloop:${task.id}:${task.generation}:${task.round}`;
    const provider = this.provider(prRef(task)),
      revision = task.revision!;
    const review = await this.outbox.perform(
      task.id,
      marker,
      revision,
      () => provider.createReview(prRef(task), revision, marker),
      async () => {
        const existing = await provider.findReview(prRef(task), marker);
        return existing ? { found: true, value: { ...existing, revision } } : { found: false };
      },
    );
    task.review = review;
    return review;
  }
  async call(
    job: Job,
    tool: string,
    input: unknown,
    callId: string = randomUUID(),
  ): Promise<unknown> {
    const task = this.store.getTask(job.taskId);
    if (task.generation !== job.generation || task.state === 'paused')
      throw new AppError('stale_run', 'This run no longer has permission to change the task');
    if (!Object.hasOwn(schemas, tool))
      throw new AppError('unknown_tool', 'Unknown review tool', 400);
    if (job.role === 'author' && !['read_review', 'record_decision'].includes(tool))
      throw new AppError('role_forbidden', 'Only the reviewer can edit review comments', 403);
    const provider = this.provider(prRef(task));
    if (!task.review)
      throw new AppError('review_missing', 'No native review is attached to this task');
    const snapshot = await provider.getReview(prRef(task), task.review);
    if (tool === 'read_review') {
      schemas.read_review.parse(input);
      if (job.role === 'author' && snapshot.status !== 'published')
        throw new AppError('draft_private', 'Draft feedback has not been published', 403);
      return snapshot;
    }
    const current = await provider.getPR(prRef(task));
    if (
      current.state !== 'open' ||
      !sameRevision(current, task.revision) ||
      this.store.getTask(task.id).generation !== job.generation
    )
      throw new AppError(
        'stale_revision',
        'The PR changed during this run; start a new review before editing comments',
      );
    if (tool === 'record_decision') {
      const data = schemas.record_decision.parse(input);
      if (job.role === 'author' && !['disputed', 'accepted'].includes(data.outcome))
        throw new AppError(
          'role_forbidden',
          'The author may accept or dispute feedback but cannot resolve it',
          403,
        );
      return this.store.decision(task, data);
    }
    assertDraft(snapshot);
    const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex').slice(0, 24);
    const key = `${task.review.marker}:${job.id}:${tool}:${callId}:${hash}`;
    const refresh = () => provider.getReview(prRef(task), task.review!);
    if (tool === 'add_comment') {
      const data = schemas.add_comment.parse(input),
        marker = `${task.review.marker}:comment:${data.key}`;
      if (
        data.path &&
        (!data.line || data.path.startsWith('/') || data.path.split('/').includes('..'))
      )
        throw new AppError('invalid_location', 'Supply a repository-relative path and line', 400);
      if (!data.path && data.line)
        throw new AppError('invalid_location', 'A line needs a file path', 400);
      if (data.startLine && (!data.line || data.startLine > data.line))
        throw new AppError(
          'invalid_location',
          'Start line must be at or before the anchor line',
          400,
        );
      const location =
        data.path && data.line
          ? {
              path: data.path,
              line: data.line,
              side: data.side,
              oldPath: data.oldPath,
              startLine: data.startLine,
            }
          : undefined;
      return this.outbox.perform(
        task.id,
        marker,
        data,
        () => provider.createComment(prRef(task), task.review!, data.body, marker, location),
        async () => {
          const found = (await refresh()).comments.find((c) => c.body.includes(tag(marker)));
          return found ? { found: true, value: found } : { found: false };
        },
      );
    }
    if (tool === 'edit_comment') {
      const data = schemas.edit_comment.parse(input),
        old = snapshot.comments.find((c) => c.id === data.id);
      if (!old) throw new AppError('comment_not_owned', 'Comment is not part of this review', 404);
      const marker = old.body.match(/<!-- reviewloop:[^>]+ -->/)?.[0];
      const next = data.body + (marker ? `\n\n${marker}` : '');
      return this.outbox.perform(
        task.id,
        key,
        data,
        () => provider.updateComment(prRef(task), task.review!, data.id, next),
        async () => {
          const found = (await refresh()).comments.find((c) => c.id === data.id && c.body === next);
          return found ? { found: true, value: found } : { found: false };
        },
      );
    }
    if (tool === 'remove_comment') {
      const data = schemas.remove_comment.parse(input);
      if (!snapshot.comments.some((c) => c.id === data.id))
        throw new AppError('comment_not_owned', 'Comment is not part of this draft review', 404);
      await this.outbox.perform(
        task.id,
        key,
        data,
        async () => {
          await provider.deleteComment(prRef(task), task.review!, data.id);
          return null;
        },
        async () => ({
          found: !(await refresh()).comments.some((c) => c.id === data.id),
          value: null,
        }),
      );
      this.store.decision(task, {
        commentId: data.id,
        outcome: data.outcome,
        reason: data.reason,
      });
      return { removed: data.id };
    }
    const data = schemas.set_summary.parse(input);
    await this.outbox.perform(
      task.id,
      key,
      data,
      async () => {
        await provider.updateSummary(prRef(task), task.review!, data.body);
        return null;
      },
      async () => {
        const s = await refresh();
        return s.body === `${data.body}\n\n${tag(task.review!.marker)}`
          ? { found: true, value: null }
          : { found: false };
      },
    );
    return { summaryUpdated: true };
  }
  async publish(task: Task): Promise<ReviewSnapshot> {
    const provider = this.provider(prRef(task));
    if (!task.review) throw new AppError('review_missing', 'No review to publish');
    const pr = await provider.getPR(prRef(task));
    if (pr.state !== 'open' || !sameRevision(pr, task.review.revision))
      throw new AppError(
        'stale_revision',
        'PR revision changed. This review cannot release feedback for the new revision.',
      );
    const snapshot = await provider.getReview(prRef(task), task.review);
    if (snapshot.status === 'published') return snapshot;
    assertDraft(snapshot);
    await this.outbox.perform(
      task.id,
      `${task.review.marker}:publish`,
      { review: task.review.id },
      async () => {
        await provider.publish(prRef(task), task.review!);
        return null;
      },
      async () =>
        (await provider.getReview(prRef(task), task.review!)).status === 'published'
          ? { found: true, value: null }
          : { found: false },
    );
    return provider.getReview(prRef(task), task.review);
  }
}
