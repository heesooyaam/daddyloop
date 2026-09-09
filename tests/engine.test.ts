import { prRef } from '../src/core/types.js';
import { describe, it, expect } from 'vitest';
import { fixture } from './helpers.js';
import { buildContext } from '../src/runtime/context.js';
import { defaultPolicy } from '../src/core/types.js';

describe('publication gates and revision safety', () => {
  it('keeps prematurely published findings in the next review’s verification obligations', async () => {
    const f = await fixture();
    await f.engine.review(f.task.id);
    const finding = (await f.engine.broker.call(f.job(), 'add_comment', {
      key: 'R1',
      body: 'Needs verification',
    })) as { id: string };
    const first = f.store.claim()!,
      task = f.store.getTask(f.task.id);
    await f.provider.publish(prRef(task), task.review!);
    await f.engine.completeJob(first, f.result());
    first.status = 'completed';
    f.store.saveJob(first);
    expect(f.store.getTask(task.id).state).toBe('needs_input');
    await f.engine.review(task.id, true);
    expect(f.store.getTask(task.id).feedback?.comments[0].id).toBe(finding.id);
    await f.run();
    expect(f.store.getTask(task.id).reason).toMatch(/not verified/);
    f.store.close();
  });
  it('can restore an earlier summary in a later tool call without an idempotency-cache collision', async () => {
    const f = await fixture();
    await f.engine.review(f.task.id);
    const job = f.job();
    await f.engine.broker.call(job, 'set_summary', { body: 'Version A' }, 'call-a1');
    await f.engine.broker.call(job, 'set_summary', { body: 'Version B' }, 'call-b');
    await f.engine.broker.call(job, 'set_summary', { body: 'Version A' }, 'call-a2');
    const task = f.store.getTask(f.task.id);
    expect((await f.provider.getReview(prRef(task), task.review!)).body).toContain('Version A');
    f.store.close();
  });
  it('a failed reviewer discussion cannot reopen the publication gate through resume', async () => {
    const f = await fixture();
    await f.engine.review(f.task.id);
    await f.run();
    await f.engine.chat(f.task.id, 'reviewer', 'Update the finding after investigation');
    const job = f.store.claim()!;
    await f.engine.completeJob(
      job,
      f.result({ status: 'incomplete', summary: 'The edit could not be verified' }),
    );
    job.status = 'failed';
    f.store.saveJob(job);
    await f.engine.action(f.task.id, 'resume');
    await expect(f.engine.publish(f.task.id)).rejects.toMatchObject({
      code: 'publication_unavailable',
    });
    f.store.close();
  });
  it('does not publish a review after the PR was closed', async () => {
    const f = await fixture();
    await f.engine.review(f.task.id);
    await f.run();
    const pr = await f.provider.getPR(prRef(f.task));
    pr.state = 'closed';
    f.store.setSetting('demo-pr:1', pr);
    await expect(f.engine.publish(f.task.id)).rejects.toMatchObject({ code: 'stale_revision' });
    f.store.close();
  });
  it('re-reviews unchanged code after an author turn instead of waiting for a nonexistent push', async () => {
    const f = await fixture();
    await f.engine.review(f.task.id);
    const comment = (await f.engine.broker.call(f.job(), 'add_comment', {
      key: 'R1',
      body: 'Potential issue',
    })) as { id: string };
    await f.run();
    await f.engine.publish(f.task.id);
    f.store.decision(f.store.getTask(f.task.id), {
      commentId: comment.id,
      outcome: 'rejected',
      reason: 'Human accepted the existing behavior',
    });
    const author = f.store.claim()!;
    await f.engine.completeJob(author, f.result());
    author.status = 'completed';
    f.store.saveJob(author);
    expect(f.store.getTask(f.task.id).state).toBe('queued');
    await f.engine.review(f.task.id);
    await f.run();
    await f.engine.publish(f.task.id);
    expect(f.store.getTask(f.task.id).state).toBe('complete');
    f.store.close();
  });
  it('waits for a manual push when real unpushed author commits exist', async () => {
    const f = await fixture();
    await f.engine.review(f.task.id);
    await f.engine.broker.call(f.job(), 'add_comment', { key: 'R1', body: 'Fix this' });
    await f.run();
    await f.engine.publish(f.task.id);
    const task = f.store.getTask(f.task.id);
    task.pendingAuthorHead = 'd'.repeat(40);
    f.store.saveTask(task);
    await f.run();
    expect(f.store.getTask(f.task.id).state).toBe('awaiting_push');
    f.store.close();
  });
  it('never gives the author draft feedback; starts exactly one fix after publication', async () => {
    const f = await fixture();
    await f.engine.review(f.task.id);
    await f.engine.broker.call(f.job(), 'add_comment', {
      key: 'R1',
      body: 'Repro:\n```ts\nstaleCallback();\n```',
      path: 'a.ts',
      line: 4,
    });
    await f.run();
    expect(f.store.getTask(f.task.id).state).toBe('awaiting_publication');
    expect(f.store.jobs().filter((j) => j.role === 'author')).toHaveLength(0);
    await expect(f.engine.broker.call(f.job('author'), 'read_review', {})).rejects.toMatchObject({
      code: 'draft_private',
    });
    await f.engine.publish(f.task.id);
    await f.engine.reconcile(f.task.id);
    await f.engine.reconcile(f.task.id);
    expect(f.store.jobs().filter((j) => j.kind === 'fix')).toHaveLength(1);
    expect(f.store.getTask(f.task.id).feedback?.comments[0].body).toContain(
      '```ts\nstaleCallback();\n```',
    );
    f.store.close();
  });
  it('uses the externally edited published comments and honors deletions', async () => {
    const f = await fixture();
    await f.engine.review(f.task.id);
    const a = (await f.engine.broker.call(f.job(), 'add_comment', {
      key: 'A',
      body: 'original A',
    })) as { id: string };
    const b = (await f.engine.broker.call(f.job(), 'add_comment', {
      key: 'B',
      body: 'delete me',
    })) as { id: string };
    await f.run();
    const task = f.store.getTask(f.task.id);
    await f.provider.updateComment(
      prRef(task),
      task.review!,
      a.id,
      'Human edited final requirement',
    );
    await f.provider.deleteComment(prRef(task), task.review!, b.id);
    await f.provider.publish(prRef(task), task.review!);
    await f.engine.reconcile(task.id);
    expect(f.store.getTask(task.id).feedback?.comments.map((c) => c.body)).toEqual([
      'Human edited final requirement',
    ]);
    f.store.close();
  });
  it('a changed head cannot be approved by a late reviewer result', async () => {
    const f = await fixture();
    await f.engine.review(f.task.id);
    const job = f.store.claim()!;
    const old = f.result();
    await f.provider.advance(prRef(f.task));
    await f.engine.reconcile(f.task.id);
    await f.engine.completeJob(job, old);
    expect(f.store.getTask(f.task.id).state).toBe('needs_input');
    expect(f.store.getTask(f.task.id).reviewFinished).toBe(false);
    await expect(f.engine.publish(f.task.id)).rejects.toMatchObject({
      code: 'publication_unavailable',
    });
    f.store.close();
  });
  it('a changed base invalidates a review even when the head is unchanged', async () => {
    const f = await fixture();
    await f.engine.review(f.task.id);
    await f.run();
    const pr = await f.provider.getPR(prRef(f.task));
    pr.base = 'c'.repeat(40);
    f.store.setSetting('demo-pr:1', pr);
    await expect(f.engine.publish(f.task.id)).rejects.toMatchObject({
      code: 'stale_revision',
    });
    f.store.close();
  });
  it('does not publish incomplete reviews after pause/resume or a restart', async () => {
    const f = await fixture();
    await f.engine.review(f.task.id);
    f.store.claim();
    f.engine.recoverInterruptedJobs();
    await f.engine.action(f.task.id, 'resume');
    expect(f.store.getTask(f.task.id).state).toBe('needs_input');
    await expect(f.engine.publish(f.task.id)).rejects.toMatchObject({
      code: 'publication_unavailable',
    });
    f.store.close();
  });
  it('refuses to publish while a discussion turn is queued', async () => {
    const f = await fixture();
    await f.engine.review(f.task.id);
    await f.run();
    await f.engine.chat(f.task.id, 'reviewer', 'Explain R1');
    await expect(f.engine.publish(f.task.id)).rejects.toMatchObject({
      code: 'publication_unavailable',
    });
    f.store.close();
  });
  it('a completed review with missing CI waits for a revision-bound human waiver', async () => {
    const f = await fixture();
    const pr = await f.provider.getPR(prRef(f.task));
    pr.checks = 'missing';
    f.store.setSetting('demo-pr:1', pr);
    await f.engine.review(f.task.id);
    await f.run();
    await f.engine.publish(f.task.id);
    expect(f.store.getTask(f.task.id).state).toBe('awaiting_checks');
    await expect(f.engine.action(f.task.id, 'waive-checks', '')).rejects.toMatchObject({
      code: 'waiver_invalid',
    });
    await f.engine.action(f.task.id, 'waive-checks', 'Reviewed test output manually');
    expect(f.store.getTask(f.task.id).state).toBe('complete');
    f.store.close();
  });
  it('a plan has a separate approval gate and retains its approved Markdown', async () => {
    const f = await fixture({
      kind: 'plan',
      planDocuments: [{ path: 'plan.md', body: '# Accepted plan\nUse generations.' }],
    });
    await f.engine.review(f.task.id);
    await f.run();
    await f.engine.publish(f.task.id);
    expect(f.store.getTask(f.task.id).state).toBe('awaiting_plan_approval');
    await f.engine.action(f.task.id, 'approve-plan');
    const implementation = await f.engine.create({
      ref: { ...prRef(f.task), number: 2, url: 'https://demo.local/pull/2' },
      repoPath: '/tmp',
      requirements: 'Implement the plan',
      planTaskId: f.task.id,
    });
    expect(implementation.approvedPlan?.documents[0].body).toContain('Use generations.');
    expect(implementation.approvedPlan?.head).toBe(f.task.revision?.head);
    f.store.close();
  });
  it('enforces a review-round limit without reporting success', async () => {
    const f = await fixture({ policy: { ...defaultPolicy, maxRounds: 1 } });
    await f.engine.review(f.task.id);
    await f.engine.broker.call(f.job(), 'add_comment', {
      key: 'R1',
      body: 'A real defect',
    });
    await f.run();
    await f.engine.publish(f.task.id);
    expect(f.store.getTask(f.task.id).state).toBe('needs_input');
    expect(f.store.jobs().filter((j) => j.kind === 'fix')).toHaveLength(0);
    f.store.close();
  });
  it('requires independent verification of prior findings before completing a clean round', async () => {
    const f = await fixture();
    await f.engine.review(f.task.id);
    await f.engine.broker.call(f.job(), 'add_comment', {
      key: 'R1',
      body: 'Defect',
    });
    await f.run();
    await f.engine.publish(f.task.id);
    const fix = f.store.claim()!;
    await f.provider.advance(prRef(f.task));
    await f.engine.completeJob(fix, f.result());
    fix.status = 'completed';
    f.store.saveJob(fix);
    await f.engine.review(f.task.id);
    await f.run({ verifiedCommentIds: [] });
    expect(f.store.getTask(f.task.id).state).toBe('needs_input');
    expect(f.store.getTask(f.task.id).reason).toMatch(/not verified/);
    f.store.close();
  });
  it('blocks author self-verification and stale tool calls', async () => {
    const f = await fixture();
    await f.engine.review(f.task.id);
    await expect(
      f.engine.broker.call(f.job('author'), 'record_decision', {
        outcome: 'verified',
        reason: 'Trust me',
      }),
    ).rejects.toMatchObject({ code: 'role_forbidden' });
    const oldJob = f.job();
    await f.engine.action(f.task.id, 'pause');
    await expect(
      f.engine.broker.call(oldJob, 'add_comment', { key: 'R1', body: 'Late' }),
    ).rejects.toMatchObject({ code: 'stale_run' });
    f.store.close();
  });
  it('keeps private reviewer chat and draft decisions out of author context', async () => {
    const f = await fixture();
    await f.engine.review(f.task.id);
    f.store.message(f.task.id, 'reviewer', 'user', 'PRIVATE CHAT');
    f.store.decision(f.store.getTask(f.task.id), {
      commentId: 'draft-1',
      outcome: 'deferred',
      reason: 'PRIVATE DRAFT REASON',
    });
    const context = buildContext(f.store, f.store.getTask(f.task.id), {
      ...f.job('author'),
      kind: 'chat',
    });
    expect(context).not.toContain('PRIVATE CHAT');
    expect(context).not.toContain('PRIVATE DRAFT REASON');
    f.store.close();
  });
  it('refuses to attach the same PR or author session twice', async () => {
    const f = await fixture();
    await expect(
      f.engine.create({
        ref: prRef(f.task),
        requirements: 'duplicate',
        repoPath: '/tmp',
      }),
    ).rejects.toMatchObject({ code: 'already_attached' });
    f.store.close();
  });
});
