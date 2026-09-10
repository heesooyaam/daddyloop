import { useEffect, useRef, useState } from 'react';
import type { DaddyApi } from '../client/daddy.js';
import type { Project } from '../core/types.js';
import type { WorkspaceInput } from '../core/projects.js';
import { useLocale } from './i18n.js';

/** The value belongs to this draft. Choosing a directory never edits project defaults. */
export function WorkspaceFields({
  api,
  project,
  value,
  onChange,
  compact = false,
}: {
  api: DaddyApi;
  project: Project;
  value?: WorkspaceInput;
  onChange: (value?: WorkspaceInput) => void;
  compact?: boolean;
}) {
  const { t } = useLocale();
  const [listing, setListing] = useState<{
    path: string;
    parent: string | null;
    directories: { name: string; path: string }[];
  }>();
  const [error, setError] = useState('');
  const sequence = useRef(0);
  useEffect(
    () => () => {
      sequence.current++;
    },
    [],
  );
  const browse = async (path?: string) => {
    const at = ++sequence.current;
    try {
      const next = await api<NonNullable<typeof listing>>(
        '/projects/directories' + (path ? '?path=' + encodeURIComponent(path) : ''),
      );
      if (at === sequence.current) {
        setListing(next);
        setError('');
      }
    } catch (error) {
      if (at === sequence.current) setError((error as Error).message);
    }
  };
  const fields = (
    <>
      <label>
        {t('Repository on this server')}
        <input
          aria-label={t('Repository on this server')}
          value={value?.path ?? project.repoPath}
          onChange={(event) =>
            onChange({ ...value, path: event.target.value, scope: undefined, base: undefined })
          }
        />
      </label>
      <button type="button" className="daddy-text-button" onClick={() => void browse()}>
        {t('Browse server folders')}
      </button>
      {listing && (
        <div className="daddy-directory-list">
          <code>{listing.path}</code>
          <button type="button" onClick={() => void browse(listing.parent ?? undefined)}>
            ↑ {t('Parent folder')}
          </button>
          {listing.directories.map((entry) => (
            <button type="button" key={entry.path} onClick={() => void browse(entry.path)}>
              {entry.name} →
            </button>
          ))}
          {listing.path && (
            <button
              type="button"
              onClick={() => {
                onChange({ path: listing.path });
                setListing(undefined);
              }}
            >
              {t('Use this folder once')}
            </button>
          )}
        </div>
      )}
      <label>
        {t('Starting directory (relative)')}
        <input
          value={value?.scope ?? (value?.path ? '' : project.scope)}
          placeholder={t('Repository root')}
          onChange={(event) => onChange({ ...value, scope: event.target.value })}
        />
      </label>
      <label>
        {t('Base branch (optional)')}
        <input
          value={value?.base ?? (value?.path ? '' : (project.base ?? ''))}
          onChange={(event) => onChange({ ...value, base: event.target.value })}
        />
      </label>
      {value && (
        <button
          type="button"
          className="daddy-text-button"
          onClick={() => {
            onChange(undefined);
            setListing(undefined);
          }}
        >
          {t('Use project defaults')}
        </button>
      )}
      <p className="daddy-muted">
        {t(
          'This selection applies only to this request. Project defaults and existing tasks stay as saved.',
        )}
      </p>
      {error && <p role="alert">{t(error)}</p>}
    </>
  );
  return (
    <details className="daddy-workspace-fields" open={compact ? undefined : true}>
      <summary>
        {t(value ? 'Repository for this request' : 'Using project defaults')} ·{' '}
        {value?.path ?? project.repoPath}
      </summary>
      {fields}
    </details>
  );
}
