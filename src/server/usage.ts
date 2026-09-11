import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { UsageBackend } from '../core/usage.js';
export function registerUsage(app: FastifyInstance, usage: UsageBackend) {
  app.get<{ Querystring: { refresh?: string } }>('/api/usage', async (request) =>
    usage.read(request.query.refresh === '1'),
  );
  app.post('/api/usage/reset/prepare', async (request) => {
    const input = z
      .object({ engine: z.string().optional() })
      .strict()
      .parse(request.body ?? {});
    return usage.prepare('api', input.engine);
  });
  app.post<{ Params: { id: string } }>('/api/usage/reset/:id', async (request) => {
    z.object({ confirmed: z.literal(true) })
      .strict()
      .parse(request.body);
    return usage.consume(z.string().uuid().parse(request.params.id), 'api');
  });
}
