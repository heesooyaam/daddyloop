import type { Store } from './store.js';
import type { ReviewGroup } from './types.js';

export function workerPool(store: Store, group: ReviewGroup) {
  const jobs = store.jobs().filter((job) => job.groupId === group.id);
  const taskIds = group.workerTasks!.filter(
    (id) => store.getTask(id).state !== 'complete' || store.busy(id),
  );
  const limit = group.workerLimit ?? 1;
  const target = group.requestedWorkerLimit ?? limit;
  return {
    limit,
    target,
    pending: limit !== target,
    occupied: taskIds.length,
    retiring: Math.max(0, taskIds.length - target),
    active: jobs.filter((job) => job.role === 'author' && job.status === 'running').length,
    hostLimit: store.setting<number>('worker.maxAgents') ?? 1,
    taskIds,
  };
}

/** Only the scheduler applies a resize. No cancellation, reassignment or workspace deletion. */
export function reconcileWorkerPools(store: Store) {
  for (const group of store.groups().filter((group) => group.orchestrated)) {
    const pool = workerPool(store, group);
    const limit = Math.max(pool.target, pool.occupied);
    if (
      limit === group.workerLimit &&
      JSON.stringify(group.workerTasks) === JSON.stringify(pool.taskIds)
    )
      continue;
    group.requestedWorkerLimit = pool.target;
    group.workerLimit = limit;
    group.workerTasks = pool.taskIds;
    store.transaction(() => {
      store.saveGroup(group);
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

export function canAssignWorker(store: Store, group: ReviewGroup, taskId: string) {
  const pool = workerPool(store, group);
  return pool.taskIds.includes(taskId) || pool.occupied < Math.min(pool.limit, pool.target);
}

export function assignWorker(store: Store, group: ReviewGroup, taskId: string) {
  if (!group.workerTasks!.includes(taskId)) {
    group.workerTasks!.push(taskId);
    store.saveGroup(group);
  }
}
