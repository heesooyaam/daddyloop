import { buildContext } from '../src/runtime/context.js';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git } from '../src/runtime/git.js';
import { describe, expect, it, vi } from 'vitest';
import { reconcileWorkerPools, workerSlots, saveWorkerSlots } from '../src/core/worker-pool.js';
import { autoMergeSettings, githubActivityStatus, pollAutoMerge } from '../src/core/auto-merge.js';
import { taskActivity } from '../src/core/task-activity.js';
import { AppError, prRef, type PullRequest } from '../src/core/types.js';
import { queueCard, taskCard } from '../src/integrations/telegram-tasks.js';
import { TelegramProgress } from '../src/integrations/telegram-progress.js';
import { TelegramApi } from '../src/integrations/telegram.js';
import { translate } from '../src/i18n/index.js';
import { githubBackoff } from '../src/providers/github-quota.js';
import { DemoProvider } from '../src/providers/demo.js';
import { daddyFixture } from './daddy-fixture.js';

async function setup(f = daddyFixture(), initial: Partial<PullRequest> = {}, repoPath = f.dir) {
  const group = f.daddy.create({ workspaceId: f.workspace.id });
  const ref = {
    provider: 'github',
    host: 'github.com',
    repo: 'test/repo',
    number: 12,
    url: 'https://github.com/test/repo/pull/12',
  };
  const provider = new DemoProvider(f.store);
  let remote: PullRequest = {
    ...(await provider.getPR(ref)),
    draft: false,
    mergeable: true,
    ...initial,
  };
  function setRemote(patch: Partial<PullRequest>) {
    remote = { ...remote, ...patch };
    f.store.setSetting('demo-pr:' + ref.number, remote);
  }
  setRemote(remote);
  const send = vi.fn(async (_head: string) => {
    setRemote({ state: 'merged', mergeCommit: 'integration-commit' });
    return remote.mergeCommit!;
  });
  const prepareMerge = vi.fn(async () => send);
  const getPR = vi.spyOn(provider, 'getPR').mockImplementation(async () => ({ ...remote }));
  vi.spyOn(f.engine, 'provider').mockReturnValue(Object.assign(provider, { prepareMerge }));
  const task = await f.engine.create({
    ref,
    requirements: 'Implement the feature',
    repoPath,
    groupId: group.id,
  });
  // Complete a genuine published-review cycle before attempting to merge.
  await f.engine.review(task.id);
  const job = f.store.claim()!;
  await f.engine.completeJob(job, {
    status: 'completed',
    summary: 'Verified',
    checkedHead: remote.head,
  });
  f.store.saveJob({ ...job, status: 'completed' });
  await f.engine.publish(task.id);
  expect(f.store.getTask(task.id).state).toBe('complete');
  const poll = () => pollAutoMerge(f.engine, () => false);
  return {
    ...f,
    group,
    task,
    provider,
    send,
    prepareMerge,
    getPR,
    poll,
    setRemote,
  };
}

describe('opt-in GitHub merging', () => {
  function expectStatus(
    f: Awaited<ReturnType<typeof setup>>,
    label: string,
    publishedReason?: string,
    russian?: string,
  ) {
    const task = f.store.getTask(f.task.id);
    const group = f.store.getGroup(f.group.id);
    const [item] = taskActivity(
      [task],
      f.store.activeJobs(task.id),
      (task, job) =>
        githubActivityStatus(
          task,
          autoMergeSettings(f.store, group, task),
          githubBackoff(f.store, task.ref),
          job,
        ),
      workerSlots(f.store, group),
    );
    const boardTask = f.daddy.board(group.id).tasks.find((row) => row.id === task.id)!;
    expect(boardTask.statusLabel).toBe(label);
    if (publishedReason) expect(boardTask.reason).toBe(publishedReason);
    for (const locale of ['en', 'ru'] as const) {
      const expected = locale === 'ru' && russian ? russian : translate(locale, label);
      expect(translate(locale, boardTask.statusLabel)).toBe(expected);
      expect(queueCard(locale, group.id, [item!]).text).toContain(expected);
      const details = taskCard(locale, item!).text;
      expect(details).toContain(expected);
      if (publishedReason) {
        expect(details).toContain(translate(locale, publishedReason));
        expect(details).not.toContain(translate(locale, task.reason));
        const progress = new TelegramProgress(
          f.store,
          new TelegramApi('123456:abcdefghijklmnopqrstuvwxyz123456', async () => {
            throw new Error('Rendering the status card must stay offline');
          }),
          'fixture:',
          () => locale,
          () => undefined,
        ).card(group).text;
        expect(progress.split('\n')[1]).toBe(expected);
        expect(progress).toContain(`${task.title} · ${expected}`);
      }
    }
  }

  it.each([
    ['completed', false],
    ['completed', true],
    ['incomplete', true],
    ['needs_input', true],
  ] as const)(
    'shows GitHub mergeability after publishing a %s review (findings: %s)',
    async (status, findings) => {
      const f = await setup();
      try {
        await f.daddy.settings(f.group.id, { autoMerge: true });
        await f.engine.review(f.task.id, true);
        const task = f.store.getTask(f.task.id);
        const handle = { ...task.review!, authorId: 'owner' };
        f.store.saveTask({ ...task, review: handle });
        f.store.setSetting('demo-review:' + handle.id, {
          ...(await f.provider.getReview(prRef(task), handle)),
          authorId: 'owner',
        });
        const job = f.store.claim()!;
        if (findings)
          await f.engine.broker.call(job, 'add_comment', { key: 'R1', body: 'Published finding' });
        await f.engine.broker.call(job, 'set_summary', { body: 'Checked the change' });
        await f.engine.completeJob(job, {
          status,
          summary: 'Report',
          question: status === 'needs_input' ? 'Which behavior is intended?' : undefined,
          checkedHead: task.revision!.head,
        });
        f.store.saveJob({ ...job, status: 'completed' });
        expectStatus(f, 'Publishing review');

        f.setRemote({ mergeable: null });
        await f.engine.publish(task.id);
        const waiting = f.store.getTask(task.id);
        expect(waiting).toMatchObject({
          state: 'awaiting_publication',
          snapshot: { status: 'published' },
        });
        expect(f.store.activeJobs(task.id)).toHaveLength(0);
        const reason = 'The review is published. Waiting for GitHub to determine mergeability.';
        let mergeability = 'GitHub is calculating mergeability';
        if (waiting.partialReview) {
          const until = waiting.partialReview.retryAt!;
          const time = new Date(Math.ceil(until / 1000) * 1000).toISOString().slice(11, 19);
          mergeability = `GitHub mergeability check · retry at ${time} UTC · PR #12`;
        }
        expectStatus(f, mergeability, reason);
        const key = `github.read-backoff:${task.ref.host}`;
        const until = Math.ceil(Date.now() / 1000) * 1000 + 60_000;
        const time = new Date(until).toISOString().slice(11, 19);
        for (const http of [undefined, 408, 500, 502, 503, 504]) {
          f.store.setSetting(key, { status: http, until, delay: 60_000 });
          const failure = http ? `HTTP ${http}` : 'offline';
          expectStatus(
            f,
            `GitHub is calculating mergeability · PR #12 · GitHub ${failure} · retry at ${time} UTC`,
            reason,
            `GitHub проверяет возможность слияния · PR #12 · GitHub ${failure} · повтор в ${time} UTC`,
          );
        }
        f.store.setSetting(key, null);
        expectStatus(f, mergeability, reason);

        f.setRemote({ mergeable: true });
        await f.engine.publish(task.id);
        expect(f.store.getTask(task.id).state).toBe(findings ? 'fixing' : 'awaiting_merge');
        expectStatus(f, findings ? 'Waiting for a worker' : 'Checking GitHub auto-merge');
      } finally {
        await f.close();
      }
    },
  );

  it.each([false, true])(
    'shows deferred author discussion after clean publication (auto-merge: %s)',
    async (autoMerge) => {
      const f = await setup();
      try {
        await f.daddy.settings(f.group.id, { autoMerge });
        await f.engine.review(f.task.id, true);
        const review = f.store.claim()!;
        await f.engine.chat(f.task.id, 'author', 'Explain the decision', 'deferred-chat', true);
        await f.engine.completeJob(review, {
          status: 'completed',
          summary: 'Verified',
          checkedHead: f.task.revision!.head,
        });
        f.store.saveJob({ ...review, status: 'completed' });
        await f.engine.publish(f.task.id);
        expect(f.store.getTask(f.task.id).state).toBe(autoMerge ? 'awaiting_merge' : 'complete');
        await f.engine.deliverWorkerInstruction(f.task.id);
        expect(f.daddy.board(f.group.id).taskQueue).toEqual([f.task.id]);
        expectStatus(f, 'Waiting for task discussion');

        saveWorkerSlots(f.store, f.store.getGroup(f.group.id), [{ number: 1, taskId: f.task.id }]);
        const chat = f.store.claim()!;
        expect(chat.kind).toBe('chat');
        expectStatus(f, 'Task discussion in progress');
        const task = f.store.getTask(f.task.id);
        expect(
          queueCard('en', f.group.id, [{ task, job: chat, assignedWorker: 1 }]).text,
        ).toContain('Worker 1 · <1 min elapsed');
        await f.engine.completeJob(chat, {
          status: 'completed',
          summary: 'Explained',
          checkedHead: f.task.revision!.head,
        });
        f.store.saveJob({ ...chat, status: 'completed' });
        expect(f.daddy.board(f.group.id).taskQueue).toEqual([]);
        if (autoMerge) expectStatus(f, 'Checking GitHub auto-merge');
        else
          expect(
            queueCard('en', f.group.id, [{ task: f.store.getTask(f.task.id) }]).text,
          ).toContain('No unfinished tasks.');
      } finally {
        await f.close();
      }
    },
  );

  it('restores a legacy timed-out conflict once, only with the original task generation and an active merge policy', async () => {
    const f = await setup();
    try {
      await f.daddy.settings(f.group.id, { autoMerge: true });
      f.setRemote({ mergeConflict: true, mergeable: false });
      await f.poll();
      const job = f.store.claim()!;
      const task = f.store.getTask(job.taskId);
      const failure = 'AppError: Agent exceeded the configured run time limit';
      Object.assign(task, {
        state: 'needs_input',
        resumeState: 'fixing',
        reason: failure,
        authorWorktree: f.dir,
      });
      f.store.saveTask(task);
      f.store.saveJob({
        ...job,
        status: 'failed',
        errorCode: 'run_timeout',
        error: failure,
        generation: task.generation - 1,
      });
      f.engine.recoverInterruptedJobs();
      expect(f.store.activeJobs(task.id)).toHaveLength(0);
      f.store.saveJob({ ...job, status: 'failed', errorCode: 'run_timeout', error: failure });
      f.daddy.taskAutoMerge(f.group.id, task.id, 'off');
      f.engine.recoverInterruptedJobs();
      expect(f.store.activeJobs(task.id)).toHaveLength(0);
      f.daddy.taskAutoMerge(f.group.id, task.id, 'on');
      f.engine.recoverInterruptedJobs();
      f.engine.recoverInterruptedJobs();
      expect(f.store.activeJobs(task.id)).toMatchObject([{ kind: 'fix', timeoutRetry: true }]);
    } finally {
      await f.close();
    }
  });

  it('recovers the recorded in-progress merge when an earlier service repinned a timed-out repair', async () => {
    const f = await setup();
    try {
      await f.daddy.settings(f.group.id, { autoMerge: true });
      f.setRemote({ mergeConflict: true, mergeable: false });
      await f.poll();
      const job = f.store.claim()!;
      const task = f.store.getTask(job.taskId);
      const original = task.revision!;
      f.store.saveJob({ ...job, status: 'failed', errorCode: 'run_timeout', error: 'timeout' });
      Object.assign(task, {
        state: 'needs_input',
        resumeState: 'fixing',
        reason: 'timeout',
        authorWorktree: f.dir,
      });
      f.store.saveTask(task);
      const base = '9'.repeat(40);
      f.setRemote({ base, start: base });
      await f.engine.review(task.id, true);
      expect(f.store.getTask(task.id).revision).toEqual(original);
      task.generation++;
      task.revision = { ...original, base, start: base };
      task.reason = 'different merge';
      f.store.saveTask(task);
      const failure = f.store.enqueue(task, 'author', 'fix', 'Resolve the conflict');
      f.store.saveJob({
        ...failure,
        status: 'failed',
        errorCode: 'workspace_diverged',
        error: task.reason,
      });
      const compare = vi.fn().mockResolvedValue(false);
      Object.assign(f.provider, { targetAdvanced: compare });
      await f.engine.restorePendingConflict(task.id, async () => original.base);
      expect(f.store.activeJobs(task.id)).toHaveLength(0);
      compare.mockResolvedValue(true);
      await f.engine.restorePendingConflict(task.id, async () => '8'.repeat(40));
      expect(f.store.activeJobs(task.id)).toHaveLength(0);
      await f.engine.restorePendingConflict(task.id, async () => original.base);
      expect(f.store.getTask(task.id)).toMatchObject({ state: 'fixing', revision: original });
      expect(f.store.activeJobs(task.id)).toMatchObject([{ kind: 'fix', timeoutRetry: true }]);
    } finally {
      await f.close();
    }
  });

  it('honors session inheritance, both overrides, and a disabled default', async () => {
    const f = await setup();
    try {
      await f.poll();
      await f.daddy.settings(f.group.id, { autoMerge: true });
      f.daddy.taskAutoMerge(f.group.id, f.task.id, 'off');
      await f.poll();
      expect(f.send).not.toHaveBeenCalled();
      f.daddy.taskAutoMerge(f.group.id, f.task.id, 'inherit');
      await f.poll();
      await f.poll();
      expect(f.send).toHaveBeenCalledExactlyOnceWith(f.task.revision!.head);
      expect(f.store.getTask(f.task.id).pr?.mergeCommit).toBe('integration-commit');
    } finally {
      await f.close();
    }
  });

  it.each([
    'draft',
    'conflict',
    'ci',
    'unpublished',
    'findings',
    'changed head',
    'changed base',
    'revoked',
    'late check failure',
    'late native findings',
  ] as const)('holds the merge for %s', async (why) => {
    const f = await setup();
    try {
      f.daddy.taskAutoMerge(f.group.id, f.task.id, 'on');
      if (why === 'draft') f.setRemote({ draft: true });
      if (why === 'conflict') f.setRemote({ mergeable: false });
      if (why === 'ci') f.setRemote({ checks: 'pending' });
      if (why === 'unpublished' || why === 'findings') {
        const task = f.store.getTask(f.task.id);
        const snapshot = await f.provider.getReview(prRef(task), task.review!);
        f.store.setSetting('demo-review:' + task.review!.id, {
          ...snapshot,
          status: why === 'unpublished' ? 'draft' : 'published',
          comments: why === 'findings' ? [{ id: 'finding' }] : [],
        });
      }
      if (why === 'changed head') f.setRemote({ head: 'c'.repeat(40) });
      if (why === 'changed base') f.setRemote({ base: 'd'.repeat(40) });
      if (why === 'late check failure')
        f.prepareMerge.mockImplementationOnce(async () => {
          f.setRemote({ checks: 'failing' });
          return f.send;
        });
      if (why === 'late native findings')
        f.prepareMerge.mockImplementationOnce(async () => {
          const t = f.store.getTask(f.task.id),
            review = t.review!;
          const native = await f.provider.getReview(prRef(t), review);
          f.store.setSetting('demo-review:' + review.id, {
            ...native,
            comments: [{ id: 'new-finding' }],
          });
          return f.send;
        });
      if (why === 'revoked')
        f.prepareMerge.mockImplementationOnce(async () => {
          f.daddy.taskAutoMerge(f.group.id, f.task.id, 'off');
          return f.send;
        });
      await f.poll();
      expect(f.send).not.toHaveBeenCalled();
      if (why.startsWith('changed')) expect(f.store.getTask(f.task.id).state).toBe('queued');
    } finally {
      await f.close();
    }
  });

  it.each(['review', 'reconcile', 'merge poll', 'last merge check'] as const)(
    'assigns the same pinned repair once when the conflict is first seen by %s',
    async (source) => {
      const f = await setup();
      try {
        await f.daddy.settings(f.group.id, { autoMerge: true });
        const group = f.store.getGroup(f.group.id);
        saveWorkerSlots(f.store, group, [{ number: 1, taskId: f.task.id }]);
        const base = 'd'.repeat(40);
        const conflict = () =>
          f.setRemote({ base, start: base, mergeable: false, mergeConflict: true });
        if (source === 'last merge check')
          f.prepareMerge.mockImplementationOnce(async () => {
            conflict();
            return f.send;
          });
        else conflict();
        if (source === 'review') await f.engine.review(f.task.id, true);
        else if (source === 'reconcile') await f.engine.reconcile(f.task.id);
        else await f.poll();
        await Promise.all([f.engine.reconcile(f.task.id), f.poll()]);
        expect(f.store.getTask(f.task.id)).toMatchObject({
          state: 'fixing',
          fixingMergeConflict: true,
          reviewFinished: false,
          revision: { head: f.task.revision!.head, base },
        });
        expect(f.store.activeJobs(f.task.id)).toMatchObject([{ role: 'author', kind: 'fix' }]);
        expect(workerSlots(f.store, f.store.getGroup(group.id))[0].taskId).toBe(f.task.id);
        expect(f.send).not.toHaveBeenCalled();
      } finally {
        await f.close();
      }
    },
  );

  it.each(['completed', 'incomplete'] as const)(
    'waits for GitHub before dispatching fixes from a %s review',
    async (status) => {
      const f = await setup();
      try {
        await f.daddy.settings(f.group.id, { autoMerge: true });
        await f.engine.review(f.task.id, true);
        const t = f.store.getTask(f.task.id),
          h = { ...t.review!, authorId: 'owner' };
        f.store.saveTask({ ...t, review: h });
        f.store.setSetting('demo-review:' + h.id, {
          ...(await f.provider.getReview(prRef(t), h)),
          authorId: 'owner',
        });
        const job = f.store.claim()!;
        await f.engine.broker.call(job, 'add_comment', { key: 'R1', body: 'Published finding' });
        await f.engine.broker.call(job, 'set_summary', { body: 'Checked the change' });
        await f.engine.completeJob(job, {
          status,
          summary: 'Report',
          checkedHead: t.revision!.head,
        });
        f.store.saveJob({ ...job, status: 'completed' });
        f.setRemote({ mergeable: null });
        await f.engine.publish(t.id);
        expect(f.store.getTask(t.id).state).toBe('awaiting_publication');
        expect(f.store.activeJobs(t.id)).toHaveLength(0);
        f.setRemote({ mergeable: false, mergeConflict: true });
        await f.engine.publish(t.id);
        expect(f.store.getTask(t.id)).toMatchObject({
          state: 'fixing',
          fixingMergeConflict: true,
          feedback: { comments: [{ body: expect.stringContaining('Published finding') }] },
        });
        expect(f.store.activeJobs(t.id)).toHaveLength(1);
        expect(f.send).not.toHaveBeenCalled();
      } finally {
        await f.close();
      }
    },
  );
  it.each(['review', 'reconcile', 'publish'] as const)(
    'preserves a just-published review when the base moves before %s',
    async (entry) => {
      const f = await setup();
      try {
        await f.daddy.settings(f.group.id, { autoMerge: true });
        await f.engine.review(f.task.id, true);
        const job = f.store.claim()!;
        await f.engine.broker.call(job, 'add_comment', { key: 'R1', body: 'A confirmed finding' });
        await f.engine.completeJob(job, {
          status: 'completed',
          summary: 'Checked',
          checkedHead: f.task.revision!.head,
        });
        f.store.saveJob({ ...job, status: 'completed' });
        const advance = () =>
          f.setRemote({
            base: 'f'.repeat(40),
            start: 'f'.repeat(40),
            mergeable: false,
            mergeConflict: true,
          });
        const task = f.store.getTask(f.task.id);
        if (entry === 'publish') {
          const send = f.engine.broker.publish.bind(f.engine.broker);
          vi.spyOn(f.engine.broker, 'publish').mockImplementationOnce(async (t) => {
            const published = await send(t);
            advance();
            return published;
          });
          await f.engine.publish(task.id);
        } else {
          await f.provider.publish(prRef(task), task.review!);
          advance();
          if (entry === 'review') await f.engine.review(task.id, true);
          else await f.engine.reconcile(task.id);
        }
        expect(f.store.getTask(task.id)).toMatchObject({
          state: 'fixing',
          fixingMergeConflict: true,
          reviewFinished: false,
          revision: { base: 'f'.repeat(40) },
          feedback: {
            status: 'published',
            comments: [{ body: expect.stringContaining('A confirmed finding') }],
          },
        });
        expect(f.store.activeJobs(task.id)).toMatchObject([{ role: 'author', kind: 'fix' }]);
        expect(f.send).not.toHaveBeenCalled();
      } finally {
        await f.close();
      }
    },
  );
  it('resumes an author fix with the answer and keeps the decision for the next independent review', async () => {
    const f = await setup();
    try {
      await f.engine.review(f.task.id, true);
      const review = f.store.claim()!;
      const head = f.store.getTask(f.task.id).revision!.head;
      await f.engine.broker.call(review, 'add_comment', { key: 'F', body: 'Fix the queue' });
      await f.engine.completeJob(review, {
        status: 'completed',
        checkedHead: head,
        summary: 'Found a defect',
      });
      f.store.saveJob({ ...review, status: 'completed' });
      await f.engine.publish(f.task.id);
      const author = f.store.claim()!;
      await f.engine.completeJob(author, {
        status: 'needs_input',
        summary: 'A decision is missing',
        question: 'Keep the manual step?',
        checkedHead: head,
      });
      f.store.saveJob({ ...author, status: 'completed' });
      const answer = 'Use automatic publication per the approved issue.';
      await f.engine.chat(f.task.id, 'author', answer, 'daddy:turn:answer');
      const t = f.store.getTask(f.task.id);
      expect(t).toMatchObject({
        state: 'fixing',
        latestClarification: { text: answer, question: 'Keep the manual step?' },
      });
      expect(t.inputRequest).toBeUndefined();
      expect(f.store.activeJobs(t.id)).toMatchObject([
        { kind: 'fix', role: 'author', input: answer },
      ]);
      const prompt = buildContext(f.store, t, { ...review, generation: t.generation });
      expect(prompt).toContain(answer);
    } finally {
      await f.close();
    }
  });
  it('reserves the original worker from clean review through a late conflict', async () => {
    const f = await setup();
    try {
      await f.engine.review(f.task.id, true);
      const group = f.store.getGroup(f.group.id);
      saveWorkerSlots(f.store, group, [{ number: 1, taskId: f.task.id }]);
      await f.daddy.settings(group.id, { autoMerge: true });
      const job = f.store.claim()!;
      await f.engine.completeJob(job, {
        status: 'completed',
        summary: 'Verified',
        checkedHead: f.task.revision!.head,
      });
      f.store.saveJob({ ...job, status: 'completed' });
      await f.engine.publish(f.task.id);
      const slots = () => workerSlots(f.store, f.store.getGroup(group.id));
      reconcileWorkerPools(f.store);
      expect(f.store.getTask(f.task.id).state).toBe('awaiting_merge');
      expect(slots()[0].taskId).toBe(f.task.id);
      await f.engine.action(f.task.id, 'pause');
      await f.engine.action(f.task.id, 'resume');
      expect(f.store.getTask(f.task.id).state).toBe('awaiting_merge');
      f.setRemote({ mergeConflict: true, mergeable: false });
      await f.poll();
      expect(f.daddy.board(group.id).tasks[0].statusLabel).toBe(
        'Conflict repair queued for worker 1',
      );
      expect(slots()[0].taskId).toBe(f.task.id);
    } finally {
      await f.close();
    }
  });
  it('retains legacy assignments until merge confirmation or opt-out', async () => {
    const f = await setup();
    try {
      const group = f.store.getGroup(f.group.id);
      saveWorkerSlots(f.store, group, [{ number: 1, taskId: f.task.id }]);
      await f.daddy.settings(group.id, { autoMerge: true });
      f.engine.restoreMergeWaits();
      reconcileWorkerPools(f.store);
      expect(f.daddy.board(group.id).workers.occupied).toBe(1);
      f.daddy.taskAutoMerge(group.id, f.task.id, 'off');
      await f.poll();
      expect(f.store.getTask(f.task.id).state).toBe('complete');
      expect(f.send).not.toHaveBeenCalled();
      f.daddy.taskAutoMerge(group.id, f.task.id, 'on');
      await f.poll();
      expect(f.store.getTask(f.task.id)).toMatchObject({
        state: 'complete',
        pr: { state: 'merged' },
      });
      reconcileWorkerPools(f.store);
      expect(f.daddy.board(group.id).workers.occupied).toBe(0);
    } finally {
      await f.close();
    }
  });
  it.each(['poll', 'completion', 'admission'] as const)(
    'restarts a review on target advance during %s without requiring auto-merge or human input',
    async (path) => {
      const f = await setup();
      try {
        await f.engine.review(f.task.id, true);
        const old = f.store.getTask(f.task.id);
        const job = path === 'admission' ? undefined : f.store.claim()!;
        const handle = old.review!,
          key = 'demo-review:' + handle.id;
        f.store.setSetting(key, {
          ...(await f.provider.getReview(prRef(old), handle)),
          body: `Review in progress.\n\n<!-- ${handle.marker} -->`,
        });
        f.setRemote({ base: 'd'.repeat(40), start: 'd'.repeat(40) });
        const lastEvent = f.store.events(old.id).at(-1)?.id ?? 0;
        if (path === 'completion') {
          await f.engine.completeJob(job!, {
            status: 'completed',
            summary: 'Old assessment',
            checkedHead: old.revision!.head,
          });
        } else if (path === 'admission') {
          await f.worker.tick();
          await vi.waitFor(() =>
            expect(f.store.getTask(old.id).revision?.base).toBe('d'.repeat(40)),
          );
        } else {
          await f.engine.reconcile(old.id);
        }
        expect(
          f.store
            .events(old.id)
            .filter((e) => e.id > lastEvent && e.type === 'task.state')
            .map((e) => e.data),
        ).not.toContainEqual(expect.objectContaining({ state: 'needs_input' }));
        expect(f.store.activeJobs(old.id)).toHaveLength(1);
        expect(f.store.getTask(old.id)).toMatchObject({
          state: 'reviewing',
          review: { id: handle.id, revision: { base: 'd'.repeat(40) } },
        });
      } finally {
        await f.close();
      }
    },
  );

  it.each([
    { conflict: false, legacy: false },
    { conflict: true, legacy: false },
    { conflict: true, legacy: true },
  ])(
    'publishes incomplete findings and dispatches the assigned author: %j',
    async ({ conflict, legacy }) => {
      const f = await setup();
      try {
        await f.daddy.settings(f.group.id, { autoMerge: true });
        await f.engine.review(f.task.id, true);
        const task = f.store.getTask(f.task.id);
        const handle = { ...task.review!, authorId: 'owner' };
        f.store.saveTask({ ...task, review: handle });
        saveWorkerSlots(f.store, f.store.getGroup(f.group.id), [{ number: 1, taskId: task.id }]);
        f.store.setSetting('demo-review:' + handle.id, {
          ...(await f.provider.getReview(prRef(task), handle)),
          authorId: 'owner',
        });
        const job = f.store.claim()!;
        await f.engine.broker.call(job, 'add_comment', {
          key: 'R1',
          body: 'Fix the visible defect',
        });
        await f.engine.broker.call(job, 'set_summary', {
          body: 'Verified one defect. Full validation remains open.',
        });
        const result = {
          status: 'incomplete' as const,
          summary: 'A required check is blocked.',
          checkedHead: task.revision!.head,
          question: conflict ? '' : 'Which API decision was approved?',
        };
        if (conflict) {
          f.setRemote({
            mergeable: false,
            mergeConflict: true,
            base: 'd'.repeat(40),
            start: 'd'.repeat(40),
          });
          Object.assign(f.provider, { targetAdvanced: async () => true });
        }
        if (legacy) {
          f.store.event(
            task.id,
            'runtime.item',
            { type: 'agentMessage', phase: 'final_answer', text: JSON.stringify(result) },
            job.id,
          );
          f.store.saveTask({
            ...f.store.getTask(task.id),
            state: 'needs_input',
            resumeState: 'reviewing',
            reason: result.summary,
          });
        } else await f.engine.completeJob(job, result);
        f.store.saveJob({ ...job, status: 'completed' });
        if (legacy) {
          await f.engine.retryInterruptedStep(task.id);
          await f.engine.retryInterruptedStep(task.id);
        }
        expect(f.store.getTask(task.id)).toMatchObject({
          state: 'awaiting_publication',
          reviewFinished: false,
        });

        // A restart after the native write must adopt the same published review.
        if (legacy) await f.provider.publish(prRef(task), handle);
        await f.engine.publish(task.id);
        expect((await f.provider.getReview(prRef(task), handle)).status).toBe('published');
        expect(
          f.store
            .events(task.id)
            .filter(
              (e) =>
                e.type === 'operation.completed' &&
                (e.data as { operationId?: string }).operationId === handle.marker + ':publish',
            ),
        ).toHaveLength(legacy ? 0 : 1);
        const next = f.store.getTask(task.id);
        expect(next).toMatchObject({
          state: 'fixing',
          reviewFinished: false,
          feedback: {
            status: 'published',
            comments: [{ body: expect.stringContaining('Fix the visible defect') }],
          },
        });
        expect(!!next.fixingMergeConflict).toBe(conflict);
        if (!conflict) expect(f.engine.coordinationBlocker(next)?.question).toBe(result.question);
        expect(f.store.activeJobs(task.id)).toMatchObject([{ role: 'author', kind: 'fix' }]);
        expect(workerSlots(f.store, f.store.getGroup(f.group.id))[0].taskId).toBe(task.id);
        await f.poll();
        expect(f.send).not.toHaveBeenCalled();
      } finally {
        await f.close();
      }
    },
  );

  it('keeps external edits private when the partial findings change before publication', async () => {
    const f = await setup();
    try {
      await f.engine.review(f.task.id, true);
      const t = f.store.getTask(f.task.id),
        handle = { ...t.review!, authorId: 'owner' };
      f.store.saveTask({ ...t, review: handle });
      f.store.setSetting('demo-review:' + handle.id, {
        ...(await f.provider.getReview(prRef(t), handle)),
        authorId: 'owner',
      });
      const job = f.store.claim()!;
      await f.engine.broker.call(job, 'add_comment', { key: 'R1', body: 'Service finding' });
      await f.engine.broker.call(job, 'set_summary', { body: 'Service summary' });
      await f.engine.completeJob(job, {
        status: 'incomplete',
        checkedHead: t.revision!.head,
        summary: 'Blocked',
      });
      f.store.saveJob({ ...job, status: 'completed' });
      await f.provider.updateSummary(prRef(t), handle, 'Private human note');
      await expect(f.engine.publish(t.id)).rejects.toMatchObject({ code: 'draft_changed' });
      expect((await f.provider.getReview(prRef(t), handle)).status).toBe('draft');
      expect(f.store.activeJobs(t.id)).toHaveLength(0);
    } finally {
      await f.close();
    }
  });

  it.each([
    {
      scenario: 'empty draft, reconcile before resource resume',
      legacy: false,
      ownerPaused: false,
    },
    { scenario: 'findings after multiple legacy base changes', legacy: true },
    { scenario: 'empty draft persisted with a stale resource marker', legacyPause: true },
    {
      scenario: 'findings persisted with a stale resource marker',
      legacy: true,
      legacyPause: true,
    },
    { scenario: 'owner pause with a stale resource marker', legacyPause: true, ownerPaused: true },
  ])(
    'handles a target-branch advance with a resource-paused GitHub review ($scenario)',
    async ({ legacy, legacyPause, ownerPaused }) => {
      const previousBase = 'b9fd4147112ca77d3d76a9cf5924ae2bce5a0590';
      const f = await setup(daddyFixture(), {
        head: legacy
          ? 'f9b309ee72b7d5d1490c2d21c5653ea942c2747f'
          : '743ed0b7404411a04341e85a4cd7291e523c1c4b',
        base: previousBase,
        start: previousBase,
      });
      try {
        const generation = legacy ? 69 : 29;
        f.store.saveTask({ ...f.store.getTask(f.task.id), generation: generation - 1 });
        await f.engine.review(f.task.id, true);
        const old = f.store.getTask(f.task.id);
        const handle = { ...old.review!, authorId: 'reviewer' };
        const key = 'demo-review:' + handle.id;
        f.store.saveTask({ ...old, review: handle });
        f.store.setSetting(key, {
          ...(await f.provider.getReview(prRef(old), handle)),
          authorId: handle.authorId,
          body: `Review in progress.

<!-- ${handle.marker} -->`,
        });
        const job = f.store.claim()!;
        const finding = legacy
          ? ((await f.engine.broker.call(job, 'add_comment', {
              key: 'finding',
              body: 'Check layout',
            })) as { id: string })
          : undefined;
        const earlier = await f.provider.getReview(prRef(old), handle);
        let restoredDeletion = earlier.comments;
        if (finding) {
          await f.engine.broker.call(job, 'set_summary', { body: 'Earlier summary' });
          earlier.body = (await f.provider.getReview(prRef(old), handle)).body;
          await f.engine.broker.call(job, 'edit_comment', {
            id: finding.id,
            body: 'Check spacing',
          });
          if (legacyPause) {
            for (let version = 0; version < 98; version++)
              await f.engine.broker.call(job, 'set_summary', { body: `Intermediate ${version}` });
            f.store.db
              .prepare(
                `WITH RECURSIVE history(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM history WHERE n<50000)
                 INSERT INTO events(task_id,type,data,at)
                 SELECT ?, 'runtime.item', '{}', ? FROM history`,
              )
              .run(old.id, new Date().toISOString());
          }
          await f.engine.broker.call(job, 'set_summary', { body: 'Current summary' });
          const removed = (await f.engine.broker.call(job, 'add_comment', {
            key: 'removed',
            body: 'Resolved finding',
          })) as { id: string };
          restoredDeletion = (await f.provider.getReview(prRef(old), handle)).comments;
          await f.engine.broker.call(job, 'remove_comment', {
            id: removed.id,
            reason: 'Already resolved',
            outcome: 'withdrawn',
          });
        }
        const draft = await f.provider.getReview(prRef(old), handle);
        await f.engine.chat(old.id, legacy ? 'reviewer' : 'author', 'Queued during review');
        await f.engine.interruptTask(old.id, 'Disk threshold', 'resource.pause');
        expect(f.store.jobs(old.id).at(-1)).toMatchObject({ kind: 'chat', status: 'cancelled' });
        expect(f.store.jobs(old.id).find(({ id }) => id === job.id)?.status).toBe('cancelled');
        const base = '9bf00a4f8ca1bb3ae882ed58da1a0186aaac73e7';
        const targetAdvanced = vi.fn(async () => false);
        Object.assign(f.provider, { targetAdvanced });
        if (!legacy || legacyPause) {
          f.setRemote({ base, start: base });
          if (legacyPause) {
            // Older reconciliation had no resource-pause guard and saved the new pin first.
            const waiting = vi
              .spyOn(
                f.engine as unknown as { reviewWaitingForResources(): boolean },
                'reviewWaitingForResources',
              )
              .mockReturnValue(false);
            try {
              await f.engine.reconcile(old.id);
            } finally {
              waiting.mockRestore();
            }
            expect(f.store.getTask(old.id)).toMatchObject({
              generation: generation + 2,
              revision: { base },
              review: { revision: old.revision },
              resourcePause: { generation: generation + 1 },
            });
          }
          await f.engine.reconcile(old.id);
          await f.engine.retryInterruptedStep(old.id);
          await f.engine.review(old.id, true);
          expect(f.store.activeJobs(old.id)).toHaveLength(0);
          expect(f.store.getTask(old.id)).toMatchObject({
            revision: { base: legacyPause ? base : previousBase },
            resourcePause: { generation: generation + 1 },
          });
        }
        if (ownerPaused) {
          await f.engine.action(old.id, 'pause');
          f.daddy.tick();
          await f.engine.reconcile(old.id);
          await f.engine.retryInterruptedStep(old.id);
          await expect(f.engine.review(old.id, true)).rejects.toMatchObject({
            code: 'task_paused',
          });
          expect(f.store.getTask(old.id).state).toBe('paused');
          expect(f.store.activeJobs(old.id)).toHaveLength(0);
          return;
        }
        f.daddy.tick();
        await vi.waitFor(() => expect(f.store.getTask(old.id).resourcePause).toBeUndefined());
        expect(f.store.getTask(old.id)).toMatchObject({
          state: 'needs_input',
          generation: generation + (legacyPause ? 2 : 1),
        });
        f.setRemote({ base, start: base });
        const currentBase = legacy && !legacyPause ? 'd'.repeat(40) : base;
        if (legacy && !legacyPause) {
          // Reach the persisted stale-draft state while the native draft cannot be carried.
          f.store.setSetting(key, { ...draft, body: 'Unrecognized native edit' });
          await f.engine.reconcile(old.id);
          expect(f.store.getTask(old.id)).toMatchObject({
            state: 'needs_input',
            generation: generation + 2,
            revision: { base },
            review: { revision: old.revision },
          });
          await f.engine.action(old.id, 'resume');
          await f.engine.reconcile(old.id);
          expect(f.store.getTask(old.id).reason).toBe('Review points to a different revision');
          f.setRemote({ base: currentBase, start: currentBase });
          await f.engine.reconcile(old.id);
          expect(f.store.getTask(old.id)).toMatchObject({
            generation: generation + 3,
            revision: { base: currentBase },
          });
          await f.engine.action(old.id, 'resume');
          f.store.setSetting(key, draft);
          await f.engine.reconcile(old.id);
        }
        await f.engine.retryInterruptedStep(old.id);
        expect(f.store.activeJobs(old.id)).toHaveLength(0);
        targetAdvanced.mockResolvedValue(true);
        for (const patch of [
          { state: 'closed' as const },
          { draft: true },
          { branch: 'another-source' },
          { targetBranch: 'another-target' },
          { head: 'e'.repeat(40) },
        ]) {
          f.setRemote(patch);
          await f.engine.retryInterruptedStep(old.id);
          expect(f.store.activeJobs(old.id)).toHaveLength(0);
          f.setRemote({ ...old.pr!, base: currentBase, start: currentBase });
        }
        for (const patch of [
          { authorId: 'another-reviewer' },
          { body: 'Unrecognized native edit' },
          ...(finding
            ? [
                { comments: [] },
                { comments: earlier.comments },
                { comments: restoredDeletion },
                { body: earlier.body },
                {
                  body: `Review in progress.

<!-- ${handle.marker} -->`,
                },
              ]
            : []),
        ]) {
          f.store.setSetting(key, { ...draft, ...patch });
          await f.engine.retryInterruptedStep(old.id);
          expect(f.store.activeJobs(old.id)).toHaveLength(0);
        }
        f.store.setSetting(key, draft);
        const pending = handle.marker + ':' + job.id + ':set_summary:lost-response';
        f.store.db
          .prepare('INSERT INTO operations VALUES(?,?,?,?,NULL)')
          .run(pending, old.id, 'pending', 'unconfirmed-summary');
        await f.engine.retryInterruptedStep(old.id);
        expect(f.store.activeJobs(old.id)).toHaveLength(0);
        f.store.db.prepare('DELETE FROM operations WHERE id=?').run(pending);

        if (legacy) {
          // Confirm that older removal receipts are still useful when their decision was saved.
          f.store.db
            .prepare("UPDATE operations SET result='null' WHERE task_id=? AND id GLOB ?")
            .run(old.id, handle.marker + ':*:remove_comment:*');
          if (legacyPause) await f.engine.retryInterruptedStep(old.id);
          else {
            await f.engine.review(old.id, true);
            expect(targetAdvanced).toHaveBeenCalledWith(prRef(old), base, currentBase);
          }
        } else await f.engine.retryInterruptedStep(old.id);
        await f.engine.retryInterruptedStep(old.id);
        expect(targetAdvanced).toHaveBeenCalledWith(prRef(old), previousBase, base);
        const recovered = f.store.getTask(old.id);
        expect(recovered).toMatchObject({
          state: 'reviewing',
          review: { id: handle.id, marker: handle.marker, revision: { base: currentBase } },
          reviewFinished: false,
        });
        expect(recovered.draftRecheck).toEqual(finding ? { commentIds: [finding.id] } : undefined);
        expect(f.store.activeJobs(old.id)).toMatchObject([
          { kind: 'review', generation: recovered.generation },
        ]);
        const result = {
          status: 'completed' as const,
          summary: 'Reviewed',
          checkedHead: old.revision!.head,
        };
        await f.engine.completeJob(job, result);
        await expect(
          f.engine.broker.call(job, 'set_summary', { body: 'Late summary' }),
        ).rejects.toMatchObject({ code: 'stale_run' });
        expect(f.store.getTask(old.id).reviewFinished).toBe(false);
        expect(await f.provider.getReview(prRef(old), handle)).toEqual(draft);
        if (finding) {
          const unchecked = f.store.claim()!;
          await f.engine.completeJob(unchecked, result);
          expect(f.store.getTask(old.id).reviewFinished).toBe(false);
          f.store.saveJob({ ...unchecked, status: 'completed' });
          const checked = f.store.claim()!;
          await f.engine.broker.call(checked, 'edit_comment', {
            id: finding.id,
            body: 'Verified against the new base',
          });
          await f.engine.broker.call(checked, 'set_summary', { body: 'Rechecked' });
          await f.engine.completeJob(checked, result);
          expect(f.store.getTask(old.id)).toMatchObject({
            state: 'awaiting_publication',
            reviewFinished: true,
          });
        }
      } finally {
        await f.close();
      }
    },
  );

  it('retains recorded draft findings across a target advance and requires a new check before publication', async () => {
    const f = await setup();
    const readReview = DemoProvider.prototype.getReview;
    const githubSnapshot = vi
      .spyOn(DemoProvider.prototype, 'getReview')
      .mockImplementation(async function (this: DemoProvider, ref, review) {
        const snapshot = await readReview.call(this, ref, review);
        // GitHub reports the commit ID. The comparison base comes from the checked handle.
        return { ...snapshot, revision: { ...review.revision, head: snapshot.revision.head } };
      });
    try {
      await f.daddy.settings(f.group.id, { autoMerge: true });
      await f.engine.review(f.task.id, true);
      const old = f.store.getTask(f.task.id);
      const handle = { ...old.review!, authorId: 'reviewer' };
      const key = 'demo-review:' + handle.id;
      f.store.saveTask({
        ...old,
        review: handle,
        ticketRepository: {
          baseHead: old.revision!.base,
          baseBranch: old.pr!.targetBranch,
          branch: old.pr!.branch,
          cloneUrl: old.pr!.cloneUrl,
        },
      });
      f.store.setSetting(key, {
        ...(await f.provider.getReview(prRef(old), handle)),
        authorId: handle.authorId,
      });
      const job = f.store.claim()!;
      const { id } = (await f.engine.broker.call(job, 'add_comment', {
        key: 'finding',
        body: 'Check layout',
      })) as { id: string };
      await f.engine.broker.call(job, 'set_summary', { body: 'Old summary' });
      const before = await f.provider.getReview(prRef(old), handle);
      const comment = before.comments[0];
      Object.assign(f.provider, { targetAdvanced: async () => true });
      f.setRemote({ base: 'd'.repeat(40), start: 'd'.repeat(40) });
      f.store.setSetting(key, {
        ...before,
        comments: [{ ...comment, body: 'Private human edit' }],
      });
      await f.engine.reconcile(old.id);
      await f.engine.retryInterruptedStep(old.id);
      expect(f.store.getTask(old.id).state).toBe('needs_input');
      f.store.setSetting(key, before);
      const observedEdit = handle.marker + ':' + job.id + ':edit_comment:lost-response';
      const digest = createHash('sha256')
        .update(JSON.stringify({ id, body: 'Check layout' }))
        .digest('hex');
      f.store.db
        .prepare('INSERT INTO operations VALUES(?,?,?,?,NULL)')
        .run(observedEdit, old.id, 'pending', digest);
      // A timeout remains uncertain. A refused legacy REST edit can be retired after a native read.
      const op = handle.marker + ':' + job.id + ':edit_comment:old:hash';
      f.store.db
        .prepare('INSERT INTO operations VALUES(?,?,?,?,NULL)')
        .run(op, old.id, 'pending', 'different-text');
      await f.engine.retryInterruptedStep(old.id);
      expect(
        f.store.db.prepare('SELECT status FROM operations WHERE id=?').get(observedEdit)?.status,
      ).toBe('done');
      expect(f.store.getTask(old.id).reason).toContain('Waiting to confirm');
      expect(f.store.activeJobs(old.id)).toHaveLength(0);
      f.store.event(old.id, 'operation.uncertain', {
        operationId: op,
        error: `AppError: PATCH /repos/${old.ref.repo}/pulls/comments/${id}: HTTP 404 Not Found`,
      });

      await f.engine.retryInterruptedStep(old.id);
      expect(f.store.getTask(old.id)).toMatchObject({
        state: 'reviewing',
        review: { id: handle.id },
        draftRecheck: { commentIds: [id] },
      });
      // Reopening the store first fences the crashed reviewer. Only its confirmed native work can be resumed.
      const interrupted = f.store.claim()!;
      f.engine.recoverInterruptedJobs();
      expect(f.store.getTask(old.id).state).toBe('needs_input');
      await f.engine.retryInterruptedStep(old.id);
      expect(f.store.getTask(old.id)).toMatchObject({
        state: 'reviewing',
        review: { id: handle.id },
        draftRecheck: { commentIds: [id] },
      });
      expect(f.store.jobs(old.id).find((j) => j.id === interrupted.id)?.status).toBe('failed');
      const first = f.store.claim()!;
      const result = {
        status: 'completed' as const,
        summary: 'Reviewed',
        checkedHead: old.revision!.head,
      };
      await f.engine.completeJob(first, result);
      f.store.saveJob({ ...first, status: 'completed' });
      expect(f.store.getTask(old.id).reviewFinished).toBe(false);
      const second = f.store.claim()!;
      await f.engine.broker.call(second, 'edit_comment', {
        id,
        body: 'Verified against the new base',
      });
      await f.engine.broker.call(second, 'set_summary', { body: 'Rechecked' });
      await f.engine.completeJob(second, result);
      expect(f.store.getTask(old.id)).toMatchObject({
        state: 'awaiting_publication',
        reviewFinished: true,
      });
    } finally {
      githubSnapshot.mockRestore();
      await f.close();
    }
  });

  it('recovers an exhausted shared reviewer once, retaining its native draft and coordinator thread', async () => {
    const f = await setup();
    try {
      await f.daddy.settings(f.group.id, { autoMerge: true });
      await f.engine.review(f.task.id, true);
      const job = f.store.claim()!;
      job.threadId = 'codex:old';
      const group = f.store.getGroup(f.group.id);
      group.reviewerThreadId = job.threadId;
      group.daddyThreadId = 'codex:coordinator';
      f.store.saveGroup(group);
      const failure = new AppError(
        'incomplete_turn',
        'Codex turn failed: {"codexErrorInfo":"contextWindowExceeded"}',
      );
      f.engine.failJob(job, failure);
      f.store.saveJob({ ...job, status: 'failed', error: String(failure) });
      const old = f.store.getTask(f.task.id);
      const key = 'demo-review:' + old.review!.id;
      const draft = await f.provider.getReview(prRef(old), old.review!);
      const tip = 'd'.repeat(40);
      f.setRemote({ base: tip, start: tip });
      f.store.setSetting(key, { ...draft, body: 'Private review notes' });
      await f.engine.retryInterruptedStep(old.id);
      expect(f.store.activeJobs(old.id)).toHaveLength(0);
      f.store.setSetting(key, {
        ...draft,
        body: `Review in progress.\n\n<!-- ${old.review!.marker} -->`,
      });
      await Promise.all([
        f.engine.retryInterruptedStep(old.id),
        f.engine.retryInterruptedStep(old.id),
      ]);
      expect(f.store.getTask(old.id)).toMatchObject({
        state: 'reviewing',
        reviewFinished: false,
        review: { id: old.review!.id, revision: { base: tip } },
      });
      expect(f.store.getGroup(group.id).daddyThreadId).toBe('codex:coordinator');
      expect(f.store.getGroup(group.id).reviewerThreadId).toBeUndefined();
      const retry = f.store.claim()!;
      expect(retry.freshContextRetry).toBe(true);
      f.engine.failJob(retry, failure);
      f.store.saveJob({ ...retry, status: 'failed', error: String(failure) });
      await f.engine.retryInterruptedStep(old.id);
      expect(f.store.activeJobs(old.id)).toHaveLength(0);
      expect(f.send).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  });

  it.each(['quota', 'timeout'] as const)(
    'rechecks the native placeholder before automatically resuming a %s review',
    async (cause) => {
      const f = await setup();
      try {
        await f.daddy.settings(f.group.id, { autoMerge: true });
        await f.engine.review(f.task.id, true);
        const job = f.store.claim()!;
        const error =
          cause === 'quota'
            ? new AppError(
                'provider_403',
                'GET /repos/test/repo/pulls/12: HTTP 403 {\n  "message":"API rate limit exceeded for user ID 7."\n}\n',
              )
            : new AppError('run_timeout', 'Agent exceeded the configured run time limit');
        f.engine.failJob(job, error);
        f.store.saveJob({ ...job, status: 'failed', error: String(error), errorCode: error.code });
        const t = f.store.getTask(f.task.id),
          key = 'demo-review:' + t.review!.id;
        const draft = await f.provider.getReview(prRef(t), t.review!);
        const group = f.store.getGroup(f.group.id);
        group.reviewerThreadId = 'codex:existing';
        f.store.saveGroup(group);
        f.store.setSetting(key, {
          ...draft,
          body: `Review in progress.\n\n<!-- ${t.review!.marker} -->`,
        });
        f.setRemote({ base: 'e'.repeat(40), start: 'e'.repeat(40) });
        await f.engine.retryInterruptedStep(t.id);
        expect(f.store.getTask(t.id)).toMatchObject({
          state: 'reviewing',
          review: { id: t.review!.id, revision: { base: 'e'.repeat(40) } },
        });
        expect(f.store.getGroup(group.id).reviewerThreadId).toBe('codex:existing');
        expect(f.store.activeJobs(t.id)).toHaveLength(1);
      } finally {
        await f.close();
      }
    },
  );

  it.each([false, true])(
    'archives a stale service draft before dispatching work on the confirmed saved head (conflict: %s)',
    async (mergeConflict) => {
      const f = await setup();
      try {
        const t = f.store.getTask(f.task.id),
          old = t.review!,
          head = 'e'.repeat(40);
        await f.daddy.settings(f.group.id, { autoMerge: true });
        old.authorId = '123';
        t.state = 'needs_input';
        t.pendingFix = { revision: t.revision! };
        t.pendingAuthorHead = head;
        t.pr = { ...t.pr!, head };
        t.revision = { ...t.revision!, head };
        t.reason = `Saved fix ${head} is on the PR. Inspect the earlier draft review ${old.id} before starting another review.`;
        f.setRemote({ head, mergeConflict, mergeable: !mergeConflict });
        const key = 'demo-review:' + old.id,
          snapshot = await f.provider.getReview(prRef(t), old);
        const draft = {
          ...snapshot,
          status: 'draft',
          body: `Review in progress.\n\n<!-- ${old.marker} -->`,
        };
        const discard = vi.fn(async () => {
          expect(f.store.setting('review.archive:' + t.id + ':' + old.id)).toEqual(draft);
          f.store.setSetting(key, { ...draft, status: 'missing' });
        });
        Object.assign(f.provider, { discardSupersededDraft: discard });
        f.store.saveTask(t);
        f.store.setSetting(key, { ...draft, body: 'Human edit' });
        await f.engine.review(t.id, true);
        expect(discard).not.toHaveBeenCalled();
        expect(f.store.activeJobs(t.id)).toHaveLength(0);
        f.store.saveTask(t);
        f.store.setSetting(key, draft);
        await f.engine.review(t.id, true);
        expect(discard).toHaveBeenCalledTimes(1);
        const current = f.store.getTask(t.id);
        if (mergeConflict) {
          expect(current).toMatchObject({
            state: 'fixing',
            fixingMergeConflict: true,
            revision: { head },
          });
          expect(current.review).toBeUndefined();
          expect(f.store.activeJobs(t.id)).toMatchObject([{ kind: 'fix', role: 'author' }]);
        } else {
          expect(current).toMatchObject({
            state: 'reviewing',
            review: { revision: { head } },
            reviewFinished: false,
          });
          expect(current.review!.id).not.toBe(old.id);
          expect(f.store.activeJobs(t.id)).toMatchObject([{ kind: 'review', role: 'reviewer' }]);
        }
      } finally {
        await f.close();
      }
    },
  );

  it.each(['stale admission', 'restart on same base', 'restart with advanced base'] as const)(
    'continues a published fix after %s while keeping its original head',
    async (cause) => {
      const f = await setup();
      try {
        await f.engine.review(f.task.id, true);
        const review = f.store.claim()!;
        const pinned = f.store.getTask(f.task.id).revision!;
        await f.engine.broker.call(review, 'add_comment', {
          key: 'action',
          body: 'Fix the layout',
        });
        await f.engine.completeJob(review, {
          status: 'completed',
          summary: 'Found an issue',
          checkedHead: pinned.head,
        });
        f.store.saveJob({ ...review, status: 'completed' });
        await f.engine.publish(f.task.id);
        const original = f.store.activeJobs(f.task.id)[0];
        const target = 'd'.repeat(40);
        const advanced = vi.fn(
          async (_ref: unknown, before: string, after: string) =>
            before === pinned.base && after === target,
        );
        Object.assign(f.provider, { targetAdvanced: advanced });
        if (cause !== 'restart on same base') f.setRemote({ base: target, start: target });
        await f.engine.reconcile(f.task.id);
        expect(f.store.activeJobs(f.task.id).map((j) => j.id)).toEqual([original.id]);
        const job = f.store.claim()!;
        const error = new AppError(
          'stale_revision',
          'The PR changed before the queued job started. Reconcile and review the new revision.',
        );
        if (cause === 'stale admission') {
          f.engine.failJob(job, error);
          f.store.saveJob({
            ...job,
            status: 'failed',
            errorCode: error.code,
            error: String(error),
          });
        } else {
          f.engine.recoverInterruptedJobs();
        }
        f.setRemote({ head: 'e'.repeat(40) });
        const checkpoint = vi.fn();
        await f.engine.recoverInterruptedFix(f.task.id, checkpoint);
        expect(f.store.getTask(f.task.id).state).toBe('needs_input');
        f.setRemote({ head: pinned.head });
        await f.engine.recoverInterruptedFix(f.task.id, checkpoint);
        expect(f.store.getTask(f.task.id)).toMatchObject({ state: 'fixing', revision: pinned });
        expect(f.store.activeJobs(f.task.id)).toHaveLength(1);
        expect(checkpoint).not.toHaveBeenCalled();
        vi.spyOn(f.checkouts, 'prepare').mockResolvedValue(f.dir);
        const saved = 'f'.repeat(40);
        vi.spyOn(f.checkouts, 'commitFix').mockResolvedValue(saved);
        f.agentRuntime.run.mockImplementationOnce(async (input) => {
          expect(input.task.feedback?.comments[0]?.body).toContain('Fix the layout');
          return { status: 'completed', summary: 'Layout fixed', checkedHead: pinned.head };
        });
        await f.worker.tick();
        await vi.waitFor(() =>
          expect(f.store.getTask(f.task.id)).toMatchObject({
            state: 'awaiting_push',
            pendingAuthorHead: saved,
          }),
        );
        expect(f.agentRuntime.run).toHaveBeenCalledOnce();
      } finally {
        await f.close();
      }
    },
  );
  it('hands an incomplete published fix to conflict repair, keeping the local checkpoint and the worker’s slot', async () => {
    const f = await setup();
    try {
      await f.daddy.settings(f.group.id, { autoMerge: true });
      const task = f.store.getTask(f.task.id);
      task.state = 'fixing';
      task.authorWorktree = f.dir;
      f.store.saveTask(task);
      saveWorkerSlots(f.store, f.store.getGroup(f.group.id), [{ number: 1, taskId: task.id }]);
      f.setRemote({ mergeable: false, mergeConflict: true });
      const job = f.store.enqueue(task, 'author', 'fix', 'Fix the published findings');
      f.store.claim();
      const save = vi.fn(async () => 'c'.repeat(40));
      await f.engine.completeJob(
        job,
        {
          status: 'incomplete',
          summary: 'Integration blocked on conflict',
          checkedHead: task.revision!.head,
        },
        undefined,
        save,
      );
      f.store.saveJob({ ...job, status: 'completed' });
      expect(save).toHaveBeenCalledOnce();
      expect(f.store.getTask(task.id)).toMatchObject({
        state: 'fixing',
        fixingMergeConflict: true,
        conflictCheckpoint: 'c'.repeat(40),
      });
      expect(f.store.activeJobs(task.id)).toHaveLength(1);
      expect(f.daddy.board(f.group.id).workers.slots[0].taskId).toBe(task.id);
    } finally {
      await f.close();
    }
  });

  it('assigns one conflict repair, pushes a two-parent commit, then requires fresh review and CI', async () => {
    const fixture = daddyFixture();
    try {
      const repo = join(fixture.dir, 'source'),
        remoteRepo = join(fixture.dir, 'remote.git');
      mkdirSync(repo);
      const command = (...args: string[]) => git(args, repo);
      await command('init', '-b', 'main');
      await command('config', 'user.name', 'Test');
      await command('config', 'user.email', 'test@localhost');
      const commit = async (value: string) => {
        writeFileSync(join(repo, 'feature'), value + '\n');
        await command('add', 'feature');
        await command('commit', '-m', value);
        return command('rev-parse', 'HEAD');
      };
      const original = await commit('original');
      await command('switch', '-c', 'feature');
      const head = await commit('worker');
      await command('switch', 'main');
      const base = await commit('upstream');
      await command('clone', '--bare', repo, remoteRepo);
      const cloneUrl = 'ssh://git@github.com/test/repo.git';
      const f = await setup(
        fixture,
        { head, base: original, start: original, branch: 'feature', cloneUrl },
        repo,
      );
      f.setRemote({ base, start: base, mergeable: false, mergeConflict: true, checks: 'missing' });
      await f.poll();
      expect(f.store.busy(f.task.id)).toBe(false);
      await f.daddy.settings(f.group.id, { autoMerge: true });
      await Promise.all([f.poll(), f.poll()]);
      const task = f.store.getTask(f.task.id);
      expect(task).toMatchObject({
        state: 'fixing',
        fixingMergeConflict: true,
        revision: { head, base },
      });
      expect(f.store.activeJobs(task.id)).toHaveLength(1);
      expect(f.send).not.toHaveBeenCalled();
      const previousCopy = await f.checkouts.prepare(task, 'author');
      writeFileSync(join(previousCopy, 'untracked-note'), 'work in progress');
      writeFileSync(join(previousCopy, 'feature'), 'previous resolution');
      f.agentRuntime.run.mockImplementationOnce(async (input) => {
        expect(input.job.role).toBe('author');
        const preserved = previousCopy + '-before-conflict-' + head;
        expect(input.readPaths).toContain(preserved);
        expect(input.prompt).toContain(preserved);
        expect(readFileSync(join(preserved, 'untracked-note'), 'utf8')).toBe('work in progress');
        expect(readFileSync(join(preserved, 'feature'), 'utf8')).toBe('previous resolution');
        expect(input.prompt).toContain('resolving a GitHub PR conflict');
        expect(readFileSync(join(input.cwd, 'feature'), 'utf8')).toContain('<<<<<<<');
        await expect(f.checkouts.commitFix(input.task, 'premature')).rejects.toMatchObject({
          code: 'unresolved_merge',
        });
        expect(await git(['rev-parse', 'HEAD'], input.cwd)).toBe(head);
        await f.checkouts.prepareConflict(input.task);

        writeFileSync(join(input.cwd, 'feature'), 'first half of the resolution');
        throw new AppError('run_timeout', 'Agent exceeded the configured run time limit');
      });
      await f.worker.tick();
      await vi.waitFor(() => expect(f.store.activeJobs(task.id)[0]?.timeoutRetry).toBe(true));
      const retry = f.store.activeJobs(task.id)[0];
      expect(Date.parse(retry.notBefore!)).toBeGreaterThan(Date.now());
      expect(f.store.getTask(task.id)).toMatchObject({
        state: 'fixing',
        revision: { head, base },
        authorWorktree: previousCopy,
      });
      f.store.saveJob({ ...retry, notBefore: undefined });
      const newerBase = await commit('later upstream');
      const targetAdvanced = vi.fn(
        async (_ref: unknown, before: string, after: string) =>
          before === base && after === newerBase,
      );
      Object.assign(f.provider, { targetAdvanced });
      f.setRemote({ base: newerBase, start: newerBase });
      f.agentRuntime.run.mockImplementationOnce(async (input) => {
        expect(input.cwd).toBe(previousCopy);
        expect(await git(['rev-parse', 'MERGE_HEAD'], input.cwd)).toBe(base);
        expect(readFileSync(join(input.cwd, 'feature'), 'utf8')).toBe(
          'first half of the resolution',
        );

        // Exercise the real push path against a local bare remote. Disallow network transports.
        await git(['config', 'protocol.allow', 'never'], input.cwd);
        await git(['config', 'protocol.file.allow', 'always'], input.cwd);
        await git(['config', 'url.' + remoteRepo + '.insteadOf', cloneUrl], input.cwd);
        writeFileSync(join(input.cwd, 'feature'), 'upstream and worker\n');
        return { status: 'completed', summary: 'Combined both changes', checkedHead: head };
      });
      await f.worker.tick();
      await vi.waitFor(() => expect(f.store.getTask(task.id).state).toBe('awaiting_push'), {
        timeout: 5000,
      });
      const saved = f.store.getTask(task.id).pendingAuthorHead!;
      await f.engine.submitSavedFix(task.id, async (current, sha) => {
        const push = await f.checkouts.prepareSavedFixPush(current, sha);
        return async () => {
          await push();
          expect(await git(['rev-parse', 'refs/heads/feature'], remoteRepo)).toBe(saved);
          expect(await git(['show', '-s', '--format=%P', saved], remoteRepo)).toBe(
            head + ' ' + base,
          );
          f.setRemote({ head: saved, mergeConflict: false, mergeable: true, checks: 'pending' });
        };
      });
      expect(f.store.getTask(task.id)).toMatchObject({
        state: 'queued',
        revision: { base: newerBase, head: saved },
      });
      expect(targetAdvanced).toHaveBeenCalled();
      await f.poll();
      expect(f.send).not.toHaveBeenCalled();
      await f.engine.review(task.id);
      const review = f.store.claim()!;
      await f.engine.completeJob(review, {
        status: 'completed',
        summary: 'Verified both branches',
        checkedHead: saved,
      });
      f.store.saveJob({ ...review, status: 'completed' });
      await f.engine.publish(task.id);
      await f.poll();
      expect(f.send).not.toHaveBeenCalled();
      f.setRemote({ checks: 'passing' });
      await f.engine.reconcile(task.id);
      await f.poll();
      expect(f.send).toHaveBeenCalledExactlyOnceWith(saved);
    } finally {
      await fixture.close();
    }
  });

  it('rechecks readiness after GitHub definitively refuses a merge', async () => {
    const f = await setup();
    try {
      f.daddy.taskAutoMerge(f.group.id, f.task.id, 'on');
      f.send.mockRejectedValueOnce(new AppError('provider_405', 'Merge blocked', 405));
      await f.poll();
      const key = 'autoMerge.result:' + f.task.id;
      const result = f.store.setting<{ state: string; checkedAt: number }>(key)!;
      expect(result.state).toBe('waiting');
      expect(f.store.getTask(f.task.id).pr?.state).toBe('open');
      f.store.setSetting(key, { ...result, checkedAt: 0 });
      await f.poll();
      expect(f.prepareMerge).toHaveBeenCalledTimes(2);
      expect(f.store.getTask(f.task.id).pr?.state).toBe('merged');
    } finally {
      await f.close();
    }
  });

  it('reconciles a lost response without a second write, even if consent was since disabled', async () => {
    const f = await setup();
    try {
      f.daddy.taskAutoMerge(f.group.id, f.task.id, 'on');
      f.send.mockImplementationOnce(async () => {
        throw new Error('response lost');
      });
      await f.poll();
      await f.engine.action(f.task.id, 'pause');
      await f.engine.action(f.task.id, 'resume');
      const resultKey = 'autoMerge.result:' + f.task.id;
      const previous = f.store.setting<{ state: string; checkedAt: number }>(resultKey)!;
      expect(previous.state).toBe('uncertain');
      f.store.setSetting(resultKey, { ...previous, checkedAt: 0 });
      await f.poll();
      expect(f.send).toHaveBeenCalledTimes(1);
      f.setRemote({ state: 'merged', mergeCommit: 'confirmed' });
      f.daddy.taskAutoMerge(f.group.id, f.task.id, 'off');
      f.store.setSetting(resultKey, { ...previous, checkedAt: 0 });
      await f.poll();
      expect(f.store.getTask(f.task.id).pr?.mergeCommit).toBe('confirmed');
      expect(
        f.store.db.prepare("SELECT status FROM operations WHERE id LIKE 'auto-merge:%'").get()
          ?.status,
      ).toBe('done');
      expect(f.send).toHaveBeenCalledTimes(1);
    } finally {
      await f.close();
    }
  });
});

const savedFixReviewCases = [
  'review',
  'reconcile then review',
  'old draft',
  'published before recovery',
  'published on old base with conflict',
  'published on old base without auto-merge',
  'published after recovery on old base',
  'published before merge verification',
  'published after recovery before merge verification',
  'published before recovery on merged original base',
  'published before recovery on merged advanced base',
  'draft before recovery on merged original base',
  'draft before recovery on merged advanced base',
  'published then deleted before review',
  'published then deleted before repair',
  'auto-merge disabled',
  'advanced with conflict',
  'advanced after resume',
  'advanced without auto-merge',
  'rewritten base',
  'retargeted',
] as const;

it.each(savedFixReviewCases)(
  'routes a confirmed saved fix on a conflicting revision (%s)',
  async (entry) => {
    const f = await setup();
    try {
      const enabled =
        entry !== 'auto-merge disabled' &&
        !entry.endsWith('without auto-merge') &&
        !entry.endsWith('before review');
      await f.daddy.settings(f.group.id, { autoMerge: enabled });
      const task = f.store.getTask(f.task.id);
      const original = task.revision!;
      task.state = 'fixing';
      f.store.saveTask(task);
      f.store.enqueue(task, 'author', 'fix', 'Fix the reported issue');
      const fix = f.store.claim()!;
      const saved = 'f'.repeat(40);
      await f.engine.completeJob(
        fix,
        {
          status: 'completed',
          summary: 'Fix saved',
          checkedHead: original.head,
        },
        { head: saved, revision: original },
      );
      f.store.saveJob({ ...fix, status: 'completed' });
      await f.engine.submitSavedFix(
        task.id,
        async () => async () => f.setRemote({ head: saved, mergeConflict: true, mergeable: false }),
      );
      if (entry === 'reconcile then review') await f.engine.reconcile(task.id);
      if (entry === 'old draft') {
        const ref = prRef(task);
        const staleDraft = await f.provider.createReview(ref, original, 'old-draft');
        const confirmed = f.store.getTask(task.id);
        confirmed.pendingAuthorFix!.staleDraft = staleDraft;
        f.store.saveTask(confirmed);
        expect(await f.engine.review(task.id)).toMatchObject({ state: 'needs_input' });
        expect(f.store.activeJobs(task.id)).toHaveLength(0);
        await f.provider.publish(ref, staleDraft);
      }
      const confirmed = f.store.getTask(task.id);
      let recoveredFinding: string | undefined;
      const mergedBeforeRecovery = entry.includes('on merged');
      const publishedAfterRecovery =
        entry.startsWith('published after recovery') || entry.startsWith('draft');
      const initialDraft = entry.startsWith('draft');
      const verifyMerge = entry.endsWith('merge verification');
      const deleted = entry.includes('then deleted');
      const earlierFinding = 'previous-finding';
      const recoveredReview =
        entry.startsWith('published') || initialDraft
          ? await f.engine.broker.ensureReview({ ...confirmed, round: confirmed.round + 1 })
          : undefined;
      if (recoveredReview) {
        if (deleted)
          f.store.saveTask({
            ...confirmed,
            feedback: {
              status: 'published',
              revision: original,
              url: task.ref.url,
              body: '',
              comments: [
                { id: earlierFinding, body: 'Check the earlier finding', url: task.ref.url },
              ],
            },
          });
        const ref = prRef(task);
        const finding = await f.provider.createComment(
          ref,
          recoveredReview,
          'Check the changed code',
          recoveredReview.marker + ':comment:R1',
        );
        if (!publishedAfterRecovery) await f.provider.publish(ref, recoveredReview);
        recoveredFinding = finding.id;
      }
      const recoveredOnNewBase = !!recoveredReview && entry !== 'published before recovery';
      const moved =
        (recoveredOnNewBase && !entry.endsWith('merged original base')) ||
        entry.startsWith('advanced') ||
        entry === 'rewritten base' ||
        entry === 'retargeted';
      const base = moved ? 'c'.repeat(40) : original.base;
      const targetAdvanced = vi.fn(async () => recoveredOnNewBase || entry.startsWith('advanced'));
      Object.assign(f.provider, { targetAdvanced });
      if (moved)
        f.setRemote({
          base,
          start: base,
          ...(entry === 'retargeted' ? { targetBranch: 'release' } : {}),
        });
      if (entry === 'advanced after resume') {
        targetAdvanced.mockResolvedValueOnce(false);
        expect(await f.engine.review(task.id)).toMatchObject({ state: 'needs_input' });
        expect(await f.engine.action(task.id, 'resume')).toMatchObject({ state: 'queued' });
        targetAdvanced.mockClear();
      }
      if (mergedBeforeRecovery) {
        if (!recoveredReview) throw new Error('Expected the native review creation');
        f.setRemote({ state: 'merged', mergeCommit: 'merge' });
        expect(await f.engine.review(task.id)).toMatchObject({ state: 'needs_input' });
        expect(f.store.getTask(task.id).review).toBeUndefined();
        if (initialDraft) {
          const held = await f.engine.action(task.id, 'verify-merge');
          expect(held).toMatchObject({
            state: 'needs_input',
            review: { id: recoveredReview.id },
          });
          expect(f.store.activeJobs(task.id)).toHaveLength(0);
          await f.provider.publish(prRef(task), recoveredReview);
        }
        const merged = await f.engine.action(task.id, 'verify-merge');
        expect(merged).toMatchObject({ state: 'reviewing', round: confirmed.round + 1 });
        expect(merged.feedback?.comments.map(({ id }) => id)).toContain(recoveredFinding);
        const verification = f.store.claim()!;
        expect(verification.kind).toBe('verify_merge');
        await f.engine.completeJob(verification, {
          status: 'completed',
          summary: 'Checked without the restored finding',
          checkedHead: saved,
        });
        expect(f.store.getTask(task.id)).toMatchObject({
          state: 'needs_input',
          reason: 'Reviewer has not verified all previously published findings',
        });
        return;
      }
      if (recoveredOnNewBase) {
        expect(await f.engine.review(task.id)).toMatchObject({
          state: 'needs_input',
          round: confirmed.round + 1,
          review: { id: recoveredReview.id },
        });
        expect(f.store.activeJobs(task.id)).toHaveLength(0);
        if (publishedAfterRecovery) await f.provider.publish(prRef(task), recoveredReview);
        if (deleted)
          await f.provider.deleteComment(prRef(task), recoveredReview, recoveredFinding!);
        if (verifyMerge) {
          f.setRemote({ state: 'merged', mergeCommit: 'merge' });
          const merged = await f.engine.action(task.id, 'verify-merge');
          expect(merged.state).toBe('reviewing');
          expect(merged.feedback?.comments.map(({ id }) => id)).toContain(recoveredFinding);
          const verification = f.store.claim()!;
          expect(verification.kind).toBe('verify_merge');
          await f.engine.completeJob(verification, {
            status: 'completed',
            summary: 'Checked without the restored finding',
            checkedHead: saved,
          });
          expect(f.store.getTask(task.id).state).toBe('needs_input');
          return;
        }
        expect(await f.engine.action(task.id, 'resume')).toMatchObject({ state: 'queued' });
      }
      const routed = await f.engine.review(task.id, entry === 'old draft');
      if (entry === 'rewritten base' || entry === 'retargeted') {
        expect(routed.state).toBe('needs_input');
        expect(routed.reason).toContain(saved);
        expect(f.store.activeJobs(task.id)).toHaveLength(0);
        expect(targetAdvanced).toHaveBeenCalledTimes(entry === 'rewritten base' ? 1 : 0);
        return;
      }
      expect(routed.revision).toMatchObject({
        head: saved,
        base,
        start: moved ? base : original.start,
      });
      expect(targetAdvanced).toHaveBeenCalledTimes(moved ? 1 : 0);
      expect(
        f.store.events(task.id).filter(({ type }) => type === 'author.submitted'),
      ).toHaveLength(1);
      if (recoveredFinding && enabled) expect(routed.round).toBe(confirmed.round + 1);
      if (!enabled) {
        expect(f.store.activeJobs(task.id)).toMatchObject([{ kind: 'review', role: 'reviewer' }]);
        if (deleted) {
          expect(routed.feedback?.comments.map(({ id }) => id)).toEqual([earlierFinding]);
        } else if (recoveredFinding) {
          expect(routed.round).toBe(confirmed.round + 2);
          expect(routed.feedback?.comments.map(({ id }) => id)).toContain(recoveredFinding);
          await f.engine.completeJob(f.store.claim()!, {
            status: 'completed',
            summary: 'Checked without the recovered finding',
            checkedHead: saved,
          });
          expect(f.store.getTask(task.id).state).toBe('needs_input');
        }
        return;
      }
      expect(routed).toMatchObject({ state: 'fixing', fixingMergeConflict: true });
      expect(routed.review).toBeUndefined();
      expect(f.store.activeJobs(task.id)).toMatchObject([{ kind: 'fix', role: 'author' }]);

      const repair = f.store.claim()!;
      const resolved = 'e'.repeat(40);
      await f.engine.completeJob(
        repair,
        {
          status: 'completed',
          summary: 'Conflict resolved',
          checkedHead: saved,
        },
        { head: resolved, revision: routed.revision! },
      );
      f.store.saveJob({ ...repair, status: 'completed' });
      await f.engine.submitSavedFix(
        task.id,
        async () => async () =>
          f.setRemote({ head: resolved, mergeConflict: false, mergeable: true }),
      );
      const next = await f.engine.review(task.id);
      expect(next).toMatchObject({
        state: 'reviewing',
        review: { revision: { head: resolved, base } },
      });
      if (deleted) {
        expect(next.feedback?.comments.map(({ id }) => id)).toEqual([earlierFinding]);
      } else if (recoveredFinding) {
        expect(next.round).toBe(confirmed.round + 2);
        expect(next.feedback?.comments.map(({ id }) => id)).toContain(recoveredFinding);
      }
      expect(f.store.activeJobs(task.id)).toMatchObject([{ kind: 'review', role: 'reviewer' }]);
      if (recoveredFinding && !deleted) {
        await f.engine.completeJob(f.store.claim()!, {
          status: 'completed',
          summary: 'Checked without the recovered finding',
          checkedHead: resolved,
        });
        expect(f.store.getTask(task.id).state).toBe('needs_input');
      }
    } finally {
      await f.close();
    }
  },
);

it.each(['before reading', 'first read', 'preparing', 'last read', 'enabled'] as const)(
  'honors the auto-merge setting before pushing a saved conflict repair (%s)',
  async (when) => {
    const f = await setup();
    try {
      await f.daddy.settings(f.group.id, { autoMerge: true });
      const task = f.store.getTask(f.task.id);
      const saved = 'f'.repeat(40);
      const disable = () => f.daddy.taskAutoMerge(f.group.id, task.id, 'off');
      const remote = f.getPR.getMockImplementation()!;
      let reads = 0;
      f.getPR.mockImplementation(async (ref) => {
        reads++;
        if ((when === 'first read' && reads === 1) || (when === 'last read' && reads === 2))
          disable();
        return remote(ref);
      });
      f.store.saveTask({
        ...task,
        state: 'awaiting_push',
        fixingMergeConflict: true,
        pendingAuthorHead: saved,
        pendingAuthorFix: { revision: task.revision!, generation: task.generation },
      });
      if (when === 'before reading') disable();
      const push = vi.fn(async () => f.setRemote({ head: saved }));
      await f.engine.submitSavedFix(task.id, async () => {
        if (when === 'preparing') disable();
        return push;
      });
      const current = f.store.getTask(task.id);
      if (when === 'enabled') {
        expect(push).toHaveBeenCalledOnce();
        expect(current).toMatchObject({ state: 'queued', revision: { head: saved } });
      } else {
        expect(push).not.toHaveBeenCalled();
        expect(current).toMatchObject({ state: 'needs_input', pendingAuthorHead: saved });
        expect(current.pendingAuthorFix?.pushStarted).toBeUndefined();
        expect(current.pendingAuthorFix?.confirmUntil).toBeUndefined();
      }
    } finally {
      await f.close();
    }
  },
);
