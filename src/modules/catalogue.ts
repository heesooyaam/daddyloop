/** Installer IDs and registry IDs are the same public contract. */
export const moduleCatalogue = [
  {
    id: 'codex',
    name: 'Codex',
    kind: 'agent',
    recommended: true,
    artifact: 'codex',
    command: 'codex',
    login: ['login', '--device-auth'],
    browserLogin: ['login'],
  },
  {
    id: 'claude',
    name: 'Claude',
    kind: 'agent',
    recommended: false,
    artifact: 'claude',
    command: 'claude',
    apiKeyFile: 'anthropic',
  },
  {
    id: 'github',
    name: 'GitHub',
    kind: 'repository',
    recommended: true,
    artifact: 'github',
    command: 'gh',
  },
  { id: 'gitlab', name: 'GitLab', kind: 'repository', recommended: false },
  { id: 'arcadia', name: 'Arcadia + Tracker', kind: 'repository', recommended: false },
] as const;
export function checkedModules(ids: string[]) {
  if (
    new Set(ids).size !== ids.length ||
    ids.some((id) => !moduleCatalogue.some((module) => module.id === id))
  )
    throw new Error('Choose module IDs from daddy modules list');
  return [...ids].sort();
}
