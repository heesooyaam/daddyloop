import { z } from 'zod';
import type { Store } from './store.js';
import type { Decision, Job, Task } from './types.js';

const promptBudget = 64 * 1024;
const pageSize = 10;

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
    'Read recorded decisions for the pinned task. Filter by commentId or head, and pass nextBefore as before with the same filters for the next page.',
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

export function readReviewDecisions(
  store: Store,
  task: Task,
  role: Job['role'],
  query: z.infer<typeof reviewDecisionQuery>,
) {
  const rows = store.decisionPage(
    task.id,
    query,
    role === 'author' ? publishedCommentIds(task) : undefined,
    pageSize + 1,
  );
  const decisions: Decision[] = [];
  let remaining = promptBudget;
  for (const row of rows.slice(0, pageSize)) {
    if (decisions.length && row.data.length > remaining) break;
    remaining -= row.data.length;
    decisions.push(JSON.parse(row.data) as Decision);
  }
  return {
    decisions,
    nextBefore: decisions.length < rows.length ? rows[decisions.length - 1].id : null,
  };
}
