import { VoiceInput, appendDictation } from './voice-input.js';
import { useRef, useState } from 'react';
import { ChevronDown, RefreshCw, Settings2 } from 'lucide-react';
import type { DaddyApi, DaddyBoard } from '../client/daddy.js';
import { sameAgentProfile, type AgentProfile, type WorkerSlot } from '../core/types.js';
import type { RepositorySelection } from '../core/workspace-registry.js';
import { profileText, taskReference } from '../core/task-activity.js';
import { AgentProfileFields, useAgentCatalogue } from './agent-profile-fields.js';
import { WorkspaceFields } from './workspace-fields.js';
import { useLocale } from './i18n.js';

export function QueueTaskForm({
  api,
  board,
  onQueued,
}: {
  api: DaddyApi;
  board: DaddyBoard;
  onQueued: (id: string) => void;
}) {
  const { t } = useLocale();
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [requirements, setRequirements] = useState('');
  const [slot, setSlot] = useState('');
  const [profile, setProfile] = useState<AgentProfile>({ engine: board.workerDefault.engine });
  const [repository, setRepository] = useState<RepositorySelection>();
  const [editingRepository, setEditingRepository] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const { catalogue, load } = useAgentCatalogue(api, false);
  const last = useRef<{ key: string; id: string } | undefined>(undefined);
  const submit = async () => {
    if (busy || voiceBusy || editingRepository || !requirements.trim()) return;
    const input = {
      requirements: requirements.trim(),
      repository,
      workerRequest: {
        slot: slot ? Number(slot) : undefined,
        profile: profile.model ? profile : undefined,
      },
    };
    const key = JSON.stringify(input);
    if (last.current?.key !== key) last.current = { key, id: crypto.randomUUID() };
    setBusy(true);
    setError('');
    try {
      const task = await api<{ id: string }>(`/daddy/sessions/${board.group.id}/tasks`, {
        ...input,
        requestId: last.current.id,
      });
      onQueued(task.id);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="daddy-form"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <label>
        {t('Task description')}
        <textarea
          data-autofocus
          required
          maxLength={20000}
          rows={5}
          value={requirements}
          onChange={(event) => setRequirements(event.target.value)}
        />
      </label>
      <VoiceInput
        onBusy={setVoiceBusy}
        disabled={busy}
        onText={(text) => setRequirements(appendDictation(requirements, text))}
      />
      <label>
        {t('Assign to worker')}
        <select value={slot} onChange={(event) => setSlot(event.target.value)}>
          <option value="">{t('Any free worker')}</option>
          {board.workers.slots
            .filter(({ number }) => number <= board.workers.target)
            .map(({ number }) => (
              <option key={number} value={number}>
                {t('Worker {number}', { number })}
              </option>
            ))}
        </select>
      </label>
      <details
        className="daddy-advanced-settings"
        onToggle={(event) => {
          if (event.currentTarget.open && !catalogue.models.length) void load();
        }}
      >
        <summary>
          <ChevronDown size={15} />
          {t('Choose a model')}
        </summary>
        <AgentProfileFields
          profile={profile}
          catalogue={catalogue}
          onChange={setProfile}
          modelPlaceholder="Use the worker model"
        />
        <button type="button" className="daddy-text-button" onClick={() => void load(true)}>
          <RefreshCw size={14} />
          {t('Refresh model list')}
        </button>
        {catalogue.error && (
          <p className="daddy-field-error" role="alert">
            {t(catalogue.error)}
          </p>
        )}
      </details>
      <WorkspaceFields
        api={api}
        workspace={board.workspace}
        sessionId={board.group.id}
        target="task"
        value={repository}
        onChange={setRepository}
        onEditingChange={setEditingRepository}
      />
      {error && (
        <p className="daddy-field-error" role="alert">
          {t(error)}
        </p>
      )}
      <button
        className="daddy-button primary"
        disabled={busy || voiceBusy || editingRepository || !requirements.trim()}
      >
        {t('Queue task')}
      </button>
    </form>
  );
}

export function WorkerControls({
  api,
  board,
  onChange,
}: {
  api: DaddyApi;
  board: DaddyBoard;
  onChange: () => Promise<void>;
}) {
  const { t } = useLocale();
  const [editing, setEditing] = useState<WorkerSlot>();
  if (editing)
    return (
      <WorkerProfileForm
        api={api}
        board={board}
        slot={editing}
        onCancel={() => setEditing(undefined)}
        onSaved={async () => {
          await onChange();
          setEditing(undefined);
        }}
      />
    );
  return (
    <ul className="daddy-worker-list">
      {board.workers.slots.map((slot) => {
        const task = board.tasks.find(({ id }) => id === slot.taskId);
        const configured = slot.profile ?? board.workerDefault;
        const profile = task?.worker ?? configured;
        return (
          <li key={slot.number}>
            <button
              className="daddy-work-item"
              type="button"
              onClick={() => setEditing(slot)}
              disabled={!!board.group.deletion}
              aria-label={t('Configure worker {number}', { number: slot.number })}
            >
              <div>
                <strong>{t('Worker {number}', { number: slot.number })}</strong>
                <Settings2 size={16} />
              </div>
              <strong>{profileText(profile)}</strong>
              {task && (
                <small>
                  {taskReference(task)} · {task.title}
                </small>
              )}
              <small>{t(task?.statusLabel ?? 'Free')}</small>
              {!sameAgentProfile(profile, configured) && (
                <small>{t('Next task · {profile}', { profile: profileText(configured) })}</small>
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function WorkerProfileForm({
  api,
  board,
  slot,
  onCancel,
  onSaved,
}: {
  api: DaddyApi;
  board: DaddyBoard;
  slot: WorkerSlot;
  onCancel: () => void;
  onSaved: () => Promise<void>;
}) {
  const { t } = useLocale();
  const { catalogue, load } = useAgentCatalogue(api);
  const [profile, setProfile] = useState(slot.profile ?? board.workerDefault);
  const [force, setForce] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const task = board.tasks.find(({ id }) => id === slot.taskId);
  const submit = async () => {
    if (busy || !profile.model) return;
    setBusy(true);
    setError('');
    try {
      await api(`/daddy/sessions/${board.group.id}/workers/${slot.number}`, {
        profile,
        forceTaskId: force ? slot.taskId : undefined,
      });
      await onSaved();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="daddy-form"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <fieldset disabled={busy}>
        <legend>{t('Worker {number}', { number: slot.number })}</legend>
        <AgentProfileFields profile={profile} catalogue={catalogue} onChange={setProfile} />
        <button type="button" className="daddy-text-button" onClick={() => void load(true)}>
          <RefreshCw size={14} />
          {t('Refresh model list')}
        </button>
      </fieldset>
      {task && (
        <label className="daddy-toggle">
          <input
            type="checkbox"
            checked={force}
            onChange={(event) => setForce(event.target.checked)}
          />
          <span>
            {t('Apply to current task')}
            <small className="daddy-muted">
              {taskReference(task)} · {task.title}
              <br />
              {t('An active worker step restarts in the same working copy.')}
            </small>
          </span>
        </label>
      )}
      {(error || catalogue.error) && (
        <p className="daddy-field-error" role="alert">
          {t(error || catalogue.error!)}
        </p>
      )}
      <div className="daddy-actions">
        <button type="button" className="daddy-button quiet" onClick={onCancel}>
          {t('Back')}
        </button>
        <button className="daddy-button primary" disabled={busy || !profile.model}>
          {t('Save model')}
        </button>
      </div>
    </form>
  );
}
