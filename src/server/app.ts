import { ModuleUsage } from '../modules/agents/usage.js';
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
import { type ReviewProvider } from '../providers/provider.js';
import { Workspaces } from '../runtime/workspaces.js';
import { Worker } from '../runtime/worker.js';
import { AgentRegistry } from '../modules/agents/registry.js';
import { createAgents } from '../modules/agents/index.js';
import { RepositoryRegistry } from '../modules/repositories/registry.js';
import { repositoryModules } from '../modules/repositories/index.js';
import { moduleCatalogue } from '../modules/catalogue.js';
import { DemoRuntime } from '../runtime/demo.js';
import { loadConfig, saveConfig, validateServerUrl, type Config } from '../ops/config.js';
import { Access, allowedRequest } from './access.js';
import { VERSION } from '../version.js';
import { Telegram, connectTelegram } from '../integrations/telegram.js';
import { homedir } from 'node:os';
import { CacheManager } from '../ops/cache.js';
import { TicketWorkflow } from '../core/ticket-workflow.js';
import { TicketReader } from '../modules/repositories/tickets.js';
import { registerPlanning, type Catalogue } from './planning.js';
import { registerInstructions } from './instructions.js';
import type { AgentRuntime } from '../runtime/agent.js';
import { randomUUID } from 'node:crypto';
import { preferences, preferenceInput, setLocale } from '../core/preferences.js';
import { UpdateMonitor } from '../core/updates.js';
import { CodexUpdater } from '../core/codex-updater.js';
import { moduleExecutable } from '../runtime/executable.js';
import { WorkspaceRegistry } from '../core/workspace-registry.js';
import { Daddy } from '../core/daddy.js';
import { registerDaddy } from './daddy.js';
import type { SessionRuntime } from '../runtime/agent.js';
import type { DaddyWorkspace } from '../runtime/daddy-workspace.js';
import type { UsageBackend } from '../core/usage.js';
import { registerUsage } from './usage.js';
import { LocalSpeech, type Speech } from '../runtime/speech.js';

export interface ServerOptions {
  agents?: AgentRegistry;
  repositories?: RepositoryRegistry;
  speech?: Speech;
  usage?: UsageBackend;
  workspaces?: WorkspaceRegistry;
  daddyRuntime?: SessionRuntime;
  daddyWorkspace?: Pick<DaddyWorkspace, 'prepare' | 'release'>;
  codexUpdater?: CodexUpdater;
  updateMonitor?: UpdateMonitor;
  startUpdateCheck?: boolean;
  catalogue?: Catalogue;
  ticketReader?: TicketReader;
  checkouts?: Workspaces;
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
  const store = options.store ?? new Store(join(dataDir, 'daddyloop.sqlite'));
  const repositories =
    options.repositories ??
    new RepositoryRegistry(
      repositoryModules().filter((module) => config.modules.includes(module.id)),
    );
  const engine = new Engine(
    store,
    options.provider ?? providers(store, repositories),
    config.agents,
  );
  if (!store.setting('preferences'))
    store.setSetting('preferences', { locale: config.locale, version: 0 });
  if (!store.setting('server.instanceId')) store.setSetting('server.instanceId', randomUUID());
  const cache = new CacheManager(engine, dataDir, config.cache);
  const checkouts = options.checkouts ?? new Workspaces(dataDir);
  let configuredExecutable = config.executables.codex;
  const executable = () =>
    moduleExecutable('codex', {
      executables: {
        ...config.executables,
        ...(configuredExecutable ? { codex: configuredExecutable } : {}),
      },
    });
  const agents =
    options.agents ??
    createAgents(config.modules, {
      store,
      dataDir,
      executable: (id) => (id === 'codex' ? executable : () => moduleExecutable(id, config)),
    });
  const catalogue = options.catalogue ?? agents;
  const updates =
    options.updateMonitor ??
    new UpdateMonitor(store, {
      enabled: config.modules.filter((id) => agents.engines().some((engine) => engine.id === id)),
      codex: executable,
      claude: moduleExecutable('claude', config),
      intervalHours: config.updates.intervalHours,
      managedRoot: join(dataDir, 'runtimes/codex'),
    });
  const tickets = new TicketWorkflow(
    engine,
    checkouts,
    options.ticketReader,
    undefined,
    repositories,
  );
  const getResources =
    options.resourceCheck ??
    (() =>
      resources(dataDir, {
        minDiskGiB: options.minDiskGiB ?? config.resources.minDiskGiB,
        maxDiskPercent: options.maxDiskPercent ?? config.resources.maxDiskPercent,
        minMemoryGiB: options.minMemoryGiB ?? config.resources.minMemoryGiB,
      }));
  const updater =
    options.codexUpdater ??
    new CodexUpdater(store, {
      dataDir,
      executable,
      enabled: config.modules.includes('codex') && !process.env.DADDYLOOP_CODEX_BIN,
      resourceCheck: () => {
        const status = getResources();
        if (!status.ok || status.diskAvailableGiB < 2)
          throw new AppError(
            'update_resources',
            status.reasons.join('; ') || 'Not enough disk space for a Codex update',
            422,
          );
      },
      activate: (expected, next) => {
        const current = loadConfig();
        if (executable() !== expected || current.executables.codex !== configuredExecutable)
          throw new Error('Codex configuration changed during the update');
        current.executables.codex = next;
        saveConfig(current);
        configuredExecutable = next;
      },
      validateModels: (models) => {
        const profiles = [
          engine.defaultAgents(),
          ...store
            .groups()
            .filter((group) => group.orchestrated)
            .map((group) => ({
              daddy: group.daddy,
              worker: group.worker ?? engine.defaultAgents().worker,
            })),
          ...store
            .tasks()
            .filter((task) => task.state !== 'complete')
            .map((task) => engine.effectiveAgents(task)),
        ];
        for (const profile of profiles.flatMap((pair) => [pair.worker, pair.daddy])) {
          if (profile.engine !== 'codex' || !profile.model) continue;
          const model = models.find((model) => model.id === profile.model);
          if (!model || (profile.effort && !model.efforts.includes(profile.effort)))
            throw new Error(
              `The new Codex catalogue does not support the saved profile ${profile.model} / ${profile.effort ?? 'default'}`,
            );
        }
      },
    });
  const checkUpdates =
    options.startWorker !== false &&
    options.startUpdateCheck !== false &&
    config.updates.enabled &&
    config.modules.includes('codex');
  const refreshRuntime = (event: Event) => {
    if (event.type === 'runtime.update_finished' && checkUpdates)
      void updates.check(true).catch(() => {});
  };
  store.changes.on('event', refreshRuntime);
  await updater.recover();
  const worker = new Worker(
    engine,
    checkouts,
    options.liveRuntime ?? agents,
    new DemoRuntime(),
    getResources,
    15000,
    config.maxConcurrentAgents,
  );
  worker.autoSubmit = (id) => tickets.submit(id);
  const workspaces =
    options.workspaces ??
    new WorkspaceRegistry(store, config.workspaces.roots, undefined, repositories);
  checkouts.protectSources(() =>
    [
      ...workspaces.list(),
      ...store.groups().flatMap((group) => (group.workspace ? [group.workspace] : [])),
      ...store.daddyJobs().flatMap((job) => (job.workspace ? [job.workspace] : [])),
    ]
      .filter((workspace) => workspace.vcs === 'arcadia')
      .map((workspace) => workspace.repoPath)
      .concat(
        store
          .tasks()
          .filter((task) => task.ref.provider === 'arcadia')
          .map((task) => task.repoPath),
      ),
  );
  const daddy = new Daddy(
    engine,
    workspaces,
    tickets,
    worker,
    options.daddyRuntime ?? agents,
    getResources,
    catalogue,
    options.daddyWorkspace,
  );
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
    const supplied = bearer ?? request.cookies.daddyloop_session ?? '';
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
      request.headers['x-daddyloop-request'] !== '1'
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
  app.get('/api/modules', async () =>
    moduleCatalogue.map((module) => ({ ...module, enabled: config.modules.includes(module.id) })),
  );
  app.get('/api/health', async () => ({ ok: true, version: VERSION, pid: process.pid }));
  registerDaddy(app, daddy);
  const usage = options.usage ?? new ModuleUsage(agents, store);
  registerUsage(app, usage);
  app.post('/api/session', async (request, reply) => {
    const input = z
      .object({ token: z.string().min(1).max(256) })
      .strict()
      .parse(request.body);
    if (!safeEqual(input.token, token))
      throw new AppError('unauthorized', 'Incorrect access token', 401);
    const device = access.createDevice('Browser');
    reply.setCookie('daddyloop_session', device.token, {
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
    reply.setCookie('daddyloop_session', device.token, {
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
        'Configure a permanent HTTPS address with daddy web before pairing your phone',
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
      const result = await checkouts.releaseArc(task, role);
      store.saveTask(task);
      store.event(task.id, 'arcadia.lease_released', result);
      return result;
    });
  });
  app.post('/api/telegram/pair', async () => {
    if (!telegram) {
      if (config.telegram.enabled)
        throw new AppError(
          'telegram_connecting',
          `${store.setting<string>('telegram.error') ?? 'Telegram is connecting.'} Configuration is saved; run daddy telegram status, then daddy telegram pair when connected.`,
          503,
        );
      throw new AppError('telegram_not_configured', 'Run daddy telegram setup first', 422);
    }
    return telegram.pair();
  });
  app.post('/api/telegram/unpair', async () => {
    if (!telegram)
      throw new AppError('telegram_not_configured', 'Run daddy telegram setup first', 422);
    return telegram.unpair();
  });
  app.post<{ Params: { id: string } }>('/api/devices/:id/revoke', async (request) => {
    access.revoke(request.params.id);
    return { revoked: true };
  });
  app.get('/api/status', async () => {
    const connection = (name: 'github' | 'gitlab') => {
      const host = process.env[`DADDYLOOP_${name.toUpperCase()}_HOST`] ?? `${name}.com`;
      try {
        return { host, configured: !!credential(name, host) };
      } catch {
        return { host, configured: false };
      }
    };
    return {
      version: VERSION,
      application: 'daddyloop',
      preferences: preferences(store),
      instanceId: store.setting('server.instanceId'),
      runtime: {
        source: process.env.DADDYLOOP_CODEX_BIN
          ? 'environment'
          : configuredExecutable
            ? 'configuration'
            : 'path',
        executable: executable(),
      },
      updates: updates.status(),
      codexUpdater: updater.status(),
      queuedJobs:
        store.jobs().filter((job) => job.status === 'queued').length +
        store.daddyJobs().filter((job) => job.status === 'queued').length,
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
      activeJobs:
        store.jobs().filter((j) => j.status === 'running').length +
        store.daddyJobs().filter((job) => job.status === 'running').length,
    };
  });
  app.get('/api/tasks', async () => store.tasks());
  app.get('/api/preferences', async () => preferences(store));
  app.post('/api/preferences', async (request) =>
    setLocale(store, preferenceInput.parse(request.body).locale),
  );
  app.get('/api/updates', async () => updates.status());
  app.get('/api/runtime/update', async () => updater.status());
  app.post('/api/runtime/update/prepare', async (request) => {
    const { action } = z
      .object({ action: z.enum(['install', 'rollback']) })
      .strict()
      .parse(request.body);
    return updater.prepare(action, 'api');
  });
  app.post('/api/runtime/update/confirm', async (request, reply) => {
    const { id } = z
      .object({ id: z.string().regex(/^[A-Za-z0-9_-]{24}$/) })
      .strict()
      .parse(request.body);
    const result = updater.confirm(id, 'api');
    return reply.code(202).send(result);
  });
  app.post('/api/updates/check', async () => updates.check(true));
  app.post('/api/updates/notifications', async (request) => {
    const { enabled } = z.object({ enabled: z.boolean() }).strict().parse(request.body);
    store.setSetting('updates.notifications', enabled);
    return updates.status();
  });
  registerPlanning(app, engine, catalogue, config.maxConcurrentAgents);
  registerInstructions(app);
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
              worker: engine.effectiveAgents(task).worker,
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
    await daddy.stop();
    store.changes.off('event', refreshRuntime);
    await updater.stop();
    await updates.stop();
    for (const stop of eventStreams) stop();
    await worker.stop();
    telegramController.abort();
    await telegramStartup;
    await telegram?.stop();
  });
  app.addHook('onReady', async () => {
    if (checkUpdates) {
      updates.start();
      const finishedAt = updater.status().operation?.finishedAt;
      if (finishedAt && finishedAt > (updates.status().checkedAt ?? ''))
        void updates.check(true).catch(() => {});
    }
    if (options.startWorker !== false && config.telegram.enabled) {
      telegramStartup = connectTelegram(
        () =>
          (options.telegramFactory ?? Telegram.create)(
            engine,
            config.telegram.tokenFile ?? join(homedir(), '.tokens/daddyloop-telegram'),
            publicOrigin,
            telegramController.signal,
          ),
        telegramController.signal,
        (error) => store.setSetting('telegram.error', redact(String(error))),
      )
        .then((instance) => {
          if (!instance || telegramController.signal.aborted) return;
          telegram = instance;
          telegram.configure({
            catalogue,
            updates,
            updater,
            daddy,
            usage,
            voice: {
              dataDir,
              speech: options.speech ?? new LocalSpeech(dataDir),
              resources: getResources,
            },
          });
          store.setSetting('telegram.error', null);
          telegram.start();
        })
        .catch((error) => {
          if (!telegramController.signal.aborted)
            store.setSetting('telegram.error', redact(String(error)));
        });
    }
  });
  if (options.startWorker !== false) {
    worker.start();
    daddy.start();
  }
  return { app, engine, worker, store, daddy, workspaces };
}
