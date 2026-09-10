import { expect, it, vi } from 'vitest';
import { CodexUsage } from '../src/core/usage.js';
import { Store } from '../src/core/store.js';
import { usageLines } from '../src/client/usage.js';
function fixture() {
  const store = new Store(':memory:');
  let account = 'account-a',
    command = '/fixture/codex',
    available = 1,
    used = 81,
    failRead = false,
    loseResponse = false;
  const consumed = new Set<string>(),
    calls: { method: string; params?: Record<string, unknown> }[] = [];
  const connection = () => ({
    start: async () => ({ userAgent: 'codex/0.154.0' }),
    close: vi.fn(),
    request: async <T>(method: string, params?: Record<string, unknown>): Promise<T> => {
      calls.push({ method, params });
      if (method === 'account/rateLimits/read') {
        if (failRead) throw new Error('Usage backend unavailable');
        return {
          accountId: account,
          ordinaryUsageAllowed: false,
          rateLimits: {
            limitId: 'codex',
            primary: { usedPercent: used, windowDurationMins: 10080, resetsAt: 1900000000 },
          },
          rateLimitResetCredits: {
            availableCount: available,
            credits: available
              ? [
                  {
                    id: 'credit-a',
                    status: 'available',
                    resetType: 'codexRateLimits',
                    title: 'Full reset',
                    expiresAt: 1900000000,
                  },
                ]
              : [],
          },
        } as T;
      }
      if (method === 'account/rateLimitResetCredit/consume') {
        const key = String(params?.idempotencyKey);
        if (consumed.has(key)) return { outcome: 'alreadyRedeemed' } as T;
        consumed.add(key);
        available--;
        used = 0;
        if (loseResponse) {
          loseResponse = false;
          throw new Error('Response lost after the server consumed the credit');
        }
        return { outcome: 'reset' } as T;
      }
      throw new Error('Unexpected method');
    },
  });
  const create = () => new CodexUsage(store, () => command, connection);
  return {
    store,
    create,
    calls,
    consumed,
    account: (value: string) => {
      account = value;
    },
    command: (value: string) => {
      command = value;
    },
    failRead: () => {
      failRead = true;
    },
    lose: () => {
      loseResponse = true;
    },
  };
}
it('reads actual quota windows, keeps unknown/stale data distinct and caches background reads', async () => {
  const f = fixture(),
    usage = f.create();
  try {
    const view = await usage.read();
    expect(view.buckets[0].windows[0]).toMatchObject({
      remainingPercent: 19,
      durationMinutes: 10080,
    });
    expect(view.ordinaryUsageAllowed).toBe(false); // Percentages do not imply permission to resume work.
    expect(usageLines(view, 'ru').join('\n')).toContain('7 дн.: осталось 19%');
    await usage.read();
    expect(f.calls).toHaveLength(1);
    f.failRead();
    const stale = await usage.read(true);
    expect(stale).toMatchObject({ stale: true, available: true, resets: { canUse: false } });
    expect(stale.buckets[0].windows[0].remainingPercent).toBe(19);
    f.command('/fixture/new-codex');
    expect(await usage.read()).toMatchObject({ available: false, stale: true, buckets: [] });
  } finally {
    f.store.close();
  }
});
it('prepares without consuming and fences expired, cross-client and changed-account confirmations', async () => {
  const f = fixture(),
    usage = f.create();
  try {
    const plan = await usage.prepare('owner');
    expect(f.consumed.size).toBe(0);
    await expect(usage.consume(plan.id, 'other')).rejects.toThrow('not found');
    f.account('account-b');
    await expect(usage.consume(plan.id, 'owner')).rejects.toThrow('account changed');
    expect(f.consumed.size).toBe(0);
    f.account('account-a');
    f.command('/fixture/new-codex');
    await expect(usage.consume(plan.id, 'owner')).rejects.toThrow('Codex changed');
    f.command('/fixture/codex');
    const saved = f.store.setting<any>(`usage.reset:${plan.id}`);
    saved.expiresAt = '2000-01-01T00:00:00Z';
    f.store.setSetting(`usage.reset:${plan.id}`, saved);
    await expect(usage.consume(plan.id, 'owner')).rejects.toThrow('expired');
    expect(f.consumed.size).toBe(0);
  } finally {
    f.store.close();
  }
});
it('recovers a lost response with the same idempotency key after restart, including the last credit', async () => {
  const f = fixture(),
    usage = f.create();
  try {
    const plan = await usage.prepare('owner');
    f.lose();
    await expect(usage.consume(plan.id, 'owner')).rejects.toThrow('Response lost');
    expect(f.consumed.size).toBe(1);
    const restarted = f.create();
    expect((await restarted.read()).resets).toMatchObject({
      availableCount: 0,
      canUse: true,
      pending: true,
    });
    expect(await restarted.prepare('owner')).toMatchObject({ id: plan.id, status: 'pending' });
    await expect(restarted.prepare('other')).rejects.toThrow('client that started');
    const result = await restarted.consume(plan.id, 'owner');
    expect(result.plan.outcome).toBe('alreadyRedeemed');
    expect(result.usage.resets.availableCount).toBe(0);
    expect(result.usage.buckets[0].windows[0].remainingPercent).toBe(100);
    await restarted.consume(plan.id, 'owner');
    expect(
      f.calls
        .filter((call) => call.method.endsWith('/consume'))
        .map((call) => call.params?.idempotencyKey),
    ).toEqual([plan.id, plan.id]);
    expect(f.consumed.size).toBe(1);
  } finally {
    f.store.close();
  }
});
it('keeps a confirmed reset successful even when the following quota read fails', async () => {
  const f = fixture();
  const base = f.create(),
    plan = await base.prepare('owner');
  let reads = 0;
  // A separate connection fixture makes the refresh failure occur after a confirmed write.
  const usage = new CodexUsage(f.store, '/fixture/codex', () => ({
    start: async () => ({}),
    close: () => {},
    request: async <T>(method: string): Promise<T> => {
      if (method.endsWith('/consume')) return { outcome: 'reset' } as T;
      if (++reads > 1) throw new Error('Refresh offline');
      return {
        accountId: 'account-a',
        rateLimits: {},
        rateLimitResetCredits: { availableCount: 1, credits: null },
      } as T;
    },
  }));
  try {
    const result = await usage.consume(plan.id, 'owner');
    expect(result.plan).toMatchObject({ status: 'done', outcome: 'reset' });
    expect(result.usage.stale).toBe(true);
  } finally {
    f.store.close();
  }
});
it('cannot replace fresh post-reset limits with a delayed pre-reset read', async () => {
  const store = new Store(':memory:');
  let release!: (value: unknown) => void,
    reads = 0,
    used = 81;
  const data = () => ({
    accountId: 'a',
    rateLimits: { limitId: 'codex', primary: { usedPercent: used, windowDurationMins: 10080 } },
    rateLimitResetCredits: { availableCount: 2, credits: null },
  });
  const usage = new CodexUsage(store, '/fixture/codex', () => ({
    start: async () => ({}),
    close: () => {},
    request: async <T>(method: string): Promise<T> => {
      if (method.endsWith('/consume')) {
        used = 0;
        return { outcome: 'reset' } as T;
      }
      if (++reads === 1)
        return new Promise<T>((resolve) => {
          release = resolve as (value: unknown) => void;
        });
      return data() as T;
    },
  }));
  try {
    const old = usage.read();
    await vi.waitFor(() => expect(release).toBeDefined());
    const snapshot = data(),
      plan = await usage.prepare('owner');
    const result = await usage.consume(plan.id, 'owner');
    expect(result.usage.buckets[0].windows[0].remainingPercent).toBe(100);
    release(snapshot);
    expect((await old).buckets[0].windows[0].remainingPercent).toBe(100);
    expect((await usage.read()).buckets[0].windows[0].remainingPercent).toBe(100);
  } finally {
    store.close();
  }
});
