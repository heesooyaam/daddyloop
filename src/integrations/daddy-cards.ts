import { TelegramText, type TelegramCard } from './telegram-text.js';
import { translator, type Locale } from '../i18n/index.js';
import type { Daddy } from '../core/daddy.js';
import type { Workspace, ReviewGroup } from '../core/types.js';
import { taskReference } from '../core/task-activity.js';
import { queueButtons } from './telegram-tasks.js';

export function daddyHome(
  locale: Locale,
  groups: ReviewGroup[],
  currentId?: string,
  page = 0,
): TelegramCard {
  const t = translator(locale);
  const sessions = groups.filter((group) => !group.deletedAt && group.daddyState !== 'archived'),
    pageSize = 10,
    pages = Math.max(1, Math.ceil(sessions.length / pageSize));
  page = Math.max(0, Math.min(page, pages - 1));
  const visible = sessions.slice(page * pageSize, (page + 1) * pageSize),
    navigation = [
      ...(page > 0 ? [{ text: '←', callback_data: `dad:sessions-page:${page - 1}` }] : []),
      ...(page + 1 < pages ? [{ text: '→', callback_data: `dad:sessions-page:${page + 1}` }] : []),
    ];
  const current = sessions.find((group) => group.id === currentId);
  const text = new TelegramText()
    .add('daddyloop', 'bold')
    .add('\n\n' + t('Send a task description or an issue link.'));
  if (current) text.add('\n' + t('Messages here go to {title}.', { title: current.title }));
  if (sessions.length) text.add('\n\n' + t('Choose a conversation below to continue it.'));
  return {
    ...text,
    buttons: [
      [{ text: '＋ ' + t('New task'), callback_data: 'dad:new' }],
      ...visible.map((group) => [
        {
          text: (current?.id === group.id ? '✓ ' : '') + group.title.slice(0, 55),
          callback_data: `dad:open:${group.id}`,
        },
      ]),
      ...(navigation.length ? [navigation] : []),
      [{ text: t('Settings'), callback_data: 'dad:settings' }],
    ],
  };
}

export function botSettings(locale: Locale): TelegramCard {
  const t = translator(locale);
  return {
    ...new TelegramText().add(t('Bot settings'), 'bold'),
    buttons: [
      [{ text: t('Repositories'), callback_data: 'dad:workspaces' }],
      [{ text: t('Disk cleanup'), callback_data: 'cleanup:show' }],
      [
        { text: t('Telegram group'), callback_data: 'dad:group' },
        { text: t('Notifications'), callback_data: 'notifications:show' },
      ],
      [
        { text: t('Language'), callback_data: 'language:show' },
        { text: t('Limits'), callback_data: 'dad:limits' },
      ],
      [
        { text: t('Updates'), callback_data: 'updates:show' },
        { text: t('Modules'), callback_data: 'dad:modules' },
      ],
      [{ text: t('Back'), callback_data: 'dad:home' }],
    ],
  };
}

export function workspacePicker(locale: Locale, workspaces: Workspace[], page = 0): TelegramCard {
  const t = translator(locale),
    pageSize = 10,
    pages = Math.max(1, Math.ceil(workspaces.length / pageSize));
  page = Math.max(0, Math.min(page, pages - 1));
  const visible = workspaces.slice(page * pageSize, (page + 1) * pageSize),
    navigation = [
      ...(page > 0 ? [{ text: '←', callback_data: `dad:new-page:${page - 1}` }] : []),
      ...(page + 1 < pages ? [{ text: '→', callback_data: `dad:new-page:${page + 1}` }] : []),
    ];
  return {
    ...new TelegramText()
      .add(t('Choose a repository'), 'bold')
      .add(pages > 1 ? '\n' + t('Page {page} of {pages}', { page: page + 1, pages }) : ''),
    buttons: [
      ...visible.map((workspace) => [
        { text: workspace.name, callback_data: `dad:new:${workspace.id}` },
      ]),
      ...(navigation.length ? [navigation] : []),
      [{ text: '＋ ' + t('Add repository'), callback_data: 'dad:add-workspace' }],
      [{ text: t('Find on server'), callback_data: 'dad:discover' }],
      [{ text: t('Back'), callback_data: 'dad:home' }],
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
      .add(board.group.title, 'bold')
      .add('\n' + (board.workspace?.name ?? t('Repository')));
  const preparation = board.group.workspacePreparation;
  if (preparation)
    text
      .add(
        '\n\n' +
          t(
            preparation.state === 'ready'
              ? 'Session copy ready'
              : preparation.state === 'error'
                ? 'Could not prepare the session copy'
                : 'Preparing the session copy',
          ),
      )
      .add(preparation.error ? '\n' + t(preparation.error) : '');
  if (board.group.deletion) {
    text.add(
      '\n\n' +
        t(
          board.group.deletion.state === 'error'
            ? 'Session deletion stopped; working copies were preserved'
            : 'Saving results and removing session copies',
        ),
    );
    if (board.group.deletion.error) text.add('\n' + t(board.group.deletion.error));
    return {
      ...text,
      buttons: [
        ...(board.group.deletion.state === 'error'
          ? [[{ text: t('Retry deletion'), callback_data: `dad:delete:${board.group.id}` }]]
          : []),
        [{ text: t('Refresh'), callback_data: `dad:open:${board.group.id}` }],
        [{ text: t('Sessions'), callback_data: 'dad:home' }],
      ],
    };
  }
  if (board.group.daddyState === 'paused') text.add('\n\n' + t('Paused'), 'bold');
  for (const task of board.tasks.slice(0, 6))
    text
      .add('\n\n' + (task.state === 'complete' ? '✅ ' : task.running ? '⚙️ ' : '• '))
      .add(taskReference(task), 'code')
      .add('  ' + task.title)
      .add('\n' + t(task.statusLabel));
  if (board.tasks.length > 6)
    text.add('\n' + t('{count} more tasks in the session', { count: board.tasks.length - 6 }));
  if (board.group.daddyState !== 'paused')
    text.add(
      '\n\n' + t('Use /task DESCRIPTION to queue a task. Send a regular message to talk to daddy.'),
    );
  return {
    ...text,
    buttons: [
      ...(topicUrl ? [[{ text: '🧵 ' + t('Open session topic'), url: topicUrl }]] : []),
      [
        { text: t('Tasks'), callback_data: `dad:tasks:${board.group.id}` },
        { text: t('Status'), callback_data: `dad:status:${board.group.id}` },
      ],
      [
        {
          text: t(board.group.daddyState === 'paused' ? 'Resume' : 'Pause'),
          callback_data: `dad:${board.group.daddyState === 'paused' ? 'resume' : 'pause'}:${board.group.id}`,
        },
      ],
      queueButtons(board.group.id, locale),
      [
        { text: t('Settings'), callback_data: `dad:settings:${board.group.id}` },
        { text: t('Sessions'), callback_data: 'dad:home' },
      ],
    ],
  };
}

export function sessionSettings(locale: Locale, board: ReturnType<Daddy['board']>): TelegramCard {
  const t = translator(locale),
    id = board.group.id;
  return {
    ...new TelegramText()
      .add(t('Settings for this session'), 'bold')
      .add('\n' + board.group.title)
      .add(
        board.workspace.provider === 'github'
          ? '\n' +
              t(
                'Includes already reviewed open PRs in this session. Task overrides take precedence.',
              )
          : '',
      ),
    buttons: [
      [
        { text: t('Models'), callback_data: `dad:models:${id}` },
        { text: t('Worker pool'), callback_data: `dad:pool:${id}` },
      ],
      ...(board.workspace.provider === 'github'
        ? [
            [
              {
                text: t(
                  board.group.autoMerge
                    ? 'Disable auto-merge for session'
                    : 'Enable auto-merge for session',
                ),
                callback_data: `dad:sm:${id}:${board.group.autoMerge ? 'off' : 'on'}`,
              },
            ],
          ]
        : []),
      [{ text: t('Instructions for this session'), callback_data: `dad:instructions:${id}` }],
      [
        {
          text: t('Repository for next task'),
          callback_data: `dad:repository:${id}`,
        },
      ],
      ...(board.canDelete
        ? [[{ text: t('Delete session'), callback_data: `dad:delete:${id}` }]]
        : []),
      [{ text: t('Back'), callback_data: `dad:open:${id}` }],
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
