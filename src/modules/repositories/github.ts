import { parseTicket } from './tickets.js';
import type { RepositoryModule, SubmissionBackend, SubmissionContext } from '../contracts.js';
import type { PRRef, Task } from '../../core/types.js';
import { GitHubProvider } from '../../providers/github.js';
import { credential } from '../../core/security.js';
class GitHubSubmission implements SubmissionBackend {
  constructor(private context: SubmissionContext) {}
  private get reader() {
    return this.context.reader;
  }
  async owner(task: Task) {
    return String((await this.reader.github(task.ref).request<{ id: number }>('GET', '/user')).id);
  }
  async prepare(task: Task) {
    await this.context.workspaces.pushTicket(task);
  }
  async create(task: Task, title: string, body: string): Promise<PRRef> {
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
  async find(task: Task, marker: string, owner: string): Promise<PRRef | undefined> {
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
}
export const githubModule: RepositoryModule = {
  id: 'github',
  name: 'GitHub',
  vcs: 'git',
  acceptsTicket(input) {
    try {
      return parseTicket(input).kind === 'github_issue';
    } catch {
      return false;
    }
  },
  readTicket: (input, reader) => reader.readBuiltin(input),
  matchesRepository: (input) => (input.vcs === 'git' ? 1 : 0),
  parsePR(url) {
    const match = url.pathname.match(/^\/([^/]+\/[^/]+)\/pull\/([1-9]\d*)\/?$/);
    if (
      !match ||
      !/^[\w.-]+(?:\/[\w.-]+)+$/.test(match[1]) ||
      match[1].split('/').some((x) => x === '.' || x === '..') ||
      !Number.isSafeInteger(Number(match[2]))
    )
      return undefined;
    return {
      provider: 'github',
      host: url.hostname,
      repo: match[1],
      number: Number(match[2]),
      url: url.origin + url.pathname.replace(/\/$/, ''),
    };
  },
  review: (ref) => new GitHubProvider(ref.host, credential('github', ref.host)),
  submission: (context) => new GitHubSubmission(context),
};
