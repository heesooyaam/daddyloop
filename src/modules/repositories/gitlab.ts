import type { RepositoryModule, SubmissionBackend, SubmissionContext } from '../contracts.js';
import type { PRRef, Task } from '../../core/types.js';
import { GitLabProvider } from '../../providers/gitlab.js';
import { credential } from '../../core/security.js';
class GitLabSubmission implements SubmissionBackend {
  constructor(private context: SubmissionContext) {}
  private get reader() {
    return this.context.reader;
  }
  async owner(task: Task) {
    return String((await this.reader.gitlab(task.ref).request<{ id: number }>('GET', '/user')).id);
  }
  async prepare(task: Task) {
    await this.context.workspaces.pushTicket(task);
  }
  async create(task: Task, title: string, body: string): Promise<PRRef> {
    const mr = await this.reader
      .gitlab(task.ref)
      .request<{ iid: number; web_url: string }>(
        'POST',
        `/projects/${encodeURIComponent(task.ref.repo)}/merge_requests`,
        {
          source_branch: task.ticketRepository!.branch,
          target_branch: task.ticketRepository!.baseBranch,
          title: `Draft: ${title}`,
          description: body,
          remove_source_branch: false,
        },
      );
    return {
      provider: 'gitlab',
      host: task.ref.host,
      repo: task.ref.repo,
      number: mr.iid,
      url: mr.web_url,
    };
  }
  async find(task: Task, marker: string, owner: string): Promise<PRRef | undefined> {
    const api = this.reader.gitlab(task.ref),
      path = `/projects/${encodeURIComponent(task.ref.repo)}`;
    const workspace = await api.request<{ id: number }>('GET', path);
    const pulls = await api.pages<{
      iid: number;
      web_url: string;
      description?: string;
      author: { id: number };
      source_branch: string;
      source_project_id: number;
    }>(
      `${path}/merge_requests?scope=all&state=all&source_branch=${encodeURIComponent(task.ticketRepository!.branch)}`,
    );
    const matches = pulls.filter(
      (mr) =>
        String(mr.author.id) === owner &&
        mr.source_project_id === workspace.id &&
        mr.source_branch === task.ticketRepository!.branch &&
        mr.description?.includes(`<!-- ${marker} -->`),
    );
    if (matches.length > 1)
      throw new Error('Multiple merge requests match this task; inspect them before continuing');
    const mr = matches[0];
    return mr
      ? {
          provider: 'gitlab',
          host: task.ref.host,
          repo: task.ref.repo,
          number: mr.iid,
          url: mr.web_url,
        }
      : undefined;
  }
}
export const gitlabModule: RepositoryModule = {
  id: 'gitlab',
  name: 'GitLab',
  vcs: 'git',
  matchesRepository: (input) =>
    input.vcs === 'git' && (input.host.includes('gitlab') || input.remotes.includes('gitlab'))
      ? 10
      : 0,
  parsePR(url) {
    const match = url.pathname.match(/^\/(.+)\/-\/merge_requests\/([1-9]\d*)\/?$/);
    if (
      !match ||
      !/^[\w.-]+(?:\/[\w.-]+)+$/.test(match[1]) ||
      match[1].split('/').some((x) => x === '.' || x === '..') ||
      !Number.isSafeInteger(Number(match[2]))
    )
      return undefined;
    return {
      provider: 'gitlab',
      host: url.hostname,
      repo: match[1],
      number: Number(match[2]),
      url: url.origin + url.pathname.replace(/\/$/, ''),
    };
  },
  review: (ref) => new GitLabProvider(ref.host, credential('gitlab', ref.host)),
  submission: (context) => new GitLabSubmission(context),
};
