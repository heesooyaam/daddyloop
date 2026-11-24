import { GitHubQuotaError } from '../providers/github-quota.js';
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
  type WorkerRequest,
  type TicketRef,
} from './types.js';
import { parseTicket, TicketReader } from '../modules/repositories/tickets.js';
import { ArcBridge } from '../integrations/arcadia.js';
import { Workspaces } from '../runtime/workspaces.js';
import { allRepositories } from '../modules/repositories/index.js';
import type { RepositoryRegistry } from '../modules/repositories/registry.js';
import { redact } from './security.js';
import { taskReference } from './task-activity.js';

// Only a declared source or a standalone issue URL identifies the work item.
// Links in acceptance criteria can refer to parent issues or unrelated examples.
export function githubTaskIssue(
  text: string,
  workspace: Pick<Workspace, 'host' | 'provider' | 'repo'>,
) {
  if (workspace.provider !== 'github') return;
  const declared = text.match(
    /^(?:GitHub issue|Тикет GitHub)\s*[:—-]\s*(https:\/\/[^\s]+)\s*$/im,
  )?.[1];
  const url = declared ?? text.trim().match(/^['"]?(https:\/\/[^\s'"]+)['"]?$/)?.[1];
  if (!url) return;
  try {
    const address = parseTicket(url);
    if (
      address.kind === 'github_issue' &&
      address.host === workspace.host &&
      address.repo.toLowerCase() === workspace.repo.toLowerCase()
    )
      return address.url;
  } catch {
    /* Free-form tasks need no native ticket. */
  }
}

export class TicketWorkflow {
  readonly reader: TicketReader;
  constructor(
    readonly engine: Engine,
    readonly workspaces: Workspaces,
    reader: TicketReader | undefined = undefined,
    private arc = new ArcBridge(),
    private repositories: RepositoryRegistry = allRepositories(),
  ) {
    this.reader =
      reader ?? new TicketReader(undefined, undefined, undefined, repositories, engine.store);
  }
  async start(input: {
    source: string;
    dependsOn?: string[];
    workerRequest?: WorkerRequest;
    startImplementation?: boolean;
    repoPath?: string;
    parentTaskId?: string;
    base?: string;
    requirements?: string;
    agents?: AgentProfiles;
    groupId?: string;
    groupGeneration?: number;
    workspaceId?: string;
    scope?: string;
    workspaceIsolation?: Workspace['copyMode'];
    createdByAction?: string;
  }) {
    const parent = input.parentTaskId ? this.engine.store.getTask(input.parentTaskId) : undefined;
    const path = input.repoPath ?? parent?.repoPath;
    if (!path)
      throw new AppError('repository_missing', 'Choose a repository path on the service host', 400);
    this.repositories.forTicket(input.source);
    const imported = await this.reader.read(input.source);
    this.repositories.get(imported.ref.provider);
    const repository = await this.workspaces.describeTicket(
      path,
      imported.ref,
      input.base,
      input.groupId
        ? {
            groupId: input.groupId,
            copyMode:
              input.workspaceIsolation ??
              this.engine.store.getGroup(input.groupId).workspace?.copyMode,
          }
        : undefined,
    );
    const task = await this.engine.createTicket({
      ...repository,
      source: imported.source,
      dependsOn: input.dependsOn,
      workerRequest: input.workerRequest,
      startImplementation: input.startImplementation,
      parentTaskId: input.parentTaskId,
      requirements: input.requirements,
      agents: input.agents,
      groupId: input.groupId,
      groupGeneration: input.groupGeneration,
      workspaceId: input.workspaceId,
      scope: input.scope,
      workspaceIsolation: input.workspaceIsolation,
      createdByAction: input.createdByAction,
    });
    return task;
  }
  async local(input: {
    source?: string;
    workspace: Workspace;
    groupId: string;
    groupGeneration: number;
    title: string;
    requirements: string;
    createdByAction: string;
    dependsOn?: string[];
    workerRequest?: WorkerRequest;
    startImplementation?: boolean;
  }) {
    const id = randomUUID(),
      workspace = input.workspace;
    const issue = input.source
      ? githubTaskIssue(input.source, workspace)
      : githubTaskIssue(input.requirements, workspace);
    if (input.source && !issue)
      throw new AppError(
        'workspace_mismatch',
        'Choose the GitHub issue in the task workspace',
        422,
      );
    if (issue) {
      const existing = this.engine.store
        .tasks(input.groupId)
        .find((t) => t.source?.url === issue && t.state !== 'complete');
      if (existing) {
        if (existing.repoPath !== workspace.repoPath || existing.scope !== workspace.scope)
          throw new AppError(
            'ticket_workspace_conflict',
            'The ticket already belongs to another workspace',
            422,
          );
        if (input.startImplementation && existing.state === 'discussing')
          await this.engine.implement(existing.id, input.createdByAction);
        return this.engine.store.getTask(existing.id);
      }
      return this.start({
        ...input,
        source: issue,
        repoPath: workspace.repoPath,
        base: workspace.base,
        scope: workspace.scope,
        workspaceId: workspace.id,
        workspaceIsolation: workspace.copyMode,
      });
    }
    this.repositories.get(workspace.provider);
    const url = `https://${workspace.host}/${workspace.provider === 'arcadia' ? 'arc' : workspace.repo}#daddyloop-${id}`;
    const ref: TicketRef = {
      kind: 'ticket',
      provider: workspace.provider,
      host: workspace.host,
      repo: workspace.repo,
      number: 0,
      key: taskReference({ id }),
      url,
    };
    const repository = await this.workspaces.describeTicket(
      workspace.repoPath,
      ref,
      workspace.base,
      { groupId: input.groupId, copyMode: workspace.copyMode },
    );
    return this.engine.createTicket({
      ...repository,
      id,
      groupId: input.groupId,
      groupGeneration: input.groupGeneration,
      workspaceId: workspace.id,
      scope: workspace.scope,
      workspaceIsolation: workspace.copyMode,
      createdByAction: input.createdByAction,
      dependsOn: input.dependsOn,
      workerRequest: input.workerRequest,
      startImplementation: input.startImplementation,
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
  async refreshIssueSource(id: string) {
    return this.engine.lock(id, async () => {
      const task = this.engine.store.getTask(id);
      if (task.ref.kind === 'ticket' || task.source?.kind !== 'local') return;
      const url = githubTaskIssue(task.requirements, task.ref);
      if (!url) return;
      const imported = await this.reader.read(url);
      if (imported.source.kind !== 'github_issue' || imported.source.url !== url) return;
      const latest = this.engine.store.getTask(id);
      if (latest.source?.kind !== 'local' || latest.ref.url !== task.ref.url) return;
      latest.source = imported.source;
      this.engine.store.transaction(() => {
        this.engine.store.saveTask(latest);
        this.engine.store.event(id, 'ticket.source_restored', { url });
      });
    });
  }
  async pushFixes(id: string) {
    return this.engine.submitSavedFix(id, (task, head) =>
      this.workspaces.prepareSavedFixPush(task, head),
    );
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
      const issue =
        task.source?.kind === 'github_issue'
          ? githubTaskIssue(task.source.url, task.ref)
          : task.source?.kind === 'local'
            ? githubTaskIssue(task.requirements, task.ref)
            : undefined;
      const closes = issue ? `\n\nCloses #${parseTicket(issue).number}` : '';
      const body = `Source: ${task.source?.url ?? task.ref.url}\n\n<!-- ${marker} -->`;
      // Keep the durable request identity compatible with submissions predating closing links.
      const publishedBody = issue ? `Source: ${issue}${closes}\n\n<!-- ${marker} -->` : body;
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
          () => submission.create(task, title, publishedBody),
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
          latest.state = error instanceof GitHubQuotaError ? 'ready_for_review' : 'needs_input';
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
          task.state = error instanceof GitHubQuotaError ? 'ready_for_review' : 'needs_input';
          task.reason =
            error instanceof GitHubQuotaError
              ? error.message
              : 'The PR was created but the task changed. Submit again to reconcile and connect it.';
          this.engine.store.saveTask(task);
        }
      });
      throw error;
    }
  }
}
