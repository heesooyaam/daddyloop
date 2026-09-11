import { mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
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
import { TicketReader } from '../integrations/tickets.js';
import { ArcBridge } from '../integrations/arcadia.js';
import { Workspaces } from '../runtime/workspaces.js';
import { parsePR } from '../providers/provider.js';
import { redact } from './security.js';

export class TicketWorkflow {
  constructor(
    readonly engine: Engine,
    readonly workspaces: Workspaces,
    readonly reader = new TicketReader(),
    private arc = new ArcBridge(),
  ) {}
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
    const imported = await this.reader.read(input.source);
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
        const owner =
          task.ref.provider === 'github'
            ? String(
                (await this.reader.github(task.ref).request<{ id: number }>('GET', '/user')).id,
              )
            : task.ref.provider === 'gitlab'
              ? String(
                  (await this.reader.gitlab(task.ref).request<{ id: number }>('GET', '/user')).id,
                )
              : (await this.assertArc(task)).user_login;
        if (!owner || owner === 'undefined')
          throw new Error('Could not verify the PR author identity');
        // A normal Git push is idempotent for the same head and cannot replace
        // concurrent commits. Native PR creation has its own durable outbox.
        if (task.ref.provider === 'github' || task.ref.provider === 'gitlab')
          await this.workspaces.pushTicket(task);
        else await this.assertArc(task);
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
          () => this.createPR(task, title, body),
          async () => {
            const value = await this.findPR(task, marker, owner);
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
  private async assertArc(task: Task) {
    const lease = task.arcWorkspaces?.author;
    if (
      !lease ||
      !(await this.arc.mounts()).some(
        (mount) =>
          mount.path === lease.mount &&
          mount.lease_owner_id === lease.ownerId &&
          mount.object_store_ok,
      )
    )
      throw new Error('This task does not own its Arc author lease');
    const info = JSON.parse(await this.arc.native(['info', '--json'], lease.mount)) as {
      hash: string;
      branch: string;
      user_login: string;
    };
    if (
      info.hash !== task.pendingAuthorHead ||
      !info.branch.startsWith(`daddyloop/${task.id}`) ||
      (await this.arc.native(['status', '--short'], lease.mount))
    )
      throw new Error('The saved Arc implementation changed; inspect it before submitting');
    if (!/^[A-Za-z0-9_.-]+$/.test(info.user_login)) throw new Error('Invalid Arc user identity');
    return info;
  }
  private async createPR(task: Task, title: string, body: string): Promise<PRRef> {
    if (task.ref.provider === 'gitlab') {
      const mr = await this.reader
        .gitlab(task.ref)
        .request<{ iid: number; web_url: string }>(
          'POST',
          `/projects/${encodeURIComponent(task.ref.repo)}/merge_requests`,
          {
            source_branch: task.ticketRepository!.branch,
            target_branch: task.ticketRepository!.baseBranch,
            title: `Draft: ${title}`,
            description: body,
            remove_source_branch: false,
          },
        );
      return {
        provider: 'gitlab',
        host: task.ref.host,
        repo: task.ref.repo,
        number: mr.iid,
        url: mr.web_url,
      };
    }
    if (task.ref.provider === 'github') {
      const pr = await this.reader
        .github(task.ref)
        .request<{ number: number; html_url: string }>('POST', `/repos/${task.ref.repo}/pulls`, {
          title,
          body,
          head: task.ticketRepository!.branch,
          base: task.ticketRepository!.baseBranch,
          draft: true,
        });
      return {
        provider: 'github',
        host: task.ref.host,
        repo: task.ref.repo,
        number: pr.number,
        url: pr.html_url,
      };
    }
    if (task.ref.provider !== 'arcadia')
      throw new Error('Ticket submission is supported for GitHub and Arcadia');
    const info = await this.assertArc(task),
      lease = task.arcWorkspaces!.author!;
    const directory = join(this.workspaces.dataDir, 'ticket-submissions');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = join(directory, task.id + '.md');
    writeFileSync(file, title + '\n\n' + body + '\n', { mode: 0o600 });
    try {
      await this.arc.native(
        [
          'pr',
          'create',
          '--json',
          '--no-edit',
          '--no-commits',
          '--code-review',
          '--wait',
          '--to',
          task.ticketRepository!.baseBranch,
          '--file',
          file,
          '--push',
          `users/${info.user_login}/${task.ticketRepository!.branch}`,
        ],
        lease.mount,
      );
      const ref = await this.findPR(task, `daddyloop:ticket:${task.id}`, info.user_login);
      if (!ref)
        throw new Error(
          'Arc created a PR but its identity could not be verified; submit again to reconcile it',
        );
      return ref;
    } finally {
      unlinkSync(file);
    }
  }
  private async findPR(task: Task, marker: string, owner: string): Promise<PRRef | undefined> {
    if (task.ref.provider === 'gitlab') {
      const api = this.reader.gitlab(task.ref),
        path = `/projects/${encodeURIComponent(task.ref.repo)}`;
      const workspace = await api.request<{ id: number }>('GET', path);
      const pulls = await api.pages<{
        iid: number;
        web_url: string;
        description?: string;
        author: { id: number };
        source_branch: string;
        source_project_id: number;
      }>(
        `${path}/merge_requests?scope=all&state=all&source_branch=${encodeURIComponent(task.ticketRepository!.branch)}`,
      );
      const matches = pulls.filter(
        (mr) =>
          String(mr.author.id) === owner &&
          mr.source_project_id === workspace.id &&
          mr.source_branch === task.ticketRepository!.branch &&
          mr.description?.includes(`<!-- ${marker} -->`),
      );
      if (matches.length > 1)
        throw new Error('Multiple merge requests match this task; inspect them before continuing');
      const mr = matches[0];
      return mr
        ? {
            provider: 'gitlab',
            host: task.ref.host,
            repo: task.ref.repo,
            number: mr.iid,
            url: mr.web_url,
          }
        : undefined;
    }
    if (task.ref.provider === 'github') {
      const branch = encodeURIComponent(
        `${task.ref.repo.split('/')[0]}:${task.ticketRepository!.branch}`,
      );
      const pulls = await this.reader.github(task.ref).pages<{
        number: number;
        html_url: string;
        body?: string;
        user?: { id: number };
        head?: { ref: string; repo?: { full_name: string } };
      }>(`/repos/${task.ref.repo}/pulls?state=all&head=${branch}`);
      const matches = pulls.filter(
        (pr) =>
          String(pr.user?.id) === owner &&
          pr.body?.includes(`<!-- ${marker} -->`) &&
          pr.head?.ref === task.ticketRepository!.branch &&
          pr.head.repo?.full_name.toLowerCase() === task.ref.repo.toLowerCase(),
      );
      if (matches.length > 1)
        throw new Error('Multiple PRs match this task; inspect them before continuing');
      return matches[0]
        ? {
            provider: 'github',
            host: task.ref.host,
            repo: task.ref.repo,
            number: matches[0].number,
            url: matches[0].html_url,
          }
        : undefined;
    }
    try {
      const lease = task.arcWorkspaces!.author!;
      const pr = JSON.parse(await this.arc.native(['pr', 'status', '--json'], lease.mount)) as {
        id?: number;
        url?: string;
        description?: string;
        from_branch?: string;
        author?: string;
      };
      if (
        !pr.id ||
        pr.author !== owner ||
        !pr.description?.includes(`<!-- ${marker} -->`) ||
        pr.from_branch !== `users/${owner}/${task.ticketRepository!.branch}`
      )
        return;
      return parsePR(pr.url ?? `https://a.yandex-team.ru/review/${pr.id}`);
    } catch {
      return;
    }
  }
}
