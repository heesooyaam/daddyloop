import { useEffect, useState } from 'react';
import type { UpdateStatus } from '../core/updates.js';
import { useLocale } from './i18n.js';
type Api = <T>(path: string, body?: unknown) => Promise<T>;
export function UpdatesPanel({ api }: { api: Api }) {
  const { t, locale } = useLocale();
  const [value, setValue] = useState<UpdateStatus>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    void api<UpdateStatus>('/updates')
      .then(setValue)
      .catch((error) => setError(error.message));
  }, []);
  return (
    <div className="task-form">
      <p>
        {t(
          'Updates are checked every {hours} hours. Running agents are never restarted automatically.',
          { hours: value?.intervalHours ?? 6 },
        )}
      </p>
      <button
        className="button primary"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError('');
          try {
            setValue(await api<UpdateStatus>('/updates/check', {}));
          } catch (error) {
            setError((error as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {t(busy ? 'Checking…' : 'Check now')}
      </button>
      {value?.checkedAt && (
        <small>
          {t('Retrieved: {time}', { time: new Date(value.checkedAt).toLocaleString(locale) })}
        </small>
      )}
      {value?.tools.map((tool) => (
        <section className="runtime-card" key={tool.id}>
          <strong>{tool.name}</strong>{' '}
          <span className="pill neutral">
            {t(
              tool.source === 'bundled'
                ? 'Bundled with Reviewloop'
                : tool.source === 'missing'
                  ? 'Not installed'
                  : tool.source === 'managed'
                    ? 'Managed by Reviewloop'
                    : 'External CLI',
            )}
          </span>
          {!tool.supported && <p>{t('Integration not available')}</p>}
          <p>
            {t('Current version')}: <code>{tool.installed ?? '—'}</code> · {t('Latest version')}:{' '}
            <code>{tool.latest ?? '—'}</code>
          </p>
          {tool.executable && (
            <p>
              <small>{t('Configured executable')}</small>
              <br />
              <code>{tool.executable}</code>
            </p>
          )}
          <p>
            {t(
              tool.error
                ? 'Check failed'
                : !tool.latest
                  ? 'Not checked yet'
                  : tool.updateAvailable
                    ? 'Update available'
                    : 'Up to date',
            )}
          </p>
          {tool.error && <p className="field-error">{tool.error}</p>}
          {tool.updateAvailable && (
            <a href={tool.releaseUrl} target="_blank" rel="noreferrer">
              {t('Release notes')} ↗
            </a>
          )}
          {tool.source === 'bundled' && (
            <small>
              {t(
                'This CLI is part of the Reviewloop release. Updating a system CLI does not replace it.',
              )}
            </small>
          )}
        </section>
      ))}
      {value && (
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={value.notifications}
            onChange={async (event) => {
              try {
                setValue(
                  await api<UpdateStatus>('/updates/notifications', {
                    enabled: event.target.checked,
                  }),
                );
              } catch (error) {
                setError((error as Error).message);
              }
            }}
          />
          <span>{t('Notify in Telegram about CLI updates')}</span>
        </label>
      )}
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
