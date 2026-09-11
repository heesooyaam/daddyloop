import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { CodexCatalogue } from '../modules/agents/codex/models.js';
import type { ModelOption } from './agents.js';
import { AppError, now } from './types.js';
import { redact } from './security.js';
import type { Store } from './store.js';
import { executablePath, isNewerVersion, versionNumber } from '../runtime/executable.js';
import { command } from '../ops/process.js';
import {
  installCodexPackage,
  latestCodexPackage,
  type CodexPackage,
} from '../ops/codex-package.js';

interface Installation {
  executable: string;
  version: string;
}
const sameInstallation = (a: Installation, b: Installation) =>
  a.executable === b.executable && a.version === b.version;
export interface CodexUpdatePlan {
  id: string;
  action: 'install' | 'rollback';
  from: Installation;
  target: { version: string; executable?: string };
  artifact?: CodexPackage;
  expiresAt: string;
}
export interface CodexUpdateOperation {
  id: string;
  action: CodexUpdatePlan['action'];
  phase: 'installing' | 'validating' | 'activating' | 'complete' | 'failed';
  from: Installation;
  target: CodexUpdatePlan['target'];
  startedAt: string;
  finishedAt?: string;
  error?: string;
}
export interface CodexUpdaterStatus {
  enabled: boolean;
  busy: boolean;
  rollback?: string;
  operation?: CodexUpdateOperation;
}
export class CodexUpdater {
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
      latest?: typeof latestCodexPackage;
      install?: typeof installCodexPackage;
      probe?: (executable: string, signal: AbortSignal) => Promise<Installation>;
      validate?: (
        executable: string,
        signal: AbortSignal,
      ) => Promise<{ version?: string; models: ModelOption[] }>;
    },
  ) {}
  status(): CodexUpdaterStatus {
    const rollback = this.store.setting<{ from: Installation; current: Installation }>(
      'codex.rollback',
    );
    return {
      enabled: this.options.enabled !== false,
      busy: !!this.pending || this.preparing,
      rollback:
        rollback?.current.executable === this.options.executable()
          ? rollback.from.version
          : undefined,
      operation: this.store.setting<CodexUpdateOperation>('codex.update.operation'),
    };
  }
  private available() {
    if (this.stopped || this.options.enabled === false)
      throw new AppError(
        'updater_disabled',
        'Codex updates are disabled by the service environment',
        422,
      );
    if (this.pending || this.preparing)
      throw new AppError('updater_busy', 'A Codex update is already in progress', 409);
  }
  private async probe(executable: string) {
    if (this.options.probe) return this.options.probe(executable, this.controller.signal);
    if (!executablePath(executable))
      throw new Error('The selected Codex executable is unavailable');
    const result = await command(executable, ['--version'], {
      timeoutMs: 10000,
      maxBytes: 8000,
      signal: this.controller.signal,
    });
    const version = versionNumber(result.stdout);
    if (!version) throw new Error('Codex did not report a recognizable version');
    return { executable, version };
  }
  async prepare(action: CodexUpdatePlan['action'], audience: string): Promise<CodexUpdatePlan> {
    this.available();
    this.preparing = true;
    try {
      const from = await this.probe(this.options.executable());
      let artifact: CodexPackage | undefined, target: CodexUpdatePlan['target'];
      if (action === 'install') {
        artifact = await (this.options.latest ?? latestCodexPackage)(this.controller.signal);
        if (!isNewerVersion(artifact.version, from.version))
          throw new AppError('codex_current', 'Codex is already up to date', 422);
        target = { version: artifact.version };
      } else {
        const rollback = this.store.setting<{ from: Installation; current: Installation }>(
          'codex.rollback',
        );
        if (!rollback || !sameInstallation(rollback.current, from))
          throw new AppError(
            'rollback_unavailable',
            'No matching previous Codex version is available',
            422,
          );
        target = rollback.from;
      }
      const plan: CodexUpdatePlan = {
        id: randomBytes(18).toString('base64url'),
        action,
        from,
        target,
        artifact,
        expiresAt: new Date(Date.now() + 10 * 60000).toISOString(),
      };
      this.controller.signal.throwIfAborted();
      this.store.setSetting('codex.update.plan', { ...plan, audience });
      return plan;
    } finally {
      this.preparing = false;
    }
  }
  confirm(id: string, audience: string): CodexUpdateOperation {
    this.available();
    const plan = this.store.setting<CodexUpdatePlan & { audience: string }>('codex.update.plan');
    if (
      !plan ||
      plan.id !== id ||
      plan.audience !== audience ||
      plan.expiresAt <= now() ||
      plan.from.executable !== this.options.executable()
    )
      throw new AppError(
        'update_confirmation_expired',
        'This Codex confirmation expired or was already used. Open Updates again.',
        409,
      );
    const operation: CodexUpdateOperation = {
      id: randomUUID(),
      action: plan.action,
      from: plan.from,
      target: plan.target,
      phase: 'installing',
      startedAt: now(),
    };
    this.store.transaction(() => {
      this.store.setSetting('codex.update.plan', null);
      this.store.setSetting('codex.update.operation', operation);
    });
    this.pending = this.apply(plan, operation).finally(() => {
      this.pending = undefined;
    });
    return operation;
  }
  private directory(id: string) {
    return join(this.options.dataDir, 'runtimes', 'codex', id);
  }
  private save(operation: CodexUpdateOperation) {
    this.store.setSetting('codex.update.operation', operation);
  }
  private complete(operation: CodexUpdateOperation) {
    this.store.transaction(() => {
      this.store.setSetting('codex.rollback', { from: operation.from, current: operation.target });
      this.save({ ...operation, phase: 'complete', finishedAt: now() });
    });
  }
  private async apply(plan: CodexUpdatePlan, operation: CodexUpdateOperation) {
    let activated = false;
    try {
      this.options.resourceCheck();
      let executable = plan.target.executable;
      if (plan.action === 'install')
        executable = await (this.options.install ?? installCodexPackage)(
          plan.artifact!,
          this.directory(operation.id),
          this.controller.signal,
          this.options.resourceCheck,
        );
      if (!executable) throw new Error('The target Codex executable is unavailable');
      operation.target = { executable, version: plan.target.version };
      operation.phase = 'validating';
      this.save(operation);
      const probe = await this.probe(executable);
      if (probe.version !== plan.target.version)
        throw new Error('The downloaded Codex version does not match the confirmation');
      const validation = this.options.validate
        ? await this.options.validate(executable, this.controller.signal)
        : await this.validate(executable);
      if (validation.version !== plan.target.version || !validation.models.length)
        throw new Error('Codex app-server validation failed');
      const current = await this.probe(this.options.executable());
      if (!sameInstallation(current, plan.from))
        throw new Error('The selected Codex changed during the update; open Updates again');
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
  private async validate(executable: string) {
    const catalogue = new CodexCatalogue(executable);
    const models = await catalogue.list(true, this.controller.signal);
    return { models, version: catalogue.metadata().cliVersion };
  }
  private async cleanup(operation: CodexUpdateOperation) {
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
        error: 'Codex update interrupted. The selected CLI was preserved; open Updates to retry.',
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
