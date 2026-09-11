import type { Store } from '../core/store.js';
import type { PRRef } from '../core/types.js';
import { DemoProvider } from './demo.js';
import type { ReviewProvider } from './provider.js';
import { allRepositories } from '../modules/repositories/index.js';
import type { RepositoryRegistry } from '../modules/repositories/registry.js';
export function providers(
  store: Store,
  modules: RepositoryRegistry = allRepositories(),
): (ref: PRRef) => ReviewProvider {
  return (ref) =>
    ref.provider === 'demo'
      ? new DemoProvider(store)
      : modules.get(ref.provider).review(ref, store);
}
