import type { Daddy } from '../core/daddy.js';
import type { Workspace, ReviewGroup, ResourceStatus } from '../core/types.js';
import type { Preferences } from '../core/preferences.js';
import type { RepositorySelection } from '../core/workspace-registry.js';
import type { ResetPlan, UsageView } from '../core/usage.js';
import type { SessionInstructions } from '../core/instructions.js';
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
  usageError?: string;
  drafts: Record<string, string>;
  overrides: Record<string, RepositorySelection | undefined>;
  connected: boolean;
  busy: boolean;
  error?: string;
  unavailableSession?: string;
}

function resolveSessionId(sessions: DaddySession[], reference: string) {
  if (!reference) return undefined;
  const exact = sessions.find(({ id }) => id === reference);
  if (exact) return exact.id;
  const matches = sessions.filter(({ id }) => id.startsWith(reference));
  return matches.length === 1 ? matches[0].id : undefined;
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
  private refreshGeneration = 0;
  private usagePending?: Promise<void>;
  private usageReset?: Promise<ResetPlan>;
  private usageGeneration = 0;
  private sequence = 0;
  private messageRequests = new Map<string, { text: string; key: string; id: string }>();
  private creation?: { key: string; id: string };
  private readonly createdSessionIds = new Set<string>();
  private explicitSelection: boolean;
  constructor(
    readonly api: DaddyApi,
    selected = '',
  ) {
    this.value.selected = selected;
    this.explicitSelection = !!selected;
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
    this.usageGeneration++;
    this.stopped = false;
    this.controller = new AbortController();
    this.refreshPending = undefined;
    this.usagePending = undefined;
    this.usageReset = undefined;
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
  async select(id: string, explicit = false) {
    this.explicitSelection = explicit;
    this.sequence++;
    this.update({
      selected: id,
      board: undefined,
      error: undefined,
      unavailableSession: undefined,
    });
    await this.detail();
  }
  selectFromReference(reference: string) {
    if (!reference) return;
    const id = this.createdSessionIds.has(reference)
      ? reference
      : (resolveSessionId(this.value.sessions, reference) ?? reference);
    this.explicitSelection = true;
    if (id === this.value.selected) return;
    this.sequence++;
    this.update({
      selected: id,
      board: undefined,
      error: undefined,
      unavailableSession: undefined,
    });
    if (/^[a-f0-9-]{36}$/.test(id)) void this.detail();
    else void this.refresh();
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
        this.update({ board, connected: true, unavailableSession: undefined });
    } catch (error) {
      if (this.value.selected === id && sequence === this.sequence && !this.stopped) {
        if (
          this.explicitSelection &&
          error instanceof Error &&
          'status' in error &&
          error.status === 404
        ) {
          this.update({ board: undefined, unavailableSession: id, error: undefined });
        } else {
          this.update({ error: (error as Error).message, connected: false });
        }
      }
    }
  }
  refresh(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    void this.refreshUsage();
    if (this.refreshPending) return this.refreshPending;
    const generation = ++this.refreshGeneration;
    const current = () => !this.stopped && generation === this.refreshGeneration;
    this.refreshPending = (async () => {
      try {
        const [sessions, workspaces, status] = await Promise.all([
          this.api<DaddySession[]>('/daddy/sessions', undefined, this.controller.signal),
          this.api<Workspace[]>('/workspaces', undefined, this.controller.signal),
          this.api<DaddyStatus>('/status', undefined, this.controller.signal),
        ]);
        if (!current()) return;
        this.createdSessionIds.clear();
        const resolved = resolveSessionId(sessions, this.value.selected);
        const unavailableSession =
          this.explicitSelection && !resolved ? this.value.selected : undefined;
        const selected = resolved ?? unavailableSession ?? sessions[0]?.id ?? '';
        if (unavailableSession || selected !== this.value.selected) this.sequence++;
        this.update({
          sessions,
          workspaces,
          status,
          selected,
          unavailableSession,
          connected: true,
          ...(unavailableSession || selected !== this.value.selected ? { board: undefined } : {}),
        });
        if (!unavailableSession) await this.detail();
      } catch (error) {
        if (current()) this.update({ error: (error as Error).message, connected: false });
      }
    })().finally(() => {
      if (generation === this.refreshGeneration) this.refreshPending = undefined;
    });
    return this.refreshPending;
  }
  private beginUsageRequest() {
    const generation = ++this.usageGeneration;
    return () => !this.stopped && generation === this.usageGeneration;
  }
  refreshUsage = (force = false): Promise<void> => {
    if (this.stopped) return Promise.resolve();
    if (this.usageReset)
      return force
        ? this.usageReset.catch(() => {}).then(() => this.refreshUsage(true))
        : Promise.resolve();
    if (!force && this.usagePending) return this.usagePending;
    const current = this.beginUsageRequest();
    const pending = this.api<UsageView>(
      force ? '/usage?refresh=1' : '/usage',
      undefined,
      this.controller.signal,
    )
      .then((usage) => {
        if (current()) this.update({ usage, usageError: undefined });
      })
      .catch((error: Error) => {
        if (current()) {
          const previous = this.value.usage;
          this.update({
            usageError: error.message,
            ...(previous && {
              usage: { agents: previous.agents.map((agent) => ({ ...agent, stale: true })) },
            }),
          });
        }
      })
      .finally(() => {
        if (this.usagePending === pending) this.usagePending = undefined;
      });
    this.usagePending = pending;
    return pending;
  };
  consumeUsageReset = async (id: string): Promise<ResetPlan> => {
    if (this.usageReset) throw new Error('A rate-limit reset is already running.');
    const current = this.beginUsageRequest();
    this.usagePending = undefined;
    const pending = this.api<{ usage: UsageView; plan: ResetPlan }>(
      `/usage/reset/${id}`,
      { confirmed: true },
      this.controller.signal,
    )
      .then(({ usage, plan }) => {
        if (current()) this.update({ usage, usageError: undefined });
        return plan;
      })
      .finally(() => {
        if (this.usageReset === pending) this.usageReset = undefined;
      });
    this.usageReset = pending;
    return pending;
  };
  async create(
    workspaceId: string,
    message?: string,
    title?: string,
    repository?: RepositorySelection,
    instructions?: SessionInstructions,
    options: { onCreated?: () => void; selectOnSuccess?: () => boolean } = {},
  ) {
    if (this.value.busy) return;
    const input = {
        workspaceId,
        ...(repository ? { repository } : {}),
        ...(instructions ? { instructions } : {}),
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
      this.createdSessionIds.add(board.group.id);
      // A session list requested before creation may omit the new session.
      this.refreshGeneration++;
      this.refreshPending = undefined;
      options.onCreated?.();
      if (options.selectOnSuccess?.() ?? true) await this.select(board.group.id, true);
      await this.refresh();
      return board.group.id;
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
    if (!id || !text || this.value.busy || this.value.unavailableSession) return;
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
  async action(
    action: 'pause' | 'resume' | 'settings' | 'delete' | 'rename',
    body: unknown = {},
    id = this.value.selected,
  ) {
    if (!id || id !== this.value.selected || this.value.busy) return;
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
