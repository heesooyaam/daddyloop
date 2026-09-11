import { TelegramText, type TelegramCard } from './telegram-text.js';
import { translator, type Locale } from '../i18n/index.js';
import type { Daddy } from '../core/daddy.js';
import type { Workspace, ReviewGroup } from '../core/types.js';
export function daddyHome(locale: Locale, groups: ReviewGroup[]): TelegramCard {
  const t = translator(locale),
    text = new TelegramText()
      .add('👨‍💻 daddyloop', 'bold')
      .add(
        '\n\n' +
          t(
            'Give daddy a goal or a ticket. He plans the work, manages workers and reviews the result.',
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
        { text: '📁 ' + t('Workspaces'), callback_data: 'dad:workspaces' },
        { text: '🧵 ' + t('Telegram group'), callback_data: 'dad:group' },
      ],
      [
        { text: '⬆️ ' + t('Updates'), callback_data: 'updates:show' },
        { text: '🌐 ' + t('Language'), callback_data: 'language:show' },
      ],
      [{ text: '📊 ' + t('Limits'), callback_data: 'dad:limits' }],
    ],
  };
}
export function workspacePicker(locale: Locale, workspaces: Workspace[]): TelegramCard {
  const t = translator(locale),
    text = new TelegramText()
      .add('📁 ' + t('Choose a workspace'), 'bold')
      .add(
        '\n\n' +
          t(
            'Workspaces are folders on the server. daddy creates separate working copies for workers.',
          ),
      );
  return {
    ...text,
    buttons: [
      ...workspaces
        .slice(0, 20)
        .map((workspace) => [{ text: workspace.name, callback_data: `dad:new:${workspace.id}` }]),
      [{ text: '＋ ' + t('Find workspaces on the server'), callback_data: 'dad:discover' }],
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
      .add('\n' + (board.workspace?.name ?? t('Workspace')))
      .add('\n' + (board.workspace?.repoPath ?? ''), 'code')
      .add('\n\n' + t('Workers: {active} / {limit}', board.workers))
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
                    ? 'daddy is checking'
                    : 'Waiting for daddy',
          ),
      );
  text.add('\n\n' + t('Got another ticket? Drop it here. daddy will make room for it.'));
  return {
    ...text,
    buttons: [
      ...(topicUrl ? [[{ text: '🧵 ' + t('Open session topic'), url: topicUrl }]] : []),
      [
        { text: '＋ ' + t('Add tasks'), callback_data: `dad:add:${board.group.id}` },
        { text: t('Worker pool'), callback_data: `dad:pool:${board.group.id}` },
      ],
      [{ text: t('Models'), callback_data: `dad:models:${board.group.id}` }],
      [{ text: '📊 ' + t('Limits'), callback_data: 'dad:limits' }],
      [
        {
          text: '📁 ' + t('Repository for next task'),
          callback_data: `dad:repository:${board.group.id}`,
        },
      ],
      [
        {
          text: t(board.group.daddyState === 'paused' ? 'Resume daddy' : 'Pause daddy'),
          callback_data: `dad:${board.group.daddyState === 'paused' ? 'resume' : 'pause'}:${board.group.id}`,
        },
        { text: t('Refresh'), callback_data: `dad:open:${board.group.id}` },
      ],
      [{ text: t('Sessions'), callback_data: 'dad:home' }],
    ],
  };
}
export function poolCard(locale: Locale, board: ReturnType<Daddy['board']>): TelegramCard {
  const { group, workers } = board;
  const t = translator(locale),
    text = new TelegramText()
      .add('⚙️ ' + t('Worker pool'), 'bold')
      .add('\n\n' + group.title)
      .add(
        '\n\n' +
          t(
            workers.pending
              ? 'Pool: {limit} → {target}. Changes apply in the background.'
              : 'Pool: {limit}. Occupied by tasks: {occupied}.',
            workers,
          ),
      )
      .add(
        '\n\n' +
          t(
            'Pool changes apply in the background. Busy workers finish their tasks, including review fixes.',
          ),
      );
  return {
    ...text,
    buttons: [
      [1, 2, 3, 4, 6, 8].map((limit) => ({
        text: (workers.target === limit ? '✓ ' : '') + limit,
        callback_data: `dad:pool:${group.id}:${limit}`,
      })),
      [{ text: t('Back'), callback_data: `dad:open:${group.id}` }],
    ],
  };
}
