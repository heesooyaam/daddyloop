export function usageFixture() {
  const view = {
    source: 'codex-app-server:account/rateLimits/read',
    available: true,
    stale: false,
    retrievedAt: new Date().toISOString(),
    cliVersion: '0.154.0',
    ordinaryUsageAllowed: true,
    buckets: [
      {
        id: 'codex',
        name: 'Codex',
        plan: 'pro',
        windows: [
          { remainingPercent: 27, durationMinutes: 10080, resetsAt: '2026-09-15T12:00:00.000Z' },
        ],
      },
    ],
    resets: {
      availableCount: 3,
      canUse: true,
      credits: [
        { id: 'fixture-reset', title: 'Full reset', expiresAt: '2026-09-30T12:00:00.000Z' },
      ],
    },
  };
  const plans = new Map();
  return {
    read: async () => structuredClone(view),
    prepare: async (owner) => {
      const plan = {
        id: crypto.randomUUID(),
        owner,
        availableCount: view.resets.availableCount,
        title: 'Full reset',
        expiresAt: new Date(Date.now() + 300000).toISOString(),
        status: 'ready',
      };
      plans.set(plan.id, plan);
      return { ...plan };
    },
    consume: async (id, owner) => {
      const plan = plans.get(id);
      if (!plan || plan.owner !== owner) throw new Error('Wrong reset owner');
      if (plan.status !== 'done') {
        plan.status = 'done';
        plan.outcome = 'reset';
        view.resets.availableCount--;
        view.resets.canUse = view.resets.availableCount > 0;
        view.buckets[0].windows[0].remainingPercent = 100;
      }
      return { plan: { ...plan }, usage: structuredClone(view) };
    },
  };
}
