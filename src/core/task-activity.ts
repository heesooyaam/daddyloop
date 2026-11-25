import type { AgentProfile, Job, State, Task, WorkerSlot } from './types.js';

export const taskReference = (task: { id: string }) => `DADDY-${task.id.slice(0, 8)}`;

export const draftSyncPending =
  'Waiting to confirm the GitHub draft or its target branch before restarting review.';

export const draftInspectionRequired =
  'Inspect the old review draft: it contains changes that daddy cannot safely replace.';

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

export type TaskActivity = { task: Task; job?: Job; mergeStatus?: string; assignedWorker?: number };

export function outstandingActivity(item: TaskActivity) {
  return item.task.state !== 'complete' || (item.task.pr?.state === 'open' && !!item.mergeStatus);
}

export function taskActivity(
  tasks: Task[],
  jobs: Job[],
  mergeStatus?: (task: Task) => string | undefined,
  slots: WorkerSlot[] = [],
): TaskActivity[] {
  const byId = new Map<string, TaskActivity>(
    tasks.map((task) => [
      task.id,
      {
        task,
        mergeStatus: mergeStatus?.(task),
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
  return [...new Set([...ordered, ...byId.values()])];
}

export function queueDetail(task: Task): string | undefined {
  if (task.prLink && task.state === 'submitting')
    return 'The PR already exists. daddy will connect it automatically.';
  if (task.state !== 'needs_input') return;
  // Private reviewer reports are not group notifications. Show an explicit owner question or an operational error.
  if (task.inputRequest?.generation === task.generation || task.resumeState !== 'reviewing')
    return task.reason;
}
export function activityStatus({ task, job, mergeStatus, assignedWorker }: TaskActivity) {
  if (mergeStatus) return mergeStatus;
  if (task.state === 'submitting' && task.prLink?.retryAt)
    return `PR #${task.prLink.ref.number} · retry at ${new Date(task.prLink.retryAt).toISOString().slice(11, 19)} UTC`;
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
