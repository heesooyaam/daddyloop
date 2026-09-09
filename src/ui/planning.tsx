import { useLocale } from './i18n.js';
import { useEffect, useState } from 'react';
import type {
  AgentProfile,
  AgentProfiles,
  ReviewGroup,
  Task,
  TicketSource,
} from '../core/types.js';
import type { ModelOption } from '../core/agents.js';
import type { ModelCatalogueInfo } from '../core/agents.js';
type Api = <T>(path: string, body?: unknown) => Promise<T>;
export interface AgentSettings {
  models: ModelOption[];
  defaults: AgentProfiles;
  maxConcurrentAgents: number;
  error?: string;
  catalogue?: ModelCatalogueInfo;
}
function ModelSource({
  api,
  settings,
  onRefresh,
}: {
  api: Api;
  settings: AgentSettings;
  onRefresh: (settings: AgentSettings) => void;
}) {
  const { t: tr, locale } = useLocale();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  return (
    <section className="model-source">
      <strong>{tr('Source: Codex app-server model/list')}</strong>
      <small>
        {tr('The model list is provided by your CLI and account, not maintained in Reviewloop.')}
      </small>
      {settings.catalogue?.cliVersion && (
        <small>
          Codex CLI <code>{settings.catalogue.cliVersion}</code>
        </small>
      )}
      {settings.catalogue?.retrievedAt && (
        <small>
          {tr('Retrieved: {time}', {
            time: new Date(settings.catalogue.retrievedAt).toLocaleString(locale),
          })}
        </small>
      )}
      <small>{tr('Cached for up to 5 minutes. Refresh queries the CLI again.')}</small>
      <button
        type="button"
        className="button small"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError('');
          try {
            onRefresh(await api<AgentSettings>('/agents?refresh=1'));
          } catch (error) {
            setError((error as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {tr(busy ? 'Refreshing…' : 'Refresh model list')}
      </button>
      <small>{tr('Claude integration is not implemented yet.')}</small>
      {settings.error && <p className="field-error">{settings.error}</p>}
      {error && <p className="field-error">{error}</p>}
    </section>
  );
}
export const profileLabel = (profile?: AgentProfile) =>
  profile?.model
    ? `${profile.model}${profile.effort ? ' · ' + profile.effort : ''}`
    : 'Codex default';
function ProfileFields({
  label,
  value,
  models,
  onChange,
  disabled = false,
}: {
  label: string;
  value: AgentProfile;
  models: ModelOption[];
  onChange: (value: AgentProfile) => void;
  disabled?: boolean;
}) {
  const { t: tr } = useLocale();

  const model = models.find((model) => model.id === value.model);
  return (
    <fieldset className="agent-profile">
      <legend>{tr(label)}</legend>
      <div className="form-row">
        <label>
          {tr(' Model ')}
          <select
            aria-label={tr('{v0} model', { v0: label })}
            disabled={disabled}
            value={value.model ?? ''}
            onChange={(event) => {
              const selected = models.find((model) => model.id === event.target.value);
              onChange(
                selected
                  ? {
                      engine: 'codex',
                      model: selected.id,
                      effort: (value.effort && selected.efforts.includes(value.effort)
                        ? value.effort
                        : selected.defaultEffort) as AgentProfile['effort'],
                    }
                  : { engine: 'codex' },
              );
            }}
          >
            <option value="">{tr('Use Codex configuration')}</option>
            {value.model && !model && (
              <option value={value.model}>
                {value.model}
                {tr(' (configured)')}
              </option>
            )}
            {models.map((model) => (
              <option value={model.id} key={model.id}>
                {model.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          {tr(' Reasoning ')}
          <select
            aria-label={tr('{v0} effort', { v0: label })}
            disabled={disabled || !value.model}
            value={value.effort ?? ''}
            onChange={(event) =>
              onChange({
                ...value,
                effort: event.target.value
                  ? (event.target.value as AgentProfile['effort'])
                  : undefined,
              })
            }
          >
            <option value="">{tr('Model default')}</option>
            {(model?.efforts ?? (value.effort ? [value.effort] : [])).map((effort) => (
              <option key={effort} value={effort}>
                {effort}
              </option>
            ))}
          </select>
        </label>
      </div>
    </fieldset>
  );
}
export function TicketForm({
  api,
  parent,
  onCreated,
}: {
  api: Api;
  parent?: { task: Task; agents?: AgentProfiles; group?: ReviewGroup };
  onCreated: (task: Task) => void;
}) {
  const { t: tr } = useLocale();

  const [source, setSource] = useState(''),
    [repoPath, setRepo] = useState(parent?.task.repoPath ?? '');
  const [settings, setSettings] = useState<AgentSettings>(),
    [profiles, setProfiles] = useState<AgentProfiles>();
  const [preview, setPreview] = useState<TicketSource>(),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const [auto, setAuto] = useState(true),
    [submit, setSubmit] = useState(true);
  useEffect(() => {
    void api<AgentSettings>('/agents')
      .then((value) => {
        setSettings(value);
        setProfiles({
          author: value.defaults.author,
          reviewer: parent?.agents?.reviewer ?? value.defaults.reviewer,
        });
      })
      .catch((error) => setError(error.message));
  }, []);
  return (
    <form
      className="task-form"
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        setError('');
        try {
          onCreated(
            await api<Task>('/tickets', {
              source,
              repoPath,
              ...(parent ? { parentTaskId: parent.task.id } : {}),
              ...(profiles ? { agents: profiles } : {}),
              publication: auto ? 'auto' : 'human',
              autoPush: submit,
            }),
          );
        } catch (error) {
          setError((error as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      {parent && (
        <p className="planning-note">
          {tr(' Child of ')}
          <strong>{parent.task.title}</strong>
          {tr('. This task gets its own author and shares the group reviewer. ')}
        </p>
      )}
      <label>
        {tr(' GitHub issue or Tracker ticket ')}
        <input
          required
          value={source}
          onChange={(event) => {
            setSource(event.target.value);
            setPreview(undefined);
          }}
          placeholder="https://github.com/owner/repo/issues/42 or QUEUE-123"
        />
      </label>
      <button
        type="button"
        className="button small"
        disabled={!source || busy}
        onClick={async () => {
          setBusy(true);
          setError('');
          try {
            setPreview(
              (await api<{ source: TicketSource }>('/tickets/preview', { source })).source,
            );
          } catch (error) {
            setError((error as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {tr(' Preview ticket ')}
      </button>
      {preview && (
        <div className="ticket-preview">
          <strong>
            {preview.key} · {preview.title}
          </strong>
          <p>
            {preview.body.slice(0, 1200)}
            {preview.body.length > 1200 ? '…' : ''}
          </p>
          <small>{tr('Description and comments will be saved with the task.')}</small>
        </div>
      )}
      <label>
        {tr(' Repository path on the service host ')}
        <input
          required
          value={repoPath}
          onChange={(event) => setRepo(event.target.value)}
          placeholder="/home/you/projects/repo or /home/you/arcadia2"
        />
        <small>
          {tr('Each author gets a separate working copy. The source checkout is preserved.')}
        </small>
      </label>
      {settings && profiles && (
        <>
          <ModelSource api={api} settings={settings} onRefresh={setSettings} />
          <ProfileFields
            label={tr('Author for this ticket')}
            value={profiles.author}
            models={settings.models}
            onChange={(author) => setProfiles({ ...profiles, author })}
          />
          <ProfileFields
            label={
              parent ? tr('Shared reviewer (inherited from parent)') : tr('Reviewer for this group')
            }
            disabled={!!parent}
            value={profiles.reviewer}
            models={settings.models}
            onChange={(reviewer) => setProfiles({ ...profiles, reviewer })}
          />
          {settings.error && (
            <p className="field-error">
              {tr(' Model list unavailable. Connect Codex with ')}
              <code>{tr('reviewctl auth codex')}</code>.
            </p>
          )}
        </>
      )}
      <label className="checkbox-label">
        <input type="checkbox" checked={auto} onChange={(event) => setAuto(event.target.checked)} />
        <span>
          <strong>{tr('Publish finished reviews automatically')}</strong>
          <small>{tr('The reviewer sends comments to the author without waiting for you.')}</small>
        </span>
      </label>
      <label className="checkbox-label">
        <input
          type="checkbox"
          checked={submit}
          onChange={(event) => setSubmit(event.target.checked)}
        />
        <span>
          <strong>{tr('Create a PR after implementation')}</strong>
          <small>
            {tr(
              ' Start with discussion. When you start implementation, the saved result enters the review loop automatically. ',
            )}
          </small>
        </span>
      </label>
      {error && (
        <p className="field-error" role="alert">
          {tr(error)}
        </p>
      )}
      <button className="button primary" disabled={busy}>
        {busy ? tr('Importing…') : tr('Import ticket and start chat')}
      </button>
    </form>
  );
}
export function AgentSettingsForm({
  api,
  selected,
  onSaved,
}: {
  api: Api;
  selected?: { task: Task; agents?: AgentProfiles; group?: ReviewGroup };
  onSaved: () => void;
}) {
  const { t: tr } = useLocale();

  const [settings, setSettings] = useState<AgentSettings>(),
    [profiles, setProfiles] = useState<AgentProfiles>();
  const [scope, setScope] = useState(selected ? 'task' : 'defaults'),
    [maxAgents, setMax] = useState(1);
  const [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    void api<AgentSettings>('/agents')
      .then((value) => {
        setSettings(value);
        setProfiles(scope === 'task' ? (selected?.agents ?? value.defaults) : value.defaults);
        setMax(value.maxConcurrentAgents);
      })
      .catch((error) => setError(error.message));
  }, [scope]);
  const save = async (role?: 'author' | 'reviewer') => {
    if (!profiles) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      if (scope === 'defaults')
        await api('/agents/defaults', { profiles, maxConcurrentAgents: maxAgents });
      else if (selected && role)
        await api(`/tasks/${selected.task.id}/agents`, { role, profile: profiles[role] });
      setNotice('Settings saved. Queued/running jobs keep their recorded profile.');
      onSaved();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="task-form">
      <label>
        {tr(' Apply to ')}
        <select value={scope} onChange={(event) => setScope(event.target.value)}>
          {selected && <option value="task">{tr('Selected task / shared reviewer group')}</option>}
          <option value="defaults">{tr('Defaults for new tasks')}</option>
        </select>
      </label>
      {settings && profiles && (
        <>
          <ModelSource api={api} settings={settings} onRefresh={setSettings} />
          {settings.error && <p className="field-error">{settings.error}</p>}
          <ProfileFields
            label={tr('Author')}
            value={profiles.author}
            models={settings.models}
            onChange={(author) => setProfiles({ ...profiles, author })}
          />
          {scope === 'task' && (
            <button className="button small" disabled={busy} onClick={() => void save('author')}>
              {tr(' Save this author ')}
            </button>
          )}
          <ProfileFields
            label={
              scope === 'task' && selected?.group
                ? tr('Shared reviewer · {v0}', { v0: selected.group.title })
                : tr('Reviewer')
            }
            value={profiles.reviewer}
            models={settings.models}
            onChange={(reviewer) => setProfiles({ ...profiles, reviewer })}
          />
          {scope === 'task' && (
            <button className="button small" disabled={busy} onClick={() => void save('reviewer')}>
              {tr(' Save reviewer ')}
            </button>
          )}
          {scope === 'defaults' && (
            <>
              <label>
                {tr(' Concurrent agents ')}
                <input
                  type="number"
                  min={1}
                  max={8}
                  value={maxAgents}
                  onChange={(event) => setMax(Number(event.target.value))}
                />
                <small>
                  {tr(
                    ' Raise this to run independent authors together. Each group still has only one active reviewer; host resource limits remain in force. ',
                  )}
                </small>
              </label>
              <button className="button primary" disabled={busy} onClick={() => void save()}>
                {tr(' Save defaults ')}
              </button>
            </>
          )}
        </>
      )}
      {notice && <p className="planning-note">{tr(notice)}</p>}
      {error && (
        <p className="field-error" role="alert">
          {tr(error)}
        </p>
      )}
    </div>
  );
}
export function NotificationsForm({ api }: { api: Api }) {
  const { t: tr } = useLocale();

  const [value, setValue] = useState<{ enabled: boolean; mode: 'attention' | 'all' }>(),
    [paired, setPaired] = useState(false),
    [message, setMessage] = useState('');
  useEffect(() => {
    void api<{ telegram: NonNullable<typeof value>; paired: boolean }>('/notifications')
      .then((result) => {
        setValue(result.telegram);
        setPaired(result.paired);
      })
      .catch((error) => setMessage(error.message));
  }, []);
  return (
    <div className="task-form">
      <p>{tr('Send updates to your paired private Telegram bot chat.')}</p>
      {value && (
        <>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={value.enabled}
              onChange={(event) => setValue({ ...value, enabled: event.target.checked })}
            />
            <span>{tr('Enable Telegram notifications')}</span>
          </label>
          <label>
            {tr(' Notify me ')}
            <select
              value={value.mode}
              onChange={(event) =>
                setValue({ ...value, mode: event.target.value as 'attention' | 'all' })
              }
            >
              <option value="attention">{tr('When work finishes or needs my input')}</option>
              <option value="all">{tr('All agent replies and review milestones')}</option>
            </select>
          </label>
          <button
            className="button primary"
            onClick={async () => {
              try {
                await api('/notifications', value);
                setMessage('Notification preferences saved.');
              } catch (error) {
                setMessage((error as Error).message);
              }
            }}
          >
            {tr(' Save notifications ')}
          </button>
        </>
      )}
      {!paired && (
        <p className="planning-note">
          {tr(' Connect your bot once on the host: ')}
          <code>{tr('reviewctl telegram setup')}</code>
          {tr('. Notifications start after private-chat pairing. ')}
        </p>
      )}
      {message && <p role="status">{message}</p>}
    </div>
  );
}
