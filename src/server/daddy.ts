import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Daddy } from '../core/daddy.js';
import { workspaceSchema, repositorySelectionSchema } from '../core/workspace-registry.js';
import { profilesSchema } from '../core/agents.js';
import { AppError } from '../core/types.js';
import { sessionInstructionsSchema } from '../core/instructions.js';
export function registerDaddy(app: FastifyInstance, daddy: Daddy) {
  const id = z.string().uuid();

  {
    const prefix = '/api/workspaces';
    app.get(prefix, async () => daddy.workspaces.list());
    app.get(`${prefix}/suggestions`, async () => daddy.workspaces.suggestions());
    app.get<{ Querystring: { path?: string } }>(`${prefix}/directories`, async (request) =>
      daddy.workspaces.browse(request.query.path),
    );
    app.post(prefix, async (request, reply) =>
      reply.code(201).send(await daddy.workspaces.register(workspaceSchema.parse(request.body))),
    );
    app.post<{ Params: { id: string } }>(`${prefix}/:id/defaults`, async (request) =>
      daddy.workspaces.register(workspaceSchema.parse(request.body), id.parse(request.params.id)),
    );
    app.post(`${prefix}/preview`, async (request) => {
      const input = z
        .object({
          workspaceId: id.optional(),
          sessionId: id.optional(),
          repository: repositorySelectionSchema.optional(),
        })
        .strict()
        .refine((input) => !!input.workspaceId !== !!input.sessionId)
        .parse(request.body);
      return daddy.workspaces.selection(
        input.sessionId
          ? daddy.board(input.sessionId).workspace!
          : daddy.workspaces.get(input.workspaceId!),
        input.repository,
      );
    });
  }
  app.get('/api/daddy/sessions', async () =>
    daddy.sessions().map((group) => {
      const board = daddy.board(group.id);
      return {
        ...group,
        instructions: undefined,
        workspace: board.workspace,
        workers: board.workers,
        daddyBusy: board.daddyBusy,
        total: board.tasks.length,
        complete: board.tasks.filter((task) => task.state === 'complete').length,
      };
    }),
  );
  app.post('/api/daddy/sessions', { bodyLimit: 1048576 }, async (request, reply) => {
    const input = z
      .object({
        workspaceId: id,
        repository: repositorySelectionSchema.optional(),
        title: z.string().trim().min(1).max(200).optional(),
        message: z.string().trim().min(1).max(20000).optional(),
        workerLimit: z.number().int().min(1).max(8).optional(),
        requestId: id.optional(),
        publication: z.enum(['auto', 'human']).optional(),
        autoPush: z.boolean().optional(),
        instructions: sessionInstructionsSchema.optional(),
      })
      .strict()
      .parse(request.body);
    const { repository, ...options } = input;
    const workspace = await daddy.workspaces.selection(
      daddy.workspaces.get(input.workspaceId),
      repository,
    );
    const defaults = daddy.engine.defaultAgents();
    await Promise.all([
      daddy.catalogue.validate(defaults.worker),
      daddy.catalogue.validate(defaults.daddy),
    ]);
    const group = daddy.create({ ...options, workspace, requirements: input.message });
    return reply.code(201).send(daddy.board(group.id));
  });
  app.get<{ Params: { id: string } }>('/api/daddy/sessions/:id', async (request) =>
    daddy.board(id.parse(request.params.id)),
  );
  app.post<{ Params: { id: string } }>('/api/daddy/sessions/:id/chat', async (request) => {
    const input = z
      .object({
        text: z.string().trim().min(1).max(20000),
        requestId: z.string().uuid().optional(),
        repository: repositorySelectionSchema.optional(),
      })
      .strict()
      .parse(request.body);
    const sessionId = id.parse(request.params.id);
    const workspace = await daddy.workspaces.selection(
      daddy.board(sessionId).workspace!,
      input.repository,
    );
    return daddy.chat(
      sessionId,
      input.text,
      input.requestId ? `api:${sessionId}:${input.requestId}` : undefined,
      workspace,
    );
  });
  app.post<{ Params: { id: string } }>(
    '/api/daddy/sessions/:id/settings',
    { bodyLimit: 1048576 },
    async (request) =>
      daddy.settings(
        id.parse(request.params.id),
        z
          .object({
            workerLimit: z.number().int().min(1).max(8).optional(),
            profiles: profilesSchema.optional(),
            instructions: sessionInstructionsSchema.optional(),
          })
          .strict()
          .parse(request.body),
      ),
  );
  app.post<{ Params: { id: string } }>('/api/daddy/sessions/:id/pause', async (request) =>
    daddy.pause(id.parse(request.params.id)),
  );
  app.post<{ Params: { id: string } }>('/api/daddy/sessions/:id/resume', async (request) =>
    daddy.resume(id.parse(request.params.id)),
  );
  app.post<{ Params: { id: string } }>('/api/daddy/sessions/:id/task-action', async (request) => {
    const input = z
      .object({
        taskId: id,
        action: z.enum(['approve-plan', 'waive-checks', 'publish', 'submit']),
        expectedHead: z.string().max(128),
        expectedGeneration: z.number().int().positive(),
      })
      .strict()
      .parse(request.body);
    const task = daddy.task(id.parse(request.params.id), input.taskId);
    if (task.revision?.head !== input.expectedHead || task.generation !== input.expectedGeneration)
      throw new AppError(
        'stale_task',
        'The task changed. Refresh it before confirming this action.',
      );
    const expected = {
      head: input.expectedHead,
      generation: input.expectedGeneration,
      groupId: request.params.id,
    };
    if (input.action === 'publish') return daddy.engine.publish(task.id, expected);
    if (input.action === 'submit') return daddy.tickets.submit(task.id, expected);
    return daddy.engine.action(task.id, input.action, '', expected);
  });
}
