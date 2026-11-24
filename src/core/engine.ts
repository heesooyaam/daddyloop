import { legacyQuotaRead } from '../providers/github-quota.js';
import { randomUUID, createHash } from 'node:crypto';
import { Store } from './store.js';
import { Broker } from './broker.js';
import { autoMergeEnabled, autoMergeRequested } from './auto-merge.js';
import {
  AppError,
  assertTaskVersion,
  type ExpectedTask,
  prRef,
  isTicket,
  type AgentProfiles,
  type AgentProfile,
  type ReviewGroup,
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

function sameOpenTarget(expected: PullRequest | undefined, current: PullRequest) {
  return (
    current.state === 'open' &&
    current.branch === expected?.branch &&
    current.targetBranch === expected.targetBranch &&
    current.cloneUrl === expected.cloneUrl
  );
}

// Only retry failures from preparing a conflict job against an outdated base.
export function staleConflictPreparation(task: Task) {
  return (
    task.state === 'needs_input' &&
    task.fixingMergeConflict === true &&
    !task.pendingFix &&
    task.resumeState === 'fixing' &&
    (task.reason ===
      'AppError: The worker copy has no pending merge of the expected target commit.' ||
      task.reason ===
        'AppError: The PR changed before the queued job started. Reconcile and review the new revision.')
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
  private state(task: Task, state: State, reason: string) {
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
  async review(id: string, retry = false) {
    return this.lock(id, async () => {
      const task = this.store.getTask(id);
      if (this.store.busy(id))
        throw new AppError('task_busy', 'Wait for the active session or pause it first');
      if (task.state === 'paused')
        throw new AppError('task_paused', 'Resume this task before starting a review');
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
      if (this.queueConflictIfReady(task, pr)) return task;
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
            ? 'Continue the interrupted review. Re-read the native draft and previous decisions; do not recreate deleted comments.'
            : 'Review the complete change and verify previous published findings. Create or edit native draft comments using your review tools.',
        );
      });
      return task;
    });
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
    const suffix = `\n\n<!-- ${handle.marker} -->`;
    const body = source?.body ?? '';
    const digest = createHash('sha256')
      .update(JSON.stringify({ body: body.slice(0, -suffix.length) }))
      .digest('hex');
    const knownSummary =
      body === 'Review in progress.' + suffix ||
      (body.endsWith(suffix) &&
        this.store.db
          .prepare(
            "SELECT 1 FROM operations WHERE task_id=? AND id GLOB ? AND request=? AND status='done'",
          )
          .get(task.id, handle.marker + ':*:set_summary:*', digest));
    if (
      !source ||
      source.status !== 'draft' ||
      source.revision.head !== handle.revision.head ||
      !handle.authorId ||
      source.comments.length ||
      !knownSummary ||
      !provider.discardSupersededDraft ||
      (archived && archived.body !== body)
    ) {
      this.state(
        task,
        'needs_input',
        'Inspect the old review draft: it contains changes that daddy cannot safely replace.',
      );
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
      if (
        !job ||
        job.status !== 'failed' ||
        job.generation !== task.generation ||
        job.groupGeneration !== group.generation
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
        task.resumeState !== 'reviewing' ||
        job.kind !== 'review' ||
        !task.review ||
        task.pendingFix ||
        job.error !== task.reason
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
      if (!quota && !((context || timeout || staleStart) && autoMergeEnabled(this.store, task)))
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
      // Rebind only an untouched service placeholder when the target advanced.
      if (
        !sameRevision(task.review.revision, pr) &&
        (draft.comments.length ||
          draft.body !== `Review in progress.\n\n<!-- ${task.review.marker} -->`)
      ) {
        if (!context)
          this.state(
            task,
            'needs_input',
            'Inspect the old review draft: it contains changes that daddy cannot safely replace.',
          );
        return;
      }
      const currentGroup = this.store.getGroup(task.groupId);
      if (
        currentGroup.generation !== job.groupGeneration ||
        currentGroup.deletedAt ||
        currentGroup.deletion ||
        currentGroup.daddyState === 'paused' ||
        currentGroup.daddyState === 'archived' ||
        (!quota && !autoMergeEnabled(this.store, task))
      )
        return;
      const handle = task.review;
      this.store.transaction(() => {
        if (
          context &&
          currentGroup.reviewerThreadId &&
          currentGroup.reviewerThreadId === job.threadId
        ) {
          currentGroup.reviewerThreadId = undefined;
          this.store.saveGroup(currentGroup);
        }
        this.invalidate(task, pr);
        task.reviewerThreadId = undefined;
        task.review = { ...handle, revision: revisionOf(pr) };
        task.snapshot = { ...draft, revision: revisionOf(pr) };
        this.state(
          task,
          'reviewing',
          context
            ? 'Reviewer context was full. Restarting the independent review.'
            : 'Continuing the independent review on the verified PR head',
        );
        const retry = this.store.enqueue(
          task,
          'reviewer',
          'review',
          'Independently review the full current revision. Read the existing native draft and recorded decisions before editing. Verify all earlier published findings.',
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
  private queueConflictIfReady(task: Task, pr: PullRequest) {
    if (
      !pr.mergeConflict ||
      pr.draft !== false ||
      !sameOpenTarget(task.pr, pr) ||
      ![
        'complete',
        'awaiting_merge',
        'awaiting_checks',
        'awaiting_plan_approval',
        'queued',
      ].includes(task.state) ||
      (task.review && task.snapshot?.status !== 'published') ||
      (task.pendingFix &&
        (task.pendingAuthorHead !== pr.head || !sameRevision(task.revision, pr))) ||
      (task.pendingAuthorHead && task.pendingAuthorHead !== pr.head) ||
      this.store.busy(task.id) ||
      !autoMergeEnabled(this.store, task)
    )
      return false;
    this.store.transaction(() => {
      this.invalidate(task, pr);
      task.pendingFix = undefined;
      this.enqueueConflictRepair(task);
    });
    return true;
  }
  private async handOffIncompleteFix(
    task: Task,
    result: AgentResult,
    pr: PullRequest,
    checkpoint: (task: Task) => Promise<string>,
  ) {
    if (
      result.status !== 'incomplete' ||
      result.question?.trim() ||
      result.disputedCommentIds?.length ||
      !task.revision ||
      result.checkedHead !== pr.head ||
      task.revision.head !== pr.head ||
      !pr.mergeConflict ||
      pr.draft !== false ||
      !sameOpenTarget(task.pr, pr) ||
      !autoMergeEnabled(this.store, task) ||
      task.fixingMergeConflict ||
      task.pendingFix ||
      !task.authorWorktree ||
      task.snapshot?.status !== 'published' ||
      !task.reviewFinished
    )
      return false;
    const saved = await checkpoint(task);
    this.store.transaction(() => {
      this.invalidate(task, pr, false);
      task.conflictCheckpoint = saved;
      this.enqueueConflictRepair(task);
      this.store.event(task.id, 'author.conflict_checkpoint', {
        head: saved,
        revision: task.revision,
      });
    });
    return true;
  }

  async recoverIncompleteFix(id: string, checkpoint: (task: Task) => Promise<string>) {
    return this.lock(id, async () => {
      const task = this.store.getTask(id);
      if (
        task.state !== 'needs_input' ||
        task.resumeState !== 'fixing' ||
        task.pendingFix ||
        task.fixingMergeConflict ||
        this.store.busy(id) ||
        !autoMergeEnabled(this.store, task)
      )
        return;
      const job = this.store.jobs(id).at(-1);
      if (
        !job ||
        job.kind !== 'fix' ||
        job.generation !== task.generation ||
        job.status !== 'completed'
      )
        return;
      const item = this.store.db
        .prepare(
          "SELECT json_extract(data,'$.text') AS text FROM events WHERE task_id=? AND run_id=? AND type='runtime.item' AND json_extract(data,'$.type')='agentMessage' AND json_extract(data,'$.phase')='final_answer' ORDER BY id DESC LIMIT 1",
        )
        .get(id, job.id);
      if (typeof item?.text !== 'string') return;
      let result: AgentResult;
      try {
        result = JSON.parse(item.text);
      } catch {
        return;
      }
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

  private enqueueConflictRepair(task: Task) {
    task.fixingMergeConflict = true;
    this.state(task, 'fixing', 'Worker assigned to resolve the GitHub merge conflict');
    this.store.enqueue(
      task,
      'author',
      'fix',
      'Resolve the merge conflicts in the prepared working copy. Preserve the intended behavior of both branches and verify the result.',
    );
  }
  private async reconcileLocked(id: string): Promise<Task> {
    let task = this.store.getTask(id);
    if (task.state === 'paused' || isTicket(task)) return task;
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
    if (staleConflictPreparation(task)) {
      if (
        task.revision?.head === pr.head &&
        task.revision.base !== pr.base &&
        sameOpenTarget(task.pr, pr) &&
        pr.draft === false &&
        pr.mergeable != null &&
        !this.store.busy(task.id) &&
        autoMergeEnabled(this.store, task)
      ) {
        this.store.transaction(() => {
          this.invalidate(task, pr);
          if (pr.mergeConflict) this.enqueueConflictRepair(task);
          else this.state(task, 'queued', 'New revision is ready for review');
        });
      }
      return task;
    }
    if (this.queueConflictIfReady(task, pr)) return task;
    if (task.state === 'fixing' && task.fixingMergeConflict) {
      if (task.revision?.head !== pr.head || !sameOpenTarget(task.pr, pr)) {
        this.onCancel(id);
        this.store.cancelJobs(id);
        task.generation++;
        task.resumeState = 'fixing';
        this.state(
          task,
          'needs_input',
          'The PR changed during conflict resolution. Inspect the preserved worker copy.',
        );
      }
      return task;
    }
    if (!sameRevision(task.revision, pr)) {
      const hadUnpublished =
        task.review && task.snapshot?.status !== 'published' && task.state !== 'awaiting_push';
      const handle = task.review,
        previous = task.snapshot;
      this.invalidate(task, pr);
      if (hadUnpublished) {
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
      if (!task.reviewFinished) {
        this.state(
          task,
          'needs_input',
          'The review was not completed successfully; published feedback is held until verification',
        );
        return task;
      }
      this.store.event(id, 'review.published', {
        reviewId: task.review.id,
        snapshot,
      });
      if (snapshot.comments.length) {
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
      } else await this.finish(task);
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
    if (task.policy.requireChecks && !task.checksWaivedAt && task.pr?.checks !== 'passing') {
      this.state(
        task,
        'awaiting_checks',
        task.pr?.checks === 'missing'
          ? 'No CI results for this revision. Add checks or record a human waiver.'
          : `CI is ${task.pr?.checks} on the reviewed revision`,
      );
      return;
    }
    if (task.kind === 'plan' && task.policy.planApproval === 'human' && !task.approvedAt)
      this.state(
        task,
        'awaiting_plan_approval',
        'Plan review is complete. Human approval is required before implementation.',
      );
    else {
      if (task.kind === 'plan') task.approvedAt = now();
      this.finishReviewedTask(
        task,
        task.verifiedMerge ? 'daddy verified the merged result' : undefined,
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
      if (task.state !== 'awaiting_publication' || !task.reviewFinished || this.store.busy(id))
        throw new AppError(
          'publication_unavailable',
          'Wait until the reviewer has finished and discussion is idle',
        );
      await this.broker.publish(task);
      return this.reconcileLocked(id);
    });
  }
  async chat(id: string, role: 'author' | 'reviewer', text: string, actionId?: string) {
    return this.lock(id, async () => {
      const task = this.store.getTask(id);
      if (role === 'author' && (task.pendingFix || task.state === 'awaiting_push')) {
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
          this.state(task, 'needs_input', result.question || result.summary);
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
      if (job.kind !== 'fix' && !sameRevision(task.revision, pr)) {
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
        task.reviewFinished = true;
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
          if (!sameOpenTarget(task.pr, pr) || !sameRevision(task.revision, pr))
            throw new AppError(
              'stale_revision',
              'The PR changed during conflict resolution. Inspect the preserved worker copy.',
            );
          if (!autoMergeEnabled(this.store, task))
            throw new AppError(
              'automerge_disabled',
              'Enable auto-merge before resuming conflict resolution.',
            );
          this.store.transaction(() => this.enqueueConflictRepair(task));
          return task;
        }
        if (
          task.resumeState === 'fixing' &&
          task.reviewFinished &&
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
        job.error =
          'Server restarted during this run. Its external effects must be reconciled before retry.';
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
  reconfigureAuthor(task: Task, profile: AgentProfile, isFinalizing: (id: string) => boolean) {
    const jobs = this.store.activeJobs(task.id).filter((job) => job.generation === task.generation);
    const previous = jobs.find(
      (job) =>
        job.role === 'author' &&
        job.status === 'running' &&
        !isFinalizing(job.id) &&
        !sameAgentProfile(job.profile, profile),
    );
    if (previous) task.generation++;
    this.applyAuthorProfile(task, profile);
    if (task.workerRequest?.profile) task.workerRequest.profile = profile;
    this.store.saveTask(task);

    for (const job of jobs) {
      if (job.status !== 'queued') continue;
      job.generation = task.generation;
      if (job.role === 'author') job.profile = profile;
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
