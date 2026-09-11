import { it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/core/store.js';
it('does not emit or retain an event from a rolled-back state transition', async () => {
  const store = new Store(':memory:'),
    events: unknown[] = [];
  store.changes.on('event', (e) => events.push(e));
  expect(() =>
    store.transaction(() => {
      store.event('t', 'should.not.exist');
      throw new Error('rollback');
    }),
  ).toThrow();
  await Promise.resolve();
  expect(events).toHaveLength(0);
  expect(store.events('t')).toHaveLength(0);
  store.transaction(() => store.event('t', 'committed'));
  await Promise.resolve();
  expect(events).toHaveLength(1);
  store.close();
});
it('retains task state, job intent and events across a SQLite reopen', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'daddyloop-store-test-')),
    path = join(dir, 'state.sqlite');
  try {
    let store = new Store(path);
    store.setSetting('fixture', { pendingReview: 'R1' });
    store.event('t', 'review.started', { head: 'H1' });
    store.close();
    store = new Store(path);
    expect(store.setting('fixture')).toEqual({ pendingReview: 'R1' });
    expect(store.events('t')[0].data).toEqual({ head: 'H1' });
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
