import { TelegramText, type TelegramCard } from './telegram-text.js';
import { translator, type Locale } from '../i18n/index.js';
import type { Daddy } from '../core/daddy.js';
import type { Project, ReviewGroup } from '../core/types.js';
export function daddyHome(locale: Locale, groups: ReviewGroup[]): TelegramCard {
  const t = translator(locale),
    text = new TelegramText()
      .add('👨‍💻 Daddyloop', 'bold')
      .add(
        '\n\n' +
          t(
            'Give Daddy a goal or a ticket. He plans the work, manages writers and reviews the result.',
          ),
      );
  return {
    ...text,
    buttons: [
      [{ text: '＋ ' + t('New session'), callback_data: 'dad:new' }],
      ...groups
        .filter((group) => group.daddyState !== 'archived')
        .slice(0, 12)
        .map((group) => [
          { text: group.title.slice(0, 55), callback_data: `dad:open:${group.id}` },
        ]),
      [
        { text: '📁 ' + t('Projects'), callback_data: 'dad:projects' },
        { text: '🧵 ' + t('Telegram workspace'), callback_data: 'dad:workspace' },
      ],
      [
        { text: '⬆️ ' + t('Updates'), callback_data: 'updates:show' },
        { text: '🌐 ' + t('Language'), callback_data: 'language:show' },
      ],
    ],
  };
}
export function projectPicker(locale: Locale, projects: Project[]): TelegramCard {
  const t = translator(locale),
    text = new TelegramText()
      .add('📁 ' + t('Choose a project'), 'bold')
      .add(
        '\n\n' +
          t(
            'Projects are folders on the server. Daddy creates separate working copies for writers.',
          ),
      );
  return {
    ...text,
    buttons: [
      ...projects
        .slice(0, 20)
        .map((project) => [{ text: project.name, callback_data: `dad:new:${project.id}` }]),
      [{ text: '＋ ' + t('Find projects on the server'), callback_data: 'dad:discover' }],
      [{ text: t('Sessions'), callback_data: 'dad:home' }],
    ],
  };
}
export function daddyBoard(
  locale: Locale,
  board: ReturnType<Daddy['board']>,
  topicUrl?: string,
): TelegramCard {
  const t = translator(locale),
    text = new TelegramText()
      .add('👨‍💻 ' + board.group.title, 'bold')
      .add('\n' + (board.project?.name ?? t('Project')))
      .add('\n\n' + t('Writers: {active} / {limit}', board.writers))
      .add(
        '\n' +
          t('Completed: {done} / {total}', {
            done: board.tasks.filter((task) => task.state === 'complete').length,
            total: board.tasks.length,
          }),
      );
  for (const task of board.tasks.slice(0, 15))
    text
      .add('\n\n' + (task.state === 'complete' ? '✅ ' : task.running ? '⚙️ ' : '• ') + task.title)
      .add(
        '\n' +
          t(
            task.state === 'complete'
              ? 'Complete'
              : task.running
                ? 'Working'
                : task.queued
                  ? 'Queued'
                  : task.state === 'needs_input'
                    ? 'Daddy is checking'
                    : 'Waiting for Daddy',
          ),
      );
  text.add(
    '\n\n' +
      t(
        'Send another ticket or describe what you need in this conversation. Daddy handles the writers.',
      ),
  );
  return {
    ...text,
    buttons: [
      ...(topicUrl ? [[{ text: '🧵 ' + t('Open session topic'), url: topicUrl }]] : []),
      [
        { text: '＋ ' + t('Add tasks'), callback_data: `dad:add:${board.group.id}` },
        { text: t('Writer pool'), callback_data: `dad:pool:${board.group.id}` },
      ],
      [{ text: t('Models'), callback_data: `dad:models:${board.group.id}` }],
      [
        {
          text: t(board.group.daddyState === 'paused' ? 'Resume Daddy' : 'Pause Daddy'),
          callback_data: `dad:${board.group.daddyState === 'paused' ? 'resume' : 'pause'}:${board.group.id}`,
        },
        { text: t('Refresh'), callback_data: `dad:open:${board.group.id}` },
      ],
      [{ text: t('Sessions'), callback_data: 'dad:home' }],
    ],
  };
}
export function poolCard(locale: Locale, group: ReviewGroup): TelegramCard {
  const t = translator(locale),
    text = new TelegramText()
      .add('⚙️ ' + t('Writer pool'), 'bold')
      .add('\n\n' + group.title)
      .add(
        '\n\n' +
          t(
            'Choose the maximum number of writers working at once. Daddy decides which tasks can run in parallel. Existing work finishes when the limit is reduced.',
          ),
      );
  return {
    ...text,
    buttons: [
      [1, 2, 3, 4, 6, 8].map((limit) => ({
        text: ((group.writerLimit ?? 1) === limit ? '✓ ' : '') + limit,
        callback_data: `dad:pool:${group.id}:${limit}`,
      })),
      [{ text: t('Back'), callback_data: `dad:open:${group.id}` }],
    ],
  };
}
