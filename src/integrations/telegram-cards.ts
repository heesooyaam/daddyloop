import type { Task, State, Role, ReviewSnapshot } from '../core/types.js';
import type { NotificationPreferences } from './notifications.js';
import { TelegramText, safeLink, type TelegramCard, type TelegramButton } from './telegram-text.js';

const states: Record<State, [string, string, string]> = {
  discussing: [
    '💬',
    'Обсуждаем задачу',
    'Автор изучает требования. Можно обсудить подход перед реализацией.',
  ],
  implementing: ['✍️', 'Автор работает', 'Идёт реализация задачи и проверка изменений.'],
  ready_for_review: [
    '📦',
    'Реализация готова',
    'Изменения сохранены и готовы к отправке на ревью.',
  ],
  submitting: ['📤', 'Создаём PR', 'Сервис отправляет сохранённые изменения на ревью.'],
  queued: ['🕓', 'В очереди', 'Задача ждёт свободного ревьюера.'],
  reviewing: ['🔎', 'Идёт ревью', 'Ревьюер проверяет текущую версию изменений.'],
  awaiting_publication: ['📝', 'Ревью готово', 'Замечания готовы к публикации.'],
  fixing: ['✍️', 'Исправляем замечания', 'Автор работает с опубликованными замечаниями ревьюера.'],
  awaiting_push: [
    '📦',
    'Нужна отправка изменений',
    'Работа автора сохранена локально. Следующий этап — push.',
  ],
  awaiting_checks: [
    '⏳',
    'Ожидаем проверки',
    'Ревью завершено. Осталось дождаться обязательных проверок.',
  ],
  awaiting_plan_approval: ['🙋', 'Нужно принять план', 'План прошёл ревью и ждёт твоего решения.'],
  needs_input: ['🙋', 'Нужен твой ответ', 'Автоматический цикл остановлен до твоего решения.'],
  paused: ['⏸', 'Задача на паузе', 'Работа сохранена. Продолжить можно командой /resume.'],
  complete: ['✅', 'Задача завершена', 'Все настроенные этапы задачи завершены.'],
};
const compact = (text: string, max = 160) => {
  const chars = [...text.replace(/\s+/g, ' ').trim()];
  return chars.length > max ? chars.slice(0, max - 1).join('') + '…' : chars.join('');
};
const card = (text: TelegramText, buttons?: TelegramButton[][]): TelegramCard => ({
  text: text.text,
  entities: text.entities,
  buttons,
});
const navigation = (): TelegramButton[][] => [
  [
    { text: '📋 Задачи', callback_data: 'tasks:0' },
    { text: '🔔 Уведомления', callback_data: 'notifications:show' },
  ],
];
function identity(text: TelegramText, task: Task) {
  text.add(compact(task.title), 'bold').add('\n');
  text.add(
    task.ref.provider === 'demo'
      ? 'ДЕМО · Reviewloop'
      : compact(task.source?.key ?? `${task.ref.repo} · #${task.ref.number}`),
    'italic',
  );
}
function taskButtons(task: Task, publicOrigin?: string): TelegramButton[][] {
  const rows: TelegramButton[][] = [];
  if (task.state === 'awaiting_publication' && task.policy.publication === 'human')
    rows.push([{ text: 'Опубликовать ревью…', callback_data: `publish:${task.id}` }]);
  const links: TelegramButton[] = [];
  const web = publicOrigin && safeLink(`${publicOrigin}/#task/${task.id}`),
    native = task.ref.provider !== 'demo' && safeLink(task.ref.url);
  if (web) links.push({ text: 'Открыть на сайте ↗', url: web });
  if (native)
    links.push({
      text: task.ref.kind === 'ticket' ? 'Открыть тикет ↗' : 'Открыть PR ↗',
      url: native,
    });
  if (links.length) rows.push(links);
  rows.push([
    { text: '↻ Статус', callback_data: `task:${task.id}` },
    { text: '📋 Задачи', callback_data: 'tasks:0' },
  ]);
  return rows;
}
export function taskCard(task: Task, publicOrigin?: string): TelegramCard {
  let [icon, title, explanation] = states[task.state];
  if (task.state === 'complete' && task.kind === 'plan') title = 'План принят';
  if (task.state === 'awaiting_checks' && task.pr?.checks === 'failing') {
    icon = '🔴';
    title = 'Проверки не прошли';
  }
  const text = new TelegramText().add(`${icon} ${title}`, 'bold').add('\n\n');
  identity(text, task);
  text.add('\n\n');
  if (task.state === 'needs_input' || task.state === 'paused' || task.state === 'awaiting_checks')
    text.markdown(task.reason || explanation);
  else if (task.state === 'complete' && task.summary.trim()) text.markdown(task.summary);
  else text.add(explanation);
  if (task.state === 'awaiting_publication')
    text.add(
      task.policy.publication === 'auto'
        ? '\nАвтор получит их автоматически.'
        : '\nНажми кнопку ниже, чтобы перейти к подтверждению.',
    );
  const facts: string[] = [];
  if (task.round) facts.push(`Раунд ${task.round}`);
  if (task.snapshot) facts.push(`Замечаний: ${task.snapshot.comments.length}`);
  if (task.pr)
    facts.push(
      task.checksWaivedAt
        ? 'CI: принято исключение'
        : !task.policy.requireChecks
          ? 'CI: необязательны'
          : `CI: ${{ passing: 'пройдены', pending: 'в процессе', failing: 'ошибка', missing: 'нет данных' }[task.pr.checks]}`,
    );
  if (facts.length) text.add('\n\n').add(facts.join(' · '));
  text.add('\nЗадача ').add(task.id.slice(0, 8), 'code');
  return card(text, taskButtons(task, publicOrigin));
}
export function agentCard(
  task: Task,
  role: Role,
  body: string,
  publicOrigin?: string,
): TelegramCard {
  const text = new TelegramText()
    .add(role === 'author' ? '✍️ Ответ автора' : '🔎 Ответ ревьюера', 'bold')
    .add('\n\n');
  identity(text, task);
  text.add('\n\n').markdown(body).add('\n\nЗадача ').add(task.id.slice(0, 8), 'code');
  return card(text, taskButtons(task, publicOrigin));
}
export function tasksCard(tasks: Task[], offset = 0): TelegramCard {
  const pageSize = 5,
    start = Math.min(
      Math.max(0, offset),
      Math.max(0, Math.floor((tasks.length - 1) / pageSize) * pageSize),
    );
  const page = tasks.slice(start, start + pageSize),
    text = new TelegramText().add('📋 Твои задачи', 'bold');
  const buttons: TelegramButton[][] = [];
  if (!tasks.length)
    text
      .add('\n\nПока задач нет. Начни с ')
      .add('/new', 'code')
      .add(' в reviewctl или подключи PR на сайте.');
  else {
    text.add(`\n${start + 1}–${start + page.length} из ${tasks.length}`);
    page.forEach((task, i) => {
      const [icon, status] = states[task.state];
      text
        .add('\n\n')
        .add(`${i + 1}. ${compact(task.title, 90)}`, 'bold')
        .add(`\n${icon} ${status} · `)
        .add(task.id.slice(0, 8), 'code');
      if (task.ref.provider === 'demo') text.add(' · демо');
      buttons.push([
        { text: `${i + 1} · ${compact(task.title, 40)}`, callback_data: `task:${task.id}` },
      ]);
    });
    const paging: TelegramButton[] = [];
    if (start)
      paging.push({ text: '← Назад', callback_data: `tasks:${Math.max(0, start - pageSize)}` });
    if (start + pageSize < tasks.length)
      paging.push({ text: 'Дальше →', callback_data: `tasks:${start + pageSize}` });
    if (paging.length) buttons.push(paging);
  }
  buttons.push([
    { text: '🔔 Уведомления', callback_data: 'notifications:show' },
    { text: 'Как пользоваться', callback_data: 'help' },
  ]);
  return card(text, buttons);
}
export function notificationsCard(prefs: NotificationPreferences): TelegramCard {
  const mode = !prefs.enabled ? 'off' : prefs.mode,
    text = new TelegramText().add('🔔 Уведомления', 'bold').add('\n\n');
  text
    .add(mode === 'off' ? 'Выключены' : mode === 'attention' ? 'Тихий режим' : 'Все ответы', 'bold')
    .add('\n');
  text.add(
    mode === 'off'
      ? 'Бот отвечает на команды, но не присылает обновления задач.'
      : mode === 'attention'
        ? 'Сообщу, когда задача завершится или понадобится твоё решение. Ответы агентов остаются в рабочем пространстве.'
        : 'Буду присылать ответы автора, ревьюера и важные этапы задач.',
  );
  const buttons = (
    [
      ['attention', 'Только итог и нужные решения', 'on'],
      ['all', 'Все ответы', 'all'],
      ['off', 'Выключить', 'off'],
    ] as const
  ).map(([key, label, value]) => [
    { text: `${mode === key ? '✓ ' : ''}${label}`, callback_data: `notifications:${value}` },
  ]);
  buttons.push([{ text: '📋 Задачи', callback_data: 'tasks:0' }]);
  return card(text, buttons);
}
export function welcomeCard(): TelegramCard {
  const text = new TelegramText()
    .add('👋 Reviewloop подключён', 'bold')
    .add('\n\nТеперь этот чат связан с твоим рабочим пространством.\n\n');
  text.add('Задачи', 'bold').add(' — статус и быстрый переход к результату.\n');
  text.add('Уведомления', 'bold').add(' — только итог и нужные решения, либо все ответы.\n\n');
  text.add('Работа продолжается на сервере, даже когда ноутбук выключен.');
  return card(text, navigation());
}
export function helpCard(): TelegramCard {
  const text = new TelegramText().add('🧭 Reviewloop · команды', 'bold').add('\n\n');
  for (const [command, label] of [
    ['/tasks', 'выбрать задачу'],
    ['/status <id>', 'посмотреть статус'],
    ['/author <id> текст', 'написать автору'],
    ['/reviewer <id> текст', 'обсудить с ревьюером'],
    ['/pause <id>', 'поставить на паузу'],
    ['/resume <id>', 'продолжить'],
    ['/retry <id>', 'повторить прерванную работу'],
    ['/publish <id>', 'перейти к подтверждению публикации'],
    ['/notifications', 'выбрать уведомления'],
    ['/web', 'получить ссылку входа на сайт'],
  ])
    text.add(command, 'code').add(`\n${label}\n\n`);
  text.add('Вместо <id> достаточно первых символов номера задачи.');
  return card(text, navigation());
}
export function noteCard(title: string, body: string): TelegramCard {
  return card(new TelegramText().add(title, 'bold').add('\n\n').add(body), navigation());
}
export function errorCard(message: string): TelegramCard {
  const text = new TelegramText()
    .add('⚠️ Проверь результат действия', 'bold')
    .add('\n\n')
    .add(message)
    .add('\n\nПосмотри текущий статус задачи перед повтором.');
  return card(text, navigation());
}
export function publishCard(
  task: Task,
  snapshot: ReviewSnapshot,
  callbackId: string,
): TelegramCard {
  const text = new TelegramText().add('📤 Опубликовать ревью?', 'bold').add('\n\n');
  identity(text, task);
  text
    .add(`\n\nЗамечаний: ${snapshot.comments.length}\nРевизия: `)
    .add(task.revision!.head.slice(0, 8), 'code');
  text.add(
    '\n\nПосле публикации автор получит замечания, и цикл продолжится.\n\nПодтверждение действует 5 минут.',
    'italic',
  );
  return card(text, [
    [{ text: 'Подтвердить публикацию', callback_data: callbackId }],
    [{ text: '← К задаче', callback_data: `task:${task.id}` }],
  ]);
}
