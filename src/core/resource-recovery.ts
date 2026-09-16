import { withInstructions } from './instructions.js';
import { mkdirSync } from 'node:fs';
import type { Engine } from './engine.js';
import type { SessionRuntime, RuntimeTool } from '../runtime/agent.js';
import { AppError, now, type DaddyJob, type ResourceStatus } from './types.js';
import { redact } from './security.js';

export interface ResourceRecoveryActions {
  directory: string;
  allowCleanup: boolean;
  inspect(groupId: string): Promise<unknown>;
  clean(groupId: string, signal: AbortSignal): Promise<unknown>;
}
const tools: RuntimeTool[] = [
  {
    name: 'read_resources',
    description:
      'Read measured disk and RAM availability and the configured resource guard result.',
  },
  {
    name: 'inspect_cache',
    description:
      'List only service-owned cleanup candidates and explain why other copies are preserved.',
  },
  {
    name: 'clean_cache',
    description:
      'Clean verified disposable application caches and ask the repository module to reclaim its idle owned copies. No arbitrary paths, source checkouts, user files or destructive GC flags are accepted.',
  },
].map((tool) => ({
  ...tool,
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
}));

/** A small, separate maintenance turn can repair the condition that blocks ordinary agents. */
export class ResourceRecovery {
  constructor(
    private engine: Engine,
    private runtime: SessionRuntime,
    private status: () => ResourceStatus,
    private actions: ResourceRecoveryActions,
  ) {}
  canStart() {
    const status = this.status();
    return status.diskAvailableGiB >= 1 && status.memoryAvailableGiB >= 0.5;
  }
  async run(job: DaddyJob, signal: AbortSignal) {
    const store = this.engine.store;
    const active = () => {
      const group = store.getGroup(job.groupId);
      if (
        signal.aborted ||
        group.generation !== job.generation ||
        group.daddyState !== 'active' ||
        group.deletion
      )
        throw new AppError('stale_daddy', 'Resource recovery was cancelled');
      return group;
    };
    const seen = new Set<string>();
    try {
      active();
      mkdirSync(this.actions.directory, { recursive: true, mode: 0o700 });
      let calls = 0;
      const result = await this.runtime.runSession({
        cwd: this.actions.directory,
        workspaceRoot: this.actions.directory,
        readOnly: true,
        profile: job.profile,
        tools,
        signal,
        instructions: withInstructions(
          'You are daddy recovering this host from resource pressure. Ordinary coding agents are stopped and user questions are waiting. Inspect resources and the verified cache candidates, use clean_cache when allowed, then check resources again. Use only these maintenance tools. Do not run shell commands, install software, edit repositories, delete arbitrary files, change resource thresholds or use destructive GC. The cleanup tool preserves user checkouts, dirty worker files, active mounts and the shared object store; repository modules may run ordinary non-truncating GC. Explain the result briefly in the user language. If safe cleanup cannot resolve the pressure, say what is still blocking work and ask for the concrete missing action. Your checkedHead is empty; this is host maintenance, not completion of the coding task.',
          job.instructions,
        ),
        prompt: JSON.stringify({
          instruction: job.input,
          resources: this.status(),
          cleanupAllowed: this.actions.allowCleanup,
          recentUserMessages: store
            .messages(job.groupId)
            .filter((message) => message.sender === 'user')
            .slice(-2)
            .map((message) => message.text),
        }),
        onSession: () => {},
        onEvent: (type, data) =>
          store.event(
            job.groupId,
            `daddy.maintenance.${type}`,
            JSON.parse(redact(JSON.stringify(data ?? null))),
            job.id,
          ),
        onAssistantMessage: ({ id, text }) => {
          if (
            signal.aborted ||
            job.status !== 'running' ||
            store.getGroup(job.groupId).generation !== job.generation
          )
            return;
          if (id && seen.has(id)) return;
          if (id) seen.add(id);
          store.daddyMessage(job.groupId, 'agent', redact(text), job.id, undefined, {
            phase: 'progress',
          });
        },
        onTool: async (name, args) => {
          active();
          if (
            ++calls > 12 ||
            !tools.some((tool) => tool.name === name) ||
            !args ||
            typeof args !== 'object' ||
            Object.keys(args).length
          )
            throw new AppError(
              'maintenance_tool_scope',
              'Only the bounded resource maintenance tools are available',
            );
          if (name === 'read_resources') return this.status();
          if (name === 'inspect_cache') return this.actions.inspect(job.groupId);
          if (!this.actions.allowCleanup)
            throw new AppError(
              'cleanup_disabled',
              'Automatic cache cleanup is disabled in this server configuration',
            );
          const result = await this.actions.clean(job.groupId, signal);
          active();
          return { cleanup: result, resources: this.status() };
        },
      });
      active();
      store.finishDaddyReply(
        job.groupId,
        redact(
          result.summary +
            (result.question && !result.summary.includes(result.question)
              ? '\n\n' + result.question
              : ''),
        ),
        job.id,
      );
      job.status = result.status === 'incomplete' ? 'failed' : 'completed';
    } catch (error) {
      job.status = signal.aborted ? 'cancelled' : 'failed';
      job.error = redact(String(error));
      store.event(job.groupId, 'daddy.resource_repair_failed', { error: job.error }, job.id);
    } finally {
      job.finishedAt = now();
      store.saveDaddyJob(job);
      const group = store.getGroup(job.groupId);
      if (group.generation === job.generation && group.resourceWait) {
        group.resourceWait.state = 'blocked';
        store.saveGroup(group);
        store.event(group.id, 'daddy.resource_wait', {
          resources: this.status(),
          state: 'blocked',
        });
      }
      const failures = this.status().ok
        ? 0
        : (store.setting<number>('resources.failedRecoveries') ?? 0) + 1;
      store.setSetting('resources.failedRecoveries', failures);
      store.setSetting(
        'resources.nextRecovery',
        Date.now() + Math.min(3600000, 300000 * 2 ** Math.min(Math.max(0, failures - 1), 4)),
      );
      store.event(
        job.groupId,
        'daddy.finished',
        { status: job.status, trigger: job.trigger },
        job.id,
      );
    }
  }
}
