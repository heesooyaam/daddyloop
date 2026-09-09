import { afterEach, it, expect, vi } from 'vitest';
import { ModelCatalogue } from '../src/core/agents.js';
import { CodexConnection } from '../src/runtime/protocol.js';
afterEach(() => vi.restoreAllMocks());
it('loads models dynamically, reuses the cache and force-refreshes new model IDs and efforts', async () => {
  vi.spyOn(CodexConnection.prototype, 'start').mockResolvedValue({
    userAgent: 'codex-cli/0.153.4',
  });
  let name = 'model-today',
    effort = 'high';
  const request = vi.spyOn(CodexConnection.prototype, 'request').mockImplementation(
    async () =>
      ({
        data: [
          {
            id: name,
            model: name,
            displayName: name,
            defaultReasoningEffort: effort,
            supportedReasoningEfforts: [{ reasoningEffort: effort }],
            isDefault: true,
          },
        ],
        nextCursor: null,
      }) as never,
  );
  const catalog = new ModelCatalogue('/test/codex');
  expect((await catalog.list())[0].id).toBe('model-today');
  name = 'brand-new-model';
  effort = 'new-effort';
  expect((await catalog.list())[0].id).toBe('model-today');
  expect(request).toHaveBeenCalledTimes(1);
  expect((await catalog.list(true))[0]).toMatchObject({
    id: 'brand-new-model',
    efforts: ['new-effort'],
  });
  await expect(catalog.validate({ engine: 'codex', model: name, effort })).resolves.toBeUndefined();
  await expect(catalog.validate({ engine: 'codex', model: 'missing-model' })).rejects.toThrow(
    'not available',
  );
  expect(catalog.metadata()).toMatchObject({
    source: 'codex-app-server:model/list',
    cliVersion: '0.153.4',
    executable: '/test/codex',
  });
});
it('follows model pagination and reloads after the five-minute cache expires', async () => {
  vi.spyOn(CodexConnection.prototype, 'start').mockResolvedValue({ userAgent: 'codex-cli/1.0.0' });
  let clock = 1000000;
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
  const request = vi.spyOn(CodexConnection.prototype, 'request').mockImplementation(
    async (_method, params) =>
      ({
        data: [
          {
            id: params?.cursor ? 'second' : 'first',
            model: params?.cursor ? 'second' : 'first',
            displayName: 'Fixture',
            defaultReasoningEffort: 'medium',
            supportedReasoningEfforts: [
              { reasoningEffort: 'medium' },
              { reasoningEffort: 'ultra' },
            ],
            isDefault: !params?.cursor,
          },
        ],
        nextCursor: params?.cursor ? null : 'page-two',
      }) as never,
  );
  const catalog = new ModelCatalogue();
  expect((await catalog.list()).map((model) => model.id)).toEqual(['first', 'second']);
  expect(request).toHaveBeenCalledTimes(2);
  await catalog.list();
  expect(request).toHaveBeenCalledTimes(2);
  clock += 300001;
  await catalog.list();
  expect(request).toHaveBeenCalledTimes(4);
  expect(request).toHaveBeenCalledWith(
    'model/list',
    expect.objectContaining({ includeHidden: false, cursor: 'page-two' }),
  );
});
