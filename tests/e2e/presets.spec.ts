import { test, expect, type Page } from '@playwright/test';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
async function login(page: Page) {
  await page.goto('/');
  await page
    .getByLabel('Local access token')
    .fill(readFileSync('.daddyloop/e2e/access-token', 'utf8'));
  await page.getByRole('button', { name: 'Connect to workspace' }).click();
  await expect(page.locator('.daddy-app')).toBeVisible();
}
async function board(page: Page) {
  return (
    await page.request.get('/api/daddy/sessions/' + new URL(page.url()).hash.slice(9))
  ).json();
}
test('creates reusable presets, selects multiple sets and components, and keeps the session snapshot after library changes', async ({
  page,
}) => {
  await login(page);
  await page.getByRole('button', { name: 'Presets', exact: true }).click();
  for (const [name, daddy, worker] of [
    ['Brief fixture', 'Brief decisions.', 'Skip this worker prompt.'],
    ['Careful fixture', 'Explain the reason.', 'Check edge cases.'],
    ['Extra fixture', 'Keep the extra context.', 'Check the extra context.'],
  ]) {
    await page.getByRole('button', { name: 'Create preset', exact: true }).click();
    await page.getByLabel('Preset name', { exact: true }).fill(name);
    await page.getByRole('button', { name: 'daddy', exact: true }).click();
    await page.getByLabel('Your instructions for daddy').fill(daddy);
    await page.getByRole('button', { name: 'All workers', exact: true }).click();
    await page.getByLabel('Your instructions for workers').fill(worker);
    await page.getByRole('button', { name: 'Save preset', exact: true }).click();
    await expect(page.getByText('Preset saved. Choose it when creating a session.')).toBeVisible();
  }
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'New session', exact: true }).click();
  await page.getByText('Style and skills for this session', { exact: true }).click();
  await page.getByRole('button', { name: 'Add presets', exact: true }).click();
  for (const name of ['Brief fixture', 'Careful fixture']) {
    await page.getByRole('checkbox', { name: 'Use preset ' + name, exact: true }).check();
    await expect(
      page.getByRole('checkbox', { name: 'Use preset ' + name, exact: true }),
    ).toBeChecked();
  }
  const brief = page
    .locator('.daddy-preset-choice')
    .filter({ has: page.getByRole('checkbox', { name: 'Use preset Brief fixture', exact: true }) });
  await brief.getByText('Choose components', { exact: false }).click();
  await brief
    .getByRole('checkbox', { name: 'Brief fixture: All workers: Prompt', exact: true })
    .uncheck();
  await page.getByLabel('Session name (optional)').fill('Preset session fixture');
  await page.getByRole('button', { name: 'Start session', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Preset session fixture' })).toBeVisible();
  const first = await board(page);
  let selected = first.group.instructions.presets;
  expect(selected).toHaveLength(2);
  expect(selected[0].omit).toEqual(['worker:prompt']);
  await page.getByRole('button', { name: 'Session settings', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Session settings' });
  await settings.getByText('Style and skills for this session', { exact: true }).click();
  await settings.getByRole('button', { name: 'Add presets', exact: true }).click();
  await settings
    .getByRole('button', {
      name: 'Remove preset Brief fixture from this session',
      exact: true,
    })
    .click();
  await settings.getByRole('checkbox', { name: 'Use preset Brief fixture', exact: true }).check();
  await expect(
    settings.locator('.daddy-preset-choice strong').filter({ hasText: /Brief|Careful/ }),
  ).toHaveText(['Careful fixture', 'Brief fixture']);
  await settings.getByRole('button', { name: 'Save settings', exact: true }).click();
  await expect(settings).toHaveCount(0);
  selected = (await board(page)).group.instructions.presets;
  expect(selected.map((entry: any) => entry.preset.name)).toEqual([
    'Careful fixture',
    'Brief fixture',
  ]);
  await page.getByRole('button', { name: 'Session settings', exact: true }).click();
  await settings.getByText('Style and skills for this session', { exact: true }).click();
  await expect(
    settings.locator('.daddy-preset-choice strong').filter({ hasText: /Brief|Careful/ }),
  ).toHaveText(['Careful fixture', 'Brief fixture']);
  await settings.getByRole('button', { name: 'Add presets', exact: true }).click();
  await settings
    .getByRole('button', {
      name: 'Remove preset Careful fixture from this session',
      exact: true,
    })
    .click();
  await settings.getByRole('checkbox', { name: 'Use preset Extra fixture', exact: true }).check();
  await settings.getByRole('checkbox', { name: 'Use preset Careful fixture', exact: true }).check();
  await expect(
    settings.locator('.daddy-preset-choice strong').filter({ hasText: /Brief|Careful|Extra/ }),
  ).toHaveText(['Brief fixture', 'Extra fixture', 'Careful fixture']);
  await settings.getByRole('button', { name: 'Save settings', exact: true }).click();
  await expect(settings).toHaveCount(0);
  selected = (await board(page)).group.instructions.presets;
  expect(selected.map((entry: any) => entry.preset.name)).toEqual([
    'Brief fixture',
    'Extra fixture',
    'Careful fixture',
  ]);
  await page.getByRole('button', { name: 'Presets', exact: true }).click();
  await page.getByRole('button', { name: 'Edit preset Brief fixture', exact: true }).click();
  await page.getByRole('button', { name: 'daddy', exact: true }).click();
  await page.getByLabel('Your instructions for daddy').fill('Updated library prompt.');
  await page.getByRole('button', { name: 'Save preset', exact: true }).click();
  await expect(page.getByText('Preset saved. Choose it when creating a session.')).toBeVisible();
  const saved = await page.request.get('/api/daddy/sessions/' + first.group.id);
  expect((await saved.json()).group.instructions.presets).toEqual(selected);
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'New session', exact: true }).click();
  await page.getByText('Style and skills for this session', { exact: true }).click();
  await page.getByRole('button', { name: 'Add presets', exact: true }).click();
  await expect(
    page.getByRole('checkbox', { name: 'Use preset Brief fixture', exact: true }),
  ).not.toBeChecked();
  await page.getByRole('checkbox', { name: 'Use preset Brief fixture', exact: true }).check();
  await expect(
    page.getByRole('checkbox', { name: 'Use preset Brief fixture', exact: true }),
  ).toBeChecked();
  await page.getByLabel('Session name (optional)').fill('Preset new version fixture');
  await page.getByRole('button', { name: 'Start session', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Preset new version fixture' })).toBeVisible();
  expect((await board(page)).group.instructions.presets[0].preset.revision).toBe(2);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test('merges a stale preset addition without undoing the order saved in another tab', async ({
  page,
  context,
}) => {
  await login(page);
  const suffix = Date.now(),
    headers = { 'X-daddyloop-Request': '1' },
    presets: any[] = [];
  for (const name of ['A', 'B', 'C', 'D']) {
    const response = await page.request.post('/api/instructions/presets', {
      headers,
      data: {
        name: `Concurrent ${name} ${suffix}`,
        description: '',
        instructions: { daddy: { prompt: name }, worker: {} },
      },
    });
    expect(response.status()).toBe(201);
    presets.push(await response.json());
  }
  const workspaces = await (await page.request.get('/api/workspaces')).json(),
    created = await page.request.post('/api/daddy/sessions', {
      headers,
      data: {
        workspaceId: workspaces[0].id,
        title: `Concurrent preset order ${suffix}`,
        instructions: {
          daddy: {},
          worker: {},
          presets: presets.slice(0, 3).map((preset) => ({ preset, enabled: true, omit: [] })),
        },
      },
    });
  expect(created.status()).toBe(201);
  const session = (await created.json()).group;
  await page.goto(`/#session/${session.id}`);
  await expect(page.getByRole('heading', { name: session.title })).toBeVisible();
  const other = await context.newPage();
  await other.goto(`/#session/${session.id}`);
  await expect(other.getByRole('heading', { name: session.title })).toBeVisible();

  await page.getByRole('button', { name: 'Session settings', exact: true }).click();
  const first = page.getByRole('dialog', { name: 'Session settings' });
  await first.getByText('Style and skills for this session', { exact: true }).click();
  await first.getByRole('button', { name: 'Add presets', exact: true }).click();
  await first
    .getByRole('button', {
      name: `Remove preset Concurrent B ${suffix} from this session`,
      exact: true,
    })
    .click();
  await first
    .getByRole('checkbox', { name: `Use preset Concurrent B ${suffix}`, exact: true })
    .check();

  await other.getByRole('button', { name: 'Session settings', exact: true }).click();
  const second = other.getByRole('dialog', { name: 'Session settings' });
  await second.getByText('Style and skills for this session', { exact: true }).click();
  await second.getByRole('button', { name: 'Add presets', exact: true }).click();
  await second
    .getByRole('checkbox', { name: `Use preset Concurrent D ${suffix}`, exact: true })
    .check();

  await first.getByRole('button', { name: 'Save settings', exact: true }).click();
  await expect(first).toHaveCount(0);
  await second.getByRole('button', { name: 'Save settings', exact: true }).click();
  await expect(second).toHaveCount(0);
  const board = await (await page.request.get(`/api/daddy/sessions/${session.id}`)).json();
  expect(board.group.instructions.presets.map((entry: any) => entry.preset.name)).toEqual([
    `Concurrent A ${suffix}`,
    `Concurrent C ${suffix}`,
    `Concurrent B ${suffix}`,
    `Concurrent D ${suffix}`,
  ]);
  await other.close();
});
test('selects a local folder, uploads only checked Markdown files, and keeps their relative paths', async ({
  page,
}) => {
  const root = mkdtempSync(join(tmpdir(), 'daddyloop-folder-e2e-'));
  try {
    for (const dir of ['brief', 'testing', 'reference']) mkdirSync(join(root, dir));
    writeFileSync(
      join(root, 'brief/SKILL.md'),
      '---\nname: folder-brief\n---\nKeep answers brief.',
    );
    writeFileSync(
      join(root, 'testing/SKILL.md'),
      '---\nname: folder-testing\n---\nVerify changes.',
    );
    writeFileSync(join(root, 'reference/notes.md'), 'Optional reference.');
    writeFileSync(join(root, '.env'), 'DO-NOT-UPLOAD');
    writeFileSync(join(root, 'binary.bin'), Buffer.alloc(50000));
    await login(page);
    await page.getByRole('button', { name: 'New session', exact: true }).click();
    await page.getByText('Style and skills for this session', { exact: true }).click();
    await page.getByRole('button', { name: 'Attach a skill', exact: true }).click();
    await page.getByLabel('Skill source').selectOption('folder');
    await page.getByLabel('Skill folder on this device').setInputFiles(root);
    await expect(page.getByRole('button', { name: 'Start session', exact: true })).toBeDisabled();
    const folder = page.getByRole('region', { name: 'Skills from a folder' });
    await expect(folder.getByRole('checkbox')).toHaveCount(3);
    await folder
      .getByRole('checkbox', { name: 'Include file ' + basename(root) + '/testing/SKILL.md' })
      .uncheck();
    const uploads: any[] = [];
    page.on('request', (request) => {
      if (request.url().endsWith('/instructions/import') && request.method() === 'POST')
        uploads.push(request.postDataJSON());
    });
    await page.getByLabel('What should daddy do?').fill('Keep the folder task draft');
    await page.getByRole('button', { name: 'Attach selected files', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Remove skill folder-brief' })).toBeVisible();
    expect(uploads).toHaveLength(1);
    expect(JSON.stringify(uploads)).not.toContain('DO-NOT-UPLOAD');
    expect(uploads[0].path).toBe(basename(root) + '/brief/SKILL.md');
    await page.getByLabel('Session name (optional)').fill('Folder session fixture');
    await page.getByRole('button', { name: 'Start session', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Folder session fixture' })).toBeVisible();
    const selected = (await board(page)).group.instructions.daddy.skills;
    expect(selected).toHaveLength(1);
    expect(selected[0].source).toEqual({ kind: 'folder', location: uploads[0].path });
    rmSync(root, { recursive: true });
    expect((await board(page)).group.instructions.daddy.skills[0].text).toContain(
      'Keep answers brief.',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test('does not partially attach a folder when a later file fails to import', async ({ page }) => {
  const root = mkdtempSync(join(tmpdir(), 'daddyloop-folder-failure-'));
  try {
    writeFileSync(join(root, 'a.md'), 'First instruction');
    writeFileSync(join(root, 'b.md'), 'Second instruction');
    await login(page);
    await page.getByRole('button', { name: 'New session', exact: true }).click();
    await page.getByText('Style and skills for this session', { exact: true }).click();
    await page.getByRole('button', { name: 'Attach a skill', exact: true }).click();
    await page.getByLabel('Skill source').selectOption('folder');
    await page.getByLabel('Skill folder on this device').setInputFiles(root);
    let requests = 0;
    await page.route('**/api/instructions/import', (route) =>
      ++requests === 2
        ? route.fulfill({
            status: 422,
            json: { error: { message: 'Second file could not be imported' } },
          })
        : route.continue(),
    );
    await page.getByRole('button', { name: 'Attach selected files', exact: true }).click();
    await expect(page.getByText('Second file could not be imported')).toBeVisible();
    await expect(page.locator('.daddy-instruction-skill')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Start session', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Start session', exact: true })).toBeEnabled();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('creates a preset from the session editor without losing its draft or creating the session early', async ({
  page,
}) => {
  await login(page);
  await page.getByRole('button', { name: 'New session', exact: true }).click();
  await page.getByLabel('Session name (optional)').fill('Inline preset fixture');
  await page.getByLabel('What should daddy do?').fill('Keep my task draft.');
  await page.getByText('Style and skills for this session', { exact: true }).click();
  await expect(page.getByRole('button', { name: 'Refresh list', exact: true })).toHaveCount(0);
  await page.getByLabel('Your instructions for daddy').fill('My session rule.');
  await page.getByRole('button', { name: 'Create preset', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Start session', exact: true })).toBeDisabled();
  await page.getByLabel('Preset name', { exact: true }).fill('Inline reusable fixture');
  await page.getByLabel('Your instructions for daddy').fill('My reusable rule.');
  await page.getByRole('button', { name: 'Save and use in this session', exact: true }).click();
  await expect(
    page.getByRole('checkbox', { name: 'Use preset Inline reusable fixture' }),
  ).toBeChecked();
  await expect(page.getByLabel('Your instructions for daddy')).toHaveValue('My session rule.');
  await expect(page.getByLabel('What should daddy do?')).toHaveValue('Keep my task draft.');
  await expect(page.getByRole('button', { name: 'Start session', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Start session', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Inline preset fixture' })).toBeVisible();
  const saved = await board(page);
  expect(saved.group.instructions.daddy.prompt).toBe('My session rule.');
  expect(saved.group.instructions.presets[0].preset.instructions.daddy.prompt).toBe(
    'My reusable rule.',
  );
});
