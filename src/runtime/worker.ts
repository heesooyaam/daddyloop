import { isDeepStrictEqual } from 'node:util';
import { dynamicTools } from '../core/broker.js';
import { reviewDecisionTool } from '../core/review-decisions.js';
import { retryConfirmedSubmission } from '../core/ticket-workflow.js';
import { sameOpenTarget, sameReviewTarget, staleConflictPreparation } from '../core/pr-routing.js';
import { GitHubRetryError, githubWait } from '../providers/github-quota.js';
import { autoMergeEnabled, pollAutoMerge } from '../core/auto-merge.js';
import { confirmedSupersededDraft, type Engine } from '../core/engine.js';
import type { Job, ResourceStatus, Task } from '../core/types.js';
import { AppError, now, sameRevision, sameAgentProfile, prRef, isTicket } from '../core/types.js';
import { redact, redactEvent } from '../core/security.js';
import type { AgentRuntime } from './agent.js';
import { Workspaces, git } from './workspaces.js';
import { DemoProvider } from '../providers/demo.js';
import { buildContext } from './context.js';
import { workspaceScope } from '../core/workspace-registry.js';
import { realpathSync } from 'node:fs';
import { join, sep } from 'node:path';
import {
  reconcileWorkerPools,
  saveWorkerSlots,
  selectWorker,
  workerSlots,
} from '../core/worker-pool.js';

export class Worker {
  private active = new Map<string, AbortController>();
  private runningJobs = new Map<string, Job>();
  private finalizing = new Set<string>();
  private pendingRuns = new Set<Promise<void>>();
  private submitting = new Set<string>();
  private taskRuns = new Map<Promise<void>, string>();
  private timer?: NodeJS.Timeout;
  private ticking = false;
  private stopped = false;
  private lastPoll = 0;
  private readonly githubPolls = new Map<
    string,
    { state: Task['state']; generation: number; at: number }
  >();
  private mergeRun?: Promise<void>;
  private tickDone: Promise<void> = Promise.resolve();
  private lastCleanup = 0;
  private lastArcRelease = 0;
  private reservedGroups = new Set<string>();
  updateAuthorGroupGeneration(groupId: string, generation: number) {
    for (const job of this.runningJobs.values())
      if (job.groupId === groupId && job.role === 'author') job.groupGeneration = generation;
  }
  reserveGroup(id: string) {
    if (
      this.reservedGroups.has(id) ||
      [...this.runningJobs.values()].some((job) => job.role === 'reviewer' && job.groupId === id)
    )
      return false;
    this.reservedGroups.add(id);
    return true;
  }
  releaseGroup(id: string) {
    this.reservedGroups.delete(id);
  }
  isFinalizing(jobId: string) {
    return this.finalizing.has(jobId);
  }
  private track(taskId: string, run: Promise<void>) {
    this.taskRuns.set(run, taskId);
    void run.then(
      () => this.taskRuns.delete(run),
      () => this.taskRuns.delete(run),
    );
  }
  async waitForGroup(groupId: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const pending = (async () => {
      await this.tickDone;
      signal?.throwIfAborted();
      await Promise.allSettled(
        [...this.taskRuns.entries()]
          .filter(([, taskId]) => this.engine.store.getTask(taskId).groupId === groupId)
          .map(([run]) => run),
      );
    })();
    if (!signal) return pending;
    let onAbort!: () => void;
    const interrupted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      await Promise.race([pending, interrupted]);
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }
  autoCleanup?: () => Promise<unknown>;
  refreshIssueSource?: (id: string) => Promise<void>;
  autoSubmit?: (id: string) => Promise<unknown>;
  constructor(
    readonly engine: Engine,
    private workspaces: Workspaces,
    private liveRuntime: AgentRuntime,
    private demoRuntime: AgentRuntime,
    private resourceCheck: () => ResourceStatus,
    private pollMs = 15000,
    private maxAgents = 1,
  ) {
    engine.onCancel = (id) => this.active.get(id)?.abort();
  }
  start() {
    this.engine.recoverInterruptedJobs();
    this.engine.restoreMergeWaits();
    this.engine.recoverLostFixes();
    this.engine.recoverReviewRoundLimits();
    this.timer = setInterval(() => {
      void this.tick().catch((error) =>
        this.engine.store.event('_system', 'worker.error', { error: redact(String(error)) }),
      );
    }, 1000);
    void this.tick().catch((error) =>
      this.engine.store.event('_system', 'worker.error', { error: redact(String(error)) }),
    );
  }
  async tick() {
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    let finishTick!: () => void;
    this.tickDone = new Promise((resolve) => {
      finishTick = resolve;
    });
    try {
      const store = this.engine.store;
      const resources = this.resourceCheck();
      if (Date.now() - this.lastArcRelease > 15000) {
        this.lastArcRelease = Date.now();
        for (const task of store
          .tasks()
          .filter(
            (task) =>
              task.state === 'complete' &&
              !store.busy(task.id) &&
              (!task.groupId || !store.getGroup(task.groupId).deletion),
          )) {
          for (const role of ['author', 'reviewer'] as const) {
            if (!task.arcWorkspaces?.[role]?.managed) continue;
            try {
              await this.workspaces.parkArc(task, role);
            } catch (error) {
              store.event(task.id, 'arc.copy_preserved', { error: redact(String(error)) });
            }
          }
        }
        for (const task of store.tasks())
          if (
            task.ref.provider === 'arcadia' &&
            (!task.groupId || !store.getGroup(task.groupId).deletion) &&
            task.ref.kind !== 'ticket' &&
            task.arcWorkspaces?.author &&
            !store.busy(task.id) &&
            task.pendingAuthorHead === task.revision?.head &&
            task.pr?.head === task.revision?.head
          ) {
            try {
              await this.engine.lock(task.id, async () => {
                const current = store.getTask(task.id);
                if (
                  store.busy(current.id) ||
                  current.ref.kind === 'ticket' ||
                  !current.arcWorkspaces?.author ||
                  current.pendingAuthorHead !== current.revision?.head ||
                  current.pr?.head !== current.revision?.head
                )
                  return;
                await this.workspaces.releaseArc(current, 'author');
                store.saveTask(current);
                store.event(current.id, 'author.workspace_released');
              });
            } catch (error) {
              store.event(task.id, 'author.workspace_preserved', { error: redact(String(error)) });
            }
          }
      }
      if (!resources.ok && this.active.size) {
        for (const id of this.active.keys())
          await this.engine.interruptTask(
            id,
            `${resources.reasons.join('; ')}. Existing work was preserved.`,
            'resource.pause',
          );
      }
      if (
        !resources.ok &&
        resources.reasons.some((r) => r.includes('Disk')) &&
        this.autoCleanup &&
        !this.active.size &&
        Date.now() - this.lastCleanup > 300000
      ) {
        this.lastCleanup = Date.now();
        await this.autoCleanup();
      }
      const poll = Date.now() - this.lastPoll > this.pollMs;
      if (poll) {
        this.lastPoll = Date.now();
        const tasks = store.tasks();
        for (const task of tasks.filter(confirmedSupersededDraft)) {
          if (
            !githubWait(store, task.ref) &&
            autoMergeEnabled(store, task) &&
            !store.busy(task.id)
          ) {
            try {
              await this.engine.review(task.id, true);
            } catch (error) {
              store.event(task.id, 'review.recovery_failed', { error: redact(String(error)) });
            }
            if (this.stopped) return;
          }
        }
        for (const task of tasks) {
          if (githubWait(store, task.ref)) continue;
          if (
            this.refreshIssueSource &&
            task.ref.provider === 'github' &&
            !isTicket(task) &&
            task.source?.kind === 'local'
          ) {
            try {
              await this.refreshIssueSource(task.id);
            } catch (error) {
              store.event(task.id, 'ticket.source_refresh_failed', {
                error: redact(String(error)),
              });
            }
          }
          if (
            task.state === 'needs_input' &&
            task.fixingMergeConflict &&
            task.resumeState === 'fixing'
          ) {
            try {
              await this.engine.restorePendingConflict(task.id, (t) =>
                this.workspaces.pendingConflictBase(t),
              );
            } catch (error) {
              store.event(task.id, 'conflict.recovery_failed', { error: redact(String(error)) });
            }
            if (this.stopped) return;
          }
          if (
            task.state === 'needs_input' &&
            (task.resumeState === 'fixing' || task.resumeState === 'needs_input') &&
            !task.fixingMergeConflict &&
            task.ref.provider === 'github'
          ) {
            try {
              await this.engine.recoverInterruptedFix(task.id, (t) =>
                this.workspaces.commitFix(t, 'Preserve review fixes before conflict resolution'),
              );
            } catch (error) {
              store.event(task.id, 'conflict.recovery_failed', { error: redact(String(error)) });
            }
            if (this.stopped) return;
          }
          if (
            task.state === 'needs_input' &&
            !staleConflictPreparation(task) &&
            (task.resumeState === 'reviewing' || task.resumeState === 'awaiting_push') &&
            task.ref.provider === 'github'
          ) {
            try {
              await this.engine.retryInterruptedStep(task.id);
            } catch (error) {
              store.event(task.id, 'review.recovery_failed', { error: redact(String(error)) });
            }
            if (this.stopped) return;
          } else if (
            [
              'awaiting_publication',
              'awaiting_push',
              'awaiting_checks',
              'awaiting_plan_approval',
              'reviewing',
              'fixing',
            ].includes(task.state) ||
            (staleConflictPreparation(task) && autoMergeEnabled(store, task))
          ) {
            if (task.ref.provider === 'github') {
              const active = store.activeJobs(task.id);
              // A queued job reads its pinned PR on admission. Do not poll its empty slot.
              if (active.length && active.every((job) => job.status === 'queued')) continue;
              const previous = this.githubPolls.get(task.id),
                at = Date.now();
              if (
                previous?.generation === task.generation &&
                previous.state === task.state &&
                at - previous.at < 4 * this.pollMs
              )
                continue;
              this.githubPolls.set(task.id, { state: task.state, generation: task.generation, at });
            }
            try {
              await this.engine.reconcile(task.id);
              if (this.stopped) return;
            } catch (error) {
              store.event(task.id, 'reconcile.failed', {
                error: redact(String(error)),
              });
            }
          }
        }
      }
      if (this.stopped) return;
      if (this.autoSubmit && resources.ok)
        for (const task of store.tasks()) {
          if (
            ((isTicket(task) &&
              (task.state === 'ready_for_review' ||
                (poll && retryConfirmedSubmission(store, task)))) ||
              (poll &&
                !isTicket(task) &&
                task.state === 'awaiting_push' &&
                task.pendingAuthorHead)) &&
            !store.busy(task.id) &&
            !githubWait(store, task.ref) &&
            !this.submitting.has(task.id)
          ) {
            this.submitting.add(task.id);
            const submission = this.autoSubmit(task.id).then(
              () => {},
              (error) => {
                store.event(task.id, 'ticket.submission_failed', { error: redact(String(error)) });
              },
            );
            this.pendingRuns.add(submission);
            this.track(task.id, submission);
            void submission.finally(() => {
              this.pendingRuns.delete(submission);
              this.submitting.delete(task.id);
            });
          }
        }
      for (const task of store.tasks())
        if (
          (task.state === 'queued' || (poll && task.state === 'awaiting_review_checks')) &&
          !store.busy(task.id) &&
          !githubWait(store, task.ref)
        ) {
          try {
            await this.engine.review(task.id);
            if (this.stopped) return;
          } catch (error) {
            if (error instanceof GitHubRetryError) continue;
            const current = store.getTask(task.id);
            if (
              current.generation === task.generation &&
              current.state === task.state &&
              !store.busy(current.id)
            ) {
              current.state = 'needs_input';
              current.reason = redact(String(error));
              store.saveTask(current);
              store.event(task.id, 'review.start_failed', { error: current.reason });
              store.event(task.id, 'task.state', { state: current.state, reason: current.reason });
            }
          }
        }
      if (this.stopped) return;
      for (const task of store.tasks())
        if (
          task.state === 'awaiting_publication' &&
          !(task.partialReview?.retryAt && task.partialReview.retryAt > Date.now()) &&
          !store.busy(task.id) &&
          !githubWait(store, task.ref)
        ) {
          try {
            await this.engine.publish(task.id);
            if (this.stopped) return;
          } catch (error) {
            if (error instanceof GitHubRetryError) continue;
            const current = store.getTask(task.id);
            if (
              current.generation === task.generation &&
              current.state === 'awaiting_publication' &&
              !store.busy(current.id)
            ) {
              if (
                current.partialReview &&
                error instanceof AppError &&
                [
                  'draft_unconfirmed',
                  'publication_unconfirmed',
                  'provider_unreachable',
                  'provider_500',
                  'provider_502',
                  'provider_503',
                  'provider_504',
                ].includes(error.code)
              ) {
                current.partialReview.retryAt = Date.now() + this.pollMs;
                store.saveTask(current);
                store.event(task.id, 'publication.deferred', { errorCode: error.code });
                continue;
              }
              current.state = 'needs_input';
              current.reason = redact(String(error));
              store.saveTask(current);
              store.event(task.id, 'publication.failed', { error: current.reason });
              store.event(task.id, 'task.state', {
                state: current.state,
                reason: current.reason,
                previousState: 'awaiting_publication',
              });
            }
          }
        }
      for (const task of store.tasks())
        if (task.deferredWorkerInstructions?.length && !store.busy(task.id))
          await this.engine.deliverWorkerInstruction(task.id);
      // Authors may be independent; each shared reviewer thread has one worker.
      reconcileWorkerPools(store);
      const limit = Math.max(
        1,
        Math.min(8, store.setting<number>('worker.maxAgents') ?? this.maxAgents),
      );
      while (!this.stopped && this.active.size < limit && this.resourceCheck().ok) {
        const job = store.claim(
          (candidate) =>
            !this.active.has(candidate.taskId) &&
            !githubWait(store, store.getTask(candidate.taskId).ref) &&
            (!candidate.groupId ||
              (() => {
                const group = store.getGroup(candidate.groupId!);
                if (
                  group.daddyState === 'paused' ||
                  group.daddyState === 'archived' ||
                  group.resourceWait?.state === 'repairing' ||
                  group.deletion
                )
                  return false;
                if (candidate.role === 'reviewer') return !this.reservedGroups.has(group.id);
                const task = store.getTask(candidate.taskId);
                if (
                  group.orchestrated &&
                  !selectWorker(
                    workerSlots(store, group),
                    group,
                    task,
                    group.worker ?? this.engine.defaultAgents().worker,
                  )
                )
                  return false;
                return (
                  candidate.kind === 'chat' ||
                  !(task.dependsOn ?? []).some((id) => store.getTask(id).state !== 'complete')
                );
              })()) &&
            !(
              candidate.role === 'reviewer' &&
              candidate.groupId &&
              [...this.runningJobs.values()].some(
                (active) => active.role === 'reviewer' && active.groupId === candidate.groupId,
              )
            ),
          (claimed) => {
            if (claimed.role === 'author' && claimed.groupId) {
              const group = store.getGroup(claimed.groupId);
              if (!group.orchestrated) return;
              const task = store.getTask(claimed.taskId);
              const slots = workerSlots(store, group);
              const slot = selectWorker(
                slots,
                group,
                task,
                group.worker ?? this.engine.defaultAgents().worker,
              );
              if (!slot) throw new AppError('worker_unavailable', 'No eligible worker is free');
              if (slot.taskId) return;
              slot.taskId = task.id;
              if (task.workerRequest) {
                const requestedSlot = task.workerRequest.slot;
                task.workerRequest.slot = undefined;
                if (task.workerRequest.profile) slot.profile = task.workerRequest.profile;
                const profile = slot.profile;
                if (
                  profile &&
                  (!sameAgentProfile(task.agents?.worker, profile) ||
                    (claimed.kind !== 'plan' && !sameAgentProfile(claimed.profile, profile)))
                ) {
                  if (claimed.kind !== 'plan') claimed.profile = profile;
                  this.engine.applyAuthorProfile(task, profile);
                  for (const job of store.activeJobs(task.id))
                    if (
                      job.id !== claimed.id &&
                      job.role === 'author' &&
                      job.kind !== 'plan' &&
                      job.status === 'queued' &&
                      job.generation === task.generation
                    )
                      store.saveJob({ ...job, profile });
                }
                if (requestedSlot || profile) store.saveTask(task);
              }
              saveWorkerSlots(store, group, slots);
            }
          },
        );
        if (job) {
          const running = this.run(job);
          this.pendingRuns.add(running);
          this.track(job.taskId, running);
          void running.finally(() => this.pendingRuns.delete(running));
        } else break;
      }
      if (poll && !this.stopped && resources.ok && !this.mergeRun) {
        const run = pollAutoMerge(this.engine, () => this.stopped)
          .catch((error) => {
            store.event('_system', 'automerge.error', { error: redact(String(error)) });
          })
          .finally(() => {
            this.mergeRun = undefined;
            this.pendingRuns.delete(run);
          });
        this.mergeRun = run;
        this.pendingRuns.add(run);
      }
    } finally {
      this.ticking = false;
      finishTick();
    }
  }
  private async run(job: Job) {
    const abort = new AbortController();
    this.active.set(job.taskId, abort);
    this.runningJobs.set(job.taskId, job);
    const store = this.engine.store;
    try {
      let task = store.getTask(job.taskId);
      const isolatedReview =
        job.kind === 'verify_merge' || (job.kind === 'review' && isTicket(task));
      const group = task.groupId ? store.getGroup(task.groupId) : undefined;
      if (job.role === 'reviewer' && group) {
        if (job.groupGeneration !== group.generation)
          throw new Error('The shared reviewer configuration changed before this job started');
        if (!isolatedReview) task.reviewerThreadId = group.reviewerThreadId;
      }
      if (!job.profile)
        throw new AppError(
          'agent_profile_missing',
          'The queued job has no frozen agent profile; queue a new turn',
        );
      delete job.error;
      delete job.errorCode;
      delete job.notBefore;
      delete job.finishedAt;
      store.saveJob(job);
      if (job.deferredResult) {
        await this.engine.completeJob(
          job,
          job.deferredResult,
          job.kind === 'fix' &&
            job.deferredResult.status === 'incomplete' &&
            !task.fixingMergeConflict
            ? (t) =>
                this.workspaces.commitFix(
                  t,
                  'Preserve review fixes before conflict resolution',
                  abort.signal,
                )
            : undefined,
        );
        delete job.deferredResult;
        job.status = 'completed';
        return;
      }
      const startingPR =
        isTicket(task) || (job.kind === 'review' && task.reviewAdmission)
          ? undefined
          : await this.engine.provider(prRef(task)).getPR(prRef(task));
      if (
        job.kind === 'fix' &&
        startingPR &&
        (!sameOpenTarget(task.pr, startingPR) ||
          task.pr?.targetCloneUrl !== startingPR.targetCloneUrl)
      )
        throw new AppError('stale_feedback', 'The PR branches changed before the author started');
      const revisingPlan = job.kind === 'plan' && !isTicket(task);
      if (job.kind === 'review' && startingPR && !sameOpenTarget(task.pr, startingPR)) {
        await this.engine.reconcile(task.id);
        job.status = 'cancelled';
        return;
      }
      if (
        revisingPlan &&
        startingPR &&
        (!sameOpenTarget(task.pr, startingPR) || !sameRevision(startingPR, task.revision))
      ) {
        await this.engine.reconcile(task.id);
        job.status = 'cancelled';
        return;
      }
      if (
        job.kind === 'review' &&
        startingPR &&
        (await this.engine.deferQueuedReview(job, startingPR))
      ) {
        job.status = 'cancelled';
        return;
      }
      if (
        startingPR &&
        !sameRevision(startingPR, task.revision) &&
        !(
          job.kind === 'fix' &&
          (await this.engine.fixCanContinueOnAdvancedBase(task, startingPR, job.timeoutRetry))
        )
      ) {
        if (
          job.kind === 'review' &&
          task.ref.provider === 'github' &&
          startingPR.head === task.revision?.head
        ) {
          const updated = await this.engine.reconcile(task.id);
          if (updated.generation !== job.generation) {
            job.status = 'cancelled';
            return;
          }
        }
        if (job.kind === 'fix' && job.timeoutRetry && task.fixingMergeConflict)
          throw new AppError(
            'conflict_target_changed',
            'The PR head or target history changed. The partial merge is preserved in the worker copy.',
          );
        throw new AppError(
          'stale_revision',
          'The PR changed before the queued job started. Reconcile and review the new revision.',
        );
      }
      if (
        job.kind === 'verify_merge' &&
        (startingPR?.state !== 'merged' ||
          !sameReviewTarget(task.pr, startingPR) ||
          startingPR.mergeCommit !== task.pr?.mergeCommit)
      )
        throw new AppError('merge_unconfirmed', 'The merged revision changed before verification');
      const repairingConflict = job.kind === 'fix' && task.fixingMergeConflict === true;
      const repairingCI = job.kind === 'fix' && sameRevision(task.ciRepairRevision, task.revision);
      if (repairingCI && startingPR && (await this.engine.skipObsoleteCIFix(job, startingPR))) {
        job.status = 'cancelled';
        return;
      }
      if (
        repairingConflict &&
        (!autoMergeEnabled(store, task) ||
          !startingPR ||
          !sameOpenTarget(task.pr, startingPR) ||
          startingPR.draft !== false)
      )
        throw new AppError(
          'conflict_repair_unavailable',
          'Check the PR branches and auto-merge setting before resuming conflict resolution.',
        );
      const demo = task.ref.provider === 'demo';
      const cwd = demo
        ? this.workspaces.dataDir
        : isTicket(task)
          ? await this.workspaces.prepareTicket(task, job.role, abort.signal)
          : await this.workspaces.prepare(task, revisingPlan ? 'reviewer' : job.role, abort.signal);
      if (task.kind === 'plan' && (job.kind === 'review' || job.kind === 'verify_merge')) {
        if (demo)
          task.planDocuments = [
            {
              path: 'plans/session-guard.md',
              body: '# Session generation guard\nCapture generation on dispatch and reject stale callbacks. Add a regression test for session replacement.',
            },
          ];
        else if (task.ref.provider === 'arcadia')
          task.planDocuments = await this.workspaces.arcPlanDocuments(task, cwd);
        else {
          const paths = (
            await git(
              [
                'diff',
                '--name-only',
                '--diff-filter=AM',
                '-z',
                `${task.revision!.base}...${task.revision!.head}`,
                '--',
                '*.md',
              ],
              cwd,
            )
          )
            .split('\0')
            .filter(Boolean);
          task.planDocuments = [];
          let total = 0;
          for (const path of paths) {
            const body = await git(['show', `${task.revision!.head}:${path}`], cwd);
            total += body.length;
            if (total > 300000)
              throw new Error(
                'Plan Markdown exceeds the 300 KB context limit; split the plan into smaller PRs.',
              );
            task.planDocuments.push({ path, body });
          }
        }
        if (!task.planDocuments?.length)
          throw new Error('A plan PR must contain changed Markdown documents.');
      }
      const prepared = task;
      task = store.getTask(job.taskId);
      if (task.generation !== job.generation || abort.signal.aborted)
        throw new AppError('run_cancelled', 'Task changed while its workspace was being prepared');
      task.authorWorktree = prepared.authorWorktree;
      task.authorBaseHead = prepared.authorBaseHead;
      task.reviewerWorktree = prepared.reviewerWorktree;
      task.planDocuments = prepared.planDocuments;
      task.arcWorkspaces = prepared.arcWorkspaces;
      if (isTicket(task)) task.revision = prepared.revision;
      if (job.role === 'reviewer' && group) task.reviewerThreadId = prepared.reviewerThreadId;
      store.saveTask(task);
      if (
        isTicket(task) &&
        task.planning &&
        job.kind === 'implement' &&
        !(await this.engine.checkImplementationPlan(job))
      ) {
        job.status = 'cancelled';
        return;
      }

      let preservedCopy: string | undefined;
      const conflictReview = repairingConflict ? this.engine.conflictPublication(task) : undefined;
      if (repairingConflict) {
        if (
          conflictReview &&
          startingPR &&
          !(await this.engine.publicationRevisionApplies(task, conflictReview.revision, startingPR))
        )
          throw new AppError(
            'stale_feedback',
            'Cannot confirm that the published review applies to the current target history. Findings awaiting verification: ' +
              (task.feedback?.comments.map((comment) => comment.id).join(', ') || 'none recorded'),
          );
        preservedCopy = await this.workspaces.prepareConflict(task, abort.signal);
      }
      if (job.kind === 'fix' && (!repairingCI || repairingConflict)) {
        const ref = prRef(task);
        const provider = this.engine.provider(ref);
        const handle = repairingConflict ? conflictReview : task.review;
        const actual = handle && (await provider.getReview(ref, handle));
        const freshPR = await provider.getPR(ref);
        if (
          (!repairingConflict && !handle) ||
          (handle &&
            (actual?.status !== 'published' ||
              actual.revision.head !== freshPR.head ||
              !sameRevision(actual.revision, handle.revision) ||
              (ref.provider === 'github' &&
                handle.authorId &&
                actual.authorId !== handle.authorId))) ||
          !sameOpenTarget(task.pr, freshPR) ||
          !sameReviewTarget(startingPR, freshPR) ||
          !sameRevision(startingPR, freshPR) ||
          freshPR.draft
        )
          throw new AppError(
            'stale_feedback',
            'The published review or PR changed before the author started; feedback was not released.',
          );
        task = store.getTask(job.taskId);
        if (task.generation !== job.generation || abort.signal.aborted)
          throw new AppError('run_cancelled', 'Task changed while feedback was being read');
        if (actual) {
          if (repairingConflict) {
            task.feedback = actual;
            task.conflictFeedbackReview = handle;
            store.saveTask(task);
            store.event(task.id, 'author.feedback_snapshot', actual, job.id);
          } else {
            if (!(await this.engine.admitReviewWork(job, actual, freshPR))) {
              job.status = 'cancelled';
              return;
            }
            task = store.getTask(job.taskId);
          }
        } else {
          // The stored feedback can belong to an earlier PR head.
          task.feedback = undefined;
        }
      } else if (revisingPlan) {
        const ref = prRef(task);
        const provider = this.engine.provider(ref);
        const actual = await provider.getReview(ref, task.review!);
        const pr = await provider.getPR(ref);
        if (abort.signal.aborted)
          throw new AppError('run_cancelled', 'Task changed while feedback was being read');
        if (!(await this.engine.admitReviewWork(job, actual, pr))) {
          job.status = 'cancelled';
          return;
        }
        task = store.getTask(job.taskId);
      }
      if (job.kind === 'verify_merge' && this.engine.heldMergeReviewId(task) && startingPR) {
        const publication = await this.engine.readHeldPublication(task, startingPR);
        const current = store.getTask(job.taskId);
        const currentGroup = current.groupId ? store.getGroup(current.groupId) : undefined;
        if (
          current.generation !== job.generation ||
          abort.signal.aborted ||
          (currentGroup &&
            (currentGroup.generation !== job.groupGeneration ||
              currentGroup.deletedAt ||
              currentGroup.deletion ||
              currentGroup.daddyState === 'paused' ||
              currentGroup.daddyState === 'archived'))
        ) {
          job.status = 'cancelled';
          return;
        }
        task = current;
        task.snapshot = publication.snapshot;
        store.saveTask(task);
      }
      let agentCwd = cwd;
      if (task.scope && !demo) {
        agentCwd = realpathSync(join(cwd, workspaceScope(task.scope)));
        if (!agentCwd.startsWith(realpathSync(cwd) + sep))
          throw new Error('The starting directory escaped its managed workspace');
      }
      const readOnlyWork =
        job.kind === 'plan' || (task.reportOnly && isTicket(task) && job.kind === 'implement');
      const tools = readOnlyWork
        ? []
        : job.kind === 'verify_merge'
          ? [reviewDecisionTool]
          : isolatedReview
            ? []
            : isTicket(task)
              ? dynamicTools
              : [...dynamicTools, reviewDecisionTool];
      let unconfirmedTools: { name: string; args: unknown; error: GitHubRetryError }[] = [];
      const forgetRetry = (name: string, args: unknown) => {
        unconfirmedTools = unconfirmedTools.filter(
          (tool) => tool.name !== name || !isDeepStrictEqual(tool.args, args),
        );
      };
      if (
        job.kind === 'review' &&
        task.reviewAdmission &&
        !(await this.engine.checkInitialGitHubDraft(job))
      ) {
        job.status = 'cancelled';
        return;
      }
      if (abort.signal.aborted) {
        job.status = 'cancelled';
        return;
      }
      const result = await (demo ? this.demoRuntime : this.liveRuntime).run({
        task,
        job,
        cwd: agentCwd,
        ...(readOnlyWork && { execution: 'sandbox' as const }),
        readPaths: demo
          ? []
          : [
              ...(this.workspaces.readPaths?.(task) ?? []),
              ...(preservedCopy ? [preservedCopy] : []),
            ],
        prompt: buildContext(store, task, job, [
          preservedCopy &&
            `Earlier uncommitted work is preserved at ${preservedCopy}. Inspect its Git diff and untracked files. Reconcile relevant changes with the current merge in your active checkout, leave unrelated files in the preserved copy, and account for the earlier work in your report.`,
          job.kind === 'review' &&
            task.draftRecheck &&
            `The target branch advanced. Independently recheck each remaining draft finding (${task.draftRecheck.commentIds.join(', ')}). For every finding still valid, call edit_comment with its native ID and the verified text (omit the service marker). Remove obsolete findings with a reason. Call set_summary with your current assessment. Publication waits for these checks.`,
        ]),
        signal: abort.signal,
        tools,
        onSession: (threadId, turnId) => {
          const current = store.getTask(job.taskId);
          if (current.generation !== job.generation || abort.signal.aborted) return;
          if (job.role === 'reviewer' && current.groupId) {
            const shared = store.getGroup(current.groupId);
            if (shared.generation !== job.groupGeneration) return;
            if (!isolatedReview) {
              if (shared.reviewerThreadId && shared.reviewerThreadId !== threadId)
                throw new Error('The shared reviewer returned a different thread identity');
              shared.reviewerThreadId = threadId;
              store.saveGroup(shared);
            }
          }
          if (
            job.role === 'author' &&
            job.kind !== 'plan' &&
            current.agents?.worker &&
            current.agents.worker.engine !== job.profile?.engine
          )
            return;
          if (job.kind === 'plan' && current.planning) {
            const planning = current.planning;
            // A pre-upgrade planner-only thread still serves its clarifications.
            planning.sharedThread =
              threadId === current.authorThreadId ||
              threadId !== planning.threadId ||
              planning.sharedThread === true;
            planning.threadId = threadId;
            if (planning.sharedThread && current.agents?.worker.engine === job.profile?.engine)
              current.authorThreadId = threadId;
          } else if (job.role === 'author') current.authorThreadId = threadId;
          else current.reviewerThreadId = threadId;
          store.saveTask(current);
          job.threadId = threadId;
          job.turnId = turnId;
          store.saveJob(job);
          store.event(
            job.taskId,
            'session.attached',
            { role: job.role, threadId, turnId, profile: job.profile, groupId: job.groupId },
            job.id,
          );
        },
        onEvent: (type, data) => store.event(job.taskId, type, redactEvent(data), job.id),
        onTool: async (name, args, callId) => {
          try {
            if (abort.signal.aborted)
              throw new AppError('run_cancelled', 'Run is no longer active');
            if (name === reviewDecisionTool.name) {
              if (!tools.includes(reviewDecisionTool))
                throw new AppError(
                  'role_forbidden',
                  'Decision history is unavailable to this run',
                  403,
                );
              return this.engine.broker.readDecisions(job, task, args);
            }
            const value = await this.engine.broker.call(job, name, args, callId);
            if (unconfirmedTools.length) forgetRetry(name, args);
            return value;
          } catch (error) {
            if (job.kind === 'review' && error instanceof GitHubRetryError) {
              forgetRetry(name, args);
              unconfirmedTools.push({ name, args: structuredClone(args), error });
            }
            throw error;
          }
        },
      });
      // The model may already have retried the exact operation during this turn.
      const pendingRetry = unconfirmedTools.at(-1);
      if (pendingRetry) throw pendingRetry.error;
      // Finish recording any saved commit before considering a forced model switch.
      if (job.role === 'author') this.finalizing.add(job.id);
      task = store.getTask(job.taskId);
      if (
        !abort.signal.aborted &&
        task.generation === job.generation &&
        isTicket(task) &&
        job.kind === 'implement' &&
        !task.reportOnly &&
        result.status === 'completed' &&
        result.checkedHead === task.revision?.head
      ) {
        const head = demo
          ? job.id.replaceAll('-', '').padEnd(40, '0')
          : await this.workspaces.commitTicket(
              task,
              `${task.source?.key ?? 'Ticket'}: implement requirements`,
              abort.signal,
            );
        const latest = store.getTask(task.id);
        if (latest.generation === job.generation && !abort.signal.aborted) {
          latest.pendingAuthorHead = head;
          store.saveTask(latest);
        }
      }
      if (!abort.signal.aborted) {
        if (
          demo &&
          job.kind === 'fix' &&
          result.status === 'completed' &&
          !result.disputedCommentIds?.length &&
          result.checkedHead === task.revision?.head &&
          task.generation === job.generation
        )
          await new DemoProvider(store).advance(prRef(task));
        const saveFix =
          !demo && job.kind === 'fix'
            ? (current: Task) =>
                this.workspaces.commitFix(
                  current,
                  repairingConflict
                    ? 'Resolve conflict with the target branch'
                    : repairingCI
                      ? 'Fix failing CI'
                      : `Address review feedback (round ${current.round})`,
                  abort.signal,
                )
            : undefined;
        try {
          await this.engine.completeJob(job, result, saveFix);
        } catch (error) {
          if (error instanceof GitHubRetryError) job.deferredResult = result;
          throw error;
        }
      }
      job.status = abort.signal.aborted ? 'cancelled' : 'completed';
    } catch (error) {
      const capacity =
        error instanceof AppError && error.code === 'workspace_capacity' && !abort.signal.aborted;
      const quota = error instanceof GitHubRetryError && !abort.signal.aborted;
      job.status = capacity || quota ? 'queued' : abort.signal.aborted ? 'cancelled' : 'failed';
      job.error = redact(String(error));
      if (error instanceof AppError) job.errorCode = error.code;
      if (quota) job.notBefore = new Date(error.until).toISOString();
      else if (capacity) job.notBefore = new Date(Date.now() + 30000).toISOString();
      else if (!abort.signal.aborted) this.engine.failJob(job, error);
    } finally {
      if (
        job.role === 'reviewer' ||
        (job.kind === 'plan' && !isTicket(store.getTask(job.taskId)))
      ) {
        const task = store.getTask(job.taskId);
        if (task.groupId && task.ref.provider === 'arcadia' && task.arcWorkspaces?.reviewer) {
          try {
            await this.workspaces.releaseArc(task, 'reviewer');
            const latest = store.getTask(task.id);
            latest.arcWorkspaces = task.arcWorkspaces;
            latest.reviewerWorktree = undefined;
            store.saveTask(latest);
          } catch (error) {
            store.event(
              task.id,
              'reviewer.workspace_preserved',
              { error: redact(String(error)) },
              job.id,
            );
          }
        }
      }
      job.finishedAt = now();
      store.saveJob(job);
      store.event(job.taskId, `job.${job.status}`, { kind: job.kind, error: job.error }, job.id);
      this.active.delete(job.taskId);
      this.runningJobs.delete(job.taskId);
      this.finalizing.delete(job.id);
    }
  }
  async stop() {
    this.stopped = true;
    clearInterval(this.timer);
    for (const id of this.active.keys())
      await this.engine.interruptTask(
        id,
        'The service stopped during this run. Inspect the saved work and resume or retry.',
        'service.interrupted',
      );
    for (const abort of this.active.values()) abort.abort();
    await this.tickDone;
    await Promise.allSettled([...this.pendingRuns]);
  }
}
