import type { AgentUsage, AgentUsageView, ResetPlan } from '../../../core/usage.js';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { CodexConnection } from '../../../runtime/protocol.js';
import { selectedExecutable, versionNumber, type Executable } from '../../../runtime/executable.js';
import { AppError, now } from '../../../core/types.js';
import { redact } from '../../../core/security.js';
import type { Store } from '../../../core/store.js';

const windowSchema = z.object({
  usedPercent: z.number().nonnegative(),
  windowDurationMins: z.number().nonnegative().nullable().optional(),
  resetsAt: z.number().nonnegative().nullable().optional(),
});
const bucketSchema = z.object({
  limitId: z.string().nullable().optional(),
  limitName: z.string().nullable().optional(),
  primary: windowSchema.nullable().optional(),
  secondary: windowSchema.nullable().optional(),
  planType: z.string().nullable().optional(),
  credits: z
    .object({ hasCredits: z.boolean(), unlimited: z.boolean(), balance: z.string().nullable() })
    .nullable()
    .optional(),
  rateLimitReachedType: z.string().nullable().optional(),
  spendControlReached: z.boolean().nullable().optional(),
});
const creditSchema = z.object({
  id: z.string().min(1),
  resetType: z.string(),
  status: z.string(),
  title: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  expiresAt: z.number().nullable().optional(),
});
const usageSchema = z.object({
  ordinaryUsageAllowed: z.boolean().nullable().optional(),
  accountId: z.string().nullable().optional(),
  rateLimits: bucketSchema.nullable().optional(),
  rateLimitsByLimitId: z.record(z.string(), bucketSchema).nullable().optional(),
  rateLimitResetCredits: z
    .object({
      availableCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      credits: z.array(creditSchema).nullable().optional(),
    })
    .nullable()
    .optional(),
});
type RawUsage = z.infer<typeof usageSchema>;
interface SavedPlan extends ResetPlan {
  owner: string;
  account: string;
  creditId?: string;
  executable: string;
}
type Rpc = Pick<CodexConnection, 'start' | 'request' | 'close'>;
const empty = (): AgentUsageView => ({
  engine: 'codex',
  name: 'Codex',
  source: 'codex-app-server:account/rateLimits/read',
  available: false,
  stale: true,
  buckets: [],
  resets: { availableCount: null, canUse: false, credits: [] },
});
const stamp = (seconds?: number | null) =>
  seconds == null || seconds * 1000 > 8.64e15 ? undefined : new Date(seconds * 1000).toISOString();
const accountKey = (data: RawUsage) =>
  data.accountId ? createHash('sha256').update(data.accountId).digest('hex') : undefined;

export class CodexUsage implements AgentUsage {
  readonly reset = {
    prepare: (owner: string) => this.prepare(owner),
    consume: (id: string, owner: string) => this.consume(id, owner),
  };
  private cached?: { at: number; executable: string; view: AgentUsageView };
  private pending?: { epoch: number; executable: string; result: Promise<AgentUsageView> };
  private epoch = 0;
  private resetting = false;
  constructor(
    private store: Store,
    private executable?: Executable,
    private connection: (executable: string) => Rpc = (executable) =>
      new CodexConnection(executable),
  ) {}
  private async withRpc<T>(fn: (rpc: Rpc, executable: string, cliVersion?: string) => Promise<T>) {
    const executable = selectedExecutable(this.executable),
      rpc = this.connection(executable);
    try {
      const initialized = await rpc.start(process.cwd());
      return await fn(rpc, executable, versionNumber(initialized.userAgent ?? ''));
    } finally {
      rpc.close();
    }
  }
  private async fetch(rpc: Rpc) {
    return usageSchema.parse(await rpc.request('account/rateLimits/read', {}, 20000));
  }
  private view(data: RawUsage, cliVersion?: string): AgentUsageView {
    // The named map is authoritative for matching IDs; retain a base bucket
    // when the server's map only contains model-specific quotas.
    const merged = new Map<string, z.infer<typeof bucketSchema>>();
    if (data.rateLimits) merged.set(data.rateLimits.limitId ?? 'codex', data.rateLimits);
    for (const [key, bucket] of Object.entries(data.rateLimitsByLimitId ?? {}))
      merged.set(bucket.limitId ?? key, bucket);
    if (!merged.size) throw new Error('Codex returned no recognized quota buckets');
    const buckets = [...merged.entries()];
    const credits = (data.rateLimitResetCredits?.credits ?? []).filter(
      (credit) =>
        credit.status === 'available' &&
        credit.resetType === 'codexRateLimits' &&
        (credit.expiresAt == null || credit.expiresAt * 1000 > Date.now()),
    );
    return {
      engine: 'codex',
      name: 'Codex',
      source: 'codex-app-server:account/rateLimits/read',
      available: true,
      stale: false,
      retrievedAt: now(),
      cliVersion,
      ordinaryUsageAllowed: data.ordinaryUsageAllowed,
      buckets: buckets.map(([key, bucket]) => ({
        id: bucket.limitId ?? key,
        name: bucket.limitName ?? (key === 'codex' ? 'Codex' : key),
        plan: bucket.planType,
        windows: [bucket.primary, bucket.secondary].flatMap((window) =>
          window
            ? [
                {
                  remainingPercent: Math.max(0, 100 - window.usedPercent),
                  durationMinutes: window.windowDurationMins,
                  resetsAt: stamp(window.resetsAt),
                },
              ]
            : [],
        ),
        credits: bucket.credits,
        blocked:
          bucket.rateLimitReachedType ?? (bucket.spendControlReached ? 'spend_control' : null),
      })),
      resets: {
        availableCount: data.rateLimitResetCredits?.availableCount ?? null,
        pending: !!this.store.setting('usage.pendingReset'),
        canUse:
          !!accountKey(data) &&
          ((data.rateLimitResetCredits?.availableCount ?? 0) > 0 ||
            !!this.store.setting('usage.pendingReset')),
        credits: credits.map((credit) => ({
          id: credit.id,
          title: credit.title ?? 'Rate-limit reset',
          description: credit.description,
          expiresAt: stamp(credit.expiresAt),
        })),
      },
    };
  }
  read(refresh = false): Promise<AgentUsageView> {
    const executable = selectedExecutable(this.executable),
      epoch = this.epoch;
    if (!refresh && this.cached?.executable === executable && Date.now() - this.cached.at < 60000)
      return Promise.resolve(this.cached.view);
    if (this.pending?.epoch === epoch && this.pending.executable === executable)
      return this.pending.result;
    const result = this.withRpc(async (rpc, selected, version) => {
      const data = await this.fetch(rpc);
      if (selected !== selectedExecutable(this.executable) || epoch !== this.epoch)
        return this.read(true);
      const view = this.view(data, version);
      if (epoch === this.epoch) this.cached = { at: Date.now(), executable: selected, view };
      return view;
    })
      .catch((error) => {
        if (epoch !== this.epoch || executable !== selectedExecutable(this.executable))
          return this.read(true);
        const view = {
          ...(this.cached?.executable === executable ? this.cached.view : empty()),
          stale: true,
          error: redact(String(error)).slice(0, 500),
        };
        view.resets = { ...view.resets, canUse: false };
        if (epoch === this.epoch && executable === selectedExecutable(this.executable))
          this.cached = { at: Date.now(), executable, view };
        return view;
      })
      .finally(() => {
        if (this.pending?.result === result) this.pending = undefined;
      });
    this.pending = { epoch, executable, result };
    return result;
  }
  private public(plan: SavedPlan): ResetPlan {
    const { id, availableCount, title, expiresAt, status, outcome } = plan;
    return { id, availableCount, title, expiresAt, status, outcome };
  }
  async prepare(owner: string): Promise<ResetPlan> {
    const unresolved = this.store.setting<string>('usage.pendingReset');
    if (unresolved) {
      const plan = this.store.setting<SavedPlan>(`usage.reset:${unresolved}`);
      if (plan?.status === 'pending') {
        if (plan.owner !== owner)
          throw new AppError(
            'reset_pending',
            'Resolve the pending reset from the client that started it.',
          );
        return this.public(plan);
      }
    }
    return this.withRpc(async (rpc, executable, version) => {
      const data = await this.fetch(rpc),
        account = accountKey(data),
        view = this.view(data, version);
      if (!account)
        throw new AppError(
          'reset_unsupported',
          'Codex did not provide an account identity for a safe reset.',
          422,
        );
      if (!view.resets.canUse)
        throw new AppError('reset_unavailable', 'No available rate-limit resets.', 422);
      const credit = view.resets.credits.toSorted((a, b) =>
        (a.expiresAt ?? 'z').localeCompare(b.expiresAt ?? 'z'),
      )[0];
      const plan: SavedPlan = {
        id: randomUUID(),
        owner,
        account,
        executable,
        creditId: credit?.id,
        title: credit?.title ?? 'Rate-limit reset',
        availableCount: view.resets.availableCount!,
        expiresAt: new Date(Date.now() + 5 * 60000).toISOString(),
        status: 'ready',
      };
      this.store.setSetting(`usage.reset:${plan.id}`, plan);
      return this.public(plan);
    });
  }
  async consume(id: string, owner: string) {
    if (this.resetting) throw new AppError('reset_busy', 'A rate-limit reset is already running.');
    const plan = this.store.setting<SavedPlan>(`usage.reset:${id}`);
    if (!plan || plan.owner !== owner)
      throw new AppError('reset_not_found', 'Reset request not found.', 404);
    if (plan.status === 'done') return { plan: this.public(plan), usage: await this.read(true) };
    if (plan.status === 'ready' && plan.expiresAt <= now())
      throw new AppError('reset_expired', 'This reset request expired. Open limits again.');
    const unresolved = this.store.setting<string>('usage.pendingReset');
    if (unresolved && unresolved !== id)
      throw new AppError('reset_pending', 'Resolve the pending reset before starting another.');
    this.resetting = true;
    try {
      await this.withRpc(async (rpc, executable) => {
        const data = await this.fetch(rpc);
        if (accountKey(data) !== plan.account)
          throw new AppError(
            'reset_account_changed',
            'The Codex account changed. This reset was not sent.',
          );
        if (executable !== selectedExecutable(this.executable))
          throw new AppError('usage_runtime_changed', 'Codex changed. Refresh the limits again.');
        if (plan.status === 'ready' && executable !== plan.executable)
          throw new AppError('usage_runtime_changed', 'Codex changed. Refresh the limits again.');
        if (
          plan.status === 'ready' &&
          plan.creditId &&
          data.rateLimitResetCredits?.credits &&
          !data.rateLimitResetCredits.credits.some(
            (credit) => credit.id === plan.creditId && credit.status === 'available',
          )
        )
          throw new AppError(
            'reset_unavailable',
            'The selected reset is no longer available. Open limits again.',
          );
        this.store.transaction(() => {
          plan.status = 'pending';
          this.store.setSetting(`usage.reset:${id}`, plan);
          this.store.setSetting('usage.pendingReset', id);
        });
        this.epoch++;
        this.cached = undefined;
        const response = z
          .object({ outcome: z.enum(['reset', 'alreadyRedeemed', 'nothingToReset', 'noCredit']) })
          .parse(
            await rpc.request(
              'account/rateLimitResetCredit/consume',
              { idempotencyKey: id, ...(plan.creditId ? { creditId: plan.creditId } : {}) },
              30000,
            ),
          );
        this.store.transaction(() => {
          plan.status = 'done';
          plan.outcome = response.outcome;
          this.store.setSetting(`usage.reset:${id}`, plan);
          this.store.setSetting('usage.pendingReset', null);
          this.store.event('_system', 'usage.reset_finished', { id, outcome: response.outcome });
        });
      });
      this.epoch++;
      this.cached = undefined;
      return { plan: this.public(plan), usage: await this.read(true) };
    } finally {
      this.resetting = false;
    }
  }
}
