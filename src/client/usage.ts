import type { ResetOutcome, UsageView, AgentUsageView } from '../core/usage.js';
import { translator, type Locale } from '../i18n/index.js';
export function usageSummary(usage?: UsageView) {
  const readings = usage?.agents
    .filter((agent) => agent.available && !agent.stale)
    .flatMap((agent) =>
      agent.buckets.flatMap((bucket) => {
        const windows = bucket.windows.flatMap((window) =>
          window.remainingPercent == null ? [] : [window.remainingPercent],
        );
        return windows.length ? [bucket.name + ' ' + Math.round(Math.min(...windows)) + '%'] : [];
      }),
    );
  return readings?.length ? readings.join(' · ') : undefined;
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
  reset: 'One reset was used. Limits were requested again from the provider.',
  alreadyRedeemed: 'This reset was already applied. No second reset was requested.',
  nothingToReset: 'The provider reports no eligible limit to reset.',
  noCredit: 'The provider reports no available resets.',
};
function agentUsageLines(usage: AgentUsageView, locale: Locale) {
  const t = translator(locale),
    lines = [usage.name, t('daddy and workers share their provider account limits.')];
  if (usage.activity)
    lines.push(
      t('Last agent turn: {input} in / {output} out · ~${cost}', {
        input: usage.activity.inputTokens,
        output: usage.activity.outputTokens,
        cost: usage.activity.costUSD.toFixed(4),
      }) +
        ' · ' +
        usageDate(usage.activity.at, locale),
    );
  if (!usage.available) lines.push(t('This provider has no current quota readings.'));
  if (usage.stale) lines.push(t('These readings are outdated. Refresh before using a reset.'));
  if (usage.ordinaryUsageAllowed === false)
    lines.push(t('The provider currently blocks included usage.'));
  for (const bucket of usage.buckets) {
    lines.push('', bucket.name);
    if (bucket.blocked)
      lines.push(t('Provider reports a quota restriction') + ': ' + bucket.blocked);
    for (const window of bucket.windows) {
      lines.push(
        t('{window}: {remaining}% remaining', {
          window: window.label ?? windowLabel(window.durationMinutes, locale),
          remaining: window.remainingPercent == null ? '—' : Math.round(window.remainingPercent),
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

export function usageLines(usage: UsageView, locale: Locale) {
  return usage.agents.flatMap((agent) => [...agentUsageLines(agent, locale), '']);
}
