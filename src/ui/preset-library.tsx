import { useEffect, useRef, useState } from 'react';
import { Plus, Save, Trash2 } from 'lucide-react';
import type { DaddyApi } from '../client/daddy.js';
import type { InstructionPreset, SessionInstructions } from '../core/instructions.js';
import type { InstructionPresets } from '../core/instruction-presets.js';
import { InstructionFields } from './instructions.js';
import { useLocale } from './i18n.js';

export function PresetLibrary({ api }: { api: DaddyApi }) {
  const { t } = useLocale();
  const [library, setLibrary] = useState<ReturnType<InstructionPresets['list']>>([]);
  const [editing, setEditing] = useState<InstructionPreset>(),
    [open, setOpen] = useState(false);
  const [name, setName] = useState(''),
    [description, setDescription] = useState('');
  const [instructions, setInstructions] = useState<SessionInstructions>({ daddy: {}, worker: {} });
  const [busy, setBusy] = useState(false),
    [importing, setImporting] = useState(false);
  const [error, setError] = useState(''),
    [saved, setSaved] = useState(false);
  const request = useRef<AbortController | undefined>(undefined);
  const load = async () =>
    setLibrary(await api<ReturnType<InstructionPresets['list']>>('/instructions/presets'));
  useEffect(() => {
    void load().catch((error) => setError(error.message));
    return () => request.current?.abort();
  }, []);
  const create = () => {
    setEditing(undefined);
    setName('');
    setDescription('');
    setInstructions({ daddy: {}, worker: {} });
    setSaved(false);
    setError('');
    setOpen(true);
  };
  const edit = async (id: string) => {
    const controller = new AbortController();
    request.current?.abort();
    request.current = controller;
    setBusy(true);
    setError('');
    try {
      const preset = await api<InstructionPreset>(
        '/instructions/presets/' + id,
        undefined,
        controller.signal,
      );
      if (controller.signal.aborted) return;
      setEditing(preset);
      setName(preset.name);
      setDescription(preset.description);
      setInstructions(preset.instructions);
      setOpen(true);
      setSaved(false);
    } catch (error) {
      if (!controller.signal.aborted) setError((error as Error).message);
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  const save = async () => {
    if (busy || importing) return;
    setBusy(true);
    setError('');
    setSaved(false);
    try {
      const preset = await api<InstructionPreset>(
        '/instructions/presets' + (editing ? '/' + editing.id : ''),
        {
          name,
          description,
          instructions,
          ...(editing ? { expectedRevision: editing.revision } : {}),
        },
      );
      setEditing(preset);
      setInstructions(preset.instructions);
      await load();
      setSaved(true);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!editing || busy || importing) return;
    setBusy(true);
    setError('');
    try {
      await api('/instructions/presets/' + editing.id + '/delete', {
        expectedRevision: editing.revision,
      });
      await load();
      setOpen(false);
      setEditing(undefined);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="daddy-preset-library">
      <p className="daddy-muted">
        {t(
          'Save reusable sets here, then choose any number of them for a session. Each session keeps its own selected version.',
        )}
      </p>
      <div className="daddy-preset-library-list">
        {library.map((preset) => (
          <button
            type="button"
            key={preset.id}
            className="daddy-preset-library-card"
            disabled={busy || importing}
            onClick={() => void edit(preset.id)}
            aria-label={t('Edit preset {name}', { name: preset.name })}
          >
            <strong>{preset.name}</strong>
            <small>
              {preset.description || t('{count} components', { count: preset.components.length })}
            </small>
          </button>
        ))}
      </div>
      {!library.length && !open && (
        <p>{t('No presets yet. Create your first reusable instruction set.')}</p>
      )}
      <button
        type="button"
        className="daddy-button outline"
        disabled={busy || importing}
        onClick={create}
      >
        <Plus size={15} />
        {t('Create preset')}
      </button>
      {open && (
        <form
          className="daddy-form daddy-preset-editor"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <fieldset disabled={busy}>
            <label>
              {t('Preset name')}
              <input
                value={name}
                maxLength={100}
                required
                onChange={(event) => {
                  setName(event.target.value);
                  setSaved(false);
                }}
              />
            </label>
            <label>
              {t('Preset description (optional)')}
              <input
                value={description}
                maxLength={1000}
                onChange={(event) => {
                  setDescription(event.target.value);
                  setSaved(false);
                }}
              />
            </label>
            <InstructionFields
              api={api}
              value={instructions}
              onChange={(value) => {
                setInstructions(value);
                setSaved(false);
              }}
              onBusyChange={setImporting}
              scope="preset"
            />
          </fieldset>
          <div className="daddy-form-actions">
            <button className="daddy-button primary" disabled={busy || importing || !name.trim()}>
              <Save size={15} />
              {t('Save preset')}
            </button>
            <button
              type="button"
              className="daddy-button quiet"
              disabled={busy}
              onClick={() => setOpen(false)}
            >
              {t('Cancel')}
            </button>
            {editing && (
              <button
                type="button"
                className="daddy-text-button"
                disabled={busy || importing}
                onClick={() => void remove()}
              >
                <Trash2 size={15} />
                {t('Delete preset')}
              </button>
            )}
          </div>
          {saved && (
            <p role="status" className="daddy-muted">
              {t('Preset saved. Choose it when creating a session.')}
            </p>
          )}
        </form>
      )}
      {error && (
        <p role="alert" className="daddy-field-error">
          {t(error)}
        </p>
      )}
    </div>
  );
}
