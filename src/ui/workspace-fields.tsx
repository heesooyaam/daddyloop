import { useRef, useState, useEffect } from 'react';
import { Check, ChevronDown, FolderGit2, FolderOpen, LoaderCircle, RotateCcw } from 'lucide-react';
import type { DaddyApi } from '../client/daddy.js';
import type { Workspace } from '../core/types.js';
import type { RepositorySelection } from '../core/workspace-registry.js';
import { useLocale } from './i18n.js';
import { FolderBrowser } from './folder-browser.js';

/** Local editing is separate from the submitted draft and from saved workspace defaults. */
export function WorkspaceFields({
  api,
  workspace,
  value,
  onChange,
  compact = false,
  sessionId,
  onEditingChange,
}: {
  api: DaddyApi;
  workspace: Workspace;
  value?: RepositorySelection;
  onChange: (value?: RepositorySelection) => void;
  compact?: boolean;
  sessionId?: string;
  onEditingChange?: (editing: boolean) => void;
}) {
  const { t } = useLocale();
  const [editing, setEditing] = useState(false),
    [picking, setPicking] = useState(false);
  const [draft, setDraft] = useState<RepositorySelection>({});
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const request = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => {
    onEditingChange?.(editing);
    return () => onEditingChange?.(false);
  }, [editing, onEditingChange]);
  useEffect(() => {
    if (!value) {
      request.current?.abort();
      setEditing(false);
      setPicking(false);
      setBusy(false);
      setError('');
    }
  }, [value]);
  const path = value?.path ?? workspace.repoPath;
  const scope = value?.scope ?? (value?.path ? '' : workspace.scope);
  const base = value?.base ?? (value?.path ? '' : (workspace.base ?? ''));
  const begin = () => {
    setDraft({ path, scope, base, provider: value?.provider ?? workspace.provider });
    setError('');
    setEditing(true);
  };
  const cancel = () => {
    request.current?.abort();
    setBusy(false);
    setEditing(false);
    setPicking(false);
    setError('');
  };
  const apply = async () => {
    if (busy || picking) return;
    const controller = new AbortController();
    request.current?.abort();
    request.current = controller;
    setBusy(true);
    setError('');
    try {
      const selected = await api<Workspace>(
        '/workspaces/preview',
        { ...(sessionId ? { sessionId } : { workspaceId: workspace.id }), repository: draft },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      const same =
        selected.repoPath === workspace.repoPath &&
        selected.scope === workspace.scope &&
        (selected.base ?? '') === (workspace.base ?? '') &&
        selected.provider === workspace.provider;
      onChange(
        same
          ? undefined
          : {
              path: selected.repoPath,
              scope: selected.scope,
              base: selected.base,
              provider: selected.provider,
            },
      );
      setEditing(false);
      setPicking(false);
    } catch (error) {
      if (!controller.signal.aborted) setError((error as Error).message);
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  return (
    <div className={'daddy-workspace-fields' + (compact ? ' compact' : '')}>
      {!editing && (
        <div className="daddy-repository-summary">
          <FolderGit2 size={18} />
          <div>
            <span>
              {t(
                value
                  ? compact
                    ? 'Folder for the next message'
                    : 'Folder for this session'
                  : 'Workspace folder',
              )}
            </span>
            <code>
              {path}
              {scope ? '/' + scope : ''}
            </code>
            {base && <small>{t('Starting branch: {branch}', { branch: base })}</small>}
          </div>
          {!editing && (
            <button
              type="button"
              className="daddy-button quiet"
              onClick={begin}
              aria-label={t(
                compact ? 'Change folder for the next message' : 'Change folder for this session',
              )}
              aria-expanded={false}
            >
              {t('Change')}
            </button>
          )}
        </div>
      )}
      {!editing && value && (
        <div className="daddy-repository-override">
          <span>
            {t(
              compact
                ? 'Only the next message uses this folder.'
                : 'Only this session uses these settings.',
            )}
          </span>
          <button type="button" className="daddy-text-button" onClick={() => onChange(undefined)}>
            <RotateCcw size={13} />
            {t('Use workspace defaults')}
          </button>
        </div>
      )}
      {editing && (
        <>
          <fieldset
            className="daddy-repository-editor"
            disabled={busy}
            onKeyDown={(event) => {
              if (
                event.key === 'Enter' &&
                !event.defaultPrevented &&
                event.target instanceof HTMLInputElement
              ) {
                event.preventDefault();
                void apply();
              }
            }}
          >
            <legend>
              {t(compact ? 'Settings for the next message' : 'Settings for this session')}
            </legend>
            <p className="daddy-muted">
              {t(
                compact
                  ? 'Choose where daddy should handle your next message. Following messages use the session folder again.'
                  : 'Choose another source for this session. The saved workspace stays as it is.',
              )}
            </p>
            <label style={picking ? { display: 'none' } : undefined}>
              {t('Repository folder')}
              <input
                aria-label={t('Repository on this server')}
                value={draft.path ?? ''}
                onChange={(event) => setDraft({ path: event.target.value })}
              />
            </label>
            {!picking && (
              <button
                type="button"
                className="daddy-button outline"
                onClick={() => setPicking(true)}
              >
                <FolderOpen size={16} />
                {t('Browse server folders')}
              </button>
            )}
            {picking && (
              <FolderBrowser
                api={api}
                initialPath={draft.path}
                onSelect={(path) => {
                  setDraft({ path });
                  setPicking(false);
                }}
                onCancel={() => setPicking(false)}
              />
            )}
            <details className="daddy-advanced-settings">
              <summary>
                <ChevronDown size={15} />
                {t('Subfolder and starting branch')}
              </summary>
              <label>
                {t('Subfolder (optional)')}
                <input
                  aria-label={t('Starting directory (relative)')}
                  value={draft.scope ?? ''}
                  placeholder={t('Leave empty for the whole repository')}
                  onChange={(event) => setDraft({ ...draft, scope: event.target.value })}
                />
                <small>{t('A path inside the repository, for example services/api.')}</small>
              </label>
              <label>
                {t('Base branch (optional)')}
                <input
                  value={draft.base ?? ''}
                  placeholder={t('Repository default')}
                  onChange={(event) => setDraft({ ...draft, base: event.target.value })}
                />
                <small>
                  {t('The branch daddy starts from. Leave it empty to use the repository default.')}
                </small>
              </label>
            </details>
            {error && (
              <p role="alert" className="daddy-field-error">
                {t(error)}
              </p>
            )}
          </fieldset>
          <div className="daddy-form-actions">
            <button
              type="button"
              disabled={busy || picking}
              className="daddy-button primary"
              onClick={() => void apply()}
            >
              {busy ? <LoaderCircle size={15} className="spin" /> : <Check size={15} />}
              {t('Apply settings')}
            </button>
            <button type="button" className="daddy-button quiet" onClick={cancel}>
              {t('Cancel')}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
