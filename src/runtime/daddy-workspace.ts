import type { WorkspaceRegistry } from '../core/workspace-registry.js';
import type { Workspace, ReviewGroup, Task } from '../core/types.js';
import { createHash } from 'node:crypto';
import { defaultPolicy, now } from '../core/types.js';
import type { Workspaces } from './workspaces.js';

/** A private read-only workspace snapshot; never a user task or a native ticket. */
export class DaddyWorkspace {
  constructor(
    private workspaces: WorkspaceRegistry,
    private checkouts: Workspaces,
  ) {}
  private selection(group: ReviewGroup, override?: Workspace) {
    const workspace = override ?? group.workspace!;
    const original = group.workspace!;
    const signature = (value: Workspace) =>
      JSON.stringify([value.repoPath, value.scope, value.base]);
    const key =
      signature(workspace) === signature(original)
        ? group.id
        : createHash('sha256')
            .update(group.id + signature(workspace))
            .digest('hex')
            .slice(0, 32);
    return { workspace, key };
  }
  async prepare(
    group: ReviewGroup,
    signal: AbortSignal,
    override?: Workspace,
  ): Promise<{ cwd: string; context: Task; readPaths?: string[] }> {
    const { workspace, key } = this.selection(group, override);
    let context = this.workspaces.store.setting<Task>(`daddy.context:${key}`);
    if (!context) {
      const ref = {
        kind: 'ticket' as const,
        provider: workspace.provider,
        host: workspace.host,
        repo: workspace.repo,
        number: 0,
        key: 'context',
        url: `https://${workspace.host}/${workspace.repo}`,
      };
      const description = await this.checkouts.describeTicket(
        workspace.repoPath,
        ref,
        workspace.base,
      );
      context = {
        id: key,
        ref,
        repoPath: workspace.repoPath,
        scope: workspace.scope,
        ticketRepository: { ...description.repository, branch: `daddyloop/context-${group.id}` },
        title: group.title,
        requirements: group.requirements,
        kind: 'code',
        state: 'discussing',
        reason: 'Read-only workspace context',
        policy: defaultPolicy,
        generation: group.generation,
        contextVersion: 1,
        round: 0,
        noProgress: 0,
        summary: '',
        revision: {
          head: description.repository.baseHead,
          base: description.repository.baseHead,
          start: description.repository.baseHead,
        },
        createdAt: now(),
        updatedAt: now(),
      };
    }
    let root: string;
    try {
      root = await this.checkouts.prepareTicket(context, 'reviewer', signal);
    } finally {
      this.workspaces.store.setSetting(`daddy.context:${key}`, context);
    }
    return {
      cwd: this.workspaces.cwd(root, workspace.scope),
      context,
      readPaths: this.checkouts.readPaths?.(context),
    };
  }
  async release(group: ReviewGroup, override?: Workspace) {
    const { key } = this.selection(group, override);
    const context = this.workspaces.store.setting<Task>(`daddy.context:${key}`);
    if (context?.ref.provider === 'arcadia' && context.arcWorkspaces?.reviewer) {
      await this.checkouts.releaseArc(context, 'reviewer');
      this.workspaces.store.setSetting(`daddy.context:${key}`, context);
    }
  }
}
