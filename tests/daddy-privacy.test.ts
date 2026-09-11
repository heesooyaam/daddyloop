import { expect, it, vi } from 'vitest';
import { daddyFixture } from './daddy-fixture.js';
import type { SessionInput } from '../src/runtime/agent.js';
import { prRef } from '../src/core/types.js';
it('keeps unpublished native review and reviewer chat out of the coordination context and worker instructions', async () => {
  const f = daddyFixture();
  let current!: SessionInput, done!: () => void;
  f.runtime.runSession.mockImplementation(async (input) => {
    current = input;
    await new Promise<void>((resolve) => {
      done = resolve;
      input.signal.addEventListener('abort', () => resolve(), { once: true });
    });
    return { status: 'completed', summary: 'Done', checkedHead: '' };
  });
  try {
    const group = f.daddy.create({ workspaceId: f.workspace.id, message: 'Coordinate the work' });
    const task = await f.engine.create({
      ref: {
        provider: 'demo',
        host: 'demo.local',
        repo: 'fixture/workspace',
        number: 1,
        url: 'https://demo.local/pull/1',
      },
      repoPath: f.dir,
      requirements: 'Review the current code',
      groupId: group.id,
      policy: { publication: 'human' },
    });
    await f.engine.review(task.id);
    f.store.cancelJobs(task.id);
    const updated = f.store.getTask(task.id);
    await f.engine
      .provider(prRef(updated))
      .updateSummary(prRef(updated), updated.review!, 'UNPUBLISHED-FINDING');
    updated.summary = 'UNPUBLISHED-FINDING';
    updated.reason = 'UNPUBLISHED-FINDING';
    f.store.saveTask(updated);
    f.store.message(task.id, 'reviewer', 'agent', 'PRIVATE-REVIEWER-CHAT');
    f.daddy.tick();
    await vi.waitFor(() => expect(current).toBeDefined());
    expect(current.prompt).not.toContain('UNPUBLISHED-FINDING');
    const board = JSON.stringify(await current.onTool('read_board', {}, 'board'));
    const details = JSON.stringify(await current.onTool('read_task', { taskId: task.id }, 'task'));
    expect(board).not.toContain('UNPUBLISHED-FINDING');
    expect(details).not.toContain('UNPUBLISHED-FINDING');
    expect(details).not.toContain('PRIVATE-REVIEWER-CHAT');
    await expect(
      current.onTool(
        'message_worker',
        { taskId: task.id, instruction: 'Implement the finding' },
        'handoff',
      ),
    ).rejects.toThrow('published');
    expect(f.store.jobs(task.id).some((job) => job.role === 'author')).toBe(false);
  } finally {
    done?.();
    await f.close();
  }
});
