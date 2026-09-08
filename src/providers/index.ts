import type { Store } from '../core/store.js';
import type { PRRef } from '../core/types.js';
import { credential } from '../core/security.js';
import { GitHubProvider } from './github.js';
import { GitLabProvider } from './gitlab.js';
import { DemoProvider } from './demo.js';
import type { ReviewProvider } from './provider.js';
export function providers(store: Store): (ref: PRRef) => ReviewProvider {
  return (ref) =>
    ref.provider === 'demo'
      ? new DemoProvider(store)
      : ref.provider === 'github'
        ? new GitHubProvider(ref.host, credential('github', ref.host))
        : new GitLabProvider(ref.host, credential('gitlab', ref.host));
}
