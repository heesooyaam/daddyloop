import { expect, it } from 'vitest';
import { daddyFixture } from './daddy-fixture.js';
import { taskActivity, taskReference } from '../src/core/task-activity.js';
import { queueCard, taskCard } from '../src/integrations/telegram-tasks.js';
import { Store } from '../src/core/store.js';
import { join } from 'node:path';

it.each(['plan', 'fix'] as const)(
  'honors the coordinator dependency before a native %s, including after reopening SQLite',
  async (kind) => {
    const f = daddyFixture(true);
    try {
      const group = f.daddy.create({
        workspaceId: f.workspace.id,
        workerLimit: 2,
        message: 'Coordinate shared ownership',
      });
      const coordinator = f.store.daddyJobs(group.id)[0];
      const make = (n: number) =>
        f.engine.create({
          groupId: group.id,
          repoPath: f.dir,
          requirements: 'Share the queue',
          ref: {
            provider: 'demo',
            host: 'demo.local',
            repo: 'r/test',
            number: n,
            url: 'https://demo.local/r/test/pull/' + n,
          },
        });
      const consumer = await make(10),
        producer = await make(11);
      for (const t of [producer, consumer]) f.store.saveTask({ ...t, state: 'fixing' });
      const g = f.store.getGroup(group.id);
      g.workerSlots = [
        { number: 1, taskId: consumer.id },
        { number: 2, taskId: producer.id },
      ];
      f.store.saveGroup(g);
      const job = f.store.enqueue(consumer, 'author', kind, 'Continue with the agreed owner');
      await f.daddy.call(
        coordinator,
        'set_dependencies',
        { taskId: consumer.id, dependsOn: [producer.id] },
        'order',
        new AbortController().signal,
      );
      const board = f.daddy.board(group.id);
      expect(board.tasks.find((t) => t.id === consumer.id)).toMatchObject({
        statusLabel: 'Waiting for prerequisite tasks',
        queueDetail: taskReference(producer),
      });
      const card = queueCard(
        'ru',
        group.id,
        taskActivity(f.store.tasks(group.id), f.store.activeJobs()),
      );
      expect(card.text).toContain('Ждёт завершения связанных задач');
      expect(card.text).toContain(taskReference(producer));
      const activity = taskActivity(f.store.tasks(group.id), f.store.activeJobs()).find(
        (item) => item.task.id === consumer.id,
      )!;
      expect(taskCard('ru', activity).text).toContain(taskReference(producer));
      expect(taskCard('en', activity).text).not.toContain(consumer.reason);

      const db = new Store(join(f.dir, 'state.sqlite'));
      try {
        expect(db.claim()).toBeUndefined();
        const upstream = db.enqueue(producer, 'author', 'fix', 'Do shared work');
        expect(db.claim()?.id).toBe(upstream.id);
        db.saveJob({ ...upstream, status: 'completed' });
        db.saveTask({ ...producer, state: 'complete' });
        const single = taskActivity(
          [db.getTask(consumer.id)],
          db.activeJobs(consumer.id),
          undefined,
          [],
          (id) => db.prerequisiteState(group.id, id),
        );
        expect(single[0].waitingFor).toEqual([]);
        expect(db.claim()).toMatchObject({ id: job.id, taskId: consumer.id, kind });
        expect(db.getGroup(group.id).workerSlots?.[0].taskId).toBe(consumer.id);
      } finally {
        db.close();
      }
    } finally {
      await f.close();
    }
  },
);
it('rejects an impossible order with a pinned slot and lets daddy revise a waiting order', async () => {
  const f = daddyFixture();
  try {
    const group = f.daddy.create({
      workspaceId: f.workspace.id,
      workerLimit: 1,
      message: 'Choose an owner',
    });
    const coordinator = f.store.daddyJobs(group.id)[0];
    const signal = new AbortController().signal;
    const t = await f.engine.create({
      groupId: group.id,
      repoPath: f.dir,
      requirements: 'Consumer',
      ref: {
        provider: 'demo',
        host: 'demo.local',
        repo: 'r/test',
        number: 1,
        url: 'https://demo.local/r/test/pull/1',
      },
    });
    f.store.saveTask({ ...t, state: 'needs_input', resumeState: 'fixing' });
    const prerequisite = await f.daddy.createTask(group.id, {
      requirements: 'Second issue',
      requestId: 'p',
    });
    const g = f.store.getGroup(group.id);
    g.workerSlots = [{ number: 1, taskId: t.id }];
    f.store.saveGroup(g);
    const set = (deps: string[], key: string) =>
      f.daddy.call(coordinator, 'set_dependencies', { taskId: t.id, dependsOn: deps }, key, signal);
    await expect(set([prerequisite.id], 'impossible')).rejects.toMatchObject({
      code: 'dependency_capacity',
    });
    expect(f.store.getTask(t.id).dependsOn ?? []).toEqual([]);
    f.store.saveGroup({ ...g, workerLimit: 2, requestedWorkerLimit: 2 });
    await set([prerequisite.id], 'now-possible');
    f.store.saveTask({ ...f.store.getTask(t.id), state: 'fixing' });
    const fix = f.store.enqueue(t, 'author', 'fix', 'Test');
    expect(f.store.claim((j) => j.taskId === t.id)).toBeUndefined();
    await set([], 'reordered');
    expect(f.store.claim((j) => j.taskId === t.id)?.id).toBe(fix.id);
  } finally {
    await f.close();
  }
});
