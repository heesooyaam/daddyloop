import { useRef, useEffect, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { useLocale } from './i18n.js';
export function Dialog({
  title,
  children,
  onClose,
  fallbackFocus,
  closeDisabled = false,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  fallbackFocus?: () => HTMLElement | null;
  closeDisabled?: boolean;
  wide?: boolean;
}) {
  const { t } = useLocale();
  const requestClose = () => {
    if (!closeDisabled) onClose();
  };
  const ref = useRef<HTMLDivElement>(null),
    close = useRef(requestClose),
    fallback = useRef(fallbackFocus);
  close.current = requestClose;
  fallback.current = fallbackFocus;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    (
      ref.current?.querySelector<HTMLElement>('[data-autofocus]') ??
      ref.current?.querySelector<HTMLElement>('button,input,select,textarea')
    )?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close.current();
      }
      if (event.key === 'Tab') {
        const nodes = [
          ...(ref.current?.querySelectorAll<HTMLElement>(
            'button,input,select,textarea,a[href],summary',
          ) ?? []),
        ].filter((node) => !node.matches(':disabled') && node.getClientRects().length > 0);
        if (!nodes?.length) return;
        const first = nodes[0],
          last = nodes[nodes.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('keydown', key);
      if (previous?.isConnected) previous.focus();
      if (!previous?.isConnected || document.activeElement !== previous)
        fallback.current?.()?.focus();
    };
  }, []);
  return (
    <div
      className="daddy-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          event.preventDefault();
          requestClose();
        }
      }}
    >
      <div
        ref={ref}
        className={'daddy-dialog' + (wide ? ' wide' : '')}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header>
          <h2>{title}</h2>
          <button
            className="daddy-icon"
            aria-label={t('Close')}
            onClick={requestClose}
            disabled={closeDisabled}
          >
            <X size={19} />
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}
