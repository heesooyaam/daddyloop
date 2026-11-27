import {
  sameRevision,
  type AgentProfile,
  type Job,
  type State,
  type Task,
  type WorkerSlot,
} from './types.js';

export const taskReference = (task: { id: string }) => `DADDY-${task.id.slice(0, 8)}`;

export const draftSyncPending =
  'Waiting to confirm the GitHub draft or its target branch before restarting review.';

export const draftInspectionRequired =
  'Inspect the old review draft: it contains changes that daddy cannot safely replace.';

export const disputedFindings =
  'Author disputes published findings; discuss them with the reviewer';

export function waitingForDaddy(task: Task) {
  return (
    task.state === 'needs_input' &&
    task.inputRequest?.generation === task.generation &&
    task.inputRequest.reviewDispute === 'daddy'
  );
}

const statusLabels: Record<State, string> = {
  discussing: 'Waiting for assignment',
  implementing: 'Implementing the task',
  ready_for_review: 'Ready for review',
  submitting: 'Submitting the changes',
  queued: 'Waiting for a worker',
  reviewing: 'Reviewing the changes',
  awaiting_publication: 'Publishing review',
  fixing: 'Addressing review feedback',
  awaiting_push: 'Sending fixes',
  awaiting_merge: 'Waiting for GitHub merge',
  awaiting_checks: 'Waiting for CI',
  awaiting_plan_approval: 'Waiting for plan approval',
  needs_input: 'Action needed',
  paused: 'Paused',
  complete: 'Complete',
};

export function taskStatus(state: State, queued = false, role?: Job['role']) {
  if (queued && state !== 'paused' && state !== 'complete')
    return role === 'reviewer' ? 'Waiting for review' : 'Waiting for a worker';
  return statusLabels[state];
}

export type TaskActivity = {
  task: Task;
  job?: Job;
  mergeStatus?: string;
  assignedWorker?: number;
  waitingFor?: string[];
};

export function correctionDependencies(
  task: Task,
  job: Job,
  stateOf: (id: string) => State | undefined,
) {
  if (
    !task.groupId ||
    task.ref.kind === 'ticket' ||
    job.role !== 'author' ||
    (job.kind !== 'plan' && job.kind !== 'fix')
  )
    return [];
  return (task.dependsOn ?? []).filter((id) => stateOf(id) !== 'complete');
}
export function dependencyDetail(item: TaskActivity) {
  return item.waitingFor?.length
    ? item.waitingFor.map((id) => taskReference({ id })).join(', ')
    : undefined;
}

export function outstandingActivity(item: TaskActivity) {
  return (
    item.task.state !== 'complete' ||
    (item.job?.kind === 'chat' &&
      (item.job.status === 'queued' || item.job.status === 'running')) ||
    (item.task.pr?.state === 'open' && !!item.mergeStatus)
  );
}

export function taskActivity(
  tasks: Task[],
  jobs: Job[],
  mergeStatus?: (task: Task, job?: Job) => string | undefined,
  slots: WorkerSlot[] = [],
  lookupDependency?: (id: string) => State | undefined,
): TaskActivity[] {
  const byId = new Map<string, TaskActivity>(
    tasks.map((task) => [
      task.id,
      {
        task,
        assignedWorker: slots.find((slot) => slot.taskId === task.id)?.number,
      },
    ]),
  );
  const ordered = new Set<TaskActivity>();
  for (const job of jobs) {
    const item = byId.get(job.taskId);
    if (item?.task.generation !== job.generation) continue;
    if (!item.job || job.status === 'running') item.job = job;
    ordered.add(item);
  }
  for (const item of byId.values()) {
    if (mergeStatus) item.mergeStatus = mergeStatus(item.task, item.job);
    if (item.job?.status === 'queued')
      item.waitingFor = correctionDependencies(
        item.task,
        item.job,
        (id) => byId.get(id)?.task.state ?? lookupDependency?.(id),
      );
  }
  return [...new Set([...ordered, ...byId.values()])];
}

export function queueDetail(task: Task): string | undefined {
  if (task.prLink && task.state === 'submitting' && !task.prLink.ref)
    return 'Checking GitHub for the result of the previous PR creation';
  if (task.prLink && task.state === 'submitting')
    return 'The PR already exists. daddy will connect it automatically.';
  if (task.state !== 'needs_input') return;
  if (waitingForDaddy(task)) return activityReason(task);
  // Private reviewer reports are not group notifications. Show an explicit owner question or an operational error.
  if (task.inputRequest?.generation === task.generation || task.resumeState !== 'reviewing')
    return task.reason;
}

export function activityPrNumber(task: Task) {
  return task.prLink?.ref?.number ?? (task.ref?.kind !== 'ticket' ? task.ref?.number : undefined);
}

export function retryTime(until: number) {
  return new Date(Math.ceil(until / 1000) * 1000).toISOString().slice(11, 19);
}

export const mergeabilityStatus = 'GitHub is calculating mergeability';

export function waitingForMergeability(task: Task) {
  return (
    task.state === 'awaiting_publication' &&
    task.snapshot?.status === 'published' &&
    sameRevision(task.snapshot.revision, task.revision) &&
    sameRevision(task.snapshot.revision, task.review?.revision)
  );
}

export function activityReason(task: Task) {
  if (waitingForDaddy(task) && task.reviewRecovery?.coordination)
    return 'daddy is coordinating the architect’s question with the related tasks.';
  if (waitingForDaddy(task))
    return 'daddy is checking the worker’s objection to the published review.';
  return waitingForMergeability(task)
    ? 'The review is published. Waiting for GitHub to determine mergeability.'
    : task.reason;
}

export function localRetryStatus(task: Task, job?: Job) {
  const number = activityPrNumber(task);
  const pr = number ? ` · PR #${number}` : '';
  if (task.state === 'awaiting_publication') {
    const until = Math.max(task.publicationRetry?.retryAt ?? 0, task.partialReview?.retryAt ?? 0);
    if (until) {
      const phase = waitingForMergeability(task)
        ? 'GitHub mergeability check'
        : 'GitHub review publication';
      return { until, label: `${phase} · retry at ${retryTime(until)} UTC${pr}` };
    }
  }
  if (task.state === 'queued' && task.mergeVerificationRequest) {
    const until = task.mergeVerificationRequest.retryAt;
    return { until, label: `GitHub PR · retry at ${retryTime(until)} UTC${pr}` };
  }
  if (task.state === 'queued' && task.draftStart?.retryAt) {
    const until = task.draftStart.retryAt;
    return { until, label: `GitHub review draft · retry at ${retryTime(until)} UTC${pr}` };
  }
  if (task.state === 'submitting' && task.prLink?.retryAt) {
    const until = task.prLink.retryAt;
    const target = number ? `PR #${number}` : 'GitHub';
    return { until, label: `${target} · retry at ${retryTime(until)} UTC` };
  }
  if (
    task.state === 'fixing' &&
    task.fixingMergeConflict &&
    job?.timeoutRetry &&
    job.status === 'queued' &&
    job.notBefore
  ) {
    const until = Date.parse(job.notBefore);
    return {
      until,
      label: `Continuing conflict resolution after a timeout at ${retryTime(until)} UTC${pr}`,
    };
  }
}

export function activityStatus({
  task,
  job,
  mergeStatus,
  assignedWorker,
  waitingFor,
}: TaskActivity) {
  if (waitingFor?.length) return 'Waiting for prerequisite tasks';
  if (waitingForDaddy(task)) return 'Waiting for daddy’s decision';
  if (
    task.state === 'needs_input' &&
    task.inputRequest?.reviewDispute === 'owner' &&
    task.inputRequest.generation === task.generation
  )
    return 'Waiting for your answer';
  if (job?.kind === 'plan' && task.ref.kind !== 'ticket' && task.reviewRecovery)
    return job.status === 'running'
      ? 'Task architect is revising the fix plan'
      : 'Waiting for the task architect';
  if (job?.kind === 'plan' && job.status === 'running')
    return 'Checking architecture and implementation plan';
  if (job?.kind === 'chat' && job.status === 'running') return 'Task discussion in progress';
  if (waitingForMergeability(task)) {
    if (mergeStatus) return `${mergeabilityStatus} · ${mergeStatus}`;
    return localRetryStatus(task, job)?.label ?? mergeabilityStatus;
  }
  if (mergeStatus) return mergeStatus;
  if (
    job?.kind === 'chat' &&
    job.status === 'queued' &&
    (task.state === 'complete' || task.state === 'awaiting_merge')
  )
    return 'Waiting for task discussion';
  const retry = localRetryStatus(task, job);
  if (retry) return retry.label;
  if (task.state === 'needs_input') {
    if (task.inputRequest?.generation === task.generation) return 'Waiting for your answer';
    if (task.reason === draftSyncPending) return 'Checking the GitHub draft';
    if (task.reason.startsWith('PR changed while a draft existed'))
      return 'The PR changed during draft review';
    if (
      task.reason.includes('The worker copy contains earlier changes') ||
      task.reason.includes('additional local changes')
    )
      return 'Earlier worker changes need reconciliation';
    if (
      task.reason.includes('Inspect the earlier draft review') ||
      task.reason.includes('Inspect the old review draft')
    )
      return 'Check the draft on the previous commit';
    if (
      task.resumeState === 'reviewing' &&
      task.reason.includes('Agent exceeded the configured run time limit')
    )
      return 'Review reached the run time limit';
  }
  if (task.fixingMergeConflict && task.state === 'fixing') {
    if (job?.status === 'running') return 'Resolving the merge conflict';
    return assignedWorker
      ? `Conflict repair queued for worker ${assignedWorker}`
      : 'Waiting for a free worker to resolve the merge conflict';
  }
  if (
    task.workerReport &&
    task.state === 'reviewing' &&
    job?.role === 'reviewer' &&
    job.status === 'running'
  )
    return 'Reviewing the worker report';
  if (assignedWorker && job?.role === 'author' && job.status === 'queued')
    return 'Assigned worker is waiting to start';
  return taskStatus(task.state, job?.status === 'queued', job?.role);
}

export function profileText(profile: AgentProfile) {
  return [profile.engine, profile.model, profile.effort].filter(Boolean).join(' · ');
}
