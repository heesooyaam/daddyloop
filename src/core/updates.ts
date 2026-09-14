import { bundledRoot, executablePath, isNewerVersion } from '../runtime/executable.js';
import { join } from 'node:path';
import { redact } from './security.js';
import type { Store } from './store.js';
import type { RuntimeUpdateOperation } from './runtime-updater.js';
import type { AgentCli } from '../modules/contracts.js';
export interface ToolVersion {
  id: string;
  name: string;
  managedUpdates: boolean;
  executable?: string;
  source: 'bundled' | 'external' | 'managed' | 'missing';
  installed?: string;
  latest?: string;
  updateAvailable: boolean;
  changedFrom?: string;
  managedOperationId?: string;
  error?: string;
  releaseUrl: string;
}
export interface UpdateStatus {
  checkedAt?: string;
  checking?: boolean;
  intervalHours: number;
  notifications: boolean;
  tools: ToolVersion[];
}
export interface UpdateNotice {
  kind: 'available' | 'changed';
  tool: ToolVersion;
  checkedAt: string;
}
export interface MonitoredCli {
  id: string;
  cli: AgentCli;
  managedUpdates: boolean;
}
export class UpdateMonitor {
  private pending?: Promise<UpdateStatus>;
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private controller = new AbortController();
  constructor(
    private store: Store,
    private options: {
      agents: MonitoredCli[];
      dataDir?: string;
      intervalHours?: number;
    },
  ) {}
  status(): UpdateStatus {
    const saved = this.store.setting<UpdateStatus>('updates.status');
    return {
      ...saved,
      tools: this.options.agents.map(({ id, cli, managedUpdates }) => ({
        id,
        source: 'missing',
        updateAvailable: false,
        ...saved?.tools.find((tool) => tool.id === id),
        name: cli.name,
        releaseUrl: cli.releaseUrl,
        managedUpdates,
      })),
      intervalHours: this.options.intervalHours ?? 6,
      checking: !!this.pending,
      notifications: this.store.setting<boolean>('updates.notifications') ?? true,
    };
  }
  start() {
    if (this.timer || this.stopped) return;
    const check = () => {
      void this.check().catch(() => {});
    };
    this.timer = setInterval(check, 60000);
    this.timer.unref();
    check();
  }
  async stop() {
    this.stopped = true;
    clearInterval(this.timer);
    this.controller.abort();
    await this.pending?.catch(() => {});
  }
  check(force = false): Promise<UpdateStatus> {
    if (this.pending) return this.pending;
    const status = this.status();
    if (
      this.stopped ||
      (!force &&
        status.checkedAt &&
        Date.now() - Date.parse(status.checkedAt) < status.intervalHours * 3600000)
    )
      return Promise.resolve(status);
    this.pending = this.load().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }
  private selection(cli: AgentCli) {
    const selected = cli.executable();
    return { selected, path: executablePath(selected) };
  }
  private async load(): Promise<UpdateStatus> {
    const previous = this.status(),
      checkedAt = new Date().toISOString();
    const selections = this.options.agents.map(({ cli }) => this.selection(cli));
    const entries = await Promise.all(
      this.options.agents.map(async ({ id, cli, managedUpdates }, index) => {
        const { selected, path } = selections[index],
          bundle = bundledRoot();
        const result: ToolVersion = {
          id,
          name: cli.name,
          managedUpdates,
          executable: path,
          releaseUrl: cli.releaseUrl,
          source: !path
            ? 'missing'
            : this.options.dataDir &&
                path.startsWith(join(this.options.dataDir, 'runtimes', id) + '/')
              ? 'managed'
              : bundle && path.startsWith(bundle + '/')
                ? 'bundled'
                : 'external',
          updateAvailable: false,
        };
        try {
          const local = await cli.probe(selected, this.controller.signal);
          result.installed = local.version;
          const before = previous.tools.find((item) => item.id === id)?.installed;
          if (before && before !== local.version) result.changedFrom = before;
          const operation = this.store.setting<RuntimeUpdateOperation>(
            `runtime.${id}.update.operation`,
          );
          if (
            result.changedFrom &&
            operation?.engine === id &&
            operation.phase === 'complete' &&
            operation.from.version === result.changedFrom &&
            operation.target.version === local.version &&
            path &&
            executablePath(operation.target.executable ?? '') === path &&
            operation.finishedAt &&
            operation.finishedAt >= (previous.checkedAt ?? '') &&
            operation.id !== this.store.setting<string>(`updates.${id}.accountedOperation`)
          )
            result.managedOperationId = operation.id;
          result.latest = await cli.latestVersion(this.controller.signal);
          result.updateAvailable = isNewerVersion(result.latest, local.version);
        } catch (error) {
          result.error = redact(String(error));
        }
        return result;
      }),
    );
    // Every engine can change while registry requests are in flight, including launcher symlinks.
    if (
      !this.stopped &&
      this.options.agents.some(({ cli }, index) => {
        const current = this.selection(cli),
          before = selections[index];
        return current.selected !== before.selected || current.path !== before.path;
      })
    )
      return this.load();
    const result = {
      checkedAt,
      intervalHours: previous.intervalHours,
      notifications: this.status().notifications,
      tools: entries,
    };
    if (!this.stopped) {
      this.store.setSetting('updates.status', result);
      for (const tool of entries) {
        if (tool.managedOperationId)
          this.store.setSetting(`updates.${tool.id}.accountedOperation`, tool.managedOperationId);
        if (tool.updateAvailable)
          this.store.event('_system', 'runtime.update_available', {
            kind: 'available',
            tool,
            checkedAt,
          } satisfies UpdateNotice);
        if (tool.changedFrom)
          this.store.event('_system', 'runtime.version_changed', {
            kind: 'changed',
            tool,
            checkedAt,
          } satisfies UpdateNotice);
      }
    }
    return result;
  }
}
