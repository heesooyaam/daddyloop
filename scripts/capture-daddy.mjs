// Actual application and terminal render, with clearly illustrative offline fixture data.
import { chromium, expect } from '@playwright/test';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { buildApp } from '../dist/server/server/app.js';
import { translator } from '../dist/server/i18n/index.js';
import { usageFixture } from '../tests/e2e/usage-fixture.mjs';
import { configSchema } from '../dist/server/ops/config.js';
import { Store } from '../dist/server/core/store.js';
import { WorkspaceRegistry } from '../dist/server/core/workspace-registry.js';
const locale = process.env.DADDYLOOP_MEDIA_LOCALE === 'ru' ? 'ru' : 'en';
const t = translator(locale);
const root = resolve(import.meta.dirname, '..'),
  output = join(root, 'docs/media', locale);
mkdirSync(output, { recursive: true });
const base = join(tmpdir(), 'daddyloop-media');
mkdirSync(base, { recursive: true, mode: 0o700 });
const scratch = mkdtempSync(join(base, 'capture-')),
  data = join(scratch, 'data'),
  repo = join(scratch, 'payments');
mkdirSync(data);
mkdirSync(repo);
for (const child of ['services/api', 'services/web', 'docs', 'tests'])
  mkdirSync(join(repo, child), { recursive: true });
const store = new Store(join(data, 'daddyloop.sqlite')),
  token = randomBytes(24).toString('hex');
writeFileSync(join(data, 'access-token'), token, { mode: 0o600 });
const workspace = {
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
store.saveWorkspace(workspace);
const arcExample = join(scratch, 'arcadia');
mkdirSync(arcExample);
store.saveWorkspace({
  ...workspace,
  id: randomUUID(),
  name: 'Work',
  repoPath: arcExample,
  vcs: 'arcadia',
  provider: 'arcadia',
  host: 'a.yandex-team.ru',
  repo: 'arcadia',
  base: 'trunk',
});
const profiles = {
  worker: { engine: 'codex', model: 'gpt-5.6-sol', effort: 'max' },
  daddy: { engine: 'codex', model: 'gpt-6-astra', effort: 'max' },
};
const config = configSchema.parse({
  dataDir: data,
  locale,
  agents: profiles,
  workspaces: { roots: [scratch] },
  telegram: { enabled: false },
});
const catalogue = {
  list: async () =>
    Object.values(profiles).map((profile) => ({
      engine: profile.engine,
      id: profile.model,
      name: profile.model,
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      defaultEffort: 'medium',
      isDefault: profile === profiles.daddy,
    })),
  validate: async () => {},
  metadata: () => ({
    source: 'codex-app-server:model/list',
    executable: '/opt/daddyloop/codex',
    cliVersion: '0.154.0',
  }),
};
const workspaces = new WorkspaceRegistry(store, [scratch], { mounts: async () => [] });
const mediaUsage = usageFixture();
const readUsage = mediaUsage.read;
mediaUsage.read = async () => {
  const value = await readUsage();
  value.agents[0].buckets[0].credits = { hasCredits: false, unlimited: false, balance: '0' };
  return value;
};
const server = await buildApp({
  usage: mediaUsage,
  dataDir: data,
  store,
  workspaces,
  config,
  token,
  startWorker: false,
  startUpdateCheck: false,
  catalogue,
});
const fixture = {
  en: {
    title: 'Payments without duplicate charges',
    messages: [
      [
        'user',
        'Make payments idempotent. A repeated request must not charge twice. Check the API, add tests and update the docs.',
      ],
      [
        'agent',
        'Leave it with daddy. The crew is on it. **API and tests** stay together; the docs can run in parallel.\n\n- Worker 1 — the idempotency key and retry handling.\n- Worker 2 — API contracts and examples.\n- I will review both and check the lost-response case myself.\n\nWe have **3 worker slots**. I will use another one when there is independent work.',
      ],
      ['user', 'Also cover a lost response followed by the same request again.'],
      [
        'agent',
        'Already in the task. The key and result are saved before the response, so a retry gets the original result.\n\nTests already cover retries and concurrent requests. Now I am checking that a network error never masquerades as a successful payment.',
      ],
    ],
    titles: ['Idempotency contract', 'Retries and error handling', 'API docs and examples'],
  },
  ru: {
    title: 'Платежи без повторных списаний',
    messages: [
      [
        'user',
        'Нужны идемпотентные платежи. Повторный запрос не должен списывать дважды. Проверь API, добавь тесты и обнови документацию.',
      ],
      [
        'agent',
        'Беру на себя. Папочка уже раздал работу. **API и тесты** идут вместе, документацию делаем параллельно.\n\n- Воркер 1 — ключ идемпотентности и обработка повторов.\n- Воркер 2 — контракты API и примеры.\n- Я проверю результат и отдельно пройду потерянный ответ.\n\nВ команде **3 места**. Ещё одного подключу, когда будет независимая задача.',
      ],
      ['user', 'Добавь случай, когда ответ потерялся, а запрос пришёл повторно.'],
      [
        'agent',
        'Учёл. Папочка этот случай не пропустит. Ключ и результат сохраняем до ответа: повтор получит прежний результат.\n\nТесты уже проверяют повторы и параллельные запросы. Сейчас смотрю, чтобы ошибка сети не выдала себя за успешный платёж.',
      ],
    ],
    titles: [
      'Контракт идемпотентности',
      'Повторы и обработка ошибок',
      'Документация и примеры API',
    ],
  },
}[locale];
const group = server.daddy.create({
  workspaceId: workspace.id,
  title: fixture.title,
  workerLimit: 3,
});
for (const [sender, text] of fixture.messages) store.daddyMessage(group.id, sender, text);
for (const [index, title] of fixture.titles.entries()) {
  const task = await server.engine.createTicket({
    groupId: group.id,
    workspaceId: workspace.id,
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
      profile: index === 1 ? profiles.daddy : profiles.worker,
      input: 'Illustrative fixture',
      status: 'running',
      createdAt: new Date().toISOString(),
    });
}
let browser;
const ledger = store.getGroup(group.id);
ledger.workerTasks = store
  .tasks()
  .filter((task) => task.state !== 'complete')
  .map((task) => task.id);
store.saveGroup(ledger);
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
  await expect(
    page.getByText(locale === 'ru' ? 'Тесты уже проверяют' : 'Tests already cover', {
      exact: false,
    }),
  ).toBeVisible();
  await page.getByRole('button', { name: t('Change theme') }).click();
  await page.getByRole('radio', { name: t('Mint'), exact: true }).click();
  await page.getByRole('button', { name: t('Close'), exact: true }).click();
  await page.screenshot({ path: join(output, 'daddy-desktop.png'), animations: 'disabled' });
  await page.getByRole('button', { name: t('Change theme') }).click();
  await expect(page.getByRole('radiogroup')).toBeVisible();
  await page.screenshot({ path: join(output, 'daddy-themes.png'), animations: 'disabled' });
  await page.getByRole('radio', { name: t('Graphite'), exact: true }).click();
  await page.getByRole('button', { name: t('Close'), exact: true }).click();
  await page.screenshot({ path: join(output, 'daddy-dark.png'), animations: 'disabled' });
  for (const theme of [
    'Glacier',
    'Pearl',
    'Mint',
    'Lilac',
    'Graphite',
    'Midnight',
    'Forest',
    'Plum',
  ]) {
    await page.getByRole('button', { name: t('Change theme') }).click();
    await page.getByRole('radio', { name: t(theme), exact: true }).click();
    await page.getByRole('button', { name: t('Close'), exact: true }).click();
    await page.screenshot({
      path: join(output, 'theme-' + theme.toLowerCase() + '.png'),
      animations: 'disabled',
    });
  }
  await page.getByRole('button', { name: t('Change theme') }).click();
  await page.getByRole('radio', { name: t('Glacier'), exact: true }).click();
  await page.getByRole('button', { name: t('Close'), exact: true }).click();

  await page.getByRole('button', { name: t('New session'), exact: true }).click();
  await page
    .getByLabel(t('What should daddy do?'))
    .fill(
      locale === 'ru'
        ? 'Почини повторные списания. Проверь потерю ответа и параллельные запросы.'
        : 'Fix duplicate charges. Cover lost responses and concurrent requests.',
    );
  await page.getByLabel(t('Workspace'), { exact: true }).selectOption(workspace.id);
  await page.screenshot({ path: join(output, 'daddy-new-session.png'), animations: 'disabled' });
  await page.getByRole('button', { name: t('Change folder for this session') }).click();
  await page.getByRole('button', { name: t('Browse server folders') }).click();
  await expect(page.getByRole('button', { name: t('Select this folder') })).toBeEnabled();
  await page
    .getByRole('button', { name: t('Open folder {name}', { name: 'services' }), exact: true })
    .click();
  await expect(page.getByRole('button', { name: t('Select this folder') })).toBeEnabled();
  await page
    .getByRole('region', { name: t('Choose a folder on this server') })
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(output, 'daddy-folder-picker.png'), animations: 'disabled' });
  await page.getByRole('button', { name: t('Close'), exact: true }).click();
  await page
    .locator('.daddy-sidebar-bottom')
    .getByRole('button', { name: t('Workspaces'), exact: false })
    .click();
  await expect(
    page.getByRole('button', { name: t('Edit workspace {name}', { name: 'Work' }) }),
  ).toBeVisible();
  await page.screenshot({ path: join(output, 'daddy-workspaces.png'), animations: 'disabled' });
  await page.getByRole('button', { name: t('Close'), exact: true }).click();
  await page.getByRole('button', { name: t('Session settings') }).click();
  await expect(page.getByLabel('daddy ' + t('Model'))).toHaveValue('gpt-6-astra');
  await page.screenshot({ path: join(output, 'daddy-models.png'), animations: 'disabled' });
  await page.getByRole('button', { name: t('Close'), exact: true }).click();
  await page
    .locator('.daddy-sidebar-bottom')
    .getByRole('button', { name: t('Limits'), exact: false })
    .click();
  await expect(
    page.getByRole('dialog').getByText(t('Available resets: {count}', { count: 3 })),
  ).toBeVisible();
  await page.screenshot({ path: join(output, 'daddy-limits.png'), animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: join(output, 'daddy-phone-limits.png'), animations: 'disabled' });
  await page.getByRole('button', { name: t('Close'), exact: true }).click();
  await page.screenshot({ path: join(output, 'daddy-phone-chat.png'), animations: 'disabled' });
  await page
    .locator('.daddy-mobile-tabs')
    .getByRole('button', { name: t('Tasks'), exact: false })
    .click();
  await page.screenshot({ path: join(output, 'daddy-phone-tasks.png'), animations: 'disabled' });

  // The empty home page has its own fixture so its copy is visible in the guides.
  const home = await context.newPage();
  await home.route('**/api/daddy/sessions', (route) => route.fulfill({ json: [] }));
  await home.goto(origin);
  await expect(home.getByRole('heading', { name: t('Your dashboard') })).toBeVisible();
  await expect(
    home.getByText(t('Describe the task or drop a ticket link. daddy will take it from here.')),
  ).toBeVisible();
  await home.getByRole('button', { name: t('Change theme') }).click();
  await home.getByRole('radio', { name: t('Mint'), exact: true }).click();
  await home.getByRole('button', { name: t('Close'), exact: true }).click();
  await home.screenshot({ path: join(output, 'daddy-home.png'), animations: 'disabled' });
  await home.close();

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
    join(base, 'proof-' + locale + '.json'),
    JSON.stringify(
      {
        fixtureData: true,
        terminalVerified: capture.verified,
        screens: [
          'daddy-home',
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
