import { randomUUID } from 'node:crypto';
import { type Store } from './store.js';
import { needsReviewChecks } from './pr-routing.js';
import {
  now,
  type ReviewGroup,
  type Task,
  type State,
  type Job,
  type AgentProfile,
  architectProfileFor,
  sameAgentProfile,
} from './types.js';

interface PausedTask {
  workerProfile?: AgentProfile;
  id: string;
  generation: number;
  state: State;
  reason: string;
  resumeState?: State;
  jobs: string[];
}
interface PauseSnapshot {
  tasks: PausedTask[];
  coordinatorQueue: string[];
}
const key = (id: string) => 'daddy.sessionPause:' + id;

// The caller holds all task locks and a single store transaction.
export function pauseSessionWork(store: Store, group: ReviewGroup, tasks: Task[]) {
  const snapshot: PauseSnapshot = { tasks: [], coordinatorQueue: [] };
  for (const task of tasks) {
    if (task.state === 'complete' || task.state === 'paused') continue;
    const jobs = store.activeJobs(task.id).filter((j) => j.generation === task.generation);
    snapshot.tasks.push({
      id: task.id,
      generation: task.generation + 1,
      state: task.state,
      reason: task.reason,
      resumeState: task.resumeState,
      workerProfile: task.agents?.worker,
      jobs: jobs.map((j) => j.id),
    });
    task.resumeState = task.state;
    task.generation++;
    store.cancelJobs(task.id);
    task.state = 'paused';
    task.reason = 'Paused with the session';
    store.saveTask(task);
    store.event(task.id, 'task.state', {
      state: task.state,
      reason: task.reason,
      generation: task.generation,
    });
  }
  for (const job of store.daddyJobs(group.id)) {
    if (job.status !== 'queued') continue;
    snapshot.coordinatorQueue.push(job.id);
    store.saveDaddyJob({ ...job, status: 'cancelled', finishedAt: now() });
  }
  store.setSetting(key(group.id), snapshot);
  return snapshot.tasks.map((t) => t.id);
}

// Old session pauses emitted consecutive task.state / human.pause pairs then daddy.paused.
// An individual pause_task call carries its own nonempty reason. Leave other pauses alone.
function legacySnapshot(store: Store, group: ReviewGroup): PauseSnapshot | undefined {
  const last = store.db
    .prepare(
      "SELECT id,data FROM events WHERE task_id=? AND type='daddy.paused' ORDER BY id DESC LIMIT 1",
    )
    .get(group.id);
  if (!last || JSON.parse(String(last.data)).snapshot) return;
  const snapshot: PauseSnapshot = { tasks: [], coordinatorQueue: [] };
  let cursor = Number(last.id);
  const tasks = new Map(store.tasks(group.id).map((t) => [t.id, t]));
  const previousPair = store.db.prepare(
    'SELECT id,task_id,type,data,at FROM events WHERE id<? ORDER BY id DESC LIMIT 2',
  );
  while (cursor > 0) {
    const [pause, state] = previousPair.all(cursor);
    if (
      !pause ||
      !state ||
      pause.type !== 'human.pause' ||
      state.type !== 'task.state' ||
      pause.task_id !== state.task_id ||
      JSON.parse(String(pause.data)).reason !== '' ||
      JSON.parse(String(state.data)).state !== 'paused'
    )
      break;
    cursor = Number(state.id);
    const task = tasks.get(String(state.task_id));
    if (!task) break;
    if (
      task.state !== 'paused' ||
      !task.resumeState ||
      task.generation !== JSON.parse(String(state.data)).generation
    )
      continue;
    const earlier = store.db
      .prepare(
        "SELECT data FROM events WHERE task_id=? AND type='task.state' AND id<? ORDER BY id DESC LIMIT 1",
      )
      .get(task.id, cursor);
    const prior = earlier && JSON.parse(String(earlier.data));
    // Only cancelled attempts belonging to the immediately preceding generation can return.
    const jobs = store
      .jobs(task.id)
      .filter(
        (j) =>
          j.status === 'cancelled' &&
          j.generation === task.generation - 1 &&
          !store.db
            .prepare(
              "SELECT 1 FROM events WHERE run_id=? AND type IN ('job.completed','job.failed','job.cancelled') AND id<?",
            )
            .get(j.id, cursor),
      );
    snapshot.tasks.push({
      id: task.id,
      generation: task.generation,
      state: task.resumeState,
      reason: prior?.state === task.resumeState ? prior.reason : 'Session work resumed',
      jobs: jobs.map((j) => j.id),
    });
  }
  if (snapshot.tasks.length) return snapshot;
}

export function restoreSessionWork(store: Store, group: ReviewGroup, legacyOnly = false) {
  const saved = store.setting<PauseSnapshot>(key(group.id));
  if (legacyOnly && saved) return;
  const snapshot = saved ?? legacySnapshot(store, group);
  if (!snapshot) return;
  for (const item of snapshot.tasks) {
    const task = store.getTask(item.id);
    if (task.state !== 'paused' || task.generation !== item.generation || task.groupId !== group.id)
      continue;
    task.state = item.state;
    if (
      task.prLink &&
      item.state === 'submitting' &&
      task.prLink.generation === item.generation - 1 &&
      task.prLink.head === task.pendingAuthorHead
    )
      task.prLink.generation = task.generation;
    task.reason = item.reason;
    task.resumeState = item.resumeState;
    if (task.inputRequest) task.inputRequest.generation = task.generation;
    if (task.resourcePause) task.resourcePause.generation = task.generation;
    store.saveTask(task);
    const history = new Map(store.jobs(task.id).map((job) => [job.id, job]));
    for (const id of item.jobs) {
      const job = history.get(id);
      if (!job || job.generation !== task.generation - 1) continue;
      if (
        job.kind === 'review' &&
        !job.deferredResult &&
        task.ref.kind !== 'ticket' &&
        task.pr &&
        needsReviewChecks(task, task.pr)
      ) {
        task.reviewAfterChecks = {
          input: job.input,
          freshContextRetry: job.freshContextRetry,
          timeoutRetry: job.timeoutRetry,
        };
        task.state = 'awaiting_review_checks';
        task.reason = 'Waiting for CI results before review';
        store.saveTask(task);
        continue;
      }
      const retry: Job = {
        ...job,
        id: randomUUID(),
        firstAttemptId: job.firstAttemptId ?? job.id,
        generation: task.generation,
        groupGeneration: group.generation,
        profile:
          job.kind === 'plan'
            ? architectProfileFor(task, group)
            : job.role === 'reviewer'
              ? group.daddy
              : item.workerProfile &&
                  task.agents?.worker &&
                  !sameAgentProfile(item.workerProfile, task.agents.worker)
                ? task.agents.worker
                : job.profile,
        status: 'queued',
        startedAt: undefined,
        finishedAt: undefined,
        turnId: undefined,
        threadId: undefined,
        error: undefined,
        errorCode: undefined,
      };
      store.saveJob(retry);
      store.event(task.id, 'job.queued', { role: job.role, kind: job.kind }, retry.id);
    }
    store.event(task.id, 'task.state', {
      state: task.state,
      reason: task.reason,
      generation: task.generation,
    });
  }
  const queued = new Set(snapshot.coordinatorQueue);
  for (const job of store.daddyJobs(group.id))
    if (queued.has(job.id) && job.status === 'cancelled')
      store.saveDaddyJob({
        ...job,
        status: 'queued',
        profile: group.daddy,
        generation: group.generation,
        finishedAt: undefined,
      });
  if (saved) store.setSetting(key(group.id), null);
}
