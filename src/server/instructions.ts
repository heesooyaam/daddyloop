import type { FastifyInstance } from 'fastify';
import { instructionSourceSchema, InstructionSources } from '../ops/instruction-sources.js';
import { sessionInstructionsSchema } from '../core/instructions.js';

export function registerInstructions(app: FastifyInstance, sources = new InstructionSources()) {
  app.post('/api/instructions/validate', async (request) =>
    sessionInstructionsSchema.parse(request.body),
  );
  app.post('/api/instructions/import', async (request) =>
    sources.import(instructionSourceSchema.parse(request.body)),
  );
}
