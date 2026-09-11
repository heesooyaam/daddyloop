import { TelegramText, type TelegramCard } from './telegram-text.js';
import { translator, localeNames, type Locale } from '../i18n/index.js';
import type { AgentProfiles } from '../core/types.js';
import type { ModelOption, ModelCatalogueInfo } from '../core/agents.js';
import type { UpdateNotice, UpdateStatus } from '../core/updates.js';
import type {
  CodexUpdatePlan,
  CodexUpdateOperation,
  CodexUpdaterStatus,
} from '../core/codex-updater.js';
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
  for (const role of ['worker', 'daddy'] as const)
    text
      .add((role === 'worker' ? t('Worker') : 'daddy') + ': ', 'bold')
      .add(profiles[role].model ?? t('Engine configuration'), 'code')
      .add(profiles[role].effort ? ` / ${profiles[role].effort}` : '')
      .add('\n');
  text
    .add('\n')
    .add(t('Select worker and daddy models independently.'))
    .add('\n')
    .add('daddy agents defaults', 'code')
    .add(' · ')
    .add('/models', 'code')
    .add(' — daddy\n\n');
  for (const model of models)
    text
      .add(model.engine + ' · ' + model.id, 'code')
      .add('\n' + model.efforts.join(' · ') + '\n\n');
  for (const source of info?.modules ?? (info ? [{ engine: '', ...info }] : [])) {
    text
      .add((source.engine || 'Agent') + (source.cliVersion ? ' CLI ' + source.cliVersion : ''))
      .add('\n');
    if (source.source) text.add(source.source).add('\n');
  }
  text.add(t('Refresh queries the enabled agent modules.'));
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
          ? 'Open Updates to install Codex directly on this server.'
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
export function updatesCard(
  locale: Locale,
  status: UpdateStatus,
  updater?: CodexUpdaterStatus,
): TelegramCard {
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
              ? 'Bundled with daddyloop'
              : tool.source === 'missing'
                ? 'Not installed'
                : tool.source === 'managed'
                  ? 'Managed by daddyloop'
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
  if (updater?.busy) text.add('\n\n⏳ ' + t('Codex update in progress'));
  if (updater?.operation?.phase === 'failed')
    text.add('\n\n⚠️ ' + t('Last update failed') + '\n' + t(updater.operation.error ?? ''));
  return {
    ...text,
    buttons: [
      ...(updater?.enabled &&
      !updater.busy &&
      status.tools.some((tool) => tool.id === 'codex' && tool.updateAvailable)
        ? [[{ text: '⬆️ ' + t('Update Codex'), callback_data: 'codex:install' }]]
        : []),
      ...(updater?.enabled && !updater.busy && updater.rollback
        ? [
            [
              {
                text: '↩️ ' + t('Roll back to {version}', { version: updater.rollback }),
                callback_data: 'codex:rollback',
              },
            ],
          ]
        : []),
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
export function codexConfirmationCard(locale: Locale, plan: CodexUpdatePlan): TelegramCard {
  const t = translator(locale),
    text = new TelegramText()
      .add(
        (plan.action === 'install' ? '⬆️ ' : '↩️ ') +
          t(plan.action === 'install' ? 'Update Codex' : 'Roll back Codex'),
        'bold',
      )
      .add('\n\n')
      .add(plan.from.version, 'code')
      .add(' → ')
      .add(plan.target.version, 'code')
      .add(
        '\n\n' +
          t(
            'The server will validate this version before switching. Running agents finish on their current version; subsequent turns use the selected version.',
          ),
      )
      .add(
        '\n\n' +
          t(
            'Your models, chats and login stay in place. The previous CLI remains available for rollback.',
          ),
      )
      .add('\n\n' + t('This confirmation is valid for 10 minutes.'));
  return {
    ...text,
    buttons: [
      [{ text: '✅ ' + t('Confirm'), callback_data: `codex:confirm:${plan.id}` }],
      [{ text: t('Back to updates'), callback_data: 'updates:show' }],
    ],
  };
}
export function codexOperationCard(locale: Locale, operation: CodexUpdateOperation): TelegramCard {
  const t = translator(locale),
    complete = operation.phase === 'complete',
    failed = operation.phase === 'failed';
  const text = new TelegramText()
    .add(
      (complete ? '✅ ' : failed ? '⚠️ ' : '⏳ ') +
        t(
          complete
            ? 'Codex version selected'
            : failed
              ? 'Codex update failed'
              : 'Codex update started',
        ),
      'bold',
    )
    .add('\n\n')
    .add(operation.from.version, 'code')
    .add(' → ')
    .add(operation.target.version, 'code')
    .add(
      '\n\n' +
        t(
          complete
            ? 'New agent turns will use this version. Running agents were not interrupted.'
            : failed
              ? 'The selected CLI was preserved. Open Updates to try again.'
              : 'Download and validation run on the server. You can close Telegram; the bot will report the result.',
        ),
    );
  if (operation.error) text.add('\n\n' + t(operation.error));
  return { ...text, buttons: [[{ text: t('Updates'), callback_data: 'updates:show' }]] };
}
