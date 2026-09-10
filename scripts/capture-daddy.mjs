// Actual application and terminal render, with clearly illustrative offline fixture data.
import { chromium, expect } from '@playwright/test';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { buildApp } from '../dist/server/server/app.js';
import { usageFixture } from '../tests/e2e/usage-fixture.mjs';
import { configSchema } from '../dist/server/ops/config.js';
import { Store } from '../dist/server/core/store.js';
import { Projects } from '../dist/server/core/projects.js';
const root = resolve(import.meta.dirname, '..'),
  output = join(root, 'docs/media');
mkdirSync(output, { recursive: true });
const base = join(root, '.reviewloop/daddy-media');
mkdirSync(base, { recursive: true, mode: 0o700 });
const scratch = mkdtempSync(join(base, 'capture-')),
  data = join(scratch, 'data'),
  repo = join(scratch, 'payments');
mkdirSync(data);
mkdirSync(repo);
const store = new Store(join(data, 'reviewloop.sqlite')),
  token = randomBytes(24).toString('hex');
writeFileSync(join(data, 'access-token'), token, { mode: 0o600 });
const project = {
  id: randomUUID(),
  name: 'Payments',
  repoPath: repo,
  scope: '',
  provider: 'github',
  host: 'github.com',
  repo: 'example/payments',
  vcs: 'git',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};
store.saveProject(project);
const profiles = {
  author: { engine: 'codex', model: 'gpt-5.6-sol', effort: 'max' },
  reviewer: { engine: 'codex', model: 'gpt-6-astra', effort: 'max' },
};
const config = configSchema.parse({
  dataDir: data,
  locale: 'ru',
  agents: profiles,
  projects: { roots: [scratch] },
  telegram: { enabled: false },
});
const catalogue = {
  list: async () =>
    Object.values(profiles).map((profile) => ({
      id: profile.model,
      name: profile.model,
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      defaultEffort: 'medium',
      isDefault: profile === profiles.reviewer,
    })),
  validate: async () => {},
  metadata: () => ({
    source: 'codex-app-server:model/list',
    executable: '/opt/daddyloop/codex',
    cliVersion: '0.154.0',
  }),
};
const projects = new Projects(store, [scratch], { mounts: async () => [] });
const server = await buildApp({
  usage: usageFixture(),
  dataDir: data,
  store,
  projects,
  config,
  token,
  startWorker: false,
  startUpdateCheck: false,
  catalogue,
});
const group = server.daddy.create({
  projectId: project.id,
  title: 'Платежи без повторных списаний',
  writerLimit: 3,
});
store.daddyMessage(
  group.id,
  'user',
  'Нужно сделать платежи идемпотентными. Повторный запрос не должен списывать деньги дважды. Посмотри API, добавь тесты и обнови документацию.',
);
store.daddyMessage(
  group.id,
  'agent',
  'Разделил работу на три части. **API и тесты** выполняются вместе, документацию можно готовить параллельно.\n\n- Писатель 1 — ключ идемпотентности и обработка повторов.\n- Писатель 2 — контракты API и примеры.\n- Я проверю изменения и пройду сценарий с потерянным ответом.\n\nВ этой сессии доступно **3 писателя**. Подключу дополнительного, если появится независимая задача.',
);
store.daddyMessage(
  group.id,
  'user',
  'Добавь ещё сценарий, когда ответ потерялся, а клиент отправил запрос повторно.',
);
store.daddyMessage(
  group.id,
  'agent',
  'Добавил в ту же задачу. Ключ и результат операции сохраняются до ответа клиенту — повтор получит прежний результат.\n\nТесты уже проверяют повторную отправку и параллельные запросы. Сейчас смотрю, чтобы ошибки сети не превращались в успешный платёж.',
);
for (const [index, title] of [
  'Контракт ключа идемпотентности',
  'Повторные запросы и проверка ошибок',
  'Документация и примеры API',
].entries()) {
  const task = await server.engine.createTicket({
    groupId: group.id,
    projectId: project.id,
    ref: {
      kind: 'ticket',
      provider: 'github',
      host: 'github.com',
      repo: 'example/payments',
      number: index + 1,
      key: 'PAY-' + (index + 1),
      url: `https://github.com/example/payments/issues/${index + 1}`,
    },
    source: {
      kind: 'github_issue',
      key: 'PAY-' + (index + 1),
      url: `https://github.com/example/payments/issues/${index + 1}`,
      title,
      body: 'Illustrative media fixture.',
      state: 'open',
      fetchedAt: new Date().toISOString(),
    },
    repoPath: repo,
    repository: {
      baseHead: 'a'.repeat(40),
      baseBranch: 'main',
      branch: '',
      cloneUrl: 'https://github.com/example/payments.git',
    },
    requirements: 'Illustrative media fixture.',
  });
  task.state = index === 0 ? 'complete' : index === 1 ? 'reviewing' : 'implementing';
  store.saveTask(task);
  if (index)
    store.saveJob({
      id: randomUUID(),
      taskId: task.id,
      groupId: group.id,
      groupGeneration: group.generation,
      generation: task.generation,
      role: index === 1 ? 'reviewer' : 'author',
      kind: index === 1 ? 'review' : 'implement',
      profile: index === 1 ? profiles.reviewer : profiles.author,
      input: 'Illustrative fixture',
      status: 'running',
      createdAt: new Date().toISOString(),
    });
}
let browser;
const command = (exe, args) =>
  new Promise((resolve, reject) => {
    const p = spawn(exe, args, { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] });
    let error = '';
    p.stderr.on('data', (chunk) => (error += String(chunk).slice(0, 4000)));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(error))));
  });
try {
  await server.app.listen({ host: '127.0.0.1', port: 0 });
  const origin = `http://127.0.0.1:${server.app.server.address().port}`;
  const configFile = join(scratch, 'config.json');
  writeFileSync(configFile, JSON.stringify({ ...config, serverUrl: origin }), { mode: 0o600 });
  browser = await chromium.launch({ args: ['--disable-dev-shm-usage'] });
  const context = await browser.newContext({
    viewport: { width: 1512, height: 1000 },
    reducedMotion: 'reduce',
  });
  await context.request.post(origin + '/api/session', { data: { token } });
  const page = await context.newPage();
  await page.goto(origin + '/#session/' + group.id);
  await expect(page.getByRole('heading', { name: group.title })).toBeVisible();
  await expect(page.getByText('Тесты уже проверяют', { exact: false })).toBeVisible();
  await page.screenshot({ path: join(output, 'daddy-desktop.png'), animations: 'disabled' });
  await page.getByRole('button', { name: 'Настройки сессии' }).click();
  await expect(page.getByLabel('daddy Модель')).toHaveValue('gpt-6-astra');
  await page.screenshot({ path: join(output, 'daddy-models.png'), animations: 'disabled' });
  await page.getByRole('button', { name: 'Закрыть', exact: true }).click();
  await page.getByRole('button', { name: /Лимиты/ }).click();
  await expect(page.getByRole('dialog').getByText('Доступно сбросов: 3')).toBeVisible();
  await page.screenshot({ path: join(output, 'daddy-limits.png'), animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: join(output, 'daddy-phone-limits.png'), animations: 'disabled' });
  await page.getByRole('button', { name: 'Закрыть', exact: true }).click();
  await page.screenshot({ path: join(output, 'daddy-phone-chat.png'), animations: 'disabled' });
  await page
    .locator('.daddy-mobile-tabs')
    .getByRole('button', { name: /Задачи/ })
    .click();
  await page.screenshot({ path: join(output, 'daddy-phone-tasks.png'), animations: 'disabled' });
  const recording = join(scratch, 'terminal.json');
  await command('python3', [
    join(root, 'scripts/capture-daddy-cli.py'),
    process.execPath,
    join(root, 'dist/server/cli.js'),
    configFile,
    recording,
    group.id,
  ]);
  const capture = JSON.parse(readFileSync(recording, 'utf8'));
  for (const snapshot of capture.snapshots) {
    const screen = await browser.newPage({ viewport: { width: 1500, height: 1100 } });
    await screen.setContent(
      '<style>body{margin:0;padding:12px;background:#10160f}#terminal{display:inline-block}.xterm-viewport{overflow:hidden!important}</style><div id="terminal"></div>',
    );
    await screen.addStyleTag({ path: join(root, 'node_modules/@xterm/xterm/css/xterm.css') });
    await screen.addScriptTag({ path: join(root, 'node_modules/@xterm/xterm/lib/xterm.js') });
    const visible = await screen.evaluate(
      async ({ events, cols, rows }) => {
        const terminal = new window.Terminal({
          cols,
          rows,
          fontFamily: 'monospace',
          fontSize: 15,
          lineHeight: 1.15,
          cursorBlink: false,
          allowProposedApi: true,
          theme: { background: '#10160f' },
        });
        terminal.open(document.querySelector('#terminal'));
        for (const event of events)
          await new Promise((resolve) => terminal.write(event.data, resolve));
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return Array.from({ length: rows }, (_, i) =>
          terminal.buffer.active.getLine(i)?.translateToString(true),
        ).join('\n');
      },
      { events: capture.events.slice(0, snapshot.at), cols: capture.columns, rows: capture.rows },
    );
    expect(visible).toContain('daddyloop');
    const box = await screen.locator('#terminal').boundingBox();
    await screen.setViewportSize({
      width: Math.ceil(box.width) + 24,
      height: Math.ceil(box.height) + 24,
    });
    await screen.screenshot({ path: join(output, snapshot.name + '.png') });
    await screen.close();
  }
  writeFileSync(
    join(base, 'proof.json'),
    JSON.stringify(
      {
        fixtureData: true,
        terminalVerified: capture.verified,
        screens: [
          'daddy-desktop',
          'daddy-models',
          'daddy-phone-chat',
          'daddy-phone-tasks',
          ...capture.snapshots.map((s) => s.name),
        ],
      },
      null,
      2,
    ),
  );
  console.log(
    'Captured daddyloop desktop, phone, model settings and real CLI screens. Terminal restored; daemon PID unchanged.',
  );
  await context.close();
} finally {
  await browser?.close();
  await server.app.close();
  store.close();
  rmSync(scratch, { recursive: true, force: true });
}
