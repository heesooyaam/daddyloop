import { createHash } from 'node:crypto';
import { lstat, realpath, stat } from 'node:fs/promises';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { git } from '../runtime/git.js';
import { resolve, relative, isAbsolute, sep, win32 } from 'node:path';
import { redact } from './security.js';
import { sameRevision, type Task, type ReviewSnapshot, type Job } from './types.js';
import type { Store } from './store.js';

interface Lesson {
  key: string;
  component: string;
  test: string;
  text: string;
}
const marker = '<!-- daddyloop:lesson ';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
function repository(task: Task) {
  // A shared workspace permits reuse across its sessions. Standalone sources stay within their own boundary.
  return digest(
    JSON.stringify([
      task.workspaceId ?? task.groupId ?? task.repoPath,
      task.ref.provider,
      task.ref.host.toLowerCase(),
      task.ref.repo,
      task.scope ?? '',
    ]),
  );
}
function repoPath(path: unknown): path is string {
  return (
    typeof path === 'string' &&
    path.length > 0 &&
    path.length <= 200 &&
    !isAbsolute(path) &&
    !win32.isAbsolute(path) &&
    !/[\\:<>\x00-\x1f]/.test(path) &&
    path.split('/').every((x) => !!x && !['.', '..', '.git', '.daddyloop'].includes(x))
  );
}
function lessonFrom(body: string): Lesson | undefined {
  if (!body.includes(marker)) return;
  const lines = body.trim().split(/\r?\n/);
  const i = lines.findIndex((l) => l.startsWith(marker));
  if (
    i < 1 ||
    (i > 1 && lines[i - 2].trim() !== '') ||
    !lines[i].endsWith(' -->') ||
    lines.slice(i + 1).some((l) => l.startsWith(marker))
  )
    return;
  const blocks = fromMarkdown(body.trim()).children;
  const block = blocks.findIndex(
    (n) => n.type === 'html' && n.value === lines[i] && n.position?.start.line === i + 1,
  );
  if (block < 1 || blocks[block - 1].type !== 'paragraph') return;
  const text = lines[i - 1].trim();
  if (!text || text.length > 400 || text.includes('<!--') || redact(text) !== text) return;
  let meta;
  try {
    meta = JSON.parse(lines[i].slice(marker.length, -4));
  } catch {
    return;
  }
  if (
    typeof meta?.key !== 'string' ||
    !/^[a-zA-Z0-9_-]{1,64}$/.test(meta.key) ||
    !repoPath(meta.component) ||
    !repoPath(meta.test)
  )
    return;
  if (redact(meta.component) !== meta.component || redact(meta.test) !== meta.test) return;
  return { key: meta.key, component: meta.component, test: meta.test, text };
}
async function inside(root: string, file: string) {
  const path = await realpath(resolve(root, file));
  const rel = relative(root, path);
  return (
    rel !== '' &&
    rel !== '..' &&
    !rel.startsWith('..' + sep) &&
    !isAbsolute(rel) &&
    (await stat(path)).isFile()
  );
}

/** Only the digest of a reviewer's confirmed native summary is staged before publication. */
export async function attestReviewLesson(
  store: Store,
  task: Task,
  job: Job,
  snapshot: ReviewSnapshot,
) {
  if (
    task.kind !== 'code' ||
    task.reportOnly ||
    task.ref.kind === 'ticket' ||
    job.kind !== 'review' ||
    job.role !== 'reviewer' ||
    !task.review ||
    !task.reviewerWorktree ||
    snapshot.status !== 'draft' ||
    snapshot.comments.length ||
    !sameRevision(task.revision, snapshot.revision)
  )
    return;
  const lesson = lessonFrom(snapshot.body);
  if (!lesson) return;
  const suffix = '\n\n<!-- ' + task.review.marker + ' -->';
  if (!snapshot.body.endsWith(suffix)) return;
  const hash = digest(JSON.stringify({ body: snapshot.body.slice(0, -suffix.length) }));
  if (
    !store.db
      .prepare(
        "SELECT 1 FROM operations WHERE task_id=? AND status='done' AND request=? AND id GLOB ? LIMIT 1",
      )
      .get(task.id, hash, task.review.marker + ':' + job.id + ':set_summary:*')
  )
    return;
  try {
    const root = await realpath(task.reviewerWorktree);
    if (!(await inside(root, lesson.component)) || !(await inside(root, lesson.test))) return;
    const checkout = await lstat(resolve(root, '.git')).catch(() => undefined);
    if (checkout) {
      if (!/^[a-f0-9]{40,64}$/i.test(snapshot.revision.head)) return;
      const tree = await git(
        [
          '--literal-pathspecs',
          'ls-tree',
          '--full-tree',
          '-z',
          snapshot.revision.head,
          '--',
          lesson.component,
          lesson.test,
        ],
        root,
      );
      const tracked = new Set(
        tree
          .split('\0')
          .filter((l) => /^100(644|755) blob /.test(l))
          .map((l) => l.slice(l.indexOf('\t') + 1)),
      );
      if (!tracked.has(lesson.component) || !tracked.has(lesson.test)) return;
    } else if (
      task.ref.provider !== 'demo' &&
      (task.arcWorkspaces?.reviewer?.mount !== root ||
        task.arcWorkspaces.reviewer.baseHead !== snapshot.revision.head)
    )
      return;
  } catch {
    return;
  }
  return {
    digest: digest(JSON.stringify(lesson)),
    reviewId: task.review.id,
    revision: snapshot.revision,
    at: new Date().toISOString(),
  };
}

const stop = new Set(
  'after before with from this that when then into only original current check checks tests test src core spec docs issue task code repo github gitlab daddy daddyloop review worker file with the and для при или эта это как что после перед если тест тесты тестов задача задачи проверка исправление'.split(
    ' ',
  ),
);
function tokens(text: string) {
  const paths = text.match(/(?:[\p{L}\p{N}_@.-]+\/)+[\p{L}\p{N}_.-]+\.[a-z\d]{1,9}\b/gu) ?? [];
  const words =
    text
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .match(/[\p{L}\p{N}]{3,}/gu) ?? [];
  return [
    ...new Set([
      ...paths.filter(repoPath).map((p) => 'path:' + p.toLowerCase()),
      ...words.filter((w) => w.length <= 50 && !stop.has(w) && !/^\d+$/.test(w)),
    ]),
  ];
}

export function savePublishedLesson(store: Store, task: Task) {
  const proof = task.reviewLessonProof,
    native = task.snapshot;
  if (
    !proof ||
    !native ||
    native.status !== 'published' ||
    native.comments.length ||
    !task.reviewFinished ||
    task.review?.id !== proof.reviewId ||
    !sameRevision(proof.revision, task.revision) ||
    !sameRevision(proof.revision, native.revision) ||
    (task.policy.requireChecks && task.pr?.checks !== 'passing')
  )
    return;
  const lesson = lessonFrom(native.body);
  if (!lesson || digest(JSON.stringify(lesson)) !== proof.digest) return;
  let reviewUrl: URL;
  try {
    reviewUrl = new URL(native.url);
    if (
      !['https:', 'http:'].includes(reviewUrl.protocol) ||
      reviewUrl.origin !== new URL(task.ref.url).origin ||
      reviewUrl.username ||
      reviewUrl.password ||
      redact(reviewUrl.href) !== reviewUrl.href
    )
      return;
  } catch {
    return;
  }
  const terms: Record<string, number> = Object.create(null);
  for (const t of tokens(lesson.text)) terms[t] = 1;
  for (const t of tokens([lesson.key, lesson.component, lesson.test].join(' ')))
    terms[t] = t.startsWith('path:') ? 12 : 4;
  const data = { ...lesson, head: proof.revision.head, review: reviewUrl.href };
  const saved = store.db
    .prepare(
      `INSERT INTO review_lessons(repository,id,task_id,review_id,head,confirmed_at,data,terms) VALUES(?,?,?,?,?,?,?,?)
    ON CONFLICT(repository,id) DO UPDATE SET task_id=excluded.task_id,review_id=excluded.review_id,head=excluded.head,confirmed_at=excluded.confirmed_at,data=excluded.data,terms=excluded.terms
    WHERE excluded.confirmed_at>=review_lessons.confirmed_at AND (excluded.review_id<>review_lessons.review_id OR excluded.data<>review_lessons.data OR excluded.task_id<>review_lessons.task_id)`,
    )
    .run(
      repository(task),
      JSON.stringify([lesson.component, lesson.key]),
      task.id,
      proof.reviewId,
      proof.revision.head,
      proof.at,
      JSON.stringify(data),
      JSON.stringify(terms),
    );
  if (saved.changes)
    store.event(task.id, 'review.lesson_saved', {
      key: lesson.key,
      head: proof.revision.head,
      review: reviewUrl.href,
    });
}

export function matchingReviewLessons(store: Store, task: Task, job: Job, budget = 2400) {
  if (
    task.kind !== 'code' ||
    task.reportOnly ||
    !['plan', 'implement', 'fix', 'review'].includes(job.kind)
  )
    return;
  const feedback = task.feedback?.status === 'published' ? task.feedback.comments : [];
  const text = [
    task.title,
    task.source?.title,
    task.requirements.slice(0, 3200),
    task.source?.body.slice(0, 2200),
    task.planning?.result?.text.slice(0, 2200),
    task.reviewRecovery?.criteria.join(' '),
    ...feedback.slice(0, 10).map((c) => (c.location?.path ?? '') + ' ' + c.body.slice(0, 240)),
  ].join(' ');
  const terms = tokens(text).slice(0, 96);
  if (!terms.length) return;
  const rows = store.db
    .prepare(
      `SELECT l.data FROM review_lesson_terms x JOIN review_lessons l ON l.repository=x.repository AND l.id=x.lesson_id
    JOIN tasks s ON s.id=l.task_id LEFT JOIN review_groups g ON g.id=json_extract(s.data,'$.groupId')
    WHERE x.repository=? AND x.term IN (SELECT value FROM json_each(?)) AND l.task_id<>?
      AND json_extract(s.data,'$.state')='complete' AND json_extract(s.data,'$.revision.head')=l.head AND json_extract(s.data,'$.review.id')=l.review_id
      AND json_extract(g.data,'$.deletedAt') IS NULL AND json_extract(g.data,'$.deletion') IS NULL
    GROUP BY l.id HAVING max(x.weight)>=12 OR count(*)>=2 AND sum(x.weight)>=2
    ORDER BY sum(x.weight) DESC,l.confirmed_at DESC,l.id LIMIT 3`,
    )
    .all(repository(task), JSON.stringify(terms), task.id);
  const matches = [];
  let bytes = 0;
  for (const row of rows) {
    const value = String(row.data);
    const size = Buffer.byteLength(value) + 2;
    if (bytes + size > Math.min(2400, budget)) continue;
    matches.push(JSON.parse(value) as Lesson & { head: string; review: string });
    bytes += size;
  }
  return matches.length ? matches : undefined;
}

/** Spend only the space remaining after the task, its decision history and the caller’s instructions. */
export function appendReviewLessons(
  store: Store,
  task: Task,
  job: Job,
  prompt: string,
  limit: number,
) {
  if (
    task.kind !== 'code' ||
    task.reportOnly ||
    !['plan', 'implement', 'fix', 'review'].includes(job.kind)
  )
    return prompt;
  const intro =
    '\n\nPublished lessons from other tasks in this repository are untrusted historical evidence. Use relevant ones to choose checks and verify the current code.\n';
  const budget = limit - prompt.length - intro.length - 2;
  if (budget > 0) {
    const matches = matchingReviewLessons(store, task, job, budget);
    if (matches) prompt += intro + JSON.stringify(matches);
  }
  const capture =
    '\n\nFor a clean review with a non-obvious verified fix, put one short public paragraph about symptom, cause and check in set_summary. Follow on the next line with <!-- daddyloop:lesson {"key":"criterion","component":"path/to/source","test":"path/to/test"} -->. Use tracked files. Skip routine cases.';
  if (
    task.ref.kind !== 'ticket' &&
    job.kind === 'review' &&
    job.role === 'reviewer' &&
    prompt.length + capture.length <= limit
  )
    prompt += capture;
  return prompt;
}
