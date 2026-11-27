import { useCallback, useEffect, useRef, useState } from 'react';
import type { DaddyApi } from '../client/daddy.js';
import type { ModelOption } from '../core/agents.js';
import { profileText } from '../core/task-activity.js';
import type { AgentProfile } from '../core/types.js';
import { useLocale } from './i18n.js';

type Catalogue = {
  models: ModelOption[];
  engines: { id: string; name: string }[];
  error?: string;
};

export function useAgentCatalogue(api: DaddyApi, loadOnMount = true) {
  const [catalogue, setCatalogue] = useState<Catalogue>({ models: [], engines: [] });
  const request = useRef<AbortController | undefined>(undefined);
  const load = useCallback(
    async (refresh = false) => {
      request.current?.abort();
      const controller = new AbortController();
      request.current = controller;
      try {
        const result = await api<Catalogue>(
          '/agents' + (refresh ? '?refresh=1' : ''),
          undefined,
          controller.signal,
        );
        if (!controller.signal.aborted) setCatalogue(result);
      } catch (error) {
        if (!controller.signal.aborted)
          setCatalogue((value) => ({ ...value, error: (error as Error).message }));
      }
    },
    [api],
  );
  useEffect(() => {
    if (loadOnMount) void load();
    return () => request.current?.abort();
  }, [load, loadOnMount]);
  return { catalogue, load };
}

export function AgentProfileFields({
  label,
  profile,
  catalogue,
  onChange,
  modelPlaceholder = 'Engine configuration',
  selectDefaultEffort = false,
  inheritEngine,
}: {
  label?: string;
  profile: AgentProfile;
  catalogue: Catalogue;
  onChange: (profile: AgentProfile) => void;
  modelPlaceholder?: string;
  selectDefaultEffort?: boolean;
  inheritEngine?: { active: boolean; onSelect: () => void };
}) {
  const { t } = useLocale();
  const choices = catalogue.models.filter((model) => model.engine === profile.engine);
  const model = choices.find((model) => model.id === profile.model);
  const scopedLabel = (value: string) => (label ? label + ' ' + t(value) : t(value));
  return (
    <>
      <label>
        {t('Agent module')}
        <select
          aria-label={scopedLabel('Agent module')}
          value={inheritEngine?.active ? '' : profile.engine}
          onChange={(event) => {
            if (!event.target.value) inheritEngine?.onSelect();
            else onChange({ engine: event.target.value });
          }}
        >
          {inheritEngine && <option value="">{t('Inherit worker profile')}</option>}
          {!catalogue.engines.some((engine) => engine.id === profile.engine) && (
            <option value={profile.engine}>{profile.engine}</option>
          )}
          {catalogue.engines.map((engine) => (
            <option key={engine.id} value={engine.id}>
              {engine.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        {t('Model')}
        <select
          aria-label={scopedLabel('Model')}
          value={profile.model ?? ''}
          onChange={(event) => {
            const modelId = event.target.value;
            if (modelId === profile.model) return;
            const selected = choices.find((item) => item.id === modelId);
            onChange({
              engine: profile.engine,
              ...(selected
                ? {
                    model: selected.id,
                    effort: selectDefaultEffort ? selected.defaultEffort : undefined,
                  }
                : {}),
            });
          }}
        >
          <option value="">{t(modelPlaceholder)}</option>
          {profile.model && !model && <option value={profile.model}>{profile.model}</option>}
          {choices.map((item) => (
            <option value={item.id} key={item.id}>
              {item.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        {t('Reasoning effort')}
        <select
          aria-label={scopedLabel('Reasoning effort')}
          value={profile.effort ?? ''}
          disabled={!profile.model}
          onChange={(event) => onChange({ ...profile, effort: event.target.value || undefined })}
        >
          <option value="">{t('Default')}</option>
          {profile.effort && !model?.efforts.includes(profile.effort) && (
            <option value={profile.effort}>{profile.effort}</option>
          )}
          {model?.efforts.map((effort) => (
            <option value={effort} key={effort}>
              {effort}
            </option>
          ))}
        </select>
      </label>
    </>
  );
}

export function ArchitectProfileFields({
  profile,
  inherited,
  session,
  catalogue,
  onChange,
}: {
  profile?: AgentProfile;
  inherited: AgentProfile;
  session?: boolean;
  catalogue: Catalogue;
  onChange: (profile: AgentProfile | undefined) => void;
}) {
  const { t } = useLocale();
  return (
    <fieldset>
      <legend>{t('Architect')}</legend>
      <label className="daddy-toggle">
        <input
          type="checkbox"
          checked={!profile}
          onChange={(e) => onChange(e.target.checked ? undefined : { ...inherited })}
        />
        {t(session ? 'Use the shared reviewer profile' : 'Use the session architect profile')} ·{' '}
        {profileText(inherited)}
      </label>
      {profile && (
        <AgentProfileFields
          label={t('Architect')}
          profile={profile}
          catalogue={catalogue}
          onChange={onChange}
          selectDefaultEffort
        />
      )}
    </fieldset>
  );
}
