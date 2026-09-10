import { mkdirSync, readFileSync, chmodSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import https from 'node:https';
import http from 'node:http';
import { buildApp } from '../../dist/server/server/app.js';
import { TicketReader } from '../../dist/server/integrations/tickets.js';
import { Workspaces } from '../../dist/server/runtime/workspaces.js';
import { Store } from '../../dist/server/core/store.js';
import { UpdateMonitor } from '../../dist/server/core/updates.js';
import { configSchema } from '../../dist/server/ops/config.js';
import { Projects } from '../../dist/server/core/projects.js';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { writeFileSync, existsSync } from 'node:fs';
const dir = resolve('.reviewloop/e2e');
mkdirSync(dir, { recursive: true, mode: 0o700 });
const key = join(dir, 'test-key.pem'),
  cert = join(dir, 'test-cert.pem');
execFileSync(
  'openssl',
  [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-days',
    '1',
    '-subj',
    '/CN=localhost',
    '-addext',
    'subjectAltName=DNS:localhost,IP:127.0.0.1',
    '-keyout',
    key,
    '-out',
    cert,
  ],
  { stdio: 'ignore' },
);
chmodSync(key, 0o600);
const fixtureProfiles = {
  author: { engine: 'codex', model: 'gpt-5.6-sol', effort: 'max' },
  reviewer: { engine: 'codex', model: 'gpt-6-astra', effort: 'max' },
};
const reader = new TicketReader();
reader.read = async (source) => {
  const number = Number(new URL(source).pathname.split('/').at(-1));
  if (
    !source.startsWith('https://github.com/fixture/planning/issues/') ||
    !Number.isSafeInteger(number)
  )
    throw new Error('Use the browser test fixture issue');
  return {
    source: {
      kind: 'github_issue',
      key: `fixture/planning#${number}`,
      title: `Ticket fixture ${number}`,
      body: 'Preserve the session generation invariant.',
      state: 'open',
      url: source,
      fetchedAt: new Date().toISOString(),
      comments: [],
    },
    ref: {
      kind: 'ticket',
      provider: 'github',
      host: 'github.com',
      repo: 'fixture/planning',
      number,
      key: `fixture/planning#${number}`,
      url: source,
    },
  };
};
const workspaces = new Workspaces(dir);
workspaces.describeTicket = async (repoPath, ref) => ({
  repoPath,
  ref,
  repository: {
    baseHead: 'a'.repeat(40),
    baseBranch: 'main',
    cloneUrl: 'https://github.com/fixture/planning.git',
    branch: '',
  },
});
workspaces.prepareTicket = async () => dir;
const store = new Store(join(dir, 'reviewloop.sqlite'));
const projectRoot = join(dir, 'fixture-repository');
mkdirSync(join(projectRoot, 'src'), { recursive: true });
if (!existsSync(join(projectRoot, '.git'))) {
  const run = (args) => execFileSync('git', args, { cwd: projectRoot, stdio: 'ignore' });
  run(['init']);
  run(['config', 'user.name', 'Browser fixture']);
  run(['config', 'user.email', 'fixture@example.test']);
  writeFileSync(join(projectRoot, 'src', 'index.txt'), 'Fixture source\n');
  run(['add', '.']);
  run(['commit', '-m', 'fixture']);
  run(['remote', 'add', 'origin', 'https://github.com/fixture/planning.git']);
}
const projects = new Projects(store, [dir], { mounts: async () => [] });
await projects.register({ name: 'Fixture project', path: projectRoot });
workspaces.commitTicket = async () => 'b'.repeat(40);
store.setSetting('preferences', {
  locale: 'en',
  version: (store.setting('preferences')?.version ?? 0) + 1,
});
const updates = new UpdateMonitor(store, {
  probe: async (name) =>
    name === 'codex'
      ? { path: '/fixture/codex', version: '0.153.4', source: 'bundled' }
      : { source: 'missing' },
  fetcher: async () => new Response(JSON.stringify({ version: '0.153.5' })),
});
const { app } = await buildApp({
  startUpdateCheck: false,
  store,
  projects,
  updateMonitor: updates,
  ticketReader: reader,
  workspaces,
  catalogue: {
    list: async () =>
      Object.values(fixtureProfiles).map((profile) => ({
        id: profile.model,
        name: profile.model,
        efforts: ['medium', 'max'],
        defaultEffort: 'medium',
        isDefault: false,
      })),
    validate: async () => {},
    metadata: () => ({
      source: 'codex-app-server:model/list',
      executable: '/fixture/codex',
      cliVersion: '0.153.4',
      retrievedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 300000).toISOString(),
    }),
  },
  liveRuntime: {
    run: async (input) => {
      if (input.job.kind === 'implement') await delay(500);
      input.onSession(`fixture-${input.job.role}-${input.task.id}`);
      return {
        status: 'completed',
        summary: 'I have read the ticket. Discuss the requirements or start implementation.',
        checkedHead: input.task.revision.head,
      };
    },
  },
  daddyWorkspace: { prepare: async () => ({ cwd: dir, context: {} }), release: async () => {} },
  daddyRuntime: {
    runSession: async (input) => {
      input.onSession(input.threadId ?? `fixture-daddy-${randomUUID()}`);
      const context = JSON.parse(input.prompt),
        sources = [
          ...new Set(
            context.currentInstruction.match(
              /https:\/\/github\.com\/fixture\/planning\/issues\/\d+/g,
            ) ?? [],
          ),
        ];
      let index = 0;
      for (const source of sources) {
        const result = await input.onTool('import_ticket', { source }, `import-${index}`);
        const task = store.getTask(result.taskId);
        task.policy.autoPush = false;
        store.saveTask(task);
        if (task.state === 'discussing' && !store.busy(task.id))
          await input.onTool('dispatch', { taskId: task.id }, `dispatch-${index}`);
        index++;
      }
      return {
        status: 'completed',
        summary: sources.length
          ? `I added ${sources.length} ticket(s) to this session and assigned the work. Your writers share one Daddy.`
          : 'I have checked the current task board. The work and conversation remain in this session.',
        checkedHead: '',
      };
    },
  },
  dataDir: dir,
  demo: true,
  config: configSchema.parse({ publicOrigin: 'https://localhost:4319', agents: fixtureProfiles }),
});
await app.listen({ host: '127.0.0.1', port: 4318 });
const proxy = https.createServer(
  { key: readFileSync(key), cert: readFileSync(cert) },
  (req, res) => {
    const upstream = http.request(
      {
        hostname: '127.0.0.1',
        port: 4318,
        path: req.url,
        method: req.method,
        headers: req.headers,
      },
      (reply) => {
        res.writeHead(reply.statusCode ?? 502, reply.headers);
        reply.pipe(res);
      },
    );
    upstream.on('error', () => {
      res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
    res.on('close', () => upstream.destroy());
  },
);
await new Promise((resolve) => proxy.listen(4319, '127.0.0.1', resolve));
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  proxy.closeAllConnections();
  await new Promise((resolve) => proxy.close(resolve));
  await app.close();
  store.close();
  process.exit(0);
}
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
