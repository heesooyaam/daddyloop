import { randomUUID, createHash } from 'node:crypto';
import { Store } from './store.js';
import { Broker } from './broker.js';
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
  defaultPolicy,
  now,
  sameRevision,
  sameAgentProfile,
  revisionOf,
  type Task,
  type PRRef,
  type PullRequest,
  type Revision,
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
const noAuthorChanges =
  'Author made no code changes; independent verification of the decisions is next';
const authorPushedChanges = 'Author pushed changes; independent verification is next';
const staleDraftReason =
  'GitHub still has a draft on the previous revision. Inspect it on GitHub and clear the pending review before resuming.';
const fixConfirmationGraceMs = 60_000;
const reviewCompletionStates: State[] = [
  'awaiting_publication',
  'awaiting_checks',
  'awaiting_plan_approval',
];

interface LostFix {
  head: string;
  revision?: Revision;
  generation: number;
  authorCompleted: boolean;
}

type SavedFixCheck =
  { status: 'ready' | 'confirmed' | 'waiting' } | { status: 'blocked'; reason: string };

function lostFixRecoveryBlock(fix: LostFix, task: Task) {
  const storedBase = task.revision?.base ?? 'unknown';
  if (!fix.revision)
    return `The original PR revision for saved fix ${fix.head} is unavailable. Stored PR base ${storedBase}.`;
  if (!sameRevision(fix.revision, task.revision))
    return `The stored PR revision changed for saved fix ${fix.head}. Original base ${fix.revision.base}. Stored PR base ${storedBase}.`;
  if (!fix.authorCompleted)
    return `The author run did not record completion. Inspect saved fix ${fix.head} before continuing.`;
  if (fix.generation !== task.generation)
    return `Saved fix ${fix.head} belongs to an earlier task generation. Resolve it before starting another review.`;
}

function changedBeforeRecovery(pr: PullRequest) {
  return `The PR revision or branch changed before recovery. Observed PR head ${pr.head} and base ${pr.base}.`;
}

function pendingFixHead(task: Task) {
  if (
    task.pendingAuthorFix ||
    ((task.state === 'awaiting_push' ||
      ((task.state === 'paused' || task.state === 'needs_input') &&
        task.resumeState === 'awaiting_push')) &&
      task.pendingAuthorHead !== task.revision?.head)
  )
    return task.pendingAuthorHead;
}

function samePullRequestBranches(expected: PullRequest | undefined, current: PullRequest) {
  return (
    current.state === 'open' &&
    expected?.branch === current.branch &&
    expected.targetBranch === current.targetBranch &&
    expected.cloneUrl === current.cloneUrl
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
  requireSubmittedFix(task: Task): string | undefined {
    const pending = pendingFixHead(task);
    if (
      pending &&
      task.pendingAuthorFix?.generation === task.generation &&
      this.isConfirmedSavedFix(task, pending)
    )
      return pending;
    const lost = pending ? undefined : this.lostFix(task);
    const unsent = pending ?? lost?.head;
    if (unsent)
      throw new AppError(
        'fix_pending',
        (lost && lostFixRecoveryBlock(lost, task)) ??
          `Resume the task to submit saved fix ${unsent} before review.`,
      );
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
      const pending = this.requireSubmittedFix(task);
      const pr = await this.provider(prRef(task)).getPR(prRef(task));
      if (pending && (!sameRevision(task.revision, pr) || !samePullRequestBranches(task.pr, pr))) {
        const check = this.savedFixStatus(task, pr, pending);
        const reason =
          check.status === 'blocked'
            ? check.reason
            : 'The PR changed after submission and before review.';
        this.blockSavedFix(task, pending, reason);
        return task;
      }
      const staleDraft = task.pendingAuthorFix?.staleDraft;
      if (pending && staleDraft) {
        const snapshot = await this.provider(prRef(task)).getReview(prRef(task), staleDraft);
        if (snapshot.status === 'draft') {
          this.blockSavedFix(task, pending, staleDraftReason);
          return task;
        }
      }
      if (pr.state !== 'open') throw new AppError('pr_closed', 'The PR is closed');
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
      if (pending) {
        task.pendingAuthorFix = undefined;
        task.resumeState = undefined;
      }
      this.store.transaction(() => {
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
  async reconcile(id: string) {
    return this.lock(id, () => this.reconcileLocked(id));
  }
  private async reconcileLocked(id: string): Promise<Task> {
    const task = this.store.getTask(id);
    if (task.state === 'paused' || isTicket(task)) return task;
    const pending = pendingFixHead(task);
    if (pending && task.state !== 'fixing') return task;
    const provider = this.provider(prRef(task)),
      pr = await provider.getPR(prRef(task));
    const lost = this.lostFix(task);
    if (lost) {
      if (pr.state !== 'open')
        this.holdLostFix(task, lost.head, `PR is ${pr.state}. Automatic work stopped.`);
      else if (
        lost.revision &&
        this.savedFixRemoteStatus(task, pr, lost.head, lost.revision).status === 'confirmed'
      )
        this.holdLostFix(
          task,
          lost.head,
          'The PR contains the saved fix on the original base. Resume the task to continue review.',
        );
      else if (
        !sameRevision(lost.revision, pr) ||
        !sameRevision(lost.revision, task.revision) ||
        !samePullRequestBranches(task.pr, pr)
      )
        this.holdLostFix(task, lost.head, changedBeforeRecovery(pr));
      else if (reviewCompletionStates.includes(task.state)) this.holdLostFix(task, lost.head);
      return task;
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
    // Fix completion handles open PR revisions.
    if (pending || (task.state === 'fixing' && this.store.busy(id))) return task;
    if (!sameRevision(task.revision, pr)) {
      const hadUnpublished =
        task.review && task.snapshot?.status !== 'published' && task.state !== 'awaiting_push';
      this.invalidate(task, pr);
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
    if (this.store.busy(id)) {
      this.store.saveTask(task);
      return task;
    }
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
    } else if (task.state === 'awaiting_checks' || task.state === 'awaiting_plan_approval')
      await this.finish(task);
    else this.store.saveTask(task);
    return this.store.getTask(id);
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
      this.state(
        task,
        'complete',
        'Current revision reviewed; publication, findings and checks are accounted for',
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
    const jobs = this.store.activeJobs(task.id);
    const running = jobs.some((job) => job.status === 'running');
    this.store.transaction(() => {
      if (running) task.generation++;
      if (jobs.length) this.store.cancelJobs(task.id);
      this.state(task, 'needs_input', `${reason} Saved fix ${head} is preserved.`);
    });
    if (running) this.onCancel(task.id);
  }

  private stopLegacyReview(task: Task): boolean {
    const lost = this.lostFix(task);
    if (!lost) return false;
    this.holdLostFix(task, lost.head);
    return true;
  }

  private savedFixStatus(task: Task, pr: PullRequest, head: string): SavedFixCheck {
    const pending = task.pendingAuthorFix;
    const original = pending?.revision ?? task.feedback?.revision ?? task.revision;
    if (
      original &&
      (pending ? pending.generation === task.generation : task.authorBaseHead === original.head)
    ) {
      const check = this.savedFixRemoteStatus(task, pr, head, original);
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
      this.savedFixRemoteStatus(task, pr, head, pendingAuthorFix.revision).status === 'confirmed'
    );
  }

  private savedFixRemoteStatus(
    task: Task,
    pr: PullRequest,
    head: string,
    original: Revision,
  ): SavedFixCheck {
    if (!samePullRequestBranches(task.pr, pr))
      return {
        status: 'blocked',
        reason: 'The PR was closed or its source or target branch changed.',
      };
    if (pr.base !== original.base || pr.start !== original.start)
      return {
        status: 'blocked',
        reason: `The PR comparison base changed. Original base ${original.base} (start ${original.start}). Observed base ${pr.base} (start ${pr.start}).`,
      };
    if (pr.head === head) {
      if (original.revisionId && (!pr.revisionId || pr.revisionId === original.revisionId))
        return { status: 'waiting' };
      return { status: 'confirmed' };
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
      const until = task.pendingAuthorFix?.confirmUntil;
      if (until === undefined || Date.now() < until) throw error;
      this.blockSavedFix(task, head, `Could not confirm the PR revision. ${redact(String(error))}`);
    }
  }

  private queueConfirmedFixReview(task: Task, pr: PullRequest, head: string) {
    this.store.transaction(() => {
      const sent = task.pendingAuthorFix?.sent === true;
      const original = task.pendingAuthorFix?.revision ?? task.revision!;
      this.invalidate(task, pr, false);
      task.pendingAuthorFix = {
        ...task.pendingAuthorFix,
        revision: original,
        generation: task.generation,
        sent,
      };
      task.resumeState = undefined;
      this.store.event(task.id, 'author.submitted', { head, pushed: sent });
      this.state(task, 'queued', 'New revision is ready for review');
    });
  }

  async submitSavedFix(
    id: string,
    preparePush: (task: Task, head: string) => Promise<() => Promise<void>>,
  ) {
    return this.lock(id, async () => {
      const task = this.store.getTask(id);
      if (isTicket(task) || task.state !== 'awaiting_push' || this.store.busy(id)) return;
      const head = pendingFixHead(task);
      if (!head) return;
      const pendingFix = task.pendingAuthorFix;
      if ((pendingFix?.sent || pendingFix?.pushStarted) && pendingFix.confirmUntil === undefined) {
        pendingFix.confirmUntil = Date.now() + fixConfirmationGraceMs;
        this.store.saveTask(task);
      }
      let pr = await this.readSavedFixPR(task, head);
      if (!pr) return;
      const waitingReason = `Waiting for the PR to confirm saved fix ${head}.`;
      let check = this.savedFixStatus(task, pr, head);
      if (
        check.status === 'ready' &&
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
        check = this.savedFixStatus(task, pr, head);
        if (check.status === 'ready') {
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
            this.blockSavedFix(task, head, redact(String(error)));
            return;
          }
          pending.sent = true;
          pending.confirmUntil = Date.now() + fixConfirmationGraceMs;
          this.state(task, 'awaiting_push', waitingReason);
          pr = await this.readSavedFixPR(task, head);
          if (!pr) return;
          check = this.savedFixStatus(task, pr, head);
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
      this.queueConfirmedFixReview(task, pr, head);
    });
  }

  private lostFix(task: Task): LostFix | undefined {
    if (
      !['queued', 'reviewing', 'needs_input', 'paused', 'awaiting_push'].includes(task.state) &&
      !reviewCompletionStates.includes(task.state)
    )
      return;
    // Read the revision pinned to the author run. Older services could replace the task's base.
    const saved = this.store.db
      .prepare(
        `SELECT saved.id, saved.run_id, json_extract(saved.data, '$.head') AS head,
            COALESCE(json_extract(saved.data, '$.revision'), (
              SELECT json_extract(feedback.data, '$.revision') FROM events feedback
              WHERE feedback.task_id=saved.task_id AND feedback.run_id=saved.run_id
                AND feedback.type='author.feedback_snapshot' AND feedback.id<saved.id
              ORDER BY feedback.id DESC LIMIT 1
            )) AS revision
         FROM events saved
         WHERE saved.task_id=? AND saved.type='author.fixes_saved' ORDER BY saved.id DESC LIMIT 1`,
      )
      .get(task.id);
    if (typeof saved?.head !== 'string') return;
    const job = this.store.jobs(task.id).find((job) => job.id === saved.run_id);
    if (job?.kind !== 'fix') return;
    const generation = job.generation + 1;
    if (generation > task.generation) return;
    const transition = this.store.db
      .prepare(
        `SELECT transition.id, json_extract(transition.data, '$.head') AS head,
                json_extract(transition.data, '$.reason') AS reason FROM events transition
         WHERE transition.task_id=? AND transition.id>? AND transition.type='task.state'
         AND json_extract(transition.data, '$.state')='queued'
         AND json_extract(transition.data, '$.reason') IN (?, ?)
         AND json_extract(transition.data, '$.generation')=?
         AND NOT EXISTS (
           SELECT 1 FROM events submission WHERE submission.task_id=transition.task_id
           AND submission.id>transition.id AND submission.type='author.submitted'
           AND json_extract(submission.data, '$.head')=?
         ) LIMIT 1`,
      )
      .get(task.id, saved.id!, noAuthorChanges, authorPushedChanges, generation, saved.head);
    if (!transition || transition.head === saved.head) return;
    let recordedRevision = saved.revision;
    if (typeof recordedRevision !== 'string' && transition.reason === noAuthorChanges) {
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
    const revision =
      typeof recordedRevision === 'string' ? (JSON.parse(recordedRevision) as Revision) : undefined;
    if (revision?.head === saved.head) return;
    return { head: saved.head, revision, generation, authorCompleted: job.status === 'completed' };
  }

  private async resumeBlockedLostFix(task: Task, lost: LostFix, reason: string) {
    // The old job cannot authorize a send. An observed exact match can authorize review.
    const original = lost.revision;
    if (original) {
      const ref = prRef(task);
      const provider = this.provider(ref);
      const current = await provider.getPR(ref);
      const check = this.savedFixRemoteStatus(task, current, lost.head, original);
      if (check.status === 'confirmed') {
        const staleDraft = ref.provider === 'github' ? task.review : undefined;
        if (staleDraft && (await provider.getReview(ref, staleDraft)).status === 'draft') {
          this.holdLostFix(task, lost.head, staleDraftReason);
          return;
        }
        task.pendingAuthorHead = lost.head;
        task.pendingAuthorFix = { revision: original, generation: task.generation, staleDraft };
        this.queueConfirmedFixReview(task, current, lost.head);
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
      if (task.state !== 'awaiting_publication' || !task.reviewFinished || this.store.busy(id))
        throw new AppError(
          'publication_unavailable',
          'Wait until the reviewer has finished and discussion is idle',
        );
      if (this.stopLegacyReview(task)) return task;
      await this.broker.publish(task);
      return this.reconcileLocked(id);
    });
  }
  async chat(id: string, role: 'author' | 'reviewer', text: string, actionId?: string) {
    return this.lock(id, async () => {
      const task = this.store.getTask(id);
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
  async completeJob(
    job: Job,
    result: AgentResult,
    savedFix?: { head: string; revision: Revision },
  ) {
    return this.lock(job.taskId, async () => {
      const task = this.store.getTask(job.taskId);
      const stale = task.generation !== job.generation || task.state === 'paused';
      if (savedFix) {
        this.store.transaction(() => {
          this.store.event(task.id, 'author.fixes_saved', savedFix, job.id);
          if (!stale && savedFix.head !== savedFix.revision.head) {
            task.pendingAuthorHead = savedFix.head;
            task.pendingAuthorFix = { revision: savedFix.revision, generation: job.generation };
            this.store.saveTask(task);
          }
        });
      }
      if (stale) {
        this.store.event(task.id, 'job.stale_result', { generation: job.generation }, job.id);
        return;
      }
      if (isTicket(task)) {
        this.store.transaction(() => {
          this.store.message(task.id, job.role, 'agent', result.summary, job.id);
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
      if (job.kind === 'review' && this.stopLegacyReview(task)) return;
      const pr = await this.provider(prRef(task)).getPR(prRef(task));
      if (job.kind !== 'fix' && !sameRevision(task.revision, pr)) {
        const saved = task.pendingAuthorHead;
        if (task.pendingAuthorFix && saved) {
          this.store.message(task.id, job.role, 'agent', result.summary, job.id);
          const check = this.savedFixStatus(task, pr, saved);
          if (check.status === 'blocked') this.blockSavedFix(task, saved, check.reason);
          return;
        }
        const lost = this.lostFix(task);
        if (lost) {
          this.holdLostFix(task, lost.head, changedBeforeRecovery(pr));
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
      this.store.message(task.id, job.role, 'agent', result.summary, job.id);
      const pending = job.kind === 'fix' ? pendingFixHead(task) : undefined;
      if (pending) {
        const check = this.savedFixStatus(task, pr, pending);
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
        const decisions = this.store.decisions(task.id);
        const verified = new Set(result.verifiedCommentIds ?? []);
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
    action: 'pause' | 'resume' | 'approve-plan' | 'waive-checks' | 'reopen',
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
        const pending = pendingFixHead(task);
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
              staleDraft: task.ref.provider === 'github' ? task.review : undefined,
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
        if (this.stopLegacyReview(task)) return task;
        const current = await this.provider(prRef(task)).getPR(prRef(task));
        if (!sameRevision(current, task.revision))
          throw new AppError('stale_plan', 'The plan changed after review');
        task.approvedAt = now();
        this.state(task, 'complete', 'Plan approved for implementation at this exact revision');
      } else if (action === 'waive-checks') {
        if (task.state !== 'awaiting_checks' || !reason.trim())
          throw new AppError(
            'waiver_invalid',
            'A waiver requires a reason and a task waiting for CI checks',
            400,
          );
        if (this.stopLegacyReview(task)) return task;
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
    this.state(task, 'needs_input', redact(String(error)));
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
