import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import type { ModelOption } from './agents.js';
import { AppError, now } from './types.js';
import { redact } from './security.js';
import type { Store } from './store.js';
import { executablePath, isNewerVersion } from '../runtime/executable.js';
import type {
  AgentInstallation as Installation,
  AgentPackage,
  AgentCli,
} from '../modules/contracts.js';

const sameInstallation = (a: Installation, b: Installation) =>
  a.executable === b.executable && a.version === b.version;
export interface RuntimeUpdatePlan {
  id: string;
  engine: string;
  name: string;
  action: 'install' | 'rollback';
  from: Installation;
  target: { version: string; executable?: string };
  artifact?: AgentPackage;
  expiresAt: string;
}
export interface RuntimeUpdateOperation {
  id: string;
  engine: string;
  name: string;
  action: RuntimeUpdatePlan['action'];
  phase: 'installing' | 'validating' | 'activating' | 'complete' | 'failed';
  from: Installation;
  target: RuntimeUpdatePlan['target'];
  startedAt: string;
  finishedAt?: string;
  error?: string;
}
export interface RuntimeUpdaterStatus {
  engine: string;
  name: string;
  reason?: string;
  enabled: boolean;
  busy: boolean;
  rollback?: string;
  operation?: RuntimeUpdateOperation;
}
export class RuntimeUpdater {
  private pending?: Promise<void>;
  private preparing = false;
  private stopped = false;
  private controller = new AbortController();
  constructor(
    private store: Store,
    private options: {
      dataDir: string;
      executable: () => string;
      activate: (expected: string, next: string) => void;
      resourceCheck: () => void;
      enabled?: boolean;
      validateModels?: (models: ModelOption[]) => void;
      engine: string;
      cli: AgentCli;
      disabledReason?: string;
    },
  ) {
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(options.engine)) throw new Error('Invalid agent module ID');
  }
  private key(suffix: string) {
    return `runtime.${this.options.engine}.${suffix}`;
  }
  status(): RuntimeUpdaterStatus {
    const rollback = this.store.setting<{ from: Installation; current: Installation }>(
      this.key('rollback'),
    );
    return {
      engine: this.options.engine,
      name: this.options.cli.name,
      enabled:
        this.options.enabled !== false &&
        !!this.options.cli.updates &&
        !this.options.cli.updates.unavailableReason,
      reason:
        this.options.disabledReason ??
        this.options.cli.updates?.unavailableReason ??
        (!this.options.cli.updates
          ? 'Managed updates are not provided by this adapter'
          : undefined),
      busy: !!this.pending || this.preparing,
      rollback:
        rollback?.current.executable === this.options.executable()
          ? rollback.from.version
          : undefined,
      operation: this.store.setting<RuntimeUpdateOperation>(this.key('update.operation')),
    };
  }
  private available() {
    if (this.stopped || !this.status().enabled)
      throw new AppError(
        'updater_disabled',
        this.status().reason ?? 'Agent CLI updates are disabled',
        422,
      );
    if (this.pending || this.preparing)
      throw new AppError(
        'updater_busy',
        `A ${this.options.cli.name} update is already in progress`,
        409,
      );
  }
  private async probe(executable: string) {
    return this.options.cli.probe(executable, this.controller.signal);
  }
  async prepare(action: RuntimeUpdatePlan['action'], audience: string): Promise<RuntimeUpdatePlan> {
    this.available();
    this.preparing = true;
    try {
      const from = await this.probe(this.options.executable());
      let artifact: AgentPackage | undefined, target: RuntimeUpdatePlan['target'];
      if (action === 'install') {
        artifact = await this.options.cli.updates!.latest(this.controller.signal);
        if (!isNewerVersion(artifact.version, from.version))
          throw new AppError('runtime_current', 'agent CLI is already up to date', 422);
        target = { version: artifact.version };
      } else {
        const rollback = this.store.setting<{ from: Installation; current: Installation }>(
          this.key('rollback'),
        );
        if (!rollback || !sameInstallation(rollback.current, from))
          throw new AppError(
            'rollback_unavailable',
            'No matching previous agent CLI version is available',
            422,
          );
        target = rollback.from;
      }
      const plan: RuntimeUpdatePlan = {
        engine: this.options.engine,
        name: this.options.cli.name,
        id: randomBytes(18).toString('base64url'),
        action,
        from,
        target,
        artifact,
        expiresAt: new Date(Date.now() + 10 * 60000).toISOString(),
      };
      this.controller.signal.throwIfAborted();
      this.store.setSetting(this.key('update.plan'), { ...plan, audience });
      return plan;
    } finally {
      this.preparing = false;
    }
  }
  confirm(id: string, audience: string): RuntimeUpdateOperation {
    this.available();
    const plan = this.store.setting<RuntimeUpdatePlan & { audience: string }>(
      this.key('update.plan'),
    );
    if (
      !plan ||
      plan.id !== id ||
      plan.audience !== audience ||
      plan.expiresAt <= now() ||
      plan.from.executable !== this.options.executable()
    )
      throw new AppError(
        'update_confirmation_expired',
        'This agent CLI confirmation expired or was already used. Open Updates again.',
        409,
      );
    const operation: RuntimeUpdateOperation = {
      engine: this.options.engine,
      name: this.options.cli.name,
      id: randomUUID(),
      action: plan.action,
      from: plan.from,
      target: plan.target,
      phase: 'installing',
      startedAt: now(),
    };
    this.store.transaction(() => {
      this.store.setSetting(this.key('update.plan'), null);
      this.store.setSetting(this.key('update.operation'), operation);
    });
    this.pending = this.apply(plan, operation).finally(() => {
      this.pending = undefined;
    });
    return operation;
  }
  private directory(id: string) {
    return join(this.options.dataDir, 'runtimes', this.options.engine, id);
  }
  private save(operation: RuntimeUpdateOperation) {
    this.store.setSetting(this.key('update.operation'), operation);
  }
  private complete(operation: RuntimeUpdateOperation) {
    this.store.transaction(() => {
      this.store.setSetting(this.key('rollback'), {
        from: operation.from,
        current: operation.target,
      });
      this.save({ ...operation, phase: 'complete', finishedAt: now() });
    });
  }
  private async apply(plan: RuntimeUpdatePlan, operation: RuntimeUpdateOperation) {
    let activated = false;
    try {
      this.options.resourceCheck();
      let executable = plan.target.executable;
      if (plan.action === 'install')
        executable = await this.options.cli.updates!.install(
          plan.artifact!,
          this.directory(operation.id),
          this.controller.signal,
          this.options.resourceCheck,
        );
      if (!executable) throw new Error('The target agent CLI executable is unavailable');
      operation.target = { executable, version: plan.target.version };
      operation.phase = 'validating';
      this.save(operation);
      const probe = await this.probe(executable);
      if (probe.version !== plan.target.version)
        throw new Error('The downloaded agent CLI version does not match the confirmation');
      const validation = await this.options.cli.validate(executable, this.controller.signal);
      if (validation.version !== plan.target.version || !validation.models.length)
        throw new Error('Agent CLI catalogue validation failed');
      const current = await this.probe(this.options.executable());
      if (!sameInstallation(current, plan.from))
        throw new Error('The selected agent CLI changed during the update; open Updates again');
      this.options.resourceCheck();
      this.controller.signal.throwIfAborted();
      this.options.validateModels?.(validation.models);
      operation.phase = 'activating';
      this.save(operation);
      // Atomic config rename and in-process selection are synchronous; new turns capture
      // this path once. Existing app-server processes keep their original executable.
      this.options.activate(plan.from.executable, executable);
      activated = true;
      this.complete(operation);
    } catch (error) {
      if (activated) this.complete(operation);
      else {
        this.save({
          ...operation,
          phase: 'failed',
          finishedAt: now(),
          error: redact(String(error)),
        });
        await this.cleanup(operation);
      }
    } finally {
      this.store.event('_system', 'runtime.update_finished', this.status().operation);
    }
  }
  private async cleanup(operation: RuntimeUpdateOperation) {
    if (operation.action !== 'install') return;
    const directory = this.directory(operation.id),
      selected = this.options.executable();
    // Also protect a candidate selected by a concurrent host-side configuration edit.
    if (
      selected.startsWith(directory + '/') ||
      executablePath(selected)?.startsWith(directory + '/')
    )
      return;
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
  async recover() {
    const operation = this.status().operation;
    if (!operation || ['complete', 'failed'].includes(operation.phase)) return;
    if (
      operation.phase === 'activating' &&
      operation.target.executable === this.options.executable()
    )
      this.complete(operation);
    else {
      this.save({
        ...operation,
        phase: 'failed',
        finishedAt: now(),
        error:
          'agent CLI update interrupted. The selected CLI was preserved; open Updates to retry.',
      });
      await this.cleanup(operation);
    }
  }
  async stop() {
    this.stopped = true;
    this.controller.abort();
    await this.pending;
  }
}

/** One isolated operation ledger per registered engine. */
export class RuntimeUpdaters {
  private items: Map<string, RuntimeUpdater>;
  constructor(items: RuntimeUpdater[]) {
    this.items = new Map(items.map((item) => [item.status().engine, item]));
    if (this.items.size !== items.length) throw new Error('Duplicate runtime updater');
  }
  get(engine: string) {
    const updater = this.items.get(engine);
    if (!updater)
      throw new AppError('updater_unavailable', `No CLI updater for agent ${engine}`, 422);
    return updater;
  }
  status() {
    return [...this.items.values()].map((item) => item.status());
  }
  async recover() {
    for (const item of this.items.values()) await item.recover();
  }
  async stop() {
    await Promise.all([...this.items.values()].map((item) => item.stop()));
  }
}
