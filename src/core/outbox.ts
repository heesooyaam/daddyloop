import { createHash } from 'node:crypto';
import { AppError } from './types.js';
import type { Store } from './store.js';
import { redact } from './security.js';

/** External writes are never blindly retried after an ambiguous outcome. */
export class Outbox {
  private active = new Set<string>();
  constructor(private store: Store) {}
  async perform<T>(
    taskId: string,
    id: string,
    input: unknown,
    write: () => Promise<T>,
    recover: () => Promise<{ found: true; value: T } | { found: false }>,
  ): Promise<T> {
    if (this.active.has(id))
      throw new AppError('operation_busy', 'This operation is already running');
    this.active.add(id);
    try {
      const request = createHash('sha256').update(JSON.stringify(input)).digest('hex');
      const existing = this.store.db.prepare('SELECT * FROM operations WHERE id=?').get(id);
      if (existing && existing.request !== request)
        throw new AppError(
          'idempotency_conflict',
          'This operation key was already used with different arguments',
        );
      if (existing?.status === 'done') return JSON.parse(existing.result as string) as T;
      if (existing) {
        const result = await recover();
        if (!result.found)
          throw new AppError(
            'ambiguous_write',
            'The previous provider write has an uncertain result. Inspect the native review; automatic retry is stopped.',
          );
        this.complete(id, result.value);
        this.store.event(taskId, 'operation.recovered', { operationId: id });
        return result.value;
      }
      this.store.db
        .prepare('INSERT INTO operations VALUES(?,?,?,?,NULL)')
        .run(id, taskId, 'pending', request);
      this.store.event(taskId, 'operation.started', { operationId: id });
      try {
        const result = await write();
        this.complete(id, result);
        this.store.event(taskId, 'operation.completed', { operationId: id });
        return result;
      } catch (error) {
        this.store.event(taskId, 'operation.uncertain', {
          operationId: id,
          error: redact(String(error)),
        });
        throw error;
      }
    } finally {
      this.active.delete(id);
    }
  }
  private complete(id: string, value: unknown) {
    this.store.db
      .prepare("UPDATE operations SET status='done',result=? WHERE id=?")
      .run(JSON.stringify(value ?? null), id);
  }
}
