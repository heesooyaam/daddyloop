import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import serveStatic from '@fastify/static';
import { z } from 'zod';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../core/store.js';
import { Engine } from '../core/engine.js';
import { AppError, type Event, type ResourceStatus, type PRRef } from '../core/types.js';
import { accessToken, credential, redact, safeEqual } from '../core/security.js';
import { resources } from '../core/resources.js';
import { providers } from '../providers/index.js';
import { parsePR, type ReviewProvider } from '../providers/provider.js';
import { Workspaces } from '../runtime/workspaces.js';
import { Worker } from '../runtime/worker.js';
import { CodexRuntime } from '../runtime/codex.js';
import { DemoRuntime } from '../runtime/demo.js';
import { loadConfig, validateServerUrl, type Config } from '../ops/config.js';
import { Access, allowedRequest } from './access.js';
import { VERSION } from '../version.js';
import { Telegram } from '../integrations/telegram.js';
import { homedir } from 'node:os';
import { CacheManager } from '../ops/cache.js';
import { ModelCatalogue, profilesSchema } from '../core/agents.js';
import { TicketWorkflow } from '../core/ticket-workflow.js';
import { TicketReader } from '../integrations/tickets.js';
import { registerPlanning, type Catalogue } from './planning.js';
import type { AgentRuntime } from '../runtime/agent.js';

const policySchema = z
  .object({
    publication: z.enum(['human', 'auto']).optional(),
    planApproval: z.enum(['human', 'auto']).optional(),
    maxRounds: z.number().int().min(1).max(20).optional(),
    maxNoProgress: z.number().int().min(1).max(10).optional(),
    requireChecks: z.boolean().optional(),
    autoPush: z.boolean().optional(),
  })
  .strict();
const createSchema = z
  .object({
    url: z.string().url(),
    provider: z.enum(['github', 'gitlab', 'arcadia']).optional(),
    repoPath: z.string().min(1),
    requirements: z.string().trim().min(1).max(100000),
    title: z.string().max(200).optional(),
    kind: z.enum(['plan', 'code']).default('code'),
    policy: policySchema.optional(),
    planTaskId: z.string().uuid().optional(),
    authorThreadId: z.string().max(200).optional(),
    agents: profilesSchema.optional(),
    groupId: z.string().uuid().optional(),
  })
  .strict();
export interface ServerOptions {
  catalogue?: Catalogue;
  ticketReader?: TicketReader;
  workspaces?: Workspaces;
  liveRuntime?: AgentRuntime;
  config?: Config;
  telegramFactory?: typeof Telegram.create;
  publicOrigin?: string;
  dataDir: string;
  demo?: boolean;
  startWorker?: boolean;
  token?: string;
  store?: Store;
  provider?: (ref: PRRef) => ReviewProvider;
  resourceCheck?: () => ResourceStatus;
  minDiskGiB?: number;
  maxDiskPercent?: number;
  minMemoryGiB?: number;
}
export async function buildApp(options: ServerOptions) {
  const config = options.config ?? loadConfig();
  const publicOrigin = options.publicOrigin ?? config.publicOrigin;
  if (publicOrigin) validateServerUrl(publicOrigin, true);
  const dataDir = resolve(options.dataDir);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const store = options.store ?? new Store(join(dataDir, 'reviewloop.sqlite'));
  const engine = new Engine(store, options.provider ?? providers(store), config.agents);
  const cache = new CacheManager(engine, dataDir, config.cache);
  const workspaces = options.workspaces ?? new Workspaces(dataDir);
  const catalogue = options.catalogue ?? new ModelCatalogue(process.env.REVIEWLOOP_CODEX_BIN);
  const tickets = new TicketWorkflow(engine, workspaces, options.ticketReader);
  const getResources =
    options.resourceCheck ??
    (() =>
      resources(dataDir, {
        minDiskGiB: options.minDiskGiB ?? config.resources.minDiskGiB,
        maxDiskPercent: options.maxDiskPercent ?? config.resources.maxDiskPercent,
        minMemoryGiB: options.minMemoryGiB ?? config.resources.minMemoryGiB,
      }));
  const worker = new Worker(
    engine,
    workspaces,
    options.liveRuntime ??
      new CodexRuntime({
        executable: process.env.REVIEWLOOP_CODEX_BIN,
        model: process.env.REVIEWLOOP_CODEX_MODEL,
      }),
    new DemoRuntime(),
    getResources,
    15000,
    config.maxConcurrentAgents,
  );
  worker.autoSubmit = (id) => tickets.submit(id);
  if (config.cache.auto) worker.autoCleanup = () => cache.prune(true);
  const token = options.token ?? accessToken(dataDir);
  const access = new Access(store, token);
  let telegram: Telegram | undefined;
  const telegramController = new AbortController();
  let telegramStartup: Promise<void> = Promise.resolve();
  const app = Fastify({
    logger: false,
    bodyLimit: 200000,
    requestTimeout: 60000,
  });
  await app.register(cookie);
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError)
      return reply.code(400).send({
        error: {
          code: 'validation_error',
          message: error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        },
      });
    const known = error instanceof AppError;
    return reply.code(known ? error.statusCode : 500).send({
      error: {
        code: known ? error.code : 'internal_error',
        message: redact(known ? error.message : String(error)),
      },
    });
  });
  app.addHook('onRequest', async (request, reply) => {
    const origin = request.headers.origin;
    if (!allowedRequest(request.headers.host, origin, publicOrigin))
      return reply.code(403).send({
        error: {
          code: 'origin_rejected',
          message: 'Cross-origin control requests are disabled',
        },
      });
    if (
      !request.url.startsWith('/api/') ||
      request.url === '/api/health' ||
      request.url === '/api/session' ||
      request.url === '/api/session/pair'
    )
      return;
    const bearer = request.headers.authorization?.replace(/^Bearer /i, '');
    const supplied = bearer ?? request.cookies.reviewloop_session ?? '';
    if (!access.validate(supplied))
      return reply.code(401).send({
        error: {
          code: 'unauthorized',
          message: 'Enter your local access token to connect',
        },
      });
    if (
      !['GET', 'HEAD'].includes(request.method) &&
      !bearer &&
      request.headers['x-reviewloop-request'] !== '1'
    )
      return reply.code(403).send({
        error: {
          code: 'csrf_rejected',
          message: 'Missing control request header',
        },
      });
  });
  app.addHook('onSend', async (_request, reply, payload) => {
    reply
      .header('X-Content-Type-Options', 'nosniff')
      .header('Referrer-Policy', 'no-referrer')
      .header('X-Frame-Options', 'DENY');
    reply.header(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    );
    if (_request.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
    return payload;
  });
  app.get('/api/health', async () => ({ ok: true, version: VERSION, pid: process.pid }));
  app.post('/api/session', async (request, reply) => {
    const input = z
      .object({ token: z.string().min(1).max(256) })
      .strict()
      .parse(request.body);
    if (!safeEqual(input.token, token))
      throw new AppError('unauthorized', 'Incorrect access token', 401);
    const device = access.createDevice('Browser');
    reply.setCookie('reviewloop_session', device.token, {
      httpOnly: true,
      sameSite: 'strict',
      path: '/',
      maxAge: 90 * 86400,
      secure:
        !!publicOrigin &&
        (request.headers.origin === publicOrigin ||
          request.headers.host === new URL(publicOrigin).host),
    });
    return { ok: true };
  });
  app.post('/api/session/pair', async (request, reply) => {
    const { code } = z
      .object({ code: z.string().min(20).max(100) })
      .strict()
      .parse(request.body);
    const device = access.consume(code);
    reply.setCookie('reviewloop_session', device.token, {
      httpOnly: true,
      sameSite: 'strict',
      path: '/',
      maxAge: 90 * 86400,
      secure: !!publicOrigin,
    });
    return { ok: true, deviceId: device.id };
  });
  app.post('/api/pairings', async (request) => {
    const { name } = z
      .object({
        name: z.string().min(1).max(80).default('Device'),
        kind: z.literal('web').default('web'),
      })
      .strict()
      .parse(request.body);
    if (!publicOrigin)
      throw new AppError(
        'public_origin_required',
        'Configure a permanent HTTPS address with reviewctl web before pairing your phone',
        422,
      );
    return access.pairing(name, publicOrigin);
  });
  app.get('/api/devices', async () => access.devices());
  app.get('/api/cache', async () => cache.prune(false));
  app.post('/api/cache/prune', async (request) => {
    const { apply } = z
      .object({ apply: z.boolean().default(false) })
      .strict()
      .parse(request.body);
    return cache.prune(apply);
  });
  app.post<{ Params: { id: string } }>('/api/tasks/:id/arcadia/release', async (request) => {
    const { role } = z
      .object({ role: z.enum(['author', 'reviewer']) })
      .strict()
      .parse(request.body);
    return engine.lock(request.params.id, async () => {
      const task = store.getTask(request.params.id);
      if (task.state !== 'complete' || store.busy(task.id))
        throw new AppError('task_active', 'Finish the task before releasing its workspace');
      const result = await workspaces.releaseArc(task, role);
      store.saveTask(task);
      store.event(task.id, 'arcadia.lease_released', result);
      return result;
    });
  });
  app.post('/api/telegram/pair', async () => {
    if (!telegram)
      throw new AppError('telegram_not_configured', 'Run reviewctl telegram setup first', 422);
    return telegram.pair();
  });
  app.post('/api/telegram/unpair', async () => {
    if (!telegram)
      throw new AppError('telegram_not_configured', 'Run reviewctl telegram setup first', 422);
    return telegram.unpair();
  });
  app.post<{ Params: { id: string } }>('/api/devices/:id/revoke', async (request) => {
    access.revoke(request.params.id);
    return { revoked: true };
  });
  app.get('/api/status', async () => {
    const connection = (name: 'github' | 'gitlab') => {
      const host = process.env[`REVIEWLOOP_${name.toUpperCase()}_HOST`] ?? `${name}.com`;
      try {
        return { host, configured: !!credential(name, host) };
      } catch {
        return { host, configured: false };
      }
    };
    return {
      version: VERSION,
      publicOrigin: publicOrigin ?? null,
      telegram: telegram?.status() ?? {
        configured: false,
        error: store.setting('telegram.error') ?? null,
      },
      demoEnabled: !!options.demo,
      resources: getResources(),
      connections: {
        github: connection('github'),
        gitlab: connection('gitlab'),
      },
      activeJobs: store.jobs().filter((j) => j.status === 'running').length,
    };
  });
  app.get('/api/tasks', async () => store.tasks());
  registerPlanning(app, engine, tickets, catalogue, config.maxConcurrentAgents);
  app.post('/api/tasks', async (request, reply) => {
    const input = createSchema.parse(request.body);
    if (input.agents)
      await Promise.all([
        catalogue.validate(input.agents.author),
        catalogue.validate(input.agents.reviewer),
      ]);
    const ref = parsePR(input.url, input.provider);
    const repoPath = await workspaces.validate(input.repoPath, ref.provider);
    const task = await engine.create({
      ...input,
      repoPath,
      ref,
    });
    reply.code(201);
    return task;
  });
  app.post('/api/demo', async (_request, reply) => {
    if (!options.demo)
      throw new AppError('demo_disabled', 'Start with --demo to enable demo fixtures', 404);
    const number = store.tasks().filter((t) => t.ref.provider === 'demo').length + 1;
    const task = await engine.create({
      ref: {
        provider: 'demo',
        host: 'demo.local',
        repo: 'acme/session-service',
        number,
        url: `https://demo.local/pull/${number}`,
      },
      requirements:
        'Prevent callbacks from an old session from changing the current session. Preserve the single event loop design and cover replacement in a regression test.',
      repoPath: dataDir,
      title: 'Guard against stale session callbacks',
      policy: { publication: 'human' },
    });
    reply.code(201);
    return task;
  });
  app.get<{ Params: { id: string } }>('/api/tasks/:id', async (request) => {
    const id = request.params.id;
    const recent = store.db
      .prepare('SELECT id FROM events WHERE task_id=? ORDER BY id DESC LIMIT 1 OFFSET 499')
      .get(id);
    return {
      task: store.getTask(id),
      agents: engine.effectiveAgents(store.getTask(id)),
      group: store.getTask(id).groupId ? store.getGroup(store.getTask(id).groupId!) : undefined,
      siblings: store.getTask(id).groupId
        ? store
            .tasks()
            .filter((task) => task.groupId === store.getTask(id).groupId)
            .map((task) => ({
              id: task.id,
              title: task.title,
              state: task.state,
              parentTaskId: task.parentTaskId,
              author: engine.effectiveAgents(task).author,
            }))
        : [],
      messages: store.messages(id),
      events: store.events(id, recent ? Number(recent.id) - 1 : 0),
      jobs: store.jobs(id),
      decisions: store.decisions(id),
    };
  });
  app.get<{ Params: { id: string }; Querystring: { after?: string } }>(
    '/api/tasks/:id/events',
    async (request) => {
      store.getTask(request.params.id);
      const after = z.coerce.number().int().nonnegative().default(0).parse(request.query.after);
      return store.events(request.params.id, after);
    },
  );
  app.post<{ Params: { id: string } }>('/api/tasks/:id/actions', async (request) => {
    const { action, reason } = z
      .object({
        action: z.enum([
          'review',
          'retry',
          'reconcile',
          'publish',
          'pause',
          'resume',
          'approve-plan',
          'waive-checks',
          'reopen',
          'implement',
          'submit',
        ]),
        reason: z.string().max(10000).default(''),
      })
      .strict()
      .parse(request.body);
    const id = request.params.id;
    if (action === 'implement') return engine.implement(id);
    if (action === 'submit') return tickets.submit(id);
    if (action === 'retry' && store.getTask(id).ref.kind === 'ticket')
      return store.getTask(id).resumeState === 'submitting'
        ? tickets.submit(id)
        : engine.retryTicket(id);
    if (action === 'review' || action === 'retry') return engine.review(id, action === 'retry');
    if (action === 'reconcile') return engine.reconcile(id);
    if (action === 'publish') return engine.publish(id);
    return engine.action(id, action, reason);
  });
  app.post<{ Params: { id: string } }>('/api/tasks/:id/messages', async (request) => {
    const { role, text } = z
      .object({
        role: z.enum(['author', 'reviewer']),
        text: z.string().trim().min(1).max(60000),
      })
      .strict()
      .parse(request.body);
    return engine.chat(request.params.id, role, text);
  });
  app.post<{ Params: { id: string } }>('/api/tasks/:id/policy', async (request) => {
    const { policy } = z.object({ policy: policySchema }).strict().parse(request.body);
    return engine.lock(request.params.id, async () => {
      const task = store.getTask(request.params.id);
      if (store.busy(task.id))
        throw new AppError(
          'task_busy',
          'Wait for the active session or pause before changing its permissions',
        );
      const previous = task.policy;
      task.policy = { ...previous, ...policy };
      store.saveTask(task);
      store.event(task.id, 'human.policy_changed', {
        previous,
        current: task.policy,
      });
      return task;
    });
  });
  const eventStreams = new Set<() => void>();
  app.get('/api/events', async (request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    reply.raw.write(': connected\n\n');
    const listener = (event: Event) => {
      if (reply.raw.writableLength > 1024 * 1024) {
        reply.raw.end();
        return;
      }
      if (!reply.raw.destroyed)
        reply.raw.write(
          `id: ${event.id}\ndata: ${JSON.stringify({ id: event.id, taskId: event.taskId, type: event.type })}\n\n`,
        );
    };
    store.changes.on('event', listener);
    const heartbeat = setInterval(() => {
      if (!reply.raw.destroyed) reply.raw.write(': heartbeat\n\n');
    }, 15000);
    const cleanup = () => {
      clearInterval(heartbeat);
      store.changes.off('event', listener);
      eventStreams.delete(stop);
    };
    const stop = () => {
      cleanup();
      reply.raw.end();
    };
    eventStreams.add(stop);
    request.raw.on('close', cleanup);
    reply.raw.on('close', cleanup);
  });
  const ui = resolve(fileURLToPath(new URL('../../dist/ui', import.meta.url)));
  // In the compiled layout, this module is dist/server/server/app.js.
  const builtUi = existsSync(ui)
    ? ui
    : resolve(fileURLToPath(new URL('../../ui', import.meta.url)));
  if (existsSync(join(builtUi, 'index.html'))) {
    await app.register(serveStatic, { root: builtUi, prefix: '/' });
    app.setNotFoundHandler((request, reply) =>
      request.url.startsWith('/api/')
        ? reply.code(404).send({
            error: { code: 'not_found', message: 'Endpoint not found' },
          })
        : reply.sendFile('index.html'),
    );
  } else
    app.get('/', async (_request, reply) =>
      reply
        .type('text/plain')
        .send('Build the web panel with npm run build, then restart the service.'),
    );
  app.addHook('onClose', async () => {
    await worker.stop();
    if (!options.store) store.close();
  });
  app.addHook('preClose', async () => {
    for (const stop of eventStreams) stop();
    await worker.stop();
    telegramController.abort();
    await telegramStartup;
    await telegram?.stop();
  });
  app.addHook('onReady', async () => {
    if (options.startWorker !== false && config.telegram.enabled) {
      telegramStartup = (options.telegramFactory ?? Telegram.create)(
        engine,
        config.telegram.tokenFile ?? join(homedir(), '.tokens/reviewloop-telegram'),
        publicOrigin,
        telegramController.signal,
      )
        .then((instance) => {
          if (telegramController.signal.aborted) return;
          telegram = instance;
          store.setSetting('telegram.error', null);
          telegram.start();
        })
        .catch((error) => {
          if (!telegramController.signal.aborted)
            store.setSetting('telegram.error', redact(String(error)));
        });
    }
  });
  if (options.startWorker !== false) worker.start();
  return { app, engine, worker, store };
}
