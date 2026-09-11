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
  revisionOf,
  type Task,
  type PRRef,
  type State,
  type Policy,
  type Job,
  type AgentResult,
} from './types.js';
import type { ReviewProvider } from '../providers/provider.js';
import { redact } from './security.js';
import { inheritedProfiles } from './agents.js';

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
      throw new AppError('thread_in_use', 'This Codex thread is already assigned to another task');
    const group = input.groupId ? this.store.getGroup(input.groupId) : undefined;
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
      policy: { ...defaultPolicy, ...group?.defaultPolicy, ...input.policy },
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
      createdByAction: input.createdByAction,
      agents: {
        ...this.defaultAgents(),
        ...(group?.worker ? { worker: group.worker } : {}),
        ...input.agents,
        ...(group ? { daddy: group.daddy } : {}),
      },
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
      const pr = await this.provider(prRef(task)).getPR(prRef(task));
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
      if (!task.review) {
        if (task.round >= task.policy.maxRounds) {
          this.state(task, 'needs_input', 'Review round limit reached');
          return task;
        }
        task.round++;
      }
      task.pr = pr;
      task.revision = revisionOf(pr);
      await this.broker.ensureReview(task);
      task.reviewFinished = false;
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
  async reconcile(id: string) {
    return this.lock(id, () => this.reconcileLocked(id));
  }
  private async reconcileLocked(id: string): Promise<Task> {
    const task = this.store.getTask(id);
    if (task.state === 'paused' || isTicket(task)) return task;
    const provider = this.provider(prRef(task)),
      pr = await provider.getPR(prRef(task));
    if (pr.state !== 'open') {
      this.onCancel(id);
      this.store.cancelJobs(id);
      task.generation++;
      this.state(task, 'needs_input', `PR is ${pr.state}; automatic work stopped`);
      return task;
    }
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
        else if (task.round >= task.policy.maxRounds)
          this.state(
            task,
            'needs_input',
            'Review round limit reached; inspect the remaining published findings',
          );
        else
          this.store.transaction(() => {
            this.state(task, 'fixing', 'Author is addressing the published review');
            this.store.enqueue(
              task,
              'author',
              'fix',
              'Address exactly the published feedback snapshot. Explain disputes. Do not treat the reviewer’s private draft or old summary as additional requirements.',
            );
          });
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
  async completeJob(job: Job, result: AgentResult) {
    return this.lock(job.taskId, async () => {
      const task = this.store.getTask(job.taskId);
      if (task.generation !== job.generation || task.state === 'paused') {
        this.store.event(task.id, 'job.stale_result', { generation: job.generation }, job.id);
        return;
      }
      if (isTicket(task)) {
        this.store.message(task.id, job.role, 'agent', result.summary, job.id);
        if (result.status !== 'completed' || result.checkedHead !== task.revision?.head) {
          task.resumeState = task.state;
          this.state(
            task,
            'needs_input',
            result.question || result.summary || 'The ticket turn was incomplete',
          );
        } else if (job.kind === 'implement') {
          if (!task.pendingAuthorHead || task.pendingAuthorHead === task.revision?.head)
            this.state(
              task,
              'needs_input',
              'The author produced no new committed changes. Discuss the result before implementing again.',
            );
          else {
            task.revision = { ...task.revision!, head: task.pendingAuthorHead };
            task.resumeState = 'ready_for_review';
            this.state(
              task,
              'ready_for_review',
              'Implementation saved locally. Submit it to a native PR for the shared reviewer.',
            );
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
        return;
      }
      const pr = await this.provider(prRef(task)).getPR(prRef(task));
      if (job.kind !== 'fix' && !sameRevision(task.revision, pr)) {
        this.invalidate(task, pr);
        this.state(
          task,
          'needs_input',
          'PR changed while the agent was working; its result did not advance the workflow',
        );
        return;
      }
      this.store.message(task.id, job.role, 'agent', result.summary, job.id);
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
        if (
          sameRevision(pr, task.revision) &&
          task.pendingAuthorHead &&
          task.pendingAuthorHead !== task.revision?.head
        )
          this.state(task, 'awaiting_push', 'Author finished; waiting for a new PR revision');
        else {
          const changed = !sameRevision(pr, task.revision);
          task.pendingAuthorHead = undefined;
          this.invalidate(task, pr, false);
          this.state(
            task,
            'queued',
            changed
              ? 'Author pushed changes; independent verification is next'
              : 'Author made no code changes; independent verification of the decisions is next',
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
    action: 'pause' | 'resume' | 'approve-plan' | 'waive-checks' | 'reopen',
    reason = '',
    expected?: ExpectedTask,
  ) {
    return this.lock(id, async () => {
      const task = this.store.getTask(id);
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
              'Continue the interrupted implementation. Preserve the existing working copy and test the result.',
            );
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
        this.invalidate(task, task.pr);
        task.round = 0;
        this.state(task, 'queued', reason || 'Reopened by the user');
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
          const old = this.effectiveAgents(task)[role === 'author' ? 'worker' : 'daddy'];
          if (old.engine !== profile.engine) {
            const field = role === 'author' ? 'authorThreadId' : 'reviewerThreadId';
            this.store.event(id, 'agent.engine_changed', {
              previous: old.engine,
              current: profile.engine,
              thread: task[field],
            });
            task[field] = undefined;
          }
          task.agents = {
            ...this.effectiveAgents(task),
            [role === 'author' ? 'worker' : 'daddy']: profile,
          };
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
    publication?: 'auto' | 'human';
    autoPush?: boolean;
    groupId?: string;
    groupGeneration?: number;
    workspaceId?: string;
    scope?: string;
    createdByAction?: string;
    dependsOn?: string[];
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
        createdByAction: input.createdByAction,
        dependsOn: input.dependsOn,
        agents: {
          worker: input.agents?.worker ?? group.worker ?? this.defaultAgents().worker,
          daddy: group.daddy,
        },
        policy: {
          ...defaultPolicy,
          publication:
            input.publication ?? group.defaultPolicy?.publication ?? defaultPolicy.publication,
          autoPush: input.autoPush ?? group.defaultPolicy?.autoPush ?? defaultPolicy.autoPush,
        },
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
        });
        if (!group.orchestrated)
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
      task.resumeState = 'implementing';
      this.state(
        task,
        'implementing',
        'The author is implementing this ticket in its managed workspace',
      );
      this.store.enqueue(
        task,
        'author',
        'implement',
        instruction ??
          'Implement the ticket according to the original requirements and our discussion. Test the changes. Do not commit, push or create a PR yourself; the service will save the local result.',
        actionId,
      );
      return task;
    });
  }
  async retryTicket(id: string) {
    const task = this.store.getTask(id);
    if (!isTicket(task)) return this.review(id, true);
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
