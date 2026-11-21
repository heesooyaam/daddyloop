import type { Store } from './store.js';
import {
  sameAgentProfile,
  type AgentProfile,
  type ReviewGroup,
  type Task,
  type WorkerSlot,
} from './types.js';

export function workerSlots(store: Store, group: ReviewGroup): WorkerSlot[] {
  const target = group.requestedWorkerLimit ?? group.workerLimit ?? 1;
  const saved: WorkerSlot[] =
    group.workerSlots ??
    (group.workerTasks ?? []).map((taskId, index) => ({ number: index + 1, taskId }));
  const occupied = saved.filter(
    (slot) =>
      slot.taskId && (store.getTask(slot.taskId).state !== 'complete' || store.busy(slot.taskId)),
  );
  const slots = Array.from({ length: target }, (_, index): WorkerSlot => {
    const number = index + 1;
    return (
      occupied.find((slot) => slot.number === number) ?? {
        number,
        profile: saved.find((slot) => slot.number === number)?.profile,
      }
    );
  });
  return slots.concat(occupied.filter((slot) => slot.number > target));
}

export function saveWorkerSlots(store: Store, group: ReviewGroup, slots: WorkerSlot[]) {
  group.workerSlots = slots.filter((slot) => slot.taskId || slot.profile);
  group.workerTasks = slots.flatMap((slot) => (slot.taskId ? [slot.taskId] : []));
  store.saveGroup(group);
}

export function workerPool(store: Store, group: ReviewGroup, jobs = store.activeJobs()) {
  const slots = workerSlots(store, group);
  const taskIds = slots.flatMap((slot) => (slot.taskId ? [slot.taskId] : []));
  const limit = group.workerLimit ?? 1;
  const target = group.requestedWorkerLimit ?? limit;
  return {
    limit,
    target,
    pending: limit !== target,
    occupied: taskIds.length,
    retiring: Math.max(0, taskIds.length - target),
    active: jobs.filter(
      (job) => job.groupId === group.id && job.role === 'author' && job.status === 'running',
    ).length,
    hostLimit: store.setting<number>('worker.maxAgents') ?? 1,
    taskIds,
    slots,
  };
}

/** Only the scheduler applies a resize. No cancellation, reassignment or workspace deletion. */
export function reconcileWorkerPools(store: Store) {
  for (const group of store.groups().filter((group) => group.orchestrated)) {
    const pool = workerPool(store, group);
    const limit = Math.max(pool.target, pool.occupied);
    if (
      limit === group.workerLimit &&
      JSON.stringify(group.workerSlots) ===
        JSON.stringify(pool.slots.filter((slot) => slot.taskId || slot.profile))
    )
      continue;
    group.requestedWorkerLimit = pool.target;
    group.workerLimit = limit;
    store.transaction(() => {
      saveWorkerSlots(store, group, pool.slots);
      if (limit > pool.hostLimit) store.setSetting('worker.maxAgents', Math.min(8, limit));
      if (limit !== pool.limit)
        store.event(group.id, 'daddy.pool_applied', {
          limit,
          target: pool.target,
          pending: limit !== pool.target,
        });
    });
  }
}

export function selectWorker(
  slots: WorkerSlot[],
  group: ReviewGroup,
  task: Task,
  defaultProfile: AgentProfile,
) {
  const current = slots.find((slot) => slot.taskId === task.id);
  if (current) return current;
  const limit = group.workerLimit ?? 1;
  const capacity = Math.min(limit, group.requestedWorkerLimit ?? limit);
  if (slots.filter((slot) => slot.taskId).length >= capacity) return;
  const request = task.workerRequest;
  const available = slots.filter(
    (slot) =>
      !slot.taskId && slot.number <= capacity && (!request?.slot || slot.number === request.slot),
  );
  const profile = request?.profile;
  return (
    (profile &&
      available.find((slot) => sameAgentProfile(slot.profile ?? defaultProfile, profile))) ??
    available[0]
  );
}
