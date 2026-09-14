import { useEffect, useState } from 'react';
import type { UpdateStatus } from '../core/updates.js';
import type { RuntimeUpdatePlan, RuntimeUpdaterStatus } from '../core/runtime-updater.js';
import { useLocale } from './i18n.js';
type Api = <T>(path: string, body?: unknown) => Promise<T>;
export function UpdatesPanel({ api }: { api: Api }) {
  const { t, locale } = useLocale();
  const [value, setValue] = useState<UpdateStatus>();
  const [updaters, setUpdaters] = useState<RuntimeUpdaterStatus[]>([]);
  const [plan, setPlan] = useState<RuntimeUpdatePlan>();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const [updates, runtimes] = await Promise.all([
          api<UpdateStatus>('/updates'),
          api<RuntimeUpdaterStatus[]>('/runtimes'),
        ]);
        if (active) {
          setValue(updates);
          setUpdaters(runtimes);
        }
      } catch (error) {
        if (active) setError((error as Error).message);
      }
    };
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, 3000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [api]);
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="task-form">
      <p>
        {t(
          'Choose the CLI to update. daddy checks it before switching; running agents finish on their current version.',
        )}
      </p>
      <button
        className="button secondary"
        disabled={busy}
        onClick={() =>
          void run(async () => {
            setValue(await api<UpdateStatus>('/updates/check', {}));
          })
        }
      >
        {t(busy ? 'Checking…' : 'Check for CLI updates')}
      </button>
      {value?.checkedAt && (
        <small>
          {t('Retrieved: {time}', { time: new Date(value.checkedAt).toLocaleString(locale) })}
        </small>
      )}
      {value?.tools.map((tool) => {
        const updater = updaters.find((item) => item.engine === tool.id);
        return (
          <section className="runtime-card" key={tool.id}>
            <strong>{tool.name}</strong>
            <p>
              {t('Current version')}: <code>{tool.installed ?? '—'}</code> · {t('Latest version')}:{' '}
              <code>{tool.latest ?? '—'}</code>
            </p>
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
            {updater?.busy && (
              <p role="status">{t('{name} update in progress', { name: tool.name })}</p>
            )}
            {updater?.operation && !updater.busy && (
              <p role="status">
                {t(
                  updater.operation.phase === 'complete'
                    ? '{name} version selected'
                    : '{name} update failed',
                  { name: tool.name },
                )}
                {updater.operation.error && `: ${updater.operation.error}`}
              </p>
            )}
            {updater?.reason && <p>{t(updater.reason)}</p>}
            {updater?.enabled && (
              <div className="daddy-settings-actions">
                {tool.updateAvailable && (
                  <button
                    className="button primary"
                    disabled={busy || updater.busy}
                    onClick={() =>
                      void run(async () => {
                        setPlan(
                          await api<RuntimeUpdatePlan>(`/runtimes/${tool.id}/update/prepare`, {
                            action: 'install',
                          }),
                        );
                      })
                    }
                  >
                    {t('Update {name}', { name: tool.name })}
                  </button>
                )}
                {updater.rollback && (
                  <button
                    className="button secondary"
                    disabled={busy || updater.busy}
                    onClick={() =>
                      void run(async () => {
                        setPlan(
                          await api<RuntimeUpdatePlan>(`/runtimes/${tool.id}/update/prepare`, {
                            action: 'rollback',
                          }),
                        );
                      })
                    }
                  >
                    {t('Roll back to {version}', { version: updater.rollback })}
                  </button>
                )}
              </div>
            )}
            <a href={tool.releaseUrl} target="_blank" rel="noreferrer">
              {t('Release notes')} ↗
            </a>
            {tool.executable && (
              <details>
                <summary>{t('CLI installation details')}</summary>
                <p>
                  {t(
                    tool.source === 'bundled'
                      ? 'Bundled with daddyloop'
                      : tool.source === 'managed'
                        ? 'Managed by daddyloop'
                        : tool.source === 'missing'
                          ? 'Not installed'
                          : 'External CLI',
                  )}
                </p>
                <code>{tool.executable}</code>
              </details>
            )}
          </section>
        );
      })}
      {plan && (
        <section className="runtime-card" aria-label={t('Confirm CLI change')}>
          <strong>
            {t(plan.action === 'install' ? 'Update {name}' : 'Roll back {name}', {
              name: plan.name,
            })}
          </strong>
          <p>
            <code>{plan.from.version}</code> → <code>{plan.target.version}</code>
          </p>
          <p>
            {t(
              'Your models, chats and login stay in place. The previous CLI remains available for rollback.',
            )}
          </p>
          <button
            className="button primary"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await api(`/runtimes/${plan.engine}/update/confirm`, { id: plan.id });
                setPlan(undefined);
                setUpdaters(await api<RuntimeUpdaterStatus[]>('/runtimes'));
              })
            }
          >
            {t('Confirm')}
          </button>{' '}
          <button className="button secondary" disabled={busy} onClick={() => setPlan(undefined)}>
            {t('Cancel')}
          </button>
        </section>
      )}
      {value && (
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={value.notifications}
            onChange={(event) => {
              const enabled = event.target.checked;
              void run(async () => {
                setValue(await api<UpdateStatus>('/updates/notifications', { enabled }));
              });
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
