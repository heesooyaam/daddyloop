import { useEffect, useRef, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import type { DaddyApi } from '../client/daddy.js';
import type { SkillSnapshot } from '../core/instructions.js';
import { InstructionFile } from './instruction-file.js';
import { useLocale } from './i18n.js';
type Candidate = { file: File; path: string; selected: boolean };
export function FolderSkills({
  api,
  onImported,
  onBusyChange,
  disabled,
}: {
  api: DaddyApi;
  onImported: (skills: SkillSnapshot[]) => void;
  onBusyChange: (busy: boolean) => void;
  disabled: boolean;
}) {
  const { t } = useLocale();
  const supported = 'webkitdirectory' in document.createElement('input');
  const [directory, setDirectory] = useState(supported),
    [files, setFiles] = useState<Candidate[]>([]);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const request = useRef<AbortController | undefined>(undefined),
    imported = useRef(onImported);
  imported.current = onImported;
  useEffect(() => () => request.current?.abort(), []);
  const pending = busy || files.length > 0;
  useEffect(() => {
    onBusyChange(pending);
    return () => onBusyChange(false);
  }, [pending, onBusyChange]);
  const chosen = files.filter((item) => item.selected),
    bytes = chosen.reduce((size, item) => size + item.file.size, 0);
  const attach = async () => {
    if (busy || disabled || !chosen.length) return;
    if (chosen.length > 12 || bytes > 131072) {
      setError('Choose up to 12 files totalling at most 128 KiB');
      return;
    }
    const controller = new AbortController();
    request.current?.abort();
    request.current = controller;
    setBusy(true);
    setError('');
    try {
      const skills: SkillSnapshot[] = [];
      for (const item of chosen) {
        if (item.file.size > 65536) throw new Error('A skill must fit in 64 KiB');
        const text = await item.file.text();
        controller.signal.throwIfAborted();
        skills.push(
          await api<SkillSnapshot>(
            '/instructions/import',
            {
              kind: 'file',
              name: item.file.name,
              text,
              ...(item.file.webkitRelativePath ? { path: item.path } : {}),
            },
            controller.signal,
          ),
        );
      }
      if (!controller.signal.aborted) {
        imported.current(skills);
        setFiles([]);
      }
    } catch (error) {
      if (!controller.signal.aborted) setError((error as Error).message);
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  return (
    <section className="daddy-folder-skills" aria-label={t('Skills from a folder')}>
      <p className="daddy-muted">
        {t(
          'Choose a folder on this device, then select its instruction files. Only selected Markdown or text files are uploaded.',
        )}
      </p>
      {!supported && (
        <p className="daddy-muted">
          {t('This browser has no folder picker. Select several instruction files instead.')}
        </p>
      )}
      <InstructionFile
        label={t(directory ? 'Skill folder on this device' : 'Instruction files on this device')}
        directory={directory}
        multiple={!directory}
        disabled={busy || disabled}
        onChange={(event) => {
          const input = event.target.files;
          setError('');
          if (!input) return;
          if (input.length > 10000) {
            setFiles([]);
            setError('Choose a smaller folder with instruction files');
            return;
          }
          const candidates = Array.from(input).filter((file) => /\.(md|txt)$/i.test(file.name));
          if (candidates.length > 200) {
            setFiles([]);
            setError('Choose a smaller folder with instruction files');
            return;
          }
          const hasSkills = candidates.some((file) => /^SKILL\.md$/i.test(file.name));
          let checked = 0;
          setFiles(
            candidates.map((file) => ({
              file,
              path: file.webkitRelativePath || file.name,
              selected:
                file.size <= 65536 &&
                (!hasSkills || /^SKILL\.md$/i.test(file.name)) &&
                checked++ < 12,
            })),
          );
          if (!candidates.length) setError('No Markdown or text instruction files were found');
        }}
      />
      {supported && (
        <button
          type="button"
          className="daddy-text-button"
          disabled={busy || disabled}
          onClick={() => {
            setDirectory(!directory);
            setFiles([]);
            setError('');
          }}
        >
          {t(directory ? 'Choose individual files instead' : 'Choose a whole folder instead')}
        </button>
      )}
      {!!files.length && (
        <>
          <div className="daddy-folder-skill-list">
            {files.map((item, index) => (
              <label key={item.path + ':' + index}>
                <input
                  type="checkbox"
                  checked={item.selected}
                  disabled={busy || disabled || item.file.size > 65536}
                  aria-label={t('Include file {path}', { path: item.path })}
                  onChange={(event) =>
                    setFiles(
                      files.map((other, i) =>
                        i === index ? { ...other, selected: event.target.checked } : other,
                      ),
                    )
                  }
                />
                <span>
                  {item.path}
                  <small>
                    {Math.ceil(item.file.size / 1024)} KiB
                    {item.file.size > 65536 ? ' · ' + t('File too large') : ''}
                  </small>
                </span>
              </label>
            ))}
          </div>
          <p className="daddy-muted">{t('{count} files selected', { count: chosen.length })}</p>
          <button
            type="button"
            className="daddy-button primary"
            disabled={busy || disabled || !chosen.length || chosen.length > 12 || bytes > 131072}
            onClick={() => void attach()}
          >
            {busy && <LoaderCircle size={15} className="spin" />}
            {t('Attach selected files')}
          </button>
          {(chosen.length > 12 || bytes > 131072) && (
            <p className="daddy-field-error">
              {t('Choose up to 12 files totalling at most 128 KiB')}
            </p>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="daddy-field-error">
          {t(error)}
        </p>
      )}
    </section>
  );
}
