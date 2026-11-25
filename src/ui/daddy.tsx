import { VoiceInput, appendDictation } from './voice-input.js';
import { sameAgentProfile } from '../core/types.js';
import { RepositoryModuleField } from './repository-module.js';
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { KeyboardEvent } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  ArrowUpRight,
  Check,
  CircleCheck,
  Info,
  Folder,
  FolderGit2,
  HardDrive,
  GitPullRequest,
  LoaderCircle,
  Menu,
  MessageSquare,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Pause,
  Play,
  Plus,
  Send,
  Settings2,
  Users,
  Bell,
  BookOpen,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { DaddyClient, type DaddyApi, type DaddyBoard } from '../client/daddy.js';
import type { AgentProfiles, Message, Workspace, Task } from '../core/types.js';
import type { Preferences } from '../core/preferences.js';
import { useLocale } from './i18n.js';
import { UpdatesPanel } from './runtime.js';
import { CleanupPanel } from './cleanup.js';
import { NotificationsForm } from './notifications.js';
import './daddy.css';
import type { RepositorySelection } from '../core/workspace-registry.js';
import { WorkspaceFields } from './workspace-fields.js';
import { FolderBrowser } from './folder-browser.js';
import { InstructionFields } from './instructions.js';
import { PresetLibrary } from './preset-library.js';
import type { SessionInstructions } from '../core/instructions.js';
import { Dialog } from './dialog.js';
import { ThemeButton } from './themes.js';
import { UsageStrip, UsagePanel } from './usage.js';
import { usageSummary } from '../client/usage.js';
import { AgentProfileFields, useAgentCatalogue } from './agent-profile-fields.js';
import { QueueTaskForm, WorkerControls } from './daddy-task-controls.js';
import { profileText, taskReference, taskStatus } from '../core/task-activity.js';

const stamp = (value: string) =>
  new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const sidebarMedia = '(max-width: 850px)';
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
function isLongDiagnostic(message: string) {
  return message.length > 100 || /[\r\n]/.test(message);
}

function NoticeRetry({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button className="daddy-notice-retry" aria-label={label} title={label} onClick={onClick}>
      <RefreshCw size={16} aria-hidden="true" />
      <span>{label}</span>
    </button>
  );
}
function SessionMaintenanceError({
  title,
  shortTitle,
  reason,
  retryLabel,
  onRetry,
  onDetails,
}: {
  title: string;
  shortTitle: string;
  reason?: string;
  retryLabel: string;
  onRetry: () => void;
  onDetails: (title: string, text: string) => void;
}) {
  const { t } = useLocale();
  return (
    <div className="daddy-error" role="alert">
      <div>
        <strong className="daddy-notice-full">{t(title)}</strong>
        <strong className="daddy-notice-short">{t(shortTitle)}</strong>
        {reason && (
          <div className="daddy-session-error-reason" hidden={isLongDiagnostic(reason)}>
            {t(reason)}
          </div>
        )}
      </div>
      <div className="daddy-notice-actions">
        {reason && (
          <button
            className="daddy-notice-details"
            aria-label={t('View details')}
            title={t('View details')}
            onClick={() => onDetails(title, reason)}
          >
            <Info size={16} aria-hidden="true" />
          </button>
        )}
        <NoticeRetry label={t(retryLabel)} onClick={onRetry} />
      </div>
    </div>
  );
}
export function DaddyWorkspace({ api }: { api: DaddyApi }) {
  const { t, locale, adopt, local } = useLocale();
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [usageEngine, setUsageEngine] = useState<string>();
  const [newDraft, setNewDraft] = useState<NewSessionDraft>({});
  const [previewingRepository, setPreviewingRepository] = useState(false);
  const [returnToNew, setReturnToNew] = useState(false);
  const [sessionsCollapsed, setSessionsCollapsed] = useState(false);
  const [tasksCollapsed, setTasksCollapsed] = useState(false);
  const [model] = useState(
    () => new DaddyClient(api, location.hash.startsWith('#session/') ? location.hash.slice(9) : ''),
  );
  const state = useSyncExternalStore(model.subscribe, model.snapshot, model.snapshot),
    board = state.board;
  const [modal, setModal] = useState<
      | 'new'
      | 'workspaces'
      | 'settings'
      | 'updates'
      | 'notifications'
      | 'cleanup'
      | 'limits'
      | 'presets'
      | 'delete'
      | 'queue-task'
      | 'workers'
      | null
    >(null),
    [menu, setMenu] = useState(false),
    [pane, setPane] = useState<'chat' | 'tasks'>('chat');
  const [narrowLayout, setNarrowLayout] = useState(() => matchMedia(sidebarMedia).matches);
  const [noticeDetails, setNoticeDetails] = useState<{ title: string; text: string }>();
  const showNoticeDetails = (title: string, text: string) => setNoticeDetails({ title, text });
  const tasksPanel = useRef<HTMLElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const firstMenuItem = useRef<HTMLButtonElement>(null);
  const sessionSettingsButton = useRef<HTMLButtonElement>(null);
  const messageInput = useRef<HTMLTextAreaElement>(null);
  const wasMenuOpen = useRef(false);
  const [inspect, setInspect] = useState<string>(),
    chatScroll = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const media = matchMedia(sidebarMedia);
    const resize = () => {
      setNarrowLayout(media.matches);
      if (!media.matches) setMenu(false);
    };
    resize();
    media.addEventListener('change', resize);
    return () => media.removeEventListener('change', resize);
  }, []);
  useLayoutEffect(() => {
    if (menu) firstMenuItem.current?.focus();
    else if (wasMenuOpen.current) menuButton.current?.focus();
    wasMenuOpen.current = menu;
  }, [menu]);
  useEffect(() => {
    model.start();
    return () => model.stop();
  }, [model]);
  useEffect(() => {
    if (state.status?.preferences) adopt(state.status.preferences);
  }, [state.status?.preferences?.version]);
  useEffect(() => {
    history.replaceState(
      null,
      '',
      state.selected ? `#session/${state.selected}` : location.pathname + location.search,
    );
  }, [state.selected]);
  useEffect(() => {
    const chat = chatScroll.current;
    if (chat) chat.scrollTo({ top: chat.scrollHeight });
  }, [board?.messages.length, state.selected]);
  const onMenuKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (!menu || !event.currentTarget.contains(event.target as Node)) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      setMenu(false);
      return;
    }
    if (event.key !== 'Tab') return;
    const items = [
      ...event.currentTarget.querySelectorAll<HTMLElement>(
        'button, a[href], input, select, textarea',
      ),
    ].filter(
      (item) => item.tabIndex >= 0 && !item.matches(':disabled') && item.getClientRects().length,
    );
    const from = event.shiftKey ? items[0] : items.at(-1);
    const to = event.shiftKey ? items.at(-1) : items[0];
    if (event.target === from) {
      event.preventDefault();
      to?.focus();
    }
  };
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
  const resourceWait = board?.group.resourceWait;
  const resourceExplanation =
    'The monitor has asked daddy to recover resources. Your messages and working files are saved.';
  const deletion = board?.group.deletion;
  const preparation = deletion ? undefined : board?.group.workspacePreparation;
  const deleting = deletion?.state === 'pending' || deletion?.state === 'running';
  const preparing =
    preparation?.state === 'preparing' || (preparation?.state === 'pending' && !paused);
  const draft = state.drafts[state.selected] ?? '';
  const messageDisabled = paused || !!deletion;
  const repository = state.overrides[state.selected];
  const canSend =
    !messageDisabled && !voiceBusy && modal !== 'settings' && !state.busy && !!draft.trim();
  const sessionsToggleLabel = t(sessionsCollapsed ? 'Show sessions panel' : 'Hide sessions panel');
  const tasksToggleLabel = t(
    tasksCollapsed ? 'Show workers and tasks panel' : 'Hide workers and tasks panel',
  );
  const positions = new Map(board?.taskQueue.map((id, index) => [id, index] as const));
  const workItems = board?.tasks.toSorted(
    (a, b) =>
      (positions.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
      (positions.get(b.id) ?? Number.MAX_SAFE_INTEGER),
  );
  const firstTaskId = workItems?.[0]?.id;
  useLayoutEffect(() => {
    const panel = tasksPanel.current;
    const workspace = panel?.parentElement;
    const main = workspace?.parentElement;
    const topbar = main?.querySelector<HTMLElement>('.daddy-topbar');
    const notices = main?.querySelector<HTMLElement>('.daddy-session-notices');
    const overview = main?.querySelector<HTMLElement>('.daddy-session-overview');
    const tabs = main?.querySelector<HTMLElement>('.daddy-mobile-tabs');
    const list = panel?.querySelector('.daddy-work-items');
    const first = list?.querySelector('.daddy-work-item');
    if (
      !panel ||
      !workspace ||
      !main ||
      !topbar ||
      !notices ||
      !overview ||
      !tabs ||
      !list ||
      !first
    )
      return;

    const requiredTaskHeight = () => {
      if (!panel.getClientRects().length) return 0;
      const listStyle = getComputedStyle(list);
      return Math.ceil(
        list.getBoundingClientRect().top -
          panel.getBoundingClientRect().top +
          first.getBoundingClientRect().height +
          parseFloat(listStyle.paddingTop) +
          parseFloat(listStyle.paddingBottom) +
          parseFloat(getComputedStyle(first).marginBottom) +
          parseFloat(getComputedStyle(panel).paddingBottom) +
          1,
      );
    };
    const measure = () => {
      // Always measure the single-column layout before deciding if the tasks need the side column.
      main.removeAttribute('data-task-side');
      let height = requiredTaskHeight();
      const room =
        main.clientHeight - topbar.offsetHeight - notices.offsetHeight - tabs.offsetHeight;
      const side = pane === 'tasks' && tabs.offsetHeight > 0 && height > room;
      main.toggleAttribute('data-task-side', side);
      if (side) height = requiredTaskHeight();

      workspace.style.setProperty('--first-task-space', height + 'px');
      main.style.setProperty(
        '--session-header-height',
        Math.ceil(topbar.getBoundingClientRect().height) + 'px',
      );
      main.style.setProperty(
        '--session-tabs-height',
        Math.ceil(tabs.getBoundingClientRect().height) + 'px',
      );
      main.toggleAttribute(
        'data-task-first',
        height > 0 &&
          getComputedStyle(main).display === 'flex' &&
          height + parseFloat(getComputedStyle(overview).minBlockSize) > room,
      );
    };
    const observer = new ResizeObserver(measure);
    observer.observe(panel);
    observer.observe(first);
    for (const element of [main, topbar, notices, tabs]) observer.observe(element);
    for (const header of panel.querySelectorAll('.daddy-board-controls, .daddy-board-heading'))
      observer.observe(header);
    measure();
    return () => {
      observer.disconnect();
      workspace.style.removeProperty('--first-task-space');
      main.style.removeProperty('--session-header-height');
      main.style.removeProperty('--session-tabs-height');
      main.removeAttribute('data-task-first');
      main.removeAttribute('data-task-side');
    };
  }, [firstTaskId, pane, tasksCollapsed]);
  return (
    <div className="daddy-app">
      <aside
        id="daddy-sidebar"
        className={'daddy-sidebar' + (menu ? ' open' : '')}
        inert={narrowLayout && !menu}
        onKeyDown={onMenuKeyDown}
      >
        <div className="daddy-brand">
          <span className="daddy-mark">d.</span>
          <span>
            daddyloop<span className="daddy-brand-dot">.</span>
          </span>
        </div>
        <p className="daddy-kicker">{t('daddy will handle it.')}</p>
        <button
          ref={firstMenuItem}
          className="daddy-button primary new-session"
          onClick={() => setModal('new')}
        >
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
            <p className="daddy-empty-small">{t('No sessions yet. Give daddy the first task.')}</p>
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
          <button onClick={() => setModal('cleanup')}>
            <HardDrive size={17} />
            {t('Disk cleanup')}
          </button>
          <button onClick={() => setModal('notifications')}>
            <Bell size={17} />
            {t('Notifications')}
          </button>
          <button onClick={() => setModal('presets')}>
            <Settings2 size={17} />
            {t('Presets')}
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
          <ThemeButton showLabel />
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
          tabIndex={-1}
          onClick={() => setMenu(false)}
        />
      )}
      <main className="daddy-main" data-pane={pane} inert={menu}>
        <header className="daddy-topbar">
          <button
            ref={menuButton}
            className="daddy-icon mobile-menu"
            aria-label={t('Sessions')}
            aria-controls="daddy-sidebar"
            aria-expanded={menu}
            onClick={() => setMenu(!menu)}
          >
            <Menu size={20} />
          </button>
          <button
            className="daddy-icon daddy-sessions-toggle"
            aria-label={sessionsToggleLabel}
            title={sessionsToggleLabel}
            aria-controls="daddy-sidebar"
            aria-expanded={!sessionsCollapsed}
            onClick={() => setSessionsCollapsed((collapsed) => !collapsed)}
          >
            {sessionsCollapsed ? <PanelLeftOpen size={20} /> : <PanelLeftClose size={20} />}
          </button>
          <div className="daddy-title">
            <span className="daddy-eyebrow" title={board?.workspace?.name}>
              {board?.workspace?.name ?? 'daddyloop'}
            </span>
            <h1 title={board?.group.title}>{board?.group.title ?? t('Your dashboard')}</h1>
          </div>
          {board && (
            <div className="daddy-header-actions">
              <button
                className="daddy-button quiet"
                aria-label={t(paused ? 'Resume' : 'Pause')}
                title={t(paused ? 'Resume' : 'Pause')}
                onClick={() => void model.action(paused ? 'resume' : 'pause')}
                disabled={state.busy || !!board.group.deletion}
              >
                {paused ? <Play size={15} /> : <Pause size={15} />}
                <span>{t(paused ? 'Resume' : 'Pause')}</span>
              </button>
              <button
                className="daddy-icon"
                ref={sessionSettingsButton}
                aria-label={t('Session settings')}
                onClick={() => setModal('settings')}
                disabled={state.busy || !!board.group.deletion}
              >
                <Settings2 size={19} />
              </button>
              {board.canDelete && (
                <button
                  className="daddy-icon"
                  aria-label={t('Delete session')}
                  disabled={
                    state.busy || (!!board.group.deletion && board.group.deletion.state !== 'error')
                  }
                  onClick={() => setModal('delete')}
                >
                  <Trash2 size={18} />
                </button>
              )}
            </div>
          )}
          {board && (
            <button
              className="daddy-icon daddy-tasks-toggle"
              aria-label={tasksToggleLabel}
              title={tasksToggleLabel}
              aria-controls="daddy-tasks-panel"
              aria-expanded={!tasksCollapsed}
              onClick={() => setTasksCollapsed((collapsed) => !collapsed)}
            >
              {tasksCollapsed ? <PanelRightOpen size={20} /> : <PanelRightClose size={20} />}
            </button>
          )}
        </header>
        <div
          className="daddy-session-notices"
          role="region"
          aria-label={t('Session status')}
          tabIndex={0}
        >
          {state.error && (modal !== 'workers' || !board) && (
            <div className="daddy-error" role="alert">
              <span className="daddy-notice-message">
                {t(isLongDiagnostic(state.error) ? 'Request failed' : state.error)}
              </span>
              <div className="daddy-notice-actions">
                <button
                  className="daddy-notice-details"
                  aria-label={t('View details')}
                  title={t('View details')}
                  onClick={() => showNoticeDetails('Session status', state.error!)}
                >
                  <Info size={16} aria-hidden="true" />
                </button>
                <NoticeRetry label={t('Retry')} onClick={() => void model.refresh()} />
              </div>
            </div>
          )}
          {preparation?.state === 'error' && (
            <SessionMaintenanceError
              title="Could not prepare the session copy"
              shortTitle="Copy failed"
              reason={preparation.error}
              retryLabel="Retry"
              onDetails={showNoticeDetails}
              onRetry={() => void model.action('resume')}
            />
          )}
          {deletion?.state === 'error' && (
            <SessionMaintenanceError
              title="Session deletion stopped; working copies were preserved"
              shortTitle="Deletion failed"
              reason={deletion.error}
              retryLabel="Retry deletion"
              onDetails={showNoticeDetails}
              onRetry={() => setModal('delete')}
            />
          )}
          {resourceWait && (
            <div className="daddy-error daddy-resource-wait" role="status">
              <div className="daddy-notice-full">
                <strong>{t('Waiting for server resources')}</strong>
                {resourceWait.reasons.length > 0 && (
                  <>
                    {' · '}
                    <span>{resourceWait.reasons.map((reason) => t(reason)).join(' · ')}</span>
                  </>
                )}
              </div>
              <div className="daddy-notice-short">
                <strong>{t('Awaiting resources')}</strong>
                {resourceWait.reasons.includes('Not enough available RAM') && (
                  <div>{t('Low memory')}</div>
                )}
                {resourceWait.reasons.includes('Disk-space threshold reached') && (
                  <div>{t('Low disk space')}</div>
                )}
              </div>
              <span className="daddy-resource-explanation">{t(resourceExplanation)}</span>
              <button
                className="daddy-notice-details"
                aria-label={t('View details')}
                title={t('View details')}
                onClick={() =>
                  showNoticeDetails(
                    'Waiting for server resources',
                    [
                      ...resourceWait.reasons.map((reason) => t(reason)),
                      t(resourceExplanation),
                    ].join('\n'),
                  )
                }
              >
                <Info size={16} aria-hidden="true" />
              </button>
            </div>
          )}
          {(preparing || deleting) && (
            <div className="daddy-session-progress" role="status">
              <span className="daddy-notice-full">
                {t(
                  deleting
                    ? 'Saving results and removing session copies'
                    : 'Preparing the session copy',
                )}
              </span>
              <span className="daddy-notice-short">
                {t(deleting ? 'Deleting session' : 'Preparing copy')}
              </span>
            </div>
          )}
        </div>
        <section className="daddy-session-overview" aria-label={t('Session overview')} tabIndex={0}>
          <UsageStrip
            usage={state.usage}
            connected={state.connected}
            onDetails={(engine) => {
              setUsageEngine(engine);
              setModal('limits');
            }}
          />
        </section>
        {board ? (
          <>
            <div className="daddy-mobile-tabs">
              <button
                className={pane === 'chat' ? 'active' : ''}
                aria-controls="daddy-chat-panel"
                aria-pressed={pane === 'chat'}
                onClick={() => setPane('chat')}
              >
                <MessageSquare size={15} />
                daddy
              </button>
              <button
                className={pane === 'tasks' ? 'active' : ''}
                aria-controls="daddy-tasks-panel"
                aria-pressed={pane === 'tasks'}
                onClick={() => setPane('tasks')}
              >
                <Users size={15} />
                {t('Tasks')}
                <span>{board.tasks.length}</span>
              </button>
            </div>
            <div className="daddy-workspace" data-pane={pane}>
              <section
                id="daddy-chat-panel"
                className={'daddy-conversation' + (pane === 'tasks' ? ' mobile-hidden' : '')}
                aria-label={t('Conversation with daddy')}
              >
                <div className="daddy-chat-scroll" ref={chatScroll}>
                  <div className="daddy-chat-intro">
                    <span className="daddy-avatar">d.</span>
                    <div>
                      <strong>daddy</strong>
                      <p>
                        {t(
                          'Hand it to daddy. I’ll get the crew moving, check their work and bring you the result.',
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
                </div>
                <form
                  className="daddy-composer"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (canSend) void model.send();
                  }}
                >
                  <textarea
                    ref={messageInput}
                    aria-label={t('Message daddy')}
                    placeholder={
                      deletion
                        ? undefined
                        : t(
                            paused
                              ? 'Resume daddy to continue'
                              : 'A task, a ticket, a voice note. daddy’s listening.',
                          )
                    }
                    value={draft}
                    disabled={messageDisabled}
                    rows={3}
                    onChange={(event) => model.draft(event.target.value)}
                    onKeyDown={(event) => {
                      if (
                        event.key === 'Enter' &&
                        !event.shiftKey &&
                        !event.nativeEvent.isComposing
                      ) {
                        event.preventDefault();
                        event.currentTarget.form?.requestSubmit();
                      }
                    }}
                  />
                  <footer>
                    {repository && !board.group.deletion ? (
                      <button
                        type="button"
                        className="daddy-text-button"
                        disabled={state.busy}
                        onClick={() => setModal('settings')}
                      >
                        <FolderGit2 size={15} />
                        {t('Repository override for the next message')}
                      </button>
                    ) : (
                      <span>
                        {board.workers.active
                          ? t('Workers at work: {count}', { count: board.workers.active })
                          : t('You set the goal. daddy handles the headaches.')}
                      </span>
                    )}
                    <VoiceInput
                      key={board.group.id}
                      onBusy={setVoiceBusy}
                      disabled={messageDisabled}
                      onText={(text) => {
                        const current = model.snapshot();
                        if (current.selected === board.group.id)
                          model.draft(
                            appendDictation(current.drafts[current.selected] ?? '', text),
                          );
                      }}
                    />
                    <button
                      type="submit"
                      className="daddy-send"
                      aria-label={t('Send message')}
                      disabled={!canSend}
                    >
                      <Send size={17} />
                    </button>
                  </footer>
                </form>
                {!deletion && (
                  <div className="daddy-composer-note">
                    {t(
                      'Enter to send · Shift+Enter for a new line · Closing this page keeps work running',
                    )}
                  </div>
                )}
              </section>
              <aside
                ref={tasksPanel}
                id="daddy-tasks-panel"
                className={`daddy-board${pane === 'chat' ? ' mobile-hidden' : ''}${tasksCollapsed ? ' collapsed' : ''}`}
                aria-labelledby="daddy-task-heading"
              >
                <div className="daddy-board-controls">
                  <button
                    className="daddy-button outline"
                    aria-haspopup="dialog"
                    onClick={() => setModal('workers')}
                  >
                    <Users className="daddy-board-worker-icon" size={15} aria-hidden="true" />
                    <span className="daddy-board-worker-label">{t('Workers')}</span>
                    <span className="daddy-pool-count">
                      {board.workers.active}/{board.workers.limit}
                      {board.workers.pending && ` → ${board.workers.target}`}
                    </span>
                  </button>
                  <button
                    className="daddy-button primary"
                    aria-haspopup="dialog"
                    aria-label={t('Queue a task')}
                    onClick={() => setModal('queue-task')}
                    disabled={paused || !!board.group.deletion}
                  >
                    <Plus size={15} />
                    <span className="daddy-queue-full">{t('Queue a task')}</span>
                    <span className="daddy-queue-short">{t('Queue')}</span>
                  </button>
                </div>
                <div className="daddy-board-heading">
                  <h2 id="daddy-task-heading">
                    {t(board.taskQueue.length ? 'Task queue' : 'Tasks')}
                  </h2>
                  <span>
                    {board.tasks.filter((task) => task.state === 'complete').length}/
                    {board.tasks.length}
                  </span>
                </div>
                <div className="daddy-work-items">
                  {workItems?.map((task) => {
                    const workspaceName =
                      state.workspaces.find((workspace) => workspace.id === task.workspaceId)
                        ?.name ?? board.workspace?.name;
                    return (
                      <button
                        key={task.id}
                        className={'daddy-work-item ' + task.state}
                        title={task.title}
                        aria-haspopup="dialog"
                        onClick={() => setInspect(task.id)}
                      >
                        <span className="daddy-work-heading">
                          <strong>{task.title}</strong>
                          <MoreHorizontal size={17} aria-hidden="true" />
                        </span>
                        <span className="daddy-work-state">
                          {task.state === 'complete' ? (
                            <CircleCheck size={14} aria-hidden="true" />
                          ) : task.running ? (
                            <LoaderCircle className="spin" size={14} aria-hidden="true" />
                          ) : (
                            <span className="daddy-work-dot" aria-hidden="true" />
                          )}
                          {t(task.statusLabel)}
                        </span>
                        <span className="daddy-work-meta">
                          <code>{taskReference(task)}</code>
                          <span title={workspaceName}>{workspaceName}</span>
                          {task.ref.kind !== 'ticket' && (
                            <GitPullRequest size={14} aria-hidden="true" />
                          )}
                        </span>
                        {task.dependsOn.length > 0 && (
                          <small>
                            {t('Prerequisites: {count}', { count: task.dependsOn.length })}
                          </small>
                        )}
                      </button>
                    );
                  })}
                  {!board.tasks.length && (
                    <p className="daddy-empty-small">
                      {t('The crew is ready. Give daddy something to handle.')}
                    </p>
                  )}
                </div>
              </aside>
            </div>
          </>
        ) : (
          <div className="daddy-welcome">
            <span className="daddy-mark large">d.</span>
            <div className="daddy-eyebrow">{t('Leave it with daddy')}</div>
            <h2>
              {t('Hand it over.')}
              <br />
              <span>{t('daddy’s got it.')}</span>
            </h2>
            <p>{t('Describe the task or drop a ticket link. daddy will take it from here.')}</p>
            <button
              className="daddy-button primary"
              onClick={() => {
                if (!state.workspaces.length) setReturnToNew(true);
                setModal(state.workspaces.length ? 'new' : 'workspaces');
              }}
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
            onWorkspaces={() => {
              setReturnToNew(true);
              setModal('workspaces');
            }}
            draft={newDraft}
            onDraft={setNewDraft}
            api={model.api}
            onCreate={async (workspaceId, message, title, repository, instructions) => {
              await model.create(workspaceId, message, title, repository, instructions);
              setNewDraft({});
              setModal(null);
              setPane('chat');
              setMenu(false);
            }}
          />
        </Dialog>
      )}
      {modal === 'workspaces' && (
        <Dialog
          title={t('Workspaces on this server')}
          onClose={() => {
            setModal(returnToNew ? 'new' : null);
            setReturnToNew(false);
          }}
          wide
        >
          <WorkspaceManager
            api={api}
            workspaces={state.workspaces}
            onSaved={async (workspace) => {
              await model.refresh();
              if (returnToNew) {
                setNewDraft((draft) => ({
                  ...draft,
                  workspaceId: workspace.id,
                  repository: undefined,
                }));
                setReturnToNew(false);
                setModal('new');
              }
            }}
          />
        </Dialog>
      )}
      {modal === 'settings' && board && (
        <Dialog
          title={t('Session settings')}
          onClose={() => setModal(null)}
          closeDisabled={previewingRepository}
          fallbackFocus={() => {
            const input = messageInput.current;
            return input && !input.disabled && input.getClientRects().length
              ? input
              : sessionSettingsButton.current;
          }}
        >
          <SessionSettings
            key={board.group.id}
            repository={repository}
            onRepositoryChange={(value) => model.repository(value)}
            onPreviewingChange={setPreviewingRepository}
            api={api}
            board={board}
            onSave={async (profiles, instructions, autoMerge, forceDaddy, applyWorkers) => {
              await model.action('settings', {
                profiles,
                instructions,
                autoMerge,
                forceDaddy,
                applyWorkers,
              });
              if (!model.snapshot().error) setModal(null);
            }}
          />
        </Dialog>
      )}
      {noticeDetails && (
        <Dialog title={t(noticeDetails.title)} onClose={() => setNoticeDetails(undefined)}>
          <p className="daddy-notice-detail-text">{t(noticeDetails.text)}</p>
        </Dialog>
      )}
      {modal === 'queue-task' && board && (
        <Dialog title={t('Queue task')} onClose={() => setModal(null)}>
          <QueueTaskForm
            key={board.group.id}
            api={api}
            board={board}
            onQueued={(taskId) => {
              setModal(null);
              setInspect(taskId);
              void model.refresh();
            }}
          />
        </Dialog>
      )}
      {modal === 'workers' && board && (
        <Dialog title={t('Workers')} onClose={() => setModal(null)}>
          {state.error && (
            <p className="daddy-field-error" role="alert">
              {t(state.error)}
            </p>
          )}
          <WorkerControls
            key={board.group.id}
            api={api}
            board={board}
            busy={state.busy}
            onLimitChange={(workerLimit) => void model.action('settings', { workerLimit })}
            onChange={() => model.refresh()}
          />
        </Dialog>
      )}
      {modal === 'presets' && (
        <Dialog title={t('Preset library')} onClose={() => setModal(null)} wide>
          <PresetLibrary api={api} />
        </Dialog>
      )}
      {modal === 'delete' && board && (
        <Dialog title={t('Delete session')} onClose={() => setModal(null)}>
          <p>
            <strong>{board.group.title}</strong>
          </p>
          <p>
            {t(
              'I will stop its agents, save the results in a local archive and remove the session copies. Your source repository stays in place.',
            )}
          </p>
          <div className="daddy-actions">
            <button className="daddy-button quiet" onClick={() => setModal(null)}>
              {t('Cancel')}
            </button>
            <button
              className="daddy-button danger"
              onClick={() => {
                void model.action('delete', { expectedGeneration: board.group.generation });
                setModal(null);
              }}
            >
              {t('Delete session')}
            </button>
          </div>
        </Dialog>
      )}
      {modal === 'updates' && (
        <Dialog title={t('CLI updates')} onClose={() => setModal(null)}>
          <UpdatesPanel api={api} />
        </Dialog>
      )}
      {modal === 'limits' && (
        <Dialog title={t('Limits')} onClose={() => setModal(null)}>
          <UsagePanel api={model.api} onUpdate={model.setUsage} initialEngine={usageEngine} />
        </Dialog>
      )}
      {modal === 'cleanup' && (
        <Dialog title={t('Disk cleanup')} onClose={() => setModal(null)}>
          <CleanupPanel api={api} />
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
          <TaskReport api={api} id={inspect} board={board} onChange={() => model.refresh()} />
        </Dialog>
      )}
    </div>
  );
}
interface NewSessionDraft {
  instructions?: SessionInstructions;
  workspaceId?: string;
  message?: string;
  title?: string;
  repository?: RepositorySelection;
}
function NewSession({
  workspaces,
  busy,
  onCreate,
  onWorkspaces,
  api,
  draft,
  onDraft,
}: {
  workspaces: Workspace[];
  busy: boolean;
  onCreate: (
    workspaceId: string,
    message?: string,
    title?: string,
    repository?: RepositorySelection,
    instructions?: SessionInstructions,
  ) => Promise<void>;
  api: DaddyApi;
  onWorkspaces: () => void;
  draft: NewSessionDraft;
  onDraft: (draft: NewSessionDraft) => void;
}) {
  const { t } = useLocale(),
    [error, setError] = useState(''),
    [editingFolder, setEditingFolder] = useState(false),
    [importingInstructions, setImportingInstructions] = useState(false);
  const workspace = workspaces.find((item) => item.id === draft.workspaceId) ?? workspaces[0];
  return (
    <form
      className="daddy-form daddy-new-session"
      onSubmit={(event) => {
        event.preventDefault();
        setError('');
        if (!workspace || editingFolder || importingInstructions) return;
        void onCreate(
          workspace.id,
          draft.message,
          draft.title || draft.message?.split('\n')[0].slice(0, 80) || undefined,
          draft.repository,
          draft.instructions,
        ).catch((error) => setError(error.message));
      }}
    >
      <label className="daddy-goal-field">
        {t('What should daddy do?')}
        <textarea
          rows={4}
          data-autofocus
          value={draft.message ?? ''}
          onChange={(event) => onDraft({ ...draft, message: event.target.value })}
          placeholder={t('Tell daddy the goal, paste a ticket, or start with a question.')}
        />
      </label>
      <div className="daddy-source-choice">
        <label>
          {t('Workspace')}
          <select
            aria-label={t('Workspace')}
            value={workspace?.id ?? ''}
            onChange={(event) =>
              onDraft({ ...draft, workspaceId: event.target.value, repository: undefined })
            }
            required
          >
            {!workspaces.length && <option value="">{t('Add a workspace first')}</option>}
            {workspaces.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <p className="daddy-muted">
          {t(
            'A workspace is a repository URL or a source folder. daddy gives every worker a separate copy.',
          )}
        </p>
        {workspace && (
          <WorkspaceFields
            key={workspace.id}
            api={api}
            workspace={workspace}
            value={draft.repository}
            onEditingChange={setEditingFolder}
            onChange={(repository) => onDraft({ ...draft, repository })}
          />
        )}
        <button type="button" className="daddy-text-button" onClick={onWorkspaces}>
          <Plus size={15} />
          {t('Add another workspace')}
        </button>
      </div>
      <InstructionFields
        api={api}
        value={draft.instructions}
        onChange={(instructions) => onDraft({ ...draft, instructions })}
        onBusyChange={setImportingInstructions}
      />
      <label>
        {t('Session name (optional)')}
        <input
          value={draft.title ?? ''}
          onChange={(event) => onDraft({ ...draft, title: event.target.value })}
          maxLength={200}
          placeholder={t('From the first line of your task')}
        />
      </label>
      <p className="daddy-muted">
        {t(
          'Start with one worker. Choose models in session settings and crew size beside the task list.',
        )}
      </p>
      {editingFolder && (
        <p className="daddy-muted">
          {t('Apply or cancel folder settings before starting the session.')}
        </p>
      )}
      {error && (
        <p role="alert" className="daddy-field-error">
          {t(error)}
        </p>
      )}
      <button
        className="daddy-button primary"
        disabled={busy || !workspace || editingFolder || importingInstructions}
      >
        {busy ? <LoaderCircle size={16} className="spin" /> : <Plus size={16} />}
        {t('Start session')}
      </button>
    </form>
  );
}
function WorkspaceManager({
  api,
  workspaces,
  onSaved,
}: {
  api: DaddyApi;
  workspaces: Workspace[];
  onSaved: (workspace: Workspace) => Promise<void>;
}) {
  const { t } = useLocale();
  const [suggestions, setSuggestions] = useState<{ name: string; path: string }[]>([]);
  const [editing, setEditing] = useState<string>(),
    [showForm, setShowForm] = useState(!workspaces.length),
    [picking, setPicking] = useState(false);
  const [path, setPath] = useState(''),
    [name, setName] = useState(''),
    [base, setBase] = useState(''),
    [scope, setScope] = useState(''),
    [provider, setProvider] = useState<string>();
  const [copyMode, setCopyMode] = useState<Workspace['copyMode']>();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const create = (path = '') => {
    setEditing(undefined);
    setName(path.split('/').at(-1) ?? '');
    setPath(path);
    setBase('');
    setCopyMode(undefined);
    setProvider(undefined);
    setScope('');
    setError('');
    setPicking(false);
    setShowForm(true);
  };
  useEffect(() => {
    const controller = new AbortController();
    void api<{ name: string; path: string }[]>(
      '/workspaces/suggestions',
      undefined,
      controller.signal,
    )
      .then(setSuggestions)
      .catch(() => {});
    return () => controller.abort();
  }, [api]);
  const save = async () => {
    if (busy || picking) return;
    setBusy(true);
    setError('');
    try {
      const saved = await api<Workspace>(
        editing ? `/workspaces/${editing}/defaults` : '/workspaces',
        {
          name: name.trim(),
          path: path.trim(),
          scope,
          provider,
          copyMode: provider === 'arcadia' ? copyMode : undefined,
          ...(base ? { base } : {}),
        },
      );
      await onSaved(saved);
      setShowForm(false);
      setPicking(false);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="daddy-workspace-manager">
      <p className="daddy-muted">
        {t('Save a repository under a familiar name. daddy will prepare a copy for every worker.')}
      </p>
      {!!workspaces.length && (
        <div className="daddy-workspace-chips">
          {workspaces.map((workspace) => (
            <button
              type="button"
              key={workspace.id}
              className={
                'daddy-workspace-card' + (editing === workspace.id && showForm ? ' selected' : '')
              }
              aria-label={t('Edit workspace {name}', { name: workspace.name })}
              onClick={() => {
                setEditing(workspace.id);
                setName(workspace.name);
                setPath(workspace.repoPath);
                setScope(workspace.scope);
                setProvider(workspace.provider);
                setBase(workspace.base ?? '');
                setCopyMode(workspace.copyMode);
                setError('');
                setPicking(false);
                setShowForm(true);
              }}
            >
              <FolderGit2 size={20} />
              <span>
                <strong>{workspace.name}</strong>
                <small>
                  <span className="daddy-vcs-badge">
                    {workspace.vcs === 'arcadia'
                      ? 'Arcadia'
                      : workspace.provider === 'gitlab'
                        ? 'GitLab'
                        : workspace.provider === 'github'
                          ? 'GitHub'
                          : 'Git'}
                  </span>
                  <span>{workspace.scope || t('Repository root')}</span>
                </small>
                <code>{workspace.repoPath}</code>
              </span>
              <Settings2 size={16} />
            </button>
          ))}
        </div>
      )}
      {!showForm && (
        <button type="button" className="daddy-button outline" onClick={() => create()}>
          <Plus size={16} />
          {t('Add workspace')}
        </button>
      )}
      {showForm && (
        <form
          className="daddy-form daddy-workspace-editor"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <div className="daddy-form-heading">
            <h3>{t(editing ? 'Edit workspace defaults' : 'Add workspace')}</h3>
            <button
              type="button"
              className="daddy-text-button"
              onClick={() => {
                setShowForm(false);
                setPicking(false);
              }}
            >
              {t('Back to workspaces')}
            </button>
          </div>
          <p className="daddy-muted">
            {t(
              editing
                ? 'These defaults apply to new sessions. Existing sessions keep their folders.'
                : 'Paste a GitHub or GitLab repository URL, or choose an existing Git folder or Arcadia mount.',
            )}
          </p>
          {!editing &&
            suggestions.some(
              (item) => !workspaces.some((workspace) => workspace.repoPath === item.path),
            ) && (
              <details className="daddy-suggestions">
                <summary>{t('Choose from detected repositories')}</summary>
                <div>
                  {suggestions
                    .filter(
                      (item) => !workspaces.some((workspace) => workspace.repoPath === item.path),
                    )
                    .map((item) => (
                      <button type="button" key={item.path} onClick={() => create(item.path)}>
                        <FolderGit2 size={15} />
                        <span>
                          <strong>{item.name}</strong>
                          <code>{item.path}</code>
                        </span>
                      </button>
                    ))}
                </div>
              </details>
            )}
          <label>
            {t('Workspace name')}
            <input
              data-autofocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              maxLength={100}
              placeholder={t('For example Work or My app')}
            />
          </label>
          <label style={picking ? { display: 'none' } : undefined}>
            {t('Repository URL or server folder')}
            <input
              aria-label={t('Repository URL or server folder')}
              value={path}
              onChange={(event) => {
                setPath(event.target.value);
                setProvider(undefined);
                setCopyMode(undefined);
              }}
              placeholder="https://github.com/team/app or ~/arcadia"
              required
            />
          </label>
          {!picking && (
            <button type="button" className="daddy-button outline" onClick={() => setPicking(true)}>
              <Folder size={16} />
              {t('Browse server folders')}
            </button>
          )}
          {picking && (
            <FolderBrowser
              api={api}
              initialPath={/^(\/|~)/.test(path) ? path : ''}
              onSelect={(path) => {
                setPath(path);
                setProvider(undefined);
                setCopyMode(undefined);
                if (!name.trim()) setName(path.split('/').at(-1) ?? '');
                setPicking(false);
              }}
              onCancel={() => setPicking(false)}
            />
          )}
          <details className="daddy-advanced-settings">
            <summary>{t('Repository settings (advanced)')}</summary>
            <RepositoryModuleField api={api} value={provider} onChange={setProvider} />
            <label>
              {t('Subfolder (optional)')}
              <input
                value={scope}
                onChange={(event) => setScope(event.target.value)}
                placeholder="services/api"
              />
            </label>
            <label>
              {t('Base branch (optional)')}
              <input
                value={base}
                onChange={(event) => setBase(event.target.value)}
                placeholder={t('Repository default')}
              />
              <small>
                {t('The branch daddy starts from. Leave it empty to use the repository default.')}
              </small>
            </label>
          </details>
          {copyMode && provider === 'arcadia' && (
            <label className="daddy-toggle">
              <input
                type="checkbox"
                checked={copyMode === 'session'}
                onChange={(event) => setCopyMode(event.target.checked ? 'session' : 'pool')}
              />
              <span>{t('Use automatic copies for new sessions')}</span>
            </label>
          )}
          {error && (
            <p className="daddy-field-error" role="alert">
              {t(error)}
            </p>
          )}
          <button
            disabled={busy || picking || !path.trim() || !name.trim()}
            className="daddy-button primary"
          >
            {busy ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}
            {t('Save workspace')}
          </button>
        </form>
      )}
    </div>
  );
}
function SessionRepository({
  api,
  board,
  repository,
  disabled,
  onChange,
  onEditingChange,
  onPreviewingChange,
}: {
  api: DaddyApi;
  board: DaddyBoard;
  repository?: RepositorySelection;
  disabled: boolean;
  onChange: (value?: RepositorySelection) => void;
  onEditingChange: (editing: boolean) => void;
  onPreviewingChange: (previewing: boolean) => void;
}) {
  const { t } = useLocale();
  const { workspace, group } = board;
  const preparation = group.workspacePreparation;
  if (!workspace) return null;

  return (
    <fieldset disabled={disabled}>
      <legend>{t('Repository')}</legend>
      <dl className="daddy-session-repository">
        <dt>{t('Workspace source')}</dt>
        <dd>
          <code>
            {workspace.repoPath}
            {workspace.scope ? '/' + workspace.scope : ''}
          </code>
        </dd>
        {workspace.base && <dd>{t('Starting branch: {branch}', { branch: workspace.base })}</dd>}
        {preparation?.state === 'ready' && preparation.path && (
          <>
            <dt>{t('Session copy ready')}</dt>
            <dd>
              <code>{preparation.path}</code>
            </dd>
          </>
        )}
      </dl>
      <WorkspaceFields
        api={api}
        workspace={workspace}
        sessionId={group.id}
        value={repository}
        onChange={onChange}
        onEditingChange={onEditingChange}
        onPreviewingChange={onPreviewingChange}
        target="message"
      />
    </fieldset>
  );
}
function SessionSettings({
  repository,
  onRepositoryChange,
  onPreviewingChange,
  api,
  board,
  onSave,
}: {
  repository?: RepositorySelection;
  onRepositoryChange: (value?: RepositorySelection) => void;
  onPreviewingChange: (previewing: boolean) => void;
  api: DaddyApi;
  board: DaddyBoard;
  onSave: (
    profiles?: Partial<AgentProfiles>,
    instructions?: SessionInstructions,
    autoMerge?: boolean,
    forceDaddy?: boolean,
    applyWorkers?: boolean,
  ) => Promise<void>;
}) {
  const { t } = useLocale(),
    [profiles, setProfiles] = useState<AgentProfiles>({
      daddy: board.group.daddy,
      worker: board.workerDefault,
    }),
    [instructions, setInstructions] = useState<SessionInstructions | undefined>(
      board.group.instructions,
    ),
    [editingFolder, setEditingFolder] = useState(false),
    [importingInstructions, setImportingInstructions] = useState(false),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const [autoMerge, setAutoMerge] = useState(board.group.autoMerge ?? false);
  const originalAutoMerge = useRef(autoMerge);
  const originalProfiles = useRef(profiles);
  const [forceDaddy, setForceDaddy] = useState(false),
    [applyWorkers, setApplyWorkers] = useState(false);
  const overrides = board.workers.slots.filter(
    (s) => s.profile && !sameAgentProfile(s.profile, board.workerDefault),
  );
  const { catalogue, load } = useAgentCatalogue(api);
  const savingBlocked = busy || editingFolder || importingInstructions;
  return (
    <form
      className="daddy-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (savingBlocked) return;
        setBusy(true);
        const changed: Partial<AgentProfiles> = {};
        if (
          forceDaddy ||
          JSON.stringify(profiles.daddy) !== JSON.stringify(originalProfiles.current.daddy)
        )
          changed.daddy = profiles.daddy;
        if (
          applyWorkers ||
          JSON.stringify(profiles.worker) !== JSON.stringify(originalProfiles.current.worker)
        )
          changed.worker = profiles.worker;
        void onSave(
          Object.keys(changed).length ? changed : undefined,
          instructions,
          autoMerge === originalAutoMerge.current ? undefined : autoMerge,
          forceDaddy || undefined,
          applyWorkers || undefined,
        )
          .catch((error) => setError(error.message))
          .finally(() => setBusy(false));
      }}
    >
      {board.workspace.provider === 'github' && (
        <label className="daddy-toggle">
          <input
            type="checkbox"
            checked={autoMerge}
            onChange={(event) => setAutoMerge(event.target.checked)}
          />
          <span>
            {t('Auto-merge GitHub PRs')}
            <small className="daddy-muted">
              {t(
                'Includes already reviewed open PRs in this session. Task overrides take precedence.',
              )}
            </small>
          </span>
        </label>
      )}
      {(['daddy', 'worker'] as const).map((role) => {
        const label = role === 'daddy' ? 'daddy' : t('All workers');
        return (
          <fieldset key={role}>
            <legend>{label}</legend>
            <AgentProfileFields
              label={label}
              profile={profiles[role]}
              catalogue={catalogue}
              onChange={(profile) => setProfiles((value) => ({ ...value, [role]: profile }))}
              selectDefaultEffort
            />
            {role === 'worker' &&
              overrides.map((slot) => (
                <small key={slot.number} className="daddy-muted">
                  {t('Worker {number}', { number: slot.number })} · {profileText(slot.profile!)}
                </small>
              ))}
            {role === 'daddy' ? (
              <label className="daddy-toggle">
                <input
                  type="checkbox"
                  checked={forceDaddy}
                  onChange={(e) => setForceDaddy(e.target.checked)}
                />
                {t('Apply now and restart the active daddy turn or review')}
              </label>
            ) : (
              <label className="daddy-toggle">
                <input
                  type="checkbox"
                  checked={
                    applyWorkers ||
                    JSON.stringify(profiles.worker) !==
                      JSON.stringify(originalProfiles.current.worker)
                  }
                  onChange={(e) => setApplyWorkers(e.target.checked)}
                  disabled={
                    JSON.stringify(profiles.worker) !==
                    JSON.stringify(originalProfiles.current.worker)
                  }
                />
                {t('Apply this profile to all worker slots')}
              </label>
            )}
          </fieldset>
        );
      })}
      <SessionRepository
        api={api}
        board={board}
        repository={repository}
        disabled={busy}
        onChange={onRepositoryChange}
        onEditingChange={setEditingFolder}
        onPreviewingChange={onPreviewingChange}
      />
      <InstructionFields
        api={api}
        value={instructions}
        onChange={setInstructions}
        onBusyChange={setImportingInstructions}
      />
      <button type="button" className="daddy-text-button" onClick={() => void load(true)}>
        <RefreshCw size={14} />
        {t('Refresh model list')}
      </button>
      <p className="daddy-muted">
        {t(
          'Worker defaults apply to new tasks. Changing daddy’s model requires his session to be idle.',
        )}
      </p>
      {(error || catalogue.error) && (
        <p className="daddy-field-error" role="alert">
          {t(error || catalogue.error!)}
        </p>
      )}
      {editingFolder && (
        <p className="daddy-muted">{t('Apply or cancel folder settings before saving.')}</p>
      )}
      <button className="daddy-button primary" disabled={savingBlocked}>
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
  onChange: () => Promise<void>;
}) {
  const { t } = useLocale(),
    [value, setValue] = useState<{ task: Task; messages: Message[] }>(),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const live = board?.tasks.find((task) => task.id === id);
  const slot = board?.workers.slots.find((worker) => worker.taskId === id);
  const request = live?.workerRequest ?? value?.task.workerRequest;
  const worker = slot?.number ?? request?.slot;
  const profile = slot ? live?.worker : request?.profile;
  const ref = live?.ref ?? value?.task.ref;
  const prUrl = ref && ref.kind !== 'ticket' ? safeUrl(ref.url) : undefined;
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
          <div className="daddy-task-meta">
            <code>{taskReference(value.task)}</code>
            <span className="daddy-status-pill">
              {t(live?.statusLabel ?? taskStatus(value.task.state))}
            </span>
            {worker !== undefined && <span>{t('Worker {number}', { number: worker })}</span>}
            {profile && <span>{profileText(profile)}</span>}
          </div>
          <p>{t(live?.reason ?? value.task.reason)}</p>
          {board?.workspace.provider === 'github' && live?.ref.provider === 'github' && (
            <label className="daddy-pool-control">
              {t('Auto-merge GitHub PRs')}
              <select
                value={live.autoMerge.mode}
                disabled={busy || !!board.group.deletion}
                onChange={async (event) => {
                  const mode = event.target.value;
                  setBusy(true);
                  setError('');
                  try {
                    await api(`/daddy/sessions/${board.group.id}/tasks/${id}/auto-merge`, { mode });
                    await onChange();
                  } catch (error) {
                    setError((error as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <option value="inherit">
                  {t(
                    board.group.autoMerge
                      ? 'Use session setting (on)'
                      : 'Use session setting (off)',
                  )}
                </option>
                <option value="on">{t('On for this task')}</option>
                <option value="off">{t('Off for this task')}</option>
              </select>
            </label>
          )}
          {live?.autoMerge.result &&
            (live.autoMerge.enabled || live.autoMerge.result.state !== 'waiting') && (
              <p>{t(live.autoMerge.result.message)}</p>
            )}
          {prUrl && (
            <a className="daddy-button outline" href={prUrl} target="_blank" rel="noreferrer">
              <GitPullRequest size={16} />
              {t('Open native review')}
              <ArrowUpRight size={15} />
            </a>
          )}
          {prUrl && (live?.state ?? value.task.state) === 'needs_input' && (
            <button
              className="daddy-button outline"
              disabled={busy}
              onClick={() => void action('verify-merge')}
            >
              {t('Verify merge')}
            </button>
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
