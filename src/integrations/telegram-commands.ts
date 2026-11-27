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
    detail: {
      en: 'Example: /help task. In a group you can address /help to this bot.',
      ru: 'Например, /help task. В группе можно указать имя бота после /help.',
    },
  },
  {
    name: 'task',
    args: 'text | [options] -- text | DADDY-ID',
    en: 'Queue work or open an existing task',
    ru: 'Поставить работу в очередь или открыть задачу',
    detail: {
      en: 'Send /task Fix search or /task DADDY-12ab34cd. Plan checking is on by default. Use --no-plan -- to skip it. Before -- you can set --worker 1..8, --model MODEL, --engine ENGINE and --effort LEVEL. To select the architect, use --architect-model MODEL, optionally with --architect-engine and --architect-effort. Use --architect-engine ENGINE alone for its configured profile. Effort requires a model. Worker engine and effort flags require --model. Example: /task --worker 2 -- Fix search.',
      ru: 'Напиши /task Почини поиск или /task DADDY-12ab34cd. Проверка плана включена. Для пропуска используй --no-plan --. Перед -- доступны --worker 1..8, --model МОДЕЛЬ, --engine ДВИЖОК и --effort УРОВЕНЬ. Для архитектора укажи --architect-model МОДЕЛЬ, при необходимости --architect-engine и --architect-effort. Для штатного профиля архитектора достаточно --architect-engine ДВИЖОК. Для уровня нужна модель. Движок и уровень воркера требуют --model. Пример: /task --worker 2 -- Почини поиск.',
    },
  },
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
    args: 'N MODEL [EFFORT|default] [--engine ENGINE] [--force] | N --engine ENGINE [--force]',
    en: 'Change the profile of a numbered worker',
    ru: 'Изменить профиль воркера по номеру',
    detail: {
      en: 'Without --force the profile applies to the next task. --force asks you to confirm a specific active task before restarting its author turn in the same copy. Use default to clear the reasoning effort. Use /worker N --engine ENGINE for the engine configuration. Use /models for available profiles.',
      ru: 'Обычно смена применяется к следующей задаче. --force запрашивает подтверждение для конкретной задачи перед перезапуском её хода в той же копии. Укажи default, чтобы вернуться к штатному уровню. /worker N --engine ENGINE возвращает настройки движка. Доступные модели показывает /models.',
    },
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
    args: '[SESSION_ID]',
    en: 'Choose a session explicitly',
    ru: 'Выбрать сессию явно',
  },
  {
    name: 'agents',
    args: '[daddy|worker ENGINE [MODEL [EFFORT]]]',
    scope: 'private',
    en: 'Inspect or change the default agent profiles',
    ru: 'Посмотреть или сменить общие профили агентов',
  },
  {
    name: 'concurrency',
    args: '1..8',
    scope: 'private',
    en: 'Set the total number of concurrent agents',
    ru: 'Задать общий предел параллельных агентов',
  },
  {
    name: 'export',
    args: 'SESSION_ID',
    scope: 'private',
    en: 'Download session instructions as JSON',
    ru: 'Скачать инструкции сессии в JSON',
  },
  {
    name: 'preset_parts',
    args: 'ID [1,2,...|all|off]',
    en: 'Choose components of an applied preset',
    ru: 'Выбрать компоненты подключённого пресета',
  },
  {
    name: 'preset_export',
    args: 'ID',
    scope: 'private',
    en: 'Download a preset as JSON',
    ru: 'Скачать пресет в JSON',
  },
  {
    name: 'preset_remove',
    args: 'ID REVISION',
    scope: 'private',
    en: 'Delete a specific preset revision',
    ru: 'Удалить указанную версию пресета',
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
    name: 'workspace_defaults',
    args: '[ID UPDATED_AT JSON]',
    scope: 'private',
    en: 'Read or edit the defaults of a saved repository',
    ru: 'Посмотреть или изменить настройки сохранённого репозитория',
  },
  {
    name: 'repo',
    args: '[default | path | JSON]',
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
    args: '[daddy|worker text|--clear]',
    en: 'Read or change session instructions',
    ru: 'Посмотреть или изменить инструкции сессии',
    detail: {
      en: 'Use /instructions to view both roles, /instructions worker TEXT to set a prompt, or /instructions worker --clear to clear that role.',
      ru: 'Без аргументов показывает инструкции обеих ролей. /instructions worker ТЕКСТ задаёт инструкции воркера, /instructions worker --clear очищает настройки этой роли.',
    },
  },
  {
    name: 'skill',
    args: 'daddy|worker GITHUB_URL',
    en: 'Attach a GitHub skill to the selected role',
    ru: 'Подключить скилл с GitHub к выбранной роли',
  },
  {
    name: 'skill_source',
    args: 'SESSION_ID daddy|worker JSON',
    scope: 'private',
    en: 'Import a skill using the same sources as the web',
    ru: 'Импортировать навык из источников веб-интерфейса',
    detail: {
      en: 'For a Markdown attachment use the caption /skill_file SESSION_ID ROLE [RELATIVE_PATH]. Use /skill_source with a JSON source, for example {"kind":"text","name":"Style","text":"Use short paragraphs."}.',
      ru: 'Приложи Markdown с подписью /skill_file ID_СЕССИИ РОЛЬ [ПУТЬ]. Для /skill_source укажи источник в JSON, например {"kind":"text","name":"Style","text":"Пиши короткими абзацами."}.',
    },
  },
  {
    name: 'presets',
    en: 'List saved instruction presets',
    ru: 'Посмотреть готовые наборы инструкций',
    detail: {
      en: 'In private chat attach a JSON document with caption /preset_create NAME or /preset_edit ID REVISION NAME. /preset_export ID downloads it. /export SESSION_ID downloads session instructions and a document captioned /import SESSION_ID loads them.',
      ru: 'В личке приложи JSON с подписью /preset_create НАЗВАНИЕ или /preset_edit ID ВЕРСИЯ НАЗВАНИЕ. /preset_export ID скачивает пресет. /export ID_СЕССИИ скачивает инструкции, а документ с подписью /import ID_СЕССИИ загружает их обратно.',
    },
  },
  {
    name: 'preset',
    args: 'name',
    en: 'Apply a saved preset to this session',
    ru: 'Применить набор инструкций к сессии',
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
      en: 'threshold is the disk usage percentage. interval is in minutes (30 or more). skill takes a server Markdown path. Example: /cleanup threshold 89.',
      ru: 'threshold задаёт процент заполнения диска, interval — интервал от 30 минут. skill принимает путь к Markdown на сервере. Пример: /cleanup threshold 89.',
    },
  },
  {
    name: 'cancel',
    en: 'Cancel a pending workspace registration step',
    ru: 'Отменить текущий шаг регистрации репозитория',
  },
];

export function telegramCommands(locale: Locale, scope: Scope) {
  return commands
    .filter((c) => !c.scope || c.scope === scope)
    .map((c) => ({ command: c.name, description: c[locale] }));
}

export function commandHelp(locale: Locale, scope: Scope, argument = '') {
  const ru = locale === 'ru',
    out = new TelegramText();
  const name = argument.trim().replace(/^\//, '').toLowerCase();
  if (name) {
    const cmd = commands.find((c) => c.name === name);
    if (!cmd)
      return out.add(
        ru
          ? 'Неизвестная команда. Открой список через /help.'
          : 'Unknown command. Use /help to see the list.',
      );
    out.add('/' + cmd.name + (cmd.args ? ' ' + cmd.args : ''), 'code').add('\n' + cmd[locale]);
    if (!cmd.scope)
      out.add(
        '\n' +
          (ru
            ? 'Доступна в личке и в подключённой группе.'
            : 'Available in private chat and the connected group.'),
      );
    if (cmd.scope)
      out.add(
        '\n' +
          (cmd.scope === 'private'
            ? ru
              ? 'Доступна в личке бота.'
              : 'Available in the private bot chat.'
            : ru
              ? 'Доступна в теме подключённой группы.'
              : 'Available in a connected group topic.'),
      );
    if (cmd.name === 'notifications' && scope === 'private')
      out.add(
        '\n' +
          (ru
            ? '/notifications on, off или all переключает режим уведомлений.'
            : '/notifications on, off or all changes the notification mode.'),
      );
    if (cmd.detail) out.add('\n\n' + cmd.detail[locale]);
    return out;
  }
  out
    .add(ru ? 'Команды daddy' : 'daddy commands', 'bold')
    .add(
      '\n' + (ru ? 'Подробнее о команде — /help task.' : 'For command details, use /help task.'),
    );
  for (const cmd of commands.filter((c) => !c.scope || c.scope === scope))
    out
      .add('\n')
      .add('/' + cmd.name, 'bot_command')
      .add((cmd.args ? ' ' + cmd.args : '') + ' — ' + cmd[locale]);
  return out;
}

export function normalizeTelegramText(value: string | undefined, username: string) {
  const text = value?.trim();
  const command = text && /^\/([a-z0-9_]+)(?:@([a-z0-9_]+))?(?=\s|$)/i.exec(text);
  if (!command) return text;
  if (command[2] && command[2].toLowerCase() !== username.toLowerCase()) return;
  return '/' + command[1].toLowerCase() + text.slice(command[0].length);
}
