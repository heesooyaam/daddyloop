import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Daddy } from '../core/daddy.js';
import { projectInput } from '../core/projects.js';
import { profilesSchema } from '../core/agents.js';
import { AppError } from '../core/types.js';
export function registerDaddy(app: FastifyInstance, daddy: Daddy) {
  const id = z.string().uuid();
  app.get('/api/projects', async () => daddy.projects.list());
  app.post('/api/daddy/adopt', async (request) => {
    const input = z.object({ taskId: id, projectId: id }).strict().parse(request.body);
    return daddy.adopt(input.taskId, input.projectId);
  });
  app.get('/api/projects/suggestions', async () => daddy.projects.suggestions());
  app.get<{ Querystring: { path?: string } }>('/api/projects/directories', async (request) =>
    daddy.projects.browse(request.query.path),
  );
  app.post('/api/projects', async (request, reply) =>
    reply.code(201).send(await daddy.projects.register(projectInput.parse(request.body))),
  );
  app.get('/api/daddy/sessions', async () =>
    daddy.sessions().map((group) => {
      const board = daddy.board(group.id);
      return {
        ...group,
        project: board.project,
        writers: board.writers,
        daddyBusy: board.daddyBusy,
        total: board.tasks.length,
        complete: board.tasks.filter((task) => task.state === 'complete').length,
      };
    }),
  );
  app.post('/api/daddy/sessions', async (request, reply) => {
    const input = z
      .object({
        projectId: id,
        title: z.string().trim().min(1).max(200).optional(),
        message: z.string().trim().min(1).max(20000).optional(),
        writerLimit: z.number().int().min(1).max(8).optional(),
        requestId: id.optional(),
        publication: z.enum(['auto', 'human']).optional(),
        autoPush: z.boolean().optional(),
      })
      .strict()
      .parse(request.body);
    const group = daddy.create({ ...input, requirements: input.message });
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
      })
      .strict()
      .parse(request.body);
    const sessionId = id.parse(request.params.id);
    return daddy.chat(
      sessionId,
      input.text,
      input.requestId ? `api:${sessionId}:${input.requestId}` : undefined,
    );
  });
  app.post<{ Params: { id: string } }>('/api/daddy/sessions/:id/settings', async (request) =>
    daddy.settings(
      id.parse(request.params.id),
      z
        .object({
          writerLimit: z.number().int().min(1).max(8).optional(),
          profiles: profilesSchema.optional(),
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
