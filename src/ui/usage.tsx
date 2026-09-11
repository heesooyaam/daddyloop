import { useEffect, useState } from 'react';
import type { DaddyApi } from '../client/daddy.js';
import type { UsageView, AgentUsageView, ResetPlan } from '../core/usage.js';
import { resetOutcomeText, usageDate, windowLabel } from '../client/usage.js';
import { useLocale } from './i18n.js';

function AgentStrip({
  usage,
  connected,
  onDetails,
}: {
  usage?: AgentUsageView;
  connected: boolean;
  onDetails: () => void;
}) {
  const { t, locale } = useLocale();
  const stale =
    !!usage &&
    (usage.stale ||
      !connected ||
      (usage.retrievedAt ? Date.now() - Date.parse(usage.retrievedAt) > 120000 : false));
  return (
    <section
      className={'daddy-usage-strip' + (stale ? ' stale' : '')}
      aria-label={t('Current usage')}
    >
      <div className="daddy-usage-caption">
        <strong>{usage?.name ?? t('Current usage')}</strong>
        <span>{t('Shared account · remaining')}</span>
        {stale && <small role="status">{t('Last known usage')}</small>}
        {usage?.ordinaryUsageAllowed === false && (
          <small role="status">{t('Included usage is blocked')}</small>
        )}
      </div>
      <div className="daddy-usage-windows">
        {!usage ? (
          <span className="daddy-muted">{t('Reading usage…')}</span>
        ) : !usage.available ? (
          <span className="daddy-muted">{t('Usage unavailable')}</span>
        ) : (
          usage.buckets.flatMap((bucket) => [
            ...bucket.windows.map((window, index) => (
              <div className="daddy-usage-window" key={bucket.id + ':' + index}>
                <div>
                  <span>
                    {bucket.name} · {window.label ?? windowLabel(window.durationMinutes, locale)}
                  </span>
                  <strong>
                    {window.remainingPercent == null ? '—' : Math.round(window.remainingPercent)}%
                  </strong>
                </div>
                <progress
                  aria-label={t('{window}: {remaining}% remaining', {
                    window:
                      bucket.name +
                      ' ' +
                      (window.label ?? windowLabel(window.durationMinutes, locale)),
                    remaining:
                      window.remainingPercent == null ? '—' : Math.round(window.remainingPercent),
                  })}
                  max={100}
                  value={window.remainingPercent ?? undefined}
                />
                {window.resetsAt && (
                  <time dateTime={window.resetsAt}>
                    {t('Resets: {time}', { time: usageDate(window.resetsAt, locale) })}
                  </time>
                )}
              </div>
            )),
            ...(bucket.credits?.unlimited || bucket.credits?.balance != null
              ? [
                  <div className="daddy-usage-window" key={bucket.id + ':credits'}>
                    <span>{bucket.name}</span>
                    <strong>
                      {bucket.credits.unlimited
                        ? t('Credits: unlimited')
                        : t('Credit balance: {balance}', { balance: bucket.credits.balance! })}
                    </strong>
                  </div>,
                ]
              : []),
            ...(bucket.blocked
              ? [
                  <small role="status" key={bucket.id + ':blocked'}>
                    {bucket.name}: {t('Provider reports a quota restriction')} ({bucket.blocked})
                  </small>,
                ]
              : []),
          ])
        )}
      </div>
      {usage?.activity && (
        <small className="daddy-muted">
          {t('Last agent turn: {input} in / {output} out · ~${cost}', {
            input: usage.activity.inputTokens,
            output: usage.activity.outputTokens,
            cost: usage.activity.costUSD.toFixed(4),
          })}
        </small>
      )}
      <button
        className="daddy-usage-details"
        onClick={onDetails}
        aria-label={t('Usage details and resets')}
      >
        <strong>
          {usage?.resets.availableCount == null
            ? t('Resets: unknown')
            : t('Resets available: {count}', { count: usage.resets.availableCount })}
        </strong>
        <span>{t('Details and reset')} ↗</span>
      </button>
    </section>
  );
}
export function UsageStrip(props: {
  usage?: UsageView;
  connected: boolean;
  onDetails: () => void;
}) {
  return (
    <>
      {props.usage?.agents.map((agent) => (
        <AgentStrip key={agent.engine} {...props} usage={agent} />
      )) ?? <AgentStrip connected={props.connected} onDetails={props.onDetails} />}
    </>
  );
}
export function UsagePanel({
  api,
  onUpdate,
}: {
  api: DaddyApi;
  onUpdate?: (usage: UsageView) => void;
}) {
  const { t, locale } = useLocale();
  const [overview, setUsage] = useState<UsageView>(),
    [engine, setEngine] = useState<string>(),
    [plan, setPlan] = useState<ResetPlan>();
  const usage = overview?.agents.find((agent) => agent.engine === engine) ?? overview?.agents[0];
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const accept = (next: UsageView) => {
    setUsage(next);
    onUpdate?.(next);
  };
  useEffect(() => {
    const abort = new AbortController();
    void api<UsageView>('/usage', undefined, abort.signal)
      .then(accept)
      .catch((error) => {
        if (!abort.signal.aborted) setError(error.message);
      });
    return () => abort.abort();
  }, [api]);
  const action = async (kind: 'refresh' | 'prepare' | 'consume') => {
    if (busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      if (kind === 'refresh') accept(await api<UsageView>('/usage?refresh=1'));
      if (kind === 'prepare')
        setPlan(await api<ResetPlan>('/usage/reset/prepare', { engine: usage?.engine }));
      if (kind === 'consume' && plan) {
        const result = await api<{ usage: UsageView; plan: ResetPlan }>(`/usage/reset/${plan.id}`, {
          confirmed: true,
        });
        accept(result.usage);
        setNotice(t(resetOutcomeText[result.plan.outcome!]));
        setPlan(undefined);
      }
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="daddy-usage">
      <select
        aria-label={t('Agent usage')}
        value={usage?.engine ?? ''}
        disabled={busy || !!plan}
        onChange={(event) => setEngine(event.target.value)}
      >
        {overview?.agents.map((agent) => (
          <option key={agent.engine} value={agent.engine}>
            {agent.name}
          </option>
        ))}
      </select>
      <p className="daddy-muted">{t('daddy and workers share their provider account limits.')}</p>
      {usage && !usage.available && <p>{t('This provider has no current quota readings.')}</p>}
      {usage?.activity && (
        <p>
          {t('Last agent turn: {input} in / {output} out · ~${cost}', {
            input: usage.activity.inputTokens,
            output: usage.activity.outputTokens,
            cost: usage.activity.costUSD.toFixed(4),
          })}{' '}
          · {usageDate(usage.activity.at, locale)}
        </p>
      )}
      {usage?.error && <p className="daddy-muted">{t(usage.error)}</p>}
      {usage?.stale && (
        <p role="status">{t('These readings are outdated. Refresh before using a reset.')}</p>
      )}
      {usage?.ordinaryUsageAllowed === false && (
        <p role="status">{t('The provider currently blocks included usage.')}</p>
      )}
      {usage?.buckets.map((bucket) => (
        <section key={bucket.id} className="daddy-usage-bucket">
          <strong>{bucket.name}</strong>
          {bucket.plan && <small> · {bucket.plan}</small>}
          {bucket.blocked && (
            <p role="status">
              {t('Provider reports a quota restriction')}: {bucket.blocked}
            </p>
          )}
          {bucket.windows.map((window, i) => (
            <div key={i}>
              <p>
                {t('{window}: {remaining}% remaining', {
                  window: window.label ?? windowLabel(window.durationMinutes, locale),
                  remaining:
                    window.remainingPercent == null ? '—' : Math.round(window.remainingPercent),
                })}
              </p>
              <progress
                aria-label={
                  bucket.name + ' ' + (window.label ?? windowLabel(window.durationMinutes, locale))
                }
                max={100}
                value={window.remainingPercent ?? undefined}
              />
              {window.resetsAt && (
                <small>{t('Resets: {time}', { time: usageDate(window.resetsAt, locale) })}</small>
              )}
            </div>
          ))}
          {bucket.credits?.unlimited ? (
            <p>{t('Credits: unlimited')}</p>
          ) : (
            bucket.credits?.balance != null && (
              <p>{t('Credit balance: {balance}', { balance: bucket.credits.balance })}</p>
            )
          )}
        </section>
      ))}
      <strong>
        {usage?.resets.availableCount == null
          ? t('Available resets: unknown')
          : t('Available resets: {count}', { count: usage.resets.availableCount })}
      </strong>
      {usage?.resets.credits.map((credit) => (
        <p key={credit.id}>
          {t(credit.title)}
          {credit.expiresAt &&
            ' · ' + t('Expires: {time}', { time: usageDate(credit.expiresAt, locale) })}
        </p>
      ))}
      {usage?.retrievedAt && (
        <p className="daddy-muted">
          {t('Checked: {time}', { time: usageDate(usage.retrievedAt, locale) })}
        </p>
      )}
      {error && <p role="alert">{t(error)}</p>}
      {notice && <p role="status">{notice}</p>}
      {plan ? (
        <div className="daddy-usage-confirm">
          <strong>{t(plan.title)}</strong>
          <p>
            {t(
              'Use one available reset for the selected provider account? Existing conversations and files are kept.',
            )}
          </p>
          <button
            className="daddy-button primary"
            disabled={busy}
            onClick={() => void action('consume')}
          >
            {t('Confirm: use one reset')}
          </button>
          <button className="daddy-button quiet" disabled={busy} onClick={() => setPlan(undefined)}>
            {t('Cancel')}
          </button>
          <p className="daddy-muted">
            {t(
              'If the response is lost, retry this same operation. It will not spend a second reset.',
            )}
          </p>
        </div>
      ) : (
        <button
          className="daddy-button primary"
          disabled={busy || !usage?.resets.canUse}
          onClick={() => void action('prepare')}
        >
          {t(usage?.resets.pending ? 'Resolve pending reset' : 'Use a reset')}
        </button>
      )}
      <button className="daddy-button quiet" disabled={busy} onClick={() => void action('refresh')}>
        {t('Refresh limits')}
      </button>
    </div>
  );
}
