import type { Locale } from '../i18n/index.js';
import { TelegramText } from './telegram-text.js';

type Scope = 'private' | 'group';
interface Command {
  name: string;
  args?: string;
  en: string;
  ru: string;
  scope?: Scope;
  detail?: Record<Locale, string>;
}

const commands: Command[] = [
  {
    name: 'help',
    args: '[command]',
    en: 'List commands or explain one command',
    ru: 'Показать команды или справку по одной команде',
  },
  {
    name: 'task',
    args: 'text | [options] -- text | DADDY-ID',
    en: 'Queue work or open an existing task',
    ru: 'Поставить работу в очередь или открыть задачу',
    detail: {
      en: 'Send /task Fix search or /task DADDY-12ab34cd. Before -- you can set --worker 1..8, --model MODEL, --engine ENGINE and --effort LEVEL. Engine and effort require a model. Example: /task --worker 2 -- Fix search.',
      ru: 'Напиши /task Почини поиск или /task DADDY-12ab34cd. Перед -- доступны --worker 1..8, --model МОДЕЛЬ, --engine ДВИЖОК и --effort УРОВЕНЬ. Для движка и уровня нужна модель. Пример: /task --worker 2 -- Почини поиск.',
    },
  },
  { name: 'tasks', en: 'List tasks and manual actions', ru: 'Показать задачи и ручные действия' },
  {
    name: 'queue',
    en: 'List unfinished tasks and their current stages',
    ru: 'Показать незавершённые задачи и их этапы',
  },
  {
    name: 'workers',
    en: 'Show worker numbers, assignments and models',
    ru: 'Посмотреть номера воркеров, их задачи и модели',
  },
  {
    name: 'worker',
    args: 'N MODEL [EFFORT] [--engine ENGINE] [--force]',
    en: 'Change the profile of a numbered worker',
    ru: 'Изменить профиль воркера по номеру',
    detail: {
      en: 'Without --force the profile applies to the next task. --force interrupts the current author turn and restarts it in the same working copy.',
      ru: 'Обычно смена применяется к следующей задаче. --force прерывает текущий ход автора и запускает его заново в той же копии.',
    },
  },
  {
    name: 'submit',
    args: '[DADDY-ID]',
    en: 'Prepare explicit PR submission',
    ru: 'Подготовить явную отправку PR',
  },
  {
    name: 'approve',
    args: '[DADDY-ID]',
    en: 'Prepare plan approval',
    ru: 'Подготовить принятие плана',
  },
  {
    name: 'publish',
    args: '[DADDY-ID]',
    en: 'Prepare review publication',
    ru: 'Подготовить публикацию ревью',
  },
  {
    name: 'waive',
    args: '[DADDY-ID --] reason',
    en: 'Prepare a CI waiver',
    ru: 'Подготовить пропуск CI с причиной',
  },
  { name: 'status', en: 'Show the latest session progress', ru: 'Показать текущий этап сессии' },
  {
    name: 'pool',
    args: '[1..8]',
    en: 'Inspect or change the session worker limit',
    ru: 'Посмотреть или изменить число воркеров',
  },
  {
    name: 'sessions',
    en: 'Choose a session or open its topic',
    ru: 'Выбрать сессию или открыть её тему',
  },
  {
    name: 'session',
    args: '[name|ID]',
    en: 'Select a session explicitly',
    ru: 'Явно выбрать сессию',
  },
  {
    name: 'new',
    args: '[goal]',
    en: 'Start a separate session and choose a workspace',
    ru: 'Создать отдельную сессию и выбрать репозиторий',
  },
  {
    name: 'rename',
    args: 'name',
    en: 'Rename the session and its Telegram topic',
    ru: 'Переименовать сессию и её тему в Telegram',
  },
  {
    name: 'workspaces',
    en: 'Choose or register a repository',
    ru: 'Выбрать или подключить репозиторий',
  },
  {
    name: 'workspace',
    args: '[name|ID]',
    en: 'Inspect or edit saved repository defaults',
    ru: 'Посмотреть или изменить настройки репозитория',
  },
  {
    name: 'repo',
    args: '[default | path]',
    en: 'Choose the repository for one request',
    ru: 'Выбрать репозиторий для одного запроса',
    detail: {
      en: 'Use /repo default to clear the one-request override.',
      ru: 'Команда /repo default возвращает репозиторий сессии.',
    },
  },
  {
    name: 'models',
    en: 'Show available agent models and reasoning levels',
    ru: 'Посмотреть доступные модели и уровни рассуждения',
  },
  { name: 'limits', en: 'Show remaining agent quotas', ru: 'Посмотреть остаток лимитов агентов' },
  {
    name: 'instructions',
    args: '[daddy|worker text|--clear|import|export]',
    en: 'Read, change, import or export instructions',
    ru: 'Посмотреть, изменить, импортировать или экспортировать инструкции',
  },
  {
    name: 'skill',
    args: 'daddy|worker URL|file|local PATH|text NAME :: TEXT',
    en: 'Attach a skill to the selected role',
    ru: 'Подключить навык к выбранной роли',
  },
  {
    name: 'presets',
    en: 'List saved instruction presets',
    ru: 'Посмотреть готовые наборы инструкций',
  },
  {
    name: 'preset',
    args: 'name | action name',
    en: 'Apply or manage saved presets',
    ru: 'Применить или изменить набор инструкций',
  },
  {
    name: 'pause',
    en: 'Pause the session and preserve ongoing work',
    ru: 'Приостановить сессию с сохранением работы',
  },
  { name: 'resume', en: 'Resume the selected session', ru: 'Продолжить работу выбранной сессии' },
  {
    name: 'notifications',
    en: 'Configure Telegram notifications',
    ru: 'Настроить уведомления бота',
  },
  {
    name: 'language',
    args: '[en|ru]',
    en: 'Choose English or Russian',
    ru: 'Выбрать русский или английский язык',
  },
  {
    name: 'modules',
    en: 'List integrations available on the server',
    ru: 'Посмотреть подключённые модули сервера',
  },
  { name: 'start', en: 'Open the session menu', ru: 'Открыть меню сессий' },
  {
    name: 'attach',
    args: 'SESSION_ID',
    scope: 'group',
    en: 'Reconnect the current topic to its session',
    ru: 'Привязать текущую тему к сессии',
    detail: {
      en: 'Run inside the topic with the unique session ID or its prefix (at least eight characters).',
      ru: 'Отправь в нужной теме уникальный ID сессии или его начало длиной от восьми символов.',
    },
  },
  {
    name: 'group',
    scope: 'private',
    en: 'Connect a Telegram group with topics',
    ru: 'Привязать группу Telegram с темами',
  },
  {
    name: 'updates',
    scope: 'private',
    en: 'Check and manage agent CLI updates',
    ru: 'Проверить и установить обновления CLI агентов',
  },
  {
    name: 'web',
    scope: 'private',
    en: 'Get a temporary browser sign-in link',
    ru: 'Получить временную ссылку для входа в браузер',
  },
  {
    name: 'cleanup',
    args: '[on|off|threshold N|interval N|skill PATH|clear-skill]',
    scope: 'private',
    en: 'Manage scheduled disk cleanup on the host',
    ru: 'Управлять плановой очисткой диска',
    detail: {
      en: 'threshold is the disk usage percentage. interval is in minutes (30 or more). skill takes a server Markdown path.',
      ru: 'threshold задаёт процент заполнения диска, interval — интервал от 30 минут. skill принимает путь к Markdown на сервере.',
    },
  },
  {
    name: 'cancel',
    scope: 'private',
    en: 'Cancel a pending private setup step',
    ru: 'Отменить ожидающий приватный шаг',
  },
];

export function telegramCommands(locale: Locale, scope: Scope) {
  return commands
    .filter((command) => !command.scope || command.scope === scope)
    .map((command) => ({ command: command.name, description: command[locale] }));
}

export function commandHelp(locale: Locale, scope: Scope, argument = '') {
  const ru = locale === 'ru',
    out = new TelegramText();
  const name = argument.trim().replace(/^\//, '').toLowerCase();
  if (name) {
    const command = commands.find((item) => item.name === name);
    if (!command)
      return out.add(
        ru
          ? 'Неизвестная команда. Открой список через /help.'
          : 'Unknown command. Use /help to see the list.',
      );
    out
      .add('/' + command.name + (command.args ? ' ' + command.args : ''), 'code')
      .add('\n' + command[locale]);
    if (!command.scope)
      out.add(
        '\n' +
          (ru
            ? 'Доступна в личке и в подключённой группе.'
            : 'Available in private chat and the connected group.'),
      );
    else
      out.add(
        '\n' +
          (command.scope === 'private'
            ? ru
              ? 'Доступна в личке бота.'
              : 'Available in the private bot chat.'
            : ru
              ? 'Доступна в теме подключённой группы.'
              : 'Available in a connected group topic.'),
      );
    if (command.name === 'notifications' && scope === 'private')
      out.add(
        '\n' +
          (ru
            ? '/notifications on, off или all переключает режим уведомлений.'
            : '/notifications on, off or all changes the notification mode.'),
      );
    if (command.detail) out.add('\n\n' + command.detail[locale]);
    return out;
  }
  out
    .add(ru ? 'Команды daddy' : 'daddy commands', 'bold')
    .add(
      '\n' + (ru ? 'Подробнее о команде — /help task.' : 'For command details, use /help task.'),
    );
  for (const command of commands.filter((item) => !item.scope || item.scope === scope))
    out
      .add('\n')
      .add('/' + command.name, 'bot_command')
      .add((command.args ? ' ' + command.args : '') + ' — ' + command[locale]);
  return out;
}

/** Returns undefined when a command explicitly addresses a different bot. */
export function normalizeTelegramCommand(text: string, username: string): string | undefined {
  const trimmed = text.trim();
  const match = /^\/([a-z][a-z0-9_]*)(?:@([a-z0-9_]+))?(?=\s|$)([\s\S]*)$/i.exec(trimmed);
  if (!match) return trimmed;
  if (match[2] && match[2].toLowerCase() !== username.toLowerCase()) return undefined;
  return `/${match[1].toLowerCase()}${match[3]}`;
}
