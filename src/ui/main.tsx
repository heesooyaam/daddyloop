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
} from '../core/types';
import './style.css';
import '@fontsource-variable/inter';

type Detail = {
  task: Task;
  messages: Message[];
  events: Event[];
  jobs: Job[];
  decisions: Decision[];
};
type Status = {
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
async function api<T>(path: string, body?: unknown): Promise<T> {
  const result = await fetch(`/api${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Reviewloop-Request': '1',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await result.json();
  if (!result.ok) throw new ApiError(data.error?.message ?? 'Request failed', result.status);
  return data as T;
}
const stateLabels: Record<State, string> = {
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
      {stateLabels[state]}
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
        reviewloop<span className="brand-period">.</span>
      </span>
    </div>
  );
}

function App() {
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
          new Notification(`Reviewloop · ${stateLabels[task.state]}`, {
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
  }, [selected, notify]);
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
        <span>Connecting to your workspace…</span>
        {error && <p role="alert">{error}</p>}
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
          <span className="workspace-avatar">W</span>
          <div>
            <strong>Personal workspace</strong>
            <small>Local installation</small>
          </div>
          <ChevronDown size={14} />
        </div>
        <span className="nav-label">WORKSPACE</span>
        <button
          className={`nav-item ${filter === 'all' ? 'selected' : ''}`}
          onClick={() => setFilter('all')}
        >
          <LayoutGrid size={18} />
          All tasks<span>{tasks.length}</span>
        </button>
        <button
          className={`nav-item ${filter === 'attention' ? 'selected' : ''}`}
          onClick={() => setFilter('attention')}
        >
          <MessageSquare size={18} />
          Needs attention
          {attentionCount > 0 && <span className="count-amber">{attentionCount}</span>}
        </button>
        <button
          className={`nav-item ${filter === 'active' ? 'selected' : ''}`}
          onClick={() => setFilter('active')}
        >
          <Activity size={18} />
          In progress<span>{runningCount}</span>
        </button>
        <button
          className={`nav-item ${filter === 'complete' ? 'selected' : ''}`}
          onClick={() => setFilter('complete')}
        >
          <CircleCheck size={18} />
          Completed
        </button>
        <div className="sidebar-divider" />
        <span className="nav-label">CONNECTIONS</span>
        {(['github', 'gitlab'] as const).map((name) => (
          <div className="connection" key={name}>
            {name === 'github' ? <Code2 size={17} /> : <GitBranch size={17} />}
            <span>{name === 'github' ? 'GitHub' : 'GitLab'}</span>
            <span
              className={`connection-dot ${status?.connections[name].configured ? 'on' : ''}`}
              title={
                status?.connections[name].configured ? 'Credential configured' : 'Credential needed'
              }
            />
          </div>
        ))}
        <p className="connection-hint">
          Connect credentials locally with
          <br />
          <code>reviewctl doctor</code>
        </p>
        <button className="nav-item" onClick={() => setConnectionsOpen(true)}>
          <Settings2 size={18} />
          Devices & connections
        </button>
        <div className="sidebar-bottom">
          <div className="local-status">
            <span className="connection-dot on" />
            <span>Running on this machine</span>
          </div>
          <small>v{status?.version} · State stored on this machine</small>
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <div className="breadcrumb">
            Workspace<span>/</span>
            <strong>Review tasks</strong>
          </div>
          <div className="top-actions">
            <button
              className="icon-button"
              aria-label="Devices and connections"
              title="Devices and connections"
              onClick={() => setConnectionsOpen(true)}
            >
              <Settings2 size={18} />
            </button>
            <button
              className={`icon-button ${notify ? 'enabled' : ''}`}
              aria-label="Enable desktop notifications"
              title="Desktop notifications"
              onClick={async () => {
                if ('Notification' in window)
                  setNotify((await Notification.requestPermission()) === 'granted');
              }}
            >
              <Bell size={18} />
            </button>
            <span className="user-avatar">Y</span>
          </div>
        </header>
        <div className="page-heading">
          <div>
            <div className="eyebrow">THE WORK BETWEEN AGENTS, HANDLED.</div>
            <h1>Review workspace</h1>
            <p>Keep the author moving. Give every change an independent review.</p>
          </div>
          <button className="button primary" onClick={() => setCreating(true)}>
            <Plus size={17} />
            Attach a PR
          </button>
        </div>
        <div className="overview">
          <div>
            <span className="metric-icon amber-bg">
              <MessageSquare size={18} />
            </span>
            <div>
              <strong>{attentionCount}</strong>
              <span>Need your attention</span>
            </div>
          </div>
          <div>
            <span className="metric-icon green-bg">
              <Activity size={18} />
            </span>
            <div>
              <strong>{runningCount}</strong>
              <span>Moving through the loop</span>
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
                    ? 'GiB in service budget'
                    : 'GiB RAM available'}
                </small>
              </strong>
              <span>
                {status?.resources.diskAvailableGiB.toFixed(0)} GiB disk free · {status?.activeJobs}{' '}
                active agent
              </span>
            </div>
            <span className={`small-dot ${status?.resources.ok ? 'healthy' : 'unhealthy'}`} />
          </div>
        </div>
        {error && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <button aria-label="Dismiss error" onClick={() => setError('')}>
              <X size={16} />
            </button>
          </div>
        )}
        {status && !status.resources.ok && (
          <div className="warning-banner">
            New agent jobs are held: {status.resources.reasons.join('; ')}. Existing files and other
            processes are preserved.
          </div>
        )}
        <div className="workbench">
          <section className="task-list">
            <div className="section-heading">
              <strong>
                {filter === 'all'
                  ? 'All tasks'
                  : filter === 'attention'
                    ? 'Needs attention'
                    : filter === 'active'
                      ? 'In progress'
                      : 'Completed'}{' '}
                <span>{visible.length}</span>
              </strong>
              <button
                className="icon-button"
                aria-label="Refresh tasks"
                onClick={() => void load()}
              >
                <RefreshCw size={15} />
              </button>
            </div>
            {!visible.length && (
              <div className="list-empty">
                <FolderGit2 size={26} />
                <p>{tasks.length ? 'Nothing in this view.' : 'Your next review starts here.'}</p>
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
                    {t.kind === 'plan' ? 'Plan' : 'Code'}
                    {t.ref.provider === 'demo' && <em>DEMO</em>}
                  </span>
                  <span>Round {t.round || '—'}</span>
                </div>
              </button>
            ))}
            <button className="add-task" onClick={() => setCreating(true)}>
              <Plus size={15} />
              Attach a pull request
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
              <span className="eyebrow">TWO SESSIONS. ONE SHARED OUTCOME.</span>
              <h2>
                {selected
                  ? 'Opening your task…'
                  : 'A second pair of eyes,\nwithout the back-and-forth.'}
              </h2>
              <p>
                Attach a GitHub pull request or GitLab merge request.
                <br />
                Discuss findings with the reviewer. Publish when you’re ready.
                <br />
                The author picks up the feedback from there.
              </p>
              <div className="empty-actions">
                <button className="button primary" onClick={() => setCreating(true)}>
                  <Plus size={16} />
                  Attach a PR
                </button>
                {status?.demoEnabled && (
                  <button className="button" onClick={() => void demo()} disabled={busy}>
                    <Play size={15} />
                    Try a demo loop
                  </button>
                )}
              </div>
              <div className="empty-notes">
                <span>
                  <LockKeyhole size={13} />
                  Manual publication by default
                </span>
                <span>
                  <GitBranch size={13} />
                  Plans and code use the same loop
                </span>
              </div>
            </section>
          ) : (
            <section className="task-detail">
              <div className="detail-header">
                <div className="detail-meta">
                  <span>
                    <GitPullRequest size={14} />
                    {task.ref.repo} #{task.ref.number}
                  </span>
                  {task.ref.provider === 'demo' && <span className="demo-label">DEMO FIXTURE</span>}
                  <a href={safeLink(task.ref.url)} target="_blank" rel="noreferrer">
                    Open PR <ArrowUpRight size={13} />
                  </a>
                </div>
                <h2>{task.title}</h2>
                <div className="detail-subtitle">
                  <StatusPill state={task.state} />
                  <span>
                    Round {task.round} of {task.policy.maxRounds}
                  </span>
                  <span className="sha">
                    <GitBranch size={12} />
                    {shortSha(task.revision?.head)}
                  </span>
                  <button className="policy-control" onClick={() => setPolicyOpen(true)}>
                    <Settings2 size={13} />
                    {task.policy.publication === 'human'
                      ? 'Manual publication'
                      : 'Automatic publication'}
                  </button>
                </div>
              </div>
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
                  <strong>{stateLabels[task.state]}</strong>
                  <p>{task.reason}</p>
                </div>
                <div className="callout-actions">
                  {task.state === 'awaiting_publication' && (
                    <button
                      className="button primary small"
                      disabled={busy || !!runningJob}
                      onClick={() => void act('publish')}
                    >
                      {task.ref.provider === 'demo' ? 'Publish demo review' : 'Publish review'}
                      <ArrowRight size={14} />
                    </button>
                  )}
                  {task.state === 'awaiting_plan_approval' && (
                    <button
                      className="button primary small"
                      disabled={busy}
                      onClick={() => void act('approve-plan')}
                    >
                      Approve plan
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
                      Resume
                    </button>
                  )}
                  {task.state === 'needs_input' && (
                    <button
                      className="button small"
                      disabled={busy || !!runningJob}
                      onClick={() => void act('retry')}
                    >
                      <RefreshCw size={14} />
                      Retry review
                    </button>
                  )}
                  {task.state === 'complete' && (
                    <button
                      className="button small"
                      disabled={busy}
                      onClick={() => void act('reopen')}
                    >
                      Reopen
                    </button>
                  )}
                  {task.state !== 'paused' && task.state !== 'complete' && (
                    <button
                      className="icon-button"
                      title="Pause task"
                      aria-label="Pause task"
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
                    {label}
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
                          {tab === 'reviewer' ? 'Independent reviewer' : 'Author session'}
                        </strong>
                        <small>
                          {runningJob?.role === tab
                            ? 'Working · updates appear here'
                            : 'A persistent session for this task'}
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
                              ? 'Make sense of the findings.'
                              : 'Stay close to the implementation.'}
                          </h3>
                          <p>
                            {tab === 'reviewer'
                              ? 'Ask about a failure scenario, challenge an assumption, or discuss a specific comment. This is the same reviewer who checks the changes.'
                              : 'Discuss requirements and ask about progress. Published feedback reaches this session automatically.'}
                          </p>
                        </div>
                      )}
                      {chatMessages.map((message) => (
                        <div key={message.id} className={`message ${message.sender}`}>
                          <div className="message-heading">
                            <strong>
                              {message.sender === 'user'
                                ? 'You'
                                : message.sender === 'system'
                                  ? 'Reviewloop'
                                  : tab === 'reviewer'
                                    ? 'Reviewer'
                                    : 'Author'}
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
                              {tab === 'reviewer' ? 'Reviewer' : 'Author'} is working
                            </strong>
                          </div>
                          {liveText ? (
                            <Md text={liveText} />
                          ) : (
                            <p>Preparing context and checking the repository…</p>
                          )}
                        </div>
                      )}
                    </div>
                    <form className="composer" onSubmit={sendMessage}>
                      <textarea
                        ref={chatInput}
                        aria-label={`Message ${tab}`}
                        placeholder={
                          tab === 'reviewer'
                            ? 'Ask about a finding, or paste a comment link…'
                            : 'Discuss the task with the author…'
                        }
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        rows={3}
                        disabled={task.state === 'paused' || task.state === 'complete'}
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
                            ? 'Private to you and the reviewer'
                            : 'Separate from the reviewer’s conversation'}
                        </span>
                        <button
                          className="button primary icon-send"
                          aria-label="Send message"
                          disabled={
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
                            ? 'Published findings'
                            : 'Draft findings'}
                          <span>{task.snapshot?.comments.length ?? 0}</span>
                        </strong>
                      </div>
                      {!task.snapshot?.comments.length && (
                        <div className="findings-empty">
                          <ShieldCheck size={25} />
                          <p>
                            {task.state === 'complete'
                              ? 'Review complete. No remaining findings.'
                              : 'Findings will appear here as the reviewer saves them.'}
                          </p>
                        </div>
                      )}
                      {task.snapshot?.comments.map((comment, index) => (
                        <article key={comment.id} className="finding">
                          <div className="finding-number">
                            <span>R{index + 1}</span>
                            <a
                              href={safeLink(comment.url)}
                              target="_blank"
                              rel="noreferrer"
                              aria-label="Open comment"
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
                            Discuss with reviewer
                            <ArrowRight size={13} />
                          </button>
                        </article>
                      ))}
                      <div className="findings-note">
                        <LockKeyhole size={14} />
                        <p>
                          {task.policy.publication === 'human'
                            ? 'Drafts stay with you until you publish. The author receives the final, published comments.'
                            : 'Completed reviews publish automatically when the session is idle.'}
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
                      text="Decisions made during review will be kept here, so the next round remembers why a finding was withdrawn or deferred."
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
                      {d.commentId && <small>Comment {d.commentId}</small>}
                    </article>
                  ))}
                </div>
              ) : (
                <div className="context-panel">
                  <div className="context-heading">
                    <FileText size={18} />
                    <h3>Original requirements</h3>
                    <span>v{task.contextVersion}</span>
                  </div>
                  <Md text={task.requirements} />
                  <div className="context-grid">
                    <div>
                      <small>BASE</small>
                      <code>{shortSha(task.revision?.base)}</code>
                    </div>
                    <div>
                      <small>REVIEWED HEAD</small>
                      <code>{shortSha(task.revision?.head)}</code>
                    </div>
                    <div>
                      <small>AUTHOR THREAD</small>
                      <code>{task.authorThreadId ?? 'Created on first run'}</code>
                    </div>
                    <div>
                      <small>REVIEWER THREAD</small>
                      <code>{task.reviewerThreadId ?? 'Created on first run'}</code>
                    </div>
                  </div>
                  {task.approvedPlan && (
                    <>
                      <h3>Approved plan · {shortSha(task.approvedPlan.head)}</h3>
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
                    Reconcile with provider
                  </button>
                </div>
              )}
            </section>
          )}
        </div>
        <footer className="page-footer">
          <span>
            <ShieldCheck size={12} />
            Publication is a decision. A completed review is tied to a revision.
          </span>
          <span>Built for a calmer review cycle.</span>
        </footer>
      </main>
      {connectionsOpen && status && (
        <Connections status={status} onClose={() => setConnectionsOpen(false)} />
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
      title="Devices & connections"
      subtitle="The service runs on the host. Your laptop is never a relay for your phone."
      onClose={onClose}
    >
      <div className="task-form">
        <h3>Web address</h3>
        <p>
          {status.publicOrigin ? (
            <a href={status.publicOrigin}>{status.publicOrigin}</a>
          ) : (
            'Local access only. Configure a permanent HTTPS address with reviewctl web on the host.'
          )}
        </p>
        <p>
          Connect the phone to the same private network, then open a one-use login link. Closing
          your laptop or the browser does not stop the service.
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
          Create phone login link
        </button>
        {link && (
          <div className="pair-link">
            <p>Valid for five minutes and one use:</p>
            <a href={link}>{link}</a>
            <button
              className="button small"
              onClick={() => void navigator.clipboard.writeText(link)}
            >
              Copy link
            </button>
          </div>
        )}
        <h3>Telegram</h3>
        <p>
          {status.telegram?.paired
            ? `Connected to @${status.telegram.bot}`
            : 'Run reviewctl telegram setup on the host, then open its private-chat pairing link.'}
        </p>
        <h3>Paired browsers</h3>
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
                Revoke
              </button>
            </div>
          ))}
        {error && (
          <p role="alert" className="field-error">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
function EmptyNote({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <div className="empty-note">
      {icon}
      <p>{text}</p>
    </div>
  );
}
function ActivityView({ detail }: { detail: Detail }) {
  const events = detail.events
    .filter((e) => e.type !== 'runtime.text' && e.type !== 'runtime.diagnostic')
    .slice()
    .reverse();
  return (
    <div className="activity-panel">
      <div className="activity-intro">
        <Activity size={16} />
        <span>Persisted events · {detail.jobs.length} runs</span>
        <code>reviewctl logs {detail.task.id.slice(0, 8)}…</code>
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
              Event {event.id}
              {event.runId ? ` · Run ${event.runId}` : ''}
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
  const [reason, setReason] = useState('');
  return (
    <div className="waiver">
      <h3>Human CI decision</h3>
      <p>Record why this exact revision may proceed without passing CI.</p>
      <textarea
        aria-label="CI waiver reason"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Reason for waiving checks…"
      />
      <button className="button small" disabled={!reason.trim()} onClick={() => onWaive(reason)}>
        Record waiver
      </button>
    </div>
  );
}
function Login({ onConnect, initialError = '' }: { onConnect: () => void; initialError?: string }) {
  const [token, setToken] = useState(''),
    [error, setError] = useState(initialError),
    [busy, setBusy] = useState(false);
  return (
    <div className="login-page">
      <Brand />
      <div className="login-card">
        <span className="login-lock">
          <LockKeyhole size={25} />
        </span>
        <h1>Your review workspace.</h1>
        <p>
          Connect to the service running on your machine.
          <br />
          Find your access token with <code>reviewctl token</code>.
        </p>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              await api('/session', { token });
              onConnect();
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <label htmlFor="token">Local access token</label>
          <input
            id="token"
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            autoComplete="off"
            placeholder="Paste your access token"
            autoFocus
          />
          {error && (
            <p className="field-error" role="alert">
              {error}
            </p>
          )}
          <button className="button primary" disabled={busy || !token.trim()}>
            {busy ? <LoaderCircle className="spin" size={16} /> : <ArrowRight size={16} />}
            Connect to workspace
          </button>
        </form>
      </div>
      <small>Local by default. Reach a remote machine through an SSH tunnel.</small>
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
            <h2 id="modal-title">{title}</h2>
            <p>{subtitle}</p>
          </div>
          <button ref={close} className="icon-button" aria-label="Close dialog" onClick={onClose}>
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
  const [url, setUrl] = useState(''),
    [repoPath, setRepoPath] = useState(''),
    [requirements, setRequirements] = useState(''),
    [kind, setKind] = useState('code'),
    [planTaskId, setPlan] = useState(''),
    [thread, setThread] = useState(''),
    [auto, setAuto] = useState(false),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  return (
    <Modal
      title="Attach a pull request"
      subtitle="Give the reviewer the original intent, not just the diff."
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
          Pull request or merge request URL
          <input
            required
            type="url"
            placeholder="https://github.com/owner/repo/pull/42"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
        </label>
        <label>
          Local repository path
          <input
            required
            placeholder="/home/you/projects/your-repo"
            value={repoPath}
            onChange={(e) => setRepoPath(e.target.value)}
          />
          <small>The runner creates separate working copies from this checkout.</small>
        </label>
        <label>
          Original requirements
          <textarea
            required
            rows={4}
            placeholder="What should this change achieve? Include constraints and acceptance criteria."
            value={requirements}
            onChange={(e) => setRequirements(e.target.value)}
          />
        </label>
        <div className="form-row">
          <label>
            Review type
            <select value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="code">Code implementation</option>
              <option value="plan">Markdown plan</option>
            </select>
          </label>
          <label>
            Approved plan
            <select value={planTaskId} onChange={(e) => setPlan(e.target.value)}>
              <option value="">No linked plan</option>
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
          <summary>Existing author session</summary>
          <label>
            Codex thread ID
            <input
              placeholder="Optional: resume an existing author"
              value={thread}
              onChange={(e) => setThread(e.target.value)}
            />
            <small>Hand control of this session to Reviewloop before attaching it.</small>
          </label>
        </details>
        <label className="checkbox-label">
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
          <span>
            <strong>Publish completed reviews automatically</strong>
            <small>Leave off to discuss and publish each draft yourself.</small>
          </span>
        </label>
        {error && (
          <div className="field-error" role="alert">
            {error}
          </div>
        )}
        <div className="modal-actions">
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button className="button primary" disabled={busy}>
            {busy ? <LoaderCircle className="spin" size={15} /> : <GitPullRequest size={15} />}
            Attach and start review
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
  const [policy, setPolicy] = useState(task.policy),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  return (
    <Modal
      title="Automation settings"
      subtitle="These permissions belong to you and remain outside the agent sessions."
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
          Review publication
          <select
            value={policy.publication}
            onChange={(e) =>
              setPolicy({
                ...policy,
                publication: e.target.value as Policy['publication'],
              })
            }
          >
            <option value="human">I publish each review</option>
            <option value="auto">Publish completed reviews automatically</option>
          </select>
        </label>
        <label>
          Plan approval
          <select
            value={policy.planApproval}
            onChange={(e) =>
              setPolicy({
                ...policy,
                planApproval: e.target.value as Policy['planApproval'],
              })
            }
          >
            <option value="human">Human approval before implementation</option>
            <option value="auto">Approve after the review and checks finish</option>
          </select>
        </label>
        <label>
          Maximum review rounds
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
          Require passing CI on the reviewed revision
        </label>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={policy.autoPush}
            onChange={(e) => setPolicy({ ...policy, autoPush: e.target.checked })}
          />
          Push the author’s completed fixes automatically
        </label>
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button className="button primary" disabled={busy}>
            Save settings
          </button>
        </div>
      </form>
    </Modal>
  );
}
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
