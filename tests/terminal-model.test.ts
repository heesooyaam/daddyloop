import { afterEach, it, expect } from 'vitest';
import { ConsoleModel } from '../src/terminal/model.js';
import { emptyEditor, insert } from '../src/terminal/editor.js';
import { taskA, taskB, transport, detail } from './terminal-fixture.js';
const models: ConsoleModel[] = [];
afterEach(() => {
  for (const model of models.splice(0)) model.stop();
});
async function ready(api = transport().api) {
  const model = new ConsoleModel(api);
  models.push(model);
  await model.refresh();
  await expect.poll(() => model.snapshot().detail?.task.id).toBe(taskA.id);
  return model;
}
it('keeps separate drafts for each task and recipient', async () => {
  const model = await ready();
  model.setEditor(insert(emptyEditor(), 'Reviewer draft'));
  model.setRole('author');
  expect(model.editor().text).toBe('');
  model.setEditor(insert(emptyEditor(), 'Author draft'));
  model.select(taskB.id);
  expect(model.editor().text).toBe('');
  model.select(taskA.id);
  expect(model.editor().text).toBe('Author draft');
  model.setRole('reviewer');
  expect(model.editor().text).toBe('Reviewer draft');
});
it('does not adopt a late response from the previously selected task', async () => {
  let resolveA!: (value: unknown) => void;
  const pending = new Promise((resolve) => {
    resolveA = resolve;
  });
  const { api } = transport((path) => (path === `/tasks/${taskA.id}` ? pending : undefined));
  const model = new ConsoleModel(api);
  models.push(model);
  await model.refresh();
  model.select(taskB.id);
  resolveA(detail(taskA));
  await expect.poll(() => model.snapshot().detail?.task.id).toBe(taskB.id);
});
it('preserves a failed message at its original recipient while another draft is edited', async () => {
  let rejectPost!: (error: Error) => void;
  const pending = new Promise((_, reject) => {
    rejectPost = reject;
  });
  const { api, writes } = transport((_, body) => (body ? pending : undefined));
  const model = await ready(api);
  model.setEditor(insert(emptyEditor(), 'Original reviewer message'));
  const send = model.send();
  model.setRole('author');
  model.setEditor(insert(emptyEditor(), 'Author draft'));
  rejectPost(new Error('Connection lost'));
  await send;
  expect(writes[0]).toEqual({
    path: `/tasks/${taskA.id}/messages`,
    body: { role: 'reviewer', text: 'Original reviewer message' },
  });
  expect(model.editor().text).toBe('Author draft');
  model.setRole('reviewer');
  expect(model.editor().text).toBe('Original reviewer message');
  expect(model.snapshot().error).toContain('not confirmed');
});
it('treats pasted slash commands as literal text and never publishes from a paste', async () => {
  const { api, writes } = transport();
  const model = await ready(api);
  model.paste('/publish\nExplain this command.');
  expect(model.menu()).toEqual([]);
  expect(model.editor().literal).toBe(true);
  await model.send();
  expect(writes[0].path).toContain('/messages');
});
it('retains attach fields when the server rejects the request', async () => {
  const { api } = transport((path, body) =>
    path === '/tasks' && body ? Promise.reject(new Error('Credentials missing')) : undefined,
  );
  const model = await ready(api);
  model.open('attach');
  for (const value of ['https://github.com/test/repo/pull/1', '/work/repo', 'Fix the callback']) {
    model.setEditor(insert(emptyEditor(), value));
    await model.submitOverlay();
  }
  expect(model.snapshot().overlay?.kind).toBe('attach');
  expect(model.editor().text).toBe('Fix the callback');
  expect(model.snapshot().error).toContain('Credentials missing');
});
it('does not reinterpret a pasted slash command after a failed message delivery', async () => {
  const { api } = transport((_path, body) =>
    body ? Promise.reject(new Error('timeout')) : undefined,
  );
  const model = await ready(api);
  model.paste('/publish');
  await model.send();
  expect(model.editor().text).toBe('/publish');
  expect(model.editor().literal).toBe(true);
  expect(model.menu()).toEqual([]);
});
it('preserves newly typed text even when restoring a failed send exceeds the input limit', async () => {
  let rejectPost!: (error: Error) => void;
  const pending = new Promise((_, reject) => {
    rejectPost = reject;
  });
  const { api } = transport((_path, body) => (body ? pending : undefined));
  const model = await ready(api);
  model.setEditor(insert(emptyEditor(), 'x'.repeat(7000)));
  const send = model.send();
  model.setEditor(insert(emptyEditor(), 'y'.repeat(5000)));
  rejectPost(new Error('timeout'));
  await send;
  expect(model.editor().text).toBe('x'.repeat(7000) + '\n' + 'y'.repeat(5000));
});
it('aborts pending requests on close without issuing pause or stop actions', async () => {
  const signals: AbortSignal[] = [];
  const { api, writes } = transport(
    (_path, _body, signal) =>
      new Promise((_, reject) => {
        signals.push(signal!);
        signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }),
  );
  const model = new ConsoleModel(api);
  models.push(model);
  const refresh = model.refresh();
  model.stop();
  await refresh;
  expect(signals.every((signal) => signal.aborted)).toBe(true);
  expect(writes).toEqual([]);
});

it('configures role models from the catalogue and keeps the chosen effort', async () => {
  const { catalogue, profiles } = await import('./planning-fixture.js');
  const settings = { defaults: profiles, models: await catalogue.list(), maxConcurrentAgents: 1 };
  const { api, writes } = transport((path) =>
    path === '/agents'
      ? Promise.resolve(settings)
      : path === '/agents/defaults/reviewer'
        ? Promise.resolve({ defaults: profiles })
        : undefined,
  );
  const model = await ready(api);
  await model.execute('/defaults');
  model.patch({ overlay: { ...model.snapshot().overlay!, index: 1 } });
  await model.submitOverlay();
  expect(model.snapshot().overlay?.index).toBe(2);
  await model.submitOverlay();
  expect(model.snapshot().overlay?.step).toBe(2);
  await model.submitOverlay();
  expect(writes.at(-1)).toEqual({ path: '/agents/defaults/reviewer', body: profiles.reviewer });
  expect(model.snapshot().overlay).toBeUndefined();
});
it('imports a ticket through the terminal wizard with defaults and opens its author chat', async () => {
  const { catalogue, profiles, ticketInput } = await import('./planning-fixture.js');
  const settings = { defaults: profiles, models: await catalogue.list(), maxConcurrentAgents: 1 };
  const task = { ...taskA, ref: ticketInput().ref, source: ticketInput().source };
  const { api, writes } = transport((path) =>
    path === '/agents'
      ? Promise.resolve(settings)
      : path === '/tickets/preview'
        ? Promise.resolve(ticketInput())
        : path === '/tickets'
          ? Promise.resolve(task)
          : undefined,
  );
  const model = await ready(api);
  await model.execute('/new');
  model.setEditor(insert(emptyEditor(), ticketInput().source.url));
  await model.submitOverlay();
  model.setEditor(insert(emptyEditor(), '/work/repo'));
  await model.submitOverlay();
  for (let i = 0; i < 4; i++) await model.submitOverlay();
  expect(writes.at(-1)).toEqual({
    path: '/tickets',
    body: {
      source: ticketInput().source.url,
      repoPath: '/work/repo',
      agents: profiles,
      publication: 'auto',
      autoPush: true,
    },
  });
  expect(model.snapshot().role).toBe('author');
  expect(model.snapshot().overlay).toBeUndefined();
});
it('saves notification preferences and does not close a newer overlay after a late response', async () => {
  let done!: () => void;
  const pending = new Promise<void>((resolve) => {
    done = resolve;
  });
  const { api, writes } = transport((path, body) =>
    path === '/notifications'
      ? body
        ? pending
        : Promise.resolve({ telegram: { enabled: true, mode: 'attention' }, paired: true })
      : undefined,
  );
  const model = await ready(api);
  await model.execute('/notifications');
  model.patch({ overlay: { ...model.snapshot().overlay!, index: 0 } });
  const saving = model.submitOverlay();
  model.open('tasks');
  done();
  await saving;
  expect(model.snapshot().overlay?.kind).toBe('tasks');
  expect(writes.at(-1)?.body).toEqual({ enabled: false, mode: 'attention' });
});
