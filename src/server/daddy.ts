import { checkWaiverReasonLimit } from '../core/task-activity.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Daddy } from '../core/daddy.js';
import { workspaceSchema, repositorySelectionSchema } from '../core/workspace-registry.js';
import { profileSchema, profilesSchema } from '../core/agents.js';
import { AppError } from '../core/types.js';
import { sessionInstructionsSchema } from '../core/instructions.js';
export function registerDaddy(app: FastifyInstance, daddy: Daddy) {
  const id = z.string().uuid();
  const workerNumber = z.number().int().min(1).max(8);
  const generation = z.number().int().positive();
  const revision = z
    .object({
      head: z.string(),
      base: z.string(),
      start: z.string(),
      revisionId: z.string().optional(),
    })
    .strict();
  const expectedTask = z
    .object({ generation, head: z.string(), revision: revision.optional() })
    .strict();
  const sessionVersion = z.object({ expectedGeneration: generation.optional() }).strict();

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
    app.post<{ Params: { id: string } }>(`${prefix}/:id/defaults`, async (request) => {
      const { baseline, ...edit } = workspaceSchema
        .extend({ baseline: workspaceSchema.optional() })
        .parse(request.body);
      return daddy.workspaces.register(edit, id.parse(request.params.id), baseline);
    });
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
        publication: z.enum(['auto', 'human']).optional(),
        autoPush: z.boolean().optional(),
        instructions: sessionInstructionsSchema.optional(),
      })
      .strict()
      .parse(request.body);
    const { repository, publication: _publication, autoPush: _autoPush, ...options } = input;
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
    { bodyLimit: 2097152 },
    async (request) =>
      daddy.settings(
        id.parse(request.params.id),
        z
          .object({
            baseline: z
              .object({
                workerLimit: workerNumber.optional(),
                profiles: profilesSchema.partial().optional(),
                workerSlotProfiles: z
                  .array(z.object({ number: workerNumber, profile: profileSchema }).strict())
                  .max(8)
                  .optional(),
                workerTaskProfiles: z.record(id, profileSchema).optional(),
                architectProfile: profileSchema.nullable().optional(),
                instructions: sessionInstructionsSchema.nullable().optional(),
                autoMerge: z.boolean().optional(),
              })
              .strict()
              .optional(),
            expectedGeneration: generation.optional(),
            workerLimit: workerNumber.optional(),
            profiles: profilesSchema.partial().optional(),
            architectProfile: profileSchema.nullable().optional(),
            forceDaddy: z.boolean().optional(),
            applyWorkers: z.boolean().optional(),
            autoMerge: z.boolean().optional(),
            instructions: sessionInstructionsSchema.optional(),
          })
          .strict()
          .parse(request.body),
      ),
  );
  app.post<{ Params: { id: string } }>('/api/daddy/sessions/:id/pause', async (request) =>
    daddy.pause(
      id.parse(request.params.id),
      sessionVersion.parse(request.body ?? {}).expectedGeneration,
    ),
  );
  app.post<{ Params: { id: string } }>('/api/daddy/sessions/:id/resume', async (request) =>
    daddy.resume(
      id.parse(request.params.id),
      sessionVersion.parse(request.body ?? {}).expectedGeneration,
    ),
  );
  app.post<{ Params: { id: string } }>('/api/daddy/sessions/:id/tasks', async (request, reply) => {
    const input = z
      .object({
        requirements: z.string().trim().min(1).max(20000),
        requestId: id,
        repository: repositorySelectionSchema.optional(),
        validatePlan: z.boolean().optional(),
        architectProfile: profileSchema.optional(),
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
      validatePlan: input.validatePlan,
      architectProfile: input.architectProfile,
      workspace,
    });
    return reply.code(201).send({ id: task.id });
  });
  app.post<{ Params: { id: string; number: string } }>(
    '/api/daddy/sessions/:id/workers/:number',
    async (request) => {
      const input = z
        .object({
          profile: profileSchema,
          baseline: profileSchema.optional(),
          expectedGeneration: generation.optional(),
          forceTaskId: id.optional(),
          expected: z
            .object({ groupGeneration: generation, task: expectedTask })
            .strict()
            .optional(),
        })
        .strict()
        .refine(
          (input) => !input.forceTaskId || !!input.expected,
          'Open the current worker settings before confirming a restart',
        )
        .parse(request.body);
      const { restarted } = await daddy.configureWorker(
        id.parse(request.params.id),
        workerNumber.parse(Number(request.params.number)),
        input.profile,
        {
          force: !!input.forceTaskId,
          expectedTaskId: input.forceTaskId,
          expected: input.expected,
          baseline: input.baseline,
          expectedGeneration: input.expectedGeneration,
        },
      );
      return { restarted };
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
    '/api/daddy/sessions/:id/tasks/:taskId/architect',
    (request) => {
      const { profile, expected } = z
        .object({
          profile: profileSchema.nullable(),
          expected: z
            .object({
              task: expectedTask,
              groupGeneration: generation,
              architectProfile: profileSchema.nullable(),
            })
            .strict()
            .optional(),
        })
        .strict()
        .parse(request.body);
      return daddy.taskArchitect(
        id.parse(request.params.id),
        id.parse(request.params.taskId),
        profile,
        undefined,
        expected && { ...expected, task: { ...expected.task, groupId: request.params.id } },
      );
    },
  );
  app.post<{ Params: { id: string; taskId: string } }>(
    '/api/daddy/sessions/:id/tasks/:taskId/auto-merge',
    async (request) => {
      const { mode, expected } = z
        .object({
          mode: z.enum(['on', 'off', 'inherit']),
          expected: z
            .object({
              task: expectedTask,
              groupGeneration: generation,
              mode: z.enum(['on', 'off', 'inherit']),
            })
            .strict()
            .optional(),
        })
        .strict()
        .parse(request.body);
      return daddy.taskAutoMerge(
        id.parse(request.params.id),
        id.parse(request.params.taskId),
        mode,
        expected && { ...expected, task: { ...expected.task, groupId: request.params.id } },
      );
    },
  );
  const roundLimit = z.number().int().positive().nullable();
  const expectedReviewLimit = z
    .object({ task: expectedTask, groupGeneration: generation, limit: roundLimit })
    .strict();
  app.post<{ Params: { id: string; taskId: string } }>(
    '/api/daddy/sessions/:id/tasks/:taskId/review-limit',
    (request) => {
      const { limit, expected } = z
        .object({ limit: roundLimit, expected: expectedReviewLimit })
        .strict()
        .parse(request.body);
      const groupId = id.parse(request.params.id);
      return daddy.taskReviewLimit(groupId, id.parse(request.params.taskId), limit, {
        ...expected,
        task: { ...expected.task, groupId },
      });
    },
  );
  app.post<{ Params: { id: string; taskId: string } }>(
    '/api/daddy/sessions/:id/tasks/:taskId/review-limit/resume',
    (request) => {
      const expected = expectedReviewLimit.parse(request.body);
      const groupId = id.parse(request.params.id);
      return daddy.resumeAfterReviewLimit(groupId, id.parse(request.params.taskId), {
        ...expected,
        task: { ...expected.task, groupId },
      });
    },
  );
  app.post<{ Params: { id: string } }>('/api/daddy/sessions/:id/task-action', async (request) => {
    const input = z
      .object({
        taskId: id,
        action: z.enum(['approve-plan', 'waive-checks', 'verify-merge']),
        reason: z.string().trim().max(checkWaiverReasonLimit).optional(),
        expectedHead: z.string().max(128),
        expectedRevision: z
          .object({
            head: z.string(),
            base: z.string(),
            start: z.string(),
            revisionId: z.string().optional(),
          })
          .strict(),
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
      revision: input.expectedRevision,
      generation: input.expectedGeneration,
      groupId: request.params.id,
    };
    return daddy.engine.action(task.id, input.action, input.reason ?? '', expected);
  });
}
