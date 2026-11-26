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
  type ReviewComment,
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
    const create = (replay: boolean) =>
      provider.createReview(
        prRef(task),
        revision,
        marker,
        task.draftStart
          ? async (owner) => {
              if (replay) {
                const pr = await provider.getPR(prRef(task));
                if (!sameOpenTarget(task.pr, pr) || !sameRevision(revision, pr) || pr.draft)
                  throw new AppError(
                    'draft_revision_changed',
                    'The PR changed during draft recovery.',
                  );
              }
              const latest = this.store.getTask(task.id);
              const intent = latest.draftStart;
              const group = latest.groupId ? this.store.getGroup(latest.groupId) : undefined;
              if (
                !intent ||
                intent.marker !== marker ||
                latest.generation !== task.generation ||
                latest.state === 'paused' ||
                group?.deletion ||
                group?.deletedAt ||
                group?.daddyState === 'paused' ||
                group?.daddyState === 'archived'
              )
                throw new AppError('stale_task', 'The task changed during draft recovery.');
              if (intent.owner && intent.owner !== owner)
                throw new AppError(
                  'draft_owner_changed',
                  'The GitHub account changed during draft recovery.',
                );
              if (!intent.owner) {
                intent.owner = owner;
                task.draftStart!.owner = owner;
                this.store.saveTask(latest);
              }
            }
          : undefined,
      );
    const review = await this.outbox.perform(
      task.id,
      marker,
      revision,
      () => create(false),
      async () => {
        // The GitHub draft create checks all of this account's reviews before writing,
        // reuses the marked draft and refuses to touch a different pending review.
        if (task.ref.provider === 'github' && task.draftStart)
          return { found: true, value: await create(true) };
        const existing = await provider.findReview(prRef(task), marker);
        if (
          task.ref.provider === 'arcadia' &&
          existing &&
          (existing.nodeId !== revision.revisionId || existing.revision.head !== revision.head)
        )
          throw new AppError(
            'diff_unavailable',
            'Arcanum has not confirmed the pinned diff for this review',
            503,
          );
        return existing ? { found: true, value: { ...existing, revision } } : { found: false };
      },
      (error) =>
        task.ref.provider === 'arcadia' &&
        error instanceof AppError &&
        error.code === 'diff_unavailable',
    );
    task.review = review;
    return review;
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
  assertReviewHistoryAccess(job: Job, pinned: Task) {
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
        'This run no longer has access to the pinned decision history or published review evidence',
      );
  }
  readDecisions(job: Job, pinned: Task, input: unknown) {
    this.assertReviewHistoryAccess(job, pinned);
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
    const snapshot =
      job.role === 'author' && tool === 'read_review'
        ? await this.readCurrentReview(task)
        : await provider.getReview(prRef(task), task.review);
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
  async readCurrentReview(
    task: Task,
    confirmedPublishedIds: readonly string[] = [],
  ): Promise<ReviewSnapshot> {
    const handle = task.review;
    if (!handle) throw new AppError('review_missing', 'No native review to read');
    const ref = prRef(task);
    const provider = this.provider(ref);
    if (!['gitlab', 'arcadia', 'github'].includes(ref.provider))
      return provider.getReview(ref, handle);

    // A snapshot is evidence only for its own review and revision.
    const snapshots = [
      task.snapshot,
      task.feedbackReview?.id === handle.id ? task.feedback : undefined,
    ].filter(
      (snapshot): snapshot is ReviewSnapshot =>
        !!snapshot &&
        sameRevision(snapshot.revision, handle.revision) &&
        (snapshot.status === 'draft' || snapshot.status === 'published'),
    );
    const hasPublishedSnapshot =
      confirmedPublishedIds.length > 0 ||
      snapshots.some((snapshot) => snapshot.status === 'published');
    const nativeIds = new Set(confirmedPublishedIds);
    const draftNotes = new Map<string, ReviewComment>();
    for (const snapshot of snapshots) {
      for (const comment of snapshot.comments) {
        // A confirmed publication supersedes its draft, whose IDs can differ.
        if (snapshot.status === 'published') nativeIds.add(comment.id);
        else if (!hasPublishedSnapshot) draftNotes.set(comment.id, comment);
      }
    }
    const requestedIds =
      ref.provider === 'arcadia' ? [...nativeIds, ...draftNotes.keys()] : [...nativeIds];
    const native = await provider.getReview(ref, handle, { knownCommentIds: requestedIds });
    const hold = () => {
      throw new AppError(
        'feedback_unconfirmed',
        'Could not account for the recorded findings in the native review. Inspect the preserved snapshot before continuing.',
      );
    };
    if (native.status === 'partial' || native.status === 'missing') {
      if (nativeIds.size || draftNotes.size) hold();
      return native;
    }
    if (draftNotes.size) {
      // A confirmed deletion through the review tool is durable even if the
      // application stops before it refreshes the saved draft.
      const removed = this.store.db
        .prepare(
          `SELECT json_extract(result,'$.id') AS comment_id FROM operations
          WHERE task_id=? AND id GLOB ? AND status='done'`,
        )
        .all(task.id, handle.marker + ':*:remove_comment:*');
      for (const row of removed)
        if (typeof row.comment_id === 'string') draftNotes.delete(row.comment_id);
    }
    const ids = new Set(native.comments.map((comment) => comment.id));
    if (native.status === 'draft') {
      if (hasPublishedSnapshot || [...draftNotes.keys()].some((id) => !ids.has(id))) hold();
      return native;
    }
    if (
      !sameRevision(native.revision, handle.revision) ||
      (!snapshots.length && (task.state === 'awaiting_publication' || task.state === 'fixing')) ||
      [...nativeIds].some((id) => !ids.has(id))
    )
      hold();

    // GitLab allocates a new ID on publication. Arcanum can also return a
    // different ID for a draft; an intact marker proves that correspondence.
    const marker = (comment: ReviewComment) =>
      comment.body
        .match(/<!-- ([^\s]+:comment:[a-zA-Z0-9_-]+) -->/g)
        ?.find((tag) => tag.startsWith(`<!-- ${handle.marker}:comment:`));
    const matched = new Set<string>();
    for (const draft of draftNotes.values()) {
      const key = marker(draft);
      const candidates = native.comments.filter(
        (note) =>
          (ref.provider !== 'gitlab' && note.id === draft.id) ||
          (ref.provider !== 'github' && key !== undefined && marker(note) === key),
      );
      if (candidates.length !== 1 || matched.has(candidates[0].id)) hold();
      matched.add(candidates[0].id);
    }
    return native;
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
      const draft = await this.readCurrentReview(task);
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
    return this.readCurrentReview(task);
  }
}
