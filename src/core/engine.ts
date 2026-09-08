import { randomUUID, createHash } from 'node:crypto';
import { Store } from './store.js';
import { Broker } from './broker.js';
import {
  AppError,
  defaultPolicy,
  now,
  sameRevision,
  type Task,
  type PRRef,
  type State,
  type Policy,
  type Job,
  type AgentResult,
} from './types.js';
import type { ReviewProvider } from '../providers/provider.js';
import { redact } from './security.js';

export class Engine {
  readonly broker: Broker;
  private locks = new Map<string, Promise<unknown>>();
  onCancel: (id: string) => void = () => {};
  constructor(
    readonly store: Store,
    readonly provider: (ref: PRRef) => ReviewProvider,
  ) {
    this.broker = new Broker(store, provider);
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
    const task: Task = {
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
      revision: { head: pr.head, base: pr.base, start: pr.start },
      authorThreadId: input.authorThreadId,
      planTaskId: input.planTaskId,
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
      this.store.saveTask(task);
      this.store.event(task.id, 'task.created', {
        kind: task.kind,
        ref: task.ref,
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
      const pr = await this.provider(task.ref).getPR(task.ref);
      if (pr.state !== 'open') throw new AppError('pr_closed', 'The PR is closed');
      const changed = !sameRevision(task.revision, pr);
      if (changed) this.invalidate(task, pr);
      if (retry && task.review) {
        const snapshot = await this.provider(task.ref).getReview(task.ref, task.review);
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
      task.revision = { head: pr.head, base: pr.base, start: pr.start };
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
    task.revision = pr ? { head: pr.head, base: pr.base, start: pr.start } : undefined;
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
    if (task.state === 'paused') return task;
    const provider = this.provider(task.ref),
      pr = await provider.getPR(task.ref);
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
    const snapshot = await provider.getReview(task.ref, task.review);
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
                body: c.body.replace(/<!-- reviewloop:[^>]+ -->/g, ''),
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
  async publish(id: string) {
    return this.lock(id, async () => {
      const task = this.store.getTask(id);
      if (task.state !== 'awaiting_publication' || !task.reviewFinished || this.store.busy(id))
        throw new AppError(
          'publication_unavailable',
          'Wait until the reviewer has finished and discussion is idle',
        );
      await this.broker.publish(task);
      return this.reconcileLocked(id);
    });
  }
  async chat(id: string, role: 'author' | 'reviewer', text: string) {
    return this.lock(id, async () => {
      const task = this.store.getTask(id);
      if (task.state === 'paused' || task.state === 'complete')
        throw new AppError(
          'chat_unavailable',
          'Resume or reopen the task before starting another session',
        );
      this.store.transaction(() => {
        this.store.message(id, role, 'user', text);
        this.store.enqueue(task, role, 'chat', text);
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
      const pr = await this.provider(task.ref).getPR(task.ref);
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
        const snapshot = await this.provider(task.ref).getReview(task.ref, task.review!);
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
          task.snapshot = await this.provider(task.ref).getReview(task.ref, task.review);
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
  ) {
    return this.lock(id, async () => {
      const task = this.store.getTask(id);
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
        const current = await this.provider(task.ref).getPR(task.ref);
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
        const current = await this.provider(task.ref).getPR(task.ref);
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
    for (const job of this.store.jobs())
      if (job.status === 'running') {
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
  failJob(job: Job, error: unknown) {
    const task = this.store.getTask(job.taskId);
    if (task.generation !== job.generation || task.state === 'paused') return;
    task.resumeState = task.state;
    if (job.role === 'reviewer') task.reviewFinished = false;
    this.state(task, 'needs_input', redact(String(error)));
    this.store.event(task.id, 'job.failed', { error: redact(String(error)) }, job.id);
  }
}
