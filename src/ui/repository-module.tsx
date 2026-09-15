import { useEffect, useState } from 'react';
import type { DaddyApi } from '../client/daddy.js';
import { useLocale } from './i18n.js';

export function RepositoryModuleField({
  api,
  value,
  onChange,
}: {
  api: DaddyApi;
  value?: string;
  onChange: (value?: string) => void;
}) {
  const { t } = useLocale();
  const [modules, setModules] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    const controller = new AbortController();
    void api<{ id: string; name: string }[]>('/workspaces/modules', undefined, controller.signal)
      .then(setModules)
      .catch(() => {});
    return () => controller.abort();
  }, [api]);
  return (
    <label>
      {t('Repository service')}
      <select value={value ?? ''} onChange={(event) => onChange(event.target.value || undefined)}>
        <option value="">{t('Detect from address')}</option>
        {modules.map((module) => (
          <option key={module.id} value={module.id}>
            {module.name}
          </option>
        ))}
      </select>
      <small>{t('Choose the service explicitly for a company Git server.')}</small>
    </label>
  );
}
