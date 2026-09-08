import type { Engine } from '../core/engine.js';
import type { Job, ResourceStatus } from '../core/types.js';
import { AppError, now, sameRevision } from '../core/types.js';
import { redact } from '../core/security.js';
import type { AgentRuntime } from './agent.js';
import { Workspaces, git } from './workspaces.js';
import { DemoProvider } from '../providers/demo.js';
import { buildContext } from './context.js';

export class Worker {
  private active = new Map<string, AbortController>();
  private pendingRuns = new Set<Promise<void>>();
  private timer?: NodeJS.Timeout;
  private ticking = false;
  private stopped = false;
  private lastPoll = 0;
  private tickDone: Promise<void> = Promise.resolve();
  private lastCleanup = 0;
  autoCleanup?: () => Promise<unknown>;
  constructor(
    readonly engine: Engine,
    private workspaces: Workspaces,
    private liveRuntime: AgentRuntime,
    private demoRuntime: AgentRuntime,
    private resourceCheck: () => ResourceStatus,
    private pollMs = 15000,
  ) {
    engine.onCancel = (id) => this.active.get(id)?.abort();
  }
  start() {
    this.engine.recoverInterruptedJobs();
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
      if (Date.now() - this.lastPoll > this.pollMs) {
        this.lastPoll = Date.now();
        for (const task of store.tasks())
          if (
            [
              'awaiting_publication',
              'awaiting_push',
              'awaiting_checks',
              'awaiting_plan_approval',
              'reviewing',
              'fixing',
            ].includes(task.state)
          ) {
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
      if (this.stopped) return;
      for (const task of store.tasks())
        if (task.state === 'queued' && !store.busy(task.id)) {
          try {
            await this.engine.review(task.id);
            if (this.stopped) return;
          } catch (error) {
            const current = store.getTask(task.id);
            if (current.generation === task.generation && current.state !== 'paused') {
              current.state = 'needs_input';
              current.reason = redact(String(error));
              store.saveTask(current);
              store.event(task.id, 'review.start_failed', { error: current.reason });
            }
          }
        }
      if (this.stopped) return;
      for (const task of store.tasks())
        if (
          task.state === 'awaiting_publication' &&
          task.policy.publication === 'auto' &&
          !store.busy(task.id)
        ) {
          try {
            await this.engine.publish(task.id);
            if (this.stopped) return;
          } catch (error) {
            const current = store.getTask(task.id);
            if (current.generation === task.generation && current.state !== 'paused') {
              current.state = 'needs_input';
              current.reason = redact(String(error));
              store.saveTask(current);
              store.event(task.id, 'publication.failed', { error: current.reason });
            }
          }
        }
      // One agent at a time by default bounds memory consumption and workspace writers.
      if (!this.stopped && !this.active.size && this.resourceCheck().ok) {
        const job = store.claim();
        if (job) {
          const running = this.run(job);
          this.pendingRuns.add(running);
          void running.finally(() => this.pendingRuns.delete(running));
        }
      }
    } finally {
      this.ticking = false;
      finishTick();
    }
  }
  private async run(job: Job) {
    const abort = new AbortController();
    this.active.set(job.taskId, abort);
    const store = this.engine.store;
    try {
      let task = store.getTask(job.taskId);
      const startingPR = await this.engine.provider(task.ref).getPR(task.ref);
      if (!sameRevision(startingPR, task.revision))
        throw new AppError(
          'stale_revision',
          'The PR changed before the queued job started. Reconcile and review the new revision.',
        );
      const demo = task.ref.provider === 'demo';
      const cwd = demo
        ? this.workspaces.dataDir
        : await this.workspaces.prepare(task, job.role, abort.signal);
      if (task.kind === 'plan' && job.kind === 'review') {
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
      store.saveTask(task);
      if (job.kind === 'fix') {
        const actual = await this.engine.provider(task.ref).getReview(task.ref, task.review!);
        if (actual.status !== 'published')
          throw new Error(
            'The published review changed before the author started; feedback was not released.',
          );
        task = store.getTask(job.taskId);
        if (task.generation !== job.generation || abort.signal.aborted)
          throw new AppError('run_cancelled', 'Task changed while feedback was being read');
        task.feedback = actual;
        store.saveTask(task);
        store.event(task.id, 'author.feedback_snapshot', actual, job.id);
      }
      const result = await (demo ? this.demoRuntime : this.liveRuntime).run({
        task,
        job,
        cwd,
        prompt: buildContext(store, task, job),
        signal: abort.signal,
        onSession: (threadId, turnId) => {
          const current = store.getTask(job.taskId);
          if (current.generation !== job.generation || abort.signal.aborted) return;
          if (job.role === 'author') current.authorThreadId = threadId;
          else current.reviewerThreadId = threadId;
          store.saveTask(current);
          job.threadId = threadId;
          job.turnId = turnId;
          store.saveJob(job);
          store.event(job.taskId, 'session.attached', { role: job.role, threadId, turnId }, job.id);
        },
        onEvent: (type, data) =>
          store.event(
            job.taskId,
            type,
            typeof data === 'string' ? redact(data) : JSON.parse(redact(JSON.stringify(data))),
            job.id,
          ),
        onTool: (name, args, callId) => this.engine.broker.call(job, name, args, callId),
      });
      task = store.getTask(job.taskId);
      if (
        !abort.signal.aborted &&
        task.generation === job.generation &&
        job.kind === 'fix' &&
        result.status === 'completed' &&
        !result.disputedCommentIds?.length &&
        result.checkedHead === task.revision?.head
      ) {
        if (demo) await new DemoProvider(store).advance(task.ref);
        else {
          const submission = await this.workspaces.submit(
            task,
            `Address review feedback (round ${task.round})`,
            abort.signal,
          );
          const latest = store.getTask(task.id);
          if (latest.generation === job.generation && !abort.signal.aborted) {
            latest.pendingAuthorHead = submission.head;
            store.saveTask(latest);
          }
          store.event(task.id, 'author.submitted', submission, job.id);
        }
      }
      if (!abort.signal.aborted) await this.engine.completeJob(job, result);
      job.status = abort.signal.aborted ? 'cancelled' : 'completed';
    } catch (error) {
      job.status = abort.signal.aborted ? 'cancelled' : 'failed';
      job.error = redact(String(error));
      if (!abort.signal.aborted) this.engine.failJob(job, error);
    } finally {
      job.finishedAt = now();
      store.saveJob(job);
      store.event(job.taskId, `job.${job.status}`, { error: job.error }, job.id);
      this.active.delete(job.taskId);
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
