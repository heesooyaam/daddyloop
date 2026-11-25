import { createRequire } from 'node:module';
import { expect, it, vi } from 'vitest';

const link = createRequire(import.meta.url)('../.github/scripts/link-pr-issue.cjs');
const repo = { owner: 'test', repo: 'repo' };

function setup() {
  const pr = {
    state: 'OPEN',
    title: 'Fix search',
    body: 'Original description.',
    closingIssuesReferences: { totalCount: 0 },
  };
  const issues: { number: number; body: string }[] = [];
  const api = {
    graphql: vi.fn(async () => ({
      repository: { pullRequest: { ...pr } },
      viewer: { login: 'automation' },
    })),
    rest: {
      issues: {
        listForRepo: vi.fn(),
        get: vi.fn(async ({ issue_number }: { issue_number: number }) => ({
          data: { number: issue_number },
        })),
        create: vi.fn(async ({ body }: { body: string }) => {
          const issue = { number: 18, body };
          issues.push(issue);
          return { data: issue };
        }),
      },
      pulls: {
        update: vi.fn(async ({ body }: { body: string }) => {
          pr.body = body;
        }),
      },
    },
    paginate: {
      iterator: async function* () {
        yield { data: issues };
      },
    },
  };
  return { api, pr };
}

it('recovers an issue after the link update failed, preserving concurrent edits', async () => {
  const { api, pr } = setup();
  api.rest.pulls.update.mockRejectedValueOnce(new Error('network interrupted'));
  await expect(link(api, repo, 12)).rejects.toThrow('network interrupted');
  pr.body += '\nExtra context.';
  await link(api, repo, 12);
  await link(api, repo, 12);
  expect(api.rest.issues.create).toHaveBeenCalledTimes(1);
  expect(pr.body).toBe('Original description.\nExtra context.\n\nCloses #18');
});
it('keeps a manually linked issue', async () => {
  const { api, pr } = setup();
  pr.closingIssuesReferences.totalCount = 1;
  await link(api, repo, 12);
  expect(api.rest.issues.create).not.toHaveBeenCalled();
  expect(api.rest.pulls.update).not.toHaveBeenCalled();
});

it('attaches an explicitly named source issue without creating another one', async () => {
  const { api, pr } = setup();
  pr.body = 'Source: https://github.com/test/repo/issues/41';
  await link(api, repo, 12);
  expect(api.rest.issues.create).not.toHaveBeenCalled();
  expect(pr.body).toContain('Closes #41');
});
