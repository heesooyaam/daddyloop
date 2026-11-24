import { useEffect, useState, type FormEvent } from 'react';
import type { DaddyApi } from '../client/daddy.js';
import type { CleanupScheduleStatus } from '../ops/cleanup-controls.js';
import { cleanupOutcomes } from '../core/cleanup-outcomes.js';
import { useLocale } from './i18n.js';

export function CleanupPanel({ api }: { api: DaddyApi }) {
  const { t, locale } = useLocale();
  const [status, setStatus] = useState<CleanupScheduleStatus>();
  const [enabled, setEnabled] = useState(false),
    [percent, setPercent] = useState(''),
    [minutes, setMinutes] = useState('');
  const [path, setPath] = useState(''),
    [remove, setRemove] = useState(false);
  const [error, setError] = useState(''),
    [saved, setSaved] = useState(false),
    [busy, setBusy] = useState(false);
  function load(value: CleanupScheduleStatus) {
    setStatus(value);
    setEnabled(value.configured);
    setPercent(String(value.diskPercent));
    setMinutes(String(value.intervalMinutes));
    setPath('');
    setRemove(false);
  }
  useEffect(() => {
    const abort = new AbortController();
    api<CleanupScheduleStatus>('/cache/schedule', undefined, abort.signal)
      .then((v) => {
        if (!abort.signal.aborted) load(v);
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(e.message);
      });
    return () => abort.abort();
  }, [api]);
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!status || busy) return;
    const patch: Record<string, unknown> = {};
    if (enabled !== status.configured) patch.enabled = enabled;
    if (Number(percent) !== status.diskPercent) patch.diskPercent = Number(percent);
    if (Number(minutes) !== status.intervalMinutes) patch.intervalMinutes = Number(minutes);
    if (remove || path.trim()) patch.skillPath = remove ? null : path.trim();
    setBusy(true);
    setError('');
    setSaved(false);
    try {
      const value = await api<CleanupScheduleStatus>(
        '/cache/schedule',
        Object.keys(patch).length ? patch : undefined,
      );
      load(value);
      setSaved(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const date = (value: string) => new Date(value).toLocaleString(locale);
  return (
    <form className="task-form" onSubmit={save} onChange={() => setSaved(false)}>
      {error && (
        <p role="alert" className="daddy-field-error">
          {t(error)}
        </p>
      )}
      {status && (
        <>
          <label className="daddy-toggle">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            <span>{t('Enable scheduled cleanup')}</span>
          </label>
          <label>
            {t('Cleanup threshold (%)')}
            <input
              type="number"
              required
              min="1"
              max="99.99"
              step="any"
              value={percent}
              onChange={(e) => setPercent(e.target.value)}
            />
          </label>
          <label>
            {t('Check interval (minutes)')}
            <input
              type="number"
              required
              min="30"
              step="1"
              value={minutes}
              onChange={(e) => setMinutes(e.target.value)}
            />
          </label>
          <p>
            {t('Cleanup skill')} · {status.skill ?? t('No cleanup skill')}
          </p>
          <label>
            {t('New skill path on the server')}
            <input
              value={path}
              disabled={remove}
              onChange={(e) => setPath(e.target.value)}
              placeholder="~/skills/cache-cleanup/SKILL.md"
            />
          </label>
          {status.skill && (
            <label className="daddy-toggle">
              <input
                type="checkbox"
                checked={remove}
                onChange={(e) => setRemove(e.target.checked)}
              />
              <span>{t('Remove cleanup skill')}</span>
            </label>
          )}
          {status.running && <p>{t('Cleanup in progress')}</p>}
          {status.lastCheckedAt && (
            <p>
              {t('Last disk check')} · {date(status.lastCheckedAt)}
            </p>
          )}
          {status.nextCheckAt && (
            <p>
              {t('Next disk check')} · {date(status.nextCheckAt)}
            </p>
          )}
          {status.lastReport && (
            <p>
              {t('Last cleanup')} · {status.lastReport.before.diskUsedPercent.toFixed(1)}% →{' '}
              {status.lastReport.after.diskUsedPercent.toFixed(1)}% ·{' '}
              {t(cleanupOutcomes[status.lastReport.status])}
            </p>
          )}
          <button className="daddy-button primary" disabled={busy}>
            {t('Save settings')}
          </button>
          {saved && <p role="status">{t('Cleanup settings saved')}</p>}
        </>
      )}
    </form>
  );
}
