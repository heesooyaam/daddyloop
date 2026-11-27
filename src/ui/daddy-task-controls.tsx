import { VoiceInput, appendDictation } from './voice-input.js';
import { useRef, useState } from 'react';
import { ChevronDown, RefreshCw, Settings2 } from 'lucide-react';
import type { DaddyApi, DaddyBoard } from '../client/daddy.js';
import { sameAgentProfile, type AgentProfile, type Task, type WorkerSlot } from '../core/types.js';
import type { RepositorySelection } from '../core/workspace-registry.js';
import { canResumeAfterReviewLimit, profileText, taskReference } from '../core/task-activity.js';
import {
  AgentProfileFields,
  ArchitectProfileFields,
  useAgentCatalogue,
} from './agent-profile-fields.js';
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
  const [shownGeneration, setShownGeneration] = useState(board.group.generation);
  const [slot, setSlot] = useState('');
  const [profile, setProfile] = useState<AgentProfile>();
  const [repository, setRepository] = useState<RepositorySelection>();
  const [editingRepository, setEditingRepository] = useState(false);
  const [validatePlan, setValidatePlan] = useState(true);
  const [architect, setArchitect] = useState<AgentProfile>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [stale, setStale] = useState(false);
  const { catalogue, load } = useAgentCatalogue(api, false);
  const last = useRef<{ key: string; id: string } | undefined>(undefined);
  const submit = async () => {
    if (busy || stale || voiceBusy || editingRepository || !requirements.trim()) return;
    const input = {
      requirements: requirements.trim(),
      expectedGeneration: shownGeneration,
      validatePlan,
      architectProfile: validatePlan ? architect : undefined,
      repository,
      workerRequest: {
        slot: slot ? Number(slot) : undefined,
        profile,
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
      if (error instanceof Error && 'code' in error && error.code === 'stale_session')
        setStale(true);
    } finally {
      setBusy(false);
    }
  };
  const useCurrentSession = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const current = await api<DaddyBoard>(`/daddy/sessions/${board.group.id}`);
      setShownGeneration(current.group.generation);
      setStale(false);
      setError('');
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
      <label>
        <input
          type="checkbox"
          checked={validatePlan}
          onChange={(event) => setValidatePlan(event.target.checked)}
        />
        {t('Check architecture and plan before implementation')}
      </label>
      <VoiceInput
        key={board.group.id}
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
          profile={profile ?? { engine: board.workerDefault.engine }}
          catalogue={catalogue}
          onChange={setProfile}
          modelPlaceholder={profile ? 'Engine configuration' : 'Use the worker model'}
          inheritEngine={{ active: !profile, onSelect: () => setProfile(undefined) }}
        />
        {validatePlan && (
          <ArchitectProfileFields
            profile={architect}
            inherited={board.group.architectProfile ?? board.group.daddy}
            catalogue={catalogue}
            onChange={setArchitect}
          />
        )}
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
      {stale && (
        <button
          type="button"
          className="daddy-button outline"
          disabled={busy}
          onClick={() => void useCurrentSession()}
        >
          {t('Use the current session')}
        </button>
      )}
      <button
        className="daddy-button primary"
        disabled={busy || stale || voiceBusy || editingRepository || !requirements.trim()}
      >
        {t('Queue task')}
      </button>
    </form>
  );
}

export function WorkerControls({
  api,
  board,
  busy,
  onLimitChange,
  onChange,
}: {
  api: DaddyApi;
  board: DaddyBoard;
  busy: boolean;
  onLimitChange: (limit: number) => void;
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
    <>
      <label className="daddy-pool-control">
        {t('Maximum workers')}
        <select
          value={board.workers.target}
          disabled={busy || !!board.group.deletion}
          onChange={(event) => onLimitChange(Number(event.target.value))}
        >
          {[1, 2, 3, 4, 5, 6, 7, 8].map((number) => (
            <option key={number} value={number}>
              {number}
            </option>
          ))}
        </select>
      </label>
      <p className="daddy-pool-hint" role="status">
        {t(
          board.workers.pending
            ? 'Pool: {limit} → {target}. Changes apply in the background.'
            : 'Pool: {limit}. Occupied by tasks: {occupied}.',
          board.workers,
        )}
      </p>
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
    </>
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
  const [baseline] = useState(slot.profile ?? board.workerDefault);
  const [profile, setProfile] = useState(baseline);
  const [force, setForce] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [shown] = useState(() => ({
    task: board.tasks.find(({ id }) => id === slot.taskId),
    groupGeneration: board.group.generation,
  }));
  const task = shown.task;
  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await api(`/daddy/sessions/${board.group.id}/workers/${slot.number}`, {
        profile,
        baseline,
        expectedGeneration: shown.groupGeneration,
        forceTaskId: force ? task?.id : undefined,
        expected:
          force && task
            ? {
                groupGeneration: shown.groupGeneration,
                task: {
                  head: task.revision?.head ?? '',
                  revision: task.revision,
                  generation: task.generation,
                },
              }
            : undefined,
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
        <button className="daddy-button primary" disabled={busy}>
          {t('Save model')}
        </button>
      </div>
    </form>
  );
}

export function TaskReviewLimitSettings({
  api,
  board,
  task,
  disabled,
  onSaved,
}: {
  api: DaddyApi;
  board: DaddyBoard;
  task: Task;
  disabled: boolean;
  onSaved: () => Promise<void>;
}) {
  const { t } = useLocale();
  const expected = {
    task: {
      generation: task.generation,
      head: task.revision?.head ?? '',
      revision: task.revision,
    },
    groupGeneration: board.group.generation,
    limit: task.reviewRoundLimit ?? null,
  };
  const [draft, setDraft] = useState<{ expected: typeof expected; value: string }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const path = `/daddy/sessions/${board.group.id}/tasks/${task.id}/review-limit`;
  const save = async (resume: boolean) => {
    if (disabled || busy) return;
    const limit = draft?.value === '' ? null : Number(draft?.value);
    if (!resume && (!draft || (limit !== null && (!Number.isSafeInteger(limit) || limit < 1))))
      return;
    setBusy(true);
    setError('');
    try {
      if (resume) await api(path + '/resume', expected);
      else {
        await api(path, { expected: draft!.expected, limit });
        setDraft(undefined);
      }
      await onSaved();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div>
      {draft ? (
        <form
          className="daddy-form"
          onSubmit={(event) => {
            event.preventDefault();
            void save(false);
          }}
        >
          <label>
            {t('Review round limit')}
            <input
              type="number"
              min={1}
              step={1}
              placeholder={t('No limit')}
              value={draft.value}
              disabled={disabled || busy}
              onChange={(event) => setDraft({ ...draft, value: event.target.value })}
            />
          </label>
          <div className="daddy-actions">
            <button
              type="button"
              className="daddy-button quiet"
              onClick={() => {
                setDraft(undefined);
                setError('');
              }}
            >
              {t('Cancel')}
            </button>
            <button className="daddy-button primary" disabled={disabled || busy}>
              {t('Save')}
            </button>
          </div>
        </form>
      ) : (
        <div className="daddy-actions">
          <button
            type="button"
            className="daddy-button outline"
            disabled={disabled || busy}
            onClick={() => {
              setError('');
              setDraft({ expected, value: expected.limit?.toString() ?? '' });
            }}
          >
            {t('Review round limit')} · {expected.limit ?? t('No limit')}
          </button>
          {canResumeAfterReviewLimit(task) && (
            <button
              type="button"
              className="daddy-button primary"
              disabled={disabled || busy}
              onClick={() => void save(true)}
            >
              {t('Resume task')}
            </button>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="daddy-field-error">
          {t(error)}
        </p>
      )}
    </div>
  );
}

export function TaskArchitectSettings({
  api,
  board,
  taskId,
  initial,
  onSaved,
}: {
  api: DaddyApi;
  board: DaddyBoard;
  taskId: string;
  initial?: AgentProfile;
  onSaved: () => Promise<void>;
}) {
  const { t } = useLocale();
  const [profile, setProfile] = useState(initial);
  const [expected, setExpected] = useState(() => {
    const task = board.tasks.find(({ id }) => id === taskId)!;
    return {
      task: {
        generation: task.generation,
        head: task.revision?.head ?? '',
        revision: task.revision,
      },
      groupGeneration: board.group.generation,
      architectProfile: initial ?? null,
    };
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const { catalogue, load } = useAgentCatalogue(api, false);
  const inherited = board.group.architectProfile ?? board.group.daddy;
  const save = async () => {
    setBusy(true);
    setError('');
    try {
      await api(`/daddy/sessions/${board.group.id}/tasks/${taskId}/architect`, {
        profile: profile ?? null,
        expected,
      });
      setExpected({ ...expected, architectProfile: profile ?? null });
      await onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <details
      onToggle={(event) => {
        if (event.currentTarget.open) {
          const task = board.tasks.find(({ id }) => id === taskId)!;
          setProfile(initial);
          setExpected({
            task: {
              generation: task.generation,
              head: task.revision?.head ?? '',
              revision: task.revision,
            },
            groupGeneration: board.group.generation,
            architectProfile: initial ?? null,
          });
        }
        if (event.currentTarget.open && !catalogue.models.length) void load();
      }}
    >
      <summary>
        {t('Architect')} · {profileText(initial ?? inherited)}
      </summary>
      <ArchitectProfileFields
        profile={profile}
        inherited={inherited}
        catalogue={catalogue}
        onChange={setProfile}
      />
      <button
        type="button"
        className="daddy-button"
        onClick={() => void save()}
        disabled={
          busy || !!board.group.deletion || JSON.stringify(profile) === JSON.stringify(initial)
        }
      >
        {t('Apply to the next planning turn')}
      </button>
      {(error || catalogue.error) && (
        <p role="alert" className="daddy-field-error">
          {t(error || catalogue.error!)}
        </p>
      )}
    </details>
  );
}
