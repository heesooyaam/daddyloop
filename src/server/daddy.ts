import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Daddy } from '../core/daddy.js';
import { workspaceSchema, repositorySelectionSchema } from '../core/workspace-registry.js';
import { profileSchema, profilesSchema } from '../core/agents.js';
import { sessionInstructionsPatchSchema, sessionInstructionsSchema } from '../core/instructions.js';
export function registerDaddy(app: FastifyInstance, daddy: Daddy) {
  const id = z.string().uuid();
  const workerNumber = z.number().int().min(1).max(8);

  {
    const prefix = '/api/workspaces';
    app.get(prefix, async () => daddy.workspaces.list());
    app.get(`${prefix}/modules`, async () => daddy.workspaces.modules());
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
          ? daddy.group(input.sessionId).workspace!
          : daddy.workspaces.get(input.workspaceId!),
        input.repository,
      );
    });
  }
  app.get('/api/daddy/sessions', async () => daddy.sessionSummaries());
  app.post('/api/daddy/sessions', { bodyLimit: 1048576 }, async (request, reply) => {
    const input = z
      .object({
        workspaceId: id,
        repository: repositorySelectionSchema.optional(),
        title: z.string().trim().min(1).max(200).optional(),
        message: z.string().trim().min(1).max(20000).optional(),
        workerLimit: workerNumber.optional(),
        requestId: id.optional(),
        instructions: sessionInstructionsSchema.optional(),
        autoPush: z.boolean().optional(),
        publication: z.enum(['auto', 'human']).optional(),
      })
      .strict()
      .parse(request.body);
    const { repository, autoPush: _autoPush, publication: _publication, ...options } = input;
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
  app.post<{ Params: { id: string } }>('/api/daddy/sessions/:id/rename', async (request) => {
    const input = z
      .object({ title: z.string().trim().min(1).max(200) })
      .strict()
      .parse(request.body);
    return daddy.rename(id.parse(request.params.id), input.title);
  });
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
      daddy.group(sessionId).workspace!,
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
            workerLimit: workerNumber.optional(),
            profiles: profilesSchema.partial().optional(),
            forceDaddy: z.boolean().optional(),
            applyWorkers: z.boolean().optional(),
            autoMerge: z.boolean().optional(),
            instructions: sessionInstructionsPatchSchema.optional(),
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
  app.post<{ Params: { id: string } }>('/api/daddy/sessions/:id/tasks', async (request, reply) => {
    const input = z
      .object({
        requirements: z.string().trim().min(1).max(20000),
        requestId: id,
        repository: repositorySelectionSchema.optional(),
        workerRequest: z
          .object({ slot: workerNumber.optional(), profile: profileSchema.optional() })
          .strict()
          .optional(),
      })
      .strict()
      .parse(request.body);
    const sessionId = id.parse(request.params.id);
    const workspace = await daddy.workspaces.selection(
      daddy.group(sessionId).workspace!,
      input.repository,
    );
    const task = await daddy.createTask(sessionId, {
      requirements: input.requirements,
      requestId: `web:task:${input.requestId}`,
      workerRequest: input.workerRequest,
      workspace,
    });
    return reply.code(201).send({ id: task.id });
  });
  app.post<{ Params: { id: string; number: string } }>(
    '/api/daddy/sessions/:id/workers/:number',
    async (request) => {
      const input = z
        .object({ profile: profileSchema, forceTaskId: id.optional() })
        .strict()
        .parse(request.body);
      return daddy.configureWorker(
        id.parse(request.params.id),
        workerNumber.parse(Number(request.params.number)),
        input.profile,
        { force: !!input.forceTaskId, expectedTaskId: input.forceTaskId },
      );
    },
  );
  app.post<{ Params: { id: string } }>('/api/daddy/sessions/:id/delete', async (request, reply) => {
    const input = z
      .object({ expectedGeneration: z.number().int().positive() })
      .strict()
      .parse(request.body);
    const result = await daddy.remove(id.parse(request.params.id), input.expectedGeneration);
    return reply.code(202).send(result);
  });
  app.post<{ Params: { id: string; taskId: string } }>(
    '/api/daddy/sessions/:id/tasks/:taskId/auto-merge',
    async (request) => {
      const { mode } = z
        .object({ mode: z.enum(['on', 'off', 'inherit']) })
        .strict()
        .parse(request.body);
      return daddy.taskAutoMerge(
        id.parse(request.params.id),
        id.parse(request.params.taskId),
        mode,
      );
    },
  );
  app.post<{ Params: { id: string } }>('/api/daddy/sessions/:id/task-action', async (request) => {
    const input = z
      .object({
        taskId: id,
        action: z.enum(['approve-plan', 'waive-checks', 'verify-merge']),
        expectedHead: z.string().max(128),
        expectedGeneration: z.number().int().positive(),
        reason: z.string().trim().max(2000).optional(),
      })
      .strict()
      .parse(request.body);
    return daddy.taskAction(
      id.parse(request.params.id),
      input.taskId,
      input.action,
      {
        head: input.expectedHead,
        generation: input.expectedGeneration,
      },
      input.reason,
    );
  });
}
