import type { AgentRegistry } from './registry.js';
import type { Store } from '../../core/store.js';
import type { AgentUsageView, UsageBackend } from '../../core/usage.js';
import { AppError } from '../../core/types.js';
import { redact } from '../../core/security.js';

export function unavailableUsage(engine: string, name: string, error?: string): AgentUsageView {
  return {
    engine,
    name,
    source: 'unavailable',
    available: false,
    stale: false,
    error,
    buckets: [],
    resets: { availableCount: null, canUse: false, credits: [] },
  };
}

/** Account windows, pricing and reset protocols belong to the selected module. */
export class ModuleUsage implements UsageBackend {
  constructor(
    private agents: AgentRegistry,
    private store: Store,
  ) {}
  async read(refresh = false) {
    const agents = await Promise.all(
      this.agents.engines().map(async ({ id, name }) => {
        try {
          const usage = this.agents.get(id).usage;
          return usage
            ? { ...(await usage.read(refresh)), engine: id, name }
            : unavailableUsage(id, name);
        } catch (error) {
          return unavailableUsage(id, name, redact(String(error)).slice(0, 500));
        }
      }),
    );
    return { agents };
  }
  async prepare(owner: string, engine?: string) {
    const candidates = this.agents.engines().filter(({ id }) => this.agents.get(id).usage?.reset);
    if (!engine && candidates.length === 1) engine = candidates[0].id;
    if (!engine)
      throw new AppError('reset_engine_required', 'Choose an agent with reset support', 422);
    const reset = this.agents.get(engine).usage?.reset;
    if (!reset)
      throw new AppError('reset_unsupported', 'This module does not offer quota resets', 422);
    const plan = await reset.prepare(owner);
    this.store.setSetting(`usage.planEngine:${plan.id}`, engine);
    return plan;
  }
  async consume(id: string, owner: string) {
    const engine = this.store.setting<string>(`usage.planEngine:${id}`);
    if (!engine) throw new AppError('reset_not_found', 'Reset confirmation not found', 404);
    const reset = this.agents.get(engine).usage?.reset;
    if (!reset)
      throw new AppError('reset_unsupported', 'This module does not offer quota resets', 422);
    const result = await reset.consume(id, owner);
    return { plan: result.plan, usage: await this.read() };
  }
}
