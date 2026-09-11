import { it, expect } from 'vitest';
import { translate } from '../src/i18n/index.js';
import { ru } from '../src/i18n/ru.js';
import { setLocale, preferences } from '../src/core/preferences.js';
import { fixture } from './helpers.js';
it('translates UI templates in both directions while preserving inserted content', () => {
  expect(translate('ru', 'Tasks')).toBe('Задачи');
  expect(translate('en', 'Задачи')).toBe('Tasks');
  expect(translate('ru', 'Round 2 of 5')).toBe('Раунд 2 из 5');
  expect(translate('en', '✅ Задача завершена')).toBe('✅ Task complete');
  expect(
    translate('ru', '{v0}\n\nShared reviewer: {v1}\n\n{v2}', {
      v0: 'Complete',
      v1: 'gpt-new-model',
      v2: 'Original **text**',
    }),
  ).toBe('Complete\n\nОбщий ревьюер: gpt-new-model\n\nOriginal **text**');
  for (const [key, value] of Object.entries(ru))
    expect([...key.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort(), key).toEqual(
      [...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort(),
    );
});
it('changes the interface preference without changing tasks or queued agent profiles', async () => {
  const f = await fixture();
  try {
    await f.engine.review(f.task.id);
    const before = f.store.getTask(f.task.id),
      jobs = f.store.jobs();
    const first = setLocale(f.store, 'ru'),
      second = setLocale(f.store, 'en');
    expect(first.version).toBe(1);
    expect(second.version).toBe(2);
    expect(preferences(f.store)).toEqual(second);
    expect(f.store.getTask(f.task.id)).toEqual(before);
    expect(f.store.jobs()).toEqual(jobs);
  } finally {
    f.store.close();
  }
});

it('resolves equivalent placeholder names without translating inserted task names', () => {
  expect(translate('en', 'Message {v0}', { v0: 'reviewer' })).toBe('Message reviewer');
  expect(translate('ru', 'Message {v0}', { v0: 'ревьюер' })).toBe('Сообщение: ревьюер');
  expect(translate('ru', 'Shared reviewer · {v0}', { v0: 'Tasks · Complete' })).toBe(
    'Общий ревьюер · Tasks · Complete',
  );
});
