import type { FastifyInstance } from 'fastify';
import { instructionSourceSchema, InstructionSources } from '../ops/instruction-sources.js';
import { sessionInstructionsSchema, flattenInstructions } from '../core/instructions.js';
import { InstructionPresets, presetInputSchema } from '../core/instruction-presets.js';
import type { Store } from '../core/store.js';
import { z } from 'zod';

export function registerInstructions(
  app: FastifyInstance,
  store: Store,
  sources = new InstructionSources(),
) {
  const presets = new InstructionPresets(store),
    prefix = '/api/instructions/presets';
  app.get(prefix, async () => presets.list());
  app.get<{ Params: { id: string } }>(prefix + '/:id', async (request) =>
    presets.get(z.string().uuid().parse(request.params.id)),
  );
  app.post(prefix, { bodyLimit: 1048576 }, async (request, reply) =>
    reply.code(201).send(presets.save(presetInputSchema.parse(request.body))),
  );
  app.post<{ Params: { id: string } }>(prefix + '/:id', { bodyLimit: 1048576 }, async (request) =>
    presets.save(presetInputSchema.parse(request.body), z.string().uuid().parse(request.params.id)),
  );
  app.post<{ Params: { id: string } }>(prefix + '/:id/delete', async (request) => {
    const input = z
      .object({ expectedRevision: z.number().int().positive() })
      .strict()
      .parse(request.body);
    return presets.remove(z.string().uuid().parse(request.params.id), input.expectedRevision);
  });
  app.post<{ Querystring: { flatten?: string } }>(
    '/api/instructions/validate',
    { bodyLimit: 1048576 },
    async (request) => {
      const instructions = sessionInstructionsSchema.parse(request.body);
      return request.query.flatten === '1' ? flattenInstructions(instructions) : instructions;
    },
  );
  app.post('/api/instructions/import', async (request) =>
    sources.import(instructionSourceSchema.parse(request.body)),
  );
}
