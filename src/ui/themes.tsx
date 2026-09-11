import { createContext, useContext, useEffect, useState, useMemo } from 'react';
import type { ReactNode } from 'react';
import { Palette, Check, Monitor, Moon, Sun } from 'lucide-react';
import { Dialog } from './dialog.js';
import { useLocale } from './i18n.js';
import './themes.css';

export const themes = [
  { id: 'glacier', name: 'Glacier', dark: false },
  { id: 'pearl', name: 'Pearl', dark: false },
  { id: 'mint', name: 'Mint', dark: false },
  { id: 'lilac', name: 'Lilac', dark: false },
  { id: 'graphite', name: 'Graphite', dark: true },
  { id: 'midnight', name: 'Midnight', dark: true },
  { id: 'forest', name: 'Forest', dark: true },
  { id: 'plum', name: 'Plum', dark: true },
] as const;
export type ThemeId = (typeof themes)[number]['id'];
export type ThemeChoice = ThemeId | 'system';
const validChoice = (value: unknown): ThemeChoice =>
  themes.some((theme) => theme.id === value) ? (value as ThemeId) : 'system';
const Context = createContext({
  choice: 'system' as ThemeChoice,
  effective: 'glacier' as ThemeId,
  select: (_choice: ThemeChoice) => {},
});
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [choice, setChoice] = useState<ThemeChoice>(() => {
    try {
      return validChoice(localStorage.getItem('daddyloop.theme'));
    } catch {
      return 'system';
    }
  });
  const [dark, setDark] = useState(() => matchMedia('(prefers-color-scheme: dark)').matches);
  const effective = choice === 'system' ? (dark ? 'graphite' : 'glacier') : choice;
  useEffect(() => {
    const query = matchMedia('(prefers-color-scheme: dark)');
    const change = () => setDark(query.matches);
    query.addEventListener('change', change);
    const storage = (event: StorageEvent) => {
      if (event.key === 'daddyloop.theme') setChoice(validChoice(event.newValue));
    };
    window.addEventListener('storage', storage);
    return () => {
      query.removeEventListener('change', change);
      window.removeEventListener('storage', storage);
    };
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = effective;
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute(
        'content',
        getComputedStyle(document.documentElement).getPropertyValue('--paper').trim(),
      );
  }, [effective]);
  const context = useMemo(
    () => ({
      choice,
      effective,
      select: (next: ThemeChoice) => {
        setChoice(next);
        try {
          localStorage.setItem('daddyloop.theme', next);
        } catch {
          /* The current tab still works when storage is unavailable. */
        }
      },
    }),
    [choice, effective],
  );
  return <Context.Provider value={context}>{children}</Context.Provider>;
}
export function ThemeButton() {
  const { t } = useLocale(),
    { choice, effective, select } = useContext(Context);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        className="daddy-icon daddy-theme-toggle"
        aria-label={t('Change theme')}
        title={t('Change theme')}
        onClick={() => setOpen(true)}
      >
        <Palette size={19} />
      </button>
      {open && (
        <Dialog title={t('Make yourself at home')} onClose={() => setOpen(false)} wide>
          <p className="daddy-muted">{t('Pick your colors. The crew keeps working.')}</p>
          <div
            role="radiogroup"
            aria-label={t('Theme')}
            className="daddy-theme-grid"
            onKeyDown={(event) => {
              if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
              event.preventDefault();
              const buttons = [
                ...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]'),
              ];
              const current = buttons.indexOf(document.activeElement as HTMLButtonElement),
                step = ['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 1;
              const next = buttons[(current + step + buttons.length) % buttons.length];
              next?.focus();
              next?.click();
            }}
          >
            <button
              role="radio"
              aria-checked={choice === 'system'}
              className="daddy-theme-system"
              onClick={() => select('system')}
            >
              <Monitor size={18} />
              <span>
                {t('Follow system')}
                <small>{t('Light or dark, with your device')}</small>
              </span>
              {choice === 'system' && <Check size={17} />}
            </button>
            {themes.map((theme) => (
              <button
                key={theme.id}
                role="radio"
                aria-label={t(theme.name)}
                aria-checked={choice === theme.id}
                data-theme={theme.id}
                className="daddy-theme-card"
                onClick={() => select(theme.id)}
              >
                <span className="daddy-theme-preview" aria-hidden="true">
                  <span>d.</span>
                  <i />
                  <i />
                  <b />
                </span>
                <span className="daddy-theme-name">
                  {theme.dark ? <Moon size={14} /> : <Sun size={14} />}
                  {t(theme.name)}
                  {choice === theme.id && <Check size={15} />}
                </span>
              </button>
            ))}
          </div>
          <p className="daddy-muted">
            {t('Saved in this browser. Your phone can have its own theme.')}
          </p>
          <small className="daddy-muted">
            {t('Current theme: {name}', {
              name: t(themes.find((theme) => theme.id === effective)!.name),
            })}
          </small>
        </Dialog>
      )}
    </>
  );
}
