import { translate, type Locale } from '../i18n/index.js';
import type { TextEntity } from './telegram-text.js';
import type { NotificationPreferences } from './notifications.js';
import { TelegramText, type TelegramCard, type TelegramButton } from './telegram-text.js';

class LocalText extends TelegramText {
  constructor(readonly locale: Locale) {
    super();
  }
  override add(
    text: string,
    type?: TextEntity['type'],
    extra: Pick<TextEntity, 'url' | 'language'> = {},
  ) {
    return super.add(translate(this.locale, text), type, extra);
  }
  literal(text: string, type?: TextEntity['type']) {
    return super.add(text, type);
  }
}
const card = (text: LocalText, buttons?: TelegramButton[][]): TelegramCard => ({
  text: text.text,
  entities: text.entities,
  buttons: buttons?.map((row) =>
    row.map((button) => ({
      ...button,
      text: /^\d+ · /.test(button.text) ? button.text : translate(text.locale, button.text),
    })),
  ),
});
const navigation = (): TelegramButton[][] => [
  [
    { text: '📋 Задачи', callback_data: 'dad:sessions' },
    { text: '🔔 Уведомления', callback_data: 'notifications:show' },
  ],
  [
    { text: '🌐 Language', callback_data: 'language:show' },
    { text: '🤖 Models', callback_data: 'models:refresh' },
    { text: '⬆️ Updates', callback_data: 'updates:show' },
  ],
];
export function notificationsCard(
  prefs: NotificationPreferences,
  locale: Locale = 'ru',
): TelegramCard {
  const mode = !prefs.enabled ? 'off' : prefs.mode,
    text = new LocalText(locale).add('🔔 Уведомления', 'bold').add('\n\n');
  text
    .add(mode === 'off' ? 'Выключены' : mode === 'attention' ? 'Тихий режим' : 'Все ответы', 'bold')
    .add('\n');
  text.add(
    mode === 'off'
      ? 'Бот отвечает на команды, но не присылает обновления задач.'
      : mode === 'attention'
        ? 'Сообщу, когда задача завершится или понадобится твоё решение. Ответы агентов остаются в рабочем пространстве.'
        : 'Буду присылать ответы daddy и важные этапы задач.',
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
  buttons.push([{ text: '📋 Задачи', callback_data: 'dad:sessions' }]);
  return card(text, buttons);
}
export function noteCard(title: string, body: string, locale: Locale = 'ru'): TelegramCard {
  return card(new LocalText(locale).add(title, 'bold').add('\n\n').add(body), navigation());
}
export function errorCard(message: string, locale: Locale = 'ru'): TelegramCard {
  const text = new LocalText(locale)
    .add('⚠️ Проверь результат действия', 'bold')
    .add('\n\n')
    .add(message)
    .add('\n\nПосмотри текущий статус задачи перед повтором.');
  return card(text, navigation());
}
