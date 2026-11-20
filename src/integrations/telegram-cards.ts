import { translate, translator, type Locale } from '../i18n/index.js';
import type { TextEntity } from './telegram-text.js';
import type { NotificationPreferences } from './notifications.js';
import { TelegramText, type TelegramCard, type TelegramButton } from './telegram-text.js';
import type { CleanupReport } from '../ops/scheduled-cleanup.js';

export function scheduledCleanupCard(locale: Locale, report: CleanupReport) {
  const t = translator(locale);
  const outcomes = {
    cleared: 'Disk usage is now within the cleanup threshold.',
    still_high: 'Disk usage is still above the cleanup threshold.',
    failed: 'Scheduled cleanup ended with an error. See daddy cache schedule.',
    interrupted: 'Scheduled cleanup was interrupted.',
  };
  const gain = Math.max(0, report.after.diskAvailableGiB - report.before.diskAvailableGiB);
  return new TelegramText()
    .add(t('Scheduled cache cleanup'), 'bold')
    .add(
      '\n\n' +
        t('Disk usage {before}% → {after}%. Free space gained {gain} GiB.', {
          before: report.before.diskUsedPercent.toFixed(1),
          after: report.after.diskUsedPercent.toFixed(1),
          gain: gain.toFixed(2),
        }),
    )
    .add('\n' + t(outcomes[report.status]));
}

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
    { text: 'Sessions', callback_data: 'dad:home' },
    { text: 'Settings', callback_data: 'dad:settings' },
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
  buttons.push([{ text: 'Back', callback_data: 'dad:settings' }]);
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
