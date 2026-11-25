import {
  sameRevision,
  type AgentResult,
  type Job,
  type PullRequest,
  type ReviewSnapshot,
  type Task,
} from './types.js';

export function sameOpenTarget(expected: PullRequest | undefined, current: PullRequest) {
  return (
    current.state === 'open' &&
    !!expected &&
    current.branch === expected.branch &&
    current.targetBranch === expected.targetBranch &&
    current.cloneUrl === expected.cloneUrl
  );
}

export function hasReleasedReview(task: Task) {
  return (
    task.reviewFinished ||
    (!!task.partialReview &&
      task.review?.id === task.partialReview.reviewId &&
      task.snapshot?.status === 'published' &&
      task.snapshot.comments.length > 0)
  );
}
const dirtyConflictCopy =
  'AppError: The worker copy contains earlier changes. Inspect them before resolving the merge conflict.';
export function staleConflictPreparation(task: Task) {
  return (
    task.state === 'needs_input' &&
    task.fixingMergeConflict === true &&
    !task.pendingFix &&
    task.resumeState === 'fixing' &&
    (task.reason === dirtyConflictCopy ||
      task.reason ===
        'AppError: The worker copy has no pending merge of the expected target commit.' ||
      task.reason ===
        'AppError: The PR changed before the queued job started. Reconcile and review the new revision.')
  );
}

export interface PrEvidence {
  // Supplied after reading the native review. Cached task.snapshot is not fresh publication evidence.
  nativeReview?: ReviewSnapshot;
  resumeRepair?: boolean;
  report?: { kind: 'review' | 'fix'; result: AgentResult };
}

export type PrAction =
  | {
      kind: 'repair';
      preparation: 'clean' | 'retire-draft' | 'checkpoint' | 'preserve-checkpoint' | 'resume';
    }
  | { kind: 'wait'; reason: string }
  | {
      kind:
        | 'wait-mergeability'
        | 'read-native-review'
        | 'target-changed'
        | 'finish-running-review'
        | 'continue-repair'
        | 'inspect-repair'
        | 'publish-findings'
        | 'publish-review'
        | 'fix-findings'
        | 'confirm-merge'
        | 'confirm-fix'
        | 'check-fix-base'
        | 'hold-incomplete'
        | 'finish'
        | 'refresh'
        | 'merge'
        | 'review'
        | 'continue';
    };

const repairableStates = new Set<Task['state']>([
  'queued',
  'awaiting_checks',
  'awaiting_plan_approval',
  'awaiting_merge',
  'complete',
]);
const wait = (reason: string): PrAction => ({ kind: 'wait', reason });

// Pure routing policy. All callers describe the observed work, independently of who noticed the PR.
export function nextPrAction(
  task: Task,
  pr: PullRequest,
  facts: PrEvidence & { autoMerge: boolean; jobs: Job[]; mergePending: boolean },
): PrAction {
  const { autoMerge: enabled, jobs, mergePending, report, nativeReview, resumeRepair } = facts;
  if (mergePending) return { kind: 'confirm-merge' };
  if (!sameOpenTarget(task.pr, pr)) {
    if (task.fixingMergeConflict && task.state === 'fixing') return { kind: 'inspect-repair' };
    return { kind: 'target-changed' };
  }
  if (resumeRepair && task.fixingMergeConflict && task.resumeState === 'fixing' && !jobs.length) {
    if (!enabled) return wait('Enable auto-merge before resuming conflict resolution.');
    return sameRevision(task.revision, pr) && pr.draft === false
      ? { kind: 'repair', preparation: 'resume' }
      : { kind: 'inspect-repair' };
  }
  if (task.state === 'paused') return wait('Paused');
  const pinned = task.revision;
  const sameHead = pinned?.head === pr.head;
  const unchanged = sameRevision(pinned, pr);
  if (
    (task.pendingFix && (task.pendingAuthorHead !== pr.head || !unchanged)) ||
    (task.state === 'awaiting_push' &&
      task.pendingAuthorHead &&
      task.pendingAuthorHead !== pinned?.head)
  )
    return { kind: 'confirm-fix' };
  const conflict = enabled && pr.draft === false && pr.mergeConflict === true;
  const recovered = staleConflictPreparation(task);
  if (task.fixingMergeConflict && (task.state === 'fixing' || recovered)) {
    if (!sameHead) return { kind: 'inspect-repair' };
    if (
      recovered &&
      enabled &&
      !jobs.length &&
      pr.draft === false &&
      pr.mergeable != null &&
      (task.reason === dirtyConflictCopy ? conflict : !unchanged)
    ) {
      return conflict
        ? { kind: 'repair', preparation: 'preserve-checkpoint' }
        : { kind: 'refresh' };
    }
    return { kind: 'continue-repair' };
  }

  if (report && sameHead && report.result.checkedHead === pr.head && !task.pendingFix) {
    const result = report.result;
    if (
      report.kind === 'fix' &&
      conflict &&
      result.status === 'incomplete' &&
      !result.question?.trim() &&
      !result.disputedCommentIds?.length &&
      task.authorWorktree &&
      task.snapshot?.status === 'published' &&
      hasReleasedReview(task)
    )
      return { kind: 'repair', preparation: 'checkpoint' };
    if (
      report.kind === 'review' &&
      task.ref.provider === 'github' &&
      task.review &&
      !task.partialReview &&
      sameRevision(task.review.revision, pinned) &&
      (result.status !== 'completed' || (conflict && !unchanged))
    ) {
      const empty =
        nativeReview?.status === 'draft' &&
        !nativeReview.comments.length &&
        nativeReview.body === `Review in progress.\n\n<!-- ${task.review.marker} -->`;
      if (empty)
        return conflict ? { kind: 'repair', preparation: 'retire-draft' } : { kind: 'continue' };
      return { kind: 'publish-findings' };
    }
  }
  if (report) return { kind: 'continue' };

  if (task.state === 'awaiting_publication' && (task.reviewFinished || task.partialReview)) {
    if (
      !sameHead ||
      (!unchanged && !task.partialReview) ||
      (nativeReview && !sameRevision(nativeReview.revision, pinned))
    )
      return { kind: 'refresh' };
    if (nativeReview?.status !== 'published') return { kind: 'publish-review' };
    if (conflict) return { kind: 'repair', preparation: 'clean' };
    if (enabled && pr.draft === false && pr.mergeable == null) return { kind: 'wait-mergeability' };
    if (nativeReview.comments.length) return { kind: 'fix-findings' };
    return task.reviewFinished ? { kind: 'finish' } : { kind: 'hold-incomplete' };
  }
  if (
    conflict &&
    task.state === 'reviewing' &&
    sameHead &&
    jobs.some(
      (j) => j.generation === task.generation && j.kind === 'review' && j.status === 'running',
    )
  )
    return { kind: 'finish-running-review' };
  if (
    (task.state === 'awaiting_merge' || task.state === 'complete') &&
    task.deferredWorkerInstructions?.length
  )
    return wait('Waiting for queued worker instructions');
  if (
    conflict &&
    repairableStates.has(task.state) &&
    !jobs.length &&
    (!task.review || task.snapshot?.status === 'published') &&
    (!task.pendingAuthorHead || task.pendingAuthorHead === pr.head)
  )
    return { kind: 'repair', preparation: 'clean' };

  if (!unchanged) {
    if (
      task.state === 'fixing' &&
      sameHead &&
      jobs.some((j) => j.kind === 'fix' && j.generation === task.generation)
    )
      return { kind: 'check-fix-base' };
    return { kind: 'refresh' };
  }

  if (task.state === 'complete' || task.state === 'awaiting_merge') {
    if (!enabled || jobs.length)
      return wait('Waiting for automatic merge to be enabled and the task to be idle');
    if (pr.draft === true) return wait('Draft PR: mark it ready for review on GitHub');
    if (
      !task.reviewFinished ||
      !task.review ||
      !sameRevision(task.review.revision, pinned) ||
      task.snapshot?.status !== 'published' ||
      task.snapshot.comments.length ||
      !sameRevision(task.snapshot.revision, pinned) ||
      task.pendingFix ||
      (task.pendingAuthorHead && task.pendingAuthorHead !== pr.head) ||
      (task.kind === 'plan' && task.policy.planApproval === 'human' && !task.approvedAt)
    )
      return wait('Waiting for a completed review of this revision');
    if (pr.checks !== 'passing') return wait('Waiting for passing CI');
    if (pr.mergeable == null) return { kind: 'wait-mergeability' };
    if (pr.draft !== false || pr.mergeable !== true || conflict)
      return wait('Waiting for GitHub to allow this PR to merge');
    if (!nativeReview) return { kind: 'read-native-review' };
    if (
      nativeReview.status !== 'published' ||
      nativeReview.comments.length ||
      !sameRevision(nativeReview.revision, pinned)
    )
      return wait('Waiting for a published review with no outstanding findings');
    return { kind: 'merge' };
  }
  return task.state === 'queued' ? { kind: 'review' } : { kind: 'continue' };
}

export function completionGate(task: Task) {
  if (task.policy.requireChecks && !task.checksWaivedAt && task.pr?.checks !== 'passing')
    return {
      state: 'awaiting_checks' as const,
      reason:
        task.pr?.checks === 'missing'
          ? 'No CI results for this revision. Add checks or record a human waiver.'
          : `CI is ${task.pr?.checks} on the reviewed revision`,
    };
  if (task.kind === 'plan' && task.policy.planApproval === 'human' && !task.approvedAt)
    return {
      state: 'awaiting_plan_approval' as const,
      reason: 'Plan review is complete. Human approval is required before implementation.',
    };
}
