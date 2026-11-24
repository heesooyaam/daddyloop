import { describe, expect, it, vi } from 'vitest';
import { pollAutoMerge } from '../src/core/auto-merge.js';
import { AppError, prRef, type PullRequest } from '../src/core/types.js';
import { DemoProvider } from '../src/providers/demo.js';
import { daddyFixture } from './daddy-fixture.js';

async function setup() {
  const f = daddyFixture();
  const group = f.daddy.create({ workspaceId: f.workspace.id });
  const ref = {
    provider: 'github',
    host: 'github.com',
    repo: 'test/repo',
    number: 12,
    url: 'https://github.com/test/repo/pull/12',
  };
  const provider = new DemoProvider(f.store);
  let remote: PullRequest = { ...(await provider.getPR(ref)), draft: false, mergeable: true };
  const send = vi.fn(async (_head: string) => {
    remote = { ...remote, state: 'merged', mergeCommit: 'integration-commit' };
    return remote.mergeCommit!;
  });
  const prepareMerge = vi.fn(async () => send);
  const getPR = vi.spyOn(provider, 'getPR').mockImplementation(async () => ({ ...remote }));
  vi.spyOn(f.engine, 'provider').mockReturnValue(Object.assign(provider, { prepareMerge }));
  const task = await f.engine.create({
    ref,
    requirements: 'Implement the feature',
    repoPath: f.dir,
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
    setRemote: (patch: Partial<PullRequest>) => {
      remote = { ...remote, ...patch };
    },
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
