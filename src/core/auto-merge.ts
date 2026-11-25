import { githubWait, type githubBackoff } from '../providers/github-quota.js';
import type { Engine } from './engine.js';
import type { Store } from './store.js';
import {
  AppError,
  isTicket,
  prRef,
  sameRevision,
  type AutoMergeMode,
  type ReviewGroup,
  type PullRequest,
  type ReviewSnapshot,
  type Task,
} from './types.js';

type MergeResult = {
  state: 'waiting' | 'uncertain' | 'merged';
  message: string;
  generation: number;
  head: string;
  checkedAt: number;
  commit?: string;
};

export function sessionAutoMerge(store: Store, id: string) {
  return store.setting<boolean>(`autoMerge.session:${id}`) === true;
}

export function autoMergeSettings(store: Store, group: ReviewGroup, task: Task) {
  const mode = store.setting<AutoMergeMode>(`autoMerge.mode:${task.id}`) ?? 'inherit';
  const result = store.setting<MergeResult>(`autoMerge.result:${task.id}`);
  return {
    mode,
    enabled: mode === 'inherit' ? sessionAutoMerge(store, group.id) : mode === 'on',
    result:
      result?.generation === task.generation && result.head === task.revision?.head
        ? result
        : undefined,
  };
}

export function githubActivityStatus(
  task: Task,
  settings: ReturnType<typeof autoMergeSettings>,
  backoff?: ReturnType<typeof githubBackoff>,
) {
  if (
    backoff &&
    [
      'queued',
      'fixing',
      'reviewing',
      'awaiting_publication',
      'awaiting_checks',
      'awaiting_push',
      'awaiting_merge',
      'ready_for_review',
      'submitting',
    ].includes(task.state)
  ) {
    const time = new Date(backoff.until).toISOString().slice(11, 19);
    if (task.prLink && backoff.kind === 'read')
      return `PR #${task.prLink.ref.number} · GitHub ${backoff.status ? 'HTTP ' + backoff.status : 'offline'} · retry at ${time} UTC`;
    if (backoff.kind === 'read')
      return `GitHub ${backoff.status ? 'HTTP ' + backoff.status : 'offline'} · retry at ${time} UTC`;
    return `Waiting for GitHub API quota until ${time.slice(0, 5)} UTC`;
  }
  if (!reviewed(task) || task.ref.provider !== 'github') return;
  if (settings.result?.state === 'merged') return settings.result.message;
  if (settings.enabled && task.pr?.state === 'open')
    return settings.result?.message ?? 'Checking GitHub auto-merge';
}

export function setTaskMergeMode(
  store: Store,
  group: ReviewGroup,
  task: Task,
  mode: AutoMergeMode,
) {
  if (group.workspace?.provider !== 'github' || task.ref.provider !== 'github')
    throw new AppError('merge_unsupported', 'Auto-merge is available for GitHub sessions', 400);
  if (group.deletion || group.deletedAt)
    throw new AppError('session_deleting', 'This session is being deleted');
  store.transaction(() => {
    store.setSetting(`autoMerge.mode:${task.id}`, mode);
    store.event(task.id, 'automerge.setting', { mode });
  });
  return autoMergeSettings(store, group, task);
}

function reviewed(task: Task) {
  return task.state === 'awaiting_merge' || task.state === 'complete';
}

function configuredGroup(store: Store, task: Task) {
  if (!task.groupId || task.ref.provider !== 'github' || isTicket(task)) return;
  const group = store.getGroup(task.groupId);
  if (
    group.workspace?.provider === 'github' &&
    !group.deletedAt &&
    !group.deletion &&
    autoMergeSettings(store, group, task).enabled
  )
    return group;
}

export function autoMergeRequested(store: Store, task: Task) {
  return !!configuredGroup(store, task);
}

export function autoMergeEnabled(store: Store, task: Task) {
  const group = configuredGroup(store, task);
  return !!group && group.daddyState !== 'paused' && group.daddyState !== 'archived';
}

export function pendingMerge(store: Store, task: Task) {
  if (!task.revision || task.ref.provider !== 'github') return;
  // An idle pause advances the run generation while the provider's answer can still be unknown.
  return store.db
    .prepare("SELECT id FROM operations WHERE task_id=? AND status='pending' AND id GLOB ?")
    .get(task.id, `auto-merge:${task.id}:*:${task.revision.head}:${task.revision.base}`)?.id as
    string | undefined;
}

function enabled(store: Store, task: Task) {
  return (
    reviewed(task) &&
    !task.deferredWorkerInstructions?.length &&
    !store.busy(task.id) &&
    autoMergeEnabled(store, task)
  );
}

export async function pollAutoMerge(engine: Engine, stopping: () => boolean) {
  const { store } = engine;
  for (const candidate of store.tasks()) {
    if (stopping()) return;
    if (
      !reviewed(candidate) ||
      candidate.ref.provider !== 'github' ||
      candidate.pr?.state !== 'open' ||
      githubWait(store, candidate.ref)
    )
      continue;
    const last = store.setting<MergeResult>(`autoMerge.result:${candidate.id}`);
    if (
      candidate.state === 'awaiting_merge' &&
      !autoMergeRequested(store, candidate) &&
      last?.state !== 'uncertain' &&
      !pendingMerge(store, candidate)
    ) {
      try {
        await engine.reconcile(candidate.id);
      } catch {
        store.event(candidate.id, 'automerge.recheck_failed', { head: candidate.revision?.head });
      }
      continue;
    }
    if (
      !enabled(store, candidate) &&
      last?.state !== 'uncertain' &&
      !pendingMerge(store, candidate)
    )
      continue;
    if (
      last?.generation === candidate.generation &&
      last.head === candidate.revision?.head &&
      (last.state === 'merged' || Date.now() - last.checkedAt < 60_000)
    )
      continue;
    const recheck = await engine.lock(candidate.id, async () => {
      const task = store.getTask(candidate.id);
      if (stopping() || !reviewed(task) || !task.revision || !task.pr || store.busy(task.id))
        return;
      if (task.state === 'complete' && autoMergeRequested(store, task))
        engine.finishReviewedTask(task);
      const ref = prRef(task),
        revision = task.revision;
      const pending = pendingMerge(store, task);
      const key =
        pending ?? `auto-merge:${task.id}:${task.generation}:${revision.head}:${revision.base}`;
      const input = { ref, revision, target: task.pr.targetBranch };
      const record = (state: MergeResult['state'], message: string, commit?: string) => {
        const result = {
          state,
          message,
          commit,
          generation: task.generation,
          head: revision.head,
          checkedAt: Date.now(),
        };
        store.setSetting(`autoMerge.result:${task.id}`, result);
        if (last?.message !== message || last.state !== state)
          store.event(task.id, 'automerge.' + state, result);
      };
      try {
        const provider = engine.provider(ref);
        const pr = await provider.getPR(ref);
        if (pr.state === 'merged') {
          if (pr.head !== revision.head)
            return record('waiting', 'GitHub merged a different revision');
          if (pr.mergeCommit && store.db.prepare('SELECT 1 FROM operations WHERE id=?').get(key)) {
            const commit = pr.mergeCommit;
            await engine.broker.outbox.perform(
              task.id,
              key,
              input,
              async () => commit,
              async () => ({ found: true, value: commit }),
            );
          }
          store.transaction(() => {
            task.pr = pr;
            record('merged', 'Merged on GitHub', pr.mergeCommit);
            engine.finishReviewedTask(task, 'Merged on GitHub');
          });
          return;
        }
        if (pending)
          return record('uncertain', 'Waiting for GitHub to confirm the previous merge request');
        // The last observation uses fresh GitHub state after the provider has prepared the
        // write. It goes through the same decision as the first observation.
        const observe = async (current: PullRequest, nativeReview?: ReviewSnapshot) => {
          const latest = store.getTask(task.id);
          if (
            stopping() ||
            !enabled(store, latest) ||
            latest.generation !== task.generation ||
            !sameRevision(latest.revision, revision)
          )
            return;
          const action = engine.prAction(latest, current, { nativeReview });
          switch (action.kind) {
            case 'repair':
              await engine.applyRepair(latest, current, action);
              return;
            case 'read-native-review':
            case 'refresh':
            case 'merge':
              return action.kind;
            case 'confirm-merge':
              return record(
                'uncertain',
                'Waiting for GitHub to confirm the previous merge request',
              );
            case 'wait':
              return record('waiting', action.reason);
            case 'target-changed':
              return record('waiting', 'The PR is closed or its branches changed');
            case 'wait-mergeability':
              return record('waiting', 'GitHub is calculating mergeability');
            default:
              return record('waiting', 'Waiting for a completed review of this revision');
          }
        };
        const first = await observe(pr);
        if (first !== 'read-native-review') return first === 'refresh';
        if (!provider.prepareMerge)
          return record('waiting', 'Auto-merge is unavailable for this provider');
        const send = await provider.prepareMerge(ref);
        const [fresh, review] = await Promise.all([
          provider.getPR(ref),
          provider.getReview(ref, task.review!),
        ]);
        const final = await observe(fresh, review);
        if (final !== 'merge') return final === 'refresh';
        if (stopping() || !enabled(store, store.getTask(task.id))) return;
        const commit = await engine.broker.outbox.perform(
          task.id,
          key,
          input,
          async () => {
            record('uncertain', 'Waiting for GitHub to confirm the previous merge request');
            return send(revision.head);
          },
          async () => {
            const remote = await provider.getPR(ref);
            return remote.state === 'merged' && remote.head === revision.head && remote.mergeCommit
              ? { found: true, value: remote.mergeCommit }
              : { found: false };
          },
          (error) =>
            error instanceof AppError && /^provider_(403|404|405|409|422)$/.test(error.code),
        );
        store.transaction(() => {
          task.pr = { ...fresh, state: 'merged', mergeCommit: commit };
          record('merged', 'Merged on GitHub', commit);
          engine.finishReviewedTask(task, 'Merged on GitHub');
        });
      } catch (error) {
        const pending = store.db
          .prepare("SELECT 1 FROM operations WHERE id=? AND status='pending'")
          .get(key);
        const status = error instanceof AppError && /^provider_([0-9]{3})$/.exec(error.code);
        record(
          pending ? 'uncertain' : 'waiting',
          pending
            ? 'Waiting for GitHub to confirm the previous merge request'
            : status
              ? `GitHub refused the auto-merge check (HTTP ${status[1]})`
              : 'Could not check GitHub auto-merge',
        );
      }
    });
    if (recheck && !stopping() && enabled(store, store.getTask(candidate.id))) {
      try {
        await engine.reconcile(candidate.id);
      } catch {
        store.event(candidate.id, 'automerge.recheck_failed', { head: candidate.revision?.head });
      }
    }
  }
}
