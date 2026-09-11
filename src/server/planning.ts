import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Engine } from '../core/engine.js';
import { ModelCatalogue, profileSchema, profilesSchema } from '../core/agents.js';
import { type AgentProfiles } from '../core/types.js';
import { notificationPreferences, notificationsSchema } from '../integrations/notifications.js';
import { redact } from '../core/security.js';
export type Catalogue = Pick<ModelCatalogue, 'list' | 'validate'> &
  Partial<Pick<ModelCatalogue, 'metadata'>>;
export function registerPlanning(
  app: FastifyInstance,
  engine: Engine,
  catalogue: Catalogue,
  maxAgents: number,
) {
  const validate = async (profiles?: AgentProfiles) => {
    if (profiles)
      await Promise.all([catalogue.validate(profiles.writer), catalogue.validate(profiles.daddy)]);
  };
  app.get<{ Querystring: { refresh?: string } }>('/api/agents', async (request) => {
    let models: Awaited<ReturnType<Catalogue['list']>> = [],
      error: string | undefined;
    try {
      models = await catalogue.list(request.query.refresh === '1');
    } catch (value) {
      error = redact(String(value));
    }
    return {
      defaults: engine.defaultAgents(),
      models,
      error,
      maxConcurrentAgents: engine.store.setting<number>('worker.maxAgents') ?? maxAgents,
      engines: ['codex'],
      catalogue: catalogue.metadata?.(),
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
    const role = z.enum(['writer', 'daddy']).parse(request.params.role),
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
}
