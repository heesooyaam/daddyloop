export function usageFixture() {
  const view = {
    engine: 'codex',
    name: 'Codex',
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
          {
            remainingPercent: 68,
            durationMinutes: 300,
            resetsAt: new Date(Date.now() + 4 * 3600000).toISOString(),
          },
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
    read: async () => ({
      agents: [{ ...structuredClone(view), retrievedAt: new Date().toISOString() }],
    }),
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
        for (const bucket of view.buckets)
          for (const window of bucket.windows) window.remainingPercent = 100;
      }
      return { plan: { ...plan }, usage: { agents: [structuredClone(view)] } };
    },
  };
}
