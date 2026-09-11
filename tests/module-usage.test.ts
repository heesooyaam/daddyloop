import { it, expect, vi } from 'vitest';
import { Store } from '../src/core/store.js';
import { AgentRegistry } from '../src/modules/agents/registry.js';
import { ModuleUsage, unavailableUsage } from '../src/modules/agents/usage.js';
import type { AgentModule } from '../src/modules/contracts.js';
it('combines isolated module readings and routes reset confirmations to their recorded engine', async () => {
  const store = new Store(':memory:');
  const plan = {
    id: 'a9196e5f-ea99-4eb7-b306-f0c217cdcf11',
    availableCount: 1,
    title: 'Provider reset',
    expiresAt: '2099-01-01',
    status: 'ready' as const,
  };
  const reading = { ...unavailableUsage('first', 'First'), available: true, stale: false };
  const reset = {
    prepare: vi.fn(async () => plan),
    consume: vi.fn(async () => ({ plan, usage: reading })),
  };
  const stub = {
    runtime: { run: vi.fn(), runSession: vi.fn() },
    catalogue: { list: async () => [], validate: async () => {} },
  };
  const first: AgentModule = {
    ...stub,
    id: 'first',
    name: 'First',
    usage: { read: async () => reading, reset },
  };
  const second: AgentModule = {
    ...stub,
    id: 'second',
    name: 'Second',
    usage: {
      read: async () => {
        throw new Error('Provider offline');
      },
    },
  };
  try {
    const usage = new ModuleUsage(new AgentRegistry([first, second]), store);
    expect((await usage.read()).agents).toMatchObject([
      { engine: 'first', available: true },
      { engine: 'second', available: false, error: 'Error: Provider offline' },
    ]);
    await expect(usage.prepare('api', 'second')).rejects.toThrow('does not offer');
    await usage.prepare('api');
    expect(reset.prepare).toHaveBeenCalledWith('api');
    const restarted = new ModuleUsage(new AgentRegistry([first, second]), store);
    expect((await restarted.consume(plan.id, 'api')).usage.agents).toHaveLength(2);
    expect(reset.consume).toHaveBeenCalledWith(plan.id, 'api');
    await expect(
      new ModuleUsage(new AgentRegistry([second]), store).consume(plan.id, 'api'),
    ).rejects.toThrow('not enabled');
  } finally {
    store.close();
  }
});
