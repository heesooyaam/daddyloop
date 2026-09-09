import { translator, type Locale } from '../i18n/index.js';
import type { Preferences } from '../core/preferences.js';
import type { UpdateStatus } from '../core/updates.js';
import type { ModelCatalogueInfo } from '../core/agents.js';
import type {
  Task,
  Message,
  Event,
  Job,
  Decision,
  ResourceStatus,
  Role,
  AgentProfiles,
  ReviewGroup,
  TicketSource,
} from '../core/types.js';
import type { ModelOption } from '../core/agents.js';
import type { Editor } from './editor.js';
import { emptyEditor, insert } from './editor.js';
import { oneLine, graphemes } from './text.js';
import { parsePR } from '../providers/provider.js';
import { openPlanning, submitPlanning } from './planning.js';
export type Api = <T>(path: string, body?: unknown, signal?: AbortSignal) => Promise<T>;
export interface Detail {
  task: Task;
  messages: Message[];
  events: Event[];
  jobs: Job[];
  decisions: Decision[];
  agents?: AgentProfiles;
  group?: ReviewGroup;
  siblings?: { id: string; title: string; state: Task['state']; parentTaskId?: string }[];
}
export interface Status {
  preferences?: Preferences;
  updates?: UpdateStatus;
  version: string;
  resources: ResourceStatus;
  activeJobs: number;
  publicOrigin: string | null;
  demoEnabled: boolean;
}
export type View = 'chat' | 'findings' | 'activity' | 'context' | 'group';
export interface AgentSettings {
  models: ModelOption[];
  defaults: AgentProfiles;
  maxConcurrentAgents: number;
  error?: string;
  catalogue?: ModelCatalogueInfo;
}
export interface Overlay {
  kind:
    'tasks' | 'help' | 'attach' | 'ticket' | 'models' | 'notifications' | 'language' | 'updates';
  id?: number;
  editor: Editor;
  index: number;
  step?: number;
  fields?: string[];
  parentTaskId?: string;
  targetTaskId?: string;
  profiles?: AgentProfiles;
  profileRole?: Role;
  scope?: 'task' | 'defaults';
  source?: TicketSource;
  paired?: boolean;
}
export interface ConsoleState {
  locale: Locale;
  preferences?: Preferences;
  updates?: UpdateStatus;
  tasks: Task[];
  selectedId: string;
  role: Role;
  detail?: Detail;
  status?: Status;
  connection: 'connecting' | 'online' | 'offline';
  connectionError?: string;
  drafts: Record<string, Editor>;
  pending?: { key: string; text: string };
  busy: boolean;
  notice?: string;
  error?: string;
  view: View;
  scroll: number;
  menuIndex: number;
  menuHidden: boolean;
  overlay?: Overlay;
  agentSettings?: AgentSettings;
}
export const commands = [
  { name: '/language', hint: 'Choose English or Russian' },
  { name: '/updates', hint: 'CLI versions and update notifications' },
  { name: '/new', hint: 'Start from a GitHub issue or Tracker ticket' },
  { name: '/child', hint: 'Add a ticket with the same reviewer' },
  { name: '/models', hint: 'Choose author / reviewer models' },
  { name: '/defaults', hint: 'Default models for new tasks' },
  { name: '/notifications', hint: 'Configure Telegram updates' },
  { name: '/implement', hint: 'Implement this ticket and start its review loop' },
  { name: '/submit', hint: 'Submit the saved implementation' },
  { name: '/concurrency', hint: 'Set the maximum simultaneous agents: 1..8' },
  { name: '/link', hint: 'Connect this ticket to an existing PR URL' },
  { name: '/group', hint: 'View sibling tickets and the shared reviewer' },
  { name: '/tasks', hint: 'Choose a task', shortcut: 'Ctrl+T' },
  { name: '/use', hint: 'Select a task by its ID prefix' },
  { name: '/role', hint: 'Switch author / reviewer', shortcut: 'Tab' },
  { name: '/reviewer', hint: 'Open the reviewer conversation' },
  { name: '/author', hint: 'Open the author conversation' },
  { name: '/findings', hint: 'Read the current native review' },
  { name: '/logs', hint: 'Inspect recent agent activity' },
  { name: '/context', hint: 'Requirements and session details' },
  { name: '/chat', hint: 'Return to the conversation' },
  { name: '/publish', hint: 'Publish this task’s finished review' },
  { name: '/pause', hint: 'Pause this task on the server' },
  { name: '/resume', hint: 'Continue a paused / interrupted task' },
  { name: '/retry', hint: 'Retry the current reviewer' },
  { name: '/attach', hint: 'Connect an existing PR or MR' },
  { name: '/demo', hint: 'Start a built-in demo loop' },
  { name: '/refresh', hint: 'Reconnect and refresh status' },
  { name: '/help', hint: 'Keyboard shortcuts and commands' },
  { name: '/quit', hint: 'Close this console; work continues', shortcut: 'Ctrl+Q' },
];
export class ConsoleModel {
  private state: ConsoleState;
  private listeners = new Set<() => void>();
  private controller = new AbortController();
  private polling?: NodeJS.Timeout;
  private refreshing?: Promise<void>;
  private refreshAgain = false;
  private selection = 0;
  private stopped = false;
  private initialId?: string;
  private autoSelected = false;
  private overlayId = 0;
  private localeOverride?: Locale;
  t = (text: string, values?: Record<string, unknown>) =>
    translator(this.state.locale)(text, values);
  constructor(
    private api: Api,
    initial?: { id?: string; role?: Role; locale?: Locale },
  ) {
    this.initialId = initial?.id;
    this.localeOverride = initial?.locale;
    this.state = {
      locale: initial?.locale ?? 'en',
      tasks: [],
      selectedId: '',
      role: initial?.role ?? 'reviewer',
      connection: 'connecting',
      drafts: {},
      busy: false,
      view: 'chat',
      scroll: 0,
      menuIndex: 0,
      menuHidden: false,
    };
  }
  snapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  patch(patch: Partial<ConsoleState>) {
    if (this.stopped) return;
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  key(id = this.state.selectedId, role = this.state.role) {
    return `${id}:${role}`;
  }
  editor() {
    return this.state.overlay?.editor ?? this.state.drafts[this.key()] ?? emptyEditor();
  }
  setEditor(editor: Editor) {
    if (this.state.overlay) this.patch({ overlay: { ...this.state.overlay, editor, index: 0 } });
    else
      this.patch({
        drafts: { ...this.state.drafts, [this.key()]: editor },
        menuIndex: 0,
        menuHidden: false,
      });
  }
  paste(text: string) {
    if (this.editor().text.length + text.length > 10000) {
      this.patch({
        error:
          'Paste is too large. The composer accepts up to 10,000 characters; split the message.',
      });
      return;
    }
    this.setEditor({ ...insert(this.editor(), text), literal: true });
    this.patch({ menuHidden: true });
  }
  menu() {
    const text = this.editor().text;
    return !this.state.overlay &&
      !this.state.menuHidden &&
      !this.editor().literal &&
      /^\/[^\s]*$/.test(text)
      ? commands.filter((command) => command.name.startsWith(text))
      : [];
  }
  taskMatches() {
    const query = oneLine(this.state.overlay?.editor.text).toLowerCase();
    return this.state.tasks.filter((task) =>
      `${task.title} ${task.id} ${task.ref.repo} ${task.state}`.toLowerCase().includes(query),
    );
  }
  open(kind: Overlay['kind']) {
    this.patch({
      overlay: {
        kind,
        id: ++this.overlayId,
        editor: emptyEditor(),
        index: 0,
        ...(kind === 'attach' ? { step: 0, fields: [] } : {}),
      },
      error: undefined,
    });
  }
  closeOverlay() {
    this.patch({ overlay: undefined });
  }
  setRole(role: Role) {
    this.patch({ role, view: 'chat', scroll: 0, menuHidden: true });
  }
  select(prefix: string) {
    const matches = this.state.tasks.filter((task) => task.id.startsWith(prefix));
    if (matches.length !== 1) {
      this.patch({
        error: matches.length
          ? 'Task prefix is ambiguous.'
          : 'Task not found. Open /tasks to choose one.',
      });
      return;
    }
    this.selection++;
    this.patch({
      selectedId: matches[0].id,
      detail: undefined,
      overlay: undefined,
      scroll: 0,
      error: undefined,
      view: 'chat',
      menuHidden: true,
    });
    void this.refresh();
  }
  start() {
    void this.refresh();
    this.polling = setInterval(() => void this.refresh(), 1500);
  }
  stop() {
    this.stopped = true;
    clearInterval(this.polling);
    this.controller.abort();
    this.listeners.clear();
  }
  async request<T>(path: string, body?: unknown): Promise<T> {
    return this.api<T>(
      path,
      body,
      AbortSignal.any([
        this.controller.signal,
        AbortSignal.timeout(body === undefined ? 8000 : 120000),
      ]),
    );
  }
  refresh(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.refreshing) {
      this.refreshAgain = true;
      return this.refreshing;
    }
    this.refreshing = this.load().finally(() => {
      this.refreshing = undefined;
      if (this.refreshAgain && !this.stopped) {
        this.refreshAgain = false;
        void this.refresh();
      }
    });
    return this.refreshing;
  }
  private async load() {
    const id = this.state.selectedId,
      selection = this.selection;
    try {
      const [tasks, status, detail] = await Promise.all([
        this.request<Task[]>('/tasks'),
        this.request<Status>('/status'),
        id ? this.request<Detail>(`/tasks/${encodeURIComponent(id)}`) : undefined,
      ]);
      this.patch({
        tasks,
        status,
        connection: 'online',
        connectionError: undefined,
        updates: status.updates ?? this.state.updates,
        ...(status.preferences &&
        status.preferences.version >= (this.state.preferences?.version ?? -1)
          ? {
              preferences: status.preferences,
              locale: this.localeOverride ?? status.preferences.locale,
            }
          : {}),
        ...(id === this.state.selectedId && selection === this.selection && detail
          ? { detail }
          : {}),
      });
      if (!id && !this.state.selectedId && tasks.length && !this.autoSelected) {
        this.autoSelected = true;
        const prefix = this.initialId ?? tasks[0].id;
        this.initialId = undefined;
        this.select(prefix);
      }
    } catch (error) {
      if (!this.stopped && selection === this.selection)
        this.patch({ connection: 'offline', connectionError: oneLine((error as Error).message) });
    }
  }
  async send() {
    const { selectedId, role, busy } = this.state;
    const draft = this.editor(),
      text = draft.text.trim(),
      key = this.key();
    if (!text || busy) return;
    if (!selectedId) {
      this.patch({ error: 'Choose a task with Ctrl+T, /attach or /demo first.' });
      return;
    }
    this.patch({
      busy: true,
      pending: { key, text },
      error: undefined,
      drafts: { ...this.state.drafts, [key]: emptyEditor() },
      scroll: 0,
    });
    try {
      await this.request(`/tasks/${encodeURIComponent(selectedId)}/messages`, { role, text });
      this.patch({ notice: `Message queued for ${role}.` });
      void this.refresh();
    } catch (error) {
      const newer = this.state.drafts[key]?.text ?? '';
      const restored = text + (newer ? '\n' + newer : '');
      this.patch({
        drafts: {
          ...this.state.drafts,
          [key]: {
            text: restored,
            cursor: graphemes(restored).length,
            literal: draft.literal || this.state.drafts[key]?.literal,
          },
        },
        error: `Delivery was not confirmed: ${oneLine((error as Error).message)}. Check the conversation before sending again.`,
      });
    } finally {
      this.patch({ busy: false, pending: undefined });
    }
  }
  async mutate(action: string, body?: Record<string, unknown>) {
    if (this.state.busy) return;
    const id = this.state.selectedId;
    this.patch({ busy: true, error: undefined });
    try {
      if (action === 'demo' || action === 'attach') {
        const task = await this.request<Task>(action === 'demo' ? '/demo' : '/tasks', body ?? {});
        this.patch({
          tasks: [task, ...this.state.tasks.filter((value) => value.id !== task.id)],
          notice: 'Task attached. The service will start the review.',
        });
        this.select(task.id);
      } else {
        if (!id) throw new Error('Choose a task first.');
        await this.request(`/tasks/${encodeURIComponent(id)}/actions`, { action });
        this.patch({ notice: `${action} requested for ${id.slice(0, 8)}.` });
        void this.refresh();
      }
    } catch (error) {
      this.patch({ error: oneLine((error as Error).message) });
    } finally {
      this.patch({ busy: false });
    }
  }
  async submitOverlay() {
    const overlay = this.state.overlay;
    if (!overlay) return;
    if (['ticket', 'models', 'notifications', 'language', 'updates'].includes(overlay.kind)) {
      await submitPlanning(this);
      return;
    }
    if (overlay.kind === 'tasks') {
      const task = this.taskMatches()[overlay.index];
      if (task) this.select(task.id);
      return;
    }
    if (overlay.kind === 'help') {
      this.closeOverlay();
      return;
    }
    const value = overlay.editor.text.trim();
    if (!value) {
      this.patch({ error: 'This field is required.' });
      return;
    }
    if (!overlay.step) {
      try {
        parsePR(value);
      } catch (error) {
        this.patch({ error: oneLine((error as Error).message) });
        return;
      }
    }
    if (overlay.step === 1 && !value.startsWith('/')) {
      this.patch({ error: 'Use an absolute repository path on the service host.' });
      return;
    }
    const fields = [...(overlay.fields ?? []), value];
    if ((overlay.step ?? 0) < 2)
      this.patch({
        overlay: { ...overlay, editor: emptyEditor(), step: (overlay.step ?? 0) + 1, fields },
        error: undefined,
      });
    else
      await this.mutate('attach', { url: fields[0], repoPath: fields[1], requirements: fields[2] });
  }
  async changeLanguage(locale: Locale) {
    const value = await this.request<Preferences>('/preferences', { locale });
    this.localeOverride = undefined;
    this.patch({ preferences: value, locale: value.locale, notice: 'Language saved.' });
  }
  async execute(text: string): Promise<'exit' | undefined> {
    const [name, ...args] = text.trim().split(/\s+/);
    if (name === '/quit' || name === '/exit') return 'exit';
    this.setEditor(emptyEditor());
    this.patch({ error: undefined, notice: undefined, menuHidden: true });
    if (
      args.length >
      ([
        '/use',
        '/role',
        '/new',
        '/child',
        '/concurrency',
        '/link',
        '/language',
        '/updates',
        '/models',
        '/defaults',
      ].includes(name)
        ? 1
        : 0)
    ) {
      this.patch({
        error: `${name} acts on the selected task. Use /use to choose another task first.`,
      });
      return;
    }
    if (name === '/language' && args[0]) {
      if (!['en', 'ru'].includes(args[0])) {
        this.patch({ error: 'Choose /language en or /language ru.' });
        return;
      }
      try {
        await this.changeLanguage(args[0] as Locale);
      } catch (error) {
        this.patch({ error: oneLine((error as Error).message) });
      }
    } else if (
      [
        '/new',
        '/child',
        '/models',
        '/defaults',
        '/notifications',
        '/language',
        '/updates',
      ].includes(name)
    )
      await openPlanning(this, name, args[0]);
    else if (name === '/concurrency') {
      const count = Number(args[0]);
      if (!Number.isInteger(count) || count < 1 || count > 8)
        this.patch({ error: 'Use /concurrency 1..8. Reviewers within a group stay serialized.' });
      else {
        try {
          await this.request('/agents/concurrency', { maxConcurrentAgents: count });
          this.patch({ notice: `Concurrent agent limit: ${count}` });
        } catch (error) {
          this.patch({ error: oneLine((error as Error).message) });
        }
      }
    } else if (name === '/link') {
      if (!this.state.selectedId || !args[0])
        this.patch({ error: 'Select a ticket and use /link <PR URL>' });
      else {
        try {
          await this.request(`/tasks/${this.state.selectedId}/link-pr`, { url: args[0] });
          void this.refresh();
        } catch (error) {
          this.patch({ error: oneLine((error as Error).message) });
        }
      }
    } else if (name === '/tasks' || (name === '/use' && !args.length)) this.open('tasks');
    else if (name === '/use') this.select(args[0]);
    else if (name === '/role') {
      if (!args.length) this.setRole(this.state.role === 'author' ? 'reviewer' : 'author');
      else if (args[0] === 'author' || args[0] === 'reviewer') this.setRole(args[0]);
      else this.patch({ error: 'Choose /role author or /role reviewer.' });
    } else if (name === '/author' || name === '/reviewer') this.setRole(name.slice(1) as Role);
    else if (name === '/help' || name === '/attach') this.open(name.slice(1) as 'help' | 'attach');
    else if (['/chat', '/findings', '/context', '/logs', '/group'].includes(name))
      this.patch({ view: name === '/logs' ? 'activity' : (name.slice(1) as View), scroll: 0 });
    else if (name === '/status' || name === '/refresh') {
      void this.refresh();
      this.patch({ notice: this.state.detail?.task.reason ?? 'Refreshing connection…' });
    } else if (
      ['/publish', '/pause', '/resume', '/retry', '/demo', '/implement', '/submit'].includes(name)
    )
      await this.mutate(name.slice(1));
    else this.patch({ error: `Unknown command: ${oneLine(name)}. Use /help.` });
  }
}
