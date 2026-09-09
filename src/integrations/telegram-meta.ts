import { TelegramText, type TelegramCard } from './telegram-text.js';
import { translator, localeNames, type Locale } from '../i18n/index.js';
import type { AgentProfiles } from '../core/types.js';
import type { ModelOption, ModelCatalogueInfo } from '../core/agents.js';
import type { UpdateNotice, UpdateStatus } from '../core/updates.js';
export function languageCard(locale: Locale): TelegramCard {
  const t = translator(locale),
    text = new TelegramText()
      .add('🌐 ' + t('Language'), 'bold')
      .add('\n\n')
      .add(
        t(
          'This is the interface language. Task and conversation content is kept in its original language.',
        ),
      );
  return {
    ...text,
    buttons: [
      Object.entries(localeNames).map(([value, name]) => ({
        text: (value === locale ? '✓ ' : '') + name,
        callback_data: `language:${value}`,
      })),
      [{ text: '📋 ' + t('Tasks'), callback_data: 'tasks:0' }],
    ],
  };
}
export function modelsCard(
  locale: Locale,
  profiles: AgentProfiles,
  models: ModelOption[],
  info?: ModelCatalogueInfo,
): TelegramCard {
  const t = translator(locale),
    text = new TelegramText().add('🤖 ' + t('Models'), 'bold').add('\n\n');
  for (const role of ['author', 'reviewer'] as const)
    text
      .add(t(role === 'author' ? 'Author' : 'Reviewer') + ': ', 'bold')
      .add(profiles[role].model ?? t('Codex configuration'), 'code')
      .add(profiles[role].effort ? ` / ${profiles[role].effort}` : '')
      .add('\n');
  text
    .add('\n')
    .add(t('Select an author or reviewer model independently.'))
    .add('\n')
    .add('/defaults', 'code')
    .add(' · ')
    .add('/models', 'code')
    .add(' — reviewctl\n\n');
  for (const model of models)
    text.add(model.id, 'code').add('\n' + model.efforts.join(' · ') + '\n\n');
  text.add(t('Source: Codex app-server model/list')).add('\n');
  if (info?.cliVersion) text.add('Codex CLI ' + info.cliVersion).add('\n');
  if (info?.retrievedAt)
    text
      .add(t('Retrieved: {time}', { time: new Date(info.retrievedAt).toLocaleString(locale) }))
      .add('\n');
  text
    .add(t('Cached for up to 5 minutes. Refresh queries the CLI again.'))
    .add('\n\n')
    .add(t('Claude integration is not implemented yet.'));
  return {
    ...text,
    buttons: [
      [{ text: '↻ ' + t('Refresh model list'), callback_data: 'models:refresh' }],
      [
        { text: '🌐 ' + t('Language'), callback_data: 'language:show' },
        { text: t('Updates'), callback_data: 'updates:show' },
      ],
    ],
  };
}
export function updateCard(locale: Locale, notice: UpdateNotice): TelegramCard {
  const t = translator(locale),
    tool = notice.tool;
  const text = new TelegramText()
    .add(
      '⬆️ ' + t(notice.kind === 'available' ? 'CLI update available' : 'CLI version changed'),
      'bold',
    )
    .add('\n\n')
    .add(tool.name, 'bold')
    .add('\n');
  if (notice.kind === 'changed')
    text
      .add(tool.changedFrom ?? '?', 'code')
      .add(' → ')
      .add(tool.installed ?? '?', 'code');
  else
    text
      .add(t('Installed') + ': ')
      .add(tool.installed ?? '?', 'code')
      .add('\n' + t('Available') + ': ')
      .add(tool.latest ?? '?', 'code');
  text
    .add('\n\n')
    .add(
      t(
        tool.source === 'bundled'
          ? 'The bundled CLI updates with Reviewloop. A system CLI update does not change this copy.'
          : 'No running session has been restarted.',
      ),
    );
  return {
    ...text,
    buttons: [
      [{ text: t('Release notes') + ' ↗', url: tool.releaseUrl }],
      [{ text: t('Updates'), callback_data: 'updates:show' }],
    ],
  };
}
export function updatesCard(locale: Locale, status: UpdateStatus): TelegramCard {
  const t = translator(locale),
    text = new TelegramText().add('⬆️ ' + t('Updates'), 'bold');
  if (!status.checkedAt) text.add('\n\n' + t('Not checked yet'));
  for (const tool of status.tools) {
    text
      .add('\n\n')
      .add(tool.name, 'bold')
      .add(
        '\n' +
          t(
            tool.source === 'bundled'
              ? 'Bundled with Reviewloop'
              : tool.source === 'missing'
                ? 'Not installed'
                : 'External CLI',
          ),
      );
    if (!tool.supported) text.add('\n' + t('Integration not available'));
    if (tool.installed) text.add('\n' + t('Installed') + ': ').add(tool.installed, 'code');
    if (tool.latest) text.add('\n' + t('Available') + ': ').add(tool.latest, 'code');
    text.add(
      '\n' +
        t(
          tool.error
            ? 'Check failed'
            : !tool.latest
              ? 'Not checked yet'
              : tool.updateAvailable
                ? 'Update available'
                : 'Up to date',
        ),
    );
    if (tool.error) text.add('\n' + tool.error);
  }
  if (status.checkedAt)
    text.add(
      '\n\n' + t('Retrieved: {time}', { time: new Date(status.checkedAt).toLocaleString(locale) }),
    );
  text.add(
    '\n\n' +
      t(
        'Updates are checked every {hours} hours. Running agents are never restarted automatically.',
        { hours: status.intervalHours },
      ),
  );
  return {
    ...text,
    buttons: [
      [{ text: '↻ ' + t('Check now'), callback_data: 'updates:check' }],
      [
        {
          text: (status.notifications ? '✓ ' : '') + t('CLI update notifications'),
          callback_data: status.notifications ? 'updates:off' : 'updates:on',
        },
      ],
      [{ text: '🌐 ' + t('Language'), callback_data: 'language:show' }],
    ],
  };
}
