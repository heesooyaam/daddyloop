export const daddyRu: Record<string, string> = {
  'Voice message was not sent to daddy': 'Голосовое не передано daddy',
  'Recognized voice message': 'Распознано голосовое',
  'Voice recognition is unavailable on this server.':
    'Распознавание голосовых недоступно на этом сервере.',
  'Start a daddy session in a workspace, then send the voice message.':
    'Сначала создай сессию daddy в воркспейсе, затем отправь голосовое.',
  'Voice messages can be at most 5 minutes and 10 MB.':
    'Голосовое должно быть не длиннее 5 минут и не больше 10 МБ.',
  'Voice messages can be at most 5 minutes long': 'Голосовое должно быть не длиннее 5 минут.',
  'Voice messages can be at most 10 MB': 'Голосовое должно быть не больше 10 МБ.',
  'Voice message queued. Recognition language: {language}.':
    'Голосовое в очереди. Язык распознавания: {language}.',
  'The voice inbox is full. Wait for the previous messages.':
    'Очередь голосовых заполнена. Дождись обработки предыдущих сообщений.',
  'The voice message belongs to a previous Telegram connection.':
    'Голосовое относится к прежнему подключению Telegram.',
  'The session changed while recognizing the voice. Send it again to continue.':
    'Пока шло распознавание, сессия изменилась. Пришли голосовое ещё раз.',
  'Voice recognition failed': 'Не удалось распознать голосовое.',
  'Unsupported voice recording': 'Поддерживаются обычные голосовые Telegram в формате OGG/Opus.',
  'Invalid voice recording': 'Не удалось прочитать запись. Пришли голосовое ещё раз.',
  'No audible speech in the recording': 'В записи не слышно речи.',
  'Could not recognize a clear voice message':
    'Не удалось разобрать речь. Пришли голосовое ещё раз.',
  'Voice recognition timed out. Send a shorter recording.':
    'Распознавание заняло слишком много времени. Пришли запись покороче.',
  'Voice recognition was interrupted; the recording is preserved.':
    'Распознавание прервано; запись сохранена.',
  'Could not download the voice message': 'Не удалось скачать голосовое из Telegram.',
  'Install the release with voice support, or run npm run speech:prepare for a source checkout.':
    'Установи релиз с голосовыми. При запуске из исходников выполни npm run speech:prepare.',
  'New session created: {title}': 'Создана новая сессия: {title}',
  'Open session': 'Открыть сессию',
  'Language updated.': 'Язык изменён.',
  'Open the private bot chat for CLI updates.': 'Для обновления CLI открой личный чат с ботом.',
  'Open private chat': 'Открыть личный чат',
  'Send /group in the private bot chat to connect a Telegram group.':
    'Для подключения группы отправь /group в личном чате с ботом.',
  'Group selection expired. Send /group again.': 'Выбор группы истёк. Отправь /group ещё раз.',

  'Codex currently blocks included usage.':
    'Codex сейчас ограничивает использование включённой квоты.',
  'Resolve pending reset': 'Завершить ожидающий сброс',
  Limits: 'Лимиты',
  'Codex limits': 'Лимиты Codex',
  'Use a reset': 'Использовать сброс',
  'Refresh limits': 'Обновить лимиты',
  'Confirm: use one reset': 'Подтвердить: использовать один сброс',
  'daddy and writers share the Codex account limits on this server.':
    'daddy и писатели используют общие лимиты аккаунта Codex на этом сервере.',
  'Limits are unavailable. Sign in to Codex and refresh.':
    'Лимиты недоступны. Войди в Codex и обнови данные.',
  'These readings are outdated. Refresh before using a reset.':
    'Данные устарели. Перед использованием сброса обнови лимиты.',
  'Quota window': 'Период квоты',
  '{count} days': '{count} дн.',
  '{count} hours': '{count} ч.',
  '{count} minutes': '{count} мин.',
  '{window}: {remaining}% remaining': '{window}: осталось {remaining}%',
  'Resets: {time}': 'Обновится: {time}',
  'Credits: unlimited': 'Кредиты: без ограничений',
  'Credit balance: {balance}': 'Остаток кредитов: {balance}',
  'Available resets: unknown': 'Доступные сбросы: нет данных',
  'Available resets: {count}': 'Доступно сбросов: {count}',
  '{title} · expires {time}': '{title} · действует до {time}',
  'Expires: {time}': 'Действует до {time}',
  'Checked: {time}': 'Проверено: {time}',
  'Use one available reset for the Codex account on this server? Existing conversations and files are kept.':
    'Использовать один доступный сброс лимитов аккаунта Codex на этом сервере? Существующие разговоры и файлы сохранятся.',
  'If the response is lost, retry this same operation. It will not spend a second reset.':
    'Если ответ потеряется, повтори эту же операцию. Второй сброс не спишется.',
  'One reset was used. Limits were requested again from Codex.':
    'Использован один сброс. Данные лимитов заново запрошены у Codex.',
  'This reset was already applied. No second reset was requested.':
    'Этот сброс уже применён. Повторного списания не было.',
  'Codex reports no eligible limit to reset.':
    'Codex сообщил, что сейчас нет подходящего лимита для сброса.',
  'Codex reports no available resets.': 'Codex сообщил, что доступных сбросов нет.',
  'Usage controls are unavailable on this server.':
    'Управление лимитами недоступно на этом сервере.',
  'Rate-limit reset': 'Сброс лимитов',
  'Full reset': 'Полный сброс',
  'Codex changed. Refresh the limits again.': 'Версия Codex изменилась. Обнови лимиты ещё раз.',
  'Resolve the pending reset from the client that started it.':
    'Заверши ожидающий сброс в том клиенте, где он был запущен.',
  'Codex did not provide an account identity for a safe reset.':
    'Codex не передал идентификатор аккаунта для проверки сброса.',
  'No available rate-limit resets.': 'Доступных сбросов лимитов нет.',
  'A rate-limit reset is already running.': 'Сброс лимитов уже выполняется.',
  'Reset request not found.': 'Запрос сброса не найден.',
  'This reset request expired. Open limits again.':
    'Срок подтверждения истёк. Открой лимиты ещё раз.',
  'Resolve the pending reset before starting another.': 'Сначала заверши ожидающий сброс.',
  'The Codex account changed. This reset was not sent.':
    'Аккаунт Codex изменился. Запрос сброса не отправлен.',
  'The selected reset is no longer available. Open limits again.':
    'Выбранный сброс больше не доступен. Открой лимиты ещё раз.',

  'Pool: {limit} → {target}. Changes apply in the background.':
    'Пул: {limit} → {target}. Изменение применяется в фоне.',
  'Pool: {limit}. Occupied by tasks: {occupied}.': 'Пул: {limit}. Занято задачами: {occupied}.',
  'Pool changes apply in the background. Busy writers finish their tasks, including review fixes.':
    'Размер пула меняется в фоне. Занятые писатели завершают задачи, включая исправления после ревью.',
  'Repository on this server': 'Репозиторий на этом сервере',
  'Browse server folders': 'Выбрать папку на сервере',
  'Parent folder': 'Родительская папка',
  'Use this folder once': 'Использовать для этой задачи',
  'Starting directory (relative)': 'Начальная папка внутри репозитория',
  'Use workspace defaults': 'Как в воркспейсе',
  'This selection applies only to this request. Workspace defaults and existing tasks stay as saved.':
    'Выбор действует только для этого запроса. Настройки воркспейса и существующих задач сохраняются.',
  'Repository for this request': 'Репозиторий для этого запроса',
  'Using workspace defaults': 'По настройкам воркспейса',
  'Repository for next task': 'Репозиторий для следующей задачи',
  'Send the task now. The following message will use the defaults again.':
    'Теперь отправь задачу. Для следующего сообщения снова будут действовать настройки по умолчанию.',
  'This selection expired. Choose the repository again.':
    'Срок выбора истёк. Выбери репозиторий ещё раз.',
  'You can also send /repo followed by an absolute server path.':
    'Можно также отправить /repo и полный путь к папке на сервере.',
  'Default changes apply to new sessions on this server. Existing sessions keep their settings.':
    'Новые настройки действуют для новых сессий на этом сервере. Существующие сессии сохраняют свои настройки.',
  'This ticket already has a task in another workspace. Its running work cannot be moved.':
    'Этот тикет уже выполняется в другой рабочей копии. Начатую работу нельзя перенести.',
  'Use /repo <path> for the next message, or /repo default to reset.':
    '/repo <путь> — репозиторий для следующего сообщения; /repo default — сброс.',

  'Your daddyloop workspace.': 'Твоё рабочее пространство daddyloop.',
  'Previous work history': 'История прежних задач',
  'Open the topic for the session you want to continue.':
    'Открой тему сессии, которую хочешь продолжить.',
  'Private setup and CLI updates': 'Подключение и обновления CLI в личке',
  'This model selection expired. Open Models again.': 'Выбор модели истёк. Открой модели ещё раз.',
  'One conversation. A whole team.': 'Один разговор. Целая команда.',
  'New session': 'Новая сессия',
  'Your sessions': 'Твои сессии',
  'YOUR SESSIONS': 'ТВОИ СЕССИИ',
  Sessions: 'Сессии',
  done: 'готово',
  'Your next workspace starts with a conversation.': 'Следующий воркспейс начинается с разговора.',
  Workspaces: 'Воркспейсы',
  Workspace: 'Воркспейс',
  'Select writer and daddy models independently.': 'Выбирай модели писателя и daddy независимо.',
  Notifications: 'Уведомления',
  'CLI updates': 'Обновления CLI',
  'Running on your server': 'Работает на твоём сервере',
  'Connecting to server': 'Подключение к серверу',
  'Close menu': 'Закрыть меню',
  'What are we building?': 'Что будем делать?',
  'Session settings': 'Настройки сессии',
  'Conversation with daddy': 'Разговор с daddy',
  'Send me the goal. I will take care of the writers, reviews and follow-through.':
    'Расскажи, что нужно сделать. Я займусь писателями, ревью и доведу работу до результата.',
  'daddy is working': 'daddy работает',
  'Message daddy': 'Написать daddy',
  'Resume daddy to continue': 'Сними паузу, чтобы продолжить',
  'A goal, a ticket link, or a question…': 'Задача, ссылка на тикет или вопрос…',
  'Writers at work: {count}': 'Работают писатели: {count}',
  'daddy handles the details.': 'Деталями занимается daddy.',
  'Enter to send · Shift+Enter for a new line · Closing this page keeps work running':
    'Enter — отправить · Shift+Enter — новая строка · Можно закрыть страницу: работа продолжится',
  'Your team': 'Твоя команда',
  'Writer pool': 'Пул писателей',
  'Maximum writers': 'Максимум писателей',
  'daddy decides what can run in parallel.': 'daddy сам решает, что можно выполнять параллельно.',
  'Prerequisites: {count}': 'Зависимостей: {count}',
  'daddy will put the plan and work items here as you discuss the goal.':
    'Здесь появятся задачи, которые daddy выделит во время обсуждения.',
  'Add tasks through daddy': 'Добавить задачи через daddy',
  'One daddy. Shared context.': 'Один daddy. Общий контекст.',
  'Meet your coding team': 'ТВОЯ КОМАНДА ДЛЯ РАЗРАБОТКИ',
  'You bring the idea.': 'С тебя идея.',
  'daddy takes it from here.': 'Дальше займётся daddy.',
  'Choose a workspace and talk to one agent. daddy turns the goal into tasks, manages a pool of writers and reviews their work.':
    'Выбери воркспейс и общайся с одним агентом. daddy разложит цель на задачи, распределит работу между писателями и проверит результат.',
  'Start a session': 'Начать сессию',
  'Add your first workspace': 'Добавить первый воркспейс',
  'Choose a workspace': 'Выбрать воркспейс',
  'Talk to daddy': 'Обсудить с daddy',
  'Review the result': 'Посмотреть результат',
  'New daddy session': 'Новая сессия daddy',
  'Workspaces on this server': 'Воркспейсы на сервере',
  'Notifications and Telegram': 'Уведомления и Telegram',
  'One topic per daddy session': 'Своя тема для каждой сессии daddy',
  'Send /group to your bot to connect a group with topics. Each session gets a topic automatically.':
    'Отправь боту /group, чтобы подключить группу с темами. Для каждой сессии тема создаётся автоматически.',
  'Open Telegram': 'Открыть Telegram',
  'Work item': 'Задача',
  'Add a workspace first': 'Сначала добавь воркспейс',
  'Register another workspace': 'Зарегистрировать ещё воркспейс',
  'What should daddy do?': 'Что поручим daddy?',
  'Describe the goal or paste one or more ticket links. You can start with a discussion.':
    'Опиши цель или вставь ссылки на тикеты. Можно начать с обсуждения.',
  'Session name (optional)': 'Название сессии (необязательно)',
  'Starts with one writer. Change the pool size at any time; daddy decides when to use more.':
    'По умолчанию один писатель. Размер пула можно изменить в любой момент; daddy сам решит, когда нужны дополнительные писатели.',
  'Start session': 'Начать сессию',
  'Register the source folder once. Agents use separate working copies; your checkout and local edits stay in place.':
    'Зарегистрируй исходную папку один раз. Агенты используют отдельные рабочие копии; твоя папка и локальные изменения сохраняются.',
  'Repository root': 'Корень репозитория',
  'Detected repositories': 'Найденные репозитории',
  'Parent directory': 'Родительская папка',
  'Server directory': 'Папка на сервере',
  'Absolute path on the server': 'Абсолютный путь на сервере',
  Open: 'Открыть',
  'No subdirectories': 'Нет вложенных папок',
  'Only the first 150 folders are shown. Enter a more specific path above.':
    'Показаны первые 150 папок. Выше можно указать более точный путь.',
  'Workspace name': 'Название воркспейса',
  'Base branch (optional)': 'Базовая ветка (необязательно)',
  'Selecting a subdirectory sets the agent’s starting folder inside each working copy.':
    'Выбранная подпапка станет стартовой папкой агента внутри каждой рабочей копии.',
  'Save workspace': 'Сохранить воркспейс',
  'New writers': 'Новые писатели',
  Model: 'Модель',
  'Reasoning effort': 'Уровень рассуждений',
  Default: 'По умолчанию',
  'Writer defaults apply to new tasks. Changing daddy’s model requires his session to be idle.':
    'Настройки писателей применяются к новым задачам. Модель daddy можно менять, когда его сессия свободна.',
  'Save settings': 'Сохранить настройки',
  'Open native review': 'Открыть ревью',
  'Approve plan': 'Подтвердить план',
  'Original requirements': 'Исходные требования',
  'Read-only worker reports': 'Отчёты писателей — только чтение',
  'Discuss changes with daddy in the main conversation. He will send the instructions to the right writer.':
    'Обсуждай изменения с daddy в основном разговоре. Он передаст инструкции нужному писателю.',
  Writer: 'Писатель',
  Writers: 'Писатели',
  writers: 'писателей',
  new: 'новая',
  sessions: 'сессии',
  'Waiting for daddy': 'Ожидает daddy',
  'Writing code': 'Пишет код',
  'daddy is reviewing': 'daddy проводит ревью',
  'Addressing feedback': 'Исправляет замечания',
  'Waiting for submission': 'Ожидает отправки',
  'Waiting for CI': 'Ожидает CI',
  'daddy is checking': 'daddy разбирается',
  Working: 'В работе',
  'Give daddy a goal or a ticket. He plans the work, manages writers and reviews the result.':
    'Отправь daddy цель или тикет. Он составит план, распределит работу между писателями и проверит результат.',
  'Telegram group': 'Группа с темами',
  'Workspaces are folders on the server. daddy creates separate working copies for writers.':
    'Воркспейсы — это папки на сервере. daddy создаёт отдельные рабочие копии для писателей.',
  'Find workspaces on the server': 'Найти воркспейсы на сервере',
  'Writers: {active} / {limit}': 'Писатели: {active} / {limit}',
  'Completed: {done} / {total}': 'Готово: {done} / {total}',
  'Send another ticket or describe what you need in this conversation. daddy handles the writers.':
    'Присылай сюда новые тикеты или описывай, что нужно сделать. Писателями занимается daddy.',
  'Open session topic': 'Открыть тему сессии',
  'Add tasks': 'Добавить задачи',
  'Resume daddy': 'Продолжить с daddy',
  'Pause daddy': 'Поставить daddy на паузу',
  'Choose the maximum number of writers working at once. daddy decides which tasks can run in parallel. Existing work finishes when the limit is reduced.':
    'Выбери максимум одновременно работающих писателей. daddy решит, какие задачи можно распараллелить. При уменьшении лимита текущая работа спокойно завершится.',
  Back: 'Назад',
  'Telegram group connected': 'Группа подключена',
  'Create a Telegram group, enable Topics, then choose it below. Telegram can add the bot with permission to manage topics. Each daddy session will get its own topic.':
    'Создай группу Telegram, включи «Темы» и выбери её кнопкой ниже. Telegram сможет добавить бота с правом управления темами. У каждой сессии daddy будет своя тема.',
  'Choose a group with topics': 'Выбрать группу с темами',
  'Group selection expired. Send /workspace again.':
    'Выбор группы истёк. Отправь /workspace ещё раз.',
  'Enable Topics and make the bot an administrator with Manage Topics permission, then select the group again.':
    'Включи «Темы» и назначь бота администратором с правом управления темами, затем выбери группу ещё раз.',
  'Workspace connected: {name}': 'Группа подключена: {name}',
  'Create a new session from the private bot chat.': 'Создай новую сессию в личном чате с ботом.',
  'Manage workspaces in the private bot chat.':
    'Управлять воркспейсами можно в личном чате с ботом.',
  'Choose a repository to register it. You can choose a subdirectory and base branch on the website.':
    'Выбери репозиторий для регистрации. На сайте также можно выбрать подпапку и базовую ветку.',
  'This selection expired. Open Workspaces again.': 'Выбор истёк. Открой воркспейсы ещё раз.',
  'This selection expired. Start a new session again.':
    'Выбор истёк. Начни создание сессии ещё раз.',
  'Send a ticket link, several tickets, or a description of the next task. daddy will add it to this session.':
    'Отправь ссылку на тикет, несколько тикетов или описание следующей задачи. daddy добавит работу в эту сессию.',
  'Write to daddy here. He sends instructions to the writers.':
    'Пиши здесь daddy. Он сам передаст инструкции писателям.',
  'Open a session topic, or send /new here to create one.':
    'Открой тему сессии или отправь здесь /new, чтобы создать новую.',
  'The topic may already exist. Open it and send /attach {id} to reconnect this session.':
    'Тема уже могла быть создана. Открой её и отправь /attach {id}, чтобы подключить к этой сессии.',
  'Telegram may have created the topic. Open that topic and send /attach followed by the daddy session ID; do not create a duplicate.':
    'Telegram уже мог создать тему. Открой её и отправь /attach с ID сессии daddy, чтобы восстановить связь.',
  'Could not complete the action': 'Не удалось выполнить действие',
  'Tasks and writer pool': 'Задачи и пул писателей',
  'Start a daddy session first.': 'Сначала создай сессию daddy.',
  'Use /help to see the daddy commands.': 'Список команд daddy доступен по /help.',
  'daddyloop commands': 'Команды daddyloop',
  'Choose a role': 'Чью модель настроить?',
  'Choose a model': 'Выбрать модель',
  'Talk to daddy in plain language. Paste goals or ticket links; he handles the writers.':
    'Общайся с daddy обычным текстом. Отправляй цели и ссылки на тикеты; писателями занимается он.',
  'Ctrl+N new session · Ctrl+T sessions · Tab chat/tasks · PgUp/PgDn scroll · Ctrl+Q exit':
    'Ctrl+N — новая сессия · Ctrl+T — сессии · Tab — чат/задачи · PgUp/PgDn — прокрутка · Ctrl+Q — выход',
  'Register folders with daddy workspaces add <path> --name <name>, or use Workspaces on the website.':
    'Зарегистрировать папку можно командой daddy workspaces add <path> --name <name> или в разделе «Воркспейсы» на сайте.',
  'Install or roll back Codex from /updates in Telegram, or use daddy runtime update --yes.':
    'Обновить или откатить Codex можно через /updates в Telegram или командой daddy runtime update --yes.',
  '↑ ↓ choose · Enter confirm · Esc back': '↑ ↓ — выбрать · Enter — подтвердить · Esc — назад',
  'You bring the idea. daddy takes it from here.': 'С тебя идея. Дальше займётся daddy.',
  'Commands and shortcuts': 'Команды и сочетания клавиш',
  'Enter send · Ctrl+J newline · /help · Ctrl+Q exit':
    'Enter — отправить · Ctrl+J — новая строка · /help · Ctrl+Q — выход',
  'daddyloop console closed. Work continues on the server.':
    'Консоль daddyloop закрыта. Работа продолжается на сервере.',
  'Run daddy in a terminal, or use daddy --help for commands.':
    'Запусти daddy в терминале или используй daddy --help для списка команд.',
  'Choose a registered workspace.': 'Выбери зарегистрированный воркспейс.',
  'Only important updates': 'Только важные уведомления',
  'All updates': 'Все уведомления',
  'Mute notifications': 'Выключить уведомления',
  'One daddy, a pool of writers, and persistent work on your server':
    'Один daddy, пул писателей и непрерывная работа на твоём сервере',
  'Register and choose workspace folders on the server':
    'Регистрация и выбор папок воркспейсов на сервере',
  'Find repositories on the server': 'Найти репозитории на сервере',
  'Browse server directories': 'Посмотреть папки на сервере',
  'Register a workspace once for phone, web and CLI':
    'Зарегистрировать воркспейс для телефона, сайта и CLI',
  'List daddy sessions and writer pools': 'Показать сессии daddy и пулы писателей',
  'maximum simultaneous writers': 'максимум одновременно работающих писателей',
  'Give daddy a goal in a registered workspace':
    'Поручить daddy цель в зарегистрированном воркспейсе',
  'Send a goal, ticket or question to daddy': 'Отправить daddy цель, тикет или вопрос',
  'Inspect or resize a session’s writer pool': 'Посмотреть или изменить пул писателей сессии',
  'Send instructions to daddy; writers receive tasks only from him':
    'Отправь инструкции daddy; писатели получают задачи только от него',
  'Resume daddy before sending another message': 'Сними daddy с паузы перед новым сообщением',
  'Wait for this session to become idle before changing its models':
    'Дождись завершения текущего хода daddy перед сменой его модели',
  'Choose between 1 and 8 writers': 'Выбери от 1 до 8 писателей',
  'Use a relative directory inside the repository': 'Укажи относительную папку внутри репозитория',
  'Choose an absolute directory on the server': 'Выбери абсолютный путь к папке на сервере',
  'Choose a directory inside a configured workspace root':
    'Выбери папку внутри настроенных каталогов воркспейсов',
  'Choose a Git or mounted Arcadia repository': 'Выбери Git-репозиторий или смонтированную Arcadia',
  'Add a GitHub or GitLab remote before registering this workspace':
    'Перед регистрацией добавь в репозиторий remote GitHub или GitLab',
  'Waiting for a free, clean Arc workspace. Existing source checkouts and writer changes are preserved.':
    'Ожидаем свободную чистую рабочую копию Arcadia. Исходные папки и изменения писателей сохранены.',
  'Waiting for an Arc writer slot; one workspace is reserved for daddy and review.':
    'Ожидаем свободный слот Arcadia для писателя; одна рабочая копия зарезервирована для daddy и ревью.',
};
