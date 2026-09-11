import type { Daddy } from '../core/daddy.js';
import type { Workspace, ReviewGroup, ResourceStatus } from '../core/types.js';
import type { Preferences } from '../core/preferences.js';
import type { RepositorySelection } from '../core/workspace-registry.js';
import type { UsageView } from '../core/usage.js';
export type DaddyBoard = ReturnType<Daddy['board']>;
export type DaddySession = ReviewGroup & {
  workspace?: Workspace;
  workers: DaddyBoard['workers'];
  daddyBusy: boolean;
  total: number;
  complete: number;
};
export type DaddyApi = <T>(path: string, body?: unknown, signal?: AbortSignal) => Promise<T>;
export interface DaddyStatus {
  version: string;
  preferences: Preferences;
  resources: ResourceStatus;
  telegram: { paired?: boolean; bot?: string; group?: { title: string; chatId: number } };
  publicOrigin?: string;
}
export interface DaddyClientState {
  sessions: DaddySession[];
  workspaces: Workspace[];
  selected: string;
  board?: DaddyBoard;
  status?: DaddyStatus;
  usage?: UsageView;
  drafts: Record<string, string>;
  overrides: Record<string, RepositorySelection | undefined>;
  connected: boolean;
  busy: boolean;
  error?: string;
}
export class DaddyClient {
  private value: DaddyClientState = {
    sessions: [],
    workspaces: [],
    selected: '',
    drafts: {},
    overrides: {},
    connected: false,
    busy: false,
  };
  private listeners = new Set<() => void>();
  private stopped = false;
  private timer?: ReturnType<typeof setInterval>;
  private controller = new AbortController();
  private refreshPending?: Promise<void>;
  private usagePending?: Promise<void>;
  private sequence = 0;
  private epoch = 0;
  private messageRequests = new Map<string, { text: string; key: string; id: string }>();
  private creation?: { key: string; id: string };
  constructor(
    readonly api: DaddyApi,
    selected = '',
  ) {
    this.value.selected = selected;
  }
  snapshot = () => this.value;
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  private update(patch: Partial<DaddyClientState>) {
    if (this.stopped) return;
    this.value = { ...this.value, ...patch };
    for (const fn of this.listeners) fn();
  }
  start() {
    this.epoch++;
    this.stopped = false;
    this.controller = new AbortController();
    this.refreshPending = undefined;
    this.usagePending = undefined;
    void this.refresh();
    this.timer = setInterval(() => {
      void this.refresh();
    }, 2000);
  }
  stop() {
    this.stopped = true;
    clearInterval(this.timer);
    this.controller.abort();
    this.sequence++;
  }
  setUsage = (usage: UsageView) => this.update({ usage });
  draft(text: string) {
    if (this.value.selected)
      this.update({ drafts: { ...this.value.drafts, [this.value.selected]: text } });
  }
  repository(value?: RepositorySelection) {
    this.update({ overrides: { ...this.value.overrides, [this.value.selected]: value } });
  }
  error(message: string) {
    this.update({ error: message });
  }
  async select(id: string) {
    this.sequence++;
    this.update({ selected: id, board: undefined, error: undefined });
    await this.detail();
  }
  private async detail() {
    const id = this.value.selected,
      sequence = ++this.sequence;
    if (!id) return;
    try {
      const board = await this.api<DaddyBoard>(
        `/daddy/sessions/${encodeURIComponent(id)}`,
        undefined,
        this.controller.signal,
      );
      if (this.value.selected === id && sequence === this.sequence)
        this.update({ board, connected: true });
    } catch (error) {
      if (this.value.selected === id && sequence === this.sequence && !this.stopped)
        this.update({ error: (error as Error).message, connected: false });
    }
  }
  refresh(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.refreshPending) return this.refreshPending;
    this.refreshUsage();
    const epoch = this.epoch;
    this.refreshPending = (async () => {
      try {
        const [sessions, workspaces, status] = await Promise.all([
          this.api<DaddySession[]>('/daddy/sessions', undefined, this.controller.signal),
          this.api<Workspace[]>('/workspaces', undefined, this.controller.signal),
          this.api<DaddyStatus>('/status', undefined, this.controller.signal),
        ]);
        if (this.stopped || epoch !== this.epoch) return;
        let selected = this.value.selected;
        if (selected && !/^[a-f0-9-]{36}$/.test(selected))
          selected =
            sessions.filter((group) => group.id.startsWith(selected)).length === 1
              ? sessions.find((group) => group.id.startsWith(selected))!.id
              : '';
        selected ||= sessions[0]?.id ?? '';
        this.update({ sessions, workspaces, status, selected, connected: true });
        await this.detail();
      } catch (error) {
        if (!this.stopped && epoch === this.epoch)
          this.update({ error: (error as Error).message, connected: false });
      }
    })().finally(() => {
      if (epoch === this.epoch) this.refreshPending = undefined;
    });
    return this.refreshPending;
  }
  private refreshUsage() {
    if (this.usagePending || this.stopped) return;
    const epoch = this.epoch;
    const pending = this.api<UsageView>('/usage', undefined, this.controller.signal)
      .then((usage) => {
        if (!this.stopped && epoch === this.epoch) this.update({ usage });
      })
      .catch(() => {
        if (!this.stopped && epoch === this.epoch && this.value.usage)
          this.update({ usage: { ...this.value.usage, stale: true } });
      })
      .finally(() => {
        if (this.usagePending === pending) this.usagePending = undefined;
      });
    this.usagePending = pending;
  }
  async create(
    workspaceId: string,
    message?: string,
    title?: string,
    repository?: RepositorySelection,
  ) {
    if (this.value.busy) return;
    const input = {
        workspaceId,
        ...(repository ? { repository } : {}),
        ...(message?.trim() ? { message: message.trim() } : {}),
        ...(title?.trim() ? { title: title.trim() } : {}),
      },
      key = JSON.stringify(input);
    if (this.creation?.key !== key) this.creation = { key, id: crypto.randomUUID() };
    this.update({ busy: true, error: undefined });
    try {
      const board = await this.api<DaddyBoard>(
        '/daddy/sessions',
        { ...input, requestId: this.creation.id },
        this.controller.signal,
      );
      this.creation = undefined;
      await this.select(board.group.id);
      await this.refresh();
    } catch (error) {
      if (!this.stopped) this.update({ error: (error as Error).message });
      throw error;
    } finally {
      this.update({ busy: false });
    }
  }
  async send() {
    const id = this.value.selected,
      text = (this.value.drafts[id] ?? '').trim(),
      repository = this.value.overrides[id],
      key = JSON.stringify({ text, repository });
    if (!id || !text || this.value.busy) return;
    let request = this.messageRequests.get(id);
    if (request?.key !== key) {
      request = { text, key, id: crypto.randomUUID() };
      this.messageRequests.set(id, request);
    }
    this.update({ busy: true, error: undefined });
    try {
      await this.api(
        `/daddy/sessions/${id}/chat`,
        { text, requestId: request.id, ...(repository ? { repository } : {}) },
        this.controller.signal,
      );
      this.messageRequests.delete(id);
      const sameWorkspace = this.value.overrides[id] === repository;
      if (sameWorkspace) this.update({ overrides: { ...this.value.overrides, [id]: undefined } });
      if (sameWorkspace && (this.value.drafts[id] ?? '').trim() === text)
        this.update({ drafts: { ...this.value.drafts, [id]: '' } });
      await this.refresh();
    } catch (error) {
      if (!this.stopped) this.update({ error: (error as Error).message });
    } finally {
      this.update({ busy: false });
    }
  }
  async action(action: 'pause' | 'resume' | 'settings', body: unknown = {}) {
    const id = this.value.selected;
    if (!id || this.value.busy) return;
    this.update({ busy: true, error: undefined });
    try {
      await this.api(`/daddy/sessions/${id}/${action}`, body, this.controller.signal);
      await this.refresh();
    } catch (error) {
      if (!this.stopped) this.update({ error: (error as Error).message });
    } finally {
      this.update({ busy: false });
    }
  }
}
