import { useEffect, useRef, useState } from 'react';
import { ArrowUp, ChevronRight, Folder, FolderCheck, LoaderCircle, X } from 'lucide-react';
import type { DaddyApi } from '../client/daddy.js';
import { useLocale } from './i18n.js';
export interface DirectoryList {
  path: string;
  parent: string | null;
  directories: { name: string; path: string }[];
  truncated: boolean;
}

/** Navigation only. A separate selection button commits the verified directory. */
export function FolderBrowser({
  api,
  initialPath = '',
  onSelect,
  onCancel,
}: {
  api: DaddyApi;
  initialPath?: string;
  onSelect: (path: string) => void;
  onCancel: () => void;
}) {
  const { t } = useLocale();
  const [listing, setListing] = useState<DirectoryList>();
  const [path, setPath] = useState(initialPath),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const request = useRef<AbortController | undefined>(undefined);
  const browse = async (target: string) => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError('');
    try {
      const result = await api<DirectoryList>(
        '/workspaces/directories' + (target ? '?path=' + encodeURIComponent(target) : ''),
        undefined,
        controller.signal,
      );
      if (!controller.signal.aborted) {
        setListing(result);
        setPath(result.path);
      }
    } catch (error) {
      if (!controller.signal.aborted) setError((error as Error).message);
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  useEffect(() => {
    void browse(initialPath);
    return () => request.current?.abort();
  }, []);
  return (
    <section
      className="daddy-folder-browser"
      aria-label={t('Choose a folder on this server')}
      aria-busy={busy}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          onCancel();
        }
      }}
    >
      <header className="daddy-folder-heading">
        <div>
          <strong>{t('Folders on this server')}</strong>
          <p>{t('Open folders to explore. Select the current folder with the button below.')}</p>
        </div>
        <button
          type="button"
          className="daddy-icon"
          aria-label={t('Close folder browser')}
          onClick={onCancel}
        >
          <X size={17} />
        </button>
      </header>
      <div className="daddy-folder-path">
        <button
          type="button"
          className="daddy-icon"
          aria-label={t('Parent folder')}
          onClick={() => void browse(listing?.parent ?? '')}
          disabled={busy || !listing?.path}
        >
          <ArrowUp size={17} />
        </button>
        <input
          aria-label={t('Server directory')}
          value={path}
          placeholder={t('Absolute path on the server')}
          onChange={(event) => setPath(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              event.stopPropagation();
              void browse(path.trim());
            }
          }}
        />
        <button
          type="button"
          className="daddy-button quiet"
          onClick={() => void browse(path.trim())}
          disabled={busy}
        >
          {t('Open folder')}
        </button>
      </div>
      <div className="daddy-browse-location">
        <span>{t('Browsing')}</span>
        <strong>
          {listing?.path
            ? listing.path.split('/').filter(Boolean).at(-1) || '/'
            : t('Server folders')}
        </strong>
        {!!listing?.path && (
          <button type="button" onClick={() => void browse('')} disabled={busy}>
            {t('All server folders')}
          </button>
        )}
      </div>
      {error && (
        <p role="alert" className="daddy-field-error">
          {t(error)}
        </p>
      )}
      <div className="daddy-directories">
        {busy && (
          <p role="status" className="daddy-folder-loading">
            <LoaderCircle size={16} className="spin" />
            {t('Loading folders…')}
          </p>
        )}
        {listing?.directories.map((entry) => (
          <button
            type="button"
            key={entry.path}
            disabled={busy}
            aria-label={t('Open folder {name}', { name: entry.name })}
            onClick={() => void browse(entry.path)}
          >
            <Folder size={17} />
            <span>{entry.name}</span>
            <ChevronRight size={16} />
          </button>
        ))}
        {!busy && listing && !listing.directories.length && (
          <p className="daddy-muted">
            {t('This folder has no subfolders. You can select it below.')}
          </p>
        )}
      </div>
      {listing?.truncated && (
        <p className="daddy-muted daddy-folder-note">
          {t('Only the first 150 folders are shown. Enter a more specific path above.')}
        </p>
      )}
      <footer className="daddy-folder-selection">
        <div>
          <span>{t('Folder to use')}</span>
          <code>{listing?.path || t('Open a folder first')}</code>
        </div>
        <button
          type="button"
          className="daddy-button primary"
          disabled={busy || !!error || !listing?.path || path !== listing.path}
          onClick={() => {
            if (listing?.path) onSelect(listing.path);
          }}
        >
          <FolderCheck size={16} />
          {t('Select this folder')}
        </button>
      </footer>
    </section>
  );
}
