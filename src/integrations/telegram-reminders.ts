import type { Store } from '../core/store.js';
import type { Message, ReviewGroup, Task } from '../core/types.js';
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
  const request = task.inputRequest;
  if (
    task.state === 'needs_input' &&
    request?.generation === task.generation &&
    request.reviewDispute !== 'daddy'
  )
    return request.reviewDispute === 'owner' ? 'dispute:' + request.runId : request.runId;
}

export function reminderOpen(store: Store, question: OwnerQuestion) {
  if (!notificationPreferences(store).enabled) return false;
  const group = store.groups().find((g) => g.id === question.groupId);
  if (!group) return false;
  if (
    group.deletedAt ||
    group.deletion ||
    group.daddyState === 'paused' ||
    group.daddyState === 'archived'
  )
    return false;
  if ('taskId' in question) {
    const task = store.tasks(group.id).find((t) => t.id === question.taskId);
    if (!task || taskRequestKey(store, task) !== question.request) return false;
    const owner = store.setting<{ userId: number }>('telegram.pairing')?.userId;
    if (!owner) return false;
    const original = `telegram:question:${owner}:${task.id}:${question.request}`;
    // An explicit reply acknowledges this occurrence even while daddy is still processing it.
    // Match the trusted outgoing receipt and the native chat/message IDs, never the quoted text.
    return !store.db
      .prepare(
        `SELECT 1 FROM messages m WHERE m.task_id=?
      AND json_extract(m.data,'$.sender')='user' AND json_extract(m.data,'$.origin.replyTo.messageId') IS NOT NULL
      AND EXISTS (SELECT 1 FROM settings s WHERE s.key GLOB 'telegram.delivery:*'
        AND (json_extract(s.value,'$.options.key')=? OR json_extract(s.value,'$.options.key') GLOB ?)
        AND json_extract(s.value,'$.destination.chatId')=json_extract(m.data,'$.origin.chatId')
        AND EXISTS(SELECT 1 FROM json_each(s.value,'$.messages') delivered
          WHERE json_extract(delivered.value,'$.id')=json_extract(m.data,'$.origin.replyTo.messageId'))) LIMIT 1`,
      )
      .get(group.id, original, original + ':reminder:*');
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
  const task = store.tasks(group.id).find((t) => t.id === job.waitingTaskId);
  return task?.state === 'needs_input' && !taskRequestKey(store, task);
}

export function privateAgentReplyAllowed(store: Store, group: ReviewGroup, message: Message) {
  const job = message.runId && store.daddyJobs(group.id).find((job) => job.id === message.runId);
  if (job && job.trigger === 'user') return true;
  const prefs = notificationPreferences(store);
  if (!prefs.enabled) return false;
  if (
    prefs.mode !== 'attention' ||
    group.daddyState === 'needs_input' ||
    (message.needsReply && reminderOpen(store, { groupId: group.id, messageId: message.id }))
  )
    return true;
  const tasks = store.tasks(group.id);
  return tasks.length > 0 && tasks.every((task) => task.state === 'complete');
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
