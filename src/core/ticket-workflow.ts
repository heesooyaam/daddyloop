import type { Engine } from './engine.js';
import { randomUUID } from 'node:crypto';
import {
  AppError,
  assertTaskVersion,
  type ExpectedTask,
  isTicket,
  now,
  type AgentProfiles,
  type PRRef,
  type Task,
  type Workspace,
  type TicketRef,
} from './types.js';
import { TicketReader } from '../modules/repositories/tickets.js';
import { ArcBridge } from '../integrations/arcadia.js';
import { Workspaces } from '../runtime/workspaces.js';
import { allRepositories } from '../modules/repositories/index.js';
import type { RepositoryRegistry } from '../modules/repositories/registry.js';
import { redact } from './security.js';

export class TicketWorkflow {
  readonly reader: TicketReader;
  constructor(
    readonly engine: Engine,
    readonly workspaces: Workspaces,
    reader: TicketReader | undefined = undefined,
    private arc = new ArcBridge(),
    private repositories: RepositoryRegistry = allRepositories(),
  ) {
    this.reader = reader ?? new TicketReader(undefined, undefined, undefined, repositories);
  }
  async start(input: {
    source: string;
    repoPath?: string;
    parentTaskId?: string;
    base?: string;
    requirements?: string;
    agents?: AgentProfiles;
    publication?: 'auto' | 'human';
    autoPush?: boolean;
    groupId?: string;
    groupGeneration?: number;
    workspaceId?: string;
    scope?: string;
    createdByAction?: string;
  }) {
    const parent = input.parentTaskId ? this.engine.store.getTask(input.parentTaskId) : undefined;
    const path = input.repoPath ?? parent?.repoPath;
    if (!path)
      throw new AppError('repository_missing', 'Choose a repository path on the service host', 400);
    this.repositories.forTicket(input.source);
    const imported = await this.reader.read(input.source);
    this.repositories.get(imported.ref.provider);
    const repository = await this.workspaces.describeTicket(path, imported.ref, input.base);
    const task = await this.engine.createTicket({
      ...repository,
      source: imported.source,
      parentTaskId: input.parentTaskId,
      requirements: input.requirements,
      agents: input.agents,
      publication: input.publication,
      autoPush: input.autoPush,
      groupId: input.groupId,
      groupGeneration: input.groupGeneration,
      workspaceId: input.workspaceId,
      scope: input.scope,
      createdByAction: input.createdByAction,
    });
    return task;
  }
  async local(input: {
    workspace: Workspace;
    groupId: string;
    groupGeneration: number;
    title: string;
    requirements: string;
    createdByAction: string;
    dependsOn?: string[];
  }) {
    const id = randomUUID(),
      workspace = input.workspace;
    this.repositories.get(workspace.provider);
    const url = `https://${workspace.host}/${workspace.provider === 'arcadia' ? 'arc' : workspace.repo}#daddyloop-${id}`;
    const ref: TicketRef = {
      kind: 'ticket',
      provider: workspace.provider,
      host: workspace.host,
      repo: workspace.repo,
      number: 0,
      key: `DADDY-${id.slice(0, 8)}`,
      url,
    };
    const repository = await this.workspaces.describeTicket(
      workspace.repoPath,
      ref,
      workspace.base,
    );
    return this.engine.createTicket({
      ...repository,
      id,
      groupId: input.groupId,
      groupGeneration: input.groupGeneration,
      workspaceId: workspace.id,
      scope: workspace.scope,
      createdByAction: input.createdByAction,
      dependsOn: input.dependsOn,
      requirements: input.requirements,
      source: {
        kind: 'local',
        key: ref.key,
        title: input.title,
        body: input.requirements,
        url,
        state: 'open',
        fetchedAt: now(),
      },
    });
  }
  async submit(id: string, expected?: ExpectedTask): Promise<Task> {
    const result = await this.engine.lock(id, async () => {
      const task = this.engine.store.getTask(id);
      assertTaskVersion(task, expected);
      if (
        !isTicket(task) ||
        !task.ticketRepository ||
        !task.pendingAuthorHead ||
        this.engine.store.busy(id) ||
        task.state === 'paused'
      )
        throw new AppError(
          'implementation_required',
          'Finish implementation before submitting this ticket',
        );
      if (!['ready_for_review', 'needs_input', 'submitting'].includes(task.state))
        throw new AppError('implementation_required', 'Implementation is not ready for submission');
      const generation = task.generation,
        marker = `daddyloop:ticket:${task.id}`;
      const title = Array.from(
        `${task.source?.key ?? 'Ticket'}: ${task.title}`.replace(/\s+/g, ' '),
      )
        .slice(0, 230)
        .join('');
      const body = `Source: ${task.source?.url ?? task.ref.url}\n\n<!-- ${marker} -->`;
      task.state = 'submitting';
      task.resumeState = 'submitting';
      task.reason = 'Creating the native PR for the shared reviewer';
      this.engine.store.saveTask(task);
      this.engine.store.event(id, 'task.state', { state: task.state, reason: task.reason });
      try {
        const submission = this.repositories
          .get(task.ref.provider)
          .submission({ reader: this.reader, workspaces: this.workspaces, arc: this.arc });
        const owner = await submission.owner(task);
        if (!owner || owner === 'undefined')
          throw new Error('Could not verify the PR author identity');
        // A normal Git push is idempotent for the same head and cannot replace
        // concurrent commits. Native PR creation has its own durable outbox.
        await submission.prepare(task);
        const ref = await this.engine.broker.outbox.perform<PRRef>(
          id,
          `ticket-submit:${id}`,
          {
            head: task.pendingAuthorHead,
            branch: task.ticketRepository.branch,
            repo: task.ref.repo,
            owner,
            title,
            body,
          },
          () => submission.create(task, title, body),
          async () => {
            const value = await submission.find(task, marker, owner);
            return value ? { found: true, value } : { found: false };
          },
        );
        this.engine.store.event(id, 'ticket.pr_created', { ref });
        return { ref, generation, head: task.pendingAuthorHead };
      } catch (error) {
        const latest = this.engine.store.getTask(id);
        if (latest.generation === generation && latest.state !== 'paused') {
          latest.state = 'needs_input';
          latest.reason = redact(String(error));
          this.engine.store.saveTask(latest);
          this.engine.store.event(id, 'task.state', { state: latest.state, reason: latest.reason });
        }
        throw error;
      }
    });
    try {
      return await this.engine.linkPR(id, result.ref, result.generation, result.head);
    } catch (error) {
      await this.engine.lock(id, async () => {
        const task = this.engine.store.getTask(id);
        if (isTicket(task) && task.state === 'submitting') {
          task.state = 'needs_input';
          task.reason =
            'The PR was created but the task changed. Submit again to reconcile and connect it.';
          this.engine.store.saveTask(task);
        }
      });
      throw error;
    }
  }
}
