import { useEffect, useRef, useState, type ChangeEventHandler } from 'react';
import { FileText, LoaderCircle, Plus, Trash2 } from 'lucide-react';
import type { SessionInstructions, SkillSnapshot } from '../core/instructions.js';
import type { DaddyApi } from '../client/daddy.js';
import { useLocale } from './i18n.js';

function InstructionFile({
  label,
  accept,
  disabled,
  onChange,
}: {
  label: string;
  accept: string;
  disabled: boolean;
  onChange: ChangeEventHandler<HTMLInputElement>;
}) {
  const { t } = useLocale();
  return (
    <span className={'daddy-file-picker' + (disabled ? ' disabled' : '')}>
      <span className="daddy-button outline" aria-hidden="true">
        <FileText size={15} />
        {t('Choose a file')}
      </span>
      <input
        type="file"
        aria-label={label}
        accept={accept}
        disabled={disabled}
        onChange={onChange}
      />
    </span>
  );
}

export function InstructionFields({
  api,
  value,
  onChange,
  onBusyChange,
}: {
  api: DaddyApi;
  value?: SessionInstructions;
  onChange: (value: SessionInstructions) => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const { t } = useLocale();
  const [role, setRole] = useState<'daddy' | 'worker'>('daddy');
  const [adding, setAdding] = useState(false),
    [kind, setKind] = useState('github');
  const [source, setSource] = useState(''),
    [name, setName] = useState('');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const request = useRef<AbortController | undefined>(undefined);
  const current = useRef(value);
  current.current = value;
  const change = useRef(onChange);
  change.current = onChange;
  const instructions = value ?? { daddy: {}, worker: {} };
  const selected = instructions[role];
  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => {
    onBusyChange?.(busy);
    return () => onBusyChange?.(false);
  }, [busy, onBusyChange]);
  const cancel = () => {
    request.current?.abort();
    setBusy(false);
    setAdding(false);
    setError('');
  };
  const attach = async (input: unknown) => {
    const controller = new AbortController();
    request.current?.abort();
    request.current = controller;
    const target = role;
    setBusy(true);
    setError('');
    try {
      const skill = await api<SkillSnapshot>('/instructions/import', input, controller.signal);
      if (controller.signal.aborted) return;
      const next = current.current ?? { daddy: {}, worker: {} },
        skills = next[target].skills ?? [];
      if (!skills.some((item) => item.checksum === skill.checksum)) {
        if (skills.length >= 12) throw new Error('Choose at most 12 skills per role');
        change.current({ ...next, [target]: { ...next[target], skills: [...skills, skill] } });
      }
      setAdding(false);
      setSource('');
      setName('');
    } catch (error) {
      if (!controller.signal.aborted) setError((error as Error).message);
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  return (
    <details
      className="daddy-instructions"
      onKeyDown={(event) => {
        if (
          event.key === 'Enter' &&
          event.target instanceof HTMLInputElement &&
          event.target.type !== 'file'
        )
          event.preventDefault();
        if (event.key === 'Escape' && adding) {
          event.preventDefault();
          event.stopPropagation();
          cancel();
        }
      }}
    >
      <summary>
        <FileText size={16} />
        {t('Style and skills for this session')}
      </summary>
      <p className="daddy-muted">
        {t(
          'Only this session. Choose separate instructions for daddy and for all its workers. Saved text travels with your backup.',
        )}
      </p>
      <div className="daddy-instruction-roles">
        {(['daddy', 'worker'] as const).map((item) => (
          <button
            type="button"
            key={item}
            className={'daddy-button ' + (role === item ? 'primary' : 'quiet')}
            aria-pressed={role === item}
            disabled={busy}
            onClick={() => {
              setRole(item);
              cancel();
            }}
          >
            {item === 'daddy' ? 'daddy' : t('All workers')}
          </button>
        ))}
      </div>
      <label>
        {t('Your instructions for {role}', { role: role === 'daddy' ? 'daddy' : t('workers') })}
        <textarea
          rows={3}
          value={selected.prompt ?? ''}
          maxLength={65536}
          onChange={(event) =>
            onChange({ ...instructions, [role]: { ...selected, prompt: event.target.value } })
          }
          placeholder={t(
            'For example: answer briefly, keep technical terms exact, and explain decisions in Russian.',
          )}
        />
      </label>
      <div className="daddy-instruction-skills">
        {(selected.skills ?? []).map((skill, index) => (
          <div className="daddy-instruction-skill" key={skill.checksum}>
            <details>
              <summary>{skill.name}</summary>
              <p className="daddy-muted">{skill.source.location ?? t('Pasted instructions')}</p>
              <pre>{skill.text}</pre>
            </details>
            <button
              type="button"
              className="daddy-icon"
              aria-label={t('Remove skill {name}', { name: skill.name })}
              onClick={() =>
                onChange({
                  ...instructions,
                  [role]: { ...selected, skills: selected.skills!.filter((_, i) => i !== index) },
                })
              }
            >
              <Trash2 size={15} />
            </button>
          </div>
        ))}
      </div>
      {!adding && (
        <button type="button" className="daddy-button outline" onClick={() => setAdding(true)}>
          <Plus size={15} />
          {t('Attach a skill')}
        </button>
      )}
      {adding && (
        <div className="daddy-instruction-import">
          <label>
            {t('Skill source')}
            <select
              value={kind}
              disabled={busy}
              onChange={(event) => {
                setKind(event.target.value);
                setSource('');
                setError('');
              }}
            >
              <option value="github">GitHub</option>
              <option value="local">{t('Folder or file on the server')}</option>
              <option value="file">{t('File from this device')}</option>
              <option value="text">{t('Paste skill text')}</option>
            </select>
          </label>
          <p className="daddy-muted">
            {t(
              'Attach the Markdown instructions from SKILL.md. Native plugin installers, scripts and hooks are not run.',
            )}
          </p>
          {kind === 'file' ? (
            <label>
              {t('Markdown file')}
              <InstructionFile
                label={t('Markdown file')}
                accept=".md,.txt,text/markdown,text/plain"
                disabled={busy}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (!file) return;
                  if (file.size > 65536) {
                    setError('A skill must fit in 64 KiB');
                    return;
                  }
                  const controller = new AbortController();
                  request.current?.abort();
                  request.current = controller;
                  setBusy(true);
                  void file
                    .text()
                    .then((text) => {
                      if (!controller.signal.aborted)
                        return attach({ kind: 'file', name: file.name, text });
                    })
                    .catch((error) => {
                      if (!controller.signal.aborted) {
                        setError(error.message);
                        setBusy(false);
                      }
                    });
                }}
              />
            </label>
          ) : (
            <>
              {kind === 'text' && (
                <label>
                  {t('Skill name')}
                  <input
                    value={name}
                    maxLength={100}
                    disabled={busy}
                    onChange={(event) => setName(event.target.value)}
                  />
                </label>
              )}
              <label>
                {t(
                  kind === 'github'
                    ? 'GitHub skill URL'
                    : kind === 'local'
                      ? 'Skill path on the server'
                      : 'Skill text',
                )}
                {kind === 'text' ? (
                  <textarea
                    rows={5}
                    value={source}
                    disabled={busy}
                    maxLength={65536}
                    onChange={(event) => setSource(event.target.value)}
                  />
                ) : (
                  <input
                    value={source}
                    disabled={busy}
                    onChange={(event) => setSource(event.target.value)}
                    placeholder={
                      kind === 'github' ? 'JuliusBrussee/caveman' : '~/.agents/skills/caveman'
                    }
                  />
                )}
              </label>
              <button
                type="button"
                className="daddy-button primary"
                disabled={busy || !source.trim() || (kind === 'text' && !name.trim())}
                onClick={() =>
                  void attach(
                    kind === 'github'
                      ? { kind, url: source.trim() }
                      : kind === 'local'
                        ? { kind, path: source.trim() }
                        : { kind, name, text: source },
                  )
                }
              >
                {busy ? <LoaderCircle size={15} className="spin" /> : <Plus size={15} />}
                {t('Attach skill')}
              </button>
            </>
          )}
          <button type="button" className="daddy-button quiet" onClick={cancel}>
            {t('Cancel')}
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="daddy-field-error">
          {t(error)}
        </p>
      )}
      <div className="daddy-instruction-import">
        <button
          type="button"
          className="daddy-text-button"
          onClick={() => {
            const url = URL.createObjectURL(
              new Blob([JSON.stringify(instructions, null, 2) + '\n'], {
                type: 'application/json',
              }),
            );
            const link = document.createElement('a');
            link.href = url;
            link.download = 'daddy-instructions.json';
            link.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
          }}
        >
          {t('Download this instruction set')}
        </button>
        <label>
          {t('Load an instruction set (.json)')}
          <InstructionFile
            label={t('Load an instruction set (.json)')}
            accept=".json,application/json"
            disabled={busy}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (!file) return;
              if (file.size > 1048576) {
                setError('The instruction set file is too large');
                return;
              }
              const controller = new AbortController();
              request.current?.abort();
              request.current = controller;
              setBusy(true);
              setError('');
              void file
                .text()
                .then(async (text) => {
                  if (controller.signal.aborted) return;
                  const next = await api<SessionInstructions>(
                    '/instructions/validate',
                    JSON.parse(text),
                    controller.signal,
                  );
                  if (!controller.signal.aborted) change.current(next);
                })
                .catch((error) => {
                  if (!controller.signal.aborted) setError(error.message);
                })
                .finally(() => {
                  if (!controller.signal.aborted) setBusy(false);
                });
            }}
          />
        </label>
      </div>
      <p className="daddy-muted">
        {t(
          'Changes affect newly queued turns. Running and already queued turns keep their saved instructions.',
        )}
      </p>
    </details>
  );
}
