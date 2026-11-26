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
  type ReviewHandle,
  type PullRequest,
} from './types.js';
import type { Store } from './store.js';
import { readReviewDecisions, reviewDecisionQuery } from './review-decisions.js';
import { Outbox } from './outbox.js';
import { sameOpenTarget } from './pr-routing.js';
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
    'Create a native DRAFT comment. Reuse a descriptive acceptance-criterion key across rounds; preserve Markdown, code blocks, links and suggestions. Group related cases. State the expected user outcome, concrete failure and acceptance check. This does not publish anything.',
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

const draftFingerprint = (s: ReviewSnapshot) =>
  createHash('sha256')
    .update(
      JSON.stringify([
        s.authorId,
        s.revision.head,
        s.body,
        s.comments
          .map((c) => [c.id, c.body, c.location])
          .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      ]),
    )
    .digest('hex');

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
    const marker =
      task.draftStart?.marker ?? `daddyloop:${task.id}:${task.generation}:${task.round}`;
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

  async resolveGitHubDraft(
    task: Task,
    provider: ReviewProvider,
    beforeWrite: (owner: string) => Promise<void>,
    allowCreate: boolean,
  ) {
    const intent = task.draftStart!;
    const { marker, revision } = intent;
    const ref = intent.ref ?? prRef(task);
    if (!provider.reviewAccount || !provider.inspectReviewStart || !provider.postReview) {
      if (!allowCreate) return;
      return this.ensureReview(task);
    }

    const owner = await provider.reviewAccount();
    if (intent.owner && intent.owner !== owner)
      throw new AppError(
        'draft_owner_changed',
        'Reconnect the original GitHub account to recover the draft.',
      );

    const operation = this.store.db
      .prepare('SELECT status, result FROM operations WHERE task_id=? AND id=?')
      .get(task.id, marker);
    const confirmed =
      operation?.status === 'done'
        ? (JSON.parse(String(operation.result)) as ReviewHandle)
        : undefined;
    if (operation && !intent.owner)
      throw new AppError(
        'draft_owner_unknown',
        'The original GitHub account was not recorded. Inspect the existing review before continuing.',
      );
    const observed = confirmed ? undefined : await provider.inspectReviewStart(ref, marker, owner);
    const match = confirmed ?? observed?.match;
    if (!match) {
      if (operation)
        throw new AppError(
          'draft_lookup_pending',
          'Waiting for the original GitHub review to become visible.',
        );
      if (!allowCreate) return;
      if (observed?.occupied)
        throw new AppError(
          'draft_occupied',
          'A different pending GitHub review occupies this account.',
        );
      await beforeWrite(owner);
    }

    // Save the native ID before reading the contents. The marker can disappear if the
    // account holder edits or submits the draft while GitHub is still serving stale lists.
    const handle = await this.outbox.perform<ReviewHandle>(
      task.id,
      marker,
      revision,
      () =>
        match
          ? Promise.resolve({ ...match, revision })
          : provider.postReview!(ref, revision, marker, owner),
      async () => (match ? { found: true, value: { ...match, revision } } : { found: false }),
      (error) =>
        error instanceof AppError &&
        [
          'provider_400',
          'provider_401',
          'provider_403',
          'provider_404',
          'provider_422',
          'provider_429',
          'draft_creation_race',
        ].includes(error.code),
    );
    task.snapshot = await provider.getReview(ref, handle);
    if (task.snapshot.status === 'missing' && !task.snapshot.authorId)
      throw new AppError(
        'draft_lookup_pending',
        'Waiting for the original GitHub review to become visible.',
      );
    return handle;
  }

  reconcileDraftEdits(task: Task, draft: ReviewSnapshot) {
    const review = task.review!;
    if (
      task.ref.provider !== 'github' ||
      !review.authorId ||
      draft.authorId !== review.authorId ||
      draft.status !== 'draft' ||
      draft.revision.head !== review.revision.head
    )
      return;
    const rows = this.store.pendingReviewWrites(task.id, review.marker).filter(
      (row) =>
        String(row.id)
          .slice(review.marker.length + 1)
          .split(':')[1] === 'edit_comment',
    );
    if (!rows.length) return;
    const original = this.store.db.prepare(
      "SELECT 1 FROM operations WHERE task_id=? AND status='done' AND (id GLOB ? OR id GLOB ?) AND json_extract(result,'$.id')=? AND json_extract(result,'$.body')=?",
    );
    // Legacy REST refusals have a durable event naming both the exact operation and native comment.
    const failure = this.store.db.prepare(
      "SELECT json_extract(data,'$.error') AS error FROM events WHERE task_id=? AND type='operation.uncertain' AND json_extract(data,'$.operationId')=? ORDER BY id DESC LIMIT 1",
    );
    this.store.transaction(() => {
      for (const row of rows) {
        const key = String(row.id);
        if (this.outbox.isActive(key)) continue;
        const error = failure.get(task.id, key)?.error;
        for (const comment of draft.comments) {
          const marker = comment.body.match(/\n\n<!-- daddyloop:[^>]+ -->$/)?.[0] ?? '';
          const body = marker ? comment.body.slice(0, -marker.length) : comment.body;
          const digest = createHash('sha256')
            .update(JSON.stringify({ id: comment.id, body }))
            .digest('hex');
          if (digest === row.request) {
            this.store.db
              .prepare(
                "UPDATE operations SET status='done',result=? WHERE id=? AND status='pending'",
              )
              .run(JSON.stringify(comment), key);
            this.store.event(task.id, 'operation.recovered', { operationId: key });
            break;
          }
          if (
            typeof error === 'string' &&
            error.startsWith(
              `AppError: PATCH /repos/${task.ref.repo}/pulls/comments/${comment.id}: HTTP 404 `,
            ) &&
            original.get(
              task.id,
              review.marker + ':comment:*',
              review.marker + ':*:edit_comment:*',
              comment.id,
              comment.body,
            )
          ) {
            this.store.db
              .prepare("DELETE FROM operations WHERE id=? AND status='pending'")
              .run(key);
            this.store.event(task.id, 'operation.refused', {
              operationId: key,
              error:
                'Legacy comment edit returned HTTP 404; the confirmed draft text was preserved.',
            });
            break;
          }
        }
      }
    });
  }
  readDecisions(job: Job, pinned: Task, input: unknown) {
    const task = this.store.getTask(job.taskId);
    if (
      task.id !== pinned.id ||
      pinned.generation !== job.generation ||
      task.generation !== job.generation ||
      task.state === 'paused' ||
      !sameRevision(task.revision, pinned.revision) ||
      task.pr?.mergeCommit !== pinned.pr?.mergeCommit
    )
      throw new AppError(
        'stale_run',
        'This run no longer has access to the pinned decision history',
      );
    return readReviewDecisions(this.store, pinned, job.role, reviewDecisionQuery.parse(input));
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
    if (job.kind === 'plan')
      throw new AppError('role_forbidden', 'Architecture planning has no native review tools', 403);
    if (job.kind === 'verify_merge')
      throw new AppError('role_forbidden', 'Merge verification is read-only', 403);
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
      const previous = task.feedback;
      if (
        previous?.status === 'published' &&
        previous.comments.length &&
        (task.round >= 3 ||
          previous.comments.some((c) => c.body.trimEnd().endsWith(`:comment:${data.key} -->`)))
      ) {
        const operations = this.store.db;
        const priorWrite = operations
          .prepare('SELECT 1 FROM operations WHERE task_id=? AND id=?')
          .get(task.id, marker);
        const diagnosis = operations
          .prepare(
            "SELECT 1 FROM operations WHERE task_id=? AND id GLOB ? AND status='done' LIMIT 1",
          )
          .get(task.id, `${task.review.marker}:${job.id}:set_summary:*`);
        if (!priorWrite && !diagnosis)
          throw new AppError(
            'review_strategy_needed',
            'Use set_summary in this turn first. Explain the remaining acceptance criterion, what the previous fix missed, the revised approach and the check that would settle it. Then add the grouped finding.',
          );
      }
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
      const marker = old.body.match(/<!-- daddyloop:[^>]+ -->/)?.[0];
      const next = data.body + (marker ? `\n\n${marker}` : '');
      return this.outbox.perform(
        task.id,
        key,
        data,
        async () =>
          old.body === next
            ? old
            : provider.updateComment(prRef(task), task.review!, data.id, next, old),
        async () => {
          const found = (await refresh()).comments.find((c) => c.id === data.id && c.body === next);
          return found ? { found: true, value: found } : { found: false };
        },
      );
    }
    if (tool === 'remove_comment') {
      const data = schemas.remove_comment.parse(input);
      const old = snapshot.comments.find((c) => c.id === data.id);
      if (!old)
        throw new AppError('comment_not_owned', 'Comment is not part of this draft review', 404);
      await this.outbox.perform(
        task.id,
        key,
        data,
        async () => {
          await provider.deleteComment(prRef(task), task.review!, data.id, old);
          return { id: data.id };
        },
        async () => ({
          found: !(await refresh()).comments.some((c) => c.id === data.id),
          value: { id: data.id },
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
    if (!data.body.trim())
      throw new AppError('empty_summary', 'Write the review summary before saving it.');
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
  hasUnsettledDraftWrites(task: Task, draft: ReviewSnapshot, publishing = false) {
    const marker = task.review!.marker,
      publish = marker + ':publish';
    const reviewed =
      task.reviewFinished &&
      task.snapshot?.status === 'draft' &&
      task.review?.authorId &&
      task.review.authorId === draft.authorId &&
      draftFingerprint(task.snapshot) === draftFingerprint(draft);
    // An absent add is never replayed. A later confirmed summary can supersede an
    // earlier uncertain edit. Keep both operation receipts for the audit trail.
    return this.store.pendingReviewWrites(task.id, marker).some((row) => {
      const id = String(row.id);
      if (id === publish && draft.status === 'draft')
        return !publishing && this.outbox.isActive(id);
      if (this.outbox.isActive(id)) return true;
      if (!reviewed) return true;
      if (id.startsWith(marker + ':comment:'))
        return draft.comments.some((c) => c.body.includes(tag(id)));
      const suffix = '\n\n' + tag(marker);
      if (
        !String(id)
          .slice(marker.length + 1)
          .split(':')
          .includes('set_summary') ||
        !draft.body.endsWith(suffix)
      )
        return true;
      const digest = createHash('sha256')
        .update(JSON.stringify({ body: draft.body.slice(0, -suffix.length) }))
        .digest('hex');
      return !this.store.db
        .prepare(
          `
        SELECT 1 FROM operations o JOIN events e ON o.id=json_extract(e.data,'$.operationId') AND e.task_id=o.task_id
        WHERE o.task_id=? AND o.id GLOB ? AND o.status='done' AND o.request=?
          AND e.type IN ('operation.completed','operation.recovered')
          AND e.id>(SELECT MAX(id) FROM events WHERE task_id=? AND type IN ('operation.started','operation.uncertain')
            AND json_extract(data,'$.operationId')=?) LIMIT 1
      `,
        )
        .get(task.id, marker + ':*:set_summary:*', digest, task.id, id);
    });
  }
  async publish(
    task: Task,
    verifyFindings?: (pr: PullRequest, snapshot: ReviewSnapshot) => Promise<void>,
  ): Promise<ReviewSnapshot> {
    const provider = this.provider(prRef(task));
    if (!task.review) throw new AppError('review_missing', 'No review to publish');
    const ref = prRef(task),
      handle = task.review;
    const key = handle.marker + ':publish';
    const read = async () => {
      const pr = await provider.getPR(ref);
      if (
        !sameOpenTarget(task.pr, pr) ||
        pr.head !== handle.revision.head ||
        (!verifyFindings && !sameRevision(pr, handle.revision))
      )
        throw new AppError(
          'stale_revision',
          'PR revision changed. This review cannot release feedback for the new revision.',
        );
      const draft = await provider.getReview(ref, handle);
      if (verifyFindings) await verifyFindings(pr, draft);
      return draft;
    };
    const draft = await read();
    if (draft.status === 'published') {
      if (
        this.store.db
          .prepare("SELECT 1 FROM operations WHERE id=? AND task_id=? AND status='pending'")
          .get(key, task.id)
      )
        await this.outbox.perform(
          task.id,
          key,
          { review: handle.id },
          async () => null,
          async () => ({ found: true, value: null }),
        );
      return draft;
    }
    assertDraft(draft);
    const baselineKey =
      'review.publish-content:' + key + ':' + handle.revision.head + ':' + handle.revision.base;
    const send = async () => {
      await provider.publish(ref, handle);
      return null;
    };
    await this.outbox.perform(
      task.id,
      key,
      { review: handle.id },
      async () => {
        if (ref.provider === 'github') this.store.setSetting(baselineKey, draftFingerprint(draft));
        return send();
      },
      async () => {
        const current = await read();
        if (current.status === 'published') return { found: true, value: null };
        if (ref.provider !== 'github') return { found: false };
        assertDraft(current);
        const latest = this.store.getTask(task.id),
          group = latest.groupId ? this.store.getGroup(latest.groupId) : undefined;
        const expected =
          this.store.setting<string>(baselineKey) ??
          (task.snapshot?.status === 'draft' &&
          sameRevision(task.snapshot.revision, handle.revision)
            ? draftFingerprint(task.snapshot)
            : undefined);
        if (
          latest.generation !== task.generation ||
          latest.state !== 'awaiting_publication' ||
          latest.review?.id !== handle.id ||
          group?.deletedAt ||
          group?.deletion ||
          group?.daddyState === 'paused' ||
          group?.daddyState === 'archived' ||
          !handle.authorId ||
          handle.authorId !== current.authorId ||
          current.revision.head !== handle.revision.head ||
          !expected ||
          expected !== draftFingerprint(current) ||
          this.hasUnsettledDraftWrites(task, current, true)
        )
          throw new AppError(
            'draft_changed',
            'The review changed before publication could be confirmed. Its contents have been preserved.',
          );
        // Submitting one review ID is a single native transition. Confirm its current state before repeating it.
        this.store.setSetting(baselineKey, expected);
        return { found: true, value: await send() };
      },
    );
    return provider.getReview(prRef(task), task.review);
  }
}
