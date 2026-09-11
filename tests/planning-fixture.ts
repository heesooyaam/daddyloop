import type { AgentProfiles, TicketRef, TicketSource } from '../src/core/types.js';
export const profiles: AgentProfiles = {
  writer: { engine: 'codex', model: 'gpt-5.6-sol', effort: 'max' },
  daddy: { engine: 'codex', model: 'gpt-6-astra', effort: 'max' },
};
export const catalogue = {
  list: async () =>
    Object.values(profiles).map((profile) => ({
      id: profile.model!,
      name: profile.model!,
      efforts: ['medium', 'max'],
      defaultEffort: 'medium',
      isDefault: profile === profiles.daddy,
    })),
  validate: async () => {},
};
export const healthy = () => ({
  memoryAvailableGiB: 30,
  memoryTotalGiB: 90,
  diskAvailableGiB: 180,
  diskUsedPercent: 77,
  ok: true,
  reasons: [],
});
export function ticketInput(number = 42) {
  const url = `https://github.com/test/repo/issues/${number}`;
  const source: TicketSource = {
    kind: 'github_issue',
    key: `test/repo#${number}`,
    url,
    title: `Ticket ${number}`,
    body: 'Keep the session generation invariant.',
    fetchedAt: new Date().toISOString(),
    state: 'open',
    comments: [],
  };
  const ref: TicketRef = {
    kind: 'ticket',
    provider: 'github',
    host: 'github.com',
    repo: 'test/repo',
    number,
    key: source.key,
    url,
  };
  return {
    source,
    ref,
    repoPath: '/tmp',
    repository: {
      baseHead: 'a'.repeat(40),
      baseBranch: 'main',
      cloneUrl: 'https://github.com/test/repo.git',
      branch: '',
    },
    agents: profiles,
  };
}
