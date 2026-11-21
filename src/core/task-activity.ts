import type { AgentProfile, Job, State, Task } from './types.js';

export const taskReference = (task: { id: string }) => `DADDY-${task.id.slice(0, 8)}`;

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

export type TaskActivity = { task: Task; job?: Job };

export function taskActivity(tasks: Task[], jobs: Job[]): TaskActivity[] {
  const byId = new Map<string, TaskActivity>(tasks.map((task) => [task.id, { task }]));
  const ordered = new Set<TaskActivity>();
  for (const job of jobs) {
    const item = byId.get(job.taskId);
    if (item?.task.generation !== job.generation) continue;
    if (!item.job || job.status === 'running') item.job = job;
    ordered.add(item);
  }
  return [...new Set([...ordered, ...byId.values()])];
}

export function activityStatus({ task, job }: TaskActivity) {
  return taskStatus(task.state, job?.status === 'queued', job?.role);
}

export function profileText(profile: AgentProfile) {
  return [profile.engine, profile.model, profile.effort].filter(Boolean).join(' · ');
}
