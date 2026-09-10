import { afterEach, expect, it, vi } from 'vitest';
import { Engine } from '../src/core/engine.js';
import { Store } from '../src/core/store.js';
import { TicketWorkflow } from '../src/core/ticket-workflow.js';
import { TicketReader } from '../src/integrations/tickets.js';
import { Workspaces } from '../src/runtime/workspaces.js';
import type { ReviewProvider } from '../src/providers/provider.js';
import { ticketInput } from './planning-fixture.js';
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
it.each([false, true])(
  'submits GitLab work with a scoped marker and recovers a lost creation response (lost=%s)',
  async (lost) => {
    vi.stubEnv('GITLAB_TOKEN', 'fixture-gitlab-credential');
    const store = new Store(':memory:');
    let body: Record<string, any> | undefined,
      posts = 0;
    const input = ticketInput();
    input.ref = { ...input.ref, provider: 'gitlab', host: 'gitlab.com', repo: 'team/sub/project' };
    const provider = {
      getPR: async () => ({
        title: 'Fixture MR',
        body: '',
        head: 'b'.repeat(40),
        base: 'a'.repeat(40),
        start: 'a'.repeat(40),
        state: 'open',
        branch: 'fixture',
        targetBranch: 'main',
        cloneUrl: 'https://gitlab.com/team/sub/project.git',
        checks: 'passing',
        checkDetails: [],
      }),
    } as unknown as ReviewProvider;
    const engine = new Engine(store, () => provider),
      ws = new Workspaces('/tmp');
    vi.spyOn(ws, 'pushTicket').mockResolvedValue(undefined);
    const reader = new TicketReader(async (url, options) => {
      const path = new URL(String(url)).pathname;
      if (path === '/api/v4/user') return new Response('{"id":7}');
      if (options?.method === 'POST') {
        posts++;
        body = JSON.parse(String(options.body));
        if (lost) throw new Error('response lost');
        return new Response(
          JSON.stringify({
            iid: 9,
            web_url: 'https://gitlab.com/team/sub/project/-/merge_requests/9',
          }),
        );
      }
      if (path.endsWith('/merge_requests'))
        return new Response(
          JSON.stringify([
            {
              iid: 9,
              web_url: 'https://gitlab.com/team/sub/project/-/merge_requests/9',
              description: body?.description,
              source_branch: body?.source_branch,
              source_project_id: 55,
              author: { id: 7 },
            },
          ]),
        );
      return new Response('{"id":55}');
    });
    const workflow = new TicketWorkflow(engine, ws, reader);
    try {
      const task = await engine.createTicket(input);
      store.cancelJobs(task.id);
      task.state = 'ready_for_review';
      task.pendingAuthorHead = 'b'.repeat(40);
      store.saveTask(task);
      if (lost) await expect(workflow.submit(task.id)).rejects.toThrow('did not finish');
      const result = await workflow.submit(task.id);
      expect(result.ref).toMatchObject({ provider: 'gitlab', repo: 'team/sub/project', number: 9 });
      expect(posts).toBe(1);
      expect(body).toMatchObject({
        source_branch: task.ticketRepository!.branch,
        target_branch: 'main',
        remove_source_branch: false,
      });
      expect(body?.description).toContain(`<!-- reviewloop:ticket:${task.id} -->`);
      expect(body?.title).toMatch(/^Draft:/);
    } finally {
      store.close();
    }
  },
);
