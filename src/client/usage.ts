import type { ResetOutcome, UsageView } from '../core/usage.js';
import { translator, type Locale } from '../i18n/index.js';
export function usageSummary(usage?: UsageView) {
  if (!usage?.available || usage.stale) return undefined;
  const bucket = usage.buckets.find((bucket) => bucket.id === 'codex') ?? usage.buckets[0];
  return bucket?.windows.length
    ? Math.round(Math.min(...bucket.windows.map((window) => window.remainingPercent))) + '%'
    : undefined;
}
export function windowLabel(minutes: number | null | undefined, locale: Locale) {
  const t = translator(locale);
  return minutes == null
    ? t('Quota window')
    : minutes % 1440 === 0
      ? t('{count} days', { count: minutes / 1440 })
      : minutes % 60 === 0
        ? t('{count} hours', { count: minutes / 60 })
        : t('{count} minutes', { count: minutes });
}
export function usageDate(value: string, locale: Locale) {
  return new Date(value).toLocaleString(locale === 'ru' ? 'ru-RU' : 'en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  });
}
export const resetOutcomeText: Record<ResetOutcome, string> = {
  reset: 'One reset was used. Limits were requested again from Codex.',
  alreadyRedeemed: 'This reset was already applied. No second reset was requested.',
  nothingToReset: 'Codex reports no eligible limit to reset.',
  noCredit: 'Codex reports no available resets.',
};
export function usageLines(usage: UsageView, locale: Locale) {
  const t = translator(locale),
    lines = [t('daddy and workers share the Codex account limits on this server.')];
  if (!usage.available) lines.push(t('Limits are unavailable. Sign in to Codex and refresh.'));
  if (usage.stale) lines.push(t('These readings are outdated. Refresh before using a reset.'));
  if (usage.ordinaryUsageAllowed === false) lines.push(t('Codex currently blocks included usage.'));
  for (const bucket of usage.buckets) {
    lines.push('', bucket.name);
    for (const window of bucket.windows) {
      lines.push(
        t('{window}: {remaining}% remaining', {
          window: windowLabel(window.durationMinutes, locale),
          remaining: Math.round(window.remainingPercent),
        }),
      );
      if (window.resetsAt)
        lines.push(t('Resets: {time}', { time: usageDate(window.resetsAt, locale) }));
    }
    if (bucket.credits?.unlimited) lines.push(t('Credits: unlimited'));
    else if (bucket.credits?.balance != null)
      lines.push(t('Credit balance: {balance}', { balance: bucket.credits.balance }));
  }
  lines.push(
    '',
    usage.resets.availableCount === null
      ? t('Available resets: unknown')
      : t('Available resets: {count}', { count: usage.resets.availableCount }),
  );
  for (const credit of usage.resets.credits)
    if (credit.expiresAt)
      lines.push(
        t('{title} · expires {time}', {
          title: t(credit.title),
          time: usageDate(credit.expiresAt, locale),
        }),
      );
  if (usage.retrievedAt)
    lines.push('', t('Checked: {time}', { time: usageDate(usage.retrievedAt, locale) }));
  return lines;
}
