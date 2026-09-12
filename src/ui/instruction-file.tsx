import type { ChangeEventHandler } from 'react';
import { FileText, Folder } from 'lucide-react';
import { useLocale } from './i18n.js';
export function InstructionFile({
  label,
  accept,
  disabled,
  onChange,
  directory = false,
  multiple = false,
}: {
  label: string;
  accept?: string;
  disabled: boolean;
  onChange: ChangeEventHandler<HTMLInputElement>;
  directory?: boolean;
  multiple?: boolean;
}) {
  const { t } = useLocale();
  return (
    <span className={'daddy-file-picker' + (disabled ? ' disabled' : '')}>
      <span className="daddy-button outline" aria-hidden="true">
        {directory ? <Folder size={15} /> : <FileText size={15} />}
        {t(directory ? 'Choose a folder' : multiple ? 'Choose files' : 'Choose a file')}
      </span>
      <input
        type="file"
        aria-label={label}
        accept={accept}
        disabled={disabled}
        onChange={(event) => {
          try {
            onChange(event);
          } finally {
            event.currentTarget.value = '';
          }
        }}
        multiple={directory || multiple}
        {...(directory ? { webkitdirectory: '' } : {})}
      />
    </span>
  );
}
