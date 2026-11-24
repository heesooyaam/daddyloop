import type { Engine } from './engine.js';
import type { Store } from './store.js';
import {
  AppError,
  isTicket,
  prRef,
  sameRevision,
  type AutoMergeMode,
  type ReviewGroup,
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

export function autoMergeStatus(task: Task, settings: ReturnType<typeof autoMergeSettings>) {
  if (task.state !== 'complete') return;
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

export function autoMergeEnabled(store: Store, task: Task) {
  if (!task.groupId || task.ref.provider !== 'github' || isTicket(task)) return false;
  const group = store.getGroup(task.groupId);
  return (
    group.workspace?.provider === 'github' &&
    !group.deletedAt &&
    !group.deletion &&
    group.daddyState !== 'paused' &&
    group.daddyState !== 'archived' &&
    autoMergeSettings(store, group, task).enabled
  );
}

function enabled(store: Store, task: Task) {
  return task.state === 'complete' && !store.busy(task.id) && autoMergeEnabled(store, task);
}

export async function pollAutoMerge(engine: Engine, stopping: () => boolean) {
  const { store } = engine;
  for (const candidate of store.tasks()) {
    if (stopping()) return;
    if (
      candidate.state !== 'complete' ||
      candidate.ref.provider !== 'github' ||
      candidate.pr?.state !== 'open'
    )
      continue;
    const last = store.setting<MergeResult>(`autoMerge.result:${candidate.id}`);
    if (!enabled(store, candidate) && last?.state !== 'uncertain') continue;
    if (
      last?.generation === candidate.generation &&
      last.head === candidate.revision?.head &&
      (last.state === 'merged' || Date.now() - last.checkedAt < 60_000)
    )
      continue;
    const recheck = await engine.lock(candidate.id, async () => {
      const task = store.getTask(candidate.id);
      if (
        stopping() ||
        task.state !== 'complete' ||
        !task.revision ||
        !task.pr ||
        store.busy(task.id)
      )
        return;
      const ref = prRef(task),
        revision = task.revision;
      const key = `auto-merge:${task.id}:${task.generation}:${revision.head}:${revision.base}`;
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
            store.saveTask(task);
            record('merged', 'Merged on GitHub', pr.mergeCommit);
          });
          return;
        }
        if (
          pr.state !== 'open' ||
          pr.cloneUrl !== task.pr.cloneUrl ||
          pr.targetBranch !== task.pr.targetBranch ||
          pr.branch !== task.pr.branch
        )
          return record('waiting', 'The PR is closed or its branches changed');
        if (store.db.prepare("SELECT 1 FROM operations WHERE id=? AND status='pending'").get(key))
          return record('uncertain', 'Waiting for GitHub to confirm the previous merge request');
        if (!enabled(store, store.getTask(task.id))) return;
        if (pr.draft === true)
          return record('waiting', 'Draft PR: mark it ready for review on GitHub');
        if (!sameRevision(revision, pr) || (pr.mergeConflict && pr.draft === false)) return true;
        if (
          !task.reviewFinished ||
          task.snapshot?.status !== 'published' ||
          task.snapshot.comments.length ||
          !sameRevision(task.snapshot.revision, revision) ||
          !task.review ||
          !sameRevision(task.review.revision, revision) ||
          task.pendingFix ||
          (task.pendingAuthorHead && task.pendingAuthorHead !== pr.head) ||
          (task.kind === 'plan' && task.policy.planApproval === 'human' && !task.approvedAt)
        )
          return record('waiting', 'Waiting for a completed review of this revision');
        if (pr.checks !== 'passing') return record('waiting', 'Waiting for passing CI');
        if (pr.mergeable === null) return record('waiting', 'GitHub is calculating mergeability');
        if (pr.draft !== false || pr.mergeable !== true)
          return record('waiting', 'Waiting for GitHub to allow this PR to merge');
        const review = await provider.getReview(ref, task.review);
        if (
          review.status !== 'published' ||
          review.comments.length ||
          !sameRevision(review.revision, revision)
        )
          return record('waiting', 'Waiting for a published review with no outstanding findings');
        if (!provider.prepareMerge)
          return record('waiting', 'Auto-merge is unavailable for this provider');
        const send = await provider.prepareMerge(ref);
        const fresh = await provider.getPR(ref);
        if (
          fresh.state !== 'open' ||
          fresh.cloneUrl !== pr.cloneUrl ||
          fresh.branch !== pr.branch ||
          fresh.targetBranch !== pr.targetBranch ||
          fresh.draft !== false ||
          fresh.mergeable !== true ||
          fresh.checks !== 'passing' ||
          !sameRevision(revision, fresh)
        )
          return record('waiting', 'PR or checks changed during the merge check');
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
          store.saveTask(task);
          record('merged', 'Merged on GitHub', commit);
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
