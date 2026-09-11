import { AppError, type PRRef } from '../../core/types.js';
import type { RepositoryModule } from '../contracts.js';
export class RepositoryRegistry {
  private modules = new Map<string, RepositoryModule>();
  constructor(modules: RepositoryModule[]) {
    for (const module of modules) {
      if (this.modules.has(module.id)) throw new Error('Repository module IDs must be unique');
      this.modules.set(module.id, module);
    }
  }
  list = () => [...this.modules.values()];
  get(id: string) {
    const module = this.modules.get(id);
    if (!module)
      throw new AppError(
        'repository_module_disabled',
        `Repository module ${id} is not enabled. Run the installer with that module selected.`,
        422,
      );
    return module;
  }
  forRepository(
    input: { vcs: 'git' | 'arcadia'; host: string; remotes: string[] },
    selected?: string,
  ) {
    if (selected) {
      const module = this.get(selected);
      if (module.vcs !== input.vcs)
        throw new AppError(
          'repository_vcs_mismatch',
          'The selected module uses a different version control system',
          422,
        );
      return module;
    }
    const candidates = this.list()
      .map((module) => ({ module, score: module.matchesRepository(input) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score);
    if (!candidates.length || (candidates[1] && candidates[1].score === candidates[0].score))
      throw new AppError(
        'repository_module_required',
        'Choose an enabled repository module explicitly',
        422,
      );
    return candidates[0].module;
  }
  forTicket(input: string) {
    const module = this.list().find((module) => module.readTicket && module.acceptsTicket?.(input));
    if (!module)
      throw new AppError(
        'ticket_module_unavailable',
        'No enabled repository module can import this ticket',
        422,
      );
    return module;
  }
  parse(url: URL, provider?: string): PRRef {
    for (const module of provider ? [this.get(provider)] : this.modules.values()) {
      const ref = module.parsePR(url);
      if (ref) {
        if (ref.provider !== module.id)
          throw new Error('A repository parser returned another module ID');
        return ref;
      }
    }
    throw new AppError('invalid_url', 'No enabled repository module accepts this PR URL', 400);
  }
}
