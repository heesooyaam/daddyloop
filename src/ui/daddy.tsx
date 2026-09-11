import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  ArrowLeft,
  ArrowUpRight,
  Check,
  ChevronRight,
  CircleCheck,
  Folder,
  FolderGit2,
  GitPullRequest,
  LoaderCircle,
  Menu,
  MessageSquare,
  MoreHorizontal,
  Pause,
  Play,
  Plus,
  Send,
  Settings2,
  Users,
  Bell,
  BookOpen,
  RefreshCw,
} from 'lucide-react';
import { DaddyClient, type DaddyApi, type DaddyBoard } from '../client/daddy.js';
import type { AgentProfiles, Message, Workspace, Task } from '../core/types.js';
import type { ModelOption } from '../core/agents.js';
import type { Preferences } from '../core/preferences.js';
import { useLocale } from './i18n.js';
import { UpdatesPanel } from './runtime.js';
import { NotificationsForm } from './notifications.js';
import './daddy.css';
import type { RepositorySelection } from '../core/workspace-registry.js';
import { WorkspaceFields } from './workspace-fields.js';
import { Dialog } from './dialog.js';
import { ThemeButton } from './themes.js';
import { UsageStrip, UsagePanel } from './usage.js';
import { usageSummary } from '../client/usage.js';

const stamp = (value: string) =>
  new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const stateCopy: Record<string, string> = {
  discussing: 'Waiting for daddy',
  implementing: 'Worker on it',
  ready_for_review: 'Ready for review',
  submitting: 'Creating PR',
  queued: 'Queued for review',
  reviewing: 'daddy is reviewing',
  awaiting_publication: 'Review ready',
  fixing: 'Addressing feedback',
  awaiting_push: 'Waiting for submission',
  awaiting_checks: 'Waiting for CI',
  awaiting_plan_approval: 'Plan approval',
  needs_input: 'daddy is checking',
  paused: 'Paused',
  complete: 'Complete',
};
function safeUrl(value: string) {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : undefined;
  } catch {
    return;
  }
}
export function DaddyWorkspace({ api }: { api: DaddyApi }) {
  const { t, locale, adopt, local } = useLocale();
  const [model] = useState(
    () => new DaddyClient(api, location.hash.startsWith('#session/') ? location.hash.slice(9) : ''),
  );
  const state = useSyncExternalStore(model.subscribe, model.snapshot, model.snapshot),
    board = state.board;
  const [modal, setModal] = useState<
      'new' | 'workspaces' | 'settings' | 'updates' | 'notifications' | 'limits' | null
    >(null),
    [menu, setMenu] = useState(false),
    [pane, setPane] = useState<'chat' | 'tasks'>('chat');
  const [inspect, setInspect] = useState<string>(),
    end = useRef<HTMLDivElement>(null),
    composer = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    model.start();
    return () => model.stop();
  }, [model]);
  useEffect(() => {
    if (state.status?.preferences) adopt(state.status.preferences);
  }, [state.status?.preferences?.version]);
  useEffect(() => {
    if (state.selected) history.replaceState(null, '', `#session/${state.selected}`);
  }, [state.selected]);
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [board?.messages.length, state.selected]);
  const choose = (id: string) => {
    void model.select(id);
    setMenu(false);
    setPane('chat');
  };
  const setLanguage = async (value: 'en' | 'ru') => {
    local(value);
    try {
      adopt(await api<Preferences>('/preferences', { locale: value }));
    } catch (error) {
      model.error((error as Error).message);
    }
  };
  const paused = board?.group.daddyState === 'paused';
  return (
    <div className="daddy-app">
      <aside className={'daddy-sidebar' + (menu ? ' open' : '')}>
        <a className="daddy-brand" href="#" onClick={(event) => event.preventDefault()}>
          <span className="daddy-mark">d.</span>
          <span>
            daddyloop<span className="daddy-brand-dot">.</span>
          </span>
        </a>
        <p className="daddy-kicker">{t('One conversation. A whole team.')}</p>
        <button className="daddy-button primary new-session" onClick={() => setModal('new')}>
          <Plus size={17} />
          {t('New session')}
        </button>
        <div className="daddy-section-label">
          {t('Your sessions')}
          <span>{state.sessions.length}</span>
        </div>
        <nav className="daddy-session-list" aria-label={t('Sessions')}>
          {state.sessions.map((group) => (
            <button
              key={group.id}
              className={'daddy-session' + (state.selected === group.id ? ' selected' : '')}
              onClick={() => choose(group.id)}
            >
              <span
                className={
                  'daddy-session-dot ' +
                  (group.daddyState === 'needs_input'
                    ? 'attention'
                    : group.daddyBusy || group.workers.active
                      ? 'working'
                      : '')
                }
              />
              <span>
                <strong>{group.title}</strong>
                <small>
                  {group.workspace?.name} · {group.complete}/{group.total} {t('done')}
                </small>
              </span>
              {group.workers.active > 0 && (
                <span className="daddy-count">{group.workers.active}</span>
              )}
            </button>
          ))}
          {!state.sessions.length && (
            <p className="daddy-empty-small">{t('No sessions yet. Send the first job.')}</p>
          )}
        </nav>
        <div className="daddy-sidebar-bottom">
          <a
            className="daddy-docs-link"
            href={`https://github.com/heesooyaam/daddyloop/blob/main/docs/index/${locale}.md`}
            target="_blank"
            rel="noreferrer"
          >
            <BookOpen size={17} />
            {t('Guides')}
          </a>
          <button onClick={() => setModal('workspaces')}>
            <FolderGit2 size={17} />
            {t('Workspaces')}
            <span>{state.workspaces.length}</span>
          </button>
          <button onClick={() => setModal('notifications')}>
            <Bell size={17} />
            {t('Notifications')}
          </button>
          <button onClick={() => setModal('updates')}>
            <RefreshCw size={17} />
            {t('CLI updates')}
          </button>
          <button onClick={() => setModal('limits')}>
            <RefreshCw size={17} />
            {t('Limits')}
            {usageSummary(state.usage) && <span>{usageSummary(state.usage)}</span>}
          </button>
          <div className="daddy-language">
            <select
              aria-label={t('Language')}
              value={locale}
              onChange={(event) => void setLanguage(event.target.value as 'en' | 'ru')}
            >
              <option value="en">English</option>
              <option value="ru">Русский</option>
            </select>
            <small>v{state.status?.version ?? '…'}</small>
          </div>
          <div className={'daddy-server' + (!state.connected ? ' offline' : '')}>
            <span />
            {t(state.connected ? 'Running on your server' : 'Connecting to server')}
          </div>
        </div>
      </aside>
      {menu && (
        <button
          className="daddy-shade"
          aria-label={t('Close menu')}
          onClick={() => setMenu(false)}
        />
      )}
      <main className="daddy-main">
        <header className="daddy-topbar">
          <button
            className="daddy-icon mobile-menu"
            aria-label={t('Sessions')}
            onClick={() => setMenu(!menu)}
          >
            <Menu size={20} />
          </button>
          <div className="daddy-title">
            <span className="daddy-eyebrow">{board?.workspace?.name ?? 'daddyloop'}</span>
            <h1>{board?.group.title ?? t('What’s the job?')}</h1>
          </div>
          <ThemeButton />
          {board && (
            <div className="daddy-header-actions">
              <button
                className="daddy-button quiet"
                onClick={() => void model.action(paused ? 'resume' : 'pause')}
                disabled={state.busy}
              >
                {paused ? <Play size={15} /> : <Pause size={15} />}
                <span>{t(paused ? 'Resume' : 'Pause')}</span>
              </button>
              <button
                className="daddy-icon"
                aria-label={t('Session settings')}
                onClick={() => setModal('settings')}
              >
                <Settings2 size={19} />
              </button>
            </div>
          )}
        </header>
        <UsageStrip
          usage={state.usage}
          connected={state.connected}
          onDetails={() => setModal('limits')}
        />
        {state.error && (
          <div className="daddy-error" role="alert">
            {t(state.error)}
            <button onClick={() => void model.refresh()}>{t('Retry')}</button>
          </div>
        )}
        {board ? (
          <>
            <div className="daddy-mobile-tabs">
              <button className={pane === 'chat' ? 'active' : ''} onClick={() => setPane('chat')}>
                <MessageSquare size={15} />
                daddy
              </button>
              <button className={pane === 'tasks' ? 'active' : ''} onClick={() => setPane('tasks')}>
                <Users size={15} />
                {t('Tasks')}
                <span>{board.tasks.length}</span>
              </button>
            </div>
            <div className="daddy-workspace">
              <section
                className={'daddy-conversation' + (pane === 'tasks' ? ' mobile-hidden' : '')}
                aria-label={t('Conversation with daddy')}
              >
                <div className="daddy-chat-scroll">
                  <div className="daddy-chat-intro">
                    <span className="daddy-avatar">d.</span>
                    <div>
                      <strong>daddy</strong>
                      <p>
                        {t(
                          'Drop the task here. I’ll get the crew moving and check the work myself.',
                        )}
                      </p>
                    </div>
                  </div>
                  {board.messages.map((message) => (
                    <article key={message.id} className={'daddy-message ' + message.sender}>
                      <div className="daddy-message-label">
                        <span>
                          {message.sender === 'user'
                            ? t('You')
                            : message.sender === 'system'
                              ? 'daddyloop'
                              : 'daddy'}
                        </span>
                        <time>{stamp(message.at)}</time>
                      </div>
                      <div className="daddy-prose">
                        {message.workspace && (
                          <small className="daddy-muted">
                            {message.workspace.repoPath}
                            {message.workspace.scope ? '/' + message.workspace.scope : ''}
                          </small>
                        )}
                        <Markdown remarkPlugins={[remarkGfm]}>{message.text}</Markdown>
                      </div>
                    </article>
                  ))}
                  {board.daddyBusy && (
                    <div className="daddy-thinking">
                      <span />
                      <span />
                      <span />
                      {t('daddy is working')}
                    </div>
                  )}
                  <div ref={end} />
                </div>
                <form
                  className="daddy-composer"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void model.send();
                  }}
                >
                  <WorkspaceFields
                    key={board.group.id}
                    api={model.api}
                    workspace={board.workspace!}
                    value={state.overrides[state.selected]}
                    onChange={(value) => model.repository(value)}
                    compact
                  />
                  <textarea
                    ref={composer}
                    aria-label={t('Message daddy')}
                    placeholder={t(
                      paused
                        ? 'Resume daddy to continue'
                        : 'Drop a task or ticket. I’ll take it from here.',
                    )}
                    value={state.drafts[state.selected] ?? ''}
                    disabled={paused}
                    rows={3}
                    onChange={(event) => model.draft(event.target.value)}
                    onKeyDown={(event) => {
                      if (
                        event.key === 'Enter' &&
                        !event.shiftKey &&
                        !event.nativeEvent.isComposing
                      ) {
                        event.preventDefault();
                        void model.send();
                      }
                    }}
                  />
                  <footer>
                    <span>
                      {board.workers.active
                        ? t('Workers at work: {count}', { count: board.workers.active })
                        : t('The crew is my problem. The goal is yours.')}
                    </span>
                    <button
                      type="submit"
                      className="daddy-send"
                      aria-label={t('Send message')}
                      disabled={state.busy || paused || !state.drafts[state.selected]?.trim()}
                    >
                      <Send size={17} />
                    </button>
                  </footer>
                </form>
                <div className="daddy-composer-note">
                  {t(
                    'Enter to send · Shift+Enter for a new line · Closing this page keeps work running',
                  )}
                </div>
              </section>
              <aside className={'daddy-board' + (pane === 'chat' ? ' mobile-hidden' : '')}>
                <div className="daddy-board-header">
                  <div>
                    <span className="daddy-eyebrow">{t('Your team')}</span>
                    <h2>{t('Worker pool')}</h2>
                  </div>
                  <span className="daddy-pool-count">
                    {board.workers.active}
                    <small>/{board.workers.limit}</small>
                  </span>
                </div>
                <label className="daddy-pool-control">
                  {t('Maximum workers')}
                  <select
                    aria-label={t('Maximum workers')}
                    value={board.workers.target}
                    disabled={state.busy}
                    onChange={(event) =>
                      void model.action('settings', { workerLimit: Number(event.target.value) })
                    }
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
                <p className="daddy-pool-hint">
                  {t(
                    'Pool changes apply in the background. Busy workers finish their tasks, including review fixes.',
                  )}
                </p>
                <div className="daddy-section-label">
                  {t('Tasks')}
                  <span>
                    {board.tasks.filter((task) => task.state === 'complete').length}/
                    {board.tasks.length}
                  </span>
                </div>
                <div className="daddy-work-items">
                  {board.tasks.map((task) => (
                    <button
                      key={task.id}
                      className={'daddy-work-item ' + task.state}
                      onClick={() => setInspect(task.id)}
                    >
                      <div>
                        <span className="daddy-work-state">
                          {task.state === 'complete' ? (
                            <CircleCheck size={15} />
                          ) : task.running ? (
                            <LoaderCircle className="spin" size={15} />
                          ) : (
                            <span className="daddy-work-dot" />
                          )}
                          {t(stateCopy[task.state] ?? task.state)}
                        </span>
                        <MoreHorizontal size={17} />
                      </div>
                      <strong>{task.title}</strong>
                      <footer>
                        <span>
                          {state.workspaces.find((workspace) => workspace.id === task.workspaceId)
                            ?.name ?? board.workspace?.name}
                        </span>
                        {task.ref.kind !== 'ticket' && <GitPullRequest size={14} />}
                      </footer>
                      {task.dependsOn.length > 0 && (
                        <small>
                          {t('Prerequisites: {count}', { count: task.dependsOn.length })}
                        </small>
                      )}
                    </button>
                  ))}
                </div>
                {!board.tasks.length && (
                  <p className="daddy-empty-small">
                    {t('daddy will put the plan and work items here as you discuss the goal.')}
                  </p>
                )}
                <button
                  className="daddy-button outline"
                  onClick={() => {
                    setPane('chat');
                    composer.current?.focus();
                    model.draft(state.drafts[state.selected] || '');
                  }}
                >
                  <Plus size={16} />
                  {t('Add tasks through daddy')}
                </button>
                <div className="daddy-board-bottom">
                  <span className="daddy-avatar small">d.</span>
                  <span>
                    {t('One daddy. Shared context.')}
                    <small>
                      {board.group.daddy.model ?? t('Engine configuration')}{' '}
                      {board.group.daddy.effort && '· ' + board.group.daddy.effort}
                    </small>
                  </span>
                </div>
              </aside>
            </div>
          </>
        ) : (
          <div className="daddy-welcome">
            <span className="daddy-mark large">d.</span>
            <div className="daddy-eyebrow">{t('Meet the crew')}</div>
            <h2>
              {t('Your task.')}
              <br />
              <span>{t('My crew.')}</span>
            </h2>
            <p>
              {t(
                'Pick a workspace and give me the job. I’ll line up the workers, keep them moving and bring the result back here.',
              )}
            </p>
            <button
              className="daddy-button primary"
              onClick={() => setModal(state.workspaces.length ? 'new' : 'workspaces')}
            >
              <Plus size={17} />
              {t(state.workspaces.length ? 'Start a session' : 'Add your first workspace')}
            </button>
            <div className="daddy-welcome-steps">
              <span>
                <FolderGit2 size={18} />
                {t('Choose a workspace')}
              </span>
              <span>
                <MessageSquare size={18} />
                {t('Talk to daddy')}
              </span>
              <span>
                <Check size={18} />
                {t('Review the result')}
              </span>
            </div>
          </div>
        )}
      </main>
      {modal === 'new' && (
        <Dialog title={t('New daddy session')} onClose={() => setModal(null)}>
          <NewSession
            workspaces={state.workspaces}
            busy={state.busy}
            onWorkspaces={() => setModal('workspaces')}
            api={model.api}
            onCreate={async (workspaceId, message, title, repository) => {
              await model.create(workspaceId, message, title, repository);
              setModal(null);
              setPane('chat');
              setMenu(false);
            }}
          />
        </Dialog>
      )}
      {modal === 'workspaces' && (
        <Dialog title={t('Workspaces on this server')} onClose={() => setModal(null)} wide>
          <WorkspaceManager
            api={api}
            workspaces={state.workspaces}
            onSaved={() => void model.refresh()}
          />
        </Dialog>
      )}
      {modal === 'settings' && board && (
        <Dialog title={t('Session settings')} onClose={() => setModal(null)}>
          <SessionSettings
            api={api}
            board={board}
            onSave={async (profiles) => {
              await model.action('settings', { profiles });
              if (!model.snapshot().error) setModal(null);
            }}
          />
        </Dialog>
      )}
      {modal === 'updates' && (
        <Dialog title={t('CLI updates')} onClose={() => setModal(null)}>
          <p className="daddy-muted">
            {t(
              'Install or roll back Codex from /updates in Telegram, or use daddy runtime update --yes.',
            )}
          </p>
          <UpdatesPanel api={api} />
        </Dialog>
      )}
      {modal === 'limits' && (
        <Dialog title={t('Limits')} onClose={() => setModal(null)}>
          <UsagePanel api={model.api} onUpdate={model.setUsage} />
        </Dialog>
      )}
      {modal === 'notifications' && (
        <Dialog title={t('Notifications and Telegram')} onClose={() => setModal(null)}>
          <div className="daddy-telegram-setup">
            <strong>
              {state.status?.telegram.group?.title ?? t('One topic per daddy session')}
            </strong>
            <p>
              {t(
                'Send /group to your bot to connect a group with topics. Each session gets a topic automatically.',
              )}
            </p>
            {state.status?.telegram.bot && (
              <a
                className="daddy-button outline"
                href={`https://t.me/${state.status.telegram.bot}`}
                target="_blank"
                rel="noreferrer"
              >
                {t('Open Telegram')}
                <ArrowUpRight size={16} />
              </a>
            )}
          </div>
          <NotificationsForm api={api} />
        </Dialog>
      )}
      {inspect && (
        <Dialog title={t('Work item')} onClose={() => setInspect(undefined)} wide>
          <TaskReport api={api} id={inspect} board={board} onChange={() => void model.refresh()} />
        </Dialog>
      )}
    </div>
  );
}
function NewSession({
  workspaces,
  busy,
  onCreate,
  onWorkspaces,
  api,
}: {
  workspaces: Workspace[];
  busy: boolean;
  onCreate: (
    workspaceId: string,
    message?: string,
    title?: string,
    repository?: RepositorySelection,
  ) => Promise<void>;
  api: DaddyApi;
  onWorkspaces: () => void;
}) {
  const { t } = useLocale(),
    [workspace, setWorkspace] = useState(workspaces[0]?.id ?? ''),
    [message, setMessage] = useState(''),
    [title, setTitle] = useState(''),
    [repository, setRepository] = useState<RepositorySelection>(),
    [error, setError] = useState('');
  return (
    <form
      className="daddy-form"
      onSubmit={(event) => {
        event.preventDefault();
        setError('');
        void onCreate(
          workspace,
          message,
          title || message.split('\n')[0].slice(0, 80) || undefined,
          repository,
        ).catch((error) => setError(error.message));
      }}
    >
      <label>
        {t('Workspace')}
        <select
          value={workspace}
          onChange={(event) => {
            setWorkspace(event.target.value);
            setRepository(undefined);
          }}
          required
        >
          {!workspaces.length && <option value="">{t('Add a workspace first')}</option>}
          {workspaces.map((workspace) => (
            <option key={workspace.id} value={workspace.id}>
              {workspace.name}
            </option>
          ))}
        </select>
      </label>
      {workspace && (
        <WorkspaceFields
          key={workspace}
          api={api}
          workspace={workspaces.find((item) => item.id === workspace)!}
          value={repository}
          onChange={setRepository}
        />
      )}
      <button type="button" className="daddy-text-button" onClick={onWorkspaces}>
        <Plus size={15} />
        {t('Register another workspace')}
      </button>
      <label>
        {t('What should daddy do?')}
        <textarea
          rows={5}
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          placeholder={t(
            'Describe the goal or paste one or more ticket links. You can start with a discussion.',
          )}
        />
      </label>
      <label>
        {t('Session name (optional)')}
        <input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={200} />
      </label>
      <p className="daddy-muted">
        {t('One worker to start. Set the crew size; I’ll handle the assignments.')}
      </p>
      {error && (
        <p role="alert" className="daddy-field-error">
          {t(error)}
        </p>
      )}
      <button className="daddy-button primary" disabled={busy || !workspace}>
        {busy ? <LoaderCircle size={16} className="spin" /> : <Plus size={16} />}{' '}
        {t('Start session')}
      </button>
    </form>
  );
}
type DirectoryList = {
  path: string;
  parent: string | null;
  directories: { name: string; path: string }[];
  truncated: boolean;
};
function WorkspaceManager({
  api,
  workspaces,
  onSaved,
}: {
  api: DaddyApi;
  workspaces: Workspace[];
  onSaved: () => void;
}) {
  const { t } = useLocale(),
    [suggestions, setSuggestions] = useState<{ name: string; path: string }[]>([]),
    [editing, setEditing] = useState<string>(),
    [listing, setListing] = useState<DirectoryList>(),
    [path, setPath] = useState(''),
    [name, setName] = useState(''),
    [base, setBase] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const sequence = useRef(0);
  const browse = async (value: string, keepName = false) => {
    const at = ++sequence.current;
    setBusy(true);
    setError('');
    try {
      const next = await api<DirectoryList>(
        '/workspaces/directories' + (value ? '?path=' + encodeURIComponent(value) : ''),
      );
      if (at !== sequence.current) return;
      setListing(next);
      setPath(next.path);
      if (next.path && !editing && !keepName) setName(next.path.split('/').at(-1) ?? '');
    } catch (error) {
      if (at === sequence.current) setError((error as Error).message);
    } finally {
      if (at === sequence.current) setBusy(false);
    }
  };
  useEffect(() => {
    void api<{ name: string; path: string }[]>('/workspaces/suggestions')
      .then(setSuggestions)
      .catch((error) => setError(error.message));
    void browse('');
    return () => {
      sequence.current++;
    };
  }, []);
  const save = async () => {
    setBusy(true);
    setError('');
    try {
      await api(editing ? `/workspaces/${editing}/defaults` : '/workspaces', {
        name,
        path,
        ...(base ? { base } : {}),
      });
      onSaved();
      setError('');
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="daddy-workspace-manager">
      <p className="daddy-muted">
        {t(
          'Register the source folder once. Agents use separate working copies; your checkout and local edits stay in place.',
        )}
      </p>
      {!!workspaces.length && (
        <div className="daddy-workspace-chips">
          {workspaces.map((workspace) => (
            <button
              key={workspace.id}
              onClick={() => {
                void browse(
                  workspace.repoPath + (workspace.scope ? '/' + workspace.scope : ''),
                  true,
                );
                setEditing(workspace.id);
                setName(workspace.name);
                setBase(workspace.base ?? '');
              }}
            >
              <FolderGit2 size={15} />
              <span>
                {workspace.name}
                <small>
                  {workspace.vcs === 'arcadia' ? 'Arcadia' : 'Git'} ·{' '}
                  {workspace.scope || t('Repository root')}
                </small>
              </span>
            </button>
          ))}
        </div>
      )}
      {!!suggestions.length && (
        <details className="daddy-suggestions" open={!workspaces.length}>
          <summary>{t('Detected repositories')}</summary>
          <div>
            {suggestions.map((item) => (
              <button key={item.path} onClick={() => void browse(item.path)}>
                <FolderGit2 size={15} />
                {item.name}
                <ChevronRight size={15} />
              </button>
            ))}
          </div>
        </details>
      )}
      <div className="daddy-folder-browser">
        <div className="daddy-folder-path">
          <button
            className="daddy-icon"
            aria-label={t('Parent directory')}
            onClick={() => void browse(listing?.parent ?? '')}
            disabled={busy}
          >
            <ArrowLeft size={16} />
          </button>
          <input
            aria-label={t('Server directory')}
            value={path}
            placeholder={t('Absolute path on the server')}
            onChange={(event) => setPath(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void browse(path);
              }
            }}
          />
          <button className="daddy-button quiet" disabled={busy} onClick={() => void browse(path)}>
            {t('Open')}
          </button>
        </div>
        <div className="daddy-directories">
          {listing?.directories.map((entry) => (
            <button key={entry.path} disabled={busy} onClick={() => void browse(entry.path)}>
              <Folder size={16} />
              <span>{entry.name}</span>
              <ChevronRight size={15} />
            </button>
          ))}
          {!listing?.directories.length && (
            <span className="daddy-muted">{t('No subdirectories')}</span>
          )}
        </div>
        {listing?.truncated && (
          <p className="daddy-muted">
            {t('Only the first 150 folders are shown. Enter a more specific path above.')}
          </p>
        )}
      </div>
      <form
        className="daddy-form"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        {editing && (
          <p className="daddy-muted">
            {t(
              'Default changes apply to new sessions on this server. Existing sessions keep their settings.',
            )}{' '}
            <button
              type="button"
              className="daddy-text-button"
              onClick={() => {
                setEditing(undefined);
                setName('');
              }}
            >
              {t('Register another workspace')}
            </button>
          </p>
        )}
        <div className="daddy-form-columns">
          <label>
            {t('Workspace name')}
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              maxLength={100}
            />
          </label>
          <label>
            {t('Base branch (optional)')}
            <input
              value={base}
              onChange={(event) => setBase(event.target.value)}
              placeholder="main / trunk"
            />
          </label>
        </div>
        <p className="daddy-muted">
          {t('Selecting a subdirectory sets the agent’s starting folder inside each working copy.')}
        </p>
        {error && (
          <p className="daddy-field-error" role="alert">
            {t(error)}
          </p>
        )}
        <button disabled={busy || !path || !name.trim()} className="daddy-button primary">
          {busy ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}{' '}
          {t('Save workspace')}
        </button>
      </form>
    </div>
  );
}
function SessionSettings({
  api,
  board,
  onSave,
}: {
  api: DaddyApi;
  board: DaddyBoard;
  onSave: (profiles: AgentProfiles) => Promise<void>;
}) {
  const { t } = useLocale(),
    [profiles, setProfiles] = useState<AgentProfiles>({
      daddy: board.group.daddy,
      worker: board.group.worker ?? board.group.daddy,
    }),
    [models, setModels] = useState<ModelOption[]>([]),
    [engines, setEngines] = useState<{ id: string; name: string }[]>([]),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const load = async (refresh = false) => {
    try {
      const result = await api<{
        models: ModelOption[];
        engines: { id: string; name: string }[];
        error?: string;
      }>('/agents' + (refresh ? '?refresh=1' : ''));
      setModels(result.models);
      setEngines(result.engines);
      setError(result.error ?? '');
    } catch (error) {
      setError((error as Error).message);
    }
  };
  useEffect(() => {
    void load();
  }, []);
  return (
    <form
      className="daddy-form"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        void onSave(profiles)
          .catch((error) => setError(error.message))
          .finally(() => setBusy(false));
      }}
    >
      {(['daddy', 'worker'] as const).map((role) => {
        const profile = profiles[role],
          choices = models.filter((model) => model.engine === profile.engine),
          model = choices.find((model) => model.id === profile.model);
        return (
          <fieldset key={role}>
            <legend>{role === 'daddy' ? 'daddy' : t('New workers')}</legend>
            <label>
              {t('Agent module')}
              <select
                aria-label={
                  (role === 'daddy' ? 'daddy' : t('New workers')) + ' ' + t('Agent module')
                }
                value={profile.engine}
                onChange={(event) =>
                  setProfiles({ ...profiles, [role]: { engine: event.target.value } })
                }
              >
                {!engines.some((engine) => engine.id === profile.engine) && (
                  <option value={profile.engine}>{profile.engine}</option>
                )}
                {engines.map((engine) => (
                  <option key={engine.id} value={engine.id}>
                    {engine.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t('Model')}
              <select
                aria-label={(role === 'daddy' ? 'daddy' : t('New workers')) + ' ' + t('Model')}
                value={profile.model ?? ''}
                onChange={(event) => {
                  const model = choices.find((model) => model.id === event.target.value);
                  setProfiles({
                    ...profiles,
                    [role]: {
                      engine: profile.engine,
                      ...(model ? { model: model.id, effort: model.defaultEffort } : {}),
                    },
                  });
                }}
              >
                <option value="">{t('Engine configuration')}</option>
                {profile.model && !model && <option value={profile.model}>{profile.model}</option>}
                {choices.map((model) => (
                  <option value={model.id} key={model.id}>
                    {model.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t('Reasoning effort')}
              <select
                value={profile.effort ?? ''}
                disabled={!profile.model}
                onChange={(event) =>
                  setProfiles({
                    ...profiles,
                    [role]: { ...profile, effort: event.target.value || undefined },
                  })
                }
              >
                <option value="">{t('Default')}</option>
                {model?.efforts.map((effort) => (
                  <option value={effort} key={effort}>
                    {effort}
                  </option>
                ))}
              </select>
            </label>
          </fieldset>
        );
      })}
      <button type="button" className="daddy-text-button" onClick={() => void load(true)}>
        <RefreshCw size={14} />
        {t('Refresh model list')}
      </button>
      <p className="daddy-muted">
        {t(
          'Worker defaults apply to new tasks. Changing daddy’s model requires his session to be idle.',
        )}
      </p>
      {error && (
        <p className="daddy-field-error" role="alert">
          {t(error)}
        </p>
      )}
      <button className="daddy-button primary" disabled={busy}>
        {t('Save settings')}
      </button>
    </form>
  );
}
function TaskReport({
  api,
  id,
  board,
  onChange,
}: {
  api: DaddyApi;
  id: string;
  board?: DaddyBoard;
  onChange: () => void;
}) {
  const { t } = useLocale(),
    [value, setValue] = useState<{ task: Task; messages: Message[] }>(),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    void api<{ task: Task; messages: Message[] }>(`/tasks/${id}`)
      .then((result) => {
        if (active) setValue(result);
      })
      .catch((error) => {
        if (active) setError(error.message);
      });
    return () => {
      active = false;
    };
  }, [id]);
  const action = async (action: string) => {
    if (!board || !value) return;
    setBusy(true);
    try {
      await api(`/daddy/sessions/${board.group.id}/task-action`, {
        taskId: id,
        action,
        expectedHead: value.task.revision?.head ?? '',
        expectedGeneration: value.task.generation,
      });
      onChange();
      const next = await api<{ task: Task; messages: Message[] }>(`/tasks/${id}`);
      setValue(next);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="daddy-task-report">
      {error && (
        <p role="alert" className="daddy-field-error">
          {t(error)}
        </p>
      )}
      {value ? (
        <>
          <h3>{value.task.title}</h3>
          <span className="daddy-status-pill">
            {t(stateCopy[value.task.state] ?? value.task.state)}
          </span>
          <p>{value.task.reason}</p>
          {value.task.ref.kind !== 'ticket' && safeUrl(value.task.ref.url) && (
            <a
              className="daddy-button outline"
              href={value.task.ref.url}
              target="_blank"
              rel="noreferrer"
            >
              <GitPullRequest size={16} />
              {t('Open native review')}
              <ArrowUpRight size={15} />
            </a>
          )}
          {value.task.state === 'awaiting_plan_approval' && (
            <button
              disabled={busy}
              className="daddy-button primary"
              onClick={() => void action('approve-plan')}
            >
              {t('Approve plan')}
            </button>
          )}
          {value.task.state === 'awaiting_publication' &&
            value.task.policy.publication === 'human' && (
              <button
                disabled={busy}
                className="daddy-button primary"
                onClick={() => void action('publish')}
              >
                {t('Publish review')}
              </button>
            )}
          {value.task.state === 'ready_for_review' && !value.task.policy.autoPush && (
            <button
              disabled={busy}
              className="daddy-button primary"
              onClick={() => void action('submit')}
            >
              {t('Submit for review')}
            </button>
          )}
          <h4>{t('Original requirements')}</h4>
          <div className="daddy-prose">
            <Markdown remarkPlugins={[remarkGfm]}>{value.task.requirements}</Markdown>
          </div>
          <h4>{t('Read-only worker reports')}</h4>
          <p className="daddy-muted">
            {t('Bring it to daddy in the main chat. I’ll get the right worker on it.')}
          </p>
          {value.messages
            .filter((message) => message.sender === 'agent')
            .slice(-8)
            .map((message) => (
              <div className="daddy-report-message" key={message.id}>
                <strong>{message.role === 'reviewer' ? 'daddy' : t('Worker')}</strong>
                <time>{stamp(message.at)}</time>
                <div className="daddy-prose">
                  <Markdown remarkPlugins={[remarkGfm]}>{message.text}</Markdown>
                </div>
              </div>
            ))}
        </>
      ) : (
        !error && <LoaderCircle className="spin" />
      )}
    </div>
  );
}
