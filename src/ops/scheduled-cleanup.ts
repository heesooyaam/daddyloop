import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { z } from 'zod';
import type { Store } from '../core/store.js';
import type { AgentProfile, ResourceStatus } from '../core/types.js';
import type { SessionRuntime } from '../runtime/agent.js';
import { withInstructions } from '../core/instructions.js';
import { redact } from '../core/security.js';
import type { CacheSchedule } from './config.js';

const minute = 60000;
const stateKey = 'cache.schedule.state';
type Disk = Pick<ResourceStatus, 'diskUsedPercent' | 'diskAvailableGiB'>;

export interface CleanupCounts {
  checked: number;
  eligible: number;
  removed: number;
  tooRecent?: number;
}
export interface CleanupAction {
  id: string;
  description: string;
  run(
    signal: AbortSignal,
    shouldContinue: () => boolean,
  ): Promise<void | { counts?: CleanupCounts; removedBytes?: number; skipped?: boolean }>;
}
type CleanupRun = { id: string; startedAt: number; before: Disk };
export interface CleanupReport extends CleanupRun {
  finishedAt: number;
  after: Disk;
  status: 'cleared' | 'still_high' | 'failed' | 'interrupted';
  actions: {
    id: string;
    error?: string;
    counts?: CleanupCounts;
    removedBytes?: number;
    skipped?: boolean;
  }[];
  error?: string;
}
type ScheduleState = { lastCheckedAt?: number; run?: CleanupRun; report?: CleanupReport };
export function lastScheduledCleanup(store: Store) {
  return store.setting<ScheduleState>(stateKey)?.report;
}
type Options = {
  allowed: boolean;
  pausePercent?: number;
  measure(): Disk;
  canPlan(): boolean;
  directory: string;
  runtime: SessionRuntime;
  profile(): AgentProfile;
  actions: CleanupAction[];
  clock?: () => number;
};

export class ScheduledCleanup {
  private timer?: NodeJS.Timeout;
  private running?: { controller: AbortController; done: Promise<void> };
  private clock: () => number;

  constructor(
    private store: Store,
    private policy: CacheSchedule,
    private options: Options,
  ) {
    this.clock = options.clock ?? Date.now;
  }

  private enabled() {
    return (
      this.policy.enabled &&
      this.options.allowed &&
      this.policy.diskPercent < (this.options.pausePercent ?? 100)
    );
  }

  private state() {
    return this.store.setting<ScheduleState>(stateKey) ?? {};
  }

  private nextCheck(lastCheckedAt: number) {
    const now = this.clock();
    return Math.min(lastCheckedAt, now) + this.policy.intervalMinutes * minute;
  }

  status() {
    const state = this.state();
    return {
      configured: this.policy.enabled,
      automaticCleanup: this.options.allowed,
      enabled: this.enabled(),
      intervalMinutes: this.policy.intervalMinutes,
      diskPercent: this.policy.diskPercent,
      skill: this.policy.skill?.name,
      targets: this.policy.targets,
      hostUnits: this.options.actions
        .filter((a) => a.id.startsWith('daddyloop-cleanup-'))
        .map((a) => a.id + '.service'),
      lastCheckedAt:
        state.lastCheckedAt === undefined ? undefined : new Date(state.lastCheckedAt).toISOString(),
      nextCheckAt:
        this.enabled() && state.lastCheckedAt !== undefined
          ? (new Date(this.nextCheck(state.lastCheckedAt)).toJSON() ?? undefined)
          : undefined,
      running: !!this.running,
      lastReport: state.report,
    };
  }

  configure(patch: Pick<CacheSchedule, 'enabled' | 'diskPercent' | 'intervalMinutes' | 'skill'>) {
    const changedSkill = this.policy.skill?.checksum !== patch.skill?.checksum;
    this.policy = { ...this.policy, ...patch };
    if (!this.enabled() || changedSkill) this.running?.controller.abort();
    if (this.timer && this.enabled()) this.checkInBackground();
  }

  private checkInBackground = () => {
    void this.tick().catch((error) => {
      try {
        this.store.event('_system', 'cache.schedule_failed', { error: redact(String(error)) });
      } catch {
        // A failed SQLite write leaves the attempt due for the next tick.
      }
    });
  };

  start() {
    if (this.timer) return;
    this.timer = setInterval(this.checkInBackground, minute);
    this.timer.unref();
    this.checkInBackground();
  }

  async stop() {
    clearInterval(this.timer);
    this.timer = undefined;
    this.running?.controller.abort();
    await this.running?.done.catch(() => {});
  }

  tick() {
    if (this.running) return this.running.done;
    const controller = new AbortController();
    const done = this.check(controller.signal).finally(() => {
      this.running = undefined;
    });
    this.running = { controller, done };
    return done;
  }

  private async check(signal: AbortSignal) {
    let state = this.state();
    if (state.run) {
      state = this.finish(state, state.run, 'interrupted', [], this.options.measure());
    }
    const now = this.clock();
    if (!this.enabled()) return;
    if (
      state.lastCheckedAt !== undefined &&
      state.lastCheckedAt <= now &&
      now < this.nextCheck(state.lastCheckedAt)
    )
      return;

    const before = this.options.measure();
    state.lastCheckedAt = now;
    if (before.diskUsedPercent <= this.policy.diskPercent) {
      this.store.setSetting(stateKey, state);
      return;
    }
    const run = { id: randomUUID(), startedAt: now, before };
    this.store.setSetting(stateKey, { ...state, run });
    const actions: CleanupReport['actions'] = [];
    const shouldContinue = () => this.options.measure().diskUsedPercent > this.policy.diskPercent;
    let error: string | undefined;
    try {
      const plan = shouldContinue() ? await this.plan(run, signal) : [];
      for (const action of plan) {
        signal.throwIfAborted();
        if (!shouldContinue()) break;
        try {
          const result = await action.run(signal, shouldContinue);
          actions.push({ id: action.id, ...result });
        } catch (failure) {
          signal.throwIfAborted();
          actions.push({ id: action.id, error: redact(String(failure)).slice(0, 500) });
        }
      }
    } catch (failure) {
      if (!signal.aborted) error = redact(String(failure)).slice(0, 500);
    }
    const after = this.options.measure();
    const status = signal.aborted
      ? 'interrupted'
      : after.diskUsedPercent <= this.policy.diskPercent
        ? 'cleared'
        : error || actions.some((action) => action.error)
          ? 'failed'
          : 'still_high';
    this.finish(state, run, status, actions, after, error);
  }

  private finish(
    state: ScheduleState,
    run: CleanupRun,
    status: CleanupReport['status'],
    actions: CleanupReport['actions'],
    after: Disk,
    error?: string,
  ) {
    const report = { ...run, finishedAt: this.clock(), after, status, actions, error };
    const next = { lastCheckedAt: state.lastCheckedAt, report };
    this.store.transaction(() => {
      this.store.setSetting(stateKey, next);
      this.store.event('_system', 'cache.scheduled_finished', report);
    });
    return next;
  }

  private async plan(run: CleanupRun, signal: AbortSignal) {
    if (!this.policy.skill) return this.options.actions;
    if (!this.options.canPlan())
      throw new Error(
        'The cleanup agent needs at least 1 GiB of disk and 0.5 GiB of available RAM',
      );
    const actions = new Map(this.options.actions.map((action) => [action.id, action]));
    const input = z.object({ ids: z.array(z.string()).max(actions.size) }).strict();
    const tools = [
      {
        name: 'choose_cleanup_order',
        description:
          'Select and order the allowed cleanup operations by ID. Omit operations to skip them.',
        inputSchema: z.toJSONSchema(input),
      },
    ];
    await mkdir(this.options.directory, { recursive: true, mode: 0o700 });
    const runSignal = AbortSignal.any([signal, AbortSignal.timeout(120000)]);
    let selected: CleanupAction[] | undefined;
    const result = await this.options.runtime.runSession({
      owner: { runId: run.id, groupId: '_scheduled_cleanup', kind: 'maintenance' },
      cwd: this.options.directory,
      execution: 'sandbox',
      readOnly: true,
      profile: this.options.profile(),
      signal: runSignal,
      tools,
      instructions: withInstructions(
        'Choose an order for the listed cleanup operations using choose_cleanup_order exactly once. The service performs verified operations after the turn. Your skill may select, reorder or skip operations only. Do not use shell commands or read files for this task. Do not report that files were deleted. Return a completed result with an empty checkedHead once the order is chosen.',
        { skills: [this.policy.skill] },
      ),
      prompt: JSON.stringify({
        disk: run.before,
        thresholdPercent: this.policy.diskPercent,
        operations: this.options.actions.map(({ id, description }) => ({ id, description })),
      }),
      onSession: () => {},
      onEvent: () => {},
      onTool: async (name, args) => {
        runSignal.throwIfAborted();
        if (name !== 'choose_cleanup_order' || selected)
          throw new Error('Choose the cleanup order once through the supplied tool');
        const { ids } = input.parse(args);
        if (new Set(ids).size !== ids.length || ids.some((id) => !actions.has(id)))
          throw new Error('Use each allowed cleanup ID at most once');
        selected = ids.map((id) => actions.get(id)!);
        return { selected: ids };
      },
    });
    runSignal.throwIfAborted();
    if (result.status !== 'completed' || !selected)
      throw new Error('The cleanup agent did not finish selecting operations');
    return selected;
  }
}
