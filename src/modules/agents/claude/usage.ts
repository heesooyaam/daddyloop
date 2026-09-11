import { createHash } from 'node:crypto';
import { claudeEnvironment, claudeExecutable } from './connection.js';
import { executablePath, type Executable } from '../../../runtime/executable.js';
import type { Store } from '../../../core/store.js';
import type { AgentUsage, AgentUsageView } from '../../../core/usage.js';
import type { SDKRateLimitInfo } from '@anthropic-ai/claude-agent-sdk';
import { unavailableUsage } from '../usage.js';
import { z } from 'zod';
const eventSchema = z.object({
  status: z.string(),
  rateLimitType: z.string().optional(),
  resetsAt: z.number().nonnegative().optional(),
  utilization: z.number().nonnegative().optional(),
});
/** CLI events are observations, not a polling API or inferred subscription table. */
export class ClaudeUsage implements AgentUsage {
  constructor(
    private store: Store,
    private executable?: Executable,
  ) {}
  identity() {
    const key = claudeEnvironment().ANTHROPIC_API_KEY;
    const path = claudeExecutable(this.executable);
    return key
      ? createHash('sha256')
          .update(key + '\0' + (executablePath(path) ?? path))
          .digest('hex')
      : undefined;
  }
  observe(value: SDKRateLimitInfo, identity = this.identity()) {
    if (!identity || identity !== this.identity()) return;
    const parsed = eventSchema.safeParse(value);
    if (!parsed.success) return;
    const event = parsed.data;
    const snapshot =
      this.store.setting<Record<string, { at: string; event: z.infer<typeof eventSchema> }>>(
        `usage.claude.windows:${identity}`,
      ) ?? {};
    snapshot[event.rateLimitType ?? 'quota'] = { at: new Date().toISOString(), event };
    this.store.setSetting(`usage.claude.windows:${identity}`, snapshot);
  }
  observeActivity(
    models: Record<string, { inputTokens: number; outputTokens: number; costUSD: number }>,
    identity = this.identity(),
  ) {
    if (!identity || identity !== this.identity()) return;
    const parsed = z
      .record(
        z.string(),
        z.object({
          inputTokens: z.number().nonnegative(),
          outputTokens: z.number().nonnegative(),
          costUSD: z.number().nonnegative(),
        }),
      )
      .safeParse(models);
    if (!parsed.success || !Object.keys(parsed.data).length) return;
    const activity = Object.values(parsed.data).reduce<NonNullable<AgentUsageView['activity']>>(
      (sum, model) => ({
        at: sum.at,
        inputTokens: sum.inputTokens + model.inputTokens,
        outputTokens: sum.outputTokens + model.outputTokens,
        costUSD: sum.costUSD + model.costUSD,
      }),
      { at: new Date().toISOString(), inputTokens: 0, outputTokens: 0, costUSD: 0 },
    );
    this.store.setSetting(`usage.claude.activity:${identity}`, activity);
  }
  async read(): Promise<AgentUsageView> {
    const identity = this.identity();
    const activity = this.store.setting<AgentUsageView['activity']>(
      `usage.claude.activity:${identity}`,
    );
    const rows = Object.entries(
      this.store.setting<Record<string, { at: string; event: z.infer<typeof eventSchema> }>>(
        `usage.claude.windows:${identity}`,
      ) ?? {},
    );
    if (!rows.length)
      return {
        ...unavailableUsage('claude', 'Claude'),
        activity,
        source: 'claude-agent-sdk:rate_limit_event',
        error:
          'Claude has not reported quota data. API billing is separate; no percentage is estimated.',
      };
    return {
      engine: 'claude',
      name: 'Claude',
      activity,
      source: 'claude-agent-sdk:rate_limit_event',
      available: true,
      stale: rows.some(([, row]) => Date.now() - Date.parse(row.at) > 120000),
      retrievedAt: rows.map(([, row]) => row.at).sort()[0],
      buckets: rows.map(([id, { event }]) => ({
        id,
        name: id,
        blocked: event.status === 'rejected' ? event.status : null,
        windows: [
          {
            label: id,
            remainingPercent:
              event.utilization == null ? null : Math.max(0, 100 - event.utilization * 100),
            resetsAt:
              event.resetsAt != null && event.resetsAt * 1000 <= 8.64e15
                ? new Date(event.resetsAt * 1000).toISOString()
                : undefined,
          },
        ],
      })),
      resets: { availableCount: null, canUse: false, credits: [] },
    };
  }
}
