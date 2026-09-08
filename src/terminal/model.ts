import type { Task, Message, Event, Job, Decision, ResourceStatus, Role } from '../core/types.js';
import type { Editor } from './editor.js';
import { emptyEditor, insert } from './editor.js';
import { oneLine, graphemes } from './text.js';
import { parsePR } from '../providers/provider.js';
export type Api = <T>(path: string, body?: unknown, signal?: AbortSignal) => Promise<T>;
export interface Detail {
  task: Task;
  messages: Message[];
  events: Event[];
  jobs: Job[];
  decisions: Decision[];
}
export interface Status {
  version: string;
  resources: ResourceStatus;
  activeJobs: number;
  publicOrigin: string | null;
  demoEnabled: boolean;
}
export type View = 'chat' | 'findings' | 'activity' | 'context';
export interface Overlay {
  kind: 'tasks' | 'help' | 'attach';
  editor: Editor;
  index: number;
  step?: number;
  fields?: string[];
}
export interface ConsoleState {
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
}
export const commands = [
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
  constructor(
    private api: Api,
    initial?: { id?: string; role?: Role },
  ) {
    this.initialId = initial?.id;
    this.state = {
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
  async execute(text: string): Promise<'exit' | undefined> {
    const [name, ...args] = text.trim().split(/\s+/);
    if (name === '/quit' || name === '/exit') return 'exit';
    this.setEditor(emptyEditor());
    this.patch({ error: undefined, notice: undefined, menuHidden: true });
    if (args.length > (['/use', '/role'].includes(name) ? 1 : 0)) {
      this.patch({
        error: `${name} acts on the selected task. Use /use to choose another task first.`,
      });
      return;
    }
    if (name === '/tasks' || (name === '/use' && !args.length)) this.open('tasks');
    else if (name === '/use') this.select(args[0]);
    else if (name === '/role') {
      if (!args.length) this.setRole(this.state.role === 'author' ? 'reviewer' : 'author');
      else if (args[0] === 'author' || args[0] === 'reviewer') this.setRole(args[0]);
      else this.patch({ error: 'Choose /role author or /role reviewer.' });
    } else if (name === '/author' || name === '/reviewer') this.setRole(name.slice(1) as Role);
    else if (name === '/help' || name === '/attach') this.open(name.slice(1) as 'help' | 'attach');
    else if (['/chat', '/findings', '/context', '/logs'].includes(name))
      this.patch({ view: name === '/logs' ? 'activity' : (name.slice(1) as View), scroll: 0 });
    else if (name === '/status' || name === '/refresh') {
      void this.refresh();
      this.patch({ notice: this.state.detail?.task.reason ?? 'Refreshing connection…' });
    } else if (['/publish', '/pause', '/resume', '/retry', '/demo'].includes(name))
      await this.mutate(name.slice(1));
    else this.patch({ error: `Unknown command: ${oneLine(name)}. Use /help.` });
  }
}
