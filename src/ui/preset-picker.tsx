import { useEffect, useRef, useState } from 'react';
import { LoaderCircle, Trash2 } from 'lucide-react';
import type { AppliedPreset, InstructionPreset } from '../core/instructions.js';
import type { InstructionPresets } from '../core/instruction-presets.js';
import { presetParts } from '../core/preset-parts.js';
import type { DaddyApi } from '../client/daddy.js';
import { useLocale } from './i18n.js';
type PresetSummary = ReturnType<InstructionPresets['list']>[number];
export function PresetPicker({
  api,
  value = [],
  onChange,
  onBusyChange,
  disabled = false,
}: {
  api: DaddyApi;
  value?: AppliedPreset[];
  onChange: (value: AppliedPreset[]) => void;
  onBusyChange: (busy: boolean) => void;
  disabled?: boolean;
}) {
  const { t } = useLocale();
  const [library, setLibrary] = useState<PresetSummary[]>([]),
    [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [pendingId, setPendingId] = useState<string>();
  const request = useRef<AbortController | undefined>(undefined),
    current = useRef(value),
    change = useRef(onChange);
  current.current = value;
  change.current = onChange;
  const load = async () => {
    try {
      setLibrary(await api<PresetSummary[]>('/instructions/presets'));
      setError('');
    } catch (error) {
      setError((error as Error).message);
    }
  };
  useEffect(() => {
    void load();
    return () => request.current?.abort();
  }, []);
  useEffect(() => {
    onBusyChange(busy);
    return () => onBusyChange(false);
  }, [busy, onBusyChange]);
  const toggle = async (id: string, enabled: boolean) => {
    const selected = current.current.find((item) => item.preset.id === id);
    if (selected) {
      change.current(
        current.current.map((item) => (item === selected ? { ...item, enabled } : item)),
      );
      return;
    }
    const controller = new AbortController();
    request.current?.abort();
    request.current = controller;
    setBusy(true);
    setPendingId(id);
    setError('');
    try {
      if (current.current.length >= 16) throw new Error('Choose at most 16 presets per session');
      const preset = await api<InstructionPreset>(
        '/instructions/presets/' + id,
        undefined,
        controller.signal,
      );
      if (!controller.signal.aborted)
        change.current([...current.current, { preset, enabled: true, omit: [] }]);
    } catch (error) {
      if (!controller.signal.aborted) setError((error as Error).message);
    } finally {
      if (!controller.signal.aborted) {
        setBusy(false);
        setPendingId(undefined);
      }
    }
  };
  const choices = [
    ...value.map((selection) => selection.preset),
    ...library.filter((preset) => !value.some((item) => item.preset.id === preset.id)),
  ];
  return (
    <section className="daddy-preset-picker" aria-label={t('Session presets')}>
      <div className="daddy-preset-heading">
        <strong>{t('Presets')}</strong>
        <button
          type="button"
          className="daddy-text-button"
          disabled={busy}
          onClick={() => void load()}
        >
          {t('Refresh list')}
        </button>
      </div>
      <p className="daddy-muted">
        {t(
          'Combine presets and choose their individual parts. Your own instructions below are applied last.',
        )}
      </p>
      {!choices.length && !error && (
        <p className="daddy-muted">{t('Create reusable sets in Presets in the sidebar.')}</p>
      )}
      {choices.map((preset) => {
        const selected = value.find((item) => item.preset.id === preset.id),
          parts = selected ? presetParts(selected.preset) : [];
        const setOmit = (omit: string[]) =>
          onChange(value.map((item) => (item === selected ? { ...item, omit } : item)));
        return (
          <div
            key={preset.id}
            className={'daddy-preset-choice' + (selected?.enabled ? ' selected' : '')}
          >
            <div className="daddy-preset-choice-header">
              <label>
                <input
                  type="checkbox"
                  checked={selected?.enabled ?? pendingId === preset.id}
                  disabled={busy || disabled}
                  aria-label={t('Use preset {name}', { name: preset.name })}
                  onChange={(event) => void toggle(preset.id, event.target.checked)}
                />
                <span>
                  <strong>{preset.name}</strong>
                  {preset.description && <small>{preset.description}</small>}
                </span>
              </label>
              {selected && (
                <button
                  type="button"
                  className="daddy-icon"
                  disabled={busy || disabled}
                  aria-label={t('Remove preset {name} from this session', { name: preset.name })}
                  onClick={() => onChange(value.filter((item) => item !== selected))}
                >
                  <Trash2 size={14} />
                </button>
              )}
            </div>
            {selected && (
              <details className="daddy-preset-components">
                <summary>
                  {t('Choose components')} · {parts.length - selected.omit.length}/{parts.length}
                </summary>
                <p className="daddy-muted">
                  {t('Saved version {revision}. Library edits do not change this copy.', {
                    revision: preset.revision,
                  })}
                </p>
                <fieldset disabled={!selected.enabled || busy || disabled}>
                  <div className="daddy-preset-parts-actions">
                    <button type="button" className="daddy-text-button" onClick={() => setOmit([])}>
                      {t('Select all')}
                    </button>
                    <button
                      type="button"
                      className="daddy-text-button"
                      onClick={() => setOmit(parts.map((part) => part.key))}
                    >
                      {t('Clear selection')}
                    </button>
                  </div>
                  {parts.map((part) => (
                    <label key={part.key}>
                      <input
                        type="checkbox"
                        checked={!selected.omit.includes(part.key)}
                        aria-label={t('{preset}: {role}: {part}', {
                          preset: preset.name,
                          role: part.role === 'daddy' ? 'daddy' : t('All workers'),
                          part: part.kind === 'prompt' ? t('Prompt') : part.name,
                        })}
                        onChange={(event) =>
                          setOmit(
                            event.target.checked
                              ? selected.omit.filter((key) => key !== part.key)
                              : [...selected.omit, part.key],
                          )
                        }
                      />
                      <span>
                        <strong>
                          {part.role === 'daddy' ? 'daddy' : t('All workers')} ·{' '}
                          {part.kind === 'prompt' ? t('Prompt') : part.name}
                        </strong>
                        {part.kind === 'prompt' && (
                          <small>
                            {selected.preset.instructions[part.role].prompt?.slice(0, 150)}
                          </small>
                        )}
                      </span>
                    </label>
                  ))}
                </fieldset>
              </details>
            )}
          </div>
        );
      })}
      {busy && (
        <p className="daddy-muted">
          <LoaderCircle size={14} className="spin" /> {t('Loading preset…')}{' '}
          <button
            type="button"
            className="daddy-text-button"
            onClick={() => {
              request.current?.abort();
              setBusy(false);
              setPendingId(undefined);
            }}
          >
            {t('Cancel')}
          </button>
        </p>
      )}
      {error && (
        <p role="alert" className="daddy-field-error">
          {t(error)}
        </p>
      )}
    </section>
  );
}
