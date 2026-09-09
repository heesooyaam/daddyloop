import { useEffect, useState } from 'react';
import type {
  AgentProfile,
  AgentProfiles,
  ReviewGroup,
  Task,
  TicketSource,
} from '../core/types.js';
import type { ModelOption } from '../core/agents.js';
type Api = <T>(path: string, body?: unknown) => Promise<T>;
export interface AgentSettings {
  models: ModelOption[];
  defaults: AgentProfiles;
  maxConcurrentAgents: number;
  error?: string;
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
  const model = models.find((model) => model.id === value.model);
  return (
    <fieldset className="agent-profile">
      <legend>{label}</legend>
      <div className="form-row">
        <label>
          Model
          <select
            aria-label={`${label} model`}
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
            <option value="">Use Codex configuration</option>
            {value.model && !model && (
              <option value={value.model}>{value.model} (configured)</option>
            )}
            {models.map((model) => (
              <option value={model.id} key={model.id}>
                {model.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Reasoning
          <select
            aria-label={`${label} effort`}
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
            <option value="">Model default</option>
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
          Child of <strong>{parent.task.title}</strong>. This task gets its own author and shares
          the group reviewer.
        </p>
      )}
      <label>
        GitHub issue or Tracker ticket
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
        Preview ticket
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
          <small>Description and comments will be saved with the task.</small>
        </div>
      )}
      <label>
        Repository path on the service host
        <input
          required
          value={repoPath}
          onChange={(event) => setRepo(event.target.value)}
          placeholder="/home/you/projects/repo or /home/you/arcadia2"
        />
        <small>Each author gets a separate working copy. The source checkout is preserved.</small>
      </label>
      {settings && profiles && (
        <>
          <ProfileFields
            label="Author for this ticket"
            value={profiles.author}
            models={settings.models}
            onChange={(author) => setProfiles({ ...profiles, author })}
          />
          <ProfileFields
            label={parent ? 'Shared reviewer (inherited from parent)' : 'Reviewer for this group'}
            disabled={!!parent}
            value={profiles.reviewer}
            models={settings.models}
            onChange={(reviewer) => setProfiles({ ...profiles, reviewer })}
          />
          {settings.error && (
            <p className="field-error">
              Model list unavailable. Connect Codex with <code>reviewctl auth codex</code>.
            </p>
          )}
        </>
      )}
      <label className="checkbox-label">
        <input type="checkbox" checked={auto} onChange={(event) => setAuto(event.target.checked)} />
        <span>
          <strong>Publish finished reviews automatically</strong>
          <small>The reviewer sends comments to the author without waiting for you.</small>
        </span>
      </label>
      <label className="checkbox-label">
        <input
          type="checkbox"
          checked={submit}
          onChange={(event) => setSubmit(event.target.checked)}
        />
        <span>
          <strong>Create a PR after implementation</strong>
          <small>
            Start with discussion. When you start implementation, the saved result enters the review
            loop automatically.
          </small>
        </span>
      </label>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      <button className="button primary" disabled={busy}>
        {busy ? 'Importing…' : 'Import ticket and start chat'}
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
        Apply to
        <select value={scope} onChange={(event) => setScope(event.target.value)}>
          {selected && <option value="task">Selected task / shared reviewer group</option>}
          <option value="defaults">Defaults for new tasks</option>
        </select>
      </label>
      {settings && profiles && (
        <>
          {settings.error && <p className="field-error">{settings.error}</p>}
          <ProfileFields
            label="Author"
            value={profiles.author}
            models={settings.models}
            onChange={(author) => setProfiles({ ...profiles, author })}
          />
          {scope === 'task' && (
            <button className="button small" disabled={busy} onClick={() => void save('author')}>
              Save this author
            </button>
          )}
          <ProfileFields
            label={
              scope === 'task' && selected?.group
                ? `Shared reviewer · ${selected.group.title}`
                : 'Reviewer'
            }
            value={profiles.reviewer}
            models={settings.models}
            onChange={(reviewer) => setProfiles({ ...profiles, reviewer })}
          />
          {scope === 'task' && (
            <button className="button small" disabled={busy} onClick={() => void save('reviewer')}>
              Save reviewer
            </button>
          )}
          {scope === 'defaults' && (
            <>
              <label>
                Concurrent agents
                <input
                  type="number"
                  min={1}
                  max={8}
                  value={maxAgents}
                  onChange={(event) => setMax(Number(event.target.value))}
                />
                <small>
                  Raise this to run independent authors together. Each group still has only one
                  active reviewer; host resource limits remain in force.
                </small>
              </label>
              <button className="button primary" disabled={busy} onClick={() => void save()}>
                Save defaults
              </button>
            </>
          )}
        </>
      )}
      {notice && <p className="planning-note">{notice}</p>}
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
export function NotificationsForm({ api }: { api: Api }) {
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
      <p>Send updates to your paired private Telegram bot chat.</p>
      {value && (
        <>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={value.enabled}
              onChange={(event) => setValue({ ...value, enabled: event.target.checked })}
            />
            <span>Enable Telegram notifications</span>
          </label>
          <label>
            Notify me
            <select
              value={value.mode}
              onChange={(event) =>
                setValue({ ...value, mode: event.target.value as 'attention' | 'all' })
              }
            >
              <option value="attention">When work finishes or needs my input</option>
              <option value="all">All agent replies and review milestones</option>
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
            Save notifications
          </button>
        </>
      )}
      {!paired && (
        <p className="planning-note">
          Connect your bot once on the host: <code>reviewctl telegram setup</code>. Notifications
          start after private-chat pairing.
        </p>
      )}
      {message && <p role="status">{message}</p>}
    </div>
  );
}
