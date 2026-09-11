import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
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
test('saves different daddy and worker instructions with multiple import methods and leaves other sessions unchanged', async ({
  page,
}) => {
  await login(page);
  const defaults = (await (await page.request.get('/api/agents')).json()).defaults;
  await page.getByRole('button', { name: 'New session', exact: true }).click();
  await page.getByText('Style and skills for this session', { exact: true }).click();
  await page.getByLabel('Your instructions for daddy').fill('Explain decisions briefly.');
  await page.getByRole('button', { name: 'Attach a skill', exact: true }).click();
  await page.getByLabel('Skill source').selectOption('text');
  await page.getByLabel('Skill name').fill('Exact names');
  await page.getByLabel('Skill text', { exact: true }).fill('Preserve exact API names.');
  await page.getByLabel('Skill name').press('Enter');
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Attach skill', exact: true }).click();
  await expect(page.getByText('Exact names', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'All workers', exact: true }).click();
  await page
    .getByLabel('Your instructions for workers')
    .fill('Test the implementation before reporting.');
  await page.getByRole('button', { name: 'Attach a skill', exact: true }).click();
  await page.getByLabel('Skill source').selectOption('file');
  await page.getByLabel('Markdown file').setInputFiles({
    name: 'SKILL.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from('---\nname: worker-style\n---\nKeep reports precise.'),
  });
  await expect(page.getByText('worker-style', { exact: true })).toBeVisible();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download this instruction set' }).click();
  const download = await downloadPromise;
  const exported = readFileSync((await download.path())!, 'utf8');
  expect(JSON.parse(exported).daddy.skills[0].name).toBe('Exact names');
  await page.getByLabel('Session name (optional)').fill('Instruction test');
  await page.getByRole('button', { name: 'Start session', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Instruction test', exact: true })).toBeVisible();
  const first = await board(page);
  expect(first.group.instructions).toEqual(JSON.parse(exported));
  expect((await (await page.request.get('/api/agents')).json()).defaults).toEqual(defaults);
  await page.getByRole('button', { name: 'New session', exact: true }).click();
  await page.getByLabel('Session name (optional)').fill('Plain task');
  await page.getByRole('button', { name: 'Start session', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Plain task', exact: true })).toBeVisible();
  expect((await board(page)).group.instructions).toBeUndefined();
  await page.getByRole('button', { name: 'Session settings' }).click();
  await page.getByText('Style and skills for this session', { exact: true }).click();
  await page.getByLabel('Load an instruction set (.json)').setInputFiles({
    name: 'instructions.json',
    mimeType: 'application/json',
    buffer: Buffer.from(exported),
  });
  await expect(page.getByLabel('Your instructions for daddy')).toHaveValue(
    'Explain decisions briefly.',
  );
  const settings = page.waitForRequest(
    (request) => request.url().endsWith('/settings') && request.method() === 'POST',
  );
  await page.getByRole('button', { name: 'Save settings', exact: true }).click();
  expect((await settings).postDataJSON()).not.toHaveProperty('profiles');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect((await board(page)).group.instructions).toEqual(JSON.parse(exported));
  expect(
    (await (await page.request.get('/api/daddy/sessions/' + first.group.id)).json()).group
      .instructions,
  ).toEqual(first.group.instructions);
});
test('pending skill imports preserve the latest task draft and cancellation cannot attach a late response', async ({
  page,
}) => {
  await login(page);
  await page.getByRole('button', { name: 'New session', exact: true }).click();
  await page.getByText('Style and skills for this session', { exact: true }).click();
  for (const cancel of [true, false]) {
    await page.getByRole('button', { name: 'Attach a skill', exact: true }).click();
    await page.getByLabel('Skill source').selectOption('file');
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/api/instructions/import', async (route) => {
      await pending;
      await route.continue().catch(() => {});
    });
    const request = page.waitForRequest('**/api/instructions/import');
    await page.getByLabel('Markdown file').setInputFiles({
      name: 'slow.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from('Preserve details.'),
    });
    await request;
    await expect(page.getByRole('button', { name: 'Start session', exact: true })).toBeDisabled();
    await page.getByLabel('What should daddy do?').fill('Latest task draft ' + cancel);
    if (cancel) await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    release();
    await expect(page.getByRole('button', { name: 'Start session', exact: true })).toBeEnabled();
    await expect(page.getByLabel('What should daddy do?')).toHaveValue(
      'Latest task draft ' + cancel,
    );
    await expect(page.getByRole('button', { name: 'Remove skill slow.md' })).toHaveCount(
      cancel ? 0 : 1,
    );
    await page.unrouteAll({ behavior: 'wait' });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
