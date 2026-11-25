import type { Store } from '../core/store.js';
import type { Task } from '../core/types.js';
import { draftInspectionRequired } from '../core/task-activity.js';
import { notificationPreferences } from './notifications.js';

export type OwnerQuestion =
  { groupId: string; taskId: string; request: string } | { groupId: string; messageId: string };
export function taskRequestKey(store: Store, task: Task) {
  if (task.state === 'awaiting_plan_approval')
    return `plan:${task.contextVersion}:${task.revision?.head}:${task.revision?.base}:${task.review?.id ?? ''}`;
  if (
    task.state === 'needs_input' &&
    task.reason === draftInspectionRequired &&
    task.review &&
    !store.pendingReviewWrites(task.id, task.review.marker).length
  )
    return 'inspect-draft:' + task.review.id;
  if (task.state === 'needs_input' && task.inputRequest?.generation === task.generation)
    return task.inputRequest.runId;
}

export function reminderOpen(store: Store, question: OwnerQuestion) {
  if (!notificationPreferences(store).enabled) return false;
  const group = store.getGroup(question.groupId);
  if (
    group.deletedAt ||
    group.deletion ||
    group.daddyState === 'paused' ||
    group.daddyState === 'archived'
  )
    return false;
  if ('taskId' in question) {
    const task = store.getTask(question.taskId);
    return task.groupId === group.id && taskRequestKey(store, task) === question.request;
  }
  const message = store.messageById(group.id, question.messageId);
  if (!message?.needsReply || message.phase !== 'final' || message.sender !== 'agent') return false;
  const later = store.db
    .prepare(
      `SELECT 1 FROM messages WHERE task_id=? AND rowid>(SELECT rowid FROM messages WHERE id=?) AND
    (json_extract(data,'$.sender')='user' OR json_extract(data,'$.phase')='final') LIMIT 1`,
    )
    .get(group.id, message.id);
  if (later) return false;
  if (group.daddyState === 'needs_input') return true;
  const job = store.daddyJobs(group.id).find((j) => j.id === message.runId);
  if (!job?.waitingTaskId) return false;
  const task = store.getTask(job.waitingTaskId);
  return task.state === 'needs_input' && !taskRequestKey(store, task);
}

export function nextReminderId(store: Store, originalId: string, time: number) {
  const prior = store.db
    .prepare(
      'SELECT id,status,at FROM notifications WHERE id=? OR id GLOB ? ORDER BY rowid DESC LIMIT 1',
    )
    .get(originalId, originalId + ':reminder:*');
  if (!prior) return;
  if (prior.status === 'pending' && prior.id !== originalId) return String(prior.id);
  if (prior.status !== 'sent' && !(prior.status === 'superseded' && prior.id !== originalId))
    return;
  const sent = Date.parse(String(prior.at));
  if (Number.isFinite(sent) && time - sent >= 30 * 60000) return originalId + ':reminder:' + sent;
}
