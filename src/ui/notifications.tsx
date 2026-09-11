import { useEffect, useState } from 'react';
import { useLocale } from './i18n.js';
import type { DaddyApi as Api } from '../client/daddy.js';
export function NotificationsForm({ api }: { api: Api }) {
  const { t: tr } = useLocale();

  const [value, setValue] = useState<{ enabled: boolean; mode: 'attention' | 'all' }>(),
    [paired, setPaired] = useState(false),
    [message, setMessage] = useState('');
  useEffect(() => {
    void api<{ telegram: NonNullable<typeof value>; paired: boolean }>('/notifications')
      .then((result) => {
        setValue(result.telegram);
        setPaired(result.paired);
      })
      .catch((error) => setMessage(error.message));
  }, []);
  return (
    <div className="task-form">
      <p>{tr('Send updates to your paired private Telegram bot chat.')}</p>
      {value && (
        <>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={value.enabled}
              onChange={(event) => setValue({ ...value, enabled: event.target.checked })}
            />
            <span>{tr('Enable Telegram notifications')}</span>
          </label>
          <label>
            {tr(' Notify me ')}
            <select
              value={value.mode}
              onChange={(event) =>
                setValue({ ...value, mode: event.target.value as 'attention' | 'all' })
              }
            >
              <option value="attention">{tr('When work finishes or needs my input')}</option>
              <option value="all">{tr('All agent replies and review milestones')}</option>
            </select>
          </label>
          <button
            className="button primary"
            onClick={async () => {
              try {
                await api('/notifications', value);
                setMessage('Notification preferences saved.');
              } catch (error) {
                setMessage((error as Error).message);
              }
            }}
          >
            {tr(' Save notifications ')}
          </button>
        </>
      )}
      {!paired && (
        <p className="planning-note">
          {tr(' Connect your bot once on the host: ')}
          <code>{tr('daddy telegram setup')}</code>
          {tr('. Notifications start after private-chat pairing. ')}
        </p>
      )}
      {message && <p role="status">{message}</p>}
    </div>
  );
}
