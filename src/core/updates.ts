import { command } from '../ops/process.js';
import {
  bundledRoot,
  executablePath,
  isNewerVersion,
  versionNumber,
} from '../runtime/executable.js';
import { redact } from './security.js';
import type { Store } from './store.js';

export interface ToolVersion {
  id: 'codex' | 'claude';
  name: string;
  supported: boolean;
  executable?: string;
  source: 'bundled' | 'external' | 'missing';
  installed?: string;
  latest?: string;
  updateAvailable: boolean;
  changedFrom?: string;
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
const tools = [
  {
    id: 'codex' as const,
    name: 'Codex CLI',
    package: '@openai/codex',
    supported: true,
    releaseUrl: 'https://github.com/openai/codex/releases',
  },
  {
    id: 'claude' as const,
    name: 'Claude Code',
    package: '@anthropic-ai/claude-code',
    supported: false,
    releaseUrl: 'https://code.claude.com/docs/en/changelog',
  },
];
export class UpdateMonitor {
  private pending?: Promise<UpdateStatus>;
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private controller = new AbortController();
  constructor(
    private store: Store,
    private options: {
      codex?: string;
      claude?: string;
      intervalHours?: number;
      fetcher?: typeof fetch;
      probe?: (command: string) => Promise<{
        path?: string;
        version?: string;
        source: ToolVersion['source'];
        error?: string;
      }>;
    } = {},
  ) {}
  status(): UpdateStatus {
    return {
      ...(this.store.setting<UpdateStatus>('updates.status') ?? { tools: [] }),
      intervalHours: this.options.intervalHours ?? 6,
      checking: !!this.pending,
      notifications: this.store.setting<boolean>('updates.notifications') ?? true,
    };
  }
  start() {
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
      !force &&
      status.checkedAt &&
      Date.now() - Date.parse(status.checkedAt) < status.intervalHours * 3600000
    )
      return Promise.resolve(status);
    this.pending = this.load().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }
  private async probe(executable: string) {
    if (this.options.probe) return this.options.probe(executable);
    const path = executablePath(executable),
      root = bundledRoot();
    if (!path) return { source: 'missing' as const };
    const source =
      root && path.startsWith(root + '/') ? ('bundled' as const) : ('external' as const);
    try {
      const result = await command(path, ['--version'], {
        timeoutMs: 10000,
        maxBytes: 8000,
        signal: this.controller.signal,
      });
      const version = versionNumber(result.stdout);
      return {
        path,
        source,
        version,
        ...(!version ? { error: 'CLI did not report a recognizable version' } : {}),
      };
    } catch (error) {
      return { path, source, error: redact(String(error)) };
    }
  }
  private async load(): Promise<UpdateStatus> {
    const previous = this.status(),
      checkedAt = new Date().toISOString();
    const entries = await Promise.all(
      tools.map(async (tool) => {
        const local = await this.probe(this.options[tool.id] ?? tool.id);
        const result: ToolVersion = {
          id: tool.id,
          name: tool.name,
          supported: tool.supported,
          source: local.source,
          executable: local.path,
          installed: local.version,
          error: local.error,
          updateAvailable: false,
          releaseUrl: tool.releaseUrl,
        };
        if (!local.version || this.stopped) return result;
        const before = previous.tools.find((item) => item.id === tool.id)?.installed;
        if (before && before !== local.version) result.changedFrom = before;
        try {
          const response = await (this.options.fetcher ?? fetch)(
            `https://registry.npmjs.org/${encodeURIComponent(tool.package)}/latest`,
            {
              redirect: 'error',
              headers: { Accept: 'application/json' },
              signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(15000)]),
            },
          );
          if (!response.ok) throw new Error(`Version registry returned HTTP ${response.status}`);
          const value = (await response.json()) as { version?: string };
          if (!value.version || !/^\d+\.\d+\.\d+$/.test(value.version))
            throw new Error('Version registry returned an invalid stable version');
          result.latest = value.version;
          result.updateAvailable = isNewerVersion(value.version, local.version);
        } catch (error) {
          result.error = redact(String(error));
        }
        return result;
      }),
    );
    const result: UpdateStatus = {
      checkedAt,
      intervalHours: previous.intervalHours,
      notifications: previous.notifications,
      tools: entries,
    };
    if (!this.stopped) {
      this.store.setSetting('updates.status', result);
      for (const tool of entries) {
        // Unsupported engines are visible for clarity but do not send irrelevant alerts.
        if (!tool.supported) continue;
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
