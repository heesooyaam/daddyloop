import { setTimeout as delaySavedFixReceipt } from 'node:timers/promises';
import {
  nextPrAction,
  completionGate,
  hasReleasedReview,
  sameOpenTarget,
  staleConflictPreparation,
  type PrAction,
  type PrEvidence,
} from './pr-routing.js';
import { draftInspectionRequired, draftSyncPending } from './task-activity.js';
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
  type ReviewGroup,
  type TicketSource,
  type TicketRef,
  type PRTask,
  defaultPolicy,
  now,
  sameRevision,
  reviewTargetChange,
  missingReviewTargetReason,
  sameAgentProfile,
  revisionOf,
  type Task,
  type PRRef,
  type PullRequest,
  type Revision,
  type ReviewHandle,
  type ReviewSnapshot,
  type State,
  type Policy,
  type Job,
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
const noAuthorChanges =
  'Author made no code changes; independent verification of the decisions is next';
const authorPushedChanges = 'Author pushed changes; independent verification is next';
const staleDraftReason =
  'GitHub still has a draft from the previous review. Inspect it on GitHub and clear the pending review before resuming.';
const gitLabDraftReason =
  'GitLab still has draft or partially published notes from the previous review. Inspect them on GitLab and resolve the pending notes before retrying.';
const arcanumDraftReason =
  'Arcanum review notes still need inspection. Publish or discard the remaining drafts before retrying.';
const fixConfirmationGraceMs = 60_000;
const reviewCompletionStates: State[] = [
  'awaiting_publication',
  'awaiting_checks',
  'awaiting_plan_approval',
];

interface LostFix {
  head: string;
  revision?: Revision;
  targetBranch?: string;
  generation: number;
  authorCompleted: boolean;
}

type SavedFixCheck =
  | { status: 'ready' | 'waiting' }
  | { status: 'confirmed'; original: Revision }
  | { status: 'blocked'; reason: string };

function unknownFixTarget(task: Task, current?: PullRequest) {
  const created = task.ticketRepository?.baseBranch ?? 'unknown';
  const stored = task.pr?.targetBranch ?? 'unknown';
  const observed = current
    ? ` Observed PR head ${current.head} and target branch ${current.targetBranch}.`
    : '';
  return `The original PR target branch could not be verified from the author run. Target branch at creation ${created}. Stored target branch ${stored}.${observed}`;
}

function parseRecordedRevision(value: unknown): Revision | undefined {
  return typeof value === 'string' ? (JSON.parse(value) as Revision) : undefined;
}

function savedFixBaseChange(original: Revision, pr: PullRequest): string | undefined {
  if (pr.base !== original.base || pr.start !== original.start)
    return `The PR comparison base changed. Original base ${original.base} (start ${original.start}). Observed base ${pr.base} (start ${pr.start}).`;
}

function savedFixTargetChange(expected: string | undefined, pr: PullRequest): string | undefined {
  if (pr.state === 'open' && expected && pr.targetBranch !== expected)
    return `The PR target branch changed. Expected ${expected}. Observed ${pr.targetBranch}.`;
}

function hasSharedDraftSlot(task: Task): boolean {
  return ['github', 'gitlab', 'arcadia'].includes(task.ref.provider);
}

function retainPublishedFeedback(
  task: Task,
  snapshot: ReviewSnapshot,
  carryPrior = !task.reviewFinished,
) {
  // A removed summary or dismissed review can still have published findings.
  if (
    snapshot.status === 'missing' &&
    snapshot.comments.length &&
    (snapshot.dismissed || task.ref.provider === 'gitlab' || task.ref.provider === 'arcadia')
  )
    snapshot = { ...snapshot, status: 'published' };
  if (snapshot.status !== 'published') return;
  if (task.feedback && carryPrior) {
    const comments = new Map(task.feedback.comments.map((comment) => [comment.id, comment]));
    for (const comment of snapshot.comments) comments.set(comment.id, comment);
    task.feedback = { ...snapshot, comments: [...comments.values()] };
  } else task.feedback = snapshot;
}

function lostFixRecoveryBlock(fix: LostFix, task: Task) {
  const storedBase = task.revision?.base ?? 'unknown';
  if (!fix.revision)
    return `The original PR revision for saved fix ${fix.head} is unavailable. Stored PR base ${storedBase}.`;
  if (!fix.targetBranch)
    return `${unknownFixTarget(task)} Saved fix ${fix.head} is preserved. Original base ${fix.revision.base}. Stored PR base ${storedBase}.`;
  if (!sameRevision(fix.revision, task.revision))
    return `The stored PR revision changed for saved fix ${fix.head}. Original base ${fix.revision.base}. Stored PR base ${storedBase}.`;
  if (!fix.authorCompleted)
    return `The author run did not record completion. Inspect saved fix ${fix.head} before continuing.`;
  if (fix.generation !== task.generation)
    return `Saved fix ${fix.head} belongs to an earlier task generation. Resolve it before starting another review.`;
}

function changedBeforeRecovery(pr: PullRequest) {
  return `The PR revision or branch changed before recovery. Observed PR head ${pr.head}, base ${pr.base}, and target branch ${pr.targetBranch}.`;
}

function samePullRequestBranches(
  expected: PullRequest | undefined,
  current: PullRequest,
  targetBranch = expected?.targetBranch,
) {
  return (
    current.state === 'open' &&
    expected?.branch === current.branch &&
    targetBranch === current.targetBranch &&
    expected.cloneUrl === current.cloneUrl
  );
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
    !!(task.pendingFix || task.pendingAuthorFix) &&
    !!task.pendingAuthorHead &&
    task.pendingAuthorHead === task.revision?.head &&
    task.review.revision.head !== task.pendingAuthorHead &&
    task.reason ===
      `Saved fix ${task.pendingAuthorHead} is on the PR. Inspect the earlier draft review ${task.review.id} before starting another review.`
  );
}

export class Engine {
  readonly broker: Broker;
  private locks = new Map<string, Promise<unknown>>();
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
  private state(task: Task, state: State, reason: string, request?: Job) {
    task.inputRequest = request
      ? { runId: request.id, role: request.role, generation: task.generation }
      : undefined;
    task.state = state;
    task.reason = reason;
    this.store.saveTask(task);
    this.store.event(task.id, 'task.state', {
      state,
      reason,
      generation: task.generation,
      head: task.revision?.head,
    });
  }
  requireSubmittedFix(task: Task, pr?: PullRequest): string | undefined {
    const pending = this.pendingFixHead(task, pr);
    if (
      pending &&
      task.pendingAuthorFix?.generation === task.generation &&
      this.isConfirmedSavedFix(task, pending)
    )
      return pending;
    const lost = pending ? undefined : this.lostFix(task, pr);
    const unsent = pending ?? lost?.head;
    if (unsent) {
      const reason = pr && this.savedFixReviewReason(task, unsent, pr);
      const recovery =
        (lost && lostFixRecoveryBlock(lost, task)) ??
        `Resume the task to confirm saved fix ${unsent} before review.`;
      throw new AppError('fix_pending', reason ? `${reason} ${recovery}` : recovery);
    }
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
      const provider = this.provider(prRef(task));
      if (task.draftStart?.retryAt && task.draftStart.retryAt > Date.now()) return task;
      const pr = await provider.getPR(prRef(task));
      if (retry && pr.state === 'merged') return this.queueMergeVerification(task, pr);
      await this.refreshConfirmedFixBase(task, pr);
      const pending = this.requireSubmittedFix(task, pr);
      const legacySave =
        retry && !pending && task.reviewFinished && task.review
          ? this.savedFixEvent(task, pr.head)
          : undefined;
      const confirmedLegacyRetry =
        legacySave &&
        typeof legacySave.saved_revision !== 'string' &&
        this.legacyFixConfirmed(
          task,
          pr,
          pr.head,
          Number(legacySave.id),
          parseRecordedRevision(legacySave.revision),
          typeof legacySave.target_branch === 'string' ? legacySave.target_branch : undefined,
        );
      if (pending && (!sameRevision(task.revision, pr) || !samePullRequestBranches(task.pr, pr))) {
        const check = this.savedFixStatus(task, pr, pending);
        const reason =
          check.status === 'blocked'
            ? check.reason
            : 'The PR changed after submission and before review.';
        this.blockSavedFix(task, pending, reason);
        return task;
      }
      if (task.draftStart) {
        retry ||= task.draftStart.retry;
        clarification ??= task.draftStart.clarification;
        if (
          !sameRevision(task.draftStart.revision, pr) ||
          !sameOpenTarget(task.pr, pr) ||
          pr.draft ||
          this.prAction(task, pr).kind === 'repair'
        )
          return this.settleMovedDraftStart(task, pr, provider);
      }
      if (pending && confirmedSupersededDraft(task) && task.review) {
        if (!(await this.retireSupersededDraft(task, this.provider(prRef(task))))) return task;
      }
      const staleDraft = task.pendingAuthorFix?.staleDraft;
      if (
        pending &&
        task.review?.revision.head === pending &&
        !sameRevision(task.review.revision, pr)
      )
        this.trackRecoveredReview(task, task.review, task.snapshot);
      if (pr.state !== 'open') throw new AppError('pr_closed', 'The PR is closed');
      if (
        (sameRevision(task.revision, pr) ||
          (pr.mergeConflict && pr.draft === false && autoMergeEnabled(this.store, task))) &&
        (await this.advancePublishedReview(task, pr))
      )
        return task;
      const action = this.prAction(task, pr);
      if (action.kind === 'publish-review')
        throw new AppError('publication_pending', 'The recorded review is being published.');
      if (
        action.kind === 'confirm-merge' ||
        action.kind === 'confirm-fix' ||
        action.kind === 'continue-repair'
      )
        return task;
      if (
        action.kind === 'inspect-repair' ||
        (action.kind === 'target-changed' &&
          (task.pr?.branch !== pr.branch || task.pr.cloneUrl !== pr.cloneUrl))
      )
        throw new AppError(
          'stale_revision',
          'The PR branches changed. Inspect the task before restarting review.',
        );
      if (!pending && action.kind === 'repair') {
        await this.applyRepair(task, pr, action);
        return task;
      }
      if (
        retry &&
        task.review &&
        !sameRevision(task.review.revision, pr) &&
        (await this.resumeReviewAfterResourcePause(task, pr, clarification))
      )
        return task;
      const retryWithoutTarget = retry && task.review && !task.review.targetBranch;
      const targetIssue =
        reviewTargetChange(task.review, pr, task.pr?.targetBranch) ??
        (retryWithoutTarget ? missingReviewTargetReason(pr) : undefined);
      const changed =
        !sameRevision(task.revision, pr) ||
        !!targetIssue ||
        (!!pending && !!task.review && !sameRevision(task.review.revision, pr));
      const replacingReview = changed || (retry && !!task.review);
      let attempt =
        hasSharedDraftSlot(task) && (!task.review || replacingReview)
          ? await this.broker.findAttemptedReview(task)
          : undefined;
      let completedSnapshot: ReviewSnapshot | undefined;
      while (attempt?.review) {
        const ref = prRef(task);
        completedSnapshot = await this.provider(ref).getReview(ref, attempt.review);
        if (!retry || completedSnapshot.status !== 'missing') break;
        if (!attempt.completed) {
          if (
            !completedSnapshot.dismissed ||
            !attempt.revision ||
            !sameRevision(attempt.revision, completedSnapshot.revision)
          )
            break;
          await this.broker.recoverDismissedReview(task, attempt.review, attempt.revision);
        }
        if (completedSnapshot.comments.length) {
          (task.retiredReviewHandles ??= []).push(attempt.review);
          (task.retiredReviewCommentIds ??= {})[attempt.review.marker] =
            completedSnapshot.comments.map(({ id }) => id);
        }
        retainPublishedFeedback(task, completedSnapshot, true);
        // Save the retired round before another write can have an uncertain outcome.
        task.round++;
        this.store.saveTask(task);
        attempt = await this.broker.findAttemptedReview(task);
        completedSnapshot = undefined;
      }
      const attempted = attempt?.review;
      const draftReason = task.ref.provider === 'gitlab' ? gitLabDraftReason : arcanumDraftReason;
      if (
        attempt &&
        (attempt.targetBranch !== pr.targetBranch ||
          !sameRevision(attempt.revision, pr) ||
          attempt.generation !== task.generation + Number(replacingReview))
      ) {
        let targetReason =
          'The earlier review creation belongs to a different revision or generation. Inspect the native review before retrying.';
        if (!attempt.targetBranch)
          targetReason = `The earlier review creation has no recorded target branch. Inspect the native review before retrying on ${pr.targetBranch}.`;
        else if (attempt.targetBranch !== pr.targetBranch)
          targetReason = `The earlier review was requested for ${attempt.targetBranch}. The PR now targets ${pr.targetBranch}. Inspect the native review before retrying.`;
        const baseChange = attempt.revision
          ? savedFixBaseChange(attempt.revision, pr)
          : 'The earlier comparison revision is unknown.';
        const reason = baseChange ? `${targetReason} ${baseChange}` : targetReason;
        if (attempted) {
          const previous = staleDraft ?? task.review;
          const blocked = previous && (await this.inspectPreviousDraft(task, previous, attempted));
          if (blocked) {
            this.state(task, 'needs_input', `${reason} ${blocked}`);
            return task;
          }
          task.review = attempted;
          // The recovered review may use an older comparison than the confirmed fix.
          if (pending !== pr.head && attempt.revision) task.revision = attempt.revision;
          task.snapshot = pending === pr.head ? completedSnapshot : undefined;
          if (pending === pr.head && completedSnapshot) {
            this.trackRecoveredReview(task, attempted, completedSnapshot);
            retainPublishedFeedback(task, completedSnapshot, true);
          }
          task.reviewFinished = false;
          task.generation = Math.max(task.generation, attempt.generation);
          task.round++;
        }
        this.state(task, 'needs_input', reason);
        return task;
      }
      const recoveredSnapshot =
        attempted &&
        (completedSnapshot ?? (await this.provider(prRef(task)).getReview(prRef(task), attempted)));
      if (recoveredSnapshot?.status === 'partial') {
        if (pending) this.blockSavedFix(task, pending, draftReason);
        else this.state(task, 'needs_input', draftReason);
        return task;
      }
      if (recoveredSnapshot?.status === 'missing') {
        this.state(
          task,
          'needs_input',
          'The recovered native review is missing. Inspect it before retrying.',
        );
        return task;
      }
      if (pending && staleDraft) {
        const reason = await this.inspectPreviousDraft(task, staleDraft, attempted);
        if (reason) {
          this.blockSavedFix(task, pending, reason);
          return task;
        }
      }
      if (changed && task.review && (hasSharedDraftSlot(task) || retryWithoutTarget)) {
        const reason = await this.inspectPreviousDraft(task, task.review, attempted);
        if (reason) {
          this.state(task, 'needs_input', targetIssue ? `${targetIssue} ${reason}` : reason);
          return task;
        }
      }
      if (!(await this.refreshRetiredReviewFeedback(task, attempted))) return task;
      if (changed) this.invalidate(task, pr);
      if (retry && task.review) {
        const snapshot = await this.provider(prRef(task)).getReview(
          prRef(task),
          task.review,
          attempted,
          task.retiredReviewHandles,
        );
        if (attempted && (snapshot.status === 'partial' || snapshot.status === 'draft')) {
          this.state(task, 'needs_input', draftReason);
          return task;
        }
        this.retainPreviousReviewFeedback(task, task.review, snapshot);
        if (snapshot.status === 'published' || snapshot.status === 'missing')
          this.invalidate(task, pr);
      }
      if (pending) {
        const repair = this.prAction(task, pr, { confirmedFix: true });
        if (repair.kind === 'repair') {
          if (attempt && recoveredSnapshot?.status !== 'published') {
            this.blockSavedFix(task, pending, staleDraftReason);
            return task;
          }
          await this.applyRepair(task, pr, repair, {
            snapshot: recoveredSnapshot,
            confirmedFix: true,
          });
          return task;
        }
      }
      if (task.review && !retry && !changed)
        throw new AppError(
          'review_exists',
          'This revision already has a review. Discuss it or use retry to continue an interrupted run.',
        );
      if (!task.review && !task.draftStart) {
        if (attempt && !attempted)
          throw new AppError(
            'ambiguous_write',
            'The previous provider write has an uncertain result. Inspect the native review before retrying.',
          );
        task.round++;
        if (attempted)
          task.review = await this.broker.outbox.perform(
            task.id,
            attempted.marker,
            revisionOf(pr),
            async () => attempted,
            async () => ({ found: true, value: attempted }),
          );
      }
      task.pr = pr;
      task.revision = revisionOf(pr);
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
          // A previous saved fix is already confirmed on this exact PR head here.
          if (task.pendingAuthorHead === pr.head) task.pendingFix = undefined;
          this.store.transaction(() => {
            if (confirmedLegacyRetry)
              this.store.event(task.id, 'author.fix_confirmed_for_review', {
                savedEventId: legacySave.id,
                revision: task.revision,
                branch: pr.branch,
                targetBranch: pr.targetBranch,
              });
            this.state(task, 'queued', 'Preparing the GitHub review draft');
          });
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
          delete task.draftStart;
          task.round--;
          this.state(task, 'needs_input', redact(String(error)));
          throw error;
        }
        if (!this.currentReviewStart(task)) return this.store.getTask(id);
        delete task.draftStart;
      } else await this.broker.ensureReview(task);
      task.reviewFinished = false;
      if (pending) {
        task.pendingAuthorFix = undefined;
        task.resumeState = undefined;
      }
      this.store.transaction(() => {
        task.pendingFix = undefined;
        if (clarification?.trim()) this.rememberClarification(task, clarification);
        if (confirmedLegacyRetry)
          this.store.event(task.id, 'author.fix_confirmed_for_review', {
            savedEventId: legacySave.id,
            revision: task.revision,
            branch: pr.branch,
            targetBranch: pr.targetBranch,
          });
        if (attempted && recoveredSnapshot?.status === 'published') {
          task.snapshot = recoveredSnapshot;
          retainPublishedFeedback(task, recoveredSnapshot);
          this.state(
            task,
            'needs_input',
            'The recovered review was already published. Use Retry review to verify outstanding findings in a new draft.',
          );
          return;
        }
        task.retiredReviewHandles = undefined;
        task.retiredReviewCommentIds = undefined;
        this.state(task, 'reviewing', `Independent review, round ${task.round}`);
        this.store.enqueue(
          task,
          'reviewer',
          'review',
          retry
            ? clarification?.trim()
              ? clarifiedReviewPrefix + clarification.trim()
              : reviewRetryInstruction
            : 'Review the complete change and verify previous published findings. Create or edit native draft comments using your review tools.',
        );
      });
      return task;
    });
  }

  private trackRecoveredReview(task: Task, review: ReviewHandle, snapshot?: ReviewSnapshot) {
    const retired = (task.retiredReviewHandles ??= []);
    if (retired.some((handle) => handle.marker === review.marker)) return;
    retired.push(review);
    (task.retiredReviewCommentIds ??= {})[review.marker] =
      snapshot?.status === 'published' ? snapshot.comments.map(({ id }) => id) : [];
  }

  private async refreshRetiredReviewFeedback(
    task: Task,
    successor?: ReviewHandle,
  ): Promise<boolean> {
    const retired = task.retiredReviewHandles;
    if (!retired?.length) return true;
    const ref = prRef(task);
    const provider = this.provider(ref);
    for (const review of retired) {
      const snapshot = await provider.getReview(ref, review, successor, retired);
      if (snapshot.status === 'draft' || snapshot.status === 'partial') {
        this.state(
          task,
          'needs_input',
          'Inspect the remaining draft notes in the earlier review before retrying.',
        );
        return false;
      }
      if (task.review?.marker === review.marker) task.snapshot = snapshot;
      const ids = new Set(task.retiredReviewCommentIds?.[review.marker]);
      if (task.feedback)
        task.feedback = {
          ...task.feedback,
          comments: task.feedback.comments.filter(
            (c) => !ids.has(c.id) && !c.body.includes(`<!-- ${review.marker}:comment:`),
          ),
        };
      retainPublishedFeedback(task, snapshot, true);
      (task.retiredReviewCommentIds ??= {})[review.marker] = snapshot.comments.map(({ id }) => id);
    }
    this.store.saveTask(task);
    return true;
  }

  private async inspectPreviousDraft(task: Task, review: ReviewHandle, successor?: ReviewHandle) {
    const ref = prRef(task);
    const snapshot = await this.provider(ref).getReview(
      ref,
      review,
      successor,
      task.retiredReviewHandles,
    );
    const pendingNotes = snapshot.status === 'draft' || snapshot.status === 'partial';
    if (pendingNotes && ref.provider === 'gitlab') return gitLabDraftReason;
    if (pendingNotes && ref.provider === 'arcadia') return arcanumDraftReason;
    if (snapshot.status === 'draft' && ref.provider === 'github') return staleDraftReason;
    if (!task.retiredReviewHandles?.some((retired) => retired.marker === review.marker))
      this.retainPreviousReviewFeedback(task, review, snapshot);
  }

  private retainPreviousReviewFeedback(task: Task, review: ReviewHandle, snapshot: ReviewSnapshot) {
    const carryPrior =
      !!task.retiredReviewHandles?.length ||
      !task.reviewFinished ||
      !this.reviewPublicationProcessed(task, review);
    retainPublishedFeedback(task, snapshot, carryPrior);
  }

  private reviewPublicationProcessed(task: Task, review: ReviewHandle): boolean {
    return (
      task.state !== 'awaiting_publication' &&
      !!this.store.db
        .prepare(
          `SELECT 1 FROM events WHERE task_id=? AND type='review.published'
         AND json_extract(data, '$.reviewId')=? LIMIT 1`,
        )
        .get(task.id, review.id)
    );
  }

  private async settleMovedDraftStart(task: Task, pr: PullRequest, provider: ReviewProvider) {
    // Settle the old intent before routing the new revision. Never replay an old POST.
    const intent = task.draftStart!;
    if (intent.owner && pr.state === 'open' && !sameOpenTarget(task.pr, pr)) {
      this.state(
        task,
        'needs_input',
        `The PR branches changed during draft creation. Expected target ${task.pr?.targetBranch}, observed ${pr.targetBranch}. Inspect the earlier draft before retrying.`,
      );
      return task;
    }
    const existing = await provider.findReview(prRef(task), intent.marker);
    if (!this.currentReviewStart(task)) return this.store.getTask(task.id);
    if (existing) {
      if (
        existing.revision.head !== intent.revision.head ||
        (intent.owner && existing.authorId !== intent.owner)
      )
        throw new AppError('draft_changed', 'The marked review belongs to a different commit.');
      const handle = {
        ...existing,
        revision: intent.revision,
        targetBranch: task.pr?.targetBranch,
      };
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
          if (task.pendingAuthorHead === pr.head) task.pendingAuthorFix = undefined;
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
    if (task.pendingAuthorFix) task.pendingAuthorFix.generation = task.generation;
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
    task.feedback = snapshot;
    if (partial.question)
      task.openReviewQuestion = { head: snapshot.revision.head, text: redact(partial.question) };
    task.draftRecheck = undefined;
    this.store.saveTask(task);
    await this.afterPublishedReview(task, pr, snapshot);
    return task;
  }

  coordinationBlocker(task: Task) {
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
    task.review = undefined;
    delete task.publicationRetry;
    task.partialReview = undefined;
    task.draftRecheck = undefined;
    task.snapshot = undefined;
    task.approvedAt = undefined;
    task.checksWaivedAt = undefined;
    task.reviewFinished = false;
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
  private restartNativeReview(task: Task, pr: PullRequest, draft: ReviewSnapshot, reason: string) {
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
    this.state(task, 'reviewing', reason);
    return this.store.enqueue(
      task,
      'reviewer',
      'review',
      'Independently review the full current revision. Read the existing native draft and recorded decisions before editing. Verify all earlier published findings.',
    );
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
        (task.pendingFix || task.pendingAuthorFix) &&
        task.pendingAuthorHead &&
        task.reason === `Saved fix ${task.pendingAuthorHead} is preserved. ${job.error}`
      ) {
        const pr = await this.provider(prRef(task)).getPR(prRef(task));
        this.adoptPendingFix(task);
        const check = await this.checkSavedFixForSubmission(task, pr, task.pendingAuthorHead);
        if (check.status === 'confirmed')
          this.queueConfirmedFixReview(task, pr, task.pendingAuthorHead, check.original);
        else if (check.status === 'blocked')
          this.blockSavedFix(task, task.pendingAuthorHead, check.reason);
        else this.state(task, 'awaiting_push', 'Author saved the fixes; sending them to the PR');
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
        const retry = this.restartNativeReview(
          task,
          pr,
          draft,
          context
            ? 'Reviewer context was full. Restarting the independent review.'
            : 'Continuing the independent review on the verified PR head',
        );
        retry.freshContextRetry = job.freshContextRetry || !!context;
        retry.timeoutRetry = job.timeoutRetry || timeout;
        this.store.saveJob(retry);
      });
    });
  }

  async reconcile(id: string) {
    return this.lock(id, () => this.reconcileLocked(id));
  }
  private async queueMergeVerification(task: Task, pr: PullRequest) {
    if (task.state !== 'needs_input' || this.store.busy(task.id))
      throw new AppError('task_busy', 'Choose an idle task that needs attention');
    if (pr.state !== 'merged')
      throw new AppError('merge_unconfirmed', 'The provider must confirm the merge');
    const head = this.pendingFixHead(task, pr);
    const pending = task.pendingAuthorFix;
    const check =
      this.hasMergedFixEvidence(task, pr) &&
      head === pr.head &&
      pending?.generation === task.generation
        ? await this.checkSavedFixForSubmission(task, { ...pr, state: 'open' }, head)
        : undefined;
    if (check?.status === 'blocked') {
      this.holdLostFix(task, pr.head, check.reason);
      return task;
    }
    if (check?.status !== 'confirmed' && (await this.stopMergeBeforeSavedFix(task, pr)))
      return task;
    if (pr.head !== task.revision?.head && pr.head !== task.pendingAuthorHead)
      throw new AppError(
        'merge_unconfirmed',
        'The provider must confirm the merge of this task head',
      );
    if (task.pendingAuthorHead && task.pendingAuthorHead !== pr.head)
      throw new AppError(
        'unsubmitted_changes',
        'Inspect the saved worker changes before verifying this merge',
      );
    if (!(await this.prepareMergeVerificationFeedback(task, pr))) return task;
    this.store.transaction(() => {
      if (!sameRevision(task.revision, pr)) {
        task.approvedAt = undefined;
        task.checksWaivedAt = undefined;
      }
      task.generation++;
      if (pending) {
        pending.generation = task.generation;
        if (check?.status === 'confirmed') pending.revision = check.original;
      }
      task.revision = revisionOf(pr);
      task.pr = pr;
      task.verifiedMerge = undefined;
      task.pendingFix = undefined;
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
  private recoverSavedFixReview(task: Task, head: string) {
    const feedback = task.feedback;
    if (
      !feedback?.comments.length ||
      feedback.revision.head === head ||
      feedback.status !== 'published' ||
      task.savedFixReview
    )
      return;
    if (task.review && sameRevision(task.review.revision, feedback.revision)) {
      task.savedFixReview = {
        handle: task.review,
        commentIds: feedback.comments.map(({ id }) => id),
      };
      return;
    }

    const rows = this.store.db
      .prepare(
        `SELECT e.data AS publication, o.result AS handle
         FROM events e JOIN operations o ON o.task_id=e.task_id AND o.status='done'
           AND json_extract(o.result,'$.id')=json_extract(e.data,'$.reviewId')
         WHERE e.task_id=? AND e.type='review.published'
           AND json_extract(e.data,'$.snapshot.revision.head')=?
         ORDER BY e.id DESC`,
      )
      .all(task.id, feedback.revision.head);
    const ids = new Set(feedback.comments.map(({ id }) => id));
    for (const row of rows) {
      if (typeof row.handle !== 'string' || typeof row.publication !== 'string') continue;
      const review = JSON.parse(row.handle) as ReviewHandle;
      const { snapshot } = JSON.parse(row.publication) as { snapshot: ReviewSnapshot };
      if (
        !review.marker ||
        !sameRevision(snapshot.revision, feedback.revision) ||
        review.revision?.head !== feedback.revision.head
      )
        continue;
      const commentIds = snapshot.comments.map(({ id }) => id).filter((id) => ids.has(id));
      if (!commentIds.length) continue;
      task.savedFixReview = { handle: { ...review, revision: snapshot.revision }, commentIds };
      return;
    }
  }

  private async prepareMergeVerificationFeedback(task: Task, pr: PullRequest): Promise<boolean> {
    if (task.pendingAuthorHead === pr.head) {
      this.recoverSavedFixReview(task, pr.head);
      if (task.review?.revision.head === pr.head)
        this.trackRecoveredReview(task, task.review, task.snapshot);
      const stale = task.pendingAuthorFix?.staleDraft;
      if (stale) {
        this.trackRecoveredReview(task, stale);
        task.review ??= stale;
      }
      if (hasSharedDraftSlot(task) && !(await this.recoverReviewBeforeMerge(task, pr)))
        return false;
    }
    const origin = task.savedFixReview;
    if (
      origin &&
      !task.retiredReviewHandles?.some(({ marker }) => marker === origin.handle.marker) &&
      task.feedback?.comments.some(({ id }) => origin.commentIds.includes(id))
    ) {
      this.trackRecoveredReview(task, origin.handle);
      (task.retiredReviewCommentIds ??= {})[origin.handle.marker] = origin.commentIds;
    }
    return this.refreshRetiredReviewFeedback(task);
  }

  private async recoverReviewBeforeMerge(task: Task, pr: PullRequest): Promise<boolean> {
    const attempt = await this.broker.findAttemptedReview(task);
    if (!attempt) return true;
    const review = attempt.review;
    const head = attempt.revision?.head ?? review?.revision.head;
    if (head && head !== pr.head) return true;
    if (!review) {
      this.holdLostFix(task, pr.head, 'Could not verify the earlier creation of a native review.');
      return false;
    }
    this.trackRecoveredReview(task, review);
    if (!task.review) {
      task.review = review;
      task.snapshot = undefined;
      task.reviewFinished = false;
    }
    task.round++;
    return true;
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
      confirmedFix?: boolean;
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
    const carried = task.feedback;
    this.store.transaction(() => {
      if (action.preparation !== 'resume') {
        this.invalidate(task, pr, !options.finishingRun);
        task.pendingFix = undefined;
        if (options.confirmedFix) {
          task.pendingAuthorFix = undefined;
          task.resumeState = undefined;
        }
        task.conflictCheckpoint = checkpoint;
        if (options.confirmedFix && options.snapshot?.status === 'published') {
          task.round++;
          retainPublishedFeedback(task, options.snapshot, true);
        } else if (feedback?.status === 'published' && feedback.revision.head === pr.head)
          task.feedback =
            options.snapshot && carried?.revision.head === pr.head ? carried : feedback;
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
    checkpoint: (task: Task) => Promise<string>,
  ) {
    const action = this.prAction(task, pr, { report: { kind: 'fix', result } });
    return (
      action.kind === 'repair' &&
      action.preparation === 'checkpoint' &&
      this.applyRepair(task, pr, action, { checkpoint, finishingRun: true })
    );
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
      !hasReleasedReview(task) ||
      task.snapshot?.status !== 'published' ||
      !sameRevision(task.snapshot.revision, pinned) ||
      !sameRevision(task.review?.revision, pinned)
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

  async recoverInterruptedFix(id: string, checkpoint: (task: Task) => Promise<string>) {
    return this.lock(id, async () => {
      const task = this.store.getTask(id);
      if (
        task.state !== 'needs_input' ||
        !(task.resumeState === 'fixing' || task.resumeState === 'needs_input') ||
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
          task.feedback = native;
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
    let draftOnSameHead: ReviewSnapshot | undefined;
    if (
      task.ref.provider === 'github' &&
      handle &&
      !task.pendingFix &&
      !task.pendingAuthorFix &&
      ['reviewing', 'awaiting_publication'].includes(task.state) &&
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
      if (draft.status === 'draft' && draft.revision.head === pr.head) draftOnSameHead = draft;
    }
    const resourcePausedDraft =
      task.resumeState === 'reviewing' && (task.resourcePause || this.resourceReviewHistory(task));
    if (resourcePausedDraft && handle && !draftOnSameHead) {
      const current = await this.provider(prRef(task)).getReview(prRef(task), handle);
      if (current.status === 'published') this.retainPreviousReviewFeedback(task, handle, current);
      draftOnSameHead = current;
    }
    if (!draftOnSameHead && (await this.preservePreviousNativeReview(task))) return;
    const previous = draftOnSameHead ?? task.snapshot;
    const hadUnpublished =
      task.review && previous?.status !== 'published' && task.state !== 'awaiting_push';
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
    if (task.state === 'paused' || isTicket(task) || this.reviewWaitingForResources(task))
      return task;
    const pending = this.pendingFixHead(task);
    if (
      pending &&
      (task.pendingAuthorFix || task.state === 'awaiting_push') &&
      task.state !== 'fixing'
    ) {
      if (task.state === 'awaiting_push' && task.pendingAuthorFix) {
        const observed = await this.readSavedFixPR(task, pending);
        if (!observed) return task;
        const check = await this.checkSavedFixForSubmission(task, observed, pending);
        if (check.status === 'confirmed')
          this.queueConfirmedFixReview(task, observed, pending, check.original);
        else if (check.status === 'blocked') this.blockSavedFix(task, pending, check.reason);
        else if (
          task.pendingAuthorFix.confirmUntil !== undefined &&
          Date.now() >= task.pendingAuthorFix.confirmUntil
        )
          this.blockSavedFix(task, pending, this.savedFixReviewReason(task, pending, observed));
        return task;
      }
      if (reviewCompletionStates.includes(task.state) && !this.isConfirmedSavedFix(task, pending))
        this.holdLostFix(task, pending);
      return task;
    }
    if (task.state === 'awaiting_push') {
      const stranded = this.lostFix(task);
      if (stranded) {
        const reason = stranded.targetBranch
          ? 'Resume the task to recover the saved fix before review.'
          : unknownFixTarget(task);
        this.holdLostFix(task, stranded.head, reason);
        return task;
      }
    }
    if (task.draftStart) return task; // Draft creation reconciles its own outstanding native write.
    if (task.state === 'awaiting_publication' && task.partialReview) return task;
    const provider = this.provider(prRef(task)),
      pr = await provider.getPR(prRef(task));
    const legacyPending = !task.pendingAuthorFix && this.pendingFixHead(task, pr);
    if (legacyPending && task.state !== 'fixing') {
      this.holdLostFix(task, legacyPending, this.savedFixReviewReason(task, legacyPending, pr));
      return task;
    }
    const lost = this.lostFix(task, pr);
    if (lost) {
      const publicationMismatch = this.legacyPublicationMismatch(task, lost.head);
      if (pr.state !== 'open')
        this.holdLostFix(task, lost.head, `PR is ${pr.state}. Automatic work stopped.`);
      else if (publicationMismatch) this.holdLostFix(task, lost.head, publicationMismatch);
      else if (!lost.targetBranch) this.holdLostFix(task, lost.head, unknownFixTarget(task, pr));
      else if (
        lost.revision &&
        this.savedFixRemoteStatus(task, pr, lost.head, lost.revision, lost.targetBranch).status ===
          'confirmed'
      )
        this.holdLostFix(
          task,
          lost.head,
          'The PR contains the saved fix on the original base. Resume the task to continue review.',
        );
      else if (
        !sameRevision(lost.revision, pr) ||
        !sameRevision(lost.revision, task.revision) ||
        !samePullRequestBranches(task.pr, pr, lost.targetBranch)
      )
        this.holdLostFix(task, lost.head, changedBeforeRecovery(pr));
      else if (reviewCompletionStates.includes(task.state)) this.holdLostFix(task, lost.head);
      return task;
    }
    if (pr.state === 'merged') {
      if (
        task.state === 'awaiting_merge' &&
        task.revision?.head === pr.head &&
        task.pr?.targetBranch === pr.targetBranch
      ) {
        task.pr = pr;
        this.finishReviewedTask(task, 'Merged on GitHub');
        return task;
      }
      if (
        task.state === 'complete' ||
        this.store.activeJobs(id).some((job) => job.kind === 'verify_merge')
      )
        return task;
      if (
        sameRevision(task.verifiedMerge, pr) &&
        task.verifiedMerge?.mergeCommit === pr.mergeCommit &&
        ['awaiting_checks', 'awaiting_plan_approval'].includes(task.state)
      ) {
        task.pr = pr;
        this.finish(task);
        return task;
      }
    }
    if (pr.state !== 'open') {
      this.onCancel(id);
      this.store.cancelJobs(id);
      task.generation++;
      const reason = `PR is ${pr.state}; automatic work stopped`;
      if (pending) this.blockSavedFix(task, pending, `${reason}.`);
      else this.state(task, 'needs_input', reason);
      return task;
    }
    if (this.stopReviewOnTargetChange(task, pr)) return task;
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
    // The active author's result owns the revision check and the saved SHA.
    if (pending || (task.state === 'fixing' && this.store.busy(id))) return task;
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
    const snapshot = await provider.getReview(prRef(task), task.review);
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
        this.finish(task);
      else
        this.state(
          task,
          'needs_input',
          'The reviewed revision needs verification before completion',
        );
    } else if (task.state === 'awaiting_checks' || task.state === 'awaiting_plan_approval')
      this.finish(task);
    else this.store.saveTask(task);
    return this.store.getTask(id);
  }
  private hasUnverifiedFindings(task: Task, verified: Set<string>, feedback = task.feedback) {
    const decisions = this.store.decisions(task.id);
    const exempt = new Set(
      decisions
        .filter(
          (d) =>
            ['withdrawn', 'deferred', 'rejected'].includes(d.outcome) ||
            (d.outcome === 'verified' &&
              d.generation === task.generation &&
              sameRevision(d.revision, task.revision) &&
              d.targetBranch === task.pr?.targetBranch),
        )
        .map((d) => d.commentId),
    );
    const unresolved =
      feedback?.comments.filter((c) => !verified.has(c.id) && !exempt.has(c.id)) ?? [];
    return unresolved.length > 0;
  }
  finishReviewedTask(
    task: Task,
    reason = 'Current revision reviewed; publication, findings and checks are accounted for',
  ) {
    if (task.pr?.state === 'open' && autoMergeRequested(this.store, task))
      this.state(task, 'awaiting_merge', 'Review complete. Waiting for GitHub to merge the PR.');
    else this.state(task, 'complete', reason);
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

  private finish(task: Task) {
    const gate = completionGate(task);
    if (gate?.state === 'awaiting_checks') {
      this.state(task, gate.state, gate.reason);
      return;
    }
    if (
      task.state === 'awaiting_checks' &&
      task.pr &&
      !task.verifiedMerge &&
      this.stopUnverifiedReviewTarget(task, task.pr)
    )
      return;
    if (gate) this.state(task, gate.state, gate.reason);
    else {
      if (task.kind === 'plan') task.approvedAt = now();
      this.finishReviewedTask(
        task,
        task.verifiedMerge ? 'daddy verified the merged result' : undefined,
      );
    }
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
    task.feedback = snapshot;
    if (task.noProgress >= task.policy.maxNoProgress)
      this.state(
        task,
        'needs_input',
        'The same findings keep returning; human decision is required',
      );
    else this.queuePublishedFix(task, 'Author is addressing the published review');
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
    if (this.stopUnverifiedReviewTarget(task, pr)) return true;
    const snapshot =
      publication ?? (await this.provider(prRef(task)).getReview(prRef(task), task.review));
    if (snapshot.status !== 'published') return false;
    if (!task.reviewFinished) {
      this.state(
        task,
        'needs_input',
        'The review was not completed successfully; published feedback is held until verification',
      );
      return true;
    }
    task.snapshot = snapshot;
    this.retainPreviousReviewFeedback(task, task.review, snapshot);
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
            revision: snapshot.revision,
            comments: snapshot.comments.length,
          }
        : { reviewId: task.review!.id, snapshot },
    );
    switch (action.kind) {
      case 'repair':
        await this.applyRepair(task, pr, action, { snapshot });
        return;
      case 'fix-findings':
        this.assignPublishedFindings(task, snapshot);
        return;
      case 'finish':
        this.finish(task);
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
        'Address exactly the published feedback snapshot. Explain disputes. Do not treat the reviewer’s private draft or old summary as additional requirements.',
      );
    });
  }

  private blockSavedFix(task: Task, head: string, reason: string) {
    task.resumeState = 'awaiting_push';
    this.state(task, 'needs_input', `${reason} Saved fix ${head} is preserved.`);
  }

  private holdLostFix(
    task: Task,
    head: string,
    reason = 'The review still points to the revision before the saved fix.',
  ) {
    this.holdTaskForInput(task, `${reason} Saved fix ${head} is preserved.`);
  }

  private holdTaskForInput(task: Task, reason: string) {
    const jobs = this.store.activeJobs(task.id);
    const running = jobs.some((job) => job.status === 'running');
    this.store.transaction(() => {
      if (running) task.generation++;
      if (jobs.length) this.store.cancelJobs(task.id);
      this.state(task, 'needs_input', reason);
    });
    if (running) this.onCancel(task.id);
  }

  private async preservePreviousNativeReview(task: Task): Promise<boolean> {
    const { review, snapshot } = task;
    if (!review || !hasSharedDraftSlot(task)) return false;
    if (
      task.reviewFinished &&
      snapshot?.status === 'published' &&
      sameRevision(snapshot.revision, review.revision)
    ) {
      // A discussion can observe publication before reconcile processes it.
      if (this.reviewPublicationProcessed(task, review)) return false;
      const ref = prRef(task);
      const current = await this.provider(ref).getReview(ref, review);
      if (
        sameRevision(current.revision, review.revision) &&
        (current.status === 'published' || current.status === 'missing')
      ) {
        retainPublishedFeedback(task, current, true);
        return false;
      }
    } else if (task.reviewFinished && task.state === 'awaiting_push') return false;
    this.holdTaskForInput(
      task,
      'PR revision changed. Use Retry review to check the previous native review before starting the next one.',
    );
    return true;
  }

  async canStartMergeVerification(job: Job, pr: PullRequest): Promise<boolean> {
    return this.lock(job.taskId, async () => {
      const task = this.store.getTask(job.taskId);
      if (
        job.generation !== task.generation ||
        (await this.stopMergeBeforeSavedFix(task, pr)) ||
        !(await this.prepareMergeVerificationFeedback(task, pr))
      )
        return false;
      this.store.event(task.id, 'merge.findings_presented', this.mergeFindingDigests(task), job.id);
      return true;
    });
  }

  private mergeFindingDigests(task: Task): [string, string][] {
    const comments = [
      ...(task.snapshot?.status === 'published' ? task.snapshot.comments : []),
      ...(task.feedback?.comments ?? []),
    ];
    return Array.from(
      new Map(
        comments.map(({ id, body }) => [id, createHash('sha256').update(body).digest('hex')]),
      ),
    );
  }

  private mergeFindingsWerePresented(task: Task, job: Job): boolean {
    const current = this.mergeFindingDigests(task);
    if (!current.length) return true;
    const recorded = this.store.db
      .prepare(
        `SELECT data FROM events WHERE task_id=? AND run_id=? AND type='merge.findings_presented'
         ORDER BY id DESC LIMIT 1`,
      )
      .get(task.id, job.id);
    if (typeof recorded?.data !== 'string') return false;
    const shown = new Map<string, string>(JSON.parse(recorded.data));
    return current.every(([id, digest]) => shown.get(id) === digest);
  }

  private async stopMergeBeforeSavedFix(task: Task, pr: PullRequest): Promise<boolean> {
    const legacyConfirmation = await this.confirmLegacyMergedFix(task, pr);
    return legacyConfirmation === undefined
      ? this.stopReviewBeforeSavedFix(task, pr, true)
      : !legacyConfirmation;
  }

  private async confirmLegacyMergedFix(task: Task, pr: PullRequest): Promise<boolean | undefined> {
    const head = task.pendingAuthorHead;
    if (
      task.ref.provider !== 'github' ||
      pr.state !== 'merged' ||
      !head ||
      head !== pr.head ||
      task.pendingAuthorFix ||
      task.pendingFix
    )
      return;
    const saved = this.savedFixEvent(task, head);
    if (!saved) return;
    const observation = this.legacyFixObservations(task, head, Number(saved.id))[0];
    if (!observation || this.savedFixSubmissionRecorded(task, head, Number(observation.id))) return;
    const revision = parseRecordedRevision(observation.revision);
    if (!revision) return;
    const held = this.store.db
      .prepare(
        `SELECT json_extract(data, '$.reason') AS reason FROM events
         WHERE task_id=? AND id>? AND type='task.state'
         AND json_extract(data, '$.generation')=?
         AND json_extract(data, '$.state')='needs_input' ORDER BY id DESC`,
      )
      .all(task.id, observation.id!, observation.generation!);
    // The old version recorded the expected target in its hold reason before replacing task.pr.
    const prefix = `Saved fix ${head} is preserved. PR is `;
    const expected = `expected ${head} (base ${revision.base}, target `;
    let target = typeof saved.target_branch === 'string' ? saved.target_branch : undefined;
    for (const { reason } of held) {
      if (typeof reason !== 'string' || !reason.startsWith(prefix)) continue;
      const start = reason.indexOf(expected);
      const end = reason.lastIndexOf('). Inspect the target and submission outcome.');
      if (start >= 0 && end > start) {
        target = reason.slice(start + expected.length, end);
        break;
      }
    }
    if (!target && task.pr?.state === 'open' && sameRevision(task.pr, revision))
      target = task.pr.targetBranch;
    if (!target || target !== pr.targetBranch) {
      this.holdLostFix(
        task,
        head,
        `Expected target branch ${target ?? 'unknown'}. Observed ${pr.targetBranch}.`,
      );
      return false;
    }
    const baseChange = savedFixBaseChange(revision, pr);
    if (!baseChange) return true;
    const ref = prRef(task);
    if (await this.provider(ref).targetAdvanced?.(ref, revision.base, pr.base)) return true;
    this.holdLostFix(task, head, baseChange);
    return false;
  }

  private hasMergedFixEvidence(task: Task, pr: PullRequest): boolean {
    if (pr.state !== 'merged') return false;
    if (pr.mergeCommit) return true;
    // GitLab can omit the merge SHA, and Arcanum identifies the delivered diff instead.
    const pinned = task.revision;
    const firstObservation =
      !!pinned &&
      task.pendingAuthorHead === pr.head &&
      pinned.head !== pr.head &&
      sameRevision(pinned, task.pr) &&
      sameRevision(pinned, task.pendingAuthorFix?.revision) &&
      !savedFixBaseChange(pinned, pr) &&
      (task.ref.provider !== 'arcadia' ||
        (!!pinned.revisionId && pinned.revisionId !== pr.revisionId));
    return (
      (task.ref.provider === 'gitlab' || (task.ref.provider === 'arcadia' && !!pr.revisionId)) &&
      !!pr.base &&
      !!pr.start &&
      !!pr.branch &&
      !!pr.targetBranch &&
      (sameRevision(task.revision, pr) || firstObservation) &&
      samePullRequestBranches(task.pr, { ...pr, state: 'open' })
    );
  }

  private stopReviewBeforeSavedFix(task: Task, pr: PullRequest, merged = false): boolean {
    const pending = this.pendingFixHead(task, pr);
    if (merged && pr.state === 'merged' && pending === pr.head) {
      if (!this.hasMergedFixEvidence(task, pr)) {
        this.holdLostFix(
          task,
          pending,
          `The provider did not return a merge commit or a matching confirmed revision and branches (observed ${pr.head}, base ${pr.base}, target ${pr.targetBranch}). Check the delivered revision on the provider and retry after it can be confirmed.`,
        );
        return true;
      }
      const pinned = task.pendingAuthorFix;
      if (
        pinned &&
        pinned.generation === task.generation &&
        this.savedFixStatus(task, { ...pr, state: 'open' }, pending).status === 'confirmed'
      )
        return false;
    }
    if (
      pending &&
      this.isConfirmedSavedFix(task, pending) &&
      sameRevision(task.revision, pr) &&
      samePullRequestBranches(task.pr, pr)
    )
      return false;
    const head = pending ?? this.lostFix(task, pr)?.head;
    if (!head) return false;
    this.holdLostFix(task, head, this.savedFixReviewReason(task, head, pr));
    return true;
  }

  private stopReviewOnTargetChange(task: Task, pr: PullRequest): boolean {
    const targetChange = reviewTargetChange(task.review, pr, task.pr?.targetBranch);
    if (!targetChange) return false;
    this.holdTaskForInput(task, targetChange);
    return true;
  }

  private stopUnverifiedReviewTarget(task: Task, pr: PullRequest): boolean {
    const target = task.review?.targetBranch;
    if (pr.state !== 'open') {
      const reviewed = target ? ` Review target branch ${target}.` : '';
      this.holdTaskForInput(
        task,
        `The PR is ${pr.state}.${reviewed} Observed target branch ${pr.targetBranch}.`,
      );
      return true;
    }
    if (target) return this.stopReviewOnTargetChange(task, pr);
    this.holdTaskForInput(task, missingReviewTargetReason(pr));
    return true;
  }

  private savedFixReviewReason(task: Task, head: string, pr: PullRequest): string {
    const publicationMismatch = this.legacyPublicationMismatch(task, head);
    if (publicationMismatch) return publicationMismatch;
    const saved = this.savedFixEvent(task, head);
    const original = parseRecordedRevision(saved?.revision);
    const baseChange = original && savedFixBaseChange(original, pr);
    const observed = `The PR currently points to ${pr.head} (base ${pr.base}, start ${pr.start}).`;
    if (baseChange) return pr.head === head ? baseChange : `${observed} ${baseChange}`;
    if (
      pr.head === head &&
      saved &&
      typeof saved.saved_revision !== 'string' &&
      !(task.review && task.reviewFinished)
    ) {
      const targetBranch =
        typeof saved.target_branch === 'string' ? saved.target_branch : undefined;
      if (!targetBranch) return unknownFixTarget(task, pr);
      const targetChange = savedFixTargetChange(targetBranch, pr);
      if (targetChange) return targetChange;
    }
    return observed;
  }

  private savedFixStatus(task: Task, pr: PullRequest, head: string): SavedFixCheck {
    const pending = task.pendingAuthorFix;
    const saved = this.savedFixEvent(task, head);
    const recordedTarget =
      typeof saved?.target_branch === 'string' ? saved.target_branch : undefined;
    // Old saves logged the SHA without a revision. Recovered task metadata may still reflect the creation branch.
    const legacy = !pending || (saved && typeof saved.saved_revision !== 'string');
    const recordedOriginal = legacy ? parseRecordedRevision(saved?.revision) : undefined;
    if (legacy && !recordedTarget) {
      const baseChange =
        pr.head === head && recordedOriginal && savedFixBaseChange(recordedOriginal, pr);
      const unknownTarget = unknownFixTarget(task, pr);
      return {
        status: 'blocked',
        reason: baseChange ? `${baseChange} ${unknownTarget}` : unknownTarget,
      };
    }
    const original =
      recordedOriginal ?? pending?.revision ?? task.feedback?.revision ?? task.revision;
    if (
      original &&
      (pending ? pending.generation === task.generation : task.authorBaseHead === original.head)
    ) {
      const check = this.savedFixRemoteStatus(
        task,
        pr,
        head,
        original,
        recordedTarget ?? pending?.targetBranch,
      );
      // A stale local revision can be replaced by remote confirmation, but cannot authorize a send.
      if (check.status !== 'ready' || sameRevision(original, task.revision)) return check;
    }
    return {
      status: 'blocked',
      reason: 'The saved fix belongs to a different task revision or generation.',
    };
  }

  private isConfirmedSavedFix(task: Task, head: string) {
    const { pendingAuthorFix, pr } = task;
    return (
      !!pendingAuthorFix &&
      !!pr &&
      sameRevision(task.revision, pr) &&
      this.savedFixStatus(task, pr, head).status === 'confirmed'
    );
  }

  private savedFixRemoteStatus(
    task: Task,
    pr: PullRequest,
    head: string,
    original: Revision,
    targetBranch = task.pendingAuthorFix?.targetBranch ?? task.pr?.targetBranch,
  ): SavedFixCheck {
    const targetChange = savedFixTargetChange(targetBranch, pr);
    if (targetChange) return { status: 'blocked', reason: targetChange };
    if (!samePullRequestBranches(task.pr, pr, targetBranch))
      return {
        status: 'blocked',
        reason: 'The PR was closed or its source or target branch changed.',
      };
    const baseChange = savedFixBaseChange(original, pr);
    if (baseChange) return { status: 'blocked', reason: baseChange };
    if (pr.head === head) {
      if (original.revisionId && (!pr.revisionId || pr.revisionId === original.revisionId))
        return { status: 'waiting' };
      return { status: 'confirmed', original };
    }
    return sameRevision(original, pr)
      ? { status: 'ready' }
      : { status: 'blocked', reason: 'The PR points to a different revision.' };
  }

  private async readSavedFixPR(task: Task, head: string): Promise<PullRequest | undefined> {
    const ref = prRef(task);
    try {
      return await this.provider(ref).getPR(ref);
    } catch (error) {
      const pending = task.pendingAuthorFix;
      if (error instanceof GitHubRetryError && !pending?.pushStarted && !pending?.sent) throw error;
      const until = pending?.confirmUntil;
      if (until !== undefined && Date.now() < until) throw error;
      this.blockSavedFix(task, head, `Could not confirm the PR revision. ${redact(String(error))}`);
    }
  }

  private queueConfirmedFixReview(task: Task, pr: PullRequest, head: string, original: Revision) {
    this.store.transaction(() => {
      const pending = task.pendingAuthorFix;
      const sent = pending?.sent === true;
      const staleDraft = task.review?.revision.head === head ? task.review : pending?.staleDraft;
      if (
        task.review &&
        task.review.revision.head !== head &&
        task.feedback?.status === 'published' &&
        sameRevision(task.feedback.revision, task.review.revision)
      ) {
        const source =
          task.snapshot?.status === 'published' &&
          sameRevision(task.snapshot.revision, task.review.revision)
            ? task.snapshot
            : task.feedback;
        task.savedFixReview = {
          handle: task.review,
          commentIds: source.comments.map(({ id }) => id),
        };
      }
      this.invalidate(task, pr, false);
      task.pendingAuthorFix = {
        ...pending,
        staleDraft,
        revision: original,
        generation: task.generation,
        sent,
      };
      task.resumeState = undefined;
      this.store.event(task.id, 'author.submitted', { head, pushed: sent });
      this.state(task, 'queued', 'New revision is ready for review');
    });
  }

  private async refreshConfirmedFixBase(task: Task, pr: PullRequest) {
    this.adoptPendingFix(task);
    const pending = task.pendingAuthorFix;
    const head = task.pendingAuthorHead;
    if (
      !pending ||
      !head ||
      head !== pr.head ||
      (!sameRevision(task.revision, pr) && !this.isConfirmedSavedFix(task, head)) ||
      !samePullRequestBranches(task.pr, pr) ||
      !savedFixBaseChange(pending.revision, pr)
    )
      return;
    const check = await this.checkSavedFixForSubmission(task, pr, head);
    if (check.status === 'confirmed') {
      this.store.transaction(() => {
        pending.revision = check.original;
        if (!sameRevision(task.revision, pr)) {
          task.pr = pr;
          task.revision = revisionOf(pr);
          task.approvedAt = undefined;
          task.checksWaivedAt = undefined;
          task.verifiedMerge = undefined;
          this.store.event(task.id, 'revision.changed', {
            revision: task.revision,
            generation: task.generation,
          });
        }
        this.store.saveTask(task);
      });
    }
  }

  private async checkSavedFixForSubmission(
    task: Task,
    pr: PullRequest,
    head: string,
  ): Promise<SavedFixCheck> {
    const check = this.savedFixStatus(task, pr, head);
    const pending = task.pendingAuthorFix;
    if (
      check.status !== 'blocked' ||
      task.ref.provider !== 'github' ||
      !pending ||
      pending.generation !== task.generation ||
      !samePullRequestBranches(task.pr, pr, pending.targetBranch) ||
      !savedFixBaseChange(pending.revision, pr) ||
      (pr.head !== head &&
        !sameRevision({ ...pending.revision, base: pr.base, start: pr.start }, pr))
    )
      return check;
    const ref = prRef(task);
    try {
      if (!(await this.provider(ref).targetAdvanced?.(ref, pending.revision.base, pr.base)))
        return check;
    } catch (error) {
      if (error instanceof GitHubRetryError && !pending.pushStarted && !pending.sent) throw error;
      if (pending.confirmUntil !== undefined && Date.now() < pending.confirmUntil) throw error;
      return {
        status: 'blocked',
        reason: `Could not confirm the PR base at ${pr.head} (base ${pr.base}, start ${pr.start}). ${redact(String(error))}`,
      };
    }
    const original = { ...pending.revision, base: pr.base, start: pr.start };
    return pr.head === head ? { status: 'confirmed', original } : { status: 'ready' };
  }

  async submitSavedFix(
    id: string,
    preparePush: (task: Task, head: string) => Promise<() => Promise<void>>,
  ) {
    return this.lock(id, async () => {
      const task = this.store.getTask(id);
      if (isTicket(task) || task.state !== 'awaiting_push' || this.store.busy(id)) return;
      const head = this.pendingFixHead(task);
      if (!head) return;
      const saved = this.savedFixEvent(task, head);
      const legacyPush =
        saved &&
        typeof saved.saved_revision !== 'string' &&
        this.savedFixSubmissionRecorded(task, head, Number(saved.id));
      const pendingFix = legacyPush
        ? (task.pendingAuthorFix ??= {
            revision:
              parseRecordedRevision(saved.revision) ?? task.feedback?.revision ?? task.revision!,
            generation: task.generation,
          })
        : task.pendingAuthorFix;
      if (
        pendingFix &&
        (legacyPush || pendingFix.sent || pendingFix.pushStarted) &&
        (pendingFix.confirmUntil === undefined || (legacyPush && !pendingFix.sent))
      ) {
        if (legacyPush) pendingFix.sent = true;
        pendingFix.confirmUntil ??= Date.now() + fixConfirmationGraceMs;
        this.store.saveTask(task);
      }
      if (task.fixingMergeConflict && !autoMergeEnabled(this.store, task)) {
        this.blockSavedFix(
          task,
          head,
          'Auto-merge is disabled. The saved conflict resolution is waiting for submission.',
        );
        return;
      }
      let pr = await this.readSavedFixPR(task, head);
      if (!pr) return;
      const waitingReason = `Waiting for the PR to confirm saved fix ${head}.`;
      let check = await this.checkSavedFixForSubmission(task, pr, head);
      if (
        check.status === 'ready' &&
        !legacyPush &&
        !task.pendingAuthorFix?.sent &&
        !task.pendingAuthorFix?.pushStarted &&
        task.pendingAuthorFix?.confirmUntil === undefined
      ) {
        let push: () => Promise<void>;
        try {
          push = await preparePush(task, head);
        } catch (error) {
          this.blockSavedFix(task, head, redact(String(error)));
          return;
        }
        pr = await this.readSavedFixPR(task, head);
        if (!pr) return;
        check = await this.checkSavedFixForSubmission(task, pr, head);
        if (check.status === 'ready') {
          if (task.fixingMergeConflict && !autoMergeEnabled(this.store, this.store.getTask(id))) {
            this.blockSavedFix(
              task,
              head,
              'Auto-merge is disabled. The saved conflict resolution is waiting for submission.',
            );
            return;
          }
          const pending = (task.pendingAuthorFix ??= {
            revision: task.revision!,
            generation: task.generation,
          });
          // Only a failure after local preparation can leave the send result unknown.
          pending.pushStarted = true;
          pending.confirmUntil = Date.now() + fixConfirmationGraceMs;
          this.store.saveTask(task);
          try {
            await push();
          } catch (error) {
            if (error instanceof AppError && error.code === 'push_not_started') {
              delete pending.pushStarted;
              delete pending.confirmUntil;
            }
            this.blockSavedFix(task, head, redact(String(error)));
            return;
          }
          pending.sent = true;
          pending.confirmUntil = Date.now() + fixConfirmationGraceMs;
          this.state(task, 'awaiting_push', waitingReason);
          pr = await this.readSavedFixPR(task, head);
          if (!pr) return;
          check = await this.checkSavedFixForSubmission(task, pr, head);
        }
      }
      if (check.status === 'blocked') {
        this.blockSavedFix(task, head, check.reason);
        return;
      }
      if (check.status !== 'confirmed') {
        const pending = (task.pendingAuthorFix ??= {
          revision: task.revision!,
          generation: task.generation,
        });
        const nowMs = Date.now();
        if (pending.confirmUntil === undefined) {
          pending.confirmUntil = nowMs + fixConfirmationGraceMs;
          this.store.saveTask(task);
        }
        if (nowMs >= pending.confirmUntil) {
          this.blockSavedFix(
            task,
            head,
            `The PR did not confirm the fix. Observed PR head ${pr.head}.`,
          );
          return;
        }
        if (task.reason !== waitingReason) this.state(task, 'awaiting_push', waitingReason);
        return;
      }
      this.queueConfirmedFixReview(task, pr, head, check.original);
    });
  }

  private savedFixEvent(task: Task, head?: string) {
    return this.store.db
      .prepare(
        `SELECT saved.id, saved.run_id, json_extract(saved.data, '$.head') AS head,
            json_extract(saved.data, '$.revision') AS saved_revision,
            COALESCE(json_extract(saved.data, '$.revision'), json_extract(feedback.data, '$.revision')) AS revision,
            json_extract(feedback.data, '$.targetBranch') AS target_branch
         FROM events saved
         LEFT JOIN events feedback ON feedback.id=(
           SELECT id FROM events prior
           WHERE prior.task_id=saved.task_id AND prior.run_id=saved.run_id
             AND prior.type='author.feedback_snapshot' AND prior.id<saved.id
           ORDER BY prior.id DESC LIMIT 1
         )
         WHERE saved.task_id=? AND saved.type='author.fixes_saved'
           AND (? IS NULL OR json_extract(saved.data, '$.head')=?)
         ORDER BY saved.id DESC LIMIT 1`,
      )
      .get(task.id, head ?? null, head ?? null);
  }

  private savedFixSubmissionRecorded(task: Task, head: string, after: number) {
    return !!this.store.db
      .prepare(
        `SELECT 1 FROM events WHERE task_id=? AND id>? AND type='author.submitted'
       AND json_extract(data, '$.head')=? LIMIT 1`,
      )
      .get(task.id, after, head);
  }

  private savedFixVerifiedInMerge(task: Task, head: string, after: number) {
    return !!this.store.db
      .prepare(
        `SELECT 1 FROM events WHERE task_id=? AND id>? AND type='author.fix_verified_in_merge'
         AND json_extract(data, '$.revision.head')=? LIMIT 1`,
      )
      .get(task.id, after, head);
  }

  private legacyFixPublication(task: Task, head: string, after: number, original?: Revision) {
    return this.store.db
      .prepare(
        `SELECT json_extract(published.data, '$.snapshot.revision.base') AS base,
                json_extract(published.data, '$.snapshot.revision.start') AS start
         FROM events published
       WHERE published.task_id=? AND published.id>? AND published.type='review.published'
         AND json_extract(published.data, '$.snapshot.revision.head')=?
         AND (? IS NULL OR (
           json_extract(published.data, '$.snapshot.revision.base')=?
           AND json_extract(published.data, '$.snapshot.revision.start')=?
         ))
         AND EXISTS (
           SELECT 1 FROM events observed
           WHERE observed.task_id=published.task_id AND observed.id>? AND observed.id<published.id
             AND observed.type='revision.changed'
             AND json_extract(observed.data, '$.revision.head')=json_extract(published.data, '$.snapshot.revision.head')
             AND json_extract(observed.data, '$.revision.base')=json_extract(published.data, '$.snapshot.revision.base')
             AND json_extract(observed.data, '$.revision.start')=json_extract(published.data, '$.snapshot.revision.start')
             AND json_extract(observed.data, '$.revision.revisionId') IS json_extract(published.data, '$.snapshot.revision.revisionId')
         ) ORDER BY published.id DESC LIMIT 1`,
      )
      .get(
        task.id,
        after,
        head,
        original?.base ?? null,
        original?.base ?? null,
        original?.start ?? null,
        after,
      );
  }

  private legacyPublicationMismatch(task: Task, head: string): string | undefined {
    const saved = this.savedFixEvent(task, head);
    if (!saved || typeof saved.saved_revision === 'string') return;
    const original = parseRecordedRevision(saved.revision);
    if (!original) return;
    const published = this.legacyFixPublication(task, head, Number(saved.id));
    if (published && (published.base !== original.base || published.start !== original.start))
      return `The published review of saved fix ${head} used base ${published.base} (start ${published.start}). The author used base ${original.base} (start ${original.start}).`;
  }

  private legacyFixConfirmed(
    task: Task,
    pr: PullRequest | undefined,
    head: string,
    after: number,
    original: Revision | undefined,
    targetBranch: string | undefined,
  ): boolean {
    if (original && this.legacyFixPublication(task, head, after, original)) return true;
    const finishedReview = task.reviewFinished && !!task.review;
    if (
      pr?.state !== 'open' ||
      pr.head !== head ||
      (original && savedFixBaseChange(original, pr)) ||
      !sameRevision(task.revision, pr) ||
      (task.review && !sameRevision(task.review.revision, pr)) ||
      (task.review?.targetBranch && task.review.targetBranch !== pr.targetBranch) ||
      (task.snapshot && !sameRevision(task.snapshot.revision, pr))
    )
      return false;
    if (
      this.store.db
        .prepare(
          `SELECT 1 FROM events WHERE task_id=? AND id>? AND type='author.fix_confirmed_for_review'
           AND json_extract(data, '$.savedEventId')=?
           AND json_extract(data, '$.revision.head')=?
           AND json_extract(data, '$.revision.base')=?
           AND json_extract(data, '$.revision.start')=?
           AND json_extract(data, '$.revision.revisionId') IS ?
           AND json_extract(data, '$.branch')=? AND json_extract(data, '$.targetBranch')=? LIMIT 1`,
        )
        .get(
          task.id,
          after,
          after,
          head,
          pr.base,
          pr.start,
          pr.revisionId ?? null,
          pr.branch,
          pr.targetBranch,
        )
    )
      return true;
    if (!finishedReview && (!original || !targetBranch || targetBranch !== pr.targetBranch))
      return false;
    return !!this.store.db
      .prepare(
        `SELECT 1 FROM events WHERE task_id=? AND id>? AND type='revision.changed'
       AND json_extract(data, '$.revision.head')=?
       AND json_extract(data, '$.revision.base')=?
       AND json_extract(data, '$.revision.start')=?
       AND json_extract(data, '$.revision.revisionId') IS ? LIMIT 1`,
      )
      .get(task.id, after, head, pr.base, pr.start, pr.revisionId ?? null);
  }

  private confirmedLegacyFixRevision(task: Task, head: string): Revision | undefined {
    const revision = task.revision;
    if (
      task.ref.provider !== 'github' ||
      revision?.head !== head ||
      task.pr?.state !== 'open' ||
      !sameRevision(revision, task.pr)
    )
      return;
    const saved = this.savedFixEvent(task, head);
    if (!saved) return;
    return this.legacyFixObservations(task, head, Number(saved.id)).some((event) =>
      sameRevision(revision, parseRecordedRevision(event.revision)),
    )
      ? revision
      : undefined;
  }

  private legacyFixObservations(task: Task, head: string, after: number) {
    // Older versions left the original comparison in pendingFix after observing the saved SHA.
    return this.store.db
      .prepare(
        `SELECT observed.id, json_extract(observed.data, '$.revision') AS revision,
                json_extract(observed.data, '$.generation') AS generation
         FROM events observed
         WHERE observed.task_id=? AND observed.id>? AND observed.type='revision.changed'
         AND json_extract(observed.data, '$.revision.head')=?
         AND EXISTS (
           SELECT 1 FROM events queued WHERE queued.task_id=observed.task_id
           AND queued.id>observed.id AND queued.type='task.state'
           AND json_extract(queued.data, '$.state')='queued'
           AND json_extract(queued.data, '$.reason')='New revision is ready for review'
           AND json_extract(queued.data, '$.head')=?
           AND json_extract(queued.data, '$.generation')=json_extract(observed.data, '$.generation')
         ) ORDER BY observed.id DESC`,
      )
      .all(task.id, after, head, head);
  }

  private adoptPendingFix(task: Task) {
    const previous = task.pendingFix;
    if (!previous) return;
    const deadline = Date.parse(previous.confirmUntil ?? '');
    const confirmed =
      task.pendingAuthorHead && this.confirmedLegacyFixRevision(task, task.pendingAuthorHead);
    task.pendingAuthorFix ??= {
      revision: confirmed || previous.revision,
      generation: task.generation,
      targetBranch: task.pr?.targetBranch,
      pushStarted: previous.attempted,
      confirmUntil: Number.isFinite(deadline)
        ? deadline
        : previous.attempted
          ? Date.now() + fixConfirmationGraceMs
          : undefined,
    };
    task.pendingFix = undefined;
    const current = this.store.getTask(task.id);
    if (current.generation === task.generation && current.pendingFix) {
      current.pendingAuthorFix ??= task.pendingAuthorFix;
      current.pendingFix = undefined;
      this.store.saveTask(current);
    }
  }

  private pendingFixHead(task: Task, pr = task.pr): string | undefined {
    this.adoptPendingFix(task);
    const head = task.pendingAuthorHead;
    if (!head || isTicket(task)) return;
    if (task.pendingAuthorFix) return head;

    const saved = this.savedFixEvent(task, head);
    const job = saved && this.store.jobs(task.id).find((job) => job.id === saved.run_id);
    if (saved && job?.role === 'author' && job.kind === 'fix') {
      const original = parseRecordedRevision(saved.revision);
      if (head === original?.head || this.savedFixVerifiedInMerge(task, head, Number(saved.id)))
        return;
      const targetBranch =
        typeof saved.target_branch === 'string' ? saved.target_branch : undefined;
      // Older push receipts preceded the provider read. The old revision transition is the observation.
      const confirmed =
        typeof saved.saved_revision === 'string'
          ? this.savedFixSubmissionRecorded(task, head, Number(saved.id))
          : this.legacyFixConfirmed(task, pr, head, Number(saved.id), original, targetBranch);
      return confirmed ? undefined : head;
    }

    if (
      head !== task.revision?.head &&
      (task.state === 'awaiting_push' ||
        ((task.state === 'paused' || task.state === 'needs_input') &&
          task.resumeState === 'awaiting_push'))
    )
      return head;
  }

  private fixRunInterrupted(job: Job, savedEventId: number): boolean {
    if (job.status === 'cancelled') return true;
    return (
      job.status === 'failed' &&
      !!this.store.db
        .prepare(
          `SELECT 1 FROM events WHERE task_id=? AND run_id=? AND id>? AND type='job.interrupted' LIMIT 1`,
        )
        .get(job.taskId, job.id, savedEventId)
    );
  }

  private lostFix(task: Task, pr = task.pr): LostFix | undefined {
    if (
      !['queued', 'reviewing', 'needs_input', 'paused', 'awaiting_push'].includes(task.state) &&
      !reviewCompletionStates.includes(task.state)
    )
      return;
    // Read the revision pinned to the author run. Older services could replace the task's base.
    const saved = this.savedFixEvent(task);
    if (typeof saved?.head !== 'string') return;
    if (this.savedFixVerifiedInMerge(task, saved.head, Number(saved.id))) return;
    const legacy = typeof saved.saved_revision !== 'string';
    if (!legacy && this.savedFixSubmissionRecorded(task, saved.head, Number(saved.id))) return;
    const job = this.store.jobs(task.id).find((job) => job.id === saved.run_id);
    if (job?.role !== 'author' || job.kind !== 'fix') return;
    const interrupted =
      (!legacy || (job.status === 'cancelled' && typeof saved.revision === 'string')) &&
      this.fixRunInterrupted(job, Number(saved.id));
    const failedAfterSave = !legacy && job.status === 'failed' && job.generation <= task.generation;
    const generation = failedAfterSave ? job.generation : job.generation + 1;
    if (!interrupted && generation > task.generation) return;
    const transition = this.store.db
      .prepare(
        `SELECT transition.id, json_extract(transition.data, '$.head') AS head,
                json_extract(transition.data, '$.reason') AS reason FROM events transition
         WHERE transition.task_id=? AND transition.id>? AND transition.type='task.state'
         AND json_extract(transition.data, '$.state')='queued'
         AND json_extract(transition.data, '$.reason') IN (?, ?)
         AND json_extract(transition.data, '$.generation')=? LIMIT 1`,
      )
      .get(task.id, saved.id!, noAuthorChanges, authorPushedChanges, generation);
    if (
      !interrupted &&
      !failedAfterSave &&
      (!transition || (!legacy && transition.head === saved.head))
    )
      return;
    let recordedRevision = saved.revision;
    if (typeof recordedRevision !== 'string' && transition?.reason === noAuthorChanges) {
      // The old no-change transition was written only when the full revision still matched.
      recordedRevision =
        this.store.db
          .prepare(
            `SELECT json_extract(data, '$.revision') AS revision FROM events
           WHERE task_id=? AND id>? AND id<? AND type='revision.changed'
           AND json_extract(data, '$.generation')=? ORDER BY id DESC LIMIT 1`,
          )
          .get(task.id, saved.id!, transition.id!, generation)?.revision ?? null;
    }
    const revision = parseRecordedRevision(recordedRevision);
    const targetBranch = typeof saved.target_branch === 'string' ? saved.target_branch : undefined;
    if (
      revision?.head === saved.head ||
      (legacy &&
        this.legacyFixConfirmed(task, pr, saved.head, Number(saved.id), revision, targetBranch))
    )
      return;
    return {
      head: saved.head,
      revision,
      targetBranch,
      generation,
      authorCompleted: job.status === 'completed',
    };
  }

  private async resumeBlockedLostFix(task: Task, lost: LostFix, reason: string) {
    // The old job cannot authorize a send. An observed exact match can authorize review.
    const { revision: original, targetBranch } = lost;
    if (original) {
      const ref = prRef(task);
      const provider = this.provider(ref);
      if (!targetBranch) {
        const current = await provider.getPR(ref).catch(() => undefined);
        this.holdLostFix(task, lost.head, unknownFixTarget(task, current));
        return;
      }
      const current = await provider.getPR(ref);
      const check = this.savedFixRemoteStatus(task, current, lost.head, original, targetBranch);
      if (check.status === 'confirmed') {
        const staleDraft = hasSharedDraftSlot(task) ? task.review : undefined;
        if (staleDraft) {
          const reason = await this.inspectPreviousDraft(task, staleDraft);
          if (reason) {
            this.holdLostFix(task, lost.head, reason);
            return;
          }
        }
        task.pendingAuthorHead = lost.head;
        task.pendingAuthorFix = {
          revision: original,
          generation: task.generation,
          targetBranch,
          staleDraft,
        };
        this.queueConfirmedFixReview(task, current, lost.head, check.original);
        return;
      }
      if (check.status === 'blocked') {
        this.holdLostFix(task, lost.head, changedBeforeRecovery(current));
        return;
      }
    }
    this.state(task, 'needs_input', reason);
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
        const pr = await this.provider(prRef(task)).getPR(prRef(task));
        if (this.stopReviewBeforeSavedFix(task, pr)) return task;
        if (task.partialReview) return await this.releaseReviewFindings(task);
        const publication = await this.broker.publish(task);
        return await this.reconcileLocked(id, publication);
      } catch (error) {
        const current = this.store.getTask(id);
        if (
          error instanceof AppError &&
          ['review_target_changed', 'review_target_unverified'].includes(error.code) &&
          current.generation === task.generation
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
          task.ref.provider !== 'github' ||
          current.generation !== task.generation ||
          current.state !== 'awaiting_publication' ||
          current.review?.id !== task.review?.id ||
          !(
            error instanceof AppError &&
            (error instanceof GitHubRetryError ||
              /^(provider_(408|500|502|503|504)|provider_unreachable)$/.test(error.code))
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
        this.state(current, 'awaiting_publication', 'Waiting to retry GitHub review publication');
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
        (deferUntilPublished ||
          task.pendingAuthorFix ||
          task.pendingFix ||
          task.state === 'awaiting_push')
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
        task.pendingAuthorFix ||
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
  async recordSavedFix(job: Job, savedFix: { head: string; revision: Revision }) {
    for (let attempt = 0; ; attempt++) {
      try {
        const recorded = this.store.db
          .prepare(
            "SELECT 1 FROM events WHERE task_id=? AND run_id=? AND type='author.fixes_saved' AND json_extract(data,'$.head')=? LIMIT 1",
          )
          .get(job.taskId, job.id, savedFix.head);
        if (!recorded) this.store.event(job.taskId, 'author.fixes_saved', savedFix, job.id);
        return;
      } catch (error) {
        const busy =
          error instanceof Error &&
          'errcode' in error &&
          typeof error.errcode === 'number' &&
          (error.errcode & 255) === 5;
        if (!busy || attempt === 4) throw error;
        await delaySavedFixReceipt(25 * 2 ** attempt);
      }
    }
  }

  async completeJob(
    job: Job,
    result: AgentResult,
    savedFix?: { head: string; revision: Revision },
    saveFix?: (task: Task) => Promise<string>,
  ) {
    // Journal the local result before waiting on a task operation that may be reading the PR.
    if (savedFix) await this.recordSavedFix(job, savedFix);
    return this.lock(job.taskId, async () => {
      const task = this.store.getTask(job.taskId);
      if (task.generation !== job.generation || task.state === 'paused') {
        this.store.event(task.id, 'job.stale_result', { generation: job.generation }, job.id);
        if (savedFix) this.showInterruptedFix(task, job);
        return;
      }
      if (savedFix && savedFix.head !== savedFix.revision.head) {
        task.pendingAuthorHead = savedFix.head;
        task.pendingAuthorFix = { revision: savedFix.revision, generation: job.generation };
        this.store.saveTask(task);
      }
      if (isTicket(task)) {
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
      if (job.kind === 'review' && this.stopReviewBeforeSavedFix(task, pr)) return;
      if (job.kind === 'verify_merge') {
        if (await this.stopMergeBeforeSavedFix(task, pr)) return;
        this.store.message(task.id, job.role, 'agent', result.summary, job.id, job.id);
        if (
          pr.state !== 'merged' ||
          !sameRevision(task.revision, pr) ||
          pr.mergeCommit !== task.pr?.mergeCommit ||
          !samePullRequestBranches(task.pr, { ...pr, state: 'open' }) ||
          result.checkedHead !== pr.head
        ) {
          this.state(task, 'needs_input', 'The merged revision changed during verification');
        } else if (!(await this.prepareMergeVerificationFeedback(task, pr))) {
          return;
        } else if (result.status !== 'completed') {
          this.state(
            task,
            'needs_input',
            result.question || result.summary,
            requestsHumanInput(result) ? job : undefined,
          );
        } else if (
          result.disputedCommentIds?.length ||
          this.hasUnverifiedFindings(task, new Set(result.verifiedCommentIds)) ||
          (task.snapshot?.status === 'published' &&
            this.hasUnverifiedFindings(task, new Set(result.verifiedCommentIds), task.snapshot))
        ) {
          this.state(
            task,
            'needs_input',
            'Reviewer has not verified all previously published findings',
          );
        } else if (
          task.pendingAuthorHead === pr.head &&
          task.feedback?.status === 'published' &&
          task.feedback.revision.head !== pr.head &&
          task.feedback.comments.length &&
          !task.savedFixReview &&
          this.savedFixEvent(task, pr.head)
        ) {
          this.state(
            task,
            'needs_input',
            'The source review of the carried findings could not be recovered. Inspect the published review before verifying the merge.',
          );
        } else if (!this.mergeFindingsWerePresented(task, job)) {
          this.state(
            task,
            'needs_input',
            'Published findings changed or were not recorded for this run. Verify the current findings.',
          );
        } else {
          this.store.transaction(() => {
            task.summary = result.summary;
            task.pr = pr;
            const revision = revisionOf(pr);
            task.verifiedMerge = { ...revision, mergeCommit: pr.mergeCommit };
            if (task.pendingAuthorHead === pr.head) {
              this.store.event(
                task.id,
                'author.fix_verified_in_merge',
                {
                  revision,
                  mergeCommit: pr.mergeCommit,
                  targetBranch: pr.targetBranch,
                },
                job.id,
              );
              task.pendingAuthorHead = undefined;
            }
            task.pendingAuthorFix = undefined;
            this.finish(task);
          });
        }
        return;
      }
      if (job.kind === 'review' && (await this.stageReviewFindings(task, job, result, pr))) {
        this.store.message(task.id, job.role, 'agent', result.summary, job.id, job.id);
        return;
      }
      if (job.kind !== 'fix' && !sameRevision(task.revision, pr)) {
        const saved = this.pendingFixHead(task, pr);
        if (saved) {
          this.store.message(task.id, job.role, 'agent', result.summary, job.id);
          const check = this.savedFixStatus(task, pr, saved);
          if (check.status === 'blocked') this.blockSavedFix(task, saved, check.reason);
          return;
        }
        const lost = this.lostFix(task, pr);
        if (lost) {
          this.holdLostFix(task, lost.head, changedBeforeRecovery(pr));
          return;
        }
        if (
          job.kind === 'review' &&
          task.ref.provider === 'github' &&
          task.review &&
          pr.state === 'open'
        ) {
          await this.changeReviewRevision(task, pr);
          return;
        }
        if (await this.preservePreviousNativeReview(task)) return;
        this.invalidate(task, pr);
        this.state(
          task,
          'needs_input',
          'PR changed while the agent was working; its result did not advance the workflow',
        );
        return;
      }
      this.store.message(task.id, job.role, 'agent', result.summary, job.id, job.id);
      const pending = job.kind === 'fix' ? this.pendingFixHead(task, pr) : undefined;
      if (pending) {
        const check = await this.checkSavedFixForSubmission(task, pr, pending);
        if (check.status === 'blocked') {
          this.blockSavedFix(task, pending, check.reason);
          return;
        }
      }
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
        (await this.handOffIncompleteFix(task, result, pr, saveFix))
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
        if (this.stopReviewOnTargetChange(task, pr)) return;
        const snapshot = await this.provider(prRef(task)).getReview(prRef(task), task.review!);
        const decisions = this.store.decisions(task.id);
        const currentDecisions = new Map(
          decisions
            .filter(
              (d) =>
                d.generation === task.generation &&
                sameRevision(d.revision, task.revision) &&
                d.targetBranch === task.review?.targetBranch,
            )
            .map((d) => [d.commentId, d]),
        );
        const verified = new Set(result.verifiedCommentIds ?? []);
        if (
          result.disputedCommentIds?.length ||
          [...currentDecisions.values()].some(
            (d) =>
              d.outcome === 'disputed' &&
              (d.runId === job.id || !d.commentId || !verified.has(d.commentId)),
          )
        ) {
          task.reviewFinished = false;
          this.state(
            task,
            'needs_input',
            'Reviewer disputes published findings; resolve them before publication',
          );
          return;
        }
        const exempt = new Set(
          decisions
            .filter(
              (d) =>
                ['withdrawn', 'deferred', 'rejected'].includes(d.outcome) ||
                currentDecisions.get(d.commentId)?.outcome === 'verified',
            )
            .map((d) => d.commentId),
        );
        const unresolved =
          task.feedback?.comments.filter((c) => !verified.has(c.id) && !exempt.has(c.id)) ?? [];
        if (!snapshot.comments.length && unresolved.length) {
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
              task.draftRecheck.retried = true;
              this.state(
                task,
                'reviewing',
                'Rechecking the existing draft on the updated target branch',
              );
              this.store.enqueue(
                task,
                'reviewer',
                'review',
                'Finish rechecking the carried draft before publication.',
              );
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
        task.reviewFinished = true;
        delete task.openReviewQuestion;
        for (const id of verified)
          this.store.decision(
            task,
            {
              commentId: id,
              outcome: 'verified',
              reason: `Verified by the independent reviewer in round ${task.round}`,
            },
            job.id,
          );
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
            'Author disputes published findings; discuss them with the reviewer',
            job,
          );
          return;
        }
        if (pending) {
          this.state(task, 'awaiting_push', 'Author saved the fixes; sending them to the PR');
        } else if (
          !samePullRequestBranches(task.pr, pr) ||
          (!sameRevision(pr, task.revision) && task.ref.provider !== 'demo')
        ) {
          task.resumeState = 'fixing';
          this.state(task, 'needs_input', 'The PR head, base or branch changed during the fix.');
        } else {
          const changed = !sameRevision(pr, task.revision);
          task.pendingAuthorHead = undefined;
          this.invalidate(task, pr, false);
          this.state(task, 'queued', changed ? authorPushedChanges : noAuthorChanges);
        }
      } else {
        if (job.role === 'reviewer' && task.review) {
          task.snapshot = await this.provider(prRef(task)).getReview(prRef(task), task.review);
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
        if (task.draftStart && !task.review) {
          this.state(task, 'queued', 'Waiting to retry the GitHub review draft');
          return task;
        }
        if (isTicket(task)) {
          if (task.workerReport && ['queued', 'reviewing'].includes(task.resumeState ?? '')) {
            this.store.transaction(() => this.queueReportReview(task));
            return task;
          }
          const implementing = task.resumeState === 'implementing';
          this.state(
            task,
            implementing
              ? 'implementing'
              : task.pendingAuthorHead
                ? 'ready_for_review'
                : 'discussing',
            'Resumed ticket work; existing changes were preserved',
          );
          if (implementing)
            this.store.enqueue(
              task,
              'author',
              'implement',
              'Continue the interrupted task. Preserve the existing working copy and verify the requested outcome.',
            );
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
        const pending = this.pendingFixHead(task);
        const lost = pending ? undefined : this.lostFix(task);
        const recoveryBlock = lost && lostFixRecoveryBlock(lost, task);
        if (lost && recoveryBlock) {
          await this.resumeBlockedLostFix(task, lost, recoveryBlock);
          this.store.event(id, 'human.resume', { reason });
          return task;
        }
        const saved = pending ?? lost?.head;
        if (saved) {
          if (lost) {
            task.pendingAuthorHead = lost.head;
            task.pendingAuthorFix = {
              revision: task.revision!,
              generation: task.generation,
              targetBranch: lost.targetBranch,
              staleDraft: hasSharedDraftSlot(task) ? task.review : undefined,
            };
          } else if (task.pendingAuthorFix) {
            task.pendingAuthorFix.generation = task.generation;
          }
          this.store.transaction(() => {
            this.state(
              task,
              this.isConfirmedSavedFix(task, saved) ? 'queued' : 'awaiting_push',
              `Resumed with saved fix ${saved}. The PR revision will be checked before continuing.`,
            );
            this.store.event(id, 'human.resume', { reason });
          });
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
        if (!task.verifiedMerge && this.stopUnverifiedReviewTarget(task, current)) return task;
        if (this.stopReviewBeforeSavedFix(task, current)) return task;
        if (
          !sameRevision(current, task.revision) ||
          (task.verifiedMerge &&
            (current.state !== 'merged' || current.mergeCommit !== task.verifiedMerge.mergeCommit))
        )
          throw new AppError('stale_plan', 'The plan changed after review');
        task.approvedAt = now();
        task.pr = current;
        this.finishReviewedTask(task, 'Plan approved for implementation at this exact revision');
      } else if (action === 'waive-checks') {
        if (task.state !== 'awaiting_checks' || !reason.trim())
          throw new AppError(
            'waiver_invalid',
            'A waiver requires a reason and a task waiting for CI checks',
            400,
          );
        const current = await this.provider(prRef(task)).getPR(prRef(task));
        if (!task.verifiedMerge && this.stopUnverifiedReviewTarget(task, current)) return task;
        if (this.stopReviewBeforeSavedFix(task, current)) return task;
        if (!sameRevision(current, task.revision))
          throw new AppError(
            'stale_revision',
            'The PR changed; a waiver cannot apply to a new revision',
          );
        task.checksWaivedAt = now();
        this.store.event(id, 'checks.waived', {
          reason,
          head: task.revision?.head,
        });
        this.finish(task);
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
          this.store.event(task.id, 'review.legacy_start_confirmed', {
            operationId: marker,
            revision: task.revision,
            targetBranch: task.pr?.targetBranch,
          });
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
          job.generation === this.store.getTask(job.taskId).generation &&
          ['reviewing', 'fixing'].includes(this.store.getTask(job.taskId).state))
      ) {
        const task = this.store.getTask(job.taskId);
        const head = this.interruptedFixHead(task, job);
        const restartReason =
          'Server restarted during this run. Its external effects must be reconciled before retry.';
        const reason = head ? `${restartReason} Saved fix ${head} is preserved.` : restartReason;
        this.store.transaction(() => {
          job.status = 'failed';
          job.error = restartReason;
          job.errorCode = 'server_restarted';
          job.finishedAt = now();
          this.store.saveJob(job);
          task.resumeState = task.state;
          task.generation++;
          this.store.cancelJobs(task.id);
          this.state(task, 'needs_input', reason);
          this.store.event(task.id, 'job.interrupted', {}, job.id);
        });
      } else if (job.status === 'cancelled' && job.role === 'author' && job.kind === 'fix') {
        this.showInterruptedFix(this.store.getTask(job.taskId), job);
      }
  }

  private showInterruptedFix(task: Task, job: Job) {
    if (task.state !== 'needs_input' && task.state !== 'paused') return;
    const head = this.interruptedFixHead(task, job);
    if (head && !task.reason.includes(head))
      this.state(task, task.state, `${task.reason} Saved fix ${head} is preserved.`);
  }

  private interruptedFixHead(task: Task, job: Job): string | undefined {
    if (job.role !== 'author' || job.kind !== 'fix') return;
    const saved = this.savedFixEvent(task);
    const original = parseRecordedRevision(saved?.revision);
    if (
      saved?.run_id === job.id &&
      typeof saved.head === 'string' &&
      original &&
      saved.head !== original.head &&
      !this.savedFixSubmissionRecorded(task, saved.head, Number(saved.id))
    )
      return saved.head;
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
        task.pendingFix ||
        task.pendingAuthorFix ||
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
      task.pendingAuthorFix ||
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
    const message = redact(String(error));
    const saved = this.pendingFixHead(task) ?? this.interruptedFixHead(task, job);
    if (!saved && task.state === 'fixing' && this.queueConflictContinuation(task, job)) return;
    if (saved && job.kind === 'fix') task.resumeState = 'awaiting_push';
    const reason =
      saved && !message.includes(saved) ? `${message} Saved fix ${saved} is preserved.` : message;
    this.state(task, 'needs_input', reason);
    this.store.event(task.id, 'job.failed', { error: message }, job.id);
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
      if (job.role === role) job.profile = profile;
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
  async implement(id: string, actionId?: string, instruction?: string) {
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
      this.store.transaction(() => this.queueImplementation(task, actionId, instruction));
      return task;
    });
  }
  private queueImplementation(task: Task, actionId?: string, instruction?: string) {
    if (task.workerReport) {
      task.workerReport = undefined;
      task.reviewFinished = false;
      task.summary = '';
    }
    task.resumeState = 'implementing';
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
    if (previous?.kind === 'implement') return this.implement(id);
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
