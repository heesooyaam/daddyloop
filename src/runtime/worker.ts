import type { Engine } from '../core/engine.js';
import type { Job, ResourceStatus } from '../core/types.js';
import { AppError, now, sameRevision, prRef, isTicket } from '../core/types.js';
import { redact } from '../core/security.js';
import type { AgentRuntime } from './agent.js';
import { Workspaces, git } from './workspaces.js';
import { DemoProvider } from '../providers/demo.js';
import { buildContext } from './context.js';
import { workspaceScope } from '../core/workspace-registry.js';
import { realpathSync } from 'node:fs';
import { join, sep } from 'node:path';
import { assignWorker, canAssignWorker, reconcileWorkerPools } from '../core/worker-pool.js';

export class Worker {
  private active = new Map<string, AbortController>();
  private runningJobs = new Map<string, Job>();
  private pendingRuns = new Set<Promise<void>>();
  private timer?: NodeJS.Timeout;
  private ticking = false;
  private stopped = false;
  private lastPoll = 0;
  private tickDone: Promise<void> = Promise.resolve();
  private lastCleanup = 0;
  private lastArcRelease = 0;
  private reservedGroups = new Set<string>();
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
  autoCleanup?: () => Promise<unknown>;
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
        for (const task of store.tasks())
          if (
            task.ref.provider === 'arcadia' &&
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
      if (this.autoSubmit && resources.ok)
        for (const task of store.tasks()) {
          if (
            isTicket(task) &&
            task.state === 'ready_for_review' &&
            task.policy.autoPush &&
            !store.busy(task.id)
          ) {
            const submission = this.autoSubmit(task.id).then(
              () => {},
              (error) => {
                store.event(task.id, 'ticket.submission_failed', { error: redact(String(error)) });
              },
            );
            this.pendingRuns.add(submission);
            void submission.finally(() => this.pendingRuns.delete(submission));
          }
        }
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
              store.event(task.id, 'task.state', { state: current.state, reason: current.reason });
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
              store.event(task.id, 'task.state', { state: current.state, reason: current.reason });
            }
          }
        }
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
            (!candidate.groupId ||
              (() => {
                const group = store.getGroup(candidate.groupId!);
                if (group.daddyState === 'paused' || group.daddyState === 'archived') return false;
                if (candidate.role === 'reviewer') return !this.reservedGroups.has(group.id);
                if (group.orchestrated && !canAssignWorker(store, group, candidate.taskId))
                  return false;
                const task = store.getTask(candidate.taskId);
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
              if (group.orchestrated) assignWorker(store, group, claimed.taskId);
            }
          },
        );
        if (job) {
          const running = this.run(job);
          this.pendingRuns.add(running);
          void running.finally(() => this.pendingRuns.delete(running));
        } else break;
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
      const group = task.groupId ? store.getGroup(task.groupId) : undefined;
      if (job.role === 'reviewer' && group) {
        if (job.groupGeneration !== group.generation)
          throw new Error('The shared reviewer configuration changed before this job started');
        task.reviewerThreadId = group.reviewerThreadId;
      }
      job.profile ??= this.engine.effectiveAgents(task)[job.role === 'author' ? 'worker' : 'daddy'];
      store.saveJob(job);
      const startingPR = isTicket(task)
        ? undefined
        : await this.engine.provider(prRef(task)).getPR(prRef(task));
      if (startingPR && !sameRevision(startingPR, task.revision))
        throw new AppError(
          'stale_revision',
          'The PR changed before the queued job started. Reconcile and review the new revision.',
        );
      const demo = task.ref.provider === 'demo';
      const cwd = demo
        ? this.workspaces.dataDir
        : isTicket(task)
          ? await this.workspaces.prepareTicket(task, job.role, abort.signal)
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
      if (isTicket(task)) task.revision = prepared.revision;
      if (job.role === 'reviewer' && group) task.reviewerThreadId = prepared.reviewerThreadId;
      store.saveTask(task);
      if (job.kind === 'fix') {
        const actual = await this.engine.provider(prRef(task)).getReview(prRef(task), task.review!);
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
      let agentCwd = cwd;
      if (task.scope && !demo) {
        agentCwd = realpathSync(join(cwd, workspaceScope(task.scope)));
        if (!agentCwd.startsWith(realpathSync(cwd) + sep))
          throw new Error('The starting directory escaped its managed workspace');
      }
      const result = await (demo ? this.demoRuntime : this.liveRuntime).run({
        task,
        job,
        cwd: agentCwd,
        readPaths: demo ? [] : this.workspaces.readPaths?.(task),
        prompt: buildContext(store, task, job),
        signal: abort.signal,
        onSession: (threadId, turnId) => {
          const current = store.getTask(job.taskId);
          if (current.generation !== job.generation || abort.signal.aborted) return;
          if (job.role === 'reviewer' && current.groupId) {
            const shared = store.getGroup(current.groupId);
            if (shared.generation !== job.groupGeneration) return;
            if (shared.reviewerThreadId && shared.reviewerThreadId !== threadId)
              throw new Error('The shared reviewer returned a different thread identity');
            shared.reviewerThreadId = threadId;
            store.saveGroup(shared);
          }
          if (job.role === 'author') current.authorThreadId = threadId;
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
        isTicket(task) &&
        job.kind === 'implement' &&
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
        store.event(task.id, 'author.implementation_saved', { head }, job.id);
      }
      if (
        !abort.signal.aborted &&
        task.generation === job.generation &&
        job.kind === 'fix' &&
        result.status === 'completed' &&
        !result.disputedCommentIds?.length &&
        result.checkedHead === task.revision?.head
      ) {
        if (demo) await new DemoProvider(store).advance(prRef(task));
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
      const capacity =
        error instanceof AppError && error.code === 'workspace_capacity' && !abort.signal.aborted;
      job.status = capacity ? 'queued' : abort.signal.aborted ? 'cancelled' : 'failed';
      job.error = redact(String(error));
      if (capacity) job.notBefore = new Date(Date.now() + 30000).toISOString();
      else if (!abort.signal.aborted) this.engine.failJob(job, error);
    } finally {
      if (job.role === 'reviewer') {
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
      store.event(job.taskId, `job.${job.status}`, { error: job.error }, job.id);
      this.active.delete(job.taskId);
      this.runningJobs.delete(job.taskId);
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
