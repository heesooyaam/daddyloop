import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Store } from './store.js';
import { AppError, type Decision, type Job, type Task, type ReviewSnapshot } from './types.js';

const promptBudget = 64 * 1024;
const pageSize = 10;
// Leave room under Codex's tool-output token limit even for densely tokenized Markdown.
const pageByteLimit = 4 * 1024;

export const reviewDecisionQuery = z
  .object({
    commentId: z.string().min(1).optional(),
    head: z.string().min(1).optional(),
    before: z.string().min(1).optional(),
  })
  .strict();

export const reviewDecisionTool = {
  name: 'read_review_decisions',
  description:
    'Read recorded decisions for the pinned task. Filter by commentId or head. Pass nextBefore unchanged as before with the same filters until null. When reasonOffset is present, the single decision contains a fragment of its reason. Join reason fragments for the same decision ID in order. If recordFragment is present, join its json strings for that ID and parse the combined JSON when complete is true.',
  inputSchema: z.toJSONSchema(reviewDecisionQuery, { target: 'draft-7' }),
};

export const publishedReviewQuery = z
  .object({
    publication: z.number().int().nonnegative(),
    comment: z.number().int().nonnegative().optional(),
    offset: z.number().int().nonnegative().optional(),
  })
  .strict();

export const publishedReviewTool = {
  name: 'read_published_review',
  description:
    'Read the published evidence captured for this review run. Start at publication 0. Omit comment to read the summary, or use a zero-based comment index below commentCount to read one finding with its native ID and Markdown. Join json fragments for the same publication and comment by passing nextOffset back as offset until null, then parse the combined JSON.',
  inputSchema: z.toJSONSchema(publishedReviewQuery, { target: 'draft-7' }),
};

export function readPublishedReview(evidence: ReviewSnapshot[], input: unknown) {
  const { publication, comment, offset = 0 } = publishedReviewQuery.parse(input);
  const snapshot = evidence[publication];
  const finding = comment === undefined ? undefined : snapshot?.comments[comment];
  if (!snapshot || snapshot.status !== 'published' || (comment !== undefined && !finding))
    throw new AppError('published_evidence_missing', 'No published evidence at that index', 404);
  const data = JSON.stringify(
    finding ?? {
      body: snapshot.body,
      url: snapshot.url,
      revision: snapshot.revision,
    },
  );
  if (offset >= data.length)
    throw new AppError(
      'invalid_review_offset',
      'The published evidence offset is out of range',
      400,
    );
  const page = {
    commentCount: snapshot.comments.length,
    json: '',
    nextOffset: data.length as number | null,
  };
  const end = fragmentEnd(data, offset, pageByteLimit - Buffer.byteLength(JSON.stringify(page)));
  page.json = data.slice(offset, end);
  page.nextOffset = end < data.length ? end : null;
  return page;
}

function publishedCommentIds(task: Task) {
  return task.feedback?.status === 'published'
    ? task.feedback.comments.map((comment) => comment.id)
    : [];
}

function visibleDecisions(store: Store, task: Task, role: Job['role']): Decision[] {
  const decisions = store.decisions(task.id);
  if (role === 'reviewer') return decisions;
  const published = new Set(publishedCommentIds(task));
  return decisions.filter((decision) => decision.commentId && published.has(decision.commentId));
}

export function reviewDecisionContext(store: Store, task: Task, role: Job['role'], budget: number) {
  const history = visibleDecisions(store, task, role);
  const findings = new Set([
    ...(task.feedback?.comments.map((comment) => comment.id) ?? []),
    ...(role === 'reviewer' ? (task.snapshot?.comments.map((comment) => comment.id) ?? []) : []),
  ]);
  const seen = new Set<string>();
  const selected = new Set<string>();
  let remaining = Math.min(promptBudget, budget) - 2;
  const newest = history.toReversed();
  // Reserve room for findings the worker needs and for task-level decisions.
  const relevant = newest.filter((d) => !d.commentId || findings.has(d.commentId));
  const otherCurrent = newest.filter(
    (d) => d.commentId && !findings.has(d.commentId) && d.head === task.revision?.head,
  );

  for (const decision of [...relevant, ...otherCurrent]) {
    const current = decision.head === task.revision?.head;

    // Keep each kind of decision independently. In particular, a decision on an
    // earlier head must not replace verification of the pinned head.
    const key = decision.commentId
      ? JSON.stringify([decision.commentId, decision.outcome, current])
      : decision.id;
    if (seen.has(key)) continue;
    seen.add(key);

    const serialized = JSON.stringify(decision, null, 2);
    // Every line gains four spaces inside the top-level decisions array.
    const size = serialized.length + 4 * serialized.split('\n').length + 2;
    if (size > remaining) continue;
    remaining -= size;
    selected.add(decision.id);
  }

  const decisions = history.filter((d) => selected.has(d.id));
  return { decisions, moreDecisions: decisions.length < history.length };
}

export interface DecisionPage {
  decisions: Decision[];
  nextBefore: string | null;
  reasonOffset?: number;
  recordFragment?: { id: string; offset: number; json: string; complete: boolean };
}

function fragmentEnd(text: string, offset: number, budget: number): number {
  let end = offset;
  // Count the escaped UTF-8 size of each code point without splitting a surrogate pair.
  for (const character of text.slice(offset)) {
    const bytes = Buffer.byteLength(JSON.stringify(character)) - 2;
    if (bytes > budget) break;
    budget -= bytes;
    end += character.length;
  }
  return end;
}

function readReasonFragment(
  decision: Decision,
  offset: number,
  hasOlder: boolean,
): DecisionPage | undefined {
  const reason = decision.reason;
  const page = {
    decisions: [{ ...decision, reason: '' }],
    reasonOffset: reason.length,
    nextBefore: `${decision.id}:${reason.length}`,
  };
  // Measure with the longest offsets. If repeated metadata takes over half
  // the page, fragment the record so the metadata is sent only once.
  const budget = pageByteLimit - Buffer.byteLength(JSON.stringify(page));
  if (budget < pageByteLimit / 2 || !reason.length) return undefined;
  const end = fragmentEnd(reason, offset, budget);
  return {
    decisions: [{ ...decision, reason: reason.slice(offset, end) }],
    reasonOffset: offset,
    nextBefore: end < reason.length ? `${decision.id}:${end}` : hasOlder ? decision.id : null,
  };
}

function readRecordFragment(
  row: { id: string; data: string },
  offset: number,
  hasOlder: boolean,
): DecisionPage {
  const { id, data } = row;
  const envelope = {
    decisions: [],
    recordFragment: { id, offset: data.length, json: '', complete: false },
    nextBefore: `${id}:record:${data.length}`,
  };
  const budget = pageByteLimit - Buffer.byteLength(JSON.stringify(envelope));
  const end = fragmentEnd(data, offset, budget);
  const complete = end === data.length;
  return {
    decisions: [],
    recordFragment: { id, offset, json: data.slice(offset, end), complete },
    nextBefore: complete ? (hasOlder ? id : null) : `${id}:record:${end}`,
  };
}

export function readReviewDecisions(
  store: Store,
  task: Task,
  role: Job['role'],
  query: z.infer<typeof reviewDecisionQuery>,
): DecisionPage {
  // A continuation includes its row; an ordinary page starts after its cursor.
  const fragment = query.before?.match(/^([^:]+):(?:(record):)?([1-9][0-9]*)$/);
  const offset = Number(fragment?.[3] ?? 0);
  const rows = store.decisionPage(
    task.id,
    { ...query, before: fragment?.[1] ?? query.before, includeBefore: !!fragment },
    role === 'author' ? publishedCommentIds(task) : undefined,
    fragment ? 2 : pageSize + 1,
  );
  const page: DecisionPage = { decisions: [], nextBefore: null };
  if (!rows.length) return page;
  if (fragment) {
    const row = rows[0];
    const record = fragment[2] === 'record';
    const decision = record ? undefined : (JSON.parse(row.data) as Decision);
    if (!Number.isSafeInteger(offset) || offset >= (decision?.reason.length ?? row.data.length))
      throw new AppError(
        'invalid_decision_cursor',
        'Decision fragment cursor is out of range',
        400,
      );
    const hasOlder = rows.length > 1;
    return decision
      ? (readReasonFragment(decision, offset, hasOlder) ?? readRecordFragment(row, 0, hasOlder))
      : readRecordFragment(row, offset, hasOlder);
  }

  let decisionBytes = 0;
  for (const [index, row] of rows.slice(0, pageSize).entries()) {
    const nextBefore = index + 1 < rows.length ? row.id : null;
    const bytes = Buffer.byteLength(row.data) + (index ? 1 : 0);
    const envelope = Buffer.byteLength(JSON.stringify({ decisions: [], nextBefore }));
    if (decisionBytes + bytes + envelope > pageByteLimit) {
      if (index === 0) {
        const decision = JSON.parse(row.data) as Decision;
        return (
          readReasonFragment(decision, 0, !!nextBefore) ?? readRecordFragment(row, 0, !!nextBefore)
        );
      }
      break;
    }
    decisionBytes += bytes;
    page.decisions.push(JSON.parse(row.data) as Decision);
    page.nextBefore = nextBefore;
  }
  return page;
}

export function findingVersion(comment: import('./types.js').ReviewComment) {
  const { body, location, resolved } = comment;
  return createHash('sha256')
    .update(
      JSON.stringify([
        body,
        location?.path,
        location?.line,
        location?.side,
        location?.oldPath,
        location?.startLine,
        resolved ?? false,
      ]),
    )
    .digest('hex');
}
