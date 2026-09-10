import type { Projects } from '../core/projects.js';
import type { Project, ReviewGroup, Task } from '../core/types.js';
import { createHash } from 'node:crypto';
import { defaultPolicy, now } from '../core/types.js';
import type { Workspaces } from './workspaces.js';

/** A private read-only project snapshot; never a user task or a native ticket. */
export class DaddyWorkspace {
  constructor(
    private projects: Projects,
    private workspaces: Workspaces,
  ) {}
  private selection(group: ReviewGroup, override?: Project) {
    const project = override ?? group.project ?? this.projects.get(group.projectId!);
    const original = group.project ?? this.projects.get(group.projectId!);
    const signature = (value: Project) => JSON.stringify([value.repoPath, value.scope, value.base]);
    const key =
      signature(project) === signature(original)
        ? group.id
        : createHash('sha256')
            .update(group.id + signature(project))
            .digest('hex')
            .slice(0, 32);
    return { project, key };
  }
  async prepare(group: ReviewGroup, signal: AbortSignal, override?: Project) {
    const { project, key } = this.selection(group, override);
    let context = this.projects.store.setting<Task>(`daddy.context:${key}`);
    if (!context) {
      const ref = {
        kind: 'ticket' as const,
        provider: project.provider,
        host: project.host,
        repo: project.repo,
        number: 0,
        key: 'context',
        url: `https://${project.host}/${project.repo}`,
      };
      const description = await this.workspaces.describeTicket(project.repoPath, ref, project.base);
      context = {
        id: key,
        ref,
        repoPath: project.repoPath,
        scope: project.scope,
        ticketRepository: { ...description.repository, branch: `reviewloop/context-${group.id}` },
        title: group.title,
        requirements: group.requirements,
        kind: 'code',
        state: 'discussing',
        reason: 'Read-only project context',
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
      root = await this.workspaces.prepareTicket(context, 'reviewer', signal);
    } finally {
      this.projects.store.setSetting(`daddy.context:${key}`, context);
    }
    return { cwd: this.projects.cwd(root, project.scope), context };
  }
  async release(group: ReviewGroup, override?: Project) {
    const { key } = this.selection(group, override);
    const context = this.projects.store.setting<Task>(`daddy.context:${key}`);
    if (context?.ref.provider === 'arcadia' && context.arcWorkspaces?.reviewer) {
      await this.workspaces.releaseArc(context, 'reviewer');
      this.projects.store.setSetting(`daddy.context:${key}`, context);
    }
  }
}
