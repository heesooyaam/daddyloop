import type { Store } from './store.js';
import type { Decision, Job, Task } from './types.js';

const promptBudget = 64 * 1024;
const pageSize = 10;

function visibleDecisions(store: Store, task: Task, role: Job['role']): Decision[] {
  const decisions = store.decisions(task.id);
  if (role === 'reviewer') return decisions;
  if (task.feedback?.status !== 'published') return [];
  const published = new Set(task.feedback.comments.map((comment) => comment.id));
  return decisions.filter((decision) => decision.commentId && published.has(decision.commentId));
}

export function reviewDecisionContext(store: Store, task: Task, role: Job['role']) {
  const history = visibleDecisions(store, task, role);
  const findings = new Set([
    ...(task.feedback?.comments.map((comment) => comment.id) ?? []),
    ...(role === 'reviewer' ? (task.snapshot?.comments.map((comment) => comment.id) ?? []) : []),
  ]);
  const seen = new Set<string>();
  const selected = new Set<string>();
  let remaining = promptBudget;
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

    const size = JSON.stringify(decision, null, 2).length + 64;
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
  query: { commentId?: string; head?: string; before?: string },
) {
  const history = visibleDecisions(store, task, role)
    .filter(
      (decision) =>
        (query.commentId === undefined || decision.commentId === query.commentId) &&
        (query.head === undefined || decision.head === query.head),
    )
    .reverse();
  const start =
    query.before === undefined ? 0 : history.findIndex((d) => d.id === query.before) + 1;
  if (query.before !== undefined && !start) return { decisions: [], nextBefore: null };

  const decisions: Decision[] = [];
  let remaining = promptBudget;
  for (const decision of history.slice(start, start + pageSize)) {
    const size = JSON.stringify(decision).length;
    if (decisions.length && size > remaining) break;
    remaining -= size;
    decisions.push(decision);
  }
  return {
    decisions,
    nextBefore: start + decisions.length < history.length ? decisions.at(-1)?.id : null,
  };
}
