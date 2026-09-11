import { useLocale, LocaleProvider } from './i18n.js';
import { localeNames, type Locale } from '../i18n/index.js';
import type { Preferences } from '../core/preferences.js';
import { DaddyWorkspace } from './daddy.js';
import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ArrowRight, LoaderCircle, LockKeyhole, RefreshCw } from 'lucide-react';
import './style.css';
import '@fontsource-variable/inter';
import { ThemeProvider, ThemeButton } from './themes.js';
class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
async function api<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const result = await fetch(`/api${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-daddyloop-Request': '1',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  const data = await result.json();
  if (!result.ok) throw new ApiError(data.error?.message ?? 'Request failed', result.status);
  return data as T;
}
function Brand() {
  return (
    <div className="brand">
      <span className="brand-icon">
        <RefreshCw size={21} />
      </span>
      <span>
        daddyloop<span className="brand-period">.</span>
      </span>
    </div>
  );
}

function App() {
  const { t, adopt } = useLocale();
  const [authenticated, setAuthenticated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const initialPair = useRef(location.hash.startsWith('#pair/') ? location.hash.slice(6) : '');
  const pairing = useRef<Promise<unknown> | null>(null);
  useEffect(() => {
    let stopped = false;
    const connect = async () => {
      try {
        if (initialPair.current) {
          pairing.current ??= api('/session/pair', { code: initialPair.current });
          try {
            await pairing.current;
          } finally {
            initialPair.current = '';
            history.replaceState(null, '', location.pathname);
          }
        }
        const prefs = await api<Preferences>('/preferences');
        if (!stopped) {
          adopt(prefs);
          setAuthenticated(true);
        }
      } catch (error) {
        if (!stopped && !(error instanceof ApiError && error.status === 401))
          setError((error as Error).message);
      } finally {
        if (!stopped) setLoading(false);
      }
    };
    void connect();
    return () => {
      stopped = true;
    };
  }, [adopt]);
  if (loading)
    return (
      <div className="loading-screen">
        <Brand />
        <LoaderCircle className="spin" />
        <span>{t('Connecting to your workspace…')}</span>
      </div>
    );
  if (!authenticated)
    return <Login initialError={error} onConnect={() => setAuthenticated(true)} />;
  return <DaddyWorkspace api={api} />;
}
function Login({
  onConnect,
  initialError = '',
}: {
  onConnect: () => void | Promise<void>;
  initialError?: string;
}) {
  const { t: tr, locale, local, adopt } = useLocale();
  const [languageChosen, setLanguageChosen] = useState(false);

  const [token, setToken] = useState(''),
    [error, setError] = useState(initialError),
    [busy, setBusy] = useState(false);
  return (
    <div className="login-page">
      <Brand />
      <ThemeButton />
      <select
        className="language-select"
        aria-label={tr('Interface language')}
        value={locale}
        disabled={busy}
        onChange={(event) => {
          local(event.target.value as Locale);
          setLanguageChosen(true);
        }}
      >
        {Object.entries(localeNames).map(([value, label]) => (
          <option key={value} value={value}>
            {tr(label)}
          </option>
        ))}
      </select>
      <div className="login-card">
        <span className="login-lock">
          <LockKeyhole size={25} />
        </span>
        <h1>{tr('Your daddyloop workspace.')}</h1>
        <p>
          {tr(' Connect to the service running on your machine. ')}
          <br />
          {tr(' Find your access token with ')}
          <code>daddy token</code>.
        </p>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              await api('/session', { token });
              if (languageChosen) adopt(await api<Preferences>('/preferences', { locale }));
              await onConnect();
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <label htmlFor="token">{tr('Local access token')}</label>
          <input
            id="token"
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            autoComplete="off"
            placeholder={tr('Paste your access token')}
            autoFocus
          />
          {error && (
            <p className="field-error" role="alert">
              {tr(error)}
            </p>
          )}
          <button className="button primary" disabled={busy || !token.trim()}>
            {busy ? <LoaderCircle className="spin" size={16} /> : <ArrowRight size={16} />}
            {tr(' Connect to workspace ')}
          </button>
        </form>
      </div>
      <small>
        <a
          href={`https://github.com/heesooyaam/daddyloop/blob/main/docs/web/${locale}.md`}
          target="_blank"
          rel="noreferrer"
        >
          {tr('Open the site from your computer or phone')}
        </a>
      </small>
    </div>
  );
}
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <LocaleProvider>
      <ThemeProvider>
        <App />
      </ThemeProvider>
    </LocaleProvider>
  </React.StrictMode>,
);
