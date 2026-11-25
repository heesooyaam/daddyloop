import { useEffect, useId, useRef, useState, type MouseEventHandler } from 'react';
import { ArrowRight, CircleAlert, Clock, Gauge } from 'lucide-react';
import { UsageResetAlreadyRunningError, type DaddyApi } from '../client/daddy.js';
import type { UsageView, AgentUsageView, ResetPlan } from '../core/usage.js';
import { resetOutcomeText, usageDate, windowLabel } from '../client/usage.js';
import { useLocale } from './i18n.js';

type QuotaWindow = AgentUsageView['buckets'][number]['windows'][number];

function isStale(usage: AgentUsageView) {
  return (
    usage.available &&
    (usage.stale ||
      (usage.retrievedAt != null && Date.now() - Date.parse(usage.retrievedAt) > 120000))
  );
}

function remaining(percent: number) {
  return percent > 0 && percent < 1 ? '<1' : Math.round(percent);
}

function providerSummary(usage: AgentUsageView, { t, locale }: ReturnType<typeof useLocale>) {
  let lowest: { bucket: string; window: QuotaWindow; percent: number } | undefined;
  if (usage.available) {
    for (const bucket of usage.buckets) {
      for (const window of bucket.windows) {
        const percent = window.remainingPercent;
        if (percent != null && (!lowest || percent < lowest.percent)) {
          lowest = { bucket: bucket.name, window, percent };
        }
      }
    }
  }
  const credits = usage.available
    ? usage.buckets.find(({ credits }) => credits?.unlimited || credits?.balance != null)?.credits
    : undefined;
  let reading = t('No quota readings yet');
  if (lowest) {
    const name = lowest.window.label ?? windowLabel(lowest.window.durationMinutes, locale);
    reading = t('{window}: {remaining}% remaining', {
      window:
        lowest.bucket === usage.name || lowest.bucket === name
          ? name
          : lowest.bucket + ' · ' + name,
      remaining: remaining(lowest.percent),
    });
  } else if (credits) {
    reading = credits.unlimited
      ? t('Credits: unlimited')
      : t('Credit balance: {balance}', { balance: credits.balance ?? '' });
  }
  const restricted =
    usage.ordinaryUsageAllowed === false || usage.buckets.some((bucket) => bucket.blocked);
  const stale = isStale(usage);
  return {
    engine: usage.engine,
    text: [
      usage.name,
      reading,
      restricted && t('Provider reports a quota restriction'),
      stale && t('Last known usage'),
    ]
      .filter(Boolean)
      .join(' · '),
    stale,
    exhausted: !stale && (lowest?.percent === 0 || restricted),
  };
}

function ProviderReadings({
  usage,
  compact = false,
}: {
  usage: AgentUsageView;
  compact?: boolean;
}) {
  const { t, locale } = useLocale();
  return (
    <>
      {!usage.available && (
        <p className="daddy-muted">{t('This provider has no current quota readings.')}</p>
      )}
      {isStale(usage) && (
        <p role="status">
          {t(
            compact
              ? 'Last known usage'
              : 'These readings are outdated. Refresh before using a reset.',
          )}
        </p>
      )}
      {usage.ordinaryUsageAllowed === false && (
        <p role="status">{t('The provider currently blocks included usage.')}</p>
      )}
      {usage.buckets.map((bucket) => (
        <div key={bucket.id} className="daddy-usage-bucket">
          {(!compact || bucket.name !== usage.name) && <strong>{bucket.name}</strong>}
          {bucket.plan && <small className="daddy-muted">{bucket.plan}</small>}
          {bucket.blocked && (
            <p role="status">
              {t('Provider reports a quota restriction')}: {bucket.blocked}
            </p>
          )}
          {bucket.windows.map((window, i) => {
            const name = window.label ?? windowLabel(window.durationMinutes, locale);
            const left = window.remainingPercent;
            return (
              <div className="daddy-quota-window" key={i}>
                <p className={left === 0 ? 'daddy-quota-exhausted' : undefined}>
                  {left == null
                    ? `${name} · ${t('No reading')}`
                    : t('{window}: {remaining}% remaining', {
                        window: name,
                        remaining: remaining(left),
                      })}
                </p>
                {left != null && (
                  <progress aria-label={bucket.name + ' ' + name} max={100} value={left} />
                )}
                {window.resetsAt && (
                  <time dateTime={window.resetsAt}>
                    {t('Resets: {time}', { time: usageDate(window.resetsAt, locale) })}
                  </time>
                )}
              </div>
            );
          })}
          {bucket.credits &&
            (!compact ||
              !bucket.windows.length ||
              bucket.credits.unlimited ||
              Number(bucket.credits.balance) > 0) && (
              <div className="daddy-credit-explanation">
                <strong>
                  {t(bucket.windows.length ? 'Additional credits' : 'Provider credits')}
                </strong>
                <p>
                  {bucket.credits.unlimited
                    ? t('Credits: unlimited')
                    : bucket.credits.balance != null
                      ? t('Credit balance: {balance}', { balance: bucket.credits.balance })
                      : t('Credit balance is not reported')}
                </p>
                {!compact && (
                  <p className="daddy-muted">
                    {t(
                      'Credits are a separate payment balance held by the provider. A zero credit balance does not mean your quota percentages are exhausted.',
                    )}
                  </p>
                )}
              </div>
            )}
        </div>
      ))}
    </>
  );
}

function usageStatusText(
  usage: UsageView | undefined,
  error: string | undefined,
  t: ReturnType<typeof useLocale>['t'],
) {
  if (error) return t('Could not read agent limits: {reason}', { reason: t(error) });
  if (!usage) return t('Reading agent limits…');
  if (!usage.agents.length) return t('No quota readings yet');
}

export function UsageIndicator({
  usage,
  usageError,
  href,
  onNavigate,
}: {
  usage?: UsageView;
  usageError?: string;
  href: string;
  onNavigate: MouseEventHandler<HTMLAnchorElement>;
}) {
  const language = useLocale();
  const { t } = language;
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const summaries = usage?.agents.map((agent) => providerSummary(agent, language)) ?? [];
  const status = usageStatusText(usage, usageError, t);
  const exhausted = summaries.some((summary) => summary.exhausted);
  const stale = summaries.some((summary) => summary.stale);
  const Icon = exhausted ? CircleAlert : stale ? Clock : Gauge;

  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      setDismissed(true);
      if (open) {
        setOpen(false);
        trigger.current?.focus();
      }
    };
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', escape);
    if (open) document.addEventListener('pointerdown', outside);
    return () => {
      document.removeEventListener('keydown', escape);
      document.removeEventListener('pointerdown', outside);
    };
  }, [open]);

  return (
    <div
      className="daddy-usage-indicator"
      ref={root}
      data-summary={!open && !dismissed}
      onPointerEnter={() => setDismissed(false)}
      onFocus={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setDismissed(false);
      }}
      onBlur={(event) => {
        if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget))
          setOpen(false);
      }}
    >
      <button
        type="button"
        className={exhausted ? 'daddy-icon daddy-quota-exhausted' : 'daddy-icon'}
        ref={trigger}
        aria-label={t('Agent limits')}
        aria-expanded={open}
        aria-controls={id + '-details'}
        aria-describedby={id + '-summary'}
        onClick={() => {
          setDismissed(true);
          setOpen(!open);
        }}
      >
        <Icon size={19} aria-hidden="true" />
      </button>
      <div className="daddy-usage-tooltip" role="tooltip" id={id + '-summary'}>
        {summaries.map((summary) => (
          <div key={summary.engine}>{summary.text}</div>
        ))}
        {status && <div>{status}</div>}
      </div>
      <div
        className="daddy-usage-popover"
        id={id + '-details'}
        role="region"
        aria-label={t('Agent limit details')}
        hidden={!open}
      >
        {open && (
          <>
            <div className="daddy-usage-providers">
              {status && <p role={usageError ? 'alert' : 'status'}>{status}</p>}
              {usage?.agents.map((agent) => (
                <section key={agent.engine} className="daddy-usage-provider">
                  <h2>{agent.name}</h2>
                  <ProviderReadings usage={agent} compact />
                  {agent.resets.availableCount != null && (
                    <p className="daddy-muted">
                      {t('Available resets: {count}', { count: agent.resets.availableCount })}
                    </p>
                  )}
                </section>
              ))}
            </div>
            <a className="daddy-usage-page-link" href={href} onClick={onNavigate}>
              {t('Open limits page')}
              <ArrowRight size={16} aria-hidden="true" />
            </a>
          </>
        )}
      </div>
    </div>
  );
}

export function UsagePanel({
  api,
  overview,
  usageError,
  onRefresh,
  onConsume,
}: {
  api: DaddyApi;
  overview?: UsageView;
  usageError?: string;
  onRefresh: () => Promise<void>;
  onConsume: (id: string) => Promise<ResetPlan>;
}) {
  const { t, locale } = useLocale();
  const [engine, setEngine] = useState<string>(),
    [confirmation, setConfirmation] = useState<{
      plan: ResetPlan;
      engine: string;
      provider: string;
      uncertain?: boolean;
    }>();
  const usage = confirmation
    ? overview?.agents.find((agent) => agent.engine === confirmation.engine)
    : (overview?.agents.find((agent) => agent.engine === engine) ?? overview?.agents[0]);
  const plan = confirmation?.plan;
  const isRetry = confirmation?.uncertain || plan?.status === 'pending';
  const canStartReset = () =>
    !!usage?.available &&
    !usageError &&
    !isStale(usage) &&
    usage.resets.canUse &&
    usage.resets.availableCount !== 0;
  const canConfirm = () => isRetry || canStartReset();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState<{ provider: string; message: string }>();
  const action = async (kind: 'refresh' | 'prepare' | 'consume') => {
    if (busy || (kind === 'consume' && !canConfirm())) return;
    setBusy(true);
    setError('');
    setNotice(undefined);
    try {
      if (kind === 'refresh') await onRefresh();
      if (kind === 'prepare' && usage) {
        const prepared = await api<ResetPlan>('/usage/reset/prepare', { engine: usage.engine });
        setConfirmation({ plan: prepared, engine: usage.engine, provider: usage.name });
      }
      if (kind === 'consume' && confirmation) {
        const result = await onConsume(confirmation.plan.id);
        setEngine(confirmation.engine);
        setNotice({ provider: confirmation.provider, message: resetOutcomeText[result.outcome!] });
        setConfirmation(undefined);
      }
    } catch (error) {
      if (
        kind === 'consume' &&
        confirmation &&
        !(error instanceof UsageResetAlreadyRunningError) &&
        !(
          error instanceof Error &&
          'status' in error &&
          typeof error.status === 'number' &&
          error.status >= 400 &&
          error.status < 500
        )
      )
        setConfirmation({ ...confirmation, uncertain: true });
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const status = usageStatusText(overview, usageError, t);
  return (
    <div className="daddy-usage">
      {status && <p role={usageError ? 'alert' : 'status'}>{status}</p>}
      {usage && (
        <>
          <select
            aria-label={t('Agent usage')}
            value={usage.engine}
            disabled={busy || !!plan}
            onChange={(event) => setEngine(event.target.value)}
          >
            {overview?.agents.map((agent) => (
              <option key={agent.engine} value={agent.engine}>
                {agent.name}
              </option>
            ))}
          </select>
          <p className="daddy-muted">
            {t(
              'These limits belong to the {provider} account connected on this server. daddy and its workers use this account together.',
              { provider: usage.name },
            )}
          </p>
          <p className="daddy-muted">
            {t(
              'Percentages show how much of each quota is left. Each period renews at its own time.',
            )}
          </p>
          <ProviderReadings usage={usage} />
          {usage.activity && (
            <p>
              {t('Last agent turn: {input} in / {output} out · ~${cost}', {
                input: usage.activity.inputTokens,
                output: usage.activity.outputTokens,
                cost: usage.activity.costUSD.toFixed(4),
              })}{' '}
              · {usageDate(usage.activity.at, locale)}
            </p>
          )}
          {usage.error && <p className="daddy-muted">{t(usage.error)}</p>}
          <strong>
            {usage.resets.availableCount == null
              ? t('Available resets: unknown')
              : t('Available resets: {count}', { count: usage.resets.availableCount })}
          </strong>
        </>
      )}
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
      {notice && (
        <p role="status">
          {notice.provider} · {t(notice.message)}
        </p>
      )}
      {plan ? (
        <div className="daddy-usage-confirm">
          <strong>
            {confirmation.provider} · {t(plan.title)}
          </strong>
          {!canConfirm() && (
            <p role="status">
              {t('Refresh limits for this provider before confirming the reset.')}
            </p>
          )}
          <p>
            {t(
              'Use one available reset for the selected provider account? Existing conversations and files are kept.',
            )}
          </p>
          <button
            className="daddy-button primary"
            disabled={busy || !canConfirm()}
            onClick={() => void action('consume')}
          >
            {t('Confirm: use one reset')}
          </button>
          <button
            className="daddy-button quiet"
            disabled={busy}
            onClick={() => setConfirmation(undefined)}
          >
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
          disabled={busy || (!canStartReset() && !usage?.resets.pending)}
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
