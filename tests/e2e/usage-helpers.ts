import type { Page } from '@playwright/test';
import type { UsageView } from '../../src/core/usage.js';

export async function mockTwoProviders(page: Page) {
  await page.route('**/api/usage', async (route) => {
    const response = await route.fetch();
    const { agents }: UsageView = await response.json();
    const codex = agents[0]!;
    await route.fulfill({
      response,
      json: {
        agents: [
          codex,
          {
            ...codex,
            engine: 'claude',
            name: 'Claude',
            buckets: codex.buckets.map((bucket) => ({ ...bucket, id: 'claude', name: 'Claude' })),
            resets: { availableCount: null, canUse: false, credits: [] },
          },
        ],
      } satisfies UsageView,
    });
  });
}
