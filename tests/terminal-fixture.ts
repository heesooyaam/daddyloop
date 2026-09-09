import type { Api, Detail, Status } from '../src/terminal/model.js';
import type { Task } from '../src/core/types.js';
import { defaultPolicy } from '../src/core/types.js';
export const taskA: Task = {
  id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  title: 'Protect session generation',
  kind: 'code',
  requirements: 'Keep old callbacks from changing the new session.',
  ref: {
    provider: 'demo',
    host: 'demo.local',
    repo: 'test/session',
    number: 1,
    url: 'https://demo.local/pull/1',
  },
  repoPath: '/tmp/demo',
  policy: defaultPolicy,
  state: 'awaiting_publication',
  reason: 'One draft finding ready.',
  generation: 1,
  contextVersion: 1,
  round: 1,
  noProgress: 0,
  summary: '',
  revision: { head: 'a'.repeat(40), base: 'b'.repeat(40), start: 'b'.repeat(40) },
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};
export const taskB: Task = {
  ...taskA,
  id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  title: 'Handle reconnects',
};
export const status: Status = {
  version: '0.4.0',
  activeJobs: 0,
  publicOrigin: null,
  demoEnabled: true,
  resources: {
    ok: true,
    reasons: [],
    memoryAvailableGiB: 6,
    memoryTotalGiB: 8,
    diskAvailableGiB: 180,
    diskUsedPercent: 70,
  },
};
export const detail = (task: Task): Detail => ({
  task,
  messages: [
    {
      id: task.id + '-reviewer',
      role: 'reviewer',
      sender: 'agent',
      text: 'Reviewer-only explanation',
      at: task.createdAt,
      taskId: task.id,
    },
    {
      id: task.id + '-author',
      role: 'author',
      sender: 'agent',
      text: 'Author-only response',
      at: task.createdAt,
      taskId: task.id,
    },
  ],
  jobs: [],
  events: [],
  decisions: [],
});
export function transport(
  override?: (path: string, body?: unknown, signal?: AbortSignal) => Promise<unknown> | undefined,
) {
  const writes: { path: string; body: unknown }[] = [];
  const api: Api = async <T>(path: string, body?: unknown, signal?: AbortSignal) => {
    if (body !== undefined) writes.push({ path, body });
    const result = override?.(path, body, signal);
    if (result) return (await result) as T;
    if (body !== undefined) return taskA as T;
    if (path === '/tasks') return [taskA, taskB] as T;
    if (path === '/status') return status as T;
    return detail(path.endsWith(taskA.id) ? taskA : taskB) as T;
  };
  return { api, writes };
}
