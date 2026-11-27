import { githubReviewIdFromUrl } from '../providers/github.js';
import { findingVersion } from './review-decisions.js';
import { attestReviewLesson, savePublishedLesson } from './review-lessons.js';
import { feedbackFingerprint, repeatedReviewFindings } from './review-recovery.js';
import { nativeReviewInstruction } from './instructions.js';
import {
  nextPrAction,
  needsReviewChecks,
  completionGate,
  hasReleasedReview,
  sameOpenTarget,
  samePullRequestTarget,
  staleConflictPreparation,
  type PrAction,
  type PrEvidence,
} from './pr-routing.js';
import { disputedFindings, draftInspectionRequired, draftSyncPending } from './task-activity.js';
import { GitHubRetryError, legacyQuotaRead } from '../providers/github-quota.js';
import { randomUUID, createHash } from 'node:crypto';
import { Store } from './store.js';
import { Broker } from './broker.js';
import { autoMergeEnabled, autoMergeRequested, pendingMerge } from './auto-merge.js';
import {
  AppError,
  assertTaskVersion,
  type ExpectedTask,
  requestsHumanInput,
  prRef,
  isTicket,
  type AgentProfiles,
  type AgentProfile,
  type Revision,
  type ReviewGroup,
  type ReviewHandle,
  type ReviewRecovery,
  type ReviewSnapshot,
  type TicketSource,
  type TicketRef,
  type PRTask,
  type PullRequest,
  defaultPolicy,
  now,
  sameRevision,
  sameAgentProfile,
  revisionOf,
  type Task,
  type PRRef,
  type State,
  type Policy,
  type Job,
  type FixSave,
  type AgentResult,
  type Workspace,
  type WorkerRequest,
} from './types.js';
import type { ReviewProvider } from '../providers/provider.js';
import { redact } from './security.js';
import { inheritedProfiles } from './agents.js';

const interruptedSubmission =
  'PR submission was interrupted. Submit again to reconcile its native result before retrying.';
const reviewRetryInstruction =
  'Continue the interrupted review. Re-read the native draft and previous decisions; do not recreate deleted comments.';
const clarifiedReviewPrefix =
  reviewRetryInstruction +
  '\nClarification from the session coordinator; verify it against the task: ';
const resumedProviderState = 'Resumed by the user; current provider state will be reconciled';
const mismatchedDraftRevision = 'Review points to a different revision';
const staleNativeDraft =
  'PR changed while a draft existed. Inspect or discard the stale native draft before starting the next review.';
const oldReviewStartLimit = 'Review round limit reached';
const oldPublishedReviewLimit =
  'Review round limit reached; inspect the remaining published findings';

const noFixChanges =
  'Author made no code changes; independent verification of the decisions is next';

function confirmationDeadline() {
  // Allow several scheduler polls for the host's PR API to catch up with Git.
  return new Date(Date.now() + 120_000).toISOString();
}

function unconfirmedFix(head: string, remote: string) {
  return `Submission of saved fix ${head} is unconfirmed; the PR still shows ${remote}. Inspect the outcome and resume to retry this exact commit.`;
}

const interruptedByRestart =
  'Server restarted during this run. Its external effects must be reconciled before retry.';
function restartInterrupted(task: Task, job: Job) {
  return (
    job.status === 'failed' &&
    job.generation + 1 === task.generation &&
    job.error === interruptedByRestart &&
    task.reason === interruptedByRestart
  );
}
export function confirmedSupersededDraft(task: Task) {
  return (
    task.ref.provider === 'github' &&
    task.state === 'needs_input' &&
    !!task.review &&
    !!task.pendingFix &&
    !!task.pendingAuthorHead &&
    task.pendingAuthorHead === task.revision?.head &&
    task.review.revision.head !== task.pendingAuthorHead &&
    task.reason ===
      `Saved fix ${task.pendingAuthorHead} is on the PR. Inspect the earlier draft review ${task.review.id} before starting another review.`
  );
}

type FindingEvidence = Pick<
  Job,
  | 'kind'
  | 'publishedFindingReview'
  | 'publishedFindingReviews'
  | 'reviewFindingIds'
  | 'findingVersions'
  | 'mergeFindingVersions'
>;

export class Engine {
  readonly broker: Broker;
  private locks = new Map<string, Promise<unknown>>();
  readFixSave?: (task: Task, save: FixSave) => Promise<string>;
  onCancel: (id: string) => void = () => {};
  constructor(
    readonly store: Store,
    readonly provider: (ref: PRRef) => ReviewProvider,
    defaults?: AgentProfiles,
  ) {
    this.broker = new Broker(store, provider);
    if (!store.setting('agents.defaults'))
      store.setSetting('agents.defaults', defaults ?? inheritedProfiles());
  }
  async lock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(fn);
    this.locks.set(id, next);
    try {
      return await next;
    } finally {
      if (this.locks.get(id) === next) this.locks.delete(id);
    }
  }
  async create(input: {
    ref: PRRef;
    requirements: string;
    repoPath: string;
    title?: string;
    kind?: 'plan' | 'code';
    policy?: Partial<Policy>;
    planTaskId?: string;
    authorThreadId?: string;
    agents?: AgentProfiles;
    groupId?: string;
    workspaceId?: string;
    scope?: string;
    workspaceIsolation?: Workspace['copyMode'];
    createdByAction?: string;
    groupGeneration?: number;
  }) {
    const pr = await this.provider(input.ref).getPR(input.ref);
    if (pr.state !== 'open')
      throw new AppError('pr_closed', 'Only open pull requests can be attached');
    if (this.store.tasks().some((t) => t.ref.url === input.ref.url && t.state !== 'complete'))
      throw new AppError('already_attached', 'This PR is already attached to an active task');
    if (
      input.authorThreadId &&
      this.store
        .tasks()
        .some(
          (t) =>
            t.authorThreadId === input.authorThreadId ||
            t.reviewerThreadId === input.authorThreadId,
        )
    )
      throw new AppError('thread_in_use', 'This agent context is already assigned to another task');
    const group = input.groupId ? this.store.getGroup(input.groupId) : undefined;
    if (group?.deletedAt || group?.deletion)
      throw new AppError('session_deleting', 'This session is being deleted');
    if (group && input.groupGeneration !== undefined && group.generation !== input.groupGeneration)
      throw new AppError(
        'stale_daddy',
        'The daddy session changed while the pull request was being attached',
      );
    const task: PRTask = {
      id: randomUUID(),
      title: input.title || pr.title,
      requirements: input.requirements,
      kind: input.kind ?? 'code',
      ref: input.ref,
      repoPath: input.repoPath,
      state: 'queued',
      reason: 'Ready for independent review',
      policy: { ...defaultPolicy, ...input.policy },
      generation: 1,
      contextVersion: 1,
      round: 0,
      noProgress: 0,
      summary: '',
      createdAt: now(),
      updatedAt: now(),
      pr,
      revision: revisionOf(pr),
      authorThreadId: input.authorThreadId,
      planTaskId: input.planTaskId,
      groupId: group?.id,
      workspaceId: input.workspaceId ?? group?.workspaceId,
      scope: input.scope,
      workspaceIsolation: input.workspaceIsolation ?? group?.workspace?.copyMode,
      createdByAction: input.createdByAction,
      agents: {
        ...this.defaultAgents(),
        ...(group?.worker ? { worker: group.worker } : {}),
        ...input.agents,
        ...(group ? { daddy: group.daddy } : {}),
      },
      workerRequest: group?.orchestrated ? { profile: input.agents?.worker } : undefined,
    };
    if (input.planTaskId) {
      const plan = this.store.getTask(input.planTaskId);
      if (plan.kind !== 'plan' || plan.state !== 'complete' || !plan.approvedAt || !plan.revision)
        throw new AppError(
          'plan_unapproved',
          'The linked plan must be reviewed and approved first',
        );
      if (!plan.planDocuments?.length)
        throw new AppError(
          'plan_content_missing',
          'The approved plan has no saved Markdown documents',
        );
      task.approvedPlan = {
        taskId: plan.id,
        head: plan.revision.head,
        contextVersion: plan.contextVersion,
        requirements: plan.requirements,
        documents: plan.planDocuments,
      };
    }
    this.store.transaction(() => {
      if (group && !group.rootTaskId) {
        group.rootTaskId = task.id;
        this.store.saveGroup(group);
      }
      this.store.saveTask(task);
      this.store.event(task.id, 'task.created', {
        kind: task.kind,
        ref: prRef(task),
        policy: task.policy,
      });
    });
    return task;
  }
  private state(task: Task, state: State, reason: string, request?: Job, reviewDispute?: 'daddy') {
    task.inputRequest = request
      ? { runId: request.id, role: request.role, generation: task.generation, reviewDispute }
      : undefined;
    const previousState = task.state;
    task.state = state;
    task.reason = reason;
    this.store.saveTask(task);
    this.store.event(task.id, 'task.state', {
      state,
      previousState,
      reason,
      generation: task.generation,
      head: task.revision?.head,
    });
  }
  async review(id: string, retry = false, clarification?: string) {
    return this.lock(id, async () => {
      const task = this.store.getTask(id);
      const entryGeneration = task.generation;
      if (this.store.busy(id))
        throw new AppError('task_busy', 'Wait for the active session or pause it first');
      if (task.state === 'paused')
        throw new AppError('task_paused', 'Resume this task before starting a review');
      if (this.reviewWaitingForResources(task)) return task;
      if (task.draftStart && !this.currentReviewStart(task)) return task;
      if (task.partialReview && task.state === 'awaiting_publication')
        throw new AppError('publication_pending', 'The recorded findings are being published.');
      if (isTicket(task)) {
        if (
          !sameRevision(task.workerReport?.revision, task.revision) ||
          !(task.state === 'queued' || (retry && task.state === 'needs_input'))
        )
          throw new AppError(
            'report_not_ready',
            'Wait for a worker report on the current task revision before reviewing',
          );
        this.store.transaction(() => this.queueReportReview(task));
        return task;
      }
      const fixPending =
        task.fixSave ||
        (task.pendingFix && task.pendingAuthorHead !== task.revision?.head) ||
        task.state === 'awaiting_push';
      if (fixPending && (!retry || task.fixSave))
        throw new AppError('fix_pending', this.fixPendingReason(task));
      const provider = this.provider(prRef(task));
      if (!retry && task.draftStart?.retryAt && task.draftStart.retryAt > Date.now()) return task;
      if (task.state === 'awaiting_review_checks' && task.review) retry = true;
      const pr = await provider.getPR(prRef(task));
      if (retry && pr.state === 'merged') return this.queueMergeVerification(task, pr);
      if (fixPending) throw new AppError('fix_pending', this.fixPendingReason(task));
      if (task.draftStart?.retryAt && task.draftStart.retryAt > Date.now()) return task;
      if (task.draftStart) {
        if (task.draftStart.retry) retry = true;
        clarification ??= task.draftStart.clarification;
        if (
          !sameRevision(task.draftStart.revision, pr) ||
          !sameOpenTarget(task.pr, pr) ||
          pr.draft ||
          (pr.checks === 'failing' && needsReviewChecks(task, pr)) ||
          this.prAction(task, pr).kind === 'repair'
        ) {
          return this.settleMovedDraftStart(task, pr, provider);
        }
      }
      if (confirmedSupersededDraft(task)) {
        if (pr.head !== task.pendingAuthorHead || !sameOpenTarget(task.pr, pr)) {
          this.holdSavedFix(task, pr);
          return task;
        }
        if (!(await this.retireSupersededDraft(task, provider))) return task;
        this.invalidate(task, pr);
        task.pendingFix = undefined;
      }
      if (task.pendingFix && (!sameRevision(task.revision, pr) || !sameOpenTarget(task.pr, pr))) {
        await this.checkSavedFix(task, pr);
        return task;
      }
      if (pr.state !== 'open') throw new AppError('pr_closed', 'The PR is closed');
      if (await this.advancePublishedReview(task, pr)) return task;
      const action = this.prAction(task, pr);
      if (action.kind === 'publish-review')
        throw new AppError('publication_pending', 'The recorded review is being published.');
      if (
        action.kind === 'confirm-merge' ||
        action.kind === 'confirm-fix' ||
        action.kind === 'continue-repair'
      )
        return task;
      if (action.kind === 'target-changed' || action.kind === 'inspect-repair')
        throw new AppError(
          'stale_revision',
          'The PR branches changed. Inspect the task before restarting review.',
        );
      if (action.kind === 'repair') {
        await this.applyRepair(task, pr, action);
        return task;
      }
      if (
        task.review &&
        sameRevision(task.revision, pr) &&
        !sameRevision(task.review.revision, pr)
      ) {
        if (retry && (await this.resumeReviewAfterResourcePause(task, pr, clarification)))
          return task;
        const previous = await provider.getReview(prRef(task), task.review);
        if (previous.status === 'draft' || previous.status === 'partial')
          throw new AppError(
            'stale_draft',
            `Inspect the earlier draft review ${task.review.id} before reviewing ${pr.head}.`,
          );
        this.invalidate(task, pr);
      }
      const changed = !sameRevision(task.revision, pr);
      if (
        changed &&
        task.ref.provider === 'github' &&
        task.review &&
        task.snapshot?.status !== 'published'
      ) {
        await this.changeReviewRevision(task, pr, retry ? clarification : undefined);
        return task;
      }
      if (changed) this.invalidate(task, pr);
      if (retry && task.review) {
        const snapshot = await this.readReviewForReconciliation(task);
        if (!snapshot) return task;
        if (snapshot.status === 'published') this.setFeedback(task, snapshot);
        if (snapshot.status === 'published' || snapshot.status === 'missing')
          this.invalidate(task, pr);
      }
      if (task.review && !retry && !changed)
        throw new AppError(
          'review_exists',
          'This revision already has a review. Discuss it or use retry to continue an interrupted run.',
        );
      task.pr = pr;
      task.revision = revisionOf(pr);
      if (needsReviewChecks(task, pr)) {
        if (clarification?.trim()) this.rememberClarification(task, clarification);
        await this.holdReviewForChecks(task, pr);
        return task;
      }
      if (!task.review && !task.draftStart) {
        if (task.reviewRoundLimit !== undefined && task.round >= task.reviewRoundLimit) {
          task.resumeState = 'queued';
          this.store.transaction(() => {
            this.state(task, 'paused', 'This task reached its review round limit');
            this.store.event(task.id, 'review.limit_reached', {
              limit: task.reviewRoundLimit,
              round: task.round,
            });
          });
          return task;
        }
        task.round++;
      }
      const parked =
        task.reviewAfterChecks ??
        (task.reviewChecksJob && this.store.jobs(id).find((j) => j.id === task.reviewChecksJob));
      delete task.ciRepairRevision;
      if (!task.review && task.ref.provider === 'github') {
        if (!task.draftStart) {
          const latest = this.store.getTask(id);
          const group = latest.groupId ? this.store.getGroup(latest.groupId) : undefined;
          if (
            latest.generation !== entryGeneration ||
            latest.state === 'paused' ||
            group?.deletedAt ||
            group?.deletion ||
            group?.daddyState === 'paused' ||
            group?.daddyState === 'archived'
          )
            return latest;
          task.draftStart = {
            marker: `daddyloop:${task.id}:${task.generation}:${task.round}`,
            revision: task.revision,
            retry,
            clarification,
          };
          this.state(task, 'queued', 'Preparing the GitHub review draft');
        }
        try {
          await this.broker.ensureReview(task);
        } catch (error) {
          if (!this.currentReviewStart(task)) return this.store.getTask(id);
          if (
            error instanceof AppError &&
            (error instanceof GitHubRetryError ||
              /^(?:provider_(?:408|500|502|503|504)|provider_unreachable|draft_creation_race|draft_create_unconfirmed|draft_revision_changed)$/.test(
                error.code,
              ))
          ) {
            const delay = Math.min(300000, (task.draftStart.delay ?? 7500) * 2);
            task.draftStart.delay = delay;
            task.draftStart.retryAt = Math.max(
              Date.now() + delay,
              error instanceof GitHubRetryError ? error.until : 0,
            );
            this.state(task, 'queued', 'Waiting to retry the GitHub review draft');
            this.store.event(id, 'review.create_deferred', {
              marker: task.draftStart.marker,
              code: error.code,
              retryAt: task.draftStart.retryAt,
            });
            return task;
          }
          this.state(task, 'needs_input', redact(String(error)));
          throw error;
        }
        if (!this.currentReviewStart(task)) return this.store.getTask(id);
        delete task.draftStart;
      } else await this.broker.ensureReview(task);
      task.reviewFinished = false;
      this.store.transaction(() => {
        task.pendingFix = undefined;
        if (clarification?.trim()) this.rememberClarification(task, clarification);
        const input =
          clarification?.trim() && retry
            ? clarifiedReviewPrefix + clarification.trim()
            : parked
              ? parked.input
              : retry
                ? reviewRetryInstruction
                : nativeReviewInstruction(task);
        this.queueNativeReview(task, pr, `Independent review, round ${task.round}`, {
          input,
          freshContextRetry: parked ? parked.freshContextRetry : undefined,
          timeoutRetry: parked ? parked.timeoutRetry : undefined,
        });
      });
      return task;
    });
  }
  // Admission runs again for review jobs restored from a pause or queued before CI changed.
  async deferQueuedReview(job: Job, pr: PullRequest) {
    return this.lock(job.taskId, async () => {
      const task = this.store.getTask(job.taskId);
      if (task.generation !== job.generation || task.state === 'paused') return true;
      if (!sameOpenTarget(task.pr, pr) || task.revision?.head !== pr.head) return false;
      if (
        autoMergeEnabled(this.store, task) &&
        pr.draft === false &&
        pr.mergeConflict &&
        (await this.stageReviewFindings(
          task,
          job,
          {
            status: 'incomplete',
            checkedHead: pr.head,
            summary: 'GitHub reported a merge conflict before independent review could start.',
          },
          pr,
        ))
      ) {
        job.errorCode = 'review_admission_changed';
        return true;
      }
      if (!needsReviewChecks(task, pr)) return false;
      this.store.transaction(() => {
        if (sameRevision(task.revision, pr)) task.pr = pr;
        task.reviewAfterChecks = {
          input: job.input,
          freshContextRetry: job.freshContextRetry,
          timeoutRetry: job.timeoutRetry,
        };
        this.parkForCI(task, job);
      });
      return true;
    });
  }
  async skipObsoleteCIFix(job: Job, pr: PullRequest) {
    return this.lock(job.taskId, async () => {
      const task = this.store.getTask(job.taskId);
      if (task.generation !== job.generation || task.state === 'paused') return true;
      if (
        !sameRevision(task.ciRepairRevision, pr) ||
        !sameOpenTarget(task.pr, pr) ||
        pr.checks === 'failing' ||
        job.firstAttemptId
      )
        return false;
      this.store.transaction(() => {
        delete task.ciRepairRevision;
        this.parkForCI(task, job);
      });
      return true;
    });
  }
  private parkForCI(task: Task, job: Job) {
    job.status = 'cancelled';
    job.finishedAt = now();
    job.errorCode = 'review_admission_changed';
    this.store.saveJob(job);
    this.state(task, 'awaiting_review_checks', 'Waiting for CI results before review');
  }
  private async holdReviewForChecks(task: Task, pr: PullRequest) {
    task.pr = pr;
    if (task.pendingAuthorHead === pr.head) task.pendingFix = undefined;
    if (pr.checks === 'failing' && !sameRevision(task.ciRepairRevision, pr)) {
      // Release recorded findings through the normal publication path before changing their head.
      if (task.review && task.ref.provider === 'github') {
        const snapshot = await this.provider(prRef(task)).getReview(prRef(task), task.review);
        const reviewer = this.store
          .jobs(task.id)
          .filter((j) => j.kind === 'review')
          .at(-1);
        if (
          reviewer &&
          (snapshot.comments.length ||
            (pr.mergeConflict && !this.draftHasWork(task.review, snapshot))) &&
          (await this.stageReviewFindings(
            task,
            reviewer,
            {
              checkedHead: pr.head,
              status: 'incomplete',
              summary: 'CI failed before independent review could continue.',
            },
            pr,
          ))
        )
          return;
        if (!(await this.retireSupersededDraft(task, this.provider(prRef(task))))) return;
        task.review = undefined;
        task.snapshot = undefined;
        task.draftRecheck = undefined;
      }
      this.store.transaction(() => {
        task.ciRepairRevision = revisionOf(pr);
        task.resumeState = 'fixing';
        this.state(task, 'fixing', 'Worker assigned to fix failing CI');
        this.store.enqueue(
          task,
          'author',
          'fix',
          'Inspect the failing CI checks on the pinned commit, fix the underlying cause and run the affected tests. The service will submit the fix and wait for CI before independent review.',
        );
      });
      return;
    }
    const reason =
      pr.checks === 'missing'
        ? 'Waiting for CI results before review'
        : pr.checks === 'failing'
          ? 'Waiting for CI to pass after the worker investigated'
          : 'Waiting for CI to finish before review';
    if (task.state !== 'awaiting_review_checks' || task.reason !== reason)
      this.state(task, 'awaiting_review_checks', reason);
    else this.store.saveTask(task);
  }
  private async settleMovedDraftStart(task: Task, pr: PullRequest, provider: ReviewProvider) {
    if (
      task.pendingFix &&
      (pr.head !== task.pendingAuthorHead || !sameOpenTarget(task.pr, pr) || pr.draft)
    ) {
      this.holdSavedFix(task, pr);
      return task;
    }
    // Settle the old intent before routing the new revision. Never replay an old POST.
    const intent = task.draftStart!;
    const existing = await provider.findReview(prRef(task), intent.marker);
    if (!this.currentReviewStart(task)) return this.store.getTask(task.id);
    if (existing) {
      if (
        existing.revision.head !== intent.revision.head ||
        (intent.owner && existing.authorId !== intent.owner)
      )
        throw new AppError('draft_changed', 'The marked review belongs to a different commit.');
      const handle = { ...existing, revision: intent.revision };
      task.review = await this.broker.outbox.perform(
        task.id,
        intent.marker,
        intent.revision,
        async () => handle,
        async () => ({ found: true, value: handle }),
      );
      task.snapshot = await provider.getReview(prRef(task), task.review);
      if (!this.currentReviewStart(task)) return this.store.getTask(task.id);
      if (
        task.snapshot.status !== 'draft' ||
        task.snapshot.authorId !== existing.authorId ||
        task.snapshot.comments.length ||
        task.snapshot.body !== `Review in progress.\n\n<!-- ${intent.marker} -->`
      ) {
        delete task.draftStart;
        task.resumeState = 'reviewing';
        this.state(task, 'needs_input', draftInspectionRequired);
        return task;
      }
      if (
        sameOpenTarget(task.pr, pr) &&
        pr.draft === false &&
        intent.revision.head === pr.head &&
        this.prAction(task, pr).kind !== 'repair'
      ) {
        const draft = task.snapshot;
        this.store.transaction(() => {
          delete task.draftStart;
          if (intent.clarification) this.rememberClarification(task, intent.clarification);
          this.restartNativeReview(
            task,
            pr,
            draft,
            'The target branch advanced. Reviewing the updated change.',
          );
        });
        return task;
      }
      // This verified empty placeholder may be retired using the normal guarded operation.
      if (!(await this.retireSupersededDraft(task, provider))) return task;
    }
    if (!this.currentReviewStart(task)) return this.store.getTask(task.id);
    delete task.draftStart;
    task.review = undefined;
    task.snapshot = undefined;
    if (!sameOpenTarget(task.pr, pr) || pr.draft) {
      this.state(
        task,
        'needs_input',
        'The PR is closed, a draft or its branches changed. Inspect it before starting review.',
      );
      return task;
    }
    this.invalidate(task, pr);
    this.state(task, 'queued', 'New revision is ready for review');
    return task;
  }
  private currentReviewStart(task: Task) {
    const current = this.store.getTask(task.id);
    const group = task.groupId ? this.store.getGroup(task.groupId) : undefined;
    return (
      current.generation === task.generation &&
      current.state !== 'paused' &&
      current.draftStart?.marker === task.draftStart?.marker &&
      !group?.deletedAt &&
      !group?.deletion &&
      group?.daddyState !== 'paused' &&
      group?.daddyState !== 'archived'
    );
  }
  private knownDraftSummary(taskId: string, handle: ReviewHandle, body: string) {
    const suffix = `\n\n<!-- ${handle.marker} -->`;
    const digest = createHash('sha256')
      .update(JSON.stringify({ body: body.slice(0, -suffix.length) }))
      .digest('hex');
    return (
      body === 'Review in progress.' + suffix ||
      (body.endsWith(suffix) &&
        this.store.db
          .prepare(
            "SELECT 1 FROM operations WHERE task_id=? AND id GLOB ? AND request=? AND status='done'",
          )
          .get(taskId, handle.marker + ':*:set_summary:*', digest))
    );
  }
  private recordedDraft(task: Task, draft: ReviewSnapshot) {
    const handle = task.review!;
    if (
      !handle.authorId ||
      draft.authorId !== handle.authorId ||
      !this.knownDraftSummary(task.id, handle, draft.body)
    )
      return false;
    const receipt = this.store.db.prepare(
      "SELECT 1 FROM operations WHERE task_id=? AND (id GLOB ? OR id GLOB ?) AND status='done' AND json_extract(result,'$.id')=? AND json_extract(result,'$.body')=?",
    );
    return draft.comments.every((comment) =>
      receipt.get(
        task.id,
        handle.marker + ':comment:*',
        handle.marker + ':*:edit_comment:*',
        comment.id,
        comment.body,
      ),
    );
  }
  private matchesLatestDraftWrites(task: Task, draft: ReviewSnapshot) {
    const handle = task.review!;
    if (!handle.authorId || draft.authorId !== handle.authorId) return false;
    const prefix = handle.marker + ':';
    const writes = this.store.db
      .prepare(
        `WITH confirmations AS MATERIALIZED (
           SELECT json_extract(data,'$.operationId') AS operation_id, MAX(id) AS confirmed
           FROM events
           WHERE task_id=? AND type IN ('operation.completed','operation.recovered')
           GROUP BY operation_id
         )
         SELECT o.id, o.request, o.result, c.confirmed
         FROM operations o LEFT JOIN confirmations c ON c.operation_id=o.id
         WHERE o.task_id=? AND o.status='done' AND
           (o.id GLOB ? OR o.id GLOB ? OR o.id GLOB ? OR o.id GLOB ?)
         ORDER BY c.confirmed`,
      )
      .all(
        task.id,
        task.id,
        prefix + 'comment:*',
        prefix + '*:edit_comment:*',
        prefix + '*:remove_comment:*',
        prefix + '*:set_summary:*',
      );
    const comments = new Map<string, string>();
    let summaryRequest: string | undefined;
    let legacyRemovals: Map<string, string> | undefined;
    for (const write of writes) {
      if (write.confirmed == null) return false;
      const [scope, tool] = String(write.id).slice(prefix.length).split(':');
      if (scope !== 'comment' && tool === 'set_summary') {
        summaryRequest = String(write.request);
        continue;
      }
      const result = JSON.parse(String(write.result)) as { id: string; body?: string } | null;
      if (scope !== 'comment' && tool === 'remove_comment') {
        // Older removal receipts only stored null. Match the confirmed request to its decision.
        legacyRemovals ??= new Map(
          this.store.decisions(task.id).flatMap(({ commentId, reason, outcome }) =>
            commentId && ['withdrawn', 'deferred', 'rejected'].includes(outcome)
              ? [
                  [
                    createHash('sha256')
                      .update(JSON.stringify({ id: commentId, reason, outcome }))
                      .digest('hex'),
                    commentId,
                  ],
                ]
              : [],
          ),
        );
        const id = result?.id ?? legacyRemovals.get(String(write.request));
        if (!id || !comments.delete(id)) return false;
      } else {
        if (!result?.id || typeof result.body !== 'string') return false;
        if (comments.has(result.id) !== (scope !== 'comment')) return false;
        comments.set(result.id, result.body);
      }
    }
    for (const { id, body } of draft.comments) {
      if (comments.get(id) !== body) return false;
      comments.delete(id);
    }
    if (comments.size) return false;
    const suffix = `

<!-- ${handle.marker} -->`;
    if (!summaryRequest) return draft.body === 'Review in progress.' + suffix;
    return (
      draft.body.endsWith(suffix) &&
      createHash('sha256')
        .update(JSON.stringify({ body: draft.body.slice(0, -suffix.length) }))
        .digest('hex') === summaryRequest
    );
  }

  private draftRechecked(task: Task, runId: string, snapshot: ReviewSnapshot) {
    if (!task.draftRecheck) return true;
    const key = task.review!.marker + ':' + runId;
    const done = this.store.db.prepare(
      "SELECT 1 FROM operations WHERE task_id=? AND id GLOB ? AND status='done' AND json_extract(result,'$.id')=? AND json_extract(result,'$.body')=?",
    );
    const summary = this.store.db
      .prepare("SELECT 1 FROM operations WHERE task_id=? AND id GLOB ? AND status='done'")
      .get(task.id, key + ':set_summary:*');
    const missed = snapshot.comments.some(
      (c) =>
        task.draftRecheck!.commentIds.includes(c.id) &&
        !done.get(task.id, key + ':edit_comment:*', c.id, c.body),
    );
    return !!summary && !missed;
  }

  // A comment review can release findings without attesting that the whole change passed.
  private async verifyPartialDraft(
    task: Task,
    pr: PullRequest,
    snapshot: ReviewSnapshot,
    runId: string,
  ) {
    const handle = task.review!;
    if (
      !sameOpenTarget(task.pr, pr) ||
      pr.head !== handle.revision.head ||
      !sameRevision(task.revision, handle.revision) ||
      snapshot.revision.head !== pr.head ||
      (snapshot.status !== 'draft' && snapshot.status !== 'published') ||
      (pr.base !== handle.revision.base &&
        !(await this.provider(prRef(task)).targetAdvanced?.(
          prRef(task),
          handle.revision.base,
          pr.base,
        )))
    )
      throw new AppError(
        'stale_revision',
        'The PR changed before its recorded findings could be published.',
      );
    this.broker.reconcileDraftEdits(task, snapshot);
    if (!this.recordedDraft(task, snapshot))
      throw new AppError('draft_changed', draftInspectionRequired);
    for (const row of this.store.pendingReviewWrites(task.id, handle.marker)) {
      const key = String(row.id);
      if (key === handle.marker + ':publish' && !this.broker.outbox.isActive(key)) continue;
      // A missing add has no visible comment to release. Never replay it or mark it successful.
      if (
        key.startsWith(handle.marker + ':comment:') &&
        !this.broker.outbox.isActive(key) &&
        !snapshot.comments.some((c) => c.body.includes('<!-- ' + key + ' -->'))
      )
        continue;
      throw new AppError('draft_unconfirmed', draftSyncPending);
    }
    if (!this.draftRechecked(task, runId, snapshot))
      throw new AppError('draft_unconfirmed', draftSyncPending);
  }

  private async stageReviewFindings(task: Task, job: Job, result: AgentResult, pr: PullRequest) {
    if (job.kind !== 'review' || !task.review) return false;
    const evidence: PrEvidence = { report: { kind: 'review', result } };
    if (this.prAction(task, pr, evidence).kind !== 'publish-findings') return false;
    const snapshot = await this.provider(prRef(task)).getReview(prRef(task), task.review);
    if (snapshot.status !== 'draft') return false;
    const action = this.prAction(task, pr, { ...evidence, nativeReview: snapshot });
    if (action.kind === 'repair')
      return this.applyRepair(task, pr, action, { snapshot, finishingRun: true });
    if (action.kind !== 'publish-findings') return false;
    try {
      await this.verifyPartialDraft(task, pr, snapshot, job.id);
    } catch (error) {
      if (
        error instanceof AppError &&
        ['draft_changed', 'draft_unconfirmed', 'stale_revision'].includes(error.code)
      )
        return false;
      throw error;
    }
    task.reviewFinished = false;
    task.partialReview = {
      reviewId: task.review.id,
      runId: job.id,
      question: result.question?.trim() || undefined,
      limitation: result.summary,
    };
    task.snapshot = snapshot;
    task.resumeState = 'reviewing';
    this.state(
      task,
      'awaiting_publication',
      'Publishing recorded findings from an incomplete review',
    );
    return true;
  }

  private async releaseReviewFindings(task: Task) {
    const partial = task.partialReview!;
    if (task.review?.id !== partial.reviewId)
      throw new AppError('stale_review', 'The draft review changed before publication.');
    const snapshot = await this.broker.publish(task, (pr, native) =>
      this.verifyPartialDraft(task, pr, native, partial.runId),
    );
    const pr = await this.provider(prRef(task)).getPR(prRef(task));
    if (snapshot.status !== 'published')
      throw new AppError(
        'publication_unconfirmed',
        'Waiting for GitHub to confirm publication of the review findings.',
      );
    await this.verifyPartialDraft(task, pr, snapshot, partial.runId);
    task.snapshot = snapshot;
    this.setFeedback(task, snapshot);
    if (partial.question)
      task.openReviewQuestion = { head: snapshot.revision.head, text: redact(partial.question) };
    task.draftRecheck = undefined;
    this.store.saveTask(task);
    await this.afterPublishedReview(task, pr, snapshot);
    return task;
  }

  coordinationBlocker(task: Task) {
    if (
      task.state === 'needs_input' &&
      task.reviewRecovery?.coordination &&
      !task.reviewRecovery.plan
    )
      return {
        question: task.reviewRecovery.coordination,
        head: task.reviewRecovery.revision.head,
      };
    if (task.draftStart && task.state === 'queued') return;
    if (
      task.partialReview?.question &&
      (task.state === 'needs_input' || task.snapshot?.status === 'published')
    )
      return { question: redact(task.partialReview.question), head: task.review?.revision.head };
    if (task.openReviewQuestion && task.state !== 'needs_input' && task.state !== 'complete')
      return { question: task.openReviewQuestion.text, head: task.openReviewQuestion.head };
    if (task.state !== 'needs_input') return;
    const job = this.store.jobs(task.id).at(-1);
    if (task.resumeState !== 'reviewing' && (!task.review || task.reviewFinished))
      return { reason: redact(task.reason) };
    if (!job) return { step: 'review', head: task.revision?.head };
    const result = this.recordedAgentResult(task.id, job.id);
    if (
      job.generation === task.generation &&
      result?.question?.trim() &&
      result.question.trim() === task.reason.trim()
    )
      return { question: redact(result.question), head: result.checkedHead };
    return {
      step: job.kind,
      status: result?.status ?? job.status,
      errorCode: job.errorCode,
      head: task.revision?.head,
      mergeConflict: task.pr?.mergeConflict,
    };
  }

  private async retireSupersededDraft(task: Task, provider: ReviewProvider) {
    const handle = task.review!,
      ref = prRef(task);
    const snapshot = await provider.getReview(ref, handle);
    if (snapshot.status === 'published') return true;
    const archiveKey = 'review.archive:' + task.id + ':' + handle.id;
    const archived = this.store.setting<typeof snapshot>(archiveKey);
    const key = handle.marker + ':retire:' + handle.id;
    const pending = this.store.db.prepare('SELECT status FROM operations WHERE id=?').get(key);
    if (snapshot.status === 'missing' && !pending) return true;
    const source = snapshot.status === 'missing' ? archived : snapshot;
    const body = source?.body ?? '';
    if (
      !source ||
      source.status !== 'draft' ||
      source.revision.head !== handle.revision.head ||
      !handle.authorId ||
      source.comments.length ||
      !this.knownDraftSummary(task.id, handle, body) ||
      !provider.discardSupersededDraft ||
      (archived && archived.body !== body)
    ) {
      this.state(task, 'needs_input', draftInspectionRequired);
      return false;
    }
    if (!archived)
      this.store.transaction(() => {
        this.store.setSetting(archiveKey, source);
        this.store.event(task.id, 'review.draft_archived', {
          reviewId: handle.id,
          head: source.revision.head,
          archiveKey,
        });
      });
    await this.broker.outbox.perform(
      task.id,
      key,
      { review: handle.id, head: source.revision.head, body },
      async () => {
        await provider.discardSupersededDraft!(ref, handle, source);
        return null;
      },
      async () => ({
        found: (await provider.getReview(ref, handle)).status === 'missing',
        value: null,
      }),
      (error) => error instanceof AppError && error.code === 'draft_changed',
    );
    return true;
  }
  private invalidate(task: Task, pr: Task['pr'], cancelRunning = true) {
    task.generation++;
    this.store.cancelJobs(task.id);
    if (cancelRunning) this.onCancel(task.id);
    if (
      !task.reviewRecovery?.plan ||
      pr?.branch !== task.reviewRecovery.branch ||
      pr.targetBranch !== task.reviewRecovery.targetBranch
    )
      delete task.reviewRecovery;
    task.review = undefined;
    delete task.reviewLessonProof;
    delete task.publicationRetry;
    task.partialReview = undefined;
    task.draftRecheck = undefined;
    task.snapshot = undefined;
    task.approvedAt = undefined;
    task.checksWaivedAt = undefined;
    delete task.reviewChecksJob;
    delete task.reviewAfterChecks;
    delete task.ciRepairRevision;
    task.reviewFinished = false;
    delete task.completedReview;
    task.pr = pr;
    task.revision = pr ? revisionOf(pr) : undefined;
    task.verifiedMerge = undefined;
    task.fixingMergeConflict = undefined;
    task.conflictCheckpoint = undefined;
    this.store.event(task.id, 'revision.changed', {
      revision: task.revision,
      generation: task.generation,
    });
  }
  private queueReportReview(task: Task) {
    task.reviewFinished = false;
    task.resumeState = 'reviewing';
    this.state(task, 'reviewing', 'The worker report is ready for review');
    this.store.enqueue(
      task,
      'reviewer',
      'review',
      'Verify the worker report and its evidence against the original requirements. Report any missing work.',
    );
  }
  private queueNativeReview(
    task: Task,
    pr: PullRequest,
    reason: string,
    turn: NonNullable<Task['reviewAfterChecks']>,
  ) {
    task.pr = pr;
    delete task.reviewChecksJob;
    if (needsReviewChecks(task, pr)) {
      task.reviewAfterChecks = turn;
      this.state(task, 'awaiting_review_checks', 'Waiting for CI results before review');
      return;
    }
    delete task.reviewAfterChecks;
    this.state(task, 'reviewing', reason);
    const job = this.store.enqueue(task, 'reviewer', 'review', turn.input);
    if (turn.freshContextRetry || turn.timeoutRetry) {
      job.freshContextRetry = turn.freshContextRetry;
      job.timeoutRetry = turn.timeoutRetry;
      this.store.saveJob(job);
    }
  }
  private restartNativeReview(
    task: Task,
    pr: PullRequest,
    draft: ReviewSnapshot,
    reason: string,
    retry: Pick<Job, 'freshContextRetry' | 'timeoutRetry'> = task.reviewAfterChecks ?? {},
  ) {
    const handle = task.review!;
    const recheck =
      !sameRevision(handle.revision, pr) && this.draftHasWork(handle, draft)
        ? { commentIds: draft.comments.map((comment) => comment.id) }
        : task.draftRecheck;
    // The old run cannot release feedback or authorize a merge after the generation changes.
    this.invalidate(task, pr);
    task.reviewerThreadId = undefined;
    task.review = { ...handle, revision: revisionOf(pr) };
    task.snapshot = { ...draft, revision: revisionOf(pr) };
    task.draftRecheck = recheck;
    task.resumeState = 'reviewing';
    this.queueNativeReview(task, pr, reason, {
      ...retry,
      input:
        'Independently review the full current revision. Read the existing native draft and recorded decisions before editing. Verify all earlier published findings.',
    });
  }
  private draftHasWork(handle: ReviewHandle, draft: ReviewSnapshot) {
    return (
      draft.comments.length > 0 || draft.body !== `Review in progress.\n\n<!-- ${handle.marker} -->`
    );
  }
  private async draftCarryProblem(task: Task, pr: PullRequest, draft: ReviewSnapshot) {
    const handle = task.review!;
    if (handle.authorId && draft.authorId !== handle.authorId) return draftInspectionRequired;
    this.broker.reconcileDraftEdits(task, draft);
    if (this.broker.hasUnsettledDraftWrites(task, draft)) return draftSyncPending;
    if (!this.draftHasWork(handle, draft)) return;
    if (!this.recordedDraft(task, draft)) return draftInspectionRequired;
    if (
      !sameRevision(handle.revision, pr) &&
      !(await this.provider(prRef(task)).targetAdvanced?.(
        prRef(task),
        handle.revision.base,
        pr.base,
      ))
    )
      return draftSyncPending;
  }
  matchesResourcePause(task: Task) {
    const pause = task.resourcePause;
    if (!pause) return false;
    if (pause.generation === task.generation) return true;
    if (
      task.ref.provider !== 'github' ||
      task.state !== 'needs_input' ||
      task.resumeState !== 'reviewing' ||
      task.inputRequest ||
      task.reviewFinished ||
      task.pendingFix ||
      task.partialReview ||
      task.snapshot?.status === 'published' ||
      pause.generation > task.generation
    )
      return false;
    // Legacy reconciliation could advance the pinned base before the monitor resumed the task.
    const history = this.resourceReviewHistory(task);
    return !!history && !history.resumed && history.pausedGeneration === pause.generation;
  }

  private reviewWaitingForResources(task: Task) {
    return (
      task.ref.provider === 'github' &&
      task.state === 'needs_input' &&
      task.resumeState === 'reviewing' &&
      !!task.review &&
      this.matchesResourcePause(task)
    );
  }

  private resourceReviewHistory(task: Task) {
    const original = task.review?.revision;
    const group = task.groupId ? this.store.getGroup(task.groupId) : undefined;
    const job = this.store.jobs(task.id).findLast((run) => run.kind !== 'chat');
    if (
      !original ||
      job?.kind !== 'review' ||
      job.status !== 'cancelled' ||
      job.groupId !== task.groupId ||
      job.groupGeneration !== group?.generation ||
      group?.deletedAt ||
      group?.deletion ||
      group?.daddyState === 'paused' ||
      group?.daddyState === 'archived'
    )
      return;
    const history = this.store.db
      .prepare(
        `SELECT type, data FROM events
         WHERE task_id=? AND type IN ('resource.pause','task.state','revision.changed')
           AND id>(SELECT id FROM events WHERE task_id=? AND run_id=? AND type='job.queued')
         ORDER BY id`,
      )
      .all(task.id, task.id, job.id);
    const pauseIndex = history.findIndex((event) => event.type === 'resource.pause');
    const stopped = history[pauseIndex - 1];
    if (stopped?.type !== 'task.state') return;
    const pause = JSON.parse(String(history[pauseIndex].data)) as { reason: string };
    const before = JSON.parse(String(stopped.data));
    if (
      before.state !== 'needs_input' ||
      before.generation !== job.generation + 1 ||
      before.head !== original.head ||
      before.reason !== pause.reason
    )
      return;

    let generation = before.generation;
    let revision = original;
    let resumed = false;
    let awaitingStaleState = false;
    const bases = [original.base];
    for (const event of history.slice(pauseIndex + 1)) {
      const data = JSON.parse(String(event.data));
      if (event.type === 'revision.changed') {
        if (
          awaitingStaleState ||
          data.generation !== generation + 1 ||
          data.revision?.head !== original.head ||
          !data.revision.base ||
          data.revision.base === revision.base
        )
          return;
        generation = data.generation;
        revision = data.revision;
        bases.push(revision.base);
        awaitingStaleState = true;
      } else if (
        event.type !== 'task.state' ||
        data.state !== 'needs_input' ||
        data.generation !== generation ||
        data.head !== original.head
      ) {
        return;
      } else if (awaitingStaleState) {
        if (data.reason !== staleNativeDraft) return;
        awaitingStaleState = false;
      } else if (data.reason === resumedProviderState) {
        resumed = true;
      } else if (data.reason !== mismatchedDraftRevision || bases.length === 1) {
        return;
      }
    }
    if (
      !awaitingStaleState &&
      generation === task.generation &&
      sameRevision(revision, task.revision)
    )
      return { bases, resumed, pausedGeneration: job.generation + 1 };
  }

  private async resumeReviewAfterResourcePause(
    task: Task,
    observed?: PullRequest,
    clarification?: string,
  ) {
    const handle = task.review;
    if (
      task.ref.provider !== 'github' ||
      task.state !== 'needs_input' ||
      task.resumeState !== 'reviewing' ||
      task.inputRequest ||
      task.reviewFinished ||
      task.pendingFix ||
      task.partialReview ||
      !handle?.authorId ||
      task.snapshot?.status === 'published' ||
      !task.revision ||
      task.revision.head !== handle.revision.head ||
      this.reviewWaitingForResources(task) ||
      this.store.busy(task.id)
    )
      return false;

    const group = task.groupId ? this.store.getGroup(task.groupId) : undefined;
    const history = this.resourceReviewHistory(task);
    if (!history?.resumed) return false;
    const { bases } = history;

    const ref = prRef(task),
      provider = this.provider(ref);
    const pr = observed ?? (await provider.getPR(ref));
    if (
      !sameOpenTarget(task.pr, pr) ||
      pr.draft !== false ||
      pr.head !== handle.revision.head ||
      pr.base === handle.revision.base
    )
      return false;
    const action = this.prAction(task, pr);
    if (action.kind !== 'refresh' && action.kind !== 'continue') return false;
    // Check each persisted base change as well as any advance since the last reconciliation.
    if (bases.at(-1) !== pr.base) bases.push(pr.base);
    for (let i = 1; i < bases.length; i++)
      if (!(await provider.targetAdvanced?.(ref, bases[i - 1], bases[i]))) return false;
    const draft = await provider.getReview(ref, handle);
    if (draft.status !== 'draft' || draft.revision.head !== pr.head) return false;
    this.broker.reconcileDraftEdits(task, draft);
    if (
      this.store.pendingReviewWrites(task.id, handle.marker).length ||
      !this.matchesLatestDraftWrites(task, draft)
    )
      return false;

    const currentPR = await provider.getPR(ref);
    const current = this.store.getTask(task.id);
    const currentGroup = task.groupId ? this.store.getGroup(task.groupId) : undefined;
    if (
      !sameRevision(currentPR, pr) ||
      !sameOpenTarget(task.pr, currentPR) ||
      currentPR.draft !== false ||
      current.generation !== task.generation ||
      current.state !== task.state ||
      current.reason !== task.reason ||
      currentGroup?.generation !== group?.generation ||
      currentGroup?.deletedAt ||
      currentGroup?.deletion ||
      currentGroup?.daddyState === 'paused' ||
      currentGroup?.daddyState === 'archived'
    )
      return false;
    this.store.transaction(() => {
      if (clarification?.trim()) this.rememberClarification(task, clarification);
      delete task.resourcePause;
      this.restartNativeReview(
        task,
        currentPR,
        draft,
        'The target branch advanced. Reviewing the updated change.',
      );
    });
    return true;
  }
  async retryInterruptedStep(id: string) {
    return this.lock(id, async () => {
      const task = this.store.getTask(id);
      if (
        task.state !== 'needs_input' ||
        !task.groupId ||
        task.ref.provider !== 'github' ||
        this.store.busy(id)
      )
        return;
      const group = this.store.getGroup(task.groupId);
      if (
        group.deletedAt ||
        group.deletion ||
        group.daddyState === 'paused' ||
        group.daddyState === 'archived'
      )
        return;
      if (this.reviewWaitingForResources(task) || (await this.resumeReviewAfterResourcePause(task)))
        return;
      const job = this.store.jobs(id).at(-1);
      if (!job || job.groupGeneration !== group.generation) return;
      if (task.partialReview) {
        if (
          task.partialReview.runId === job.id &&
          task.resumeState === 'awaiting_publication' &&
          restartInterrupted(task, job)
        )
          this.state(
            task,
            'awaiting_publication',
            'Publishing recorded findings from an incomplete review',
          );
        return;
      }
      if (
        job.kind === 'review' &&
        job.generation === task.generation &&
        task.resumeState === 'reviewing'
      ) {
        const result =
          job.status === 'completed'
            ? this.recordedAgentResult(id, job.id)
            : job.status === 'failed' &&
                job.error === task.reason &&
                task.revision &&
                !['stale_revision', 'run_cancelled'].includes(job.errorCode ?? '')
              ? {
                  status: 'incomplete' as const,
                  checkedHead: task.revision.head,
                  summary: task.reason,
                  question: '',
                }
              : undefined;
        if (
          result &&
          result.status !== 'completed' &&
          (result.question || result.summary) === task.reason &&
          (await this.stageReviewFindings(
            task,
            job,
            result,
            await this.provider(prRef(task)).getPR(prRef(task)),
          ))
        )
          return;
      }
      const previous = task.ticketRepository;
      const movedBase =
        job.kind === 'review' &&
        job.status === 'cancelled' &&
        job.generation + 1 === task.generation &&
        (task.reason === staleNativeDraft ||
          task.reason === draftInspectionRequired ||
          task.reason === draftSyncPending) &&
        !!task.review &&
        task.review.revision.head === task.revision?.head &&
        task.review.revision.base !== task.revision.base &&
        !!previous &&
        previous.branch === task.pr?.branch &&
        previous.baseBranch === task.pr.targetBranch &&
        previous.cloneUrl === task.pr.cloneUrl;
      const waitingForSync =
        task.reason === draftSyncPending &&
        job.kind === 'review' &&
        job.status === 'failed' &&
        (job.generation === task.generation ||
          (job.error === interruptedByRestart && job.generation + 1 === task.generation));
      const restarted =
        restartInterrupted(task, job) || (waitingForSync && job.error === interruptedByRestart);
      if (
        !movedBase &&
        !restarted &&
        (job.status !== 'failed' || job.generation !== task.generation)
      )
        return;
      const quota = job.errorCode === 'github_rate_limit' || legacyQuotaRead(job.error);
      if (
        quota &&
        job.error &&
        job.kind === 'fix' &&
        task.resumeState === 'awaiting_push' &&
        task.pendingFix &&
        task.pendingAuthorHead &&
        task.reason === `Saved fix ${task.pendingAuthorHead} is preserved. ${job.error}`
      ) {
        const pr = await this.provider(prRef(task)).getPR(prRef(task));
        if (await this.checkSavedFix(task, pr))
          this.state(task, 'awaiting_push', 'Author saved the fixes; sending them to the PR');
        return;
      }
      if (
        (!movedBase && task.resumeState !== 'reviewing') ||
        job.kind !== 'review' ||
        !task.review ||
        task.pendingFix ||
        (!movedBase && !waitingForSync && job.error !== task.reason)
      )
        return;
      const context =
        job.profile?.engine === 'codex' &&
        !job.freshContextRetry &&
        (job.errorCode === 'context_window_exceeded' ||
          (job.error?.startsWith('AppError: Codex turn failed: {') &&
            job.error.includes('"codexErrorInfo":"contextWindowExceeded"')));
      const timeout = job.errorCode === 'run_timeout' && !job.timeoutRetry;
      const staleStart =
        job.errorCode === 'stale_revision' &&
        job.error ===
          'AppError: The PR changed before the queued job started. Reconcile and review the new revision.';
      if (
        !quota &&
        !restarted &&
        !movedBase &&
        !staleStart &&
        !((context || timeout) && autoMergeEnabled(this.store, task))
      )
        return;
      const ref = prRef(task),
        provider = this.provider(ref);
      const [pr, draft] = await Promise.all([
        provider.getPR(ref),
        provider.getReview(ref, task.review),
      ]);
      if (
        !sameOpenTarget(task.pr, pr) ||
        pr.draft !== false ||
        pr.head !== task.revision?.head ||
        pr.head !== task.review.revision.head ||
        draft.status !== 'draft' ||
        draft.revision.head !== pr.head
      ) {
        if (!context)
          this.state(
            task,
            'needs_input',
            'The PR or native draft changed. Inspect the interrupted review.',
          );
        return;
      }
      if (restarted || waitingForSync || !sameRevision(task.review.revision, pr)) {
        const problem = await this.draftCarryProblem(task, pr, draft);
        if (problem) {
          if ((!context || problem === draftSyncPending) && task.reason !== problem)
            this.state(task, 'needs_input', problem);
          return;
        }
      }
      const currentGroup = this.store.getGroup(task.groupId);
      if (
        currentGroup.generation !== job.groupGeneration ||
        currentGroup.deletedAt ||
        currentGroup.deletion ||
        currentGroup.daddyState === 'paused' ||
        currentGroup.daddyState === 'archived' ||
        (!quota && !restarted && !movedBase && !staleStart && !autoMergeEnabled(this.store, task))
      )
        return;
      this.store.transaction(() => {
        if (
          context &&
          currentGroup.reviewerThreadId &&
          currentGroup.reviewerThreadId === job.threadId
        ) {
          currentGroup.reviewerThreadId = undefined;
          this.store.saveGroup(currentGroup);
        }
        if (restarted && this.draftHasWork(task.review!, draft))
          task.draftRecheck = { commentIds: draft.comments.map((comment) => comment.id) };
        this.restartNativeReview(
          task,
          pr,
          draft,
          context
            ? 'Reviewer context was full. Restarting the independent review.'
            : 'Continuing the independent review on the verified PR head',
          {
            freshContextRetry: job.freshContextRetry || !!context,
            timeoutRetry: job.timeoutRetry || timeout,
          },
        );
      });
    });
  }

  async reconcile(id: string) {
    return this.lock(id, () => this.reconcileLocked(id));
  }
  private fixPendingReason(task: Task) {
    return task.fixSave
      ? `Resolve the local save for run ${task.fixSave.runId} before review.`
      : `Resume submission of saved fix ${task.pendingAuthorHead} before review.`;
  }
  private queueMergeVerification(task: Task, pr: PullRequest) {
    if (task.state !== 'needs_input' || this.store.busy(task.id))
      throw new AppError('task_busy', 'Choose an idle task that needs attention');
    if (
      task.fixSave ||
      pr.state !== 'merged' ||
      (pr.head !== task.revision?.head &&
        !(task.pendingFix && pr.head === task.pendingAuthorHead)) ||
      !samePullRequestTarget(task.pr, pr) ||
      ((task.ref.provider === 'github' || task.ref.provider === 'gitlab') && !pr.mergeCommit) ||
      (task.ref.provider === 'arcadia' && (!pr.revisionId || !this.savedFixDiffReady(task, pr))) ||
      (task.pr?.mergeCommit && task.pr.state === 'merged' && task.pr.mergeCommit !== pr.mergeCommit)
    )
      throw new AppError(
        'merge_unconfirmed',
        'The provider must confirm the merge of this task head',
      );
    if (task.pendingAuthorHead && task.pendingAuthorHead !== pr.head)
      throw new AppError(
        'unsubmitted_changes',
        'Inspect the saved worker changes before verifying this merge',
      );
    this.store.transaction(() => {
      if (!sameRevision(task.revision, pr)) {
        task.approvedAt = undefined;
        task.checksWaivedAt = undefined;
      }
      task.generation++;
      task.revision = revisionOf(pr);
      task.pr = pr;
      task.verifiedMerge = undefined;
      task.pendingFix = undefined;
      delete task.draftStart;
      task.reviewerThreadId = undefined;
      this.state(task, 'reviewing', 'Checking the merged result');
      this.store.enqueue(
        task,
        'reviewer',
        'verify_merge',
        'Verify the delivered PR diff and the original task outcome, including requested deployment checks. Use read-only evidence. Check prior published findings and return their verified IDs. Report incomplete if any required result cannot be verified.',
      );
    });
    return task;
  }
  prAction(task: Task, pr: PullRequest, evidence: PrEvidence = {}) {
    return nextPrAction(task, pr, {
      ...evidence,
      autoMerge: autoMergeEnabled(this.store, task),
      jobs: this.store.activeJobs(task.id),
      mergePending: !!pendingMerge(this.store, task),
    });
  }

  // Called under the task lock, after the router has selected the required preparation.
  async applyRepair(
    task: Task,
    pr: PullRequest,
    action: Extract<PrAction, { kind: 'repair' }>,
    options: {
      snapshot?: ReviewSnapshot;
      checkpoint?: (task: Task) => Promise<string>;
      finishingRun?: boolean;
    } = {},
  ) {
    if (action.preparation === 'retire-draft') {
      if (
        !task.review?.authorId ||
        options.snapshot?.authorId !== task.review.authorId ||
        this.store.pendingReviewWrites(task.id, task.review.marker).length
      )
        return false;
      if (!(await this.retireSupersededDraft(task, this.provider(prRef(task))))) return true;
    }
    let checkpoint =
      action.preparation === 'preserve-checkpoint' ? task.conflictCheckpoint : undefined;
    if (action.preparation === 'checkpoint') {
      if (!options.checkpoint)
        throw new Error('Conflict repair requires a checkpoint of the author changes');
      checkpoint = await options.checkpoint(task);
    }
    const feedback = options.snapshot ?? task.snapshot;
    const feedbackReview = task.review;
    this.store.transaction(() => {
      if (action.preparation !== 'resume') {
        if (action.preparation === 'checkpoint') delete task.fixSave;
        this.invalidate(task, pr, !options.finishingRun);
        task.pendingFix = undefined;
        task.conflictCheckpoint = checkpoint;
        if (feedback?.status === 'published' && feedback.revision.head === pr.head)
          this.setFeedback(task, feedback, feedbackReview);
      }
      task.fixingMergeConflict = true;
      this.state(task, 'fixing', 'Worker assigned to resolve the GitHub merge conflict');
      this.store.enqueue(
        task,
        'author',
        'fix',
        'Resolve the merge conflicts in the prepared working copy. Preserve the intended behavior of both branches and verify the result.',
      );
      if (action.preparation === 'checkpoint')
        this.store.event(task.id, 'author.conflict_checkpoint', {
          head: checkpoint,
          revision: task.revision,
        });
    });
    return true;
  }

  private async handOffIncompleteFix(
    task: Task,
    result: AgentResult,
    pr: PullRequest,
    job: Job,
    checkpoint: (task: Task, save?: FixSave) => Promise<string>,
  ) {
    const action = this.prAction(task, pr, { report: { kind: 'fix', result } });
    if (action.kind !== 'repair' || action.preparation !== 'checkpoint') return false;
    return this.applyRepair(task, pr, action, {
      checkpoint: (current) => this.writeFixSave(current, job, result.summary, checkpoint, pr),
      finishingRun: true,
    });
  }

  async fixCanContinueOnAdvancedBase(task: Task, pr: PullRequest, resumeConflict = false) {
    const pinned = task.revision;
    if (
      task.ref.provider !== 'github' ||
      !pinned ||
      task.pendingFix ||
      (task.pendingAuthorHead && task.pendingAuthorHead !== pinned.head) ||
      pr.draft !== false ||
      pr.head !== pinned.head ||
      pr.base === pinned.base ||
      !sameOpenTarget(task.pr, pr)
    )
      return false;
    if (task.fixingMergeConflict) {
      if (!resumeConflict || !autoMergeEnabled(this.store, task) || !task.authorWorktree)
        return false;
    } else if (
      !sameRevision(task.ciRepairRevision, pinned) &&
      (!hasReleasedReview(task) ||
        task.snapshot?.status !== 'published' ||
        !sameRevision(task.snapshot.revision, pinned) ||
        !sameRevision(task.review?.revision, pinned))
    )
      return false;
    return (
      (await this.provider(prRef(task)).targetAdvanced?.(prRef(task), pinned.base, pr.base)) ===
      true
    );
  }

  private recordedAgentResult(taskId: string, runId: string): AgentResult | undefined {
    const result = this.store.db
      .prepare(
        "SELECT json_extract(data,'$.text') AS text FROM events WHERE task_id=? AND run_id=? AND type='runtime.item' AND json_extract(data,'$.type')='agentMessage' AND json_extract(data,'$.phase')='final_answer' ORDER BY id DESC LIMIT 1",
      )
      .get(taskId, runId);
    if (typeof result?.text !== 'string') return;
    try {
      const value = JSON.parse(result.text);
      if (
        value &&
        typeof value.summary === 'string' &&
        typeof value.checkedHead === 'string' &&
        (value.question == null || typeof value.question === 'string')
      )
        return value;
    } catch {
      /* Earlier agents could leave plain text instead of a structured result. */
    }
  }

  async recoverInterruptedFix(
    id: string,
    checkpoint: (task: Task, save?: FixSave) => Promise<string>,
  ) {
    return this.lock(id, async () => {
      const task = this.store.getTask(id);
      if (
        task.state !== 'needs_input' ||
        !(task.resumeState === 'fixing' || task.resumeState === 'needs_input') ||
        task.fixSave ||
        task.pendingFix ||
        task.fixingMergeConflict ||
        this.store.busy(id)
      )
        return;
      const job = this.store.jobs(id).at(-1);
      if (task.resumeState === 'needs_input') {
        if (
          job?.kind !== 'chat' ||
          job.role !== 'author' ||
          job.status !== 'failed' ||
          job.errorCode !== 'stale_revision' ||
          job.generation !== task.generation ||
          job.error !== task.reason ||
          !job.actionId?.startsWith('daddy:') ||
          !task.review ||
          !hasReleasedReview(task) ||
          task.snapshot?.status !== 'published'
        )
          return;
        const previous = this.store.jobs(id).at(-2);
        if (
          previous?.kind !== 'fix' ||
          previous.status !== 'completed' ||
          previous.generation !== task.generation
        )
          return;
        const result = this.recordedAgentResult(id, previous.id);
        if (
          !result ||
          !requestsHumanInput(result) ||
          !result.question?.trim() ||
          result.checkedHead !== task.revision?.head
        )
          return;
        const group = task.groupId && this.store.getGroup(task.groupId);
        if (
          !group ||
          group.generation !== job.groupGeneration ||
          group.deletion ||
          group.deletedAt ||
          group.daddyState === 'paused' ||
          group.daddyState === 'archived'
        )
          return;
        const pr = await this.provider(prRef(task)).getPR(prRef(task));
        if (
          !sameOpenTarget(task.pr, pr) ||
          (!sameRevision(pr, task.revision) && !(await this.fixCanContinueOnAdvancedBase(task, pr)))
        )
          return;
        this.store.transaction(() => this.queueAnsweredFix(task, job.input, job.actionId));
        return;
      }
      if (!job || job.kind !== 'fix') return;
      const restarted = restartInterrupted(task, job);
      if (!restarted && job.generation !== task.generation) return;
      const staleStart =
        job.status === 'failed' &&
        job.errorCode === 'stale_revision' &&
        job.error === task.reason &&
        job.error ===
          'AppError: The PR changed before the queued job started. Reconcile and review the new revision.';
      if (staleStart || restarted) {
        if (
          task.ref.provider !== 'github' ||
          !hasReleasedReview(task) ||
          !task.review ||
          task.snapshot?.status !== 'published' ||
          !sameRevision(task.review.revision, task.revision) ||
          task.fixSave ||
          (task.pendingAuthorHead && task.pendingAuthorHead !== task.revision?.head)
        )
          return;
        const ref = prRef(task),
          provider = this.provider(ref);
        const pr = await provider.getPR(ref);
        const same =
          sameRevision(pr, task.revision) && sameOpenTarget(task.pr, pr) && pr.draft === false;
        if (!(restarted && same) && !(await this.fixCanContinueOnAdvancedBase(task, pr))) return;
        if (restarted) {
          const native = await provider.getReview(ref, task.review);
          const pending = this.store.db
            .prepare("SELECT 1 FROM operations WHERE task_id=? AND status='pending'")
            .get(task.id);
          if (pending || native.status !== 'published' || native.revision.head !== pr.head) return;
          this.setFeedback(task, native);
        }
        const group = task.groupId ? this.store.getGroup(task.groupId) : undefined;
        if (
          group &&
          (group.generation !== job.groupGeneration ||
            group.deletedAt ||
            group.deletion ||
            group.daddyState === 'paused' ||
            group.daddyState === 'archived')
        )
          return;
        this.store.transaction(() => {
          this.state(
            task,
            'fixing',
            restarted
              ? 'Continuing the interrupted fix against confirmed published feedback.'
              : 'The target branch advanced. Continuing the published feedback on the same PR commit.',
          );
          this.store.enqueue(task, 'author', 'fix', job.input);
        });
        return;
      }
      if (job.status !== 'completed' || !autoMergeEnabled(this.store, task)) return;
      const result = this.recordedAgentResult(task.id, job.id);
      if (
        result?.status !== 'incomplete' ||
        result.summary !== task.reason ||
        result.question ||
        result.checkedHead !== task.revision?.head
      )
        return;
      await this.handOffIncompleteFix(
        task,
        result,
        await this.provider(prRef(task)).getPR(prRef(task)),
        job,
        checkpoint,
      );
    });
  }

  private async changeReviewRevision(task: Task, pr: PullRequest, clarification?: string) {
    if (task.state === 'needs_input' && task.resumeState === 'reviewing') {
      if (await this.resumeReviewAfterResourcePause(task, pr, clarification)) return;
      if (this.store.getTask(task.id).generation !== task.generation) return;
    }
    const handle = task.review;
    if (
      task.ref.provider === 'github' &&
      handle &&
      !task.pendingFix &&
      ['reviewing', 'awaiting_review_checks', 'awaiting_publication'].includes(task.state) &&
      sameOpenTarget(task.pr, pr) &&
      pr.draft === false &&
      sameRevision(handle.revision, task.revision) &&
      handle.revision.head === pr.head &&
      handle.revision.base !== pr.base
    ) {
      const groupGeneration = task.groupId && this.store.getGroup(task.groupId).generation;
      const draft = await this.provider(prRef(task)).getReview(prRef(task), handle);
      const reusable =
        draft.status === 'draft' &&
        draft.revision.head === pr.head &&
        !(await this.draftCarryProblem(task, pr, draft));
      const group = task.groupId ? this.store.getGroup(task.groupId) : undefined;
      if (
        this.store.getTask(task.id).generation !== task.generation ||
        (group &&
          (group.generation !== groupGeneration ||
            group.deletedAt ||
            group.deletion ||
            group.daddyState === 'paused' ||
            group.daddyState === 'archived'))
      )
        return;
      if (reusable) {
        this.store.transaction(() =>
          this.restartNativeReview(
            task,
            pr,
            draft,
            'The target branch advanced. Reviewing the updated change.',
          ),
        );
        return;
      }
    }
    const hadUnpublished =
      task.review && task.snapshot?.status !== 'published' && task.state !== 'awaiting_push';
    const previous = task.snapshot;
    this.invalidate(task, pr);
    if (hadUnpublished) {
      if (handle) task.resumeState = 'reviewing';
      task.review = handle;
      task.snapshot = previous;
    }
    this.state(
      task,
      hadUnpublished ? 'needs_input' : 'queued',
      hadUnpublished ? staleNativeDraft : 'New revision is ready for review',
    );
  }
  private async reconcileLocked(id: string, publication?: ReviewSnapshot): Promise<Task> {
    let task = this.store.getTask(id);
    if (task.fixSave) return task;
    if (task.draftStart) return task; // Draft creation reconciles its own outstanding native write.
    if (task.state === 'paused' || isTicket(task) || this.reviewWaitingForResources(task))
      return task;
    if (task.state === 'awaiting_publication' && task.partialReview) return task;
    const provider = this.provider(prRef(task)),
      pr = await provider.getPR(prRef(task));
    task = this.store.getTask(id);
    if (
      task.pendingFix ||
      (task.state === 'awaiting_push' &&
        !!task.pendingAuthorHead &&
        task.pendingAuthorHead !== task.revision?.head)
    ) {
      await this.checkSavedFix(task, pr);
      return task;
    }
    if (pr.state === 'merged') {
      if (
        task.state === 'awaiting_merge' &&
        pr.mergeCommit &&
        (!task.pendingAuthorHead || task.pendingAuthorHead === pr.head) &&
        sameRevision(task.revision, pr) &&
        samePullRequestTarget(task.pr, pr) &&
        task.reviewFinished &&
        task.snapshot?.status === 'published' &&
        !task.snapshot.comments.length
      ) {
        const published = task.review && (await provider.getReview(prRef(task), task.review));
        if (
          published?.status === 'published' &&
          !published.comments.length &&
          sameRevision(published.revision, task.revision) &&
          pr.checks === 'passing' &&
          (await this.completedReviewFindingsCurrent(task))
        ) {
          task.pr = pr;
          this.finishReviewedTask(task, 'Merged on GitHub');
          return task;
        }
      }
      if (
        task.state === 'complete' ||
        this.store.activeJobs(id).some((job) => job.kind === 'verify_merge')
      )
        return task;
      if (
        samePullRequestTarget(task.pr, pr) &&
        sameRevision(task.verifiedMerge, pr) &&
        task.verifiedMerge?.mergeCommit === pr.mergeCommit &&
        ['awaiting_checks', 'awaiting_plan_approval'].includes(task.state)
      ) {
        task.pr = pr;
        await this.finish(task);
        return task;
      }
    }
    if (pr.state !== 'open') {
      this.onCancel(id);
      this.store.cancelJobs(id);
      task.generation++;
      this.state(task, 'needs_input', `PR is ${pr.state}; automatic work stopped`);
      return task;
    }
    if (
      (publication || !sameRevision(task.revision, pr)) &&
      (await this.advancePublishedReview(task, pr, publication))
    )
      return task;
    const action = this.prAction(task, pr);
    if (action.kind === 'repair') {
      await this.applyRepair(task, pr, action);
      return task;
    }
    if (
      action.kind === 'confirm-merge' ||
      action.kind === 'continue-repair' ||
      action.kind === 'finish-running-review'
    )
      return task;
    if (action.kind === 'target-changed') {
      if (
        task.state === 'needs_input' &&
        task.reason === 'The PR branches changed. Inspect the task before restarting review.'
      )
        return task;
      this.onCancel(id);
      this.store.cancelJobs(id);
      task.generation++;
      this.state(
        task,
        'needs_input',
        'The PR branches changed. Inspect the task before restarting review.',
      );
      return task;
    }
    if (action.kind === 'inspect-repair') {
      this.onCancel(id);
      this.store.cancelJobs(id);
      task.generation++;
      task.resumeState = 'fixing';
      this.state(
        task,
        'needs_input',
        'The PR changed during conflict resolution. Inspect the preserved worker copy.',
      );
      return task;
    }
    if (staleConflictPreparation(task)) {
      if (action.kind === 'refresh')
        this.store.transaction(() => {
          this.invalidate(task, pr);
          this.state(task, 'queued', 'New revision is ready for review');
        });
      return task;
    }
    if (action.kind === 'check-fix-base' && (await this.fixCanContinueOnAdvancedBase(task, pr)))
      return task;
    if (action.kind === 'refresh' || action.kind === 'check-fix-base') {
      await this.changeReviewRevision(task, pr);
      return task;
    }
    task.pr = pr;
    if (this.store.busy(id)) return task;
    if (!task.review) {
      this.store.saveTask(task);
      return task;
    }
    const snapshot = await this.readReviewForReconciliation(task);
    if (!snapshot) return task;
    if (task.snapshot && JSON.stringify(task.snapshot) !== JSON.stringify(snapshot))
      this.store.event(id, 'review.changed', {
        previous: task.snapshot,
        current: snapshot,
      });
    task.snapshot = snapshot;
    if (!sameRevision(snapshot.revision, task.revision)) {
      this.state(task, 'needs_input', mismatchedDraftRevision);
      return task;
    }
    if (snapshot.status === 'partial' || snapshot.status === 'missing') {
      this.state(
        task,
        'needs_input',
        snapshot.status === 'partial'
          ? 'Native review was partially published or contains untracked notes. Inspect it before continuing.'
          : 'Native review was removed or dismissed. Inspect it before continuing.',
      );
      return task;
    }
    if (task.state === 'awaiting_publication' && snapshot.status === 'published') {
      await this.advancePublishedReview(task, pr, snapshot);
    } else if (task.state === 'awaiting_merge' && !autoMergeRequested(this.store, task)) {
      if (snapshot.status === 'published' && task.reviewFinished && !snapshot.comments.length)
        await this.finish(task);
      else
        this.state(
          task,
          'needs_input',
          'The reviewed revision needs verification before completion',
        );
    } else if (task.state === 'awaiting_checks' || task.state === 'awaiting_plan_approval')
      await this.finish(task);
    else this.store.saveTask(task);
    return this.store.getTask(id);
  }
  // Keep the original PR identity pinned until the provider confirms the saved head.
  private savedFixDiffReady(task: Task, pr: PullRequest) {
    const original = task.pendingFix?.revision ?? task.revision;
    return (
      task.ref.provider !== 'arcadia' ||
      pr.head === original?.head ||
      (pr.diffHead === pr.head && !!pr.revisionId && pr.revisionId !== original?.revisionId)
    );
  }

  private async checkSavedFix(task: Task, pr: PullRequest, resume = false): Promise<boolean> {
    const head = task.pendingAuthorHead;
    const original = task.pendingFix?.revision ?? task.revision;
    if (!head || !original)
      throw new AppError('missing_fix', 'The saved fix or its original revision is missing');
    if (!task.pendingFix) {
      task.pendingFix = { revision: original };
      this.store.saveTask(task);
    }
    const sameTarget = sameOpenTarget(task.pr, pr) && !pr.draft;
    if (task.revision?.head === head) {
      if (sameTarget && sameRevision(task.revision, pr)) {
        if (resume) this.state(task, 'queued', 'New revision is ready for review');
      } else if (
        sameTarget &&
        pr.head === head &&
        !task.review &&
        !task.draftStart &&
        task.ref.provider === 'github' &&
        (await this.provider(prRef(task)).targetAdvanced?.(
          prRef(task),
          task.revision.base,
          pr.base,
        )) === true
      ) {
        this.store.transaction(() => {
          this.invalidate(task, pr);
          this.state(
            task,
            'queued',
            'Target advanced. Reviewing the saved fix against the new base.',
          );
        });
      } else this.holdSavedFix(task, pr);
      return false;
    }
    const sameBase = pr.base === original.base && pr.start === original.start;
    const compatibleBase =
      sameBase ||
      (task.ref.provider === 'github' &&
        sameTarget &&
        (pr.head === head || pr.head === original.head) &&
        (await this.provider(prRef(task)).targetAdvanced?.(prRef(task), original.base, pr.base)) ===
          true);
    if (sameTarget && pr.head === head && compatibleBase && !this.savedFixDiffReady(task, pr)) {
      if (!task.pendingFix.attempted) {
        task.pendingFix.attempted = true;
        task.pendingFix.confirmUntil = confirmationDeadline();
        this.store.saveTask(task);
      }
      const reason = `Waiting for Arcanum to prepare the diff for saved fix ${head}.`;
      if (task.state !== 'awaiting_push' || task.reason !== reason)
        this.state(task, 'awaiting_push', reason);
      return false;
    }
    if (sameTarget && pr.head === head && compatibleBase) {
      const old = task.review;
      const snapshot =
        old && !task.reviewFinished
          ? await this.provider(prRef(task)).getReview(prRef(task), old)
          : undefined;
      this.store.transaction(() => {
        this.invalidate(task, pr, false);
        task.pendingAuthorHead = head;
        if (old && (snapshot?.status === 'draft' || snapshot?.status === 'partial')) {
          task.review = old;
          task.snapshot = snapshot;
          this.state(
            task,
            'needs_input',
            `Saved fix ${head} is on the PR. Inspect the earlier draft review ${old.id} before starting another review.`,
          );
        } else {
          this.state(task, 'queued', 'New revision is ready for review');
        }
      });
      return false;
    }
    if (
      sameTarget &&
      pr.head === original.head &&
      compatibleBase &&
      original.revisionId === pr.revisionId
    ) {
      if (!task.pendingFix.attempted) return true;
      if (task.pendingFix.confirmUntil && task.pendingFix.confirmUntil > now()) {
        const reason = `Waiting for the PR to confirm saved fix ${head}.`;
        if (task.state !== 'awaiting_push' || task.reason !== reason)
          this.state(task, 'awaiting_push', reason);
        return false;
      }
      if (resume) return true;
      task.resumeState = 'awaiting_push';
      this.state(task, 'needs_input', unconfirmedFix(head, pr.head));
      return false;
    }
    this.holdSavedFix(task, pr);
    return false;
  }

  private holdSavedFix(task: Task, pr: PullRequest) {
    const original = task.revision!;
    task.resumeState = 'awaiting_push';
    this.state(
      task,
      'needs_input',
      `Saved fix ${task.pendingAuthorHead} is preserved. PR is ${pr.state} at ${pr.head} (base ${pr.base}, target ${pr.targetBranch}); expected ${original.head} (base ${original.base}, target ${task.pr?.targetBranch}). Inspect the target and submission outcome.`,
    );
  }

  async submitSavedFix(id: string, push: (task: Task, head: string) => Promise<void>) {
    return this.lock(id, async () => {
      const task = this.store.getTask(id);
      const head = task.pendingAuthorHead;
      if (
        task.state !== 'awaiting_push' ||
        task.fixSave ||
        !task.revision ||
        !head ||
        head === task.revision.head ||
        this.store.busy(id)
      )
        return;
      const provider = this.provider(prRef(task));
      if (!(await this.checkSavedFix(task, await provider.getPR(prRef(task))))) return;
      if (task.fixingMergeConflict && !autoMergeEnabled(this.store, task)) {
        task.resumeState = 'awaiting_push';
        this.state(
          task,
          'needs_input',
          'Auto-merge is disabled. The saved conflict resolution is waiting for submission.',
        );
        return;
      }
      task.pendingFix = {
        ...task.pendingFix,
        revision: task.pendingFix?.revision ?? task.revision,
        attempted: true,
        confirmUntil: confirmationDeadline(),
      };
      this.store.saveTask(task);
      try {
        await push(task, head);
        task.pendingFix.confirmUntil = confirmationDeadline();
        this.store.transaction(() => {
          this.store.saveTask(task);
          this.store.event(id, 'author.submitted', { head, pushed: true });
        });
      } catch (error) {
        if (error instanceof AppError && error.code === 'fix_before_push') {
          task.pendingFix.attempted = false;
          delete task.pendingFix.confirmUntil;
          task.resumeState = 'awaiting_push';
          this.state(
            task,
            'needs_input',
            `Saved fix ${head} is preserved. ${redact(error.message)}`,
          );
          return;
        }
        this.store.event(id, 'author.submission_uncertain', { head, error: redact(String(error)) });
      }
      await this.checkSavedFix(task, await provider.getPR(prRef(task)));
    });
  }

  setFeedback(task: Task, snapshot: ReviewSnapshot, handle = task.review) {
    task.feedback = snapshot;
    task.feedbackReview = handle;
  }

  private publications(task: Task) {
    return this.store.db
      .prepare(
        "SELECT data FROM events WHERE task_id=? AND type IN ('review.published','review.findings_published') ORDER BY id DESC",
      )
      .all(task.id)
      .map(
        (event) =>
          JSON.parse(String(event.data)) as {
            reviewId?: string;
            handle?: ReviewHandle;
            snapshot?: ReviewSnapshot;
            revision?: Revision;
            comments?: number;
          },
      );
  }

  private publicationHandle(task: Task, publication: ReturnType<Engine['publications']>[number]) {
    const { reviewId, handle, snapshot } = publication;
    const revision = snapshot?.revision ?? publication.revision;
    if (!reviewId || !revision) return;
    if (handle && handle.id === reviewId && sameRevision(handle.revision, revision)) return handle;
    const record = this.store.db
      .prepare(
        `SELECT result FROM operations WHERE task_id=? AND status='done'
        AND id GLOB ? AND json_extract(result,'$.id')=? AND json_extract(result,'$.marker')=id
        LIMIT 1`,
      )
      .get(task.id, `daddyloop:${task.id}:*`, reviewId);
    if (typeof record?.result === 'string') {
      const saved = JSON.parse(record.result) as ReviewHandle;
      if (sameRevision(saved.revision, revision)) return saved;
    }
    // GitHub fetches directly by review ID. Other providers need the native marker.
    if (task.ref.provider === 'github') return { id: reviewId, marker: '', revision };
  }

  private async feedbackHandle(task: Task) {
    if (task.feedbackReview) return task.feedbackReview;
    if (!task.feedback?.comments.length) return;
    if (task.ref.provider === 'github' && task.feedback.url?.includes('#pullrequestreview-'))
      return this.broker.publishedReviewFromLink(task, task.feedback);
    const matches = (snapshot?: ReviewSnapshot) =>
      snapshot?.status === 'published' &&
      sameRevision(snapshot.revision, task.feedback?.revision) &&
      task.feedback!.comments.every((finding) =>
        snapshot.comments.some((c) => c.id === finding.id),
      );
    const handles = new Map<string, ReviewHandle | undefined>();
    for (const publication of this.publications(task)) {
      if (
        !publication.reviewId ||
        !sameRevision(
          publication.snapshot?.revision ?? publication.revision,
          task.feedback.revision,
        )
      )
        continue;
      const handle = this.publicationHandle(task, publication);
      if (matches(publication.snapshot)) handles.set(publication.reviewId, handle);
      else if (!publication.snapshot && publication.comments && handle) {
        // Older partial-publication events retained a count without the native comment IDs.
        const native = await this.provider(prRef(task)).getReview(prRef(task), handle, {
          publishedEvidence: true,
        });
        if (matches(native)) handles.set(publication.reviewId, handle);
      }
    }
    if (task.review && matches(task.snapshot)) handles.set(task.review.id, task.review);
    if (handles.size === 1) return handles.values().next().value;
  }

  private earlierPublications(task: Task) {
    return this.publications(task).filter(
      (event) =>
        event.reviewId !== task.review?.id && (event.snapshot?.comments.length || event.comments),
    );
  }

  async refreshFindingEvidence(task: Task, job: FindingEvidence): Promise<ReviewSnapshot[]> {
    if (job.kind !== 'review' && job.kind !== 'verify_merge') return [];
    const latest = job.publishedFindingReviews
      ? job.publishedFindingReview
      : (job.publishedFindingReview ?? (await this.feedbackHandle(task)));
    if (!latest && task.feedback?.comments.length && !job.publishedFindingReviews)
      throw new AppError(
        'feedback_unconfirmed',
        'The native publication of earlier findings could not be identified.',
      );
    const handles = new Map<string, ReviewHandle>();
    if (latest) handles.set(latest.id, latest);
    if (job.publishedFindingReviews) {
      for (const handle of job.publishedFindingReviews) handles.set(handle.id, handle);
    } else {
      for (const publication of this.earlierPublications(task)) {
        if (publication.reviewId && handles.has(publication.reviewId)) continue;
        const handle = this.publicationHandle(task, publication);
        if (!handle)
          throw new AppError(
            'feedback_unconfirmed',
            'An earlier native publication could not be identified.',
          );
        handles.set(handle.id, handle);
      }
    }
    const provider = this.provider(prRef(task));
    const publications = this.publications(task);
    const recordedFindings = (handle: ReviewHandle) => {
      const known = new Set(job.reviewFindingIds?.[handle.id]);
      let minimumCount = 0;
      const remember = (snapshot?: ReviewSnapshot) => {
        if (snapshot?.status === 'published' && sameRevision(snapshot.revision, handle.revision))
          for (const { id } of snapshot.comments) known.add(id);
      };
      for (const publication of publications) {
        if (publication.reviewId !== handle.id) continue;
        remember(publication.snapshot);
        // Old partial publications preserve a count without native IDs.
        if (
          !publication.snapshot &&
          sameRevision(publication.revision, handle.revision) &&
          typeof publication.comments === 'number' &&
          Number.isSafeInteger(publication.comments)
        )
          minimumCount = Math.max(minimumCount, publication.comments);
      }
      if (
        task.feedbackReview?.id === handle.id ||
        (!task.feedbackReview && !job.publishedFindingReviews && latest?.id === handle.id)
      )
        remember(task.feedback);
      if (task.review?.id === handle.id) remember(task.snapshot);
      // GitHub keeps a comment ID when publishing its draft. An old author
      // snapshot without a review ID needs a completed write to this review.
      const receipts = new Set(
        (task.ref.provider === 'github' && handle.marker
          ? this.store.db
              .prepare(
                `SELECT json_extract(result,'$.id') AS id FROM operations
               WHERE task_id=? AND status='done' AND id GLOB ?`,
              )
              .all(task.id, handle.marker + ':comment:*')
          : []
        ).map((row) => String(row.id)),
      );
      const snapshots = this.store.db
        .prepare(
          `SELECT data FROM events WHERE task_id=? AND type='author.feedback_snapshot'
         AND json_extract(data,'$.revision.head')=?`,
        )
        .all(task.id, handle.revision.head);
      for (const row of snapshots) {
        const snapshot = JSON.parse(String(row.data)) as ReviewSnapshot & { reviewId?: string };
        if (snapshot.status !== 'published' || !sameRevision(snapshot.revision, handle.revision))
          continue;
        const linkedId = githubReviewIdFromUrl(prRef(task), snapshot.url);
        if (snapshot.reviewId && linkedId && snapshot.reviewId !== linkedId) continue;
        const reviewId = snapshot.reviewId ?? linkedId;
        for (const { id } of snapshot.comments) {
          if (reviewId === handle.id || (!reviewId && receipts.has(id))) known.add(id);
        }
      }
      return { known: [...known], minimumCount };
    };
    const readFindingReview = async (handle: ReviewHandle) => {
      const { known, minimumCount } = recordedFindings(handle);
      const checkingMerge = job.kind === 'verify_merge';
      const current = checkingMerge && task.review?.id === handle.id;
      const native = current
        ? await this.broker.readCurrentReview(task, known)
        : await provider.getReview(prRef(task), handle, {
            publishedEvidence: true,
            knownCommentIds: known,
          });
      const ids = new Set(native.comments.map((comment) => comment.id));
      const expectsPublished =
        !current || known.length > 0 || minimumCount > 0 || task.snapshot?.status === 'published';
      if (
        !sameRevision(native.revision, handle.revision) ||
        native.status === 'missing' ||
        native.status === 'partial' ||
        (expectsPublished && native.status !== 'published') ||
        ids.size < minimumCount ||
        known.some((id) => !ids.has(id))
      )
        throw new AppError(
          checkingMerge ? 'published_review_unavailable' : 'feedback_unconfirmed',
          `Could not confirm the recorded findings in review ${handle.id}. Its last snapshot was preserved.`,
        );
      return native;
    };
    const read = new Map<string, ReviewSnapshot>();
    for (const handle of handles.values()) read.set(handle.id, await readFindingReview(handle));
    job.publishedFindingReview = latest;
    job.publishedFindingReviews = [...handles.values()];
    job.findingVersions = this.findingVersions([...read.values()]);
    job.mergeFindingVersions = {};
    if (latest) this.setFeedback(task, read.get(latest.id)!, latest);
    if (job.kind === 'verify_merge' && task.review) {
      const current = read.get(task.review.id) ?? (await readFindingReview(task.review));
      task.snapshot = current;
      job.mergeFindingVersions = this.findingVersions([current]);
      if (current.status === 'published') read.set(task.review.id, current);
    }
    // Retain attribution for IDs first seen in this run as well as archived IDs.
    job.reviewFindingIds = Object.fromEntries(
      [...read].map(([id, snapshot]) => [id, snapshot.comments.map((comment) => comment.id)]),
    );
    return [...read.values()];
  }

  private findingVersions(snapshots: (ReviewSnapshot | undefined)[]) {
    return Object.fromEntries(
      snapshots.flatMap((snapshot) =>
        snapshot?.status === 'published'
          ? snapshot.comments.map((c) => [c.id, findingVersion(c)])
          : [],
      ),
    );
  }

  private async currentFindingEvidence(task: Task, job: FindingEvidence, capture = false) {
    const before = job.findingVersions ?? this.findingVersions([task.feedback]);
    const beforeMerge = job.mergeFindingVersions ?? this.findingVersions([task.snapshot]);
    const current = { ...job };
    const evidence = await this.refreshFindingEvidence(task, current);
    const matches = (before: Record<string, string>, after: Record<string, string> = {}) =>
      Object.entries(after).every(([id, version]) => before[id] === version) &&
      Object.keys(before).length === Object.keys(after).length;
    if (
      matches(before, current.findingVersions) &&
      matches(beforeMerge, current.mergeFindingVersions)
    ) {
      if (capture) Object.assign(job, current);
      return evidence;
    }
  }

  async completedReviewFindingsCurrent(task: Task) {
    const receipt = task.completedReview;
    if (
      receipt &&
      (receipt.reviewId !== task.review?.id || !sameRevision(receipt.revision, task.revision))
    )
      return false;
    const jobs = this.store.jobs(task.id);
    const review = receipt
      ? jobs.find((job) => job.id === receipt.runId && job.kind === 'review')
      : jobs.findLast(
          (job) =>
            job.kind === 'review' &&
            job.status === 'completed' &&
            job.generation <= task.generation,
        );
    if (receipt && !review) return false;
    const earlier = this.earlierPublications(task);
    const known = new Set(review?.publishedFindingReviews?.map((handle) => handle.id));
    if (review?.publishedFindingReview) known.add(review.publishedFindingReview.id);
    if (earlier.some((publication) => !publication.reviewId || !known.has(publication.reviewId)))
      return false;
    if (!review?.findingVersions) return !task.feedback?.comments.length && known.size === 0;
    return !!(await this.currentFindingEvidence({ ...task }, review));
  }

  private async confirmCompletedReview(task: Task) {
    if (!task.reviewFinished || (await this.completedReviewFindingsCurrent(task))) return true;
    task.reviewFinished = false;
    this.state(task, 'needs_input', 'Published findings changed. Retry review before completing.');
    return false;
  }

  private hasUnverifiedFindings(task: Task, verified: Set<string>, evidence: ReviewSnapshot[]) {
    const decisions = this.store.decisions(task.id);
    return evidence
      .flatMap((snapshot) => snapshot.comments)
      .some((comment) => {
        if (verified.has(comment.id)) return false;
        return !decisions.some(
          (d) =>
            d.commentId === comment.id &&
            d.commentVersion === findingVersion(comment) &&
            (['withdrawn', 'deferred', 'rejected'].includes(d.outcome) ||
              (d.outcome === 'verified' && d.head === task.revision?.head)),
        );
      });
  }
  finishReviewedTask(
    task: Task,
    reason = 'Current revision reviewed; publication, findings and checks are accounted for',
  ) {
    if (task.pr?.state === 'open' && autoMergeRequested(this.store, task))
      this.state(task, 'awaiting_merge', 'Review complete. Waiting for GitHub to merge the PR.');
    else this.state(task, 'complete', reason);
    if (task.state === 'complete') savePublishedLesson(this.store, task);
  }

  restoreMergeWaits() {
    for (const task of this.store.tasks())
      if (
        task.state === 'complete' &&
        task.pr?.state === 'open' &&
        autoMergeRequested(this.store, task)
      )
        this.finishReviewedTask(task);
  }

  private async finish(task: Task) {
    const gate = completionGate(task);
    if (gate) this.state(task, gate.state, gate.reason);
    else if (
      (await this.checkMergedFindings(task)) &&
      (task.verifiedMerge || (await this.confirmCompletedReview(task)))
    ) {
      if (task.kind === 'plan') task.approvedAt = now();
      this.finishReviewedTask(
        task,
        task.verifiedMerge ? 'daddy verified the merged result' : undefined,
      );
    }
  }
  private async checkMergedFindings(task: Task) {
    const verified = task.verifiedMerge;
    if (!verified) return true;
    const known = new Set(verified.publishedFindingReviews?.map((handle) => handle.id));
    const coversPublications = this.earlierPublications(task).every(
      (publication) => publication.reviewId && known.has(publication.reviewId),
    );
    const hasEvidence = verified.findingVersions && verified.mergeFindingVersions;
    const noFindings =
      !task.feedback?.comments.length &&
      !(task.snapshot?.status === 'published' && task.snapshot.comments.length);
    try {
      if (
        coversPublications &&
        (hasEvidence || noFindings) &&
        (await this.currentFindingEvidence(task, { ...verified, kind: 'verify_merge' }))
      )
        return true;
    } catch (error) {
      if (
        !(error instanceof AppError) ||
        !['published_review_unavailable', 'feedback_unconfirmed'].includes(error.code)
      )
        throw error;
      const state = task.state === 'awaiting_plan_approval' ? task.state : 'awaiting_checks';
      if (task.state !== state || task.reason !== error.message)
        this.state(task, state, error.message);
      return false;
    }
    delete task.verifiedMerge;
    this.state(task, 'needs_input', 'Published findings changed. Verify the merged result again.');
    return false;
  }

  private enqueueArchitect(
    task: Task,
    recovery: ReviewRecovery,
    clarification?: string,
    actionId?: string,
  ) {
    task.planning ??= {};
    task.reviewRecovery = recovery;
    delete recovery.coordination;
    this.state(
      task,
      'fixing',
      'The task architect is revising the fix plan after two unsuccessful corrections.',
    );
    const job = this.store.enqueue(
      task,
      'author',
      'plan',
      clarification ??
        'Diagnose the recurring published criteria and give the assigned worker a revised, testable fix plan.',
      actionId,
    );
    recovery.runId = job.id;
    this.store.saveTask(task);
  }
  private scheduleReviewRecovery(task: Task, snapshot: ReviewSnapshot) {
    const evidence = repeatedReviewFindings(this.store, task, snapshot);
    if (!evidence) return false;
    this.store.transaction(() => {
      task.noProgress = 0;
      this.enqueueArchitect(task, { ...evidence, runId: '' });
      this.store.event(
        task.id,
        'review.architect_requested',
        {
          reviewId: evidence.reviewId,
          revision: evidence.revision,
          criteria: evidence.criteria,
          attempts: evidence.attempts,
        },
        task.reviewRecovery!.runId,
      );
    });
    return true;
  }
  /** Also handles an ordinary fix that was already queued by an older installation. */
  async admitReviewWork(
    job: Job,
    snapshot: ReviewSnapshot,
    pr: PullRequest,
    observedReview?: ReviewHandle,
  ) {
    return this.lock(job.taskId, async () => {
      const task = this.store.getTask(job.taskId);
      if (task.generation !== job.generation || task.state === 'paused') return false;
      const recovery = task.reviewRecovery;
      if (
        job.kind === 'plan' &&
        (!recovery ||
          recovery.plan ||
          recovery.runId !== (job.firstAttemptId ?? job.id) ||
          task.state !== 'fixing')
      )
        return false;
      if (snapshot.status !== 'published')
        throw new AppError(
          'unpublished_feedback',
          'The published review changed before work started.',
        );
      if (
        job.kind === 'fix' &&
        recovery &&
        !recovery.plan &&
        recovery.reviewId === task.review?.id &&
        sameRevision(recovery.revision, task.revision)
      )
        return false;
      if (
        job.kind === 'plan' &&
        (!sameOpenTarget(task.pr, pr) || !sameRevision(task.revision, pr))
      ) {
        await this.reconcileLocked(task.id);
        return false;
      }
      if (job.kind === 'plan' && !sameRevision(task.revision, snapshot.revision)) {
        this.invalidate(task, pr, false);
        this.state(
          task,
          'queued',
          'Published findings changed. Independent review will check the current evidence.',
        );
        return false;
      }
      if (
        recovery &&
        task.review?.id === recovery.reviewId &&
        sameRevision(task.revision, recovery.revision) &&
        feedbackFingerprint(snapshot) !== recovery.fingerprint
      ) {
        this.invalidate(task, pr, false);
        this.state(
          task,
          'queued',
          'Published findings changed. Independent review will check the current evidence.',
        );
        return false;
      }
      const handle = task.review ?? task.feedbackReview ?? observedReview;
      this.setFeedback(task, snapshot, handle);
      if (
        job.kind === 'fix' &&
        task.state === 'fixing' &&
        sameOpenTarget(task.pr, pr) &&
        sameRevision(pr, task.revision) &&
        this.scheduleReviewRecovery(task, snapshot)
      )
        return false;
      this.store.saveTask(task);
      if (job.kind === 'fix')
        this.store.event(
          task.id,
          'author.feedback_snapshot',
          { ...snapshot, reviewId: handle?.id },
          job.id,
        );
      return true;
    });
  }
  private async finishReviewRecovery(task: Task, job: Job, result: AgentResult, pr: PullRequest) {
    const recovery = task.reviewRecovery;
    if (
      !recovery ||
      recovery.runId !== (job.firstAttemptId ?? job.id) ||
      recovery.plan ||
      task.state !== 'fixing' ||
      task.review?.id !== recovery.reviewId ||
      !sameRevision(task.revision, recovery.revision)
    )
      return;
    if (!sameOpenTarget(task.pr, pr) || !sameRevision(recovery.revision, pr)) {
      await this.reconcileLocked(task.id);
      return;
    }
    const native = await this.broker.readCurrentReview(task);
    const confirmed = await this.provider(prRef(task)).getPR(prRef(task));
    if (!sameOpenTarget(task.pr, confirmed) || !sameRevision(recovery.revision, confirmed)) {
      await this.reconcileLocked(task.id);
      return;
    }
    if (
      native.status !== 'published' ||
      !sameRevision(native.revision, recovery.revision) ||
      feedbackFingerprint(native) !== recovery.fingerprint
    ) {
      if (native.status === 'published') {
        this.invalidate(task, pr, false);
        this.state(
          task,
          'queued',
          'Published findings changed. Independent review will check the current evidence.',
        );
      } else {
        task.resumeState = 'fixing';
        this.state(task, 'needs_input', 'The architect could not confirm the published review.');
      }
      return;
    }
    this.store.transaction(() => {
      this.store.message(task.id, 'author', 'agent', result.summary, job.id, job.id);
      const text = redact(result.summary.trim());
      if (result.checkedHead !== recovery.revision.head || !text || result.status !== 'completed') {
        task.resumeState = 'fixing';
        const question =
          result.checkedHead === recovery.revision.head &&
          requestsHumanInput(result) &&
          (result.question?.trim() || text);
        if (question) {
          recovery.coordination = redact(question);
          this.state(
            task,
            'needs_input',
            recovery.coordination,
            job,
            task.groupId && this.store.getGroup(task.groupId).orchestrated ? 'daddy' : undefined,
          );
        } else
          this.state(
            task,
            'needs_input',
            'The architect did not finish a plan for the pinned revision.',
          );
        return;
      }
      recovery.plan = text;
      delete recovery.coordination;
      task.noProgress = 0;
      this.state(task, 'fixing', 'The worker is applying the revised architecture plan.');
      this.store.enqueue(
        task,
        'author',
        'fix',
        'Apply the task architect’s revised plan to the published findings. Test the recorded failing and passing paths through their final consumer.',
      );
      this.store.event(
        task.id,
        'review.architect_planned',
        { reviewId: recovery.reviewId, revision: recovery.revision, criteria: recovery.criteria },
        job.id,
      );
    });
  }
  private assignPublishedFindings(task: Task, snapshot: ReviewSnapshot) {
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify(
          snapshot.comments.map((c) => ({
            body: c.body.replace(/<!-- daddyloop:[^>]+ -->/g, ''),
            location: c.location,
          })),
        ),
      )
      .digest('hex');
    task.noProgress = fingerprint === task.lastFeedbackHash ? task.noProgress + 1 : 0;
    task.lastFeedbackHash = fingerprint;
    this.setFeedback(task, snapshot);
    if (this.scheduleReviewRecovery(task, snapshot)) return;
    if (task.noProgress >= task.policy.maxNoProgress)
      this.state(
        task,
        'needs_input',
        'The same findings keep returning; human decision is required',
      );
    else this.queuePublishedFix(task, 'Author is addressing the published review');
  }
  private async readReviewForReconciliation(task: Task) {
    try {
      return await this.broker.readCurrentReview(task);
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== 'feedback_unconfirmed') throw error;
      this.state(task, 'needs_input', error.message);
    }
  }
  private async advancePublishedReview(task: Task, pr: PullRequest, publication?: ReviewSnapshot) {
    if (
      task.state !== 'awaiting_publication' ||
      task.partialReview ||
      !task.review ||
      !sameOpenTarget(task.pr, pr) ||
      this.store.busy(task.id)
    )
      return false;
    const snapshot = publication ?? (await this.readReviewForReconciliation(task));
    if (!snapshot) return true;
    if (snapshot.status !== 'published') return false;
    if (!task.reviewFinished) {
      this.state(
        task,
        'needs_input',
        'The review was not completed successfully; published feedback is held until verification',
      );
      return true;
    }
    if (!(await this.confirmCompletedReview(task))) return true;
    task.snapshot = snapshot;
    this.setFeedback(task, snapshot);
    if (sameRevision(task.revision, pr)) task.pr = pr;
    await this.afterPublishedReview(task, pr, snapshot);
    return true;
  }
  private async afterPublishedReview(task: Task, pr: PullRequest, snapshot: ReviewSnapshot) {
    delete task.publicationRetry;
    const action = this.prAction(task, pr, { nativeReview: snapshot });
    if (action.kind === 'wait-mergeability') {
      if (task.partialReview) task.partialReview.retryAt = Date.now() + 5000;
      this.store.saveTask(task);
      return;
    }
    const partial = task.partialReview;
    this.store.event(
      task.id,
      partial ? 'review.findings_published' : 'review.published',
      partial
        ? {
            reviewId: task.review!.id,
            handle: task.review,
            revision: snapshot.revision,
            comments: snapshot.comments.length,
            snapshot,
          }
        : { reviewId: task.review!.id, handle: task.review, snapshot },
    );
    switch (action.kind) {
      case 'repair':
        await this.applyRepair(task, pr, action, { snapshot });
        return;
      case 'fix-findings':
        this.assignPublishedFindings(task, snapshot);
        return;
      case 'finish':
        await this.finish(task);
        return;
      case 'hold-incomplete': {
        const job = this.store.jobs(task.id).find((j) => j.id === partial!.runId);
        this.state(
          task,
          'needs_input',
          partial!.question || partial!.limitation,
          partial!.question ? job : undefined,
        );
        return;
      }
      case 'refresh':
        await this.changeReviewRevision(task, pr);
        return;
      default:
        throw new AppError(
          'publication_unconfirmed',
          'Waiting for GitHub to confirm publication of the review findings.',
        );
    }
  }
  private queuePublishedFix(task: Task, reason: string) {
    this.store.transaction(() => {
      this.state(task, 'fixing', reason);
      this.store.enqueue(
        task,
        'author',
        'fix',
        'Deliver the original outcome using the published review as evidence. Read its current summary for the diagnosis, group related findings, fix the shared cause, and report the checks for each affected criterion. Explain disputes. Use only published feedback and recorded decisions.',
      );
    });
  }

  recoverLostFixes() {
    for (const task of this.store.tasks()) {
      if (
        task.state === 'needs_input' &&
        task.reason === 'The same findings keep returning; human decision is required' &&
        task.snapshot?.status === 'published' &&
        !this.store.busy(task.id) &&
        (!task.groupId ||
          !['paused', 'archived'].includes(
            this.store.getGroup(task.groupId).daddyState ?? 'active',
          )) &&
        this.scheduleReviewRecovery(task, task.snapshot)
      )
        continue;
      if (
        isTicket(task) ||
        !['queued', 'needs_input'].includes(task.state) ||
        this.store.busy(task.id) ||
        !task.revision
      )
        continue;
      if (task.groupId) {
        const group = this.store.getGroup(task.groupId);
        if (
          group.deletion ||
          group.deletedAt ||
          group.daddyState === 'paused' ||
          group.daddyState === 'archived'
        )
          continue;
      }
      if (
        task.state === 'needs_input' &&
        task.pendingFix?.attempted &&
        !task.pendingFix.confirmUntil &&
        task.pendingAuthorHead &&
        task.revision &&
        task.reason === unconfirmedFix(task.pendingAuthorHead, task.revision.head)
      ) {
        // A previous release stopped on the first stale read. Recheck without sending.
        task.pendingFix.confirmUntil = confirmationDeadline();
        this.state(
          task,
          'awaiting_push',
          `Waiting for the PR to confirm saved fix ${task.pendingAuthorHead}.`,
        );
        continue;
      }
      if (
        task.pendingFix ||
        task.pendingAuthorHead ||
        task.feedback?.status !== 'published' ||
        !sameRevision(task.feedback.revision, task.revision)
      )
        continue;
      const job = this.store
        .jobs(task.id)
        .filter((item) => item.role === 'author')
        .at(-1);
      if (
        job?.kind !== 'fix' ||
        job.status !== 'completed' ||
        job.generation + 1 !== task.generation
      )
        continue;
      const saved = this.store.db
        .prepare(
          `SELECT id,json_extract(data,'$.head') AS head FROM events
         WHERE task_id=? AND run_id=? AND type='author.fixes_saved' ORDER BY id DESC LIMIT 1`,
        )
        .get(task.id, job.id);
      if (typeof saved?.head !== 'string' || !saved.head || saved.head === task.revision.head)
        continue;
      const lost = this.store.db
        .prepare(
          `SELECT 1 FROM events WHERE task_id=? AND id>? AND type='task.state'
         AND json_extract(data,'$.state')='queued' AND json_extract(data,'$.reason')=?
         AND json_extract(data,'$.generation')=? AND json_extract(data,'$.head')=?
         AND NOT EXISTS (SELECT 1 FROM events e WHERE e.task_id=? AND e.id>? AND e.type='author.submitted')`,
        )
        .get(
          task.id,
          saved.id,
          noFixChanges,
          task.generation,
          task.revision.head,
          task.id,
          saved.id,
        );
      if (!lost) continue;
      const head = saved.head;
      this.store.transaction(() => {
        task.pendingAuthorHead = head;
        task.pendingFix = { revision: task.revision! };
        task.resumeState = 'awaiting_push';
        this.state(
          task,
          'awaiting_push',
          `Recovered saved fix ${head}; checking the PR before submission.`,
        );
        this.store.event(task.id, 'author.fix_recovered', { head }, job.id);
      });
    }
  }

  recoverReviewRoundLimits() {
    for (const task of this.store.tasks()) {
      if (!['needs_input', 'awaiting_push'].includes(task.state) || this.store.busy(task.id))
        continue;
      if (task.groupId) {
        const group = this.store.getGroup(task.groupId);
        if (
          group.deletedAt ||
          group.deletion ||
          group.daddyState === 'paused' ||
          group.daddyState === 'archived'
        )
          continue;
      }
      if (task.state === 'needs_input' && task.reason === oldReviewStartLimit && !task.review) {
        this.state(task, 'queued', 'Review can continue on the saved revision');
        continue;
      }
      if (
        !task.revision ||
        !task.reviewFinished ||
        !task.review ||
        task.snapshot?.status !== 'published' ||
        task.feedback?.status !== 'published' ||
        !task.feedback.comments.length ||
        task.noProgress >= task.policy.maxNoProgress ||
        !sameRevision(task.review.revision, task.revision) ||
        !sameRevision(task.snapshot.revision, task.revision) ||
        !sameRevision(task.feedback.revision, task.revision) ||
        (task.pendingAuthorHead && task.pendingAuthorHead !== task.revision.head)
      )
        continue;
      // A legacy resume may have changed the visible reason without queuing an author.
      const stop = this.store.db
        .prepare(
          `SELECT 1 FROM events stopped
           WHERE stopped.task_id=? AND stopped.type='task.state'
             AND json_extract(stopped.data,'$.reason')=?
             AND json_extract(stopped.data,'$.generation')=?
             AND json_extract(stopped.data,'$.head')=?
             AND NOT EXISTS (
               SELECT 1 FROM events later
               WHERE later.task_id=stopped.task_id AND later.id>stopped.id
                 AND later.type='job.queued'
                 AND json_extract(later.data,'$.kind') IN ('review','fix')
             )
           LIMIT 1`,
        )
        .get(task.id, oldPublishedReviewLimit, task.generation, task.revision.head);
      if (!stop) continue;
      this.queuePublishedFix(task, 'Continuing against the saved published findings');
    }
  }
  async publish(id: string, expected?: ExpectedTask) {
    return this.lock(id, async () => {
      const task = this.store.getTask(id);
      assertTaskVersion(task, expected);
      if (
        task.state !== 'awaiting_publication' ||
        (!task.reviewFinished && !task.partialReview) ||
        this.store.busy(id)
      )
        throw new AppError(
          'publication_unavailable',
          'Wait until the reviewer has finished and discussion is idle',
        );
      if (task.publicationRetry && task.publicationRetry.retryAt > Date.now()) return task;
      try {
        if (task.partialReview) return await this.releaseReviewFindings(task);
        if (!(await this.confirmCompletedReview(task))) return task;
        const publication = await this.broker.publish(task);
        return await this.reconcileLocked(id, publication);
      } catch (error) {
        const current = this.store.getTask(id);
        if (
          error instanceof AppError &&
          error.code === 'feedback_unconfirmed' &&
          current.generation === task.generation &&
          current.state === 'awaiting_publication' &&
          current.review?.id === task.review?.id
        ) {
          this.state(current, 'needs_input', error.message);
          return current;
        }
        if (
          error instanceof AppError &&
          error.code === 'stale_revision' &&
          !task.partialReview &&
          task.ref.provider === 'github' &&
          current.generation === task.generation &&
          current.state === 'awaiting_publication'
        )
          return this.reconcileLocked(id);

        if (
          current.generation !== task.generation ||
          current.state !== 'awaiting_publication' ||
          current.review?.id !== task.review?.id ||
          !(
            error instanceof AppError &&
            (error.code === 'diff_unavailable' ||
              (task.ref.provider === 'github' &&
                (error instanceof GitHubRetryError ||
                  /^(provider_(408|500|502|503|504)|provider_unreachable)$/.test(error.code))))
          )
        )
          throw error;
        const delay = Math.min((current.publicationRetry?.delay ?? 7500) * 2, 300000);
        current.publicationRetry = {
          delay,
          retryAt: Math.max(
            Date.now() + delay,
            error instanceof GitHubRetryError ? error.until : 0,
          ),
        };
        this.state(
          current,
          'awaiting_publication',
          error.code === 'diff_unavailable'
            ? 'Waiting for the provider to confirm the diff before continuing publication'
            : 'Waiting to retry GitHub review publication',
        );
        return current;
      }
    });
  }
  private rememberClarification(task: Task, text: string) {
    task.latestClarification = {
      text: text.trim(),
      question:
        task.openReviewQuestion?.text ??
        (task.inputRequest?.role === 'author' ? task.reason : undefined),
    };
    delete task.openReviewQuestion;
    if (task.partialReview) delete task.partialReview.question;
  }
  private queueAnsweredFix(task: Task, text: string, actionId?: string) {
    this.rememberClarification(task, text);
    task.resumeState = 'fixing';
    this.state(task, 'fixing', 'Continuing the fix with the answer from the session');
    this.store.enqueue(task, 'author', 'fix', text, actionId);
  }
  async chat(
    id: string,
    role: 'author' | 'reviewer',
    text: string,
    actionId?: string,
    deferUntilPublished = false,
  ) {
    return this.lock(id, async () => {
      const task = this.store.getTask(id);
      if (
        role === 'author' &&
        (deferUntilPublished || task.fixSave || task.pendingFix || task.state === 'awaiting_push')
      ) {
        const key = actionId ?? randomUUID();
        this.store.transaction(() => {
          const pending = (task.deferredWorkerInstructions ??= []);
          if (
            this.store.db
              .prepare('SELECT id FROM messages WHERE id=? AND task_id=?')
              .get('deferred:' + id + ':' + key, id)
          )
            return;
          pending.push({ id: key, text });
          this.store.message(id, role, 'user', text, undefined, 'deferred:' + id + ':' + key);
          this.store.saveTask(task);
        });
        return task;
      }
      if (task.fixSave || task.pendingFix || task.state === 'awaiting_push')
        throw new AppError(
          'fix_pending',
          `Wait for submission of saved fix ${task.pendingAuthorHead} before starting another turn.`,
        );
      if (task.state === 'paused' || task.state === 'complete')
        throw new AppError(
          'chat_unavailable',
          'Resume or reopen the task before starting another session',
        );
      this.store.transaction(() => {
        this.store.message(id, role, 'user', text);
        if (
          role === 'author' &&
          task.state === 'needs_input' &&
          task.reviewRecovery?.coordination &&
          !task.reviewRecovery.plan &&
          task.reviewRecovery.reviewId === task.review?.id &&
          sameRevision(task.reviewRecovery.revision, task.revision)
        ) {
          this.enqueueArchitect(task, task.reviewRecovery, text, actionId);
          return;
        }
        if (
          role === 'author' &&
          isTicket(task) &&
          task.state === 'needs_input' &&
          task.resumeState === 'implementing' &&
          task.planning &&
          !task.planning.result &&
          task.inputRequest?.generation === task.generation
        ) {
          this.rememberClarification(task, text);
          this.queueImplementation(task, actionId);
          return;
        }
        if (
          role === 'author' &&
          task.state === 'needs_input' &&
          task.resumeState === 'fixing' &&
          !task.fixingMergeConflict &&
          task.inputRequest?.role === 'author' &&
          task.inputRequest.generation === task.generation &&
          hasReleasedReview(task) &&
          sameRevision(task.revision, task.snapshot?.revision) &&
          task.snapshot?.status === 'published'
        ) {
          this.queueAnsweredFix(task, text, actionId);
        } else this.store.enqueue(task, role, 'chat', text, actionId);
      });
      return task;
    });
  }
  async deliverWorkerInstruction(id: string) {
    return this.lock(id, async () => {
      const task = this.store.getTask(id),
        next = task.deferredWorkerInstructions?.[0];
      if (
        !next ||
        this.store.busy(id) ||
        task.fixSave ||
        task.pendingFix ||
        task.pr?.state !== 'open' ||
        ![
          'complete',
          'awaiting_merge',
          'awaiting_checks',
          'awaiting_plan_approval',
          'fixing',
        ].includes(task.state) ||
        task.snapshot?.status !== 'published' ||
        !sameRevision(task.snapshot.revision, task.revision)
      )
        return;
      this.store.enqueue(task, 'author', 'chat', next.text, next.id);
    });
  }
  async recoverFixSave(id: string) {
    return this.lock(id, async () => {
      const task = this.store.getTask(id);
      if (task.state !== 'paused' && !this.store.busy(id)) await this.settleFixSave(task);
    });
  }

  private async settleFixSave(task: Task, savedHead?: string) {
    const save = task.fixSave;
    if (!save || !this.readFixSave) return;
    const job = this.store.jobs(task.id).find((job) => job.id === save.runId);
    let head: string;
    try {
      if (
        job?.kind !== 'fix' ||
        job.generation !== save.generation ||
        task.ref.provider !== save.ref.provider ||
        task.ref.host !== save.ref.host ||
        task.ref.repo !== save.ref.repo ||
        task.ref.number !== save.ref.number ||
        !sameRevision(task.revision, save.revision) ||
        !task.pr ||
        !samePullRequestTarget(save.pr, task.pr)
      )
        throw new Error('The original fix run or target changed.');
      head = savedHead ?? (await this.readFixSave(task, save));
    } catch (error) {
      const reason = `Could not confirm local save for run ${save.runId}. The author copy was preserved. ${redact(String(error))}`;
      if (task.reason !== reason) this.state(task, 'needs_input', reason);
      return;
    }

    const recorded = this.store.db
      .prepare("SELECT data FROM events WHERE task_id=? AND run_id=? AND type='author.fixes_saved'")
      .all(task.id, save.runId)
      .map((event) => JSON.parse(String(event.data)) as { head: string; revision?: Revision });
    const previous = task.pendingAuthorHead;
    if (
      recorded.some(
        (value) =>
          value.head !== head || (value.revision && !sameRevision(value.revision, save.revision)),
      ) ||
      (task.pendingFix && !sameRevision(task.pendingFix.revision, save.revision)) ||
      (previous && previous !== head && (task.pendingFix || previous !== save.revision.head))
    ) {
      const conflicting = [
        ...new Set([...recorded.map((value) => value.head), ...(previous ? [previous] : [])]),
      ];
      const reason = `Conflicting evidence for fix run ${save.runId}: saved ${head}, previously recorded ${conflicting.join(', ')}. The recorded commit or starting revision disagrees with the save intent. The author copy and both records were preserved.`;
      if (task.reason !== reason) this.state(task, 'needs_input', reason);
      return;
    }

    if (save.checkpointTarget) {
      const pr = await this.provider(prRef(task)).getPR(prRef(task));
      if (
        !sameOpenTarget(save.pr, pr) ||
        !sameRevision(pr, save.checkpointTarget) ||
        pr.draft !== false ||
        pr.mergeConflict !== true ||
        !autoMergeEnabled(this.store, task)
      ) {
        this.state(
          task,
          'needs_input',
          `Conflict checkpoint ${head} was preserved. The PR or conflict repair conditions changed.`,
        );
        return;
      }
      await this.applyRepair(
        task,
        pr,
        { kind: 'repair', preparation: 'checkpoint' },
        {
          checkpoint: async () => head,
        },
      );
    } else if (head === save.revision.head && !task.pendingFix) {
      const pr = await this.provider(prRef(task)).getPR(prRef(task));
      if (!sameRevision(pr, save.revision) || !sameOpenTarget(save.pr, pr) || pr.draft) {
        this.state(task, 'needs_input', 'The PR changed after the worker saved no code changes.');
        return;
      }
      this.store.transaction(() => {
        this.recordFixSave(task, save.runId, head, recorded.length > 0);
        task.pendingAuthorHead = undefined;
        this.invalidate(task, pr, false);
        this.state(task, 'queued', noFixChanges);
      });
    } else {
      this.store.transaction(() => this.recordFixSave(task, save.runId, head, recorded.length > 0));
    }
  }

  private recordFixSave(task: Task, runId: string, head: string, alreadyRecorded = false) {
    const save = task.fixSave;
    delete task.fixSave;
    task.pendingAuthorHead = head;
    if (head !== task.revision!.head) {
      task.pendingFix ??= { revision: task.revision! };
      task.resumeState = 'awaiting_push';
      this.state(task, 'awaiting_push', 'Author saved the fixes; sending them to the PR');
    } else this.store.saveTask(task);
    if (!alreadyRecorded)
      this.store.event(
        task.id,
        'author.fixes_saved',
        {
          head,
          revision: task.revision,
          reviewId: task.review?.id,
          branch: (save?.pr ?? task.pr)?.branch,
          targetBranch: (save?.pr ?? task.pr)?.targetBranch,
          conflict: task.fixingMergeConflict,
        },
        runId,
      );
    if (save && !this.store.messageById(task.id, runId))
      this.store.message(task.id, 'author', 'agent', save.summary, runId, runId);
  }

  private async writeFixSave(
    task: Task,
    job: Job,
    summary: string,
    write: (task: Task, save?: FixSave) => Promise<string>,
    checkpoint?: PullRequest,
  ) {
    if (task.fixSave)
      throw new AppError('fix_save_pending', 'The previous local fix save needs reconciliation');
    const save =
      this.readFixSave && task.pr && task.revision
        ? {
            runId: job.id,
            generation: job.generation,
            revision: task.revision,
            pr: task.pr,
            ref: prRef(task),
            summary,
            checkpointTarget: checkpoint && revisionOf(checkpoint),
          }
        : undefined;
    if (save) {
      task.fixSave = save;
      this.store.saveTask(task);
    }
    try {
      return await write(task, save);
    } catch (error) {
      if (error instanceof AppError && error.code === 'fix_before_commit') {
        delete task.fixSave;
        this.store.saveTask(task);
      }
      throw error;
    }
  }

  async completeJob(
    job: Job,
    result: AgentResult,
    saveFix?: (task: Task, save?: FixSave) => Promise<string>,
  ) {
    return this.lock(job.taskId, async () => {
      const task = this.store.getTask(job.taskId);
      if (task.generation !== job.generation || task.state === 'paused') {
        this.store.event(task.id, 'job.stale_result', { generation: job.generation }, job.id);
        return;
      }
      if (
        saveFix &&
        job.kind === 'fix' &&
        result.status === 'completed' &&
        task.revision &&
        result.checkedHead === task.revision.head &&
        !result.disputedCommentIds?.length
      ) {
        if (!task.pendingFix) {
          const head = await this.writeFixSave(task, job, result.summary, saveFix);
          if (task.fixSave) {
            await this.settleFixSave(task, head);
            if (task.fixSave || head === result.checkedHead) return;
          } else this.store.transaction(() => this.recordFixSave(task, job.id, head));
        }
      } else if (job.kind === 'fix' && task.fixSave) {
        await this.settleFixSave(task);
        return;
      }
      if (isTicket(task)) {
        if (
          job.kind === 'plan' &&
          (task.state !== 'implementing' ||
            !task.planning ||
            task.planning.activeRunId !== (job.firstAttemptId ?? job.id) ||
            !!task.planning.result)
        )
          return;
        this.store.transaction(() => {
          this.store.message(task.id, job.role, 'agent', result.summary, job.id, job.id);
          const reportReview = job.kind === 'review';
          if (
            reportReview &&
            (!sameRevision(task.workerReport?.revision, task.revision) ||
              result.checkedHead !== task.revision?.head)
          ) {
            task.resumeState = 'reviewing';
            this.state(
              task,
              'needs_input',
              'The review used a different worker report or revision',
            );
          } else if (result.status !== 'completed' || result.checkedHead !== task.revision?.head) {
            task.resumeState = task.state;
            this.state(
              task,
              'needs_input',
              result.question || result.summary || 'The ticket turn was incomplete',
              requestsHumanInput(result) && result.checkedHead === task.revision?.head
                ? job
                : undefined,
            );
          } else if (reportReview) {
            task.resumeState = undefined;
            task.reviewFinished = true;
            this.state(task, 'complete', 'daddy verified the worker report');
          } else if (job.kind === 'plan') {
            if (!task.planning) return;
            if (!result.summary.trim()) {
              task.resumeState = 'implementing';
              this.state(task, 'needs_input', 'The planning step returned an empty plan.');
              return;
            }
            task.planning.result = {
              text: result.summary,
              runId: job.id,
              revision: { ...task.revision! },
            };
            this.store.event(task.id, 'task.plan_validated', { head: result.checkedHead }, job.id);
            this.queueImplementation(task, undefined, task.planning.instruction);
          } else if (job.kind === 'implement') {
            const head = task.pendingAuthorHead;
            const base = task.ticketRepository?.baseHead ?? task.revision?.base;
            // A resumed run can start on a saved commit that still needs submission.
            if (head && head !== base) {
              task.revision = { ...task.revision!, head };
              task.resumeState = 'ready_for_review';
              this.store.event(task.id, 'author.implementation_saved', { head }, job.id);
              this.state(
                task,
                'ready_for_review',
                'Implementation saved locally. Submit it to a native PR for the shared reviewer.',
              );
            } else {
              task.pendingAuthorHead = undefined;
              task.workerReport = { runId: job.id, revision: task.revision! };
              task.reviewerThreadId = undefined;
              task.summary = result.summary;
              this.queueReportReview(task);
            }
          } else {
            const pendingSubmission = !!this.store.db
              .prepare('SELECT 1 FROM operations WHERE id=?')
              .get('ticket-submit:' + task.id);
            this.state(
              task,
              pendingSubmission
                ? 'needs_input'
                : task.pendingAuthorHead
                  ? 'ready_for_review'
                  : 'discussing',
              pendingSubmission
                ? 'Submit again to reconcile the existing PR creation before changing implementation.'
                : task.pendingAuthorHead
                  ? 'Saved implementation is ready to submit for review.'
                  : 'Continue the conversation, or start implementation when the requirements are clear.',
            );
          }
        });
        return;
      }
      const pr = await this.provider(prRef(task)).getPR(prRef(task));
      if (job.kind === 'plan') {
        await this.finishReviewRecovery(task, job, result, pr);
        return;
      }
      if (job.kind === 'fix' && task.pendingFix) {
        if (!this.store.messageById(task.id, job.id))
          this.store.message(task.id, job.role, 'agent', result.summary, job.id, job.id);
        if (await this.checkSavedFix(task, pr)) {
          task.resumeState = 'awaiting_push';
          this.state(task, 'awaiting_push', 'Author saved the fixes; sending them to the PR');
        }
        return;
      }
      if (job.kind === 'verify_merge') {
        this.store.message(task.id, job.role, 'agent', result.summary, job.id, job.id);
        if (
          pr.state !== 'merged' ||
          !sameRevision(task.revision, pr) ||
          !samePullRequestTarget(task.pr, pr) ||
          pr.mergeCommit !== task.pr?.mergeCommit ||
          result.checkedHead !== pr.head
        ) {
          this.state(task, 'needs_input', 'The merged revision changed during verification');
        } else if (result.status !== 'completed') {
          this.state(
            task,
            'needs_input',
            result.question || result.summary,
            requestsHumanInput(result) ? job : undefined,
          );
        } else {
          let evidence: ReviewSnapshot[] | undefined;
          try {
            evidence = await this.currentFindingEvidence(task, job, true);
          } catch (error) {
            if (
              !(error instanceof AppError) ||
              !['published_review_unavailable', 'feedback_unconfirmed'].includes(error.code)
            )
              throw error;
            this.state(task, 'needs_input', error.message);
            return;
          }
          if (
            result.disputedCommentIds?.length ||
            !evidence ||
            this.hasUnverifiedFindings(task, new Set(result.verifiedCommentIds), evidence)
          ) {
            this.state(
              task,
              'needs_input',
              'Reviewer has not verified all previously published findings',
            );
            return;
          }
          task.summary = result.summary;
          task.pr = pr;
          task.verifiedMerge = {
            ...revisionOf(pr),
            mergeCommit: pr.mergeCommit,
            publishedFindingReviews: job.publishedFindingReviews,
            reviewFindingIds: job.reviewFindingIds,
            findingVersions: job.findingVersions,
            mergeFindingVersions: job.mergeFindingVersions,
          };
          await this.finish(task);
        }
        return;
      }
      if (job.kind === 'review' && (await this.stageReviewFindings(task, job, result, pr))) {
        this.store.message(task.id, job.role, 'agent', result.summary, job.id, job.id);
        return;
      }
      if (job.kind !== 'fix' && !sameRevision(task.revision, pr)) {
        if (
          job.kind === 'review' &&
          task.ref.provider === 'github' &&
          task.review &&
          pr.state === 'open'
        ) {
          await this.changeReviewRevision(task, pr);
          return;
        }
        this.invalidate(task, pr);
        this.state(
          task,
          'needs_input',
          'PR changed while the agent was working; its result did not advance the workflow',
        );
        return;
      }
      if (!this.store.messageById(task.id, job.id))
        this.store.message(task.id, job.role, 'agent', result.summary, job.id, job.id);
      if (pr.state !== 'open') {
        this.state(
          task,
          'needs_input',
          `PR is ${pr.state}; the agent result did not advance the task`,
        );
        return;
      }
      if (
        job.kind === 'fix' &&
        saveFix &&
        (await this.handOffIncompleteFix(task, result, pr, job, saveFix))
      )
        return;
      if (
        job.kind === 'chat' &&
        job.actionId &&
        sameRevision(task.revision, pr) &&
        task.deferredWorkerInstructions
      )
        task.deferredWorkerInstructions = task.deferredWorkerInstructions.filter(
          (entry) => entry.id !== job.actionId,
        );
      if (result.status !== 'completed') {
        task.resumeState = task.state;
        if (job.role === 'reviewer') task.reviewFinished = false;
        this.state(
          task,
          'needs_input',
          result.question || result.summary || 'Agent did not complete its work',
          requestsHumanInput(result) ? job : undefined,
        );
        return;
      }
      if (job.kind === 'review') {
        if (result.checkedHead !== task.revision?.head) {
          this.state(task, 'needs_input', 'Reviewer reported a different revision');
          return;
        }
        if (!sameOpenTarget(task.pr, pr)) {
          this.state(task, 'needs_input', 'The PR target changed during review.');
          return;
        }
        const snapshot = await this.provider(prRef(task)).getReview(prRef(task), task.review!);
        const verified = new Set(result.verifiedCommentIds ?? []);
        const evidence = await this.currentFindingEvidence(task, job, true);
        if (
          !evidence ||
          (!snapshot.comments.length && this.hasUnverifiedFindings(task, verified, evidence))
        ) {
          this.state(
            task,
            'needs_input',
            'Reviewer has not verified all previously published findings',
          );
          return;
        }
        task.summary = result.summary;
        task.snapshot = snapshot;
        if (snapshot.status !== 'draft') {
          this.state(
            task,
            'needs_input',
            'Review was published, removed or changed before the reviewer completed; inspect it before releasing feedback',
          );
          return;
        }
        if (task.draftRecheck) {
          if (!this.draftRechecked(task, job.id, snapshot)) {
            if (!task.draftRecheck.retried) {
              this.store.transaction(() => {
                task.draftRecheck!.retried = true;
                this.queueNativeReview(
                  task,
                  pr,
                  'Rechecking the existing draft on the updated target branch',
                  {
                    input: 'Finish rechecking the carried draft before publication.',
                  },
                );
              });
            } else {
              this.state(
                task,
                'needs_input',
                'Reviewer could not verify the carried draft on the updated target branch',
              );
            }
            return;
          }
          task.draftRecheck = undefined;
        }
        task.reviewLessonProof = await attestReviewLesson(this.store, task, job, snapshot);
        task.reviewFinished = true;
        task.completedReview = {
          runId: job.id,
          reviewId: task.review!.id,
          revision: task.revision!,
        };
        delete task.openReviewQuestion;
        const checked = this.findingVersions(evidence);
        for (const id of verified) {
          if (!Object.hasOwn(checked, id)) continue;
          this.store.decision(task, {
            commentId: id,
            commentVersion: checked[id],
            outcome: 'verified',
            reason: `Verified by the independent reviewer in round ${task.round}`,
          });
        }
        this.state(
          task,
          'awaiting_publication',
          `${snapshot.comments.length} draft comment(s) ready for discussion and publication`,
        );
      } else if (job.kind === 'fix') {
        if (result.checkedHead !== task.revision?.head) {
          this.state(
            task,
            'needs_input',
            'Author reported work against a different starting revision',
          );
          return;
        }
        if (result.disputedCommentIds?.length) {
          task.resumeState = 'fixing';
          this.state(
            task,
            'needs_input',
            disputedFindings,
            job,
            task.groupId && this.store.getGroup(task.groupId).orchestrated ? 'daddy' : undefined,
          );
          return;
        }
        if (
          sameRevision(task.ciRepairRevision, pr) &&
          (!task.pendingAuthorHead || task.pendingAuthorHead === pr.head)
        ) {
          this.state(
            task,
            'awaiting_review_checks',
            'Waiting for CI to pass after the worker investigated',
          );
          return;
        }
        if (
          sameRevision(pr, task.revision) &&
          task.pendingAuthorHead &&
          task.pendingAuthorHead !== task.revision?.head
        )
          this.state(task, 'awaiting_push', 'Author saved the fixes; sending them to the PR');
        else {
          const changed = !sameRevision(pr, task.revision);
          task.pendingAuthorHead = undefined;
          this.invalidate(task, pr, false);
          this.state(
            task,
            'queued',
            changed ? 'Author pushed changes; independent verification is next' : noFixChanges,
          );
        }
      } else {
        if (job.role === 'reviewer' && task.review) {
          const snapshot = await this.readReviewForReconciliation(task);
          if (!snapshot) return;
          task.snapshot = snapshot;
          task.summary = result.summary;
        }
        this.store.saveTask(task);
      }
    });
  }
  async action(
    id: string,
    action: 'pause' | 'resume' | 'approve-plan' | 'waive-checks' | 'reopen' | 'verify-merge',
    reason = '',
    expected?: ExpectedTask,
  ) {
    return this.lock(id, async () => {
      const task = this.store.getTask(id);
      if (task.groupId) {
        const group = this.store.getGroup(task.groupId);
        if (group.deletedAt || group.deletion)
          throw new AppError('session_deleting', 'This session is being deleted');
      }
      assertTaskVersion(task, expected);
      if (task.fixSave && action === 'reopen')
        throw new AppError(
          'fix_save_pending',
          'Resolve the pending local fix save before reopening.',
        );
      if (action === 'verify-merge') {
        const pr = await this.provider(prRef(task)).getPR(prRef(task));
        return this.queueMergeVerification(task, pr);
      }
      if (action === 'pause') {
        task.resumeState = task.state;
        task.generation++;
        this.store.cancelJobs(id);
        this.onCancel(id);
        this.state(task, 'paused', reason || 'Paused by the user');
      } else if (action === 'resume') {
        if (task.state !== 'paused' && task.state !== 'needs_input')
          throw new AppError('cannot_resume', 'This task is not paused or waiting for input');
        if (this.store.busy(id))
          throw new AppError('task_busy', 'Wait for the active session to finish');
        if (task.fixSave) {
          await this.settleFixSave(task);
          return task;
        }
        if (task.draftStart && !task.review) {
          this.state(task, 'queued', 'Waiting to retry the GitHub review draft');
          return task;
        }
        if (task.pendingFix && task.pendingAuthorHead) {
          if (
            await this.checkSavedFix(
              task,
              await this.provider(prRef(task)).getPR(prRef(task)),
              true,
            )
          ) {
            task.pendingFix.attempted = false;
            this.state(task, 'awaiting_push', 'Resuming submission of the saved fix');
          }
          return task;
        }
        if (isTicket(task)) {
          if (task.workerReport && ['queued', 'reviewing'].includes(task.resumeState ?? '')) {
            this.store.transaction(() => this.queueReportReview(task));
            return task;
          }
          if (task.resumeState === 'implementing')
            this.store.transaction(() =>
              this.queueImplementation(task, undefined, task.planning?.instruction),
            );
          else
            this.state(
              task,
              task.pendingAuthorHead ? 'ready_for_review' : 'discussing',
              'Resumed ticket work; existing changes were preserved',
            );
          return task;
        }
        if (
          task.reviewRecovery &&
          !task.reviewRecovery.plan &&
          task.reviewRecovery.reviewId === task.review?.id &&
          sameRevision(task.reviewRecovery.revision, task.revision)
        ) {
          this.store.transaction(() =>
            this.enqueueArchitect(task, task.reviewRecovery!, reason || undefined),
          );
          return task;
        }
        if (
          task.resumeState === 'awaiting_review_checks' ||
          (task.resumeState === 'fixing' && task.ciRepairRevision && !task.fixingMergeConflict)
        ) {
          if (task.resumeState === 'fixing') delete task.ciRepairRevision;
          this.state(task, 'awaiting_review_checks', 'Waiting for CI results before review');
          return task;
        }
        if (task.resumeState === 'awaiting_merge') {
          this.state(
            task,
            'awaiting_merge',
            'Review complete. Waiting for GitHub to merge the PR.',
          );
          return task;
        }
        if (task.resumeState === 'fixing' && task.fixingMergeConflict) {
          const pr = await this.provider(prRef(task)).getPR(prRef(task));
          const action = this.prAction(task, pr, { resumeRepair: true });
          if (action.kind !== 'repair')
            throw new AppError(
              action.kind === 'wait' ? 'automerge_disabled' : 'stale_revision',
              action.kind === 'wait'
                ? action.reason
                : 'The PR changed during conflict resolution. Inspect the preserved worker copy.',
            );
          await this.applyRepair(task, pr, action);
          return task;
        }
        if (
          task.resumeState === 'fixing' &&
          hasReleasedReview(task) &&
          task.snapshot?.status === 'published'
        ) {
          this.store.transaction(() => {
            this.state(task, 'fixing', 'Resuming the author against the published feedback');
            this.store.enqueue(
              task,
              'author',
              'fix',
              'Continue the interrupted fix. Inspect the managed workspace and preserve existing changes. Address the current published feedback.',
            );
            this.store.event(id, 'human.resume', { reason });
          });
          return task;
        }
        const target = task.review
          ? !task.reviewFinished
            ? 'needs_input'
            : task.snapshot?.status === 'published'
              ? 'awaiting_push'
              : 'awaiting_publication'
          : 'queued';
        if (this.reviewWaitingForResources(task)) {
          this.store.transaction(() => {
            delete task.resourcePause;
            this.state(task, target, resumedProviderState);
            this.store.event(id, 'human.resume', { reason });
          });
          return task;
        }
        this.state(task, target, resumedProviderState);
      } else if (action === 'approve-plan') {
        if (task.state !== 'awaiting_plan_approval' || task.kind !== 'plan')
          throw new AppError('plan_not_ready', 'This plan is not ready for approval');
        const current = await this.provider(prRef(task)).getPR(prRef(task));
        if (
          !sameRevision(current, task.revision) ||
          !samePullRequestTarget(task.pr, current) ||
          (task.verifiedMerge &&
            (current.state !== 'merged' || current.mergeCommit !== task.verifiedMerge.mergeCommit))
        )
          throw new AppError('stale_plan', 'The plan changed after review');
        if (
          !(await this.checkMergedFindings(task)) ||
          (!task.verifiedMerge && !(await this.confirmCompletedReview(task)))
        )
          return task;
        task.approvedAt = now();
        task.pr = current;
        this.store.saveTask(task);
        await this.finish(task);
      } else if (action === 'waive-checks') {
        if (!['awaiting_checks', 'awaiting_review_checks'].includes(task.state) || !reason.trim())
          throw new AppError(
            'waiver_invalid',
            'A waiver requires a reason and a task waiting for CI checks',
            400,
          );
        const current = await this.provider(prRef(task)).getPR(prRef(task));
        if (
          !sameRevision(current, task.revision) ||
          !samePullRequestTarget(task.pr, current) ||
          (task.verifiedMerge &&
            (current.state !== 'merged' || current.mergeCommit !== task.verifiedMerge.mergeCommit))
        )
          throw new AppError(
            'stale_revision',
            'The PR changed; a waiver cannot apply to a new revision',
          );
        task.checksWaivedAt = now();
        this.store.event(id, 'checks.waived', {
          reason,
          head: task.revision?.head,
        });
        if (task.state === 'awaiting_review_checks') this.store.saveTask(task);
        else await this.finish(task);
      } else {
        if (task.state !== 'complete')
          throw new AppError('not_complete', 'Only completed tasks can be reopened');
        if (isTicket(task)) {
          task.generation++;
          this.store.cancelJobs(id);
          this.onCancel(id);
          task.workerReport = undefined;
          task.reviewFinished = false;
          this.state(task, 'discussing', reason || 'Reopened by the user');
        } else {
          this.invalidate(task, task.pr);
          task.round = 0;
          this.state(task, 'queued', reason || 'Reopened by the user');
        }
      }
      this.store.event(id, `human.${action}`, { reason });
      return task;
    });
  }
  recoverInterruptedJobs() {
    for (const task of this.store.tasks()) {
      if (
        task.ref.provider === 'github' &&
        !task.review &&
        !task.draftStart &&
        task.revision &&
        !task.inputRequest &&
        task.state === 'needs_input' &&
        task.reason.startsWith(
          `AppError: POST /repos/${task.ref.repo}/pulls/${task.ref.number}/reviews: HTTP `,
        ) &&
        /: HTTP (?:408|500|502|503|504)\b/.test(task.reason)
      ) {
        const marker = `daddyloop:${task.id}:${task.generation}:${task.round + 1}`;
        const digest = createHash('sha256').update(JSON.stringify(task.revision)).digest('hex');
        if (
          this.store.db
            .prepare(
              "SELECT 1 FROM operations WHERE task_id=? AND id=? AND request=? AND status='pending'",
            )
            .get(task.id, marker, digest)
        ) {
          task.round++;
          task.draftStart = { marker, revision: task.revision, retry: false };
          if (task.pendingAuthorHead === task.revision.head) task.pendingFix = undefined;
          this.state(task, 'queued', 'Waiting to retry the GitHub review draft');
        }
      }
      if (
        task.ref.provider === 'github' &&
        task.state === 'needs_input' &&
        !task.inputRequest &&
        task.review &&
        (task.reviewFinished || task.partialReview) &&
        task.reason.startsWith(
          `AppError: POST /repos/${task.ref.repo}/pulls/${task.ref.number}/reviews/${task.review.id}/events: HTTP `,
        ) &&
        /: HTTP (?:408|500|502|503|504)\b/.test(task.reason) &&
        this.store.db
          .prepare("SELECT 1 FROM operations WHERE task_id=? AND id=? AND status='pending'")
          .get(task.id, task.review.marker + ':publish')
      ) {
        this.state(task, 'awaiting_publication', 'Waiting to retry GitHub review publication');
      }
      if (!task.latestClarification && task.state !== 'complete') {
        const review = this.store
          .jobs(task.id)
          .findLast((j) => j.kind === 'review' && j.input.startsWith(clarifiedReviewPrefix));
        if (review) {
          task.latestClarification = { text: review.input.slice(clarifiedReviewPrefix.length) };
          this.store.saveTask(task);
        }
      }

      // The outbox commits its receipt before sending the POST. A process can exit before
      // submit() records the response, so recover that window using the same request hash.
      if (
        isTicket(task) &&
        task.ref.provider === 'github' &&
        task.pendingAuthorHead &&
        !task.prLink &&
        task.resumeState === 'submitting' &&
        (task.state === 'submitting' ||
          (task.state === 'needs_input' && task.reason === interruptedSubmission)) &&
        this.store.db
          .prepare("SELECT 1 FROM operations WHERE id=? AND task_id=? AND status='pending'")
          .get('ticket-submit:' + task.id, task.id)
      ) {
        task.prLink = { generation: task.generation, head: task.pendingAuthorHead };
        this.state(
          task,
          'submitting',
          'Checking GitHub for the result of the previous PR creation',
        );
      }
      if (task.state !== 'needs_input' || task.inputRequest) continue;
      const job = this.store.jobs(task.id).at(-1);
      if (
        !task.fixSave &&
        job?.status === 'failed' &&
        job.error === task.reason &&
        task.resumeState === 'fixing' &&
        !this.store.busy(task.id) &&
        this.queueConflictContinuation(task, job)
      )
        continue;
      if (!job || job.status !== 'completed' || job.generation !== task.generation) continue;
      const result = this.recordedAgentResult(task.id, job.id);
      if (
        result &&
        requestsHumanInput(result) &&
        result.checkedHead === task.revision?.head &&
        (result.question || result.summary) === task.reason
      ) {
        this.state(task, 'needs_input', task.reason, job);
      }
    }
    for (const task of this.store.tasks())
      if (
        task.state === 'submitting' &&
        !(
          task.prLink?.generation === task.generation && task.prLink.head === task.pendingAuthorHead
        )
      )
        this.state(task, 'needs_input', interruptedSubmission);
    for (const job of this.store.jobs())
      if (
        job.status === 'running' ||
        (job.status === 'cancelled' &&
          job.errorCode !== 'review_admission_changed' &&
          job.generation === this.store.getTask(job.taskId).generation &&
          ['reviewing', 'fixing'].includes(this.store.getTask(job.taskId).state))
      ) {
        const pending = this.store.getTask(job.taskId);
        if (
          job.kind === 'plan' &&
          !isTicket(pending) &&
          pending.state === 'fixing' &&
          pending.generation === job.generation &&
          pending.reviewRecovery?.runId === (job.firstAttemptId ?? job.id) &&
          !pending.reviewRecovery.plan
        ) {
          job.status = 'queued';
          delete job.finishedAt;
          delete job.startedAt;
          this.store.saveJob(job);
          this.store.event(
            pending.id,
            'review.architect_resumed',
            { reviewId: pending.reviewRecovery.reviewId },
            job.id,
          );
          continue;
        }
        job.status = 'failed';
        job.error = interruptedByRestart;
        job.errorCode = 'server_restarted';
        job.finishedAt = now();
        this.store.saveJob(job);
        const task = this.store.getTask(job.taskId);
        if (task.state === 'awaiting_push' && task.pendingFix && task.pendingAuthorHead) continue;
        task.resumeState = task.state;
        task.generation++;
        this.store.cancelJobs(task.id);
        this.state(task, 'needs_input', job.error);
        this.store.event(task.id, 'job.interrupted', {}, job.id);
      }
  }
  async interruptTask(id: string, reason: string, source: string) {
    return this.lock(id, async () => {
      const task = this.store.getTask(id);
      if (task.state === 'paused' || !this.store.busy(id)) return;
      const reviewerActive = this.store
        .jobs(id)
        .some((j) => j.role === 'reviewer' && j.status === 'running');
      task.resumeState = task.state;
      task.generation++;
      if (reviewerActive) task.reviewFinished = false;
      if (source === 'resource.pause')
        task.resourcePause = { generation: task.generation, at: now() };
      this.store.cancelJobs(id);
      this.onCancel(id);
      this.state(task, 'needs_input', reason);
      this.store.event(id, source, { reason });
    });
  }
  async restorePendingConflict(
    id: string,
    pendingBase: (task: Task) => Promise<string | undefined>,
  ) {
    return this.lock(id, async () => {
      const task = this.store.getTask(id);
      if (
        task.state !== 'needs_input' ||
        task.resumeState !== 'fixing' ||
        !task.fixingMergeConflict ||
        task.inputRequest ||
        task.fixSave ||
        task.pendingFix ||
        task.review ||
        !task.revision ||
        !autoMergeEnabled(this.store, task) ||
        this.store.busy(id)
      )
        return;
      const last = this.store.jobs(id).at(-1);
      if (
        last?.kind !== 'fix' ||
        last.status !== 'failed' ||
        last.generation !== task.generation ||
        last.error !== task.reason ||
        last.errorCode !== 'workspace_diverged'
      )
        return;
      const base = await pendingBase(task);
      if (!base || base === task.revision.base) return;
      // Older versions could start a fresh review after a timeout and repin the task
      // while the original merge was still open. Only restore a recorded repair revision.
      const row = this.store.db
        .prepare(
          `
        SELECT json_extract(r.data,'$.revision') revision FROM events r
        JOIN jobs j ON j.task_id=r.task_id AND json_extract(j.data,'$.generation')=json_extract(r.data,'$.generation')
        WHERE r.task_id=? AND r.type='revision.changed' AND json_extract(r.data,'$.revision.head')=?
          AND json_extract(r.data,'$.revision.base')=? AND j.status='failed'
          AND json_extract(j.data,'$.kind')='fix' AND json_extract(j.data,'$.errorCode')='run_timeout'
          AND EXISTS (SELECT 1 FROM events e WHERE e.task_id=r.task_id AND e.type='task.state'
            AND json_extract(e.data,'$.generation')=json_extract(r.data,'$.generation')
            AND json_extract(e.data,'$.reason')='Worker assigned to resolve the GitHub merge conflict')
        ORDER BY r.id DESC LIMIT 1`,
        )
        .get(id, task.revision.head, base);
      if (typeof row?.revision !== 'string') return;
      const pinned = JSON.parse(row.revision) as Revision;
      const provider = this.provider(prRef(task)),
        pr = await provider.getPR(prRef(task));
      if (
        !sameOpenTarget(task.pr, pr) ||
        pr.draft !== false ||
        pr.head !== pinned.head ||
        !(await provider.targetAdvanced?.(prRef(task), pinned.base, pr.base)) ||
        !autoMergeEnabled(this.store, task)
      )
        return;
      this.store.transaction(() => {
        task.revision = pinned;
        task.generation++;
        this.store.event(task.id, 'revision.changed', {
          revision: pinned,
          generation: task.generation,
        });
        this.enqueueConflictContinuation(task, last);
      });
    });
  }
  private queueConflictContinuation(task: Task, job: Job) {
    if (
      job.kind !== 'fix' ||
      job.role !== 'author' ||
      job.errorCode !== 'run_timeout' ||
      task.generation !== job.generation ||
      !task.fixingMergeConflict ||
      task.pendingFix ||
      !task.authorWorktree ||
      !autoMergeEnabled(this.store, task)
    )
      return false;
    this.store.transaction(() => this.enqueueConflictContinuation(task, job));
    return true;
  }
  private enqueueConflictContinuation(task: Task, job: Job) {
    this.store.saveJob(job);
    this.state(
      task,
      'fixing',
      'Continuing conflict resolution in the saved worker copy after a timeout',
    );
    const retry = this.store.enqueue(
      task,
      'author',
      'fix',
      'Continue the interrupted conflict repair in the same working copy. Inspect the partial resolution, finish the remaining files and run the checks.',
    );
    retry.timeoutRetry = true;
    retry.notBefore = new Date(Date.now() + (job.timeoutRetry ? 300000 : 30000)).toISOString();
    this.store.saveJob(retry);
    this.store.event(
      task.id,
      'conflict.timeout_retry',
      { previousRun: job.id, notBefore: retry.notBefore },
      retry.id,
    );
  }
  failJob(job: Job, error: unknown) {
    const task = this.store.getTask(job.taskId);
    if (task.generation !== job.generation || task.state === 'paused') return;
    task.resumeState = task.state;
    if (job.role === 'reviewer') task.reviewFinished = false;
    const reason = redact(String(error));
    if (!task.fixSave && task.state === 'fixing' && this.queueConflictContinuation(task, job))
      return;
    if (job.kind === 'fix' && task.pendingFix && task.pendingAuthorHead) {
      task.resumeState = 'awaiting_push';
      this.state(
        task,
        'needs_input',
        `Saved fix ${task.pendingAuthorHead} is preserved. ${reason}`,
      );
    } else {
      this.state(task, 'needs_input', reason);
    }
    this.store.event(task.id, 'job.failed', { error: redact(String(error)) }, job.id);
  }
  defaultAgents(): AgentProfiles {
    return this.store.setting<AgentProfiles>('agents.defaults') ?? inheritedProfiles();
  }
  effectiveAgents(task: Task): AgentProfiles {
    return {
      ...this.defaultAgents(),
      ...task.agents,
      ...(task.groupId ? { daddy: this.store.getGroup(task.groupId).daddy } : {}),
    };
  }
  setDefaultAgents(profiles: AgentProfiles) {
    this.store.setSetting('agents.defaults', profiles);
    return profiles;
  }
  applyAuthorProfile(task: Task, profile: AgentProfile) {
    const agents = this.effectiveAgents(task);
    if (agents.worker.engine !== profile.engine) {
      this.store.event(task.id, 'agent.engine_changed', {
        previous: agents.worker.engine,
        current: profile.engine,
        thread: task.authorThreadId,
      });
      task.authorThreadId = undefined;
    }
    task.agents = { ...agents, worker: profile };
  }

  /** Called under the task lock and in the same transaction as the slot update. */
  reconfigureTaskRuns(
    task: Task,
    role: Job['role'],
    profile: AgentProfile,
    canInterrupt: (id: string) => boolean,
  ) {
    const jobs = this.store.activeJobs(task.id).filter((job) => job.generation === task.generation);
    const previous = jobs.find(
      (job) =>
        job.role === role &&
        job.kind !== 'plan' &&
        job.status === 'running' &&
        canInterrupt(job.id) &&
        !sameAgentProfile(job.profile, profile),
    );
    if (previous) task.generation++;
    if (role === 'author') {
      this.applyAuthorProfile(task, profile);
      if (task.workerRequest?.profile) task.workerRequest.profile = profile;
    }
    this.store.saveTask(task);

    for (const job of jobs) {
      if (job.status !== 'queued') continue;
      job.generation = task.generation;
      if (job.role === role && job.kind !== 'plan') job.profile = profile;
      this.store.saveJob(job);
    }
    if (!previous) return false;

    this.store.saveJob({ ...previous, status: 'cancelled', finishedAt: now() });
    const resumed: Job = {
      ...previous,
      id: randomUUID(),
      firstAttemptId: previous.firstAttemptId ?? previous.id,
      generation: task.generation,
      profile,
      status: 'queued',
      startedAt: undefined,
      firstStartedAt: undefined,
      finishedAt: undefined,
      threadId: undefined,
      turnId: undefined,
      notBefore: undefined,
      error: undefined,
      createdAt: now(),
    };
    this.store.saveJob(resumed);
    this.store.event(
      task.id,
      'job.queued',
      {
        role: resumed.role,
        kind: resumed.kind,
        replaces: previous.id,
      },
      resumed.id,
    );
    return true;
  }

  async setTaskAgent(id: string, role: 'author' | 'reviewer', profile: AgentProfile) {
    const existing = this.store.getTask(id);
    return this.lock(
      existing.groupId && role === 'reviewer' ? `group:${existing.groupId}` : id,
      async () => {
        const task = this.store.getTask(id);
        if (role === 'reviewer' && task.groupId) {
          if (
            this.store
              .jobs()
              .some(
                (job) =>
                  job.groupId === task.groupId &&
                  job.role === 'reviewer' &&
                  ['queued', 'running'].includes(job.status),
              )
          )
            throw new AppError(
              'reviewer_busy',
              'Wait for the shared reviewer queue to become idle before changing its model',
            );
          const group = this.store.getGroup(task.groupId);
          if (group.daddy.engine !== profile.engine) {
            this.store.event(id, 'agent.engine_changed', {
              previous: group.daddy.engine,
              current: profile.engine,
              coordination: group.daddyThreadId,
              review: group.reviewerThreadId,
            });
            group.daddyThreadId = undefined;
            group.reviewerThreadId = undefined;
          }
          group.daddy = profile;
          group.generation++;
          this.store.saveGroup(group);
        } else {
          if (this.store.busy(id))
            throw new AppError(
              'task_busy',
              'Wait for this task to become idle before changing its model',
            );
          if (role === 'author') {
            this.applyAuthorProfile(task, profile);
            if (task.workerRequest) task.workerRequest.profile = profile;
          } else {
            const agents = this.effectiveAgents(task);
            if (agents.daddy.engine !== profile.engine) {
              this.store.event(id, 'agent.engine_changed', {
                previous: agents.daddy.engine,
                current: profile.engine,
                thread: task.reviewerThreadId,
              });
              task.reviewerThreadId = undefined;
            }
            task.agents = { ...agents, daddy: profile };
          }
          task.contextVersion++;
          task.generation++;
          this.store.saveTask(task);
        }
        this.store.event(id, 'agents.updated', {
          role,
          profile,
          groupId: role === 'reviewer' ? task.groupId : undefined,
        });
        return this.effectiveAgents(this.store.getTask(id));
      },
    );
  }
  async createTicket(input: {
    replyTo?: Task['replyTo'];
    ref: TicketRef;
    source: TicketSource;
    repoPath: string;
    repository: NonNullable<Task['ticketRepository']>;
    requirements?: string;
    parentTaskId?: string;
    agents?: AgentProfiles;
    groupId?: string;
    groupGeneration?: number;
    workspaceId?: string;
    scope?: string;
    workspaceIsolation?: Workspace['copyMode'];
    createdByAction?: string;
    dependsOn?: string[];
    workerRequest?: WorkerRequest;
    startImplementation?: boolean;
    architectProfile?: AgentProfile;
    reportOnly?: boolean;
    validatePlan?: boolean;
    id?: string;
  }) {
    if (
      this.store
        .tasks()
        .some((task) => task.source?.url === input.source.url && task.state !== 'complete')
    )
      throw new AppError('already_attached', 'This ticket already has an active task');
    const parent = input.parentTaskId ? this.store.getTask(input.parentTaskId) : undefined;
    const create = async () => {
      if (
        this.store
          .tasks()
          .some((task) => task.source?.url === input.source.url && task.state !== 'complete')
      )
        throw new AppError('already_attached', 'This ticket already has an active task');
      const parent = input.parentTaskId ? this.store.getTask(input.parentTaskId) : undefined;
      let group: ReviewGroup;
      if (input.groupId) {
        group = this.store.getGroup(input.groupId);
        if (group.deletedAt || group.deletion)
          throw new AppError('session_deleting', 'This session is being deleted');
        if (input.groupGeneration !== undefined && group.generation !== input.groupGeneration)
          throw new AppError(
            'stale_daddy',
            'The daddy session changed while the ticket was being imported',
          );
        if (parent?.groupId && parent.groupId !== group.id)
          throw new AppError('wrong_session', 'The parent belongs to another daddy session');
      } else if (parent?.groupId) group = this.store.getGroup(parent.groupId);
      else if (parent) {
        if (this.store.busy(parent.id))
          throw new AppError(
            'task_busy',
            'Wait for the parent to become idle before creating its shared review group',
          );
        group = {
          id: randomUUID(),
          rootTaskId: parent.id,
          title: parent.title,
          requirements: parent.requirements,
          source: parent.source,
          daddy: this.effectiveAgents(parent).daddy,
          reviewerThreadId: parent.reviewerThreadId,
          generation: 1,
          createdAt: now(),
          updatedAt: now(),
        };
        parent.groupId = group.id;
      } else
        group = {
          id: randomUUID(),
          rootTaskId: '',
          title: input.source.title,
          source: input.source,
          requirements: input.requirements ?? (input.source.body || input.source.title),
          daddy: input.agents?.daddy ?? this.defaultAgents().daddy,
          generation: 1,
          createdAt: now(),
          updatedAt: now(),
        };
      if (group.deletedAt || group.deletion)
        throw new AppError('session_deleting', 'This session is being deleted');
      if (input.startImplementation) {
        if (group.daddyState === 'paused' || group.daddyState === 'archived')
          throw new AppError('daddy_paused', 'Resume daddy before sending another message');
        const slot = input.workerRequest?.slot;
        const capacity = group.requestedWorkerLimit ?? group.workerLimit ?? 1;
        if (slot !== undefined && (!Number.isInteger(slot) || slot < 1 || slot > capacity))
          throw new AppError('unknown_worker', 'Choose a worker from this session', 422);
      }
      if (
        (parent || input.groupId) &&
        input.agents?.daddy &&
        (['engine', 'model', 'effort'] as const).some(
          (key) => input.agents!.daddy[key] !== group.daddy[key],
        )
      )
        throw new AppError(
          'shared_reviewer',
          'Child tickets inherit the group reviewer; change it in the group model settings',
        );
      const task: Task = {
        id: input.id ?? randomUUID(),
        title: input.source.title,
        kind: 'code',
        planning: input.validatePlan ? {} : undefined,
        architectProfile: input.architectProfile,
        reportOnly: input.reportOnly || undefined,
        ref: input.ref,
        source: input.source,
        repoPath: input.repoPath,
        ticketRepository: input.repository,
        replyTo: input.replyTo,
        requirements: input.requirements ?? (input.source.body || input.source.title),
        parentTaskId: parent?.id,
        groupId: group.id,
        workspaceId: input.workspaceId ?? group.workspaceId,
        scope: input.scope,
        workspaceIsolation: input.workspaceIsolation ?? group.workspace?.copyMode,
        createdByAction: input.createdByAction,
        dependsOn: input.dependsOn,
        agents: {
          worker:
            input.workerRequest?.profile ??
            input.agents?.worker ??
            group.worker ??
            this.defaultAgents().worker,
          daddy: group.daddy,
        },
        workerRequest: group.orchestrated
          ? (input.workerRequest ?? { profile: input.agents?.worker })
          : undefined,
        policy: { ...defaultPolicy },
        state: 'discussing',
        reason: group.orchestrated
          ? 'Waiting for daddy to assign this task.'
          : 'Ticket imported. The author is reading it before implementation.',
        generation: 1,
        contextVersion: 1,
        round: 0,
        noProgress: 0,
        summary: '',
        revision: {
          head: input.repository.baseHead,
          base: input.repository.baseHead,
          start: input.repository.baseHead,
        },
        createdAt: now(),
        updatedAt: now(),
      };
      task.ticketRepository!.branch = `daddyloop/${task.id}`;
      group.rootTaskId ||= task.id;
      this.store.transaction(() => {
        this.store.saveGroup(group);
        if (parent) this.store.saveTask(parent);
        this.store.saveTask(task);
        this.store.event(task.id, 'ticket.imported', {
          source: input.source.url,
          groupId: group.id,
          parentTaskId: parent?.id,
          dispatched: input.startImplementation,
        });
        if (input.startImplementation) this.queueImplementation(task, input.createdByAction);
        else if (!group.orchestrated)
          this.store.enqueue(
            task,
            'author',
            'chat',
            'Read the ticket and inspect the repository. Explain your understanding, an implementation approach, and any concrete questions. This is discussion only; do not edit files yet.',
          );
      });
      return task;
    };
    return parent ? this.lock(parent.id, create) : create();
  }
  async implement(
    id: string,
    actionId?: string,
    instruction?: string,
    validatePlan?: boolean,
    architectProfile?: AgentProfile,
  ) {
    return this.lock(id, async () => {
      const task = this.store.getTask(id);
      if (!isTicket(task))
        throw new AppError(
          'already_in_review',
          'This task already has a PR; use the review/fix cycle',
        );
      if (this.store.db.prepare('SELECT 1 FROM operations WHERE id=?').get('ticket-submit:' + id))
        throw new AppError(
          'submission_pending',
          'Reconcile the existing PR submission before changing implementation again',
        );
      if (task.state === 'paused' || this.store.busy(id))
        throw new AppError(
          'task_busy',
          'Resume or wait for the current discussion before implementing',
        );
      this.store.transaction(() => {
        if (architectProfile) task.architectProfile = architectProfile;
        if (validatePlan === true) task.planning ??= {};
        if (validatePlan === false && !sameRevision(task.planning?.result?.revision, task.revision))
          delete task.planning;
        this.queueImplementation(task, actionId, instruction);
      });
      return task;
    });
  }
  async checkImplementationPlan(job: Job) {
    return this.lock(job.taskId, async () => {
      const task = this.store.getTask(job.taskId);
      if (task.generation !== job.generation || task.state !== 'implementing') return false;
      if (!task.planning || sameRevision(task.planning.result?.revision, task.revision))
        return true;
      this.store.transaction(() =>
        this.queueImplementation(task, undefined, task.planning?.instruction),
      );
      return false;
    });
  }
  private queueImplementation(task: Task, actionId?: string, instruction?: string) {
    if (task.workerReport) {
      task.workerReport = undefined;
      task.reviewFinished = false;
      task.summary = '';
    }
    task.resumeState = 'implementing';
    if (task.planning && !sameRevision(task.planning.result?.revision, task.revision)) {
      delete task.planning.result;
      if (instruction) task.planning.instruction = instruction;
      this.state(task, 'implementing', 'Checking architecture and implementation plan');
      const plan = this.store.enqueue(
        task,
        'author',
        'plan',
        task.planning.instruction ?? 'Validate the task plan before implementation.',
        actionId,
      );
      task.planning.activeRunId = plan.id;
      this.store.saveTask(task);
      return;
    }
    this.state(task, 'implementing', 'The worker is carrying out the task');
    this.store.enqueue(
      task,
      'author',
      'implement',
      instruction ??
        'Carry out the task according to the original requirements and discussion. Verify the outcome and report what was accomplished. The service saves any code changes and handles submission. Do not commit, push or create a PR yourself.',
      actionId,
    );
  }
  async retryTicket(id: string) {
    const task = this.store.getTask(id);
    if (!isTicket(task) || task.workerReport) return this.review(id, true);
    if (this.store.db.prepare('SELECT 1 FROM operations WHERE id=?').get('ticket-submit:' + id))
      throw new AppError(
        'submission_pending',
        `Open the task report in the daddy session and use Submit for review to reconcile the existing PR.`,
      );
    if (task.state === 'paused' || this.store.busy(id))
      throw new AppError('task_busy', 'Resume or wait for the current task before retrying');
    const previous = this.store
      .jobs(id)
      .filter((job) => ['failed', 'cancelled'].includes(job.status))
      .at(-1);
    if (previous?.kind === 'implement' || previous?.kind === 'plan') return this.implement(id);
    return this.lock(id, async () => {
      const current = this.store.getTask(id);
      if (!isTicket(current) || current.state === 'paused' || this.store.busy(id))
        throw new AppError('task_busy', 'The task changed before the retry');
      this.state(current, 'discussing', 'Retrying the ticket conversation');
      this.store.enqueue(
        current,
        previous?.role ?? 'author',
        'chat',
        previous?.input ??
          'Continue discussing the ticket and explain the next steps. Do not edit files yet.',
      );
      return current;
    });
  }
  async linkPR(id: string, ref: PRRef, expectedGeneration?: number, expectedHead?: string) {
    return this.lock(id, async () => {
      const task = this.store.getTask(id);
      if (
        !isTicket(task) ||
        this.store.busy(id) ||
        task.state === 'paused' ||
        (expectedGeneration !== undefined && task.generation !== expectedGeneration)
      )
        throw new AppError(
          'task_busy',
          'Only an unchanged, idle ticket task can be connected to a PR',
        );
      if (
        ref.provider !== task.ref.provider ||
        ref.host !== task.ref.host ||
        ref.repo.toLowerCase() !== task.ref.repo.toLowerCase()
      )
        throw new AppError(
          'repository_mismatch',
          'The PR must belong to this task’s configured repository',
        );
      if (expectedHead && task.pendingAuthorHead !== expectedHead)
        throw new AppError(
          'submitted_head_changed',
          'The task now has a different saved commit. Inspect the submission before connecting.',
        );
      const pr = await this.provider(ref).getPR(ref);
      if (expectedHead && pr.head !== expectedHead)
        throw new AppError(
          'submitted_head_changed',
          'The PR does not point to the submitted implementation; inspect it before connecting',
        );
      if (
        ref.provider === 'github' &&
        task.ticketRepository &&
        (pr.branch !== task.ticketRepository.branch ||
          pr.targetBranch !== task.ticketRepository.baseBranch)
      )
        throw new AppError(
          'submitted_branch_changed',
          'The PR branches changed after submission; inspect it before connecting.',
        );
      if (pr.state !== 'open') throw new AppError('pr_closed', 'Connect an open PR');
      if (
        this.store
          .tasks()
          .some(
            (other) => other.id !== id && other.ref.url === ref.url && other.state !== 'complete',
          )
      )
        throw new AppError('already_attached', 'This PR is already attached');
      task.ref = ref;
      delete task.prLink;
      task.pr = pr;
      task.revision = revisionOf(pr);
      task.generation++;
      task.review = undefined;
      task.snapshot = undefined;
      task.reviewFinished = false;
      task.round = 0;
      this.state(task, 'queued', 'PR connected. The shared reviewer will check this revision.');
      this.store.event(id, 'ticket.pr_connected', { ref });
      return task;
    });
  }
}
