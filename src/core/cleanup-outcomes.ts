import type { CleanupReport } from '../ops/scheduled-cleanup.js';
import { translator, type Locale } from '../i18n/index.js';
export const cleanupOutcomes = {
  cleared: 'Disk usage is now within the cleanup threshold.',
  still_high: 'Disk usage is still above the cleanup threshold.',
  failed: 'Scheduled cleanup ended with an error.',
  interrupted: 'Scheduled cleanup was interrupted.',
};

export function cleanupReportLines(locale: Locale, report: CleanupReport): string[] {
  const t = translator(locale);
  const delta = report.after.diskAvailableGiB - report.before.diskAvailableGiB;
  const stats = {
    before: report.before.diskUsedPercent.toFixed(1),
    after: report.after.diskUsedPercent.toFixed(1),
    gain: Math.abs(delta).toFixed(2),
  };
  const movement =
    Math.abs(delta) < 0.005
      ? 'Disk usage {before}% → {after}%. Free space was unchanged.'
      : delta < 0
        ? 'Disk usage {before}% → {after}%. Free space decreased by {gain} GiB.'
        : 'Disk usage {before}% → {after}%. Free space gained {gain} GiB.';
  const lines = [t(movement, stats), t(cleanupOutcomes[report.status])];
  for (const action of report.actions) {
    if (action.counts) {
      lines.push(
        t(
          'Review copies and downloads checked: {checked}, eligible: {eligible}, removed: {removed}.',
          { ...action.counts },
        ),
      );
      if (action.counts.tooRecent)
        lines.push(
          t('Younger than the retention period: {count}.', { count: action.counts.tooRecent }),
        );
    }
    if (action.id.startsWith('daddyloop-cleanup-') && !action.error)
      lines.push(
        t(action.skipped ? 'Host cleanup {unit} was skipped.' : 'Host cleanup {unit} completed.', {
          unit: action.id,
        }),
      );
    if (action.error) lines.push(action.id + ' · ' + t(action.error).slice(0, 300));
  }
  if (report.error) lines.push(t(report.error).slice(0, 300));
  return lines;
}
