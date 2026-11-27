import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { daddyFixture } from './daddy-fixture.js';
import { DemoProvider } from '../src/providers/demo.js';
import { prRef, type Job, type Task } from '../src/core/types.js';
import {
  matchingReviewLessons,
  savePublishedLesson,
  appendReviewLessons,
} from '../src/core/review-lessons.js';
import { buildContext } from '../src/runtime/context.js';
import { Store } from '../src/core/store.js';
import { git } from '../src/runtime/git.js';

const note =
  'A delayed acknowledgement must retain the original payload across restart. The regression test checks both consumers.';
const meta = { key: 'retry-payload', component: 'src/queue.ts', test: 'tests/queue.test.ts' };
const annotated = (text = note, m = meta) =>
  'Reviewed the delivery behavior.\n\n' +
  text +
  '\n<!-- daddyloop:lesson ' +
  JSON.stringify(m) +
  ' -->';

async function lessonFixture() {
  const f = daddyFixture(true),
    group = f.daddy.create({ workspaceId: f.workspace.id });
  const root = mkdtempSync(join(tmpdir(), 'daddy-lesson-git-'));
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, 'tests'));
  writeFileSync(join(root, meta.component), 'export const queue=1;\n');
  writeFileSync(join(root, meta.test), '// regression case for both consumers\n');
  await git(['init', '-q'], root);
  await git(['add', '.'], root);
  await git(
    [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.test',
      'commit',
      '-qm',
      'Verified checkout',
    ],
    root,
  );
  const head = await git(['rev-parse', 'HEAD'], root);
  const ref = {
    provider: 'fixture',
    host: 'fixture.local',
    repo: 'acme/code',
    number: 169,
    url: 'https://fixture.local/acme/code/pull/169',
  };
  const provider = new DemoProvider(f.store);
  const remote = await provider.getPR(ref);
  remote.head = head;
  f.store.setSetting('demo-pr:' + ref.number, remote);
  const source = await f.engine.create({
    ref,
    repoPath: root,
    groupId: group.id,
    workspaceId: f.workspace.id,
    requirements: 'Correct the queue',
  });
  source.reviewerWorktree = root;
  f.store.saveTask(source);
  const target: Task = {
    ...source,
    id: 'next-task',
    title: 'Resume src/queue.ts after a network retry',
    requirements: 'Inspect src/queue.ts and the payload.',
  };
  f.store.saveTask(target);
  const job: Job = {
    id: 'planning',
    kind: 'plan',
    role: 'author',
    status: 'running',
    generation: target.generation,
    taskId: target.id,
    createdAt: target.createdAt,
    input: 'Plan the correction',
  };
  const lookup = (q = target, s = f.store) => matchingReviewLessons(s, q, job) ?? [];
  const stage = async (body: string) => {
    await f.engine.review(source.id);
    const review = f.store.claim((j) => j.taskId === source.id)!;
    await f.engine.broker.call(review, 'set_summary', { body });
    await f.engine.completeJob(review, {
      status: 'completed',
      checkedHead: head,
      summary: 'Verified the committed tests independently.',
    });
    f.store.saveJob({ ...review, status: 'completed' });
    return f.store.getTask(source.id);
  };
  const close = async () => {
    await f.close();
    rmSync(root, { recursive: true, force: true });
  };
  return { f, source, target, job, root, head, provider, lookup, stage, close };
}

it('reuses only independently reviewed, published lessons on completed revisions, including after restart', async () => {
  const { f, source, target, job, head, provider, lookup, stage, close } = await lessonFixture();
  try {
    const pending = await stage(annotated());
    expect(pending.reviewLessonProof?.revision.head).toBe(head);
    expect(lookup()).toEqual([]);
    const pr = await provider.getPR(prRef(source));
    pr.checks = 'pending';
    f.store.setSetting('demo-pr:' + prRef(source).number, pr);
    await f.engine.publish(source.id);
    expect(f.store.getTask(source.id).state).toBe('awaiting_checks');
    expect(lookup()).toEqual([]);
    pr.checks = 'passing';
    f.store.setSetting('demo-pr:' + prRef(source).number, pr);
    await f.engine.reconcile(source.id);
    const checked = f.store.getTask(source.id);
    expect(checked.state).toBe('complete');
    expect(lookup()).toMatchObject([
      { text: note, component: meta.component, test: meta.test, head, review: source.ref.url },
    ]);
    savePublishedLesson(f.store, checked);
    expect(f.store.events(source.id).filter((e) => e.type === 'review.lesson_saved')).toHaveLength(
      1,
    );
    expect(lookup(source)).toEqual([]);
    expect(lookup({ ...target, workspaceId: 'other-workspace' })).toEqual([]);
    expect(lookup({ ...target, ref: { ...target.ref, repo: 'other/repo' } })).toEqual([]);
    expect(lookup({ ...target, scope: 'another/scope' })).toEqual([]);
    expect(
      lookup({ ...target, title: 'Billing receipts', requirements: 'Calculate sales tax' }),
    ).toEqual([]);
    const previous = f.store.jobs().length;
    const ticket = { ...target, ref: { ...prRef(target), kind: 'ticket' as const, key: 'T-1' } };
    for (const [task, kind, role] of [
      [ticket, 'plan', 'author'],
      [ticket, 'implement', 'author'],
      [target, 'fix', 'author'],
      [target, 'review', 'reviewer'],
    ] as const) {
      expect(buildContext(f.store, task, { ...job, kind, role })).toContain(note);
    }
    expect(buildContext(f.store, { ...ticket, reportOnly: true }, job)).not.toContain(note);
    expect(buildContext(f.store, target, { ...job, kind: 'chat' })).not.toContain(note);
    expect(f.store.jobs()).toHaveLength(previous);
    const reopened = new Store(join(f.dir, 'state.sqlite'));
    try {
      expect(lookup(target, reopened)).toHaveLength(1);
    } finally {
      reopened.close();
    }
    f.store.saveTask({ ...checked, revision: { ...checked.revision!, head: 'b'.repeat(40) } });
    expect(lookup()).toEqual([]);
  } finally {
    await close();
  }
});

it.each([
  'edited after review',
  'unconfirmed external summary',
  'untracked test',
  'escaped test',
  'marker in a code block',
  'credential in text',
  'ordinary summary',
] as const)('skips unsafe or unconfirmed retention without blocking the task: %s', async (mode) => {
  const { f, source, root, lookup, stage, provider, head, close } = await lessonFixture();
  try {
    let body = annotated();
    if (mode === 'untracked test') {
      writeFileSync(join(root, 'extra.test.ts'), 'unused');
      body = annotated(note, { ...meta, test: 'extra.test.ts' });
    }
    if (mode === 'escaped test') {
      symlinkSync('/etc/passwd', join(root, 'outside'));
      body = annotated(note, { ...meta, test: 'outside' });
    }
    if (mode === 'marker in a code block') body = '```md\n\n' + body + '\n```';
    if (mode === 'credential in text')
      body = annotated(
        'The operation used access_token=fixture_sensitive. Never retain this marker.',
      );
    if (mode === 'ordinary summary') body = 'The behavior and tests have been verified.';
    if (mode === 'unconfirmed external summary') {
      await f.engine.review(source.id);
      const job = f.store.claim((j) => j.taskId === source.id)!;
      const t = f.store.getTask(source.id);
      await provider.updateSummary(prRef(t), t.review!, body);
      await f.engine.completeJob(job, {
        status: 'completed',
        checkedHead: head,
        summary: 'Checked',
      });
      f.store.saveJob({ ...job, status: 'completed' });
    } else await stage(body);
    if (mode === 'edited after review') {
      const t = f.store.getTask(source.id);
      await provider.updateSummary(
        prRef(t),
        t.review!,
        annotated('Another paragraph which was added later.'),
      );
    }
    await f.engine.publish(source.id);
    expect(f.store.getTask(source.id).state).toBe('complete');
    expect(lookup()).toEqual([]);
  } finally {
    await close();
  }
});

it('ranks exact paths, limits the shared excerpt and gives near-limit task evidence priority', async () => {
  const { f, source, target, job, lookup, stage, close } = await lessonFixture();
  try {
    await stage(annotated());
    await f.engine.publish(source.id);
    const saved = f.store.db.prepare('SELECT * FROM review_lessons').get()!;
    const sourceData = f.store.getTask(source.id);
    for (let i = 0; i < 5; i++) {
      const next = { ...sourceData, id: 'completed-' + i };
      f.store.saveTask(next);
      const data = {
        ...JSON.parse(String(saved.data)),
        key: 'other-' + i,
        component: 'other/file' + i + '.ts',
        text: 'Long but relevant receipt observation. '.repeat(8),
      };
      f.store.db
        .prepare('INSERT INTO review_lessons VALUES(?,?,?,?,?,?,?,?)')
        .run(
          saved.repository,
          'other-' + i,
          next.id,
          saved.review_id,
          saved.head,
          saved.confirmed_at,
          JSON.stringify(data),
          JSON.stringify({ queue: 4, payload: 4 }),
        );
    }
    const matches = lookup();
    expect(matches).toHaveLength(3);
    expect(matches[0].component).toBe(meta.component);
    expect(Buffer.byteLength(JSON.stringify(matches))).toBeLessThanOrEqual(2400);
    const text = 'The user’s complete acceptance criteria.';
    expect(appendReviewLessons(f.store, target, job, text, text.length + 3)).toBe(text);
    expect(appendReviewLessons(f.store, target, job, text, 5000)).toContain(note);
    f.store.db.prepare('DELETE FROM tasks WHERE id=?').run(source.id);
    expect(lookup().some((l) => l.key === meta.key)).toBe(false);
  } finally {
    await close();
  }
});
