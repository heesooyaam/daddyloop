import { it, expect } from 'vitest';
import {
  TelegramText,
  markdownText,
  splitTelegramText,
  safeLink,
  type FormattedText,
} from '../src/integrations/telegram-text.js';
import {
  taskCard,
  tasksCard,
  agentCard,
  notificationsCard,
} from '../src/integrations/telegram-cards.js';
import { TelegramApi } from '../src/integrations/telegram.js';
import { taskA } from './terminal-fixture.js';
const fragments = (value: FormattedText, type: string) =>
  value.entities
    .filter((entity) => entity.type === type)
    .map((entity) => value.text.slice(entity.offset, entity.offset + entity.length));
it('renders Markdown into Telegram entities with correct emoji offsets and literal HTML', () => {
  const result = markdownText(
    '## ✅ Проверено\n\n**Готово** и _курсив_ с `a < b`.\n\n```ts\nif (a < b) return "✓";\n```\n\n[Документация](https://example.com/docs?a=1&b=2)\n\n<b>literal HTML</b>',
  );
  expect(fragments(result, 'bold')).toEqual(['✅ Проверено', 'Готово']);
  expect(fragments(result, 'italic')).toContain('курсив');
  expect(fragments(result, 'code')).toContain('a < b');
  expect(fragments(result, 'pre')).toContain('if (a < b) return "✓";');
  expect(result.entities.find((entity) => entity.type === 'pre')?.language).toBe('ts');
  expect(result.entities.find((entity) => entity.type === 'text_link')?.url).toBe(
    'https://example.com/docs?a=1&b=2',
  );
  expect(result.text).toContain('<b>literal HTML</b>');
  for (const code of result.entities.filter((entity) => ['code', 'pre'].includes(entity.type)))
    expect(
      result.entities.filter(
        (other) =>
          other !== code &&
          other.offset < code.offset + code.length &&
          other.offset + other.length > code.offset,
      ),
    ).toEqual([]);
});
it('keeps nested styles out of code and renders lists, tables and reference links', () => {
  const result = markdownText(
    '**bold `code` and _italic_**\n\n- [x] Done\n- [ ] Next\n\n> Quote with **emphasis**\n\n| State | Count |\n| --- | --- |\n| Ready | 2 |\n\n[ref][docs]\n\n[docs]: https://example.com\n\n[x](javascript:alert(1))',
  );
  expect(result.text).toContain('☑ Done\n☐ Next');
  expect(result.text).toContain('▎ Quote with emphasis');
  expect(fragments(result, 'code')).toEqual(['code']);
  expect(fragments(result, 'bold').join('')).not.toContain('code');
  expect(fragments(result, 'pre')[0]).toContain('Ready');
  expect(result.entities.filter((entity) => entity.type === 'text_link')).toHaveLength(1);
  for (const url of [
    'javascript:alert(1)',
    'file:///secret',
    'https://user:password@example.com',
    'tg://user?id=1',
  ])
    expect(safeLink(url)).toBeUndefined();
});
it('splits long code and styled Unicode without losing text or cutting graphemes', () => {
  const family = '👩🏽‍💻',
    value = new TelegramText()
      .add('✅ Header\n', 'bold')
      .add((family + ' x\n').repeat(1800), 'pre', { language: 'text' })
      .add('\nDone', 'italic');
  const chunks = splitTelegramText(value);
  expect(chunks.map((chunk) => chunk.text).join('')).toBe(value.text);
  expect(chunks.length).toBeGreaterThan(2);
  const boundaries = new Set(
    [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value.text)].map(
      (part) => part.index,
    ),
  );
  boundaries.add(value.text.length);
  let offset = 0;
  for (const chunk of chunks) {
    expect(chunk.text.length).toBeLessThanOrEqual(3800);
    expect(boundaries.has(offset)).toBe(true);
    for (const entity of chunk.entities) {
      expect(entity.offset).toBeGreaterThanOrEqual(0);
      expect(entity.length).toBeGreaterThan(0);
      expect(entity.offset + entity.length).toBeLessThanOrEqual(chunk.text.length);
    }
    offset += chunk.text.length;
  }
  expect(
    chunks.filter((chunk) => chunk.entities.some((entity) => entity.type === 'pre')),
  ).toHaveLength(chunks.length);
});
it('splits densely formatted answers within the entity budget and retains every word', () => {
  const value = markdownText(Array.from({ length: 400 }, (_, i) => `**word${i}**`).join(' '));
  const chunks = splitTelegramText(value);
  expect(chunks.map((chunk) => chunk.text).join('')).toBe(value.text);
  for (const chunk of chunks) expect(chunk.entities.length).toBeLessThanOrEqual(90);
});
it('sends native entities and puts working buttons on the last chunk only', async () => {
  const sent: Record<string, unknown>[] = [];
  const api = new TelegramApi('123456:abcdefghijklmnopqrstuvwxyz123456', async (_url, options) => {
    sent.push(JSON.parse(String(options?.body)));
    return new Response(JSON.stringify({ ok: true, result: { message_id: sent.length } }));
  });
  const value = new TelegramText().add('x'.repeat(8000), 'pre');
  await api.send(7, { ...value, buttons: [[{ text: 'Задачи', callback_data: 'tasks:0' }]] });
  expect(sent).toHaveLength(3);
  expect(sent.map((message) => message.text).join('')).toBe(value.text);
  expect(sent.every((message) => Array.isArray(message.entities) && !message.parse_mode)).toBe(
    true,
  );
  expect(sent[0].reply_markup).toBeUndefined();
  expect(sent.at(-1)?.reply_markup).toBeDefined();
});
it('shows honest task facts, literal titles and no nonexistent web or demo links', () => {
  const task = {
    ...taskA,
    state: 'complete' as const,
    title: '<b>literal **title**</b>',
    summary: '**Готово.** Проверка завершена.',
    checksWaivedAt: '2026-09-09T00:00:00Z',
  };
  const value = taskCard(task);
  expect(value.text).toContain(task.title);
  expect(value.text).toContain('✅ Задача завершена');
  expect(value.text).toContain('ДЕМО');
  expect(value.buttons?.flat().some((button) => !!button.url)).toBe(false);
  const agent = agentCard(task, 'reviewer', '**Finding**\n\n```cpp\nreturn 0;\n```');
  expect(agent.text).toContain('🔎 Ответ ревьюера');
  expect(fragments(agent, 'pre')).toEqual(['return 0;']);
  const real = taskCard(
    {
      ...task,
      ref: { ...task.ref, provider: 'github', url: 'https://github.com/test/repo/pull/1' },
      pr: {
        head: 'a'.repeat(40),
        base: 'b'.repeat(40),
        start: 'b'.repeat(40),
        title: 'PR',
        body: '',
        branch: 'work',
        targetBranch: 'main',
        cloneUrl: 'https://github.com/test/repo.git',
        state: 'open',
        checks: 'failing',
        checkDetails: [],
      },
    },
    'https://review.example',
  );
  expect(real.text).toContain('CI: принято исключение');
  expect(real.text).not.toContain('CI: пройдены');
  expect(real.buttons?.flat().filter((button) => !!button.url)).toHaveLength(2);
});
it('paginates task cards and exposes current notification preferences through buttons', () => {
  const tasks = Array.from({ length: 12 }, (_, i) => ({
    ...taskA,
    id: taskA.id.slice(0, -2) + String(i).padStart(2, '0'),
    title: 'Задача ' + i,
  }));
  const first = tasksCard(tasks),
    next = tasksCard(tasks, 5);
  expect(first.text).toContain('1–5 из 12');
  expect(next.text).toContain('6–10 из 12');
  expect(next.text).not.toContain('Задача 0\n');
  for (const button of [...first.buttons!.flat(), ...next.buttons!.flat()])
    if (button.callback_data)
      expect(Buffer.byteLength(button.callback_data)).toBeLessThanOrEqual(64);
  const prefs = notificationsCard({ enabled: true, mode: 'attention' });
  expect(prefs.text).toContain('Тихий режим');
  expect(prefs.buttons?.flat().find((button) => button.text.startsWith('✓'))?.callback_data).toBe(
    'notifications:on',
  );
});

it('hides native correlation markers from summaries while preserving literal code examples', () => {
  const marker = '<!-- reviewloop:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa:1:2 -->';
  const source = '**Проверено**\n\n' + marker;
  const value = markdownText(source);
  expect(value.text).toBe('Проверено');
  expect(source).toContain(marker);
  const example = markdownText('```html\n' + marker + '\n```');
  expect(fragments(example, 'pre')).toEqual([marker]);
});
it('does not claim an operation failed when only its confirmation could not be delivered', async () => {
  const { errorCard } = await import('../src/integrations/telegram-cards.js');
  const value = errorCard('Telegram connection timed out after the request.');
  expect(value.text).toContain('Проверь результат действия');
  expect(value.text).toContain('перед повтором');
});
