import type { Store } from './store.js';
import type { ReviewGroup } from './types.js';

export function writerPool(store: Store, group: ReviewGroup) {
  const jobs = store.jobs().filter((job) => job.groupId === group.id);
  // Upgrade old sessions conservatively: an idle author can still owe review fixes.
  const assigned =
    group.writerTasks ??
    store
      .tasks()
      .filter(
        (task) =>
          task.groupId === group.id &&
          (task.authorThreadId ||
            jobs.some((job) => job.taskId === task.id && job.role === 'author' && job.startedAt)),
      )
      .map((task) => task.id);
  const taskIds = assigned.filter((id) => store.getTask(id).state !== 'complete' || store.busy(id));
  const limit = group.writerLimit ?? 1;
  const target = group.requestedWriterLimit ?? limit;
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
export function reconcileWriterPools(store: Store) {
  for (const group of store.groups().filter((group) => group.orchestrated)) {
    const pool = writerPool(store, group);
    const limit = Math.max(pool.target, pool.occupied);
    if (
      limit === group.writerLimit &&
      JSON.stringify(group.writerTasks) === JSON.stringify(pool.taskIds)
    )
      continue;
    group.requestedWriterLimit = pool.target;
    group.writerLimit = limit;
    group.writerTasks = pool.taskIds;
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

export function canAssignWriter(store: Store, group: ReviewGroup, taskId: string) {
  const pool = writerPool(store, group);
  return pool.taskIds.includes(taskId) || pool.occupied < Math.min(pool.limit, pool.target);
}

export function assignWriter(store: Store, group: ReviewGroup, taskId: string) {
  group.writerTasks ??= writerPool(store, group).taskIds;
  if (!group.writerTasks.includes(taskId)) {
    group.writerTasks.push(taskId);
    store.saveGroup(group);
  }
}
