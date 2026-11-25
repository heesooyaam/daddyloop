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
import { legacyQuotaRead } from '../providers/github-quota.js';
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
  type ReviewHandle,
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
  type AgentResult,
  type Workspace,
  type WorkerRequest,
} from './types.js';
import type { ReviewProvider } from '../providers/provider.js';
import { redact } from './security.js';
import { inheritedProfiles } from './agents.js';

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
  async review(id: string, retry = false, clarification?: string) {
    return this.lock(id, async () => {
      const task = this.store.getTask(id);
      if (this.store.busy(id))
        throw new AppError('task_busy', 'Wait for the active session or pause it first');
      if (task.state === 'paused')
        throw new AppError('task_paused', 'Resume this task before starting a review');
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
      if (
        (task.pendingFix && task.pendingAuthorHead !== task.revision?.head) ||
        task.state === 'awaiting_push'
      )
        throw new AppError(
          'fix_pending',
          `Resume submission of saved fix ${task.pendingAuthorHead} before review.`,
        );
      const provider = this.provider(prRef(task));
      const pr = await provider.getPR(prRef(task));
      if (retry && pr.state === 'merged') return this.queueMergeVerification(task, pr);
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
        this.holdSavedFix(task, pr);
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
        await this.changeReviewRevision(task, pr);
        return task;
      }
      if (changed) this.invalidate(task, pr);
      if (retry && task.review) {
        const snapshot = await this.provider(prRef(task)).getReview(prRef(task), task.review);
        if (snapshot.status === 'published') task.feedback = snapshot;
        if (snapshot.status === 'published' || snapshot.status === 'missing')
          this.invalidate(task, pr);
      }
      if (task.review && !retry && !changed)
        throw new AppError(
          'review_exists',
          'This revision already has a review. Discuss it or use retry to continue an interrupted run.',
        );
      if (!task.review) task.round++;
      task.pr = pr;
      task.revision = revisionOf(pr);
      await this.broker.ensureReview(task);
      task.reviewFinished = false;
      this.store.transaction(() => {
        task.pendingFix = undefined;
        this.state(task, 'reviewing', `Independent review, round ${task.round}`);
        this.store.enqueue(
          task,
          'reviewer',
          'review',
          retry
            ? 'Continue the interrupted review. Re-read the native draft and previous decisions; do not recreate deleted comments.' +
                (clarification?.trim()
                  ? '\nClarification from the session coordinator; verify it against the task: ' +
                    clarification.trim()
                  : '')
            : 'Review the complete change and verify previous published findings. Create or edit native draft comments using your review tools.',
        );
      });
      return task;
    });
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
    if (this.store.pendingReviewWrites(task.id, handle.marker).length) return draftSyncPending;
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
        (task.reason ===
          'PR changed while a draft existed. Inspect or discard the stale native draft before starting the next review.' ||
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
  private queueMergeVerification(task: Task, pr: PullRequest) {
    if (task.state !== 'needs_input' || this.store.busy(task.id))
      throw new AppError('task_busy', 'Choose an idle task that needs attention');
    if (pr.state !== 'merged' || pr.head !== task.revision?.head)
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
    this.store.transaction(() => {
      if (action.preparation !== 'resume') {
        this.invalidate(task, pr, !options.finishingRun);
        task.pendingFix = undefined;
        task.conflictCheckpoint = checkpoint;
        if (feedback?.status === 'published' && feedback.revision.head === pr.head)
          task.feedback = feedback;
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

  async publishedFixBaseAdvanced(task: Task, pr: PullRequest) {
    const pinned = task.revision;
    if (
      task.ref.provider !== 'github' ||
      !pinned ||
      task.pendingFix ||
      task.fixingMergeConflict ||
      !hasReleasedReview(task) ||
      task.snapshot?.status !== 'published' ||
      !sameRevision(task.snapshot.revision, pinned) ||
      !sameRevision(task.review?.revision, pinned) ||
      (task.pendingAuthorHead && task.pendingAuthorHead !== pinned.head) ||
      pr.draft !== false ||
      pr.head !== pinned.head ||
      pr.base === pinned.base ||
      !sameOpenTarget(task.pr, pr)
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
        task.resumeState !== 'fixing' ||
        task.pendingFix ||
        task.fixingMergeConflict ||
        this.store.busy(id)
      )
        return;
      const job = this.store.jobs(id).at(-1);
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
        if (!(restarted && same) && !(await this.publishedFixBaseAdvanced(task, pr))) return;
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

  private async changeReviewRevision(task: Task, pr: PullRequest) {
    const handle = task.review;
    if (
      task.ref.provider === 'github' &&
      handle &&
      !task.pendingFix &&
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
      hadUnpublished
        ? 'PR changed while a draft existed. Inspect or discard the stale native draft before starting the next review.'
        : 'New revision is ready for review',
    );
  }
  private async reconcileLocked(id: string, publication?: ReviewSnapshot): Promise<Task> {
    let task = this.store.getTask(id);
    if (task.state === 'paused' || isTicket(task)) return task;
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
    if (action.kind === 'check-fix-base' && (await this.publishedFixBaseAdvanced(task, pr)))
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
    const snapshot = await provider.getReview(prRef(task), task.review);
    if (task.snapshot && JSON.stringify(task.snapshot) !== JSON.stringify(snapshot))
      this.store.event(id, 'review.changed', {
        previous: task.snapshot,
        current: snapshot,
      });
    task.snapshot = snapshot;
    if (!sameRevision(snapshot.revision, task.revision)) {
      this.state(task, 'needs_input', 'Review points to a different revision');
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
  private async checkSavedFix(task: Task, pr: PullRequest, resume = false): Promise<boolean> {
    const head = task.pendingAuthorHead;
    const original = task.pendingFix?.revision ?? task.revision;
    if (!head || !original)
      throw new AppError('missing_fix', 'The saved fix or its original revision is missing');
    if (!task.pendingFix) {
      task.pendingFix = { revision: original };
      this.store.saveTask(task);
    }
    const sameTarget = sameOpenTarget(task.pr, pr);
    if (task.revision?.head === head) {
      if (!sameTarget || !sameRevision(task.revision, pr)) this.holdSavedFix(task, pr);
      else if (resume) this.state(task, 'queued', 'New revision is ready for review');
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
        this.store.event(id, 'author.submission_uncertain', { head, error: redact(String(error)) });
      }
      await this.checkSavedFix(task, await provider.getPR(prRef(task)));
    });
  }

  private hasUnverifiedFindings(task: Task, verified: Set<string>, feedback = task.feedback) {
    const decisions = this.store.decisions(task.id);
    const exempt = new Set(
      decisions
        .filter(
          (d) =>
            ['withdrawn', 'deferred', 'rejected'].includes(d.outcome) ||
            (d.outcome === 'verified' && d.head === task.revision?.head),
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

  private async finish(task: Task) {
    const gate = completionGate(task);
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
    task.feedback = snapshot;
    if (sameRevision(task.revision, pr)) task.pr = pr;
    await this.afterPublishedReview(task, pr, snapshot);
    return true;
  }
  private async afterPublishedReview(task: Task, pr: PullRequest, snapshot: ReviewSnapshot) {
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
        'Address exactly the published feedback snapshot. Explain disputes. Do not treat the reviewer’s private draft or old summary as additional requirements.',
      );
    });
  }

  recoverLostFixes() {
    for (const task of this.store.tasks()) {
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
      if (task.partialReview) return this.releaseReviewFindings(task);
      const publication = await this.broker.publish(task);
      return this.reconcileLocked(id, publication);
    });
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
        (deferUntilPublished || task.pendingFix || task.state === 'awaiting_push')
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
      if (task.pendingFix || task.state === 'awaiting_push')
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
        this.store.enqueue(task, role, 'chat', text, actionId);
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
  async completeJob(job: Job, result: AgentResult, saveFix?: (task: Task) => Promise<string>) {
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
        const head = await saveFix(task);
        this.store.transaction(() => {
          task.pendingAuthorHead = head;
          task.pendingFix = head === result.checkedHead ? undefined : { revision: task.revision! };
          this.store.saveTask(task);
          this.store.event(
            task.id,
            'author.fixes_saved',
            { head, revision: task.revision },
            job.id,
          );
        });
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
      if (job.kind === 'fix' && task.pendingFix) {
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
        } else {
          task.summary = result.summary;
          task.pr = pr;
          task.verifiedMerge = { ...revisionOf(pr), mergeCommit: pr.mergeCommit };
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
        const snapshot = await this.provider(prRef(task)).getReview(prRef(task), task.review!);
        const verified = new Set(result.verifiedCommentIds ?? []);
        if (!snapshot.comments.length && this.hasUnverifiedFindings(task, verified)) {
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
          this.store.decision(task, {
            commentId: id,
            outcome: 'verified',
            reason: `Verified by the independent reviewer in round ${task.round}`,
          });
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
        this.state(task, target, 'Resumed by the user; current provider state will be reconciled');
      } else if (action === 'approve-plan') {
        if (task.state !== 'awaiting_plan_approval' || task.kind !== 'plan')
          throw new AppError('plan_not_ready', 'This plan is not ready for approval');
        const current = await this.provider(prRef(task)).getPR(prRef(task));
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
        await this.finish(task);
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
      if (task.state !== 'needs_input' || task.inputRequest) continue;
      const job = this.store.jobs(task.id).at(-1);
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
      if (task.state === 'submitting')
        this.state(
          task,
          'needs_input',
          'PR submission was interrupted. Submit again to reconcile its native result before retrying.',
        );
    for (const job of this.store.jobs())
      if (
        job.status === 'running' ||
        (job.status === 'cancelled' &&
          job.generation === this.store.getTask(job.taskId).generation &&
          ['reviewing', 'fixing'].includes(this.store.getTask(job.taskId).state))
      ) {
        job.status = 'failed';
        job.error = interruptedByRestart;
        job.errorCode = 'server_restarted';
        job.finishedAt = now();
        this.store.saveJob(job);
        const task = this.store.getTask(job.taskId);
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
  failJob(job: Job, error: unknown) {
    const task = this.store.getTask(job.taskId);
    if (task.generation !== job.generation || task.state === 'paused') return;
    task.resumeState = task.state;
    if (job.role === 'reviewer') task.reviewFinished = false;
    const reason = redact(String(error));
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
      const pr = await this.provider(ref).getPR(ref);
      if (expectedHead && pr.head !== expectedHead)
        throw new AppError(
          'submitted_head_changed',
          'The PR does not point to the submitted implementation; inspect it before connecting',
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
