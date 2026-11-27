import { createHash } from 'node:crypto';
import type { Store } from './store.js';
import {
  sameRevision,
  type ReviewComment,
  type ReviewFixAttempt,
  type ReviewRecovery,
  type ReviewSnapshot,
  type Task,
} from './types.js';

export function findingKey(taskId: string, finding: ReviewComment) {
  const marker = finding.body.match(/<!-- (daddyloop:[^\s<>]+) -->\s*$/)?.[1] ?? finding.marker;
  const match = marker?.match(/^daddyloop:([^:]+):\d+:\d+:comment:([A-Za-z0-9_-]{1,64})$/);
  return match?.[1] === taskId ? match[2] : undefined;
}

export function feedbackFingerprint(snapshot: ReviewSnapshot) {
  return createHash('sha256')
    .update(
      JSON.stringify([
        snapshot.body,
        snapshot.authorId,
        snapshot.comments
          .map((c) => [c.id, c.body, c.location, c.resolved])
          .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      ]),
    )
    .digest('hex');
}

function releasedFeedback(store: Store, taskId: string, attempt: ReviewFixAttempt) {
  // The author reads the published native snapshot at admission, including in pre-upgrade stores.
  let row = store.db
    .prepare(
      "SELECT data FROM events WHERE task_id=? AND run_id=? AND type='author.feedback_snapshot' ORDER BY id DESC LIMIT 1",
    )
    .get(taskId, attempt.runId);
  if (!row && attempt.reviewId)
    row = store.db
      .prepare(
        "SELECT json_extract(data,'$.snapshot') AS data FROM events WHERE task_id=? AND type='review.published' AND json_extract(data,'$.reviewId')=? ORDER BY id DESC LIMIT 1",
      )
      .get(taskId, attempt.reviewId);
  if (typeof row?.data !== 'string') return;
  const snapshot: ReviewSnapshot = JSON.parse(row.data);
  if (snapshot.status === 'published' && sameRevision(snapshot.revision, attempt.before))
    return snapshot;
}

/** Walk two real commit edges backwards. Re-reading the same head or receiving an external push proves no failed fix. */
export function repeatedReviewFindings(
  store: Store,
  task: Task,
  snapshot: ReviewSnapshot,
): Omit<ReviewRecovery, 'runId'> | undefined {
  if (
    task.kind !== 'code' ||
    task.reportOnly ||
    !task.review ||
    !task.pr ||
    task.fixingMergeConflict ||
    snapshot.status !== 'published' ||
    !sameRevision(snapshot.revision, task.revision) ||
    !sameRevision(snapshot.revision, task.review.revision)
  )
    return;
  const last = task.reviewRecovery;
  // The worker consumes the whole publication and the accepted plan. Re-entering
  // with the same evidence must not elect a different subset of its findings.
  if (
    last &&
    last.reviewId === task.review.id &&
    sameRevision(last.revision, snapshot.revision) &&
    last.branch === task.pr.branch &&
    last.targetBranch === task.pr.targetBranch &&
    last.fingerprint === feedbackFingerprint(snapshot)
  )
    return;
  let keys = [
    ...new Set(
      snapshot.comments.map((c) => findingKey(task.id, c)).filter((k): k is string => !!k),
    ),
  ];
  const attempts: ReviewFixAttempt[] = [];
  let next = snapshot.revision;
  let cursor = Number.MAX_SAFE_INTEGER;
  const seen = new Set([next.head]);
  const saved = store.db
    .prepare(`SELECT e.id,e.data,e.run_id FROM events e JOIN jobs j ON j.id=e.run_id AND j.task_id=e.task_id
    WHERE e.task_id=? AND e.id<? AND e.type='author.fixes_saved' AND json_extract(e.data,'$.head')=?
    AND json_extract(e.data,'$.revision.head')!=? AND json_extract(j.data,'$.kind')='fix'
    ORDER BY e.id DESC LIMIT 1`);
  while (keys.length && attempts.length < 2) {
    const row = saved.get(task.id, cursor, next.head, next.head);
    if (!row) return;
    const receipt = JSON.parse(String(row.data)) as {
      revision: ReviewFixAttempt['before'];
      head: string;
      reviewId?: string;
      branch?: string;
      targetBranch?: string;
      conflict?: boolean;
    };
    if (receipt.conflict || seen.has(receipt.revision.head)) return;
    if (
      receipt.targetBranch !== undefined
        ? receipt.targetBranch !== task.pr.targetBranch || receipt.branch !== task.pr.branch
        : receipt.revision.base !== next.base
    )
      return;
    const attempt: ReviewFixAttempt = {
      runId: String(row.run_id),
      before: receipt.revision,
      after: receipt.head,
      reviewId: receipt.reviewId,
    };
    const prior = releasedFeedback(store, task.id, attempt);
    if (!prior) return;
    const earlier = new Set(prior.comments.map((c) => findingKey(task.id, c)));
    keys = keys.filter((k) => earlier.has(k));
    attempts.push(attempt);
    seen.add(attempt.before.head);
    next = attempt.before;
    cursor = Number(row.id);
  }
  if (attempts.length !== 2) return;
  if (
    last &&
    last.branch === task.pr.branch &&
    last.targetBranch === task.pr.targetBranch &&
    (last.revision.head === snapshot.revision.head ||
      last.revision.head === attempts[0].before.head)
  )
    keys = keys.filter((k) => !last.criteria.includes(k));
  if (!keys.length) return;
  return {
    reviewId: task.review.id,
    revision: snapshot.revision,
    branch: task.pr.branch,
    targetBranch: task.pr.targetBranch,
    fingerprint: feedbackFingerprint(snapshot),
    criteria: keys.sort(),
    attempts: attempts.reverse(),
  };
}

/** Recover a previously completed handoff on stores affected by repeated planning. */
export function completedArchitectPlan(store: Store, task: Task, recovery: ReviewRecovery) {
  const row = store.db
    .prepare(
      `
    SELECT p.data AS receipt, q.data AS request, m.data AS message, p.run_id AS runId
    FROM events p
    JOIN jobs j ON j.id=p.run_id AND j.task_id=p.task_id AND j.status='completed'
    JOIN jobs original ON original.id=? AND original.task_id=p.task_id
    JOIN events q ON q.run_id=j.id AND q.task_id=p.task_id AND q.type='review.architect_requested'
    JOIN messages m ON m.id=j.id AND m.task_id=p.task_id
    WHERE p.task_id=? AND p.type='review.architect_planned'
      AND json_extract(j.data,'$.kind')='plan'
      AND json_extract(j.data,'$.generation')=json_extract(original.data,'$.generation')
      AND json_extract(p.data,'$.reviewId')=? AND json_extract(p.data,'$.criteria')=?
      AND NOT EXISTS (SELECT 1 FROM messages n WHERE n.task_id=p.task_id AND n.rowid>m.rowid
        AND json_extract(n.data,'$.sender')='user')
    ORDER BY p.id DESC LIMIT 1
  `,
    )
    .get(recovery.runId, task.id, recovery.reviewId, JSON.stringify(recovery.criteria));
  if (!row) return;
  const receipt = JSON.parse(String(row.receipt));
  const request = JSON.parse(String(row.request));
  const message = JSON.parse(String(row.message));
  if (
    !sameRevision(receipt.revision, recovery.revision) ||
    request.reviewId !== recovery.reviewId ||
    !sameRevision(request.revision, recovery.revision) ||
    JSON.stringify(request.attempts) !== JSON.stringify(recovery.attempts) ||
    message.role !== 'author' ||
    message.sender !== 'agent' ||
    message.runId !== row.runId ||
    typeof message.text !== 'string' ||
    !message.text.trim()
  )
    return;
  if (receipt.fingerprint !== undefined) {
    if (receipt.fingerprint !== recovery.fingerprint) return;
  } else {
    // Old receipts predate fingerprints. Require the original published snapshot,
    // the same worker commit edges and the original job generation as evidence.
    const publication = store.db
      .prepare(
        `SELECT json_extract(data,'$.snapshot') AS snapshot
      FROM events WHERE task_id=? AND type='review.published' AND json_extract(data,'$.reviewId')=?
      ORDER BY id DESC LIMIT 1`,
      )
      .get(task.id, recovery.reviewId);
    if (typeof publication?.snapshot !== 'string') return;
    const published: ReviewSnapshot = JSON.parse(publication.snapshot);
    if (
      published.status !== 'published' ||
      !sameRevision(published.revision, recovery.revision) ||
      feedbackFingerprint(published) !== recovery.fingerprint
    )
      return;
  }
  return { runId: String(row.runId), text: message.text.trim() as string };
}

export function recoveryEvidence(store: Store, task: Task, recovery: ReviewRecovery) {
  // Keep all source references in the journal. Share a compact sample per revision in this turn.
  const excerptSize = Math.min(
    740,
    Math.floor(2100 / Math.max(1, Math.min(recovery.criteria.length, 8))),
  );
  const findings = (snapshot: ReviewSnapshot | undefined) =>
    snapshot?.comments
      .flatMap((c) => {
        const key = findingKey(task.id, c);
        return key && recovery.criteria.includes(key)
          ? [{ key, id: c.id, url: c.url, body: c.body.slice(0, excerptSize) }]
          : [];
      })
      .slice(0, 8);
  return {
    criteria: recovery.criteria,
    fixes: recovery.attempts.map((a) => {
      const review = releasedFeedback(store, task.id, a);
      return {
        from: a.before.head,
        to: a.after,
        review: review?.url,
        findings: findings(review),
        workerReport: store.messageById(task.id, a.runId)?.text.slice(0, 1200),
      };
    }),
    current: {
      revision: recovery.revision,
      review: task.feedback?.url,
      summary: task.feedback?.body.slice(0, 1000),
      findings: findings(task.feedback),
    },
  };
}

/** Send only relevant excerpts from other visible plans, never sibling review/agent conversations. */
export function relatedArchitecturePlans(task: Task, siblings: Task[]) {
  const own = [
    task.requirements,
    task.source?.body,
    task.planning?.result?.text,
    ...(task.feedback?.status === 'published'
      ? task.feedback.comments.map((c) => c.location?.path + ' ' + c.body)
      : []),
  ].join(' ');
  const names = new Set(
    own.match(/(?:[\w@.-]+\/)+[\w.-]+\.[a-z]{1,8}\b|\b[A-Z]\w+\.[a-z]\w+/g) ?? [],
  );
  const candidates = siblings.flatMap((other) => {
    if (
      other.id === task.id ||
      other.state === 'complete' ||
      other.ref.host !== task.ref.host ||
      other.ref.repo !== task.ref.repo ||
      other.workspaceId !== task.workspaceId
    )
      return [];
    const linked =
      task.dependsOn?.includes(other.id) ||
      other.dependsOn?.includes(task.id) ||
      task.parentTaskId === other.id ||
      other.parentTaskId === task.id;
    const plan = other.reviewRecovery?.plan ?? other.planning?.result?.text ?? other.requirements;
    const hits = [...names].filter((n) => plan.includes(n));
    if (!linked && !hits.length) return [];
    const lines = plan.split('\n').filter((l) => hits.some((n) => l.includes(n)));
    return [
      {
        id: other.id,
        title: other.title,
        shared: hits.slice(0, 5),
        excerpt: (lines.length ? lines.join('\n') : plan).slice(0, 640),
        score: (linked ? 100 : 0) + hits.length,
      },
    ];
  });
  return candidates
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, 3)
    .map(({ score, ...plan }) => plan);
}
