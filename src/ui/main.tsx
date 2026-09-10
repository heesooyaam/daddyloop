import { useLocale, LocaleProvider } from './i18n.js';
import { localeNames, type Locale } from '../i18n/index.js';
import type { Preferences } from '../core/preferences.js';
import type { UpdateStatus } from '../core/updates.js';
import { UpdatesPanel } from './runtime.js';
import { DaddyWorkspace } from './daddy.js';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  Activity,
  ArrowRight,
  ArrowUpRight,
  Bell,
  Check,
  CheckCheck,
  ChevronDown,
  Circle,
  CircleCheck,
  CirclePause,
  Code2,
  ExternalLink,
  FileText,
  FolderGit2,
  GitBranch,
  GitPullRequest,
  LayoutGrid,
  LoaderCircle,
  LockKeyhole,
  MessageSquare,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Sparkles,
  Terminal,
  X,
} from 'lucide-react';
import type {
  Task,
  Message,
  Event,
  Job,
  Decision,
  State,
  ResourceStatus,
  Policy,
  AgentProfiles,
  ReviewGroup,
  AgentProfile,
} from '../core/types';
import './style.css';
import '@fontsource-variable/inter';
import { TicketForm, AgentSettingsForm, NotificationsForm, profileLabel } from './planning.js';

type Detail = {
  task: Task;
  messages: Message[];
  events: Event[];
  jobs: Job[];
  decisions: Decision[];
  agents?: AgentProfiles;
  group?: ReviewGroup;
  siblings?: {
    id: string;
    title: string;
    state: State;
    parentTaskId?: string;
    author: AgentProfile;
  }[];
};
type Status = {
  preferences?: Preferences;
  updates?: UpdateStatus;
  version: string;
  publicOrigin: string | null;
  telegram: { configured: boolean; paired?: boolean; bot?: string; error?: string | null };
  demoEnabled: boolean;
  resources: ResourceStatus;
  connections: Record<'github' | 'gitlab', { host: string; configured: boolean }>;
  activeJobs: number;
};
class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
async function api<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const result = await fetch(`/api${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Reviewloop-Request': '1',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  const data = await result.json();
  if (!result.ok) throw new ApiError(data.error?.message ?? 'Request failed', result.status);
  return data as T;
}
const stateLabels: Record<State, string> = {
  discussing: 'Discussing ticket',
  implementing: 'Author is implementing',
  ready_for_review: 'Ready to submit',
  submitting: 'Creating PR',
  queued: 'Queued for review',
  reviewing: 'Reviewer is working',
  awaiting_publication: 'Review ready',
  fixing: 'Author is fixing',
  awaiting_push: 'Waiting for changes',
  awaiting_checks: 'Waiting for checks',
  awaiting_plan_approval: 'Plan approval',
  needs_input: 'Needs your input',
  paused: 'Paused',
  complete: 'Complete',
};
const needsAttention = (state: State) =>
  ['awaiting_publication', 'awaiting_plan_approval', 'needs_input', 'awaiting_checks'].includes(
    state,
  );
const isRunning = (state: State) => ['queued', 'reviewing', 'fixing'].includes(state);
const time = (date: string) =>
  new Date(date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const shortSha = (sha?: string) => sha?.slice(0, 8) ?? '—';
function safeLink(value: string) {
  try {
    return new URL(value).protocol === 'https:' ? value : '#';
  } catch {
    return '#';
  }
}
function StatusPill({ state }: { state: State }) {
  const { t: tr } = useLocale();

  return (
    <span
      className={`pill ${state === 'complete' ? 'green' : needsAttention(state) ? 'amber' : isRunning(state) ? 'blue' : 'neutral'}`}
    >
      {isRunning(state) ? (
        <LoaderCircle size={12} className="spin" />
      ) : state === 'complete' ? (
        <Check size={12} />
      ) : (
        <span className="status-dot" />
      )}
      {tr(stateLabels[state])}
    </span>
  );
}
function Md({ text }: { text: string }) {
  return (
    <div className="markdown">
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: (props) => <a {...props} target="_blank" rel="noreferrer" />,
        }}
      >
        {text.replace(/<!-- reviewloop:[\s\S]*?-->/g, '')}
      </Markdown>
    </div>
  );
}
function Brand() {
  return (
    <div className="brand">
      <span className="brand-icon">
        <RefreshCw size={21} />
      </span>
      <span>
        daddyloop<span className="brand-period">.</span>
      </span>
    </div>
  );
}

function App() {
  const { t: tr, locale, adopt } = useLocale();

  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [status, setStatus] = useState<Status>();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selected, setSelected] = useState<string>(() =>
    location.hash.startsWith('#task/') ? location.hash.slice(6) : '',
  );
  const [detail, setDetail] = useState<Detail>();
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const [filter, setFilter] = useState('all');
  const [tab, setTab] = useState('reviewer');
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState('');
  const [policyOpen, setPolicyOpen] = useState(false);
  const [connectionsOpen, setConnectionsOpen] = useState(false);
  const [ticketOpen, setTicketOpen] = useState<'root' | 'child' | null>(null);
  const [agentsOpen, setAgentsOpen] = useState(false);
  const [updatesOpen, setUpdatesOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const initialPair = useRef(location.hash.startsWith('#pair/') ? location.hash.slice(6) : '');
  const pairingPromise = useRef<Promise<unknown> | null>(null);
  const chatInput = useRef<HTMLTextAreaElement>(null);
  const previousStates = useRef(new Map<string, State>());
  const [notify, setNotify] = useState(false);
  const load = useCallback(async () => {
    try {
      if (initialPair.current) {
        if (!pairingPromise.current)
          pairingPromise.current = api('/session/pair', { code: initialPair.current });
        try {
          await pairingPromise.current;
        } catch (error) {
          setError((error as Error).message);
          throw error;
        } finally {
          initialPair.current = '';
          history.replaceState(null, '', location.pathname);
        }
      }
      const [nextTasks, nextStatus] = await Promise.all([
        api<Task[]>('/tasks'),
        api<Status>('/status'),
      ]);
      setAuthenticated(true);
      setTasks(nextTasks);
      setStatus(nextStatus);
      if (nextStatus.preferences) adopt(nextStatus.preferences);
      for (const task of nextTasks) {
        const previous = previousStates.current.get(task.id);
        if (
          notify &&
          previous &&
          previous !== task.state &&
          (needsAttention(task.state) || task.state === 'complete') &&
          'Notification' in window &&
          Notification.permission === 'granted'
        )
          new Notification(`Reviewloop · ${tr(stateLabels[task.state])}`, {
            body: task.title,
          });
        previousStates.current.set(task.id, task.state);
      }
      if (selected) {
        const next = await api<Detail>(`/tasks/${encodeURIComponent(selected)}`);
        if (selectedRef.current === selected) setDetail(next);
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setAuthenticated(false);
      else setError(String(e));
    }
  }, [selected, notify, adopt]);
  useEffect(() => {
    void load();
    const timer = setInterval(() => {
      void load();
    }, 4000);
    let pending: ReturnType<typeof setTimeout> | undefined;
    const events = new EventSource('/api/events');
    events.onmessage = () => {
      if (!pending)
        pending = setTimeout(() => {
          pending = undefined;
          void load();
        }, 350);
    };
    return () => {
      clearInterval(timer);
      clearTimeout(pending);
      events.close();
    };
  }, [load]);
  useEffect(() => {
    const handle = () => {
      const id = location.hash.startsWith('#task/') ? location.hash.slice(6) : '';
      setSelected(id);
    };
    window.addEventListener('hashchange', handle);
    return () => window.removeEventListener('hashchange', handle);
  }, []);
  const choose = (id: string) => {
    location.hash = `task/${id}`;
    setSelected(id);
    setDetail(undefined);
    setDraft('');
    setTab('reviewer');
  };
  const act = async (action: string, reason = '') => {
    if (!selected) return;
    setBusy(true);
    setError('');
    try {
      await api(`/tasks/${selected}/actions`, { action, reason });
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const demo = async () => {
    setBusy(true);
    try {
      const task = await api<Task>('/demo', {});
      choose(task.id);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const sendMessage = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!draft.trim() || !selected) return;
    setBusy(true);
    setError('');
    try {
      await api(`/tasks/${selected}/messages`, { role: tab, text: draft });
      setDraft('');
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (authenticated === null)
    return (
      <div className="loading-screen">
        <Brand />
        <LoaderCircle className="spin" />
        <span>{tr('Connecting to your workspace…')}</span>
        {error && <p role="alert">{tr(error)}</p>}
      </div>
    );
  if (!authenticated)
    return (
      <Login
        initialError={error}
        onConnect={() => {
          setAuthenticated(true);
          void load();
        }}
      />
    );
  if (!new URLSearchParams(location.search).has('legacy') && !location.hash.startsWith('#task/'))
    return <DaddyWorkspace api={api} />;
  const task = detail?.task.id === selected ? detail.task : undefined;
  const attentionCount = tasks.filter((t) => needsAttention(t.state)).length;
  const runningCount = tasks.filter((t) => isRunning(t.state)).length;
  const visible = tasks.filter(
    (t) =>
      filter === 'all' ||
      (filter === 'attention' && needsAttention(t.state)) ||
      (filter === 'active' && isRunning(t.state)) ||
      (filter === 'complete' && t.state === 'complete'),
  );
  const runningJob = detail?.jobs.find((j) => j.status === 'running');
  const chatMessages = detail?.messages.filter((m) => m.role === tab) ?? [];
  const liveEvents = detail?.events.filter((e) => e.runId === runningJob?.id) ?? [];
  const liveText = liveEvents
    .filter((e) => e.type === 'runtime.text')
    .map((e) => (e.data as { delta: string }).delta)
    .join('');
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Brand />
        <div className="workspace-switch">
          <span className="workspace-avatar">{tr('W')}</span>
          <div>
            <strong>{tr('Personal workspace')}</strong>
            <small>{tr('Local installation')}</small>
          </div>
          <ChevronDown size={14} />
        </div>
        <span className="nav-label">{tr('WORKSPACE')}</span>
        <button
          className={`nav-item ${filter === 'all' ? 'selected' : ''}`}
          onClick={() => setFilter('all')}
        >
          <LayoutGrid size={18} />
          {tr(' All tasks')}
          <span>{tasks.length}</span>
        </button>
        <button
          className={`nav-item ${filter === 'attention' ? 'selected' : ''}`}
          onClick={() => setFilter('attention')}
        >
          <MessageSquare size={18} />
          {tr(' Needs attention ')}
          {attentionCount > 0 && <span className="count-amber">{attentionCount}</span>}
        </button>
        <button
          className={`nav-item ${filter === 'active' ? 'selected' : ''}`}
          onClick={() => setFilter('active')}
        >
          <Activity size={18} />
          {tr(' In progress')}
          <span>{runningCount}</span>
        </button>
        <button
          className={`nav-item ${filter === 'complete' ? 'selected' : ''}`}
          onClick={() => setFilter('complete')}
        >
          <CircleCheck size={18} />
          {tr(' Completed ')}
        </button>
        <div className="sidebar-divider" />
        <span className="nav-label">{tr('CONNECTIONS')}</span>
        {(['github', 'gitlab'] as const).map((name) => (
          <div className="connection" key={name}>
            {name === 'github' ? <Code2 size={17} /> : <GitBranch size={17} />}
            <span>{name === 'github' ? tr('GitHub') : tr('GitLab')}</span>
            <span
              className={`connection-dot ${status?.connections[name].configured ? 'on' : ''}`}
              title={
                status?.connections[name].configured
                  ? tr('Credential configured')
                  : tr('Credential needed')
              }
            />
          </div>
        ))}
        <p className="connection-hint">
          {tr(' Connect credentials locally with ')}
          <br />
          <code>{tr('reviewctl doctor')}</code>
        </p>
        <button className="nav-item" onClick={() => setConnectionsOpen(true)}>
          <Settings2 size={18} />
          {tr(' Devices & connections ')}
        </button>
        <button className="nav-item" onClick={() => setAgentsOpen(true)}>
          <Code2 size={18} />
          {tr(' Agents & models ')}
        </button>
        <button className="nav-item" onClick={() => setNotificationsOpen(true)}>
          <Bell size={18} />
          {tr(' Notifications ')}
        </button>
        <div className="sidebar-bottom">
          <div className="local-status">
            <span className="connection-dot on" />
            <span>{tr('Running on this machine')}</span>
          </div>
          <small>
            {tr('v')}
            {status?.version}
            {tr(' · State stored on this machine')}
          </small>
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <div className="breadcrumb">
            {tr(' Workspace')}
            <span>/</span>
            <strong>{tr('Review tasks')}</strong>
          </div>
          <div className="top-actions">
            <select
              className="language-select"
              aria-label={tr('Interface language')}
              value={locale}
              onChange={async (event) => {
                const next = event.target.value as Locale;
                try {
                  adopt(await api<Preferences>('/preferences', { locale: next }));
                } catch (error) {
                  setError((error as Error).message);
                }
              }}
            >
              {Object.entries(localeNames).map(([value, label]) => (
                <option key={value} value={value}>
                  {tr(label)}
                </option>
              ))}
            </select>
            <button
              className="icon-button"
              aria-label={tr('Updates')}
              title={tr('Updates')}
              onClick={() => setUpdatesOpen(true)}
            >
              <RefreshCw size={18} />
              {status?.updates?.tools.some((tool) => tool.supported && tool.updateAvailable) && (
                <span className="update-dot" />
              )}
            </button>
            <button
              className="icon-button"
              aria-label={tr('Devices and connections')}
              title={tr('Devices and connections')}
              onClick={() => setConnectionsOpen(true)}
            >
              <Settings2 size={18} />
            </button>
            <button
              className={`icon-button ${notify ? 'enabled' : ''}`}
              aria-label={tr('Notification settings')}
              title={tr('Notification settings')}
              onClick={() => setNotificationsOpen(true)}
            >
              <Bell size={18} />
            </button>
            <span className="user-avatar">{tr('Y')}</span>
          </div>
        </header>
        <div className="page-heading">
          <div>
            <div className="eyebrow">{tr('THE WORK BETWEEN AGENTS, HANDLED.')}</div>
            <h1>{tr('Review workspace')}</h1>
            <p>{tr('Keep the author moving. Give every change an independent review.')}</p>
          </div>
          <div className="heading-actions">
            <button className="button primary" onClick={() => setTicketOpen('root')}>
              <Plus size={17} />
              {tr(' New from ticket ')}
            </button>
            <button className="button" onClick={() => setCreating(true)}>
              <Plus size={17} />
              {tr(' Attach a PR ')}
            </button>
          </div>
        </div>
        <div className="overview">
          <div>
            <span className="metric-icon amber-bg">
              <MessageSquare size={18} />
            </span>
            <div>
              <strong>{attentionCount}</strong>
              <span>{tr('Need your attention')}</span>
            </div>
          </div>
          <div>
            <span className="metric-icon green-bg">
              <Activity size={18} />
            </span>
            <div>
              <strong>{runningCount}</strong>
              <span>{tr('Moving through the loop')}</span>
            </div>
          </div>
          <div className="resource-metric">
            <span className="metric-icon neutral-bg">
              <Terminal size={18} />
            </span>
            <div>
              <strong>
                {status?.resources.memoryAvailableGiB.toFixed(1)}{' '}
                <small>
                  {status?.resources.memoryScope === 'service'
                    ? tr('GiB in service budget')
                    : tr('GiB RAM available')}
                </small>
              </strong>
              <span>
                {status?.resources.diskAvailableGiB.toFixed(0)}
                {tr(' GiB disk free · ')}
                {status?.activeJobs} {tr(' active agent ')}
              </span>
            </div>
            <span className={`small-dot ${status?.resources.ok ? 'healthy' : 'unhealthy'}`} />
          </div>
        </div>
        {error && (
          <div className="error-banner" role="alert">
            <span>{tr(error)}</span>
            <button aria-label={tr('Dismiss error')} onClick={() => setError('')}>
              <X size={16} />
            </button>
          </div>
        )}
        {status && !status.resources.ok && (
          <div className="warning-banner">
            {tr(' New agent jobs are held: ')}
            {status.resources.reasons.join('; ')}
            {tr('. Existing files and other processes are preserved. ')}
          </div>
        )}
        <div className="workbench">
          <section className="task-list">
            <div className="section-heading">
              <strong>
                {filter === 'all'
                  ? tr('All tasks')
                  : filter === 'attention'
                    ? tr('Needs attention')
                    : filter === 'active'
                      ? tr('In progress')
                      : tr('Completed')}{' '}
                <span>{visible.length}</span>
              </strong>
              <button
                className="icon-button"
                aria-label={tr('Refresh tasks')}
                onClick={() => void load()}
              >
                <RefreshCw size={15} />
              </button>
            </div>
            {!visible.length && (
              <div className="list-empty">
                <FolderGit2 size={26} />
                <p>
                  {tasks.length ? tr('Nothing in this view.') : tr('Your next review starts here.')}
                </p>
              </div>
            )}
            {visible.map((t) => (
              <button
                key={t.id}
                className={`task-card ${t.id === selected ? 'active' : ''}`}
                onClick={() => choose(t.id)}
              >
                <div className="task-repo">
                  <GitPullRequest size={13} />
                  {t.ref.repo.split('/').slice(-1)[0]}
                  <span>#{t.ref.number}</span>
                </div>
                <h3>{t.title}</h3>
                <StatusPill state={t.state} />
                <div className="task-card-bottom">
                  <span>
                    {t.kind === 'plan' ? <FileText size={12} /> : <Code2 size={12} />}
                    {t.kind === 'plan' ? tr('Plan') : tr('Code')}
                    {t.ref.provider === 'demo' && <em>{tr('DEMO')}</em>}
                  </span>
                  <span>
                    {tr('Round ')}
                    {t.round || '—'}
                  </span>
                </div>
              </button>
            ))}
            <button className="add-task" onClick={() => setCreating(true)}>
              <Plus size={15} />
              {tr(' Attach a pull request ')}
            </button>
          </section>
          {!task ? (
            <section className="empty-workspace">
              <div className="empty-illustration">
                <span className="agent-node">
                  <Code2 size={25} />
                </span>
                <span className="dotted-line" />
                <span className="loop-node">
                  <RefreshCw size={26} />
                </span>
                <span className="dotted-line" />
                <span className="agent-node">
                  <ShieldCheck size={25} />
                </span>
              </div>
              <span className="eyebrow">{tr('TWO SESSIONS. ONE SHARED OUTCOME.')}</span>
              <h2>
                {selected
                  ? tr('Opening your task…')
                  : tr('A second pair of eyes, without the back-and-forth.')}
              </h2>
              <p>
                {tr(' Attach a GitHub pull request or GitLab merge request. ')}
                <br />
                {tr(' Discuss findings with the reviewer. Publish when you’re ready. ')}
                <br />
                {tr(' The author picks up the feedback from there. ')}
              </p>
              <div className="empty-actions">
                <button className="button primary" onClick={() => setCreating(true)}>
                  <Plus size={16} />
                  {tr(' Attach a PR ')}
                </button>
                {status?.demoEnabled && (
                  <button className="button" onClick={() => void demo()} disabled={busy}>
                    <Play size={15} />
                    {tr(' Try a demo loop ')}
                  </button>
                )}
              </div>
              <div className="empty-notes">
                <span>
                  <LockKeyhole size={13} />
                  {tr(' Manual publication by default ')}
                </span>
                <span>
                  <GitBranch size={13} />
                  {tr(' Plans and code use the same loop ')}
                </span>
              </div>
            </section>
          ) : (
            <section className="task-detail">
              <div className="detail-header">
                <div className="detail-meta">
                  <span>
                    <GitPullRequest size={14} />
                    {task.ref.kind === 'ticket'
                      ? task.ref.key
                      : `${task.ref.repo} #${task.ref.number}`}
                  </span>
                  {task.ref.provider === 'demo' && (
                    <span className="demo-label">{tr('DEMO FIXTURE')}</span>
                  )}
                  <a href={safeLink(task.ref.url)} target="_blank" rel="noreferrer">
                    {task.ref.kind === 'ticket' ? tr('Open ticket') : tr('Open PR')}{' '}
                    <ArrowUpRight size={13} />
                  </a>
                </div>
                <h2>{task.title}</h2>
                <div className="detail-subtitle">
                  <StatusPill state={task.state} />
                  <span>
                    {tr(' Round ')}
                    {task.round}
                    {tr(' of ')}
                    {task.policy.maxRounds}
                  </span>
                  <span className="sha">
                    <GitBranch size={12} />
                    {shortSha(task.revision?.head)}
                  </span>
                  <button className="policy-control" onClick={() => setPolicyOpen(true)}>
                    <Settings2 size={13} />
                    {task.policy.publication === 'human'
                      ? tr('Manual publication')
                      : tr('Automatic publication')}
                  </button>
                </div>
              </div>
              <div className="agent-strip">
                <span>
                  <Code2 size={13} />
                  {tr(' Author: ')}
                  {tr(profileLabel(detail?.agents?.author))}
                </span>
                <span>
                  <ShieldCheck size={13} /> {detail?.group ? tr('Shared reviewer') : tr('Reviewer')}
                  : {tr(profileLabel(detail?.agents?.reviewer))}
                </span>
                <button className="button small" onClick={() => setAgentsOpen(true)}>
                  {tr(' Models ')}
                </button>
                <button className="button small" onClick={() => setTicketOpen('child')}>
                  {tr(' Add child ticket ')}
                </button>
              </div>
              {detail?.group && (
                <div className="group-strip">
                  <strong>{detail.group.source?.key ?? detail.group.title}</strong>
                  <span>
                    {tr('One reviewer · ')}
                    {detail.siblings?.length ?? 1}
                    {tr(' author tasks')}
                  </span>
                  {detail.siblings
                    ?.filter((sibling) => sibling.id !== task.id)
                    .map((sibling) => (
                      <button
                        key={sibling.id}
                        onClick={() => {
                          choose(sibling.id);
                          if (tasks.find((item) => item.id === sibling.id)?.ref.kind === 'ticket')
                            setTab('author');
                        }}
                      >
                        {sibling.title} · {tr(stateLabels[sibling.state])}
                      </button>
                    ))}
                </div>
              )}
              <div className={`task-callout ${needsAttention(task.state) ? 'attention' : ''}`}>
                <div className="callout-icon">
                  {task.state === 'complete' ? (
                    <CheckCheck size={19} />
                  ) : task.state === 'paused' ? (
                    <CirclePause size={19} />
                  ) : needsAttention(task.state) ? (
                    <MessageSquare size={19} />
                  ) : (
                    <Activity size={19} />
                  )}
                </div>
                <div>
                  <strong>{tr(stateLabels[task.state])}</strong>
                  <p>{tr(task.reason)}</p>
                </div>
                <div className="callout-actions">
                  {task.ref.kind === 'ticket' &&
                    ['discussing', 'needs_input'].includes(task.state) && (
                      <button
                        className="button primary small"
                        disabled={busy || !!runningJob}
                        onClick={() => void act('implement')}
                      >
                        {tr(' Start implementation ')}
                        <Play size={14} />
                      </button>
                    )}
                  {task.ref.kind === 'ticket' &&
                    ['ready_for_review', 'needs_input'].includes(task.state) &&
                    task.pendingAuthorHead && (
                      <button
                        className="button primary small"
                        disabled={busy || !!runningJob}
                        onClick={() => void act('submit')}
                      >
                        {tr(' Submit for review ')}
                        <ArrowRight size={14} />
                      </button>
                    )}
                  {task.state === 'awaiting_publication' && (
                    <button
                      className="button primary small"
                      disabled={busy || !!runningJob}
                      onClick={() => void act('publish')}
                    >
                      {task.ref.provider === 'demo'
                        ? tr('Publish demo review')
                        : tr('Publish review')}
                      <ArrowRight size={14} />
                    </button>
                  )}
                  {task.state === 'awaiting_plan_approval' && (
                    <button
                      className="button primary small"
                      disabled={busy}
                      onClick={() => void act('approve-plan')}
                    >
                      {tr(' Approve plan ')}
                      <Check size={14} />
                    </button>
                  )}
                  {task.state === 'paused' && (
                    <button
                      className="button small"
                      disabled={busy}
                      onClick={() => void act('resume')}
                    >
                      <Play size={14} />
                      {tr(' Resume ')}
                    </button>
                  )}
                  {task.state === 'needs_input' && (
                    <button
                      className="button small"
                      disabled={busy || !!runningJob}
                      onClick={() => void act('retry')}
                    >
                      <RefreshCw size={14} />
                      {task.ref.kind === 'ticket' ? tr('Retry task') : tr('Retry review')}
                    </button>
                  )}
                  {task.state === 'complete' && (
                    <button
                      className="button small"
                      disabled={busy}
                      onClick={() => void act('reopen')}
                    >
                      {tr(' Reopen ')}
                    </button>
                  )}
                  {task.state !== 'paused' && task.state !== 'complete' && (
                    <button
                      className="icon-button"
                      title={tr('Pause task')}
                      aria-label={tr('Pause task')}
                      disabled={busy}
                      onClick={() => void act('pause')}
                    >
                      <Pause size={16} />
                    </button>
                  )}
                </div>
              </div>
              <div className="tabs" role="tablist">
                {[
                  { key: 'reviewer', label: 'Reviewer', icon: ShieldCheck },
                  { key: 'author', label: 'Author', icon: Code2 },
                  { key: 'activity', label: 'Activity', icon: Activity },
                  { key: 'decisions', label: 'Decisions', icon: CheckCheck },
                  { key: 'context', label: 'Context', icon: FileText },
                ].map(({ key, label, icon: Icon }) => (
                  <button
                    role="tab"
                    aria-selected={tab === key}
                    className={tab === key ? 'active' : ''}
                    key={key}
                    onClick={() => {
                      setTab(key);
                      setDraft('');
                    }}
                  >
                    <Icon size={15} />
                    {tr(label)}
                    {key === 'decisions' && !!detail?.decisions.length && (
                      <span>{detail.decisions.length}</span>
                    )}
                  </button>
                ))}
              </div>
              {tab === 'reviewer' || tab === 'author' ? (
                <div className={`session-layout ${tab === 'author' ? 'author-layout' : ''}`}>
                  <div className="chat-panel">
                    <div className="session-heading">
                      <span className={`session-avatar ${tab}`}>
                        {tab === 'reviewer' ? <ShieldCheck size={18} /> : <Code2 size={18} />}
                      </span>
                      <div>
                        <strong>
                          {tab === 'reviewer' ? tr('Independent reviewer') : tr('Author session')}
                        </strong>
                        <small>
                          {runningJob?.role === tab
                            ? tr('Working · updates appear here')
                            : tr('A persistent session for this task')}
                        </small>
                      </div>
                      <span className="session-indicator" />
                    </div>
                    <div className="messages">
                      {chatMessages.length === 0 && (
                        <div className="chat-welcome">
                          <Sparkles size={22} />
                          <h3>
                            {tab === 'reviewer'
                              ? tr('Make sense of the findings.')
                              : tr('Stay close to the implementation.')}
                          </h3>
                          <p>
                            {tab === 'reviewer'
                              ? tr(
                                  'Ask about a failure scenario, challenge an assumption, or discuss a specific comment. This is the same reviewer who checks the changes.',
                                )
                              : tr(
                                  'Discuss requirements and ask about progress. Published feedback reaches this session automatically.',
                                )}
                          </p>
                        </div>
                      )}
                      {chatMessages.map((message) => (
                        <div key={message.id} className={`message ${message.sender}`}>
                          <div className="message-heading">
                            <strong>
                              {message.sender === 'user'
                                ? tr('You')
                                : message.sender === 'system'
                                  ? tr('Reviewloop')
                                  : tab === 'reviewer'
                                    ? tr('Reviewer')
                                    : tr('Author')}
                            </strong>
                            <time>{time(message.at)}</time>
                          </div>
                          <Md text={message.text} />
                        </div>
                      ))}
                      {runningJob?.role === tab && (
                        <div className="message agent live-message">
                          <div className="message-heading">
                            <strong>
                              <LoaderCircle className="spin" size={13} />
                              {tab === 'reviewer' ? tr('Reviewer') : tr('Author')}
                              {tr(' is working ')}
                            </strong>
                          </div>
                          {liveText ? (
                            <Md text={liveText} />
                          ) : (
                            <p>{tr('Preparing context and checking the repository…')}</p>
                          )}
                        </div>
                      )}
                    </div>
                    <form className="composer" onSubmit={sendMessage}>
                      <textarea
                        ref={chatInput}
                        aria-label={tr('Message {v0}', { v0: tr(tab) })}
                        placeholder={
                          tab === 'reviewer'
                            ? tr('Ask about a finding, or paste a comment link…')
                            : tr('Discuss the task with the author…')
                        }
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        rows={3}
                        disabled={
                          tab === 'author' || task.state === 'paused' || task.state === 'complete'
                        }
                        onKeyDown={(e) => {
                          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                            e.preventDefault();
                            e.currentTarget.form?.requestSubmit();
                          }
                        }}
                      />
                      <div>
                        <span>
                          <LockKeyhole size={11} />
                          {tab === 'reviewer'
                            ? tr('Private to you and the reviewer')
                            : tr('Separate from the reviewer’s conversation')}
                        </span>
                        <button
                          className="button primary icon-send"
                          aria-label={tr('Send message')}
                          disabled={
                            tab === 'author' ||
                            busy ||
                            !draft.trim() ||
                            task.state === 'paused' ||
                            task.state === 'complete'
                          }
                        >
                          <ArrowRight size={17} />
                        </button>
                      </div>
                    </form>
                  </div>
                  {tab === 'reviewer' && (
                    <aside className="findings">
                      <div className="section-heading">
                        <strong>
                          {task.snapshot?.status === 'published'
                            ? tr('Published findings')
                            : tr('Draft findings')}
                          <span>{task.snapshot?.comments.length ?? 0}</span>
                        </strong>
                      </div>
                      {!task.snapshot?.comments.length && (
                        <div className="findings-empty">
                          <ShieldCheck size={25} />
                          <p>
                            {task.state === 'complete'
                              ? tr('Review complete. No remaining findings.')
                              : tr('Findings will appear here as the reviewer saves them.')}
                          </p>
                        </div>
                      )}
                      {task.snapshot?.comments.map((comment, index) => (
                        <article key={comment.id} className="finding">
                          <div className="finding-number">
                            <span>
                              {tr('R')}
                              {index + 1}
                            </span>
                            <a
                              href={safeLink(comment.url)}
                              target="_blank"
                              rel="noreferrer"
                              aria-label={tr('Open comment')}
                            >
                              <ExternalLink size={13} />
                            </a>
                          </div>
                          {comment.location && (
                            <code className="finding-location">
                              {comment.location.path}:{comment.location.line}
                            </code>
                          )}
                          <Md text={comment.body} />
                          <button
                            className="discuss"
                            onClick={() => {
                              setDraft(
                                `Let's discuss this comment (${comment.id}): ${comment.url}\n\n`,
                              );
                              chatInput.current?.focus();
                            }}
                          >
                            <MessageSquare size={13} />
                            {tr(' Discuss with reviewer ')}
                            <ArrowRight size={13} />
                          </button>
                        </article>
                      ))}
                      <div className="findings-note">
                        <LockKeyhole size={14} />
                        <p>
                          {task.policy.publication === 'human'
                            ? tr(
                                'Drafts stay with you until you publish. The author receives the final, published comments.',
                              )
                            : tr(
                                'Completed reviews publish automatically when the session is idle.',
                              )}
                        </p>
                      </div>
                    </aside>
                  )}
                </div>
              ) : tab === 'activity' ? (
                <ActivityView detail={detail!} />
              ) : tab === 'decisions' ? (
                <div className="decisions-panel">
                  {!detail?.decisions.length && (
                    <EmptyNote
                      icon={<CheckCheck size={24} />}
                      text={tr(
                        'Decisions made during review will be kept here, so the next round remembers why a finding was withdrawn or deferred.',
                      )}
                    />
                  )}
                  {detail?.decisions.map((d) => (
                    <article key={d.id} className="decision">
                      <div>
                        <span className={`pill ${d.outcome === 'verified' ? 'green' : 'neutral'}`}>
                          {d.outcome}
                        </span>
                        <time>
                          {time(d.at)} · {shortSha(d.head)}
                        </time>
                      </div>
                      <Md text={d.reason} />
                      {d.commentId && (
                        <small>
                          {tr('Comment ')}
                          {d.commentId}
                        </small>
                      )}
                    </article>
                  ))}
                </div>
              ) : (
                <div className="context-panel">
                  <div className="context-heading">
                    <FileText size={18} />
                    <h3>{tr('Original requirements')}</h3>
                    <span>
                      {tr('v')}
                      {task.contextVersion}
                    </span>
                  </div>
                  <Md text={task.requirements} />
                  <div className="context-grid">
                    <div>
                      <small>{tr('BASE')}</small>
                      <code>{shortSha(task.revision?.base)}</code>
                    </div>
                    <div>
                      <small>{tr('REVIEWED HEAD')}</small>
                      <code>{shortSha(task.revision?.head)}</code>
                    </div>
                    <div>
                      <small>{tr('AUTHOR THREAD')}</small>
                      <code>{task.authorThreadId ?? tr('Created on first run')}</code>
                    </div>
                    <div>
                      <small>{tr('REVIEWER THREAD')}</small>
                      <code>{task.reviewerThreadId ?? tr('Created on first run')}</code>
                    </div>
                  </div>
                  {task.approvedPlan && (
                    <>
                      <h3>
                        {tr('Approved plan · ')}
                        {shortSha(task.approvedPlan.head)}
                      </h3>
                      {task.approvedPlan.documents.map((doc) => (
                        <details key={doc.path}>
                          <summary>{doc.path}</summary>
                          <Md text={doc.body} />
                        </details>
                      ))}
                    </>
                  )}
                  {task.state === 'awaiting_checks' && (
                    <Waiver onWaive={(reason) => void act('waive-checks', reason)} />
                  )}
                  <button
                    className="button small"
                    disabled={busy}
                    onClick={() => void act('reconcile')}
                  >
                    <RefreshCw size={14} />
                    {tr(' Reconcile with provider ')}
                  </button>
                </div>
              )}
            </section>
          )}
        </div>
        <footer className="page-footer">
          <span>
            <ShieldCheck size={12} />
            {tr(' Publication is a decision. A completed review is tied to a revision. ')}
          </span>
          <span>{tr('Built for a calmer review cycle.')}</span>
        </footer>
      </main>
      {updatesOpen && (
        <Modal
          title={tr('Updates')}
          subtitle={tr('CLI versions and update notifications')}
          onClose={() => setUpdatesOpen(false)}
        >
          <UpdatesPanel api={api} />
        </Modal>
      )}
      {connectionsOpen && status && (
        <Connections status={status} onClose={() => setConnectionsOpen(false)} />
      )}
      {ticketOpen && (
        <Modal
          title={ticketOpen === 'child' ? tr('Add a child ticket') : tr('Start from a ticket')}
          subtitle={tr('Import the requirements, choose the agents, and begin a conversation.')}
          onClose={() => setTicketOpen(null)}
        >
          <TicketForm
            api={api}
            parent={ticketOpen === 'child' ? detail : undefined}
            onCreated={(task) => {
              setTicketOpen(null);
              choose(task.id);
              setTab('author');
              void load();
            }}
          />
        </Modal>
      )}
      {agentsOpen && (
        <Modal
          title={tr('Agents & models')}
          subtitle={tr(
            'Choose a separate writer for each task and a shared reviewer for its group.',
          )}
          onClose={() => setAgentsOpen(false)}
        >
          <AgentSettingsForm api={api} selected={detail} onSaved={() => void load()} />
        </Modal>
      )}
      {notificationsOpen && (
        <Modal
          title={tr('Notifications')}
          subtitle={tr('Choose which updates reach your private Telegram chat.')}
          onClose={() => setNotificationsOpen(false)}
        >
          <NotificationsForm api={api} />
          <button
            className="button small"
            onClick={async () => {
              if ('Notification' in window)
                setNotify((await Notification.requestPermission()) === 'granted');
            }}
          >
            {notify ? tr('Browser notifications enabled') : tr('Enable browser notifications too')}
          </button>
        </Modal>
      )}
      {creating && (
        <CreateTask
          tasks={tasks}
          onClose={() => setCreating(false)}
          onCreated={(task) => {
            setCreating(false);
            choose(task.id);
            void load();
          }}
        />
      )}
      {policyOpen && task && (
        <PolicyModal
          task={task}
          onClose={() => setPolicyOpen(false)}
          onSave={async (policy) => {
            await api(`/tasks/${task.id}/policy`, { policy });
            setPolicyOpen(false);
            await load();
          }}
        />
      )}
    </div>
  );
}
function Connections({ status, onClose }: { status: Status; onClose: () => void }) {
  const { t: tr } = useLocale();

  const [link, setLink] = useState(''),
    [error, setError] = useState('');
  const [devices, setDevices] = useState<{ id: string; name: string; revoked: number }[]>([]);
  useEffect(() => {
    void api<typeof devices>('/devices')
      .then(setDevices)
      .catch((e) => setError(e.message));
  }, []);
  return (
    <Modal
      title={tr('Devices & connections')}
      subtitle={tr('The service runs on the host. Your laptop is never a relay for your phone.')}
      onClose={onClose}
    >
      <div className="task-form">
        <h3>{tr('Web address')}</h3>
        <p>
          {status.publicOrigin ? (
            <a href={status.publicOrigin}>{status.publicOrigin}</a>
          ) : (
            tr(
              'Local access only. Configure a permanent HTTPS address with reviewctl web on the host.',
            )
          )}
        </p>
        <p>
          {tr(
            ' Connect the phone to the same private network, then open a one-use login link. Closing your laptop or the browser does not stop the service. ',
          )}
        </p>
        <button
          className="button primary"
          disabled={!status.publicOrigin}
          onClick={async () => {
            try {
              const result = await api<{ url: string }>('/pairings', {
                name: 'Phone',
                kind: 'web',
              });
              setLink(result.url);
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        >
          {tr(' Create phone login link ')}
        </button>
        {link && (
          <div className="pair-link">
            <p>{tr('Valid for five minutes and one use:')}</p>
            <a href={link}>{link}</a>
            <button
              className="button small"
              onClick={() => void navigator.clipboard.writeText(link)}
            >
              {tr(' Copy link ')}
            </button>
          </div>
        )}
        <h3>{tr('Telegram')}</h3>
        <p>
          {status.telegram?.paired
            ? tr('Connected to @{v0}', { v0: status.telegram.bot })
            : tr(
                'Run reviewctl telegram setup on the host, then open its private-chat pairing link.',
              )}
        </p>
        <h3>{tr('Paired browsers')}</h3>
        {devices
          .filter((d) => !d.revoked)
          .map((device) => (
            <div className="device-row" key={device.id}>
              <span>{device.name}</span>
              <button
                className="button small"
                onClick={async () => {
                  await api(`/devices/${device.id}/revoke`, {});
                  setDevices(await api('/devices'));
                }}
              >
                {tr(' Revoke ')}
              </button>
            </div>
          ))}
        {error && (
          <p role="alert" className="field-error">
            {tr(error)}
          </p>
        )}
      </div>
    </Modal>
  );
}
function EmptyNote({ icon, text }: { icon: React.ReactNode; text: string }) {
  const { t: tr } = useLocale();
  return (
    <div className="empty-note">
      {icon}
      <p>{tr(text)}</p>
    </div>
  );
}
function ActivityView({ detail }: { detail: Detail }) {
  const { t: tr } = useLocale();

  const events = detail.events
    .filter((e) => e.type !== 'runtime.text' && e.type !== 'runtime.diagnostic')
    .slice()
    .reverse();
  return (
    <div className="activity-panel">
      <div className="activity-intro">
        <Activity size={16} />
        <span>
          {tr('Persisted events · ')}
          {detail.jobs.length}
          {tr(' runs')}
        </span>
        <code>
          {tr('reviewctl logs ')}
          {detail.task.id.slice(0, 8)}…
        </code>
      </div>
      {events.map((event) => (
        <details className="event" key={event.id}>
          <summary>
            <span className={`event-icon ${event.type.includes('failed') ? 'error' : ''}`}>
              {event.type.includes('completed') ? <Check size={13} /> : <Circle size={10} />}
            </span>
            <strong>{event.type.replaceAll('.', ' / ')}</strong>
            <time>{time(event.at)}</time>
          </summary>
          <div>
            <small>
              {tr(' Event ')}
              {event.id}
              {event.runId ? tr(' · Run {v0}', { v0: event.runId }) : ''}
            </small>
            <pre>
              {typeof event.data === 'string' ? event.data : JSON.stringify(event.data, null, 2)}
            </pre>
          </div>
        </details>
      ))}
    </div>
  );
}
function Waiver({ onWaive }: { onWaive: (reason: string) => void }) {
  const { t: tr } = useLocale();

  const [reason, setReason] = useState('');
  return (
    <div className="waiver">
      <h3>{tr('Human CI decision')}</h3>
      <p>{tr('Record why this exact revision may proceed without passing CI.')}</p>
      <textarea
        aria-label={tr('CI waiver reason')}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder={tr('Reason for waiving checks…')}
      />
      <button className="button small" disabled={!reason.trim()} onClick={() => onWaive(reason)}>
        {tr(' Record waiver ')}
      </button>
    </div>
  );
}
function Login({
  onConnect,
  initialError = '',
}: {
  onConnect: () => void | Promise<void>;
  initialError?: string;
}) {
  const { t: tr, locale, local, adopt } = useLocale();
  const [languageChosen, setLanguageChosen] = useState(false);

  const [token, setToken] = useState(''),
    [error, setError] = useState(initialError),
    [busy, setBusy] = useState(false);
  return (
    <div className="login-page">
      <Brand />
      <select
        className="language-select"
        aria-label={tr('Interface language')}
        value={locale}
        disabled={busy}
        onChange={(event) => {
          local(event.target.value as Locale);
          setLanguageChosen(true);
        }}
      >
        {Object.entries(localeNames).map(([value, label]) => (
          <option key={value} value={value}>
            {tr(label)}
          </option>
        ))}
      </select>
      <div className="login-card">
        <span className="login-lock">
          <LockKeyhole size={25} />
        </span>
        <h1>{tr('Your Daddyloop workspace.')}</h1>
        <p>
          {tr(' Connect to the service running on your machine. ')}
          <br />
          {tr(' Find your access token with ')}
          <code>daddy token</code>.
        </p>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              await api('/session', { token });
              if (languageChosen) adopt(await api<Preferences>('/preferences', { locale }));
              await onConnect();
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <label htmlFor="token">{tr('Local access token')}</label>
          <input
            id="token"
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            autoComplete="off"
            placeholder={tr('Paste your access token')}
            autoFocus
          />
          {error && (
            <p className="field-error" role="alert">
              {tr(error)}
            </p>
          )}
          <button className="button primary" disabled={busy || !token.trim()}>
            {busy ? <LoaderCircle className="spin" size={16} /> : <ArrowRight size={16} />}
            {tr(' Connect to workspace ')}
          </button>
        </form>
      </div>
      <small>{tr('Local by default. Reach a remote machine through an SSH tunnel.')}</small>
    </div>
  );
}
function Modal({
  title,
  subtitle,
  children,
  onClose,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  const { t: tr } = useLocale();

  const close = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    close.current?.focus();
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseRef.current();
      if (e.key === 'Tab' && dialog.current) {
        const controls = [
          ...dialog.current.querySelectorAll<HTMLElement>(
            'button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),a[href],summary',
          ),
        ].filter((node) => node.offsetParent !== null);
        const first = controls[0],
          last = controls.at(-1);
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener('keydown', handler);
    return () => {
      document.removeEventListener('keydown', handler);
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        ref={dialog}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
      >
        <div className="modal-heading">
          <div>
            <h2 id="modal-title">{tr(title)}</h2>
            <p>{tr(subtitle)}</p>
          </div>
          <button
            ref={close}
            className="icon-button"
            aria-label={tr('Close dialog')}
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </div>
        {children}
      </section>
    </div>
  );
}
function CreateTask({
  tasks,
  onClose,
  onCreated,
}: {
  tasks: Task[];
  onClose: () => void;
  onCreated: (task: Task) => void;
}) {
  const { t: tr } = useLocale();

  const [url, setUrl] = useState(''),
    [repoPath, setRepoPath] = useState(''),
    [requirements, setRequirements] = useState(''),
    [kind, setKind] = useState('code'),
    [planTaskId, setPlan] = useState(''),
    [thread, setThread] = useState(''),
    [auto, setAuto] = useState(true),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  return (
    <Modal
      title={tr('Attach a pull request')}
      subtitle={tr('Give the reviewer the original intent, not just the diff.')}
      onClose={onClose}
    >
      <form
        className="task-form"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            onCreated(
              await api<Task>('/tasks', {
                url,
                repoPath,
                requirements,
                kind,
                ...(planTaskId ? { planTaskId } : {}),
                ...(thread ? { authorThreadId: thread } : {}),
                policy: { publication: auto ? 'auto' : 'human' },
              }),
            );
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          {tr(' Pull request or merge request URL ')}
          <input
            required
            type="url"
            placeholder="https://github.com/owner/repo/pull/42"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
        </label>
        <label>
          {tr(' Local repository path ')}
          <input
            required
            placeholder="/home/you/projects/your-repo"
            value={repoPath}
            onChange={(e) => setRepoPath(e.target.value)}
          />
          <small>{tr('The runner creates separate working copies from this checkout.')}</small>
        </label>
        <label>
          {tr(' Original requirements ')}
          <textarea
            required
            rows={4}
            placeholder={tr(
              'What should this change achieve? Include constraints and acceptance criteria.',
            )}
            value={requirements}
            onChange={(e) => setRequirements(e.target.value)}
          />
        </label>
        <div className="form-row">
          <label>
            {tr(' Review type ')}
            <select value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="code">{tr('Code implementation')}</option>
              <option value="plan">{tr('Markdown plan')}</option>
            </select>
          </label>
          <label>
            {tr(' Approved plan ')}
            <select value={planTaskId} onChange={(e) => setPlan(e.target.value)}>
              <option value="">{tr('No linked plan')}</option>
              {tasks
                .filter((t) => t.kind === 'plan' && t.state === 'complete')
                .map((t) => (
                  <option value={t.id} key={t.id}>
                    {t.title}
                  </option>
                ))}
            </select>
          </label>
        </div>
        <details className="advanced">
          <summary>{tr('Existing author session')}</summary>
          <label>
            {tr(' Codex thread ID ')}
            <input
              placeholder={tr('Optional: resume an existing author')}
              value={thread}
              onChange={(e) => setThread(e.target.value)}
            />
            <small>{tr('Hand control of this session to Reviewloop before attaching it.')}</small>
          </label>
        </details>
        <label className="checkbox-label">
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
          <span>
            <strong>{tr('Publish completed reviews automatically')}</strong>
            <small>{tr('Leave off to discuss and publish each draft yourself.')}</small>
          </span>
        </label>
        {error && (
          <div className="field-error" role="alert">
            {tr(error)}
          </div>
        )}
        <div className="modal-actions">
          <button type="button" className="button" onClick={onClose}>
            {tr(' Cancel ')}
          </button>
          <button className="button primary" disabled={busy}>
            {busy ? <LoaderCircle className="spin" size={15} /> : <GitPullRequest size={15} />}
            {tr(' Attach and start review ')}
          </button>
        </div>
      </form>
    </Modal>
  );
}
function PolicyModal({
  task,
  onClose,
  onSave,
}: {
  task: Task;
  onClose: () => void;
  onSave: (policy: Policy) => Promise<void>;
}) {
  const { t: tr } = useLocale();

  const [policy, setPolicy] = useState(task.policy),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  return (
    <Modal
      title={tr('Automation settings')}
      subtitle={tr('These permissions belong to you and remain outside the agent sessions.')}
      onClose={onClose}
    >
      <form
        className="task-form"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await onSave(policy);
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          {tr(' Review publication ')}
          <select
            value={policy.publication}
            onChange={(e) =>
              setPolicy({
                ...policy,
                publication: e.target.value as Policy['publication'],
              })
            }
          >
            <option value="human">{tr('I publish each review')}</option>
            <option value="auto">{tr('Publish completed reviews automatically')}</option>
          </select>
        </label>
        <label>
          {tr(' Plan approval ')}
          <select
            value={policy.planApproval}
            onChange={(e) =>
              setPolicy({
                ...policy,
                planApproval: e.target.value as Policy['planApproval'],
              })
            }
          >
            <option value="human">{tr('Human approval before implementation')}</option>
            <option value="auto">{tr('Approve after the review and checks finish')}</option>
          </select>
        </label>
        <label>
          {tr(' Maximum review rounds ')}
          <input
            type="number"
            min="1"
            max="20"
            value={policy.maxRounds}
            onChange={(e) => setPolicy({ ...policy, maxRounds: Number(e.target.value) })}
          />
        </label>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={policy.requireChecks}
            onChange={(e) => setPolicy({ ...policy, requireChecks: e.target.checked })}
          />
          {tr(' Require passing CI on the reviewed revision ')}
        </label>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={policy.autoPush}
            onChange={(e) => setPolicy({ ...policy, autoPush: e.target.checked })}
          />
          {tr(' Push the author’s completed fixes automatically ')}
        </label>
        {error && (
          <p className="field-error" role="alert">
            {tr(error)}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" className="button" onClick={onClose}>
            {tr(' Cancel ')}
          </button>
          <button className="button primary" disabled={busy}>
            {tr(' Save settings ')}
          </button>
        </div>
      </form>
    </Modal>
  );
}
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <LocaleProvider>
      <App />
    </LocaleProvider>
  </React.StrictMode>,
);
