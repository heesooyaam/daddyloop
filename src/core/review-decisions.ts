import { z } from 'zod';
import type { Store } from './store.js';
import { AppError, type Decision, type Job, type Task } from './types.js';

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
    'Read recorded decisions for the pinned task. Filter by commentId or head. Pass nextBefore unchanged as before with the same filters until null. When reasonOffset is present, the single decision contains a fragment of its reason. Join fragments for the same decision ID in order before treating the reason as complete.',
  inputSchema: z.toJSONSchema(reviewDecisionQuery, { target: 'draft-7' }),
};

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
}

function readReasonFragment(decision: Decision, offset: number, hasOlder: boolean): DecisionPage {
  const reason = decision.reason;
  const page = {
    decisions: [{ ...decision, reason: '' }],
    reasonOffset: offset,
    nextBefore: `${decision.id}:${reason.length}`,
  };
  let remaining = pageByteLimit - Buffer.byteLength(JSON.stringify(page));
  let end = offset;
  // Count the escaped UTF-8 size of each code point without splitting a surrogate pair.
  for (const character of reason.slice(offset)) {
    const bytes = Buffer.byteLength(JSON.stringify(character)) - 2;
    if (bytes > remaining) break;
    remaining -= bytes;
    end += character.length;
  }
  if (end === offset)
    throw new AppError('decision_page_limit', 'Decision metadata leaves no room for its reason');
  return {
    ...page,
    decisions: [{ ...decision, reason: reason.slice(offset, end) }],
    nextBefore: end < reason.length ? `${decision.id}:${end}` : hasOlder ? decision.id : null,
  };
}

export function readReviewDecisions(
  store: Store,
  task: Task,
  role: Job['role'],
  query: z.infer<typeof reviewDecisionQuery>,
): DecisionPage {
  // A continuation includes its row; an ordinary page starts after its cursor.
  const fragment = query.before?.match(/^([^:]+):([1-9][0-9]*)$/);
  const offset = Number(fragment?.[2] ?? 0);
  const rows = store.decisionPage(
    task.id,
    { ...query, before: fragment?.[1] ?? query.before, includeBefore: !!fragment },
    role === 'author' ? publishedCommentIds(task) : undefined,
    fragment ? 2 : pageSize + 1,
  );
  const page: DecisionPage = { decisions: [], nextBefore: null };
  if (!rows.length) return page;
  if (fragment) {
    const decision = JSON.parse(rows[0].data) as Decision;
    if (!Number.isSafeInteger(offset) || offset >= decision.reason.length)
      throw new AppError('invalid_decision_cursor', 'Decision reason cursor is out of range', 400);
    return readReasonFragment(decision, offset, rows.length > 1);
  }

  let decisionBytes = 0;
  for (const [index, row] of rows.slice(0, pageSize).entries()) {
    const nextBefore = index + 1 < rows.length ? row.id : null;
    const bytes = Buffer.byteLength(row.data) + (index ? 1 : 0);
    const envelope = Buffer.byteLength(JSON.stringify({ decisions: [], nextBefore }));
    if (decisionBytes + bytes + envelope > pageByteLimit) {
      if (index === 0) return readReasonFragment(JSON.parse(row.data) as Decision, 0, !!nextBefore);
      break;
    }
    decisionBytes += bytes;
    page.decisions.push(JSON.parse(row.data) as Decision);
    page.nextBefore = nextBefore;
  }
  return page;
}
