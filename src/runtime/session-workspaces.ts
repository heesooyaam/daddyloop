import type { ReviewGroup } from '../core/types.js';
import type { SessionWorkspaceBackend, SessionWorkspaceContext } from '../modules/contracts.js';
import type { RepositoryRegistry } from '../modules/repositories/registry.js';
import { join } from 'node:path';

/** The coordinator only sees this lifecycle; repository modules own native copies. */
export class SessionWorkspaces {
  private backends = new Map<string, SessionWorkspaceBackend>();
  constructor(
    private repositories: RepositoryRegistry,
    private context: SessionWorkspaceContext,
  ) {}
  supports(group: Pick<ReviewGroup, 'workspace'>) {
    return (
      !!group.workspace &&
      group.workspace.copyMode !== 'pool' &&
      this.repositories
        .list()
        .some((module) => module.id === group.workspace!.provider && !!module.sessionWorkspace)
    );
  }
  private backend(id: string) {
    let backend = this.backends.get(id);
    if (!backend) {
      const factory = this.repositories.get(id).sessionWorkspace;
      if (!factory) return;
      backend = factory(this.context);
      this.backends.set(id, backend);
    }
    return backend;
  }
  async prepare(group: ReviewGroup, signal: AbortSignal) {
    if (!this.supports(group)) return undefined;
    return this.backend(group.workspace!.provider)!.prepare(group, signal);
  }
  async remove(group: ReviewGroup) {
    const contexts = this.context.store.db
      .prepare("SELECT value FROM settings WHERE key LIKE 'daddy.context:%'")
      .all()
      .map((row) => JSON.parse(String(row.value)))
      .filter((value) => value?.groupId === group.id);
    const copies = [
      ...this.context.store.tasks().filter((task) => task.groupId === group.id),
      ...contexts,
    ];
    if (
      copies.some(
        (task) =>
          (task.authorWorktree || task.reviewerWorktree) &&
          !this.repositories.get(task.ref.provider).sessionWorkspace,
      )
    )
      throw new Error(
        'A repository module cannot remove its session copies; all working copies were preserved',
      );
    const archives: string[] = [];
    for (const module of this.repositories.list()) {
      if (!module.sessionWorkspace) continue;
      const result = await this.backend(module.id)!.remove(group);
      if (result.archivePath) archives.push(result.archivePath);
    }
    return {
      archivePath:
        archives.length > 1
          ? join(this.context.dataDir, 'session-archives', group.id)
          : archives[0],
    };
  }
}
