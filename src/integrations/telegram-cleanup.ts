import { cleanupReportLines } from '../core/cleanup-outcomes.js';
import { translator, type Locale } from '../i18n/index.js';
import type { CleanupScheduleStatus } from '../ops/cleanup-controls.js';
import { TelegramText, type TelegramCard } from './telegram-text.js';

export function cleanupCommand(args = ''): Record<string, unknown> | undefined {
  if (!args) return;
  if (args === 'on' || args === 'off') return { enabled: args === 'on' };
  if (args === 'clear-skill') return { skillPath: null };
  const numeric = /^(threshold|interval)\s+(\d+(?:\.\d+)?)$/.exec(args);
  if (numeric)
    return { [numeric[1] === 'threshold' ? 'diskPercent' : 'intervalMinutes']: Number(numeric[2]) };
  const path = /^skill\s+(.+)$/.exec(args);
  if (path) return { skillPath: path[1] };
  throw new Error('Use /cleanup, /cleanup threshold N, /cleanup interval N or /cleanup skill PATH');
}

export function cleanupControlCard(locale: Locale, value: CleanupScheduleStatus): TelegramCard {
  const t = translator(locale);
  const text = new TelegramText()
    .add(t('Disk cleanup'), 'bold')
    .add(
      '\n' +
        t(value.enabled ? 'On' : 'Off') +
        ' · ' +
        t('Every {minutes} min when disk usage exceeds {percent}%', {
          minutes: value.intervalMinutes,
          percent: value.diskPercent,
        }),
    )
    .add('\n' + t('Cleanup skill') + ' · ' + (value.skill ?? t('No cleanup skill')));
  if (value.hostUnits?.length)
    text.add('\n' + t('Host cleanup services') + ' · ' + value.hostUnits.join(', '));
  if (value.running) text.add('\n' + t('Cleanup in progress'));
  if (value.lastCheckedAt) text.add('\n' + t('Last disk check') + ' · ' + value.lastCheckedAt);
  if (value.nextCheckAt) text.add('\n' + t('Next disk check') + ' · ' + value.nextCheckAt);
  if (value.lastReport)
    text.add(
      '\n' + t('Last cleanup') + '\n' + cleanupReportLines(locale, value.lastReport).join('\n'),
    );
  text.add(
    '\n\n/cleanup threshold N\n/cleanup interval N\n/cleanup skill PATH\n/cleanup clear-skill',
  );
  return {
    ...text,
    buttons: [
      [
        {
          text: t(value.enabled ? 'Disable scheduled cleanup' : 'Enable scheduled cleanup'),
          callback_data: value.enabled ? 'cleanup:off' : 'cleanup:on',
        },
      ],
      [
        { text: t('Refresh cleanup status'), callback_data: 'cleanup:show' },
        { text: t('Back'), callback_data: 'dad:settings' },
      ],
    ],
  };
}
