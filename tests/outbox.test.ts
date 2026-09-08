import { it, expect, vi } from 'vitest';
import { Store } from '../src/core/store.js';
import { Outbox } from '../src/core/outbox.js';
it('recovers a lost provider response without publishing twice', async () => {
  const store = new Store(':memory:'),
    box = new Outbox(store);
  let published = false;
  const write = vi.fn(async () => {
    published = true;
    throw new Error('Response lost after commit');
  });
  const recover = async () =>
    published ? { found: true as const, value: 'review-123' } : { found: false as const };
  await expect(box.perform('task', 'op', { body: 'hello' }, write, recover)).rejects.toThrow(
    'Response lost',
  );
  expect(await new Outbox(store).perform('task', 'op', { body: 'hello' }, write, recover)).toBe(
    'review-123',
  );
  expect(write).toHaveBeenCalledTimes(1);
  store.close();
});
it('stops when the previous side effect cannot be conclusively recovered', async () => {
  const store = new Store(':memory:'),
    box = new Outbox(store),
    write = vi.fn(async () => {
      throw new Error('timeout');
    });
  const recover = async () => ({ found: false as const });
  await expect(box.perform('task', 'op', {}, write, recover)).rejects.toThrow();
  await expect(box.perform('task', 'op', {}, write, recover)).rejects.toMatchObject({
    code: 'ambiguous_write',
  });
  expect(write).toHaveBeenCalledTimes(1);
  store.close();
});
it('rejects reuse of an idempotency key with changed Markdown', async () => {
  const store = new Store(':memory:'),
    box = new Outbox(store);
  await box.perform(
    'task',
    'R1',
    { body: 'A' },
    async () => 'id',
    async () => ({ found: false }),
  );
  await expect(
    box.perform(
      'task',
      'R1',
      { body: 'B' },
      async () => 'new-id',
      async () => ({ found: false }),
    ),
  ).rejects.toMatchObject({ code: 'idempotency_conflict' });
  store.close();
});
