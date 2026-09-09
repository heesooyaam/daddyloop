import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Engine } from '../core/engine.js';
import type { TicketWorkflow } from '../core/ticket-workflow.js';
import { ModelCatalogue, profileSchema, profilesSchema } from '../core/agents.js';
import { AppError, type AgentProfiles } from '../core/types.js';
import { parsePR } from '../providers/provider.js';
import { notificationPreferences, notificationsSchema } from '../integrations/notifications.js';
import { redact } from '../core/security.js';
export type Catalogue = Pick<ModelCatalogue, 'list' | 'validate'>;
export function registerPlanning(
  app: FastifyInstance,
  engine: Engine,
  tickets: TicketWorkflow,
  catalogue: Catalogue,
  maxAgents: number,
) {
  const validate = async (profiles?: AgentProfiles) => {
    if (profiles)
      await Promise.all([
        catalogue.validate(profiles.author),
        catalogue.validate(profiles.reviewer),
      ]);
  };
  app.get('/api/agents', async () => {
    let models: Awaited<ReturnType<Catalogue['list']>> = [],
      error: string | undefined;
    try {
      models = await catalogue.list();
    } catch (value) {
      error = redact(String(value));
    }
    return {
      defaults: engine.defaultAgents(),
      models,
      error,
      maxConcurrentAgents: engine.store.setting<number>('worker.maxAgents') ?? maxAgents,
      engines: ['codex'],
    };
  });
  app.post('/api/agents/defaults', async (request) => {
    const input = z
      .object({
        profiles: profilesSchema,
        maxConcurrentAgents: z.number().int().min(1).max(8).optional(),
      })
      .strict()
      .parse(request.body);
    await validate(input.profiles);
    engine.store.transaction(() => {
      engine.setDefaultAgents(input.profiles);
      if (input.maxConcurrentAgents !== undefined)
        engine.store.setSetting('worker.maxAgents', input.maxConcurrentAgents);
    });
    return {
      defaults: engine.defaultAgents(),
      maxConcurrentAgents: engine.store.setting<number>('worker.maxAgents') ?? maxAgents,
    };
  });
  app.post<{ Params: { role: string } }>('/api/agents/defaults/:role', async (request) => {
    const role = z.enum(['author', 'reviewer']).parse(request.params.role),
      profile = profileSchema.parse(request.body);
    await catalogue.validate(profile);
    return { defaults: engine.setDefaultAgents({ ...engine.defaultAgents(), [role]: profile }) };
  });
  app.post('/api/agents/concurrency', async (request) => {
    const { maxConcurrentAgents } = z
      .object({ maxConcurrentAgents: z.number().int().min(1).max(8) })
      .strict()
      .parse(request.body);
    engine.store.setSetting('worker.maxAgents', maxConcurrentAgents);
    return { maxConcurrentAgents };
  });
  app.post<{ Params: { id: string } }>('/api/tasks/:id/agents', async (request) => {
    const input = z
      .object({ role: z.enum(['author', 'reviewer']), profile: profileSchema })
      .strict()
      .parse(request.body);
    await catalogue.validate(input.profile);
    return engine.setTaskAgent(request.params.id, input.role, input.profile);
  });
  app.get('/api/groups', async () =>
    engine.store.groups().map((group) => {
      const children = engine.store.tasks().filter((task) => task.groupId === group.id);
      return {
        ...group,
        source: group.source
          ? { key: group.source.key, url: group.source.url, title: group.source.title }
          : undefined,
        tasks: children.map((task) => ({
          id: task.id,
          parentTaskId: task.parentTaskId,
          title: task.title,
          state: task.state,
          author: engine.effectiveAgents(task).author,
          url: task.ref.url,
        })),
        complete: children.filter((task) => task.state === 'complete').length,
      };
    }),
  );
  app.post('/api/tickets/preview', async (request) => {
    const { source } = z
      .object({ source: z.string().min(1).max(2048) })
      .strict()
      .parse(request.body);
    return tickets.reader.read(source);
  });
  app.post('/api/tickets', async (request, reply) => {
    const input = z
      .object({
        source: z.string().min(1).max(2048),
        repoPath: z.string().max(4000).optional(),
        parentTaskId: z.string().uuid().optional(),
        base: z.string().max(200).optional(),
        requirements: z.string().min(1).max(100000).optional(),
        agents: profilesSchema.optional(),
        publication: z.enum(['auto', 'human']).default('auto'),
        autoPush: z.boolean().default(true),
      })
      .strict()
      .parse(request.body);
    await validate(input.agents);
    const task = await tickets.start(input);
    reply.code(201);
    return task;
  });
  app.post<{ Params: { id: string } }>('/api/tasks/:id/link-pr', async (request) => {
    const { url } = z.object({ url: z.string().url() }).strict().parse(request.body);
    return engine.linkPR(request.params.id, parsePR(url));
  });
  app.get('/api/notifications', async () => ({
    telegram: notificationPreferences(engine.store),
    paired: !!engine.store.setting('telegram.pairing'),
  }));
  app.post('/api/notifications', async (request) => {
    const input = notificationsSchema.parse(request.body);
    engine.store.setSetting('notifications.telegram', input);
    return {
      telegram: notificationPreferences(engine.store),
      paired: !!engine.store.setting('telegram.pairing'),
    };
  });
  app.post<{ Params: { id: string } }>('/api/tasks/:id/implement', async (request) =>
    engine.implement(request.params.id),
  );
  app.post<{ Params: { id: string } }>('/api/tasks/:id/submit', async (request) =>
    tickets.submit(request.params.id),
  );
  app.get<{ Params: { id: string } }>('/api/groups/:id', async (request) => {
    const group = engine.store.getGroup(request.params.id);
    if (!group) throw new AppError('not_found', 'Group not found', 404);
    return { group, tasks: engine.store.tasks().filter((task) => task.groupId === group.id) };
  });
}
