import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git } from '../src/runtime/git.js';
import { describe, expect, it, vi } from 'vitest';
import { pollAutoMerge } from '../src/core/auto-merge.js';
import { AppError, prRef, type PullRequest } from '../src/core/types.js';
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
      await f.engine.retryExhaustedReview(old.id);
      expect(f.store.activeJobs(old.id)).toHaveLength(0);
      f.store.setSetting(key, {
        ...draft,
        body: `Review in progress.\n\n<!-- ${old.review!.marker} -->`,
      });
      await Promise.all([
        f.engine.retryExhaustedReview(old.id),
        f.engine.retryExhaustedReview(old.id),
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
      await f.engine.retryExhaustedReview(old.id);
      expect(f.store.activeJobs(old.id)).toHaveLength(0);
      expect(f.send).not.toHaveBeenCalled();
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
      f.agentRuntime.run.mockImplementationOnce(async (input) => {
        expect(input.job.role).toBe('author');
        expect(input.prompt).toContain('resolving a GitHub PR conflict');
        expect(readFileSync(join(input.cwd, 'feature'), 'utf8')).toContain('<<<<<<<');
        await expect(f.checkouts.commitFix(input.task, 'premature')).rejects.toMatchObject({
          code: 'unresolved_merge',
        });
        expect(await git(['rev-parse', 'HEAD'], input.cwd)).toBe(head);
        await f.checkouts.prepareConflict(input.task);

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
      // Another PR landed while the worker was resolving the pinned conflict.
      const newerBase = await commit('later upstream');
      const targetAdvanced = vi.fn(
        async (_ref: unknown, before: string, after: string) =>
          before === base && after === newerBase,
      );
      Object.assign(f.provider, { targetAdvanced });
      f.setRemote({ base: newerBase, start: newerBase });
      await f.engine.submitSavedFix(task.id, async (current, sha) => {
        await f.checkouts.pushSavedFix(current, sha);
        expect(await git(['rev-parse', 'refs/heads/feature'], remoteRepo)).toBe(saved);
        expect(await git(['show', '-s', '--format=%P', saved], remoteRepo)).toBe(head + ' ' + base);
        f.setRemote({ head: saved, mergeConflict: false, mergeable: true, checks: 'pending' });
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
