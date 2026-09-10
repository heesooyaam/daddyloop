import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { credential, rememberSecret } from '../core/security.js';
import { AppError, now, type TicketSource, type TicketRef } from '../core/types.js';
import { ProviderHttp, type Fetch } from '../providers/http.js';

export interface TicketAddress {
  kind: 'github_issue' | 'tracker';
  key: string;
  url: string;
  host: string;
  repo: string;
  number: number;
}
export function parseTicket(input: string): TicketAddress {
  const key = input.trim().match(/^[A-Z][A-Z0-9_]{0,39}-[1-9]\d*$/)?.[0];
  let url: URL;
  try {
    url = key ? new URL(`https://st.yandex-team.ru/${key}`) : new URL(input.trim());
  } catch {
    throw new AppError('invalid_ticket', 'Use a GitHub issue URL or Tracker key', 400);
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port)
    throw new AppError('invalid_ticket', 'Use an HTTPS issue URL or a Tracker key', 400);
  if (url.hostname === 'st.yandex-team.ru') {
    const match = url.pathname.match(/^\/([A-Z][A-Z0-9_]{0,39}-([1-9]\d*))\/?$/);
    if (!match || !Number.isSafeInteger(Number(match[2])))
      throw new AppError('invalid_ticket', 'Use a Tracker ticket URL or QUEUE-123 key', 400);
    return {
      kind: 'tracker',
      key: match[1],
      number: Number(match[2]),
      url: `https://st.yandex-team.ru/${match[1]}`,
      host: 'a.yandex-team.ru',
      repo: 'arcadia',
    };
  }
  const match = url.pathname.match(/^\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/issues\/([1-9]\d*)\/?$/);
  if (
    !match ||
    !Number.isSafeInteger(Number(match[2])) ||
    (url.hostname !== 'github.com' && url.hostname !== process.env.REVIEWLOOP_GITHUB_HOST)
  )
    throw new AppError('invalid_ticket', 'Use a GitHub issue URL or a Yandex Tracker ticket', 400);
  match[1] = match[1].toLowerCase();
  return {
    kind: 'github_issue',
    host: url.hostname,
    repo: match[1],
    number: Number(match[2]),
    key: `${match[1]}#${match[2]}`,
    url: `https://${url.hostname}/${match[1]}/issues/${match[2]}`,
  };
}
function trackerToken() {
  const paths = [join(homedir(), '.tokens/tracker'), join(homedir(), '.tracker-token')];
  const token =
    process.env.TRACKER_OAUTH_TOKEN ??
    process.env.TRACKER_TOKEN ??
    paths.filter(existsSync).map((path) => readFileSync(path, 'utf8').trim())[0];
  if (!token)
    throw new AppError(
      'credentials_missing',
      'Configure ~/.tokens/tracker or TRACKER_OAUTH_TOKEN',
      422,
    );
  return rememberSecret(token);
}
export function parseTrackerJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // Some Tracker descriptions contain raw controls inside JSON strings. Escape
    // those controls, preserving the Markdown instead of deleting its newlines.
    let string = false,
      escaped = false,
      repaired = '';
    for (const char of text) {
      if (string && !escaped && char.charCodeAt(0) < 32)
        repaired += JSON.stringify(char).slice(1, -1);
      else repaired += char;
      if (!escaped && char === '"') string = !string;
      if (string && !escaped && char === '\\') escaped = true;
      else escaped = false;
    }
    return JSON.parse(repaired);
  }
}
export class TicketReader {
  constructor(
    private fetcher: Fetch = fetch,
    private trackerCredential = trackerToken,
    private githubCredential = (host: string) => credential('github', host),
  ) {}
  gitlab(address: { host: string }) {
    return new ProviderHttp(
      `https://${address.host}/api/v4`,
      { 'PRIVATE-TOKEN': credential('gitlab', address.host) },
      this.fetcher,
    );
  }
  github(address: Pick<TicketAddress, 'host'>) {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'reviewloop',
    };
    try {
      headers.Authorization = `Bearer ${this.githubCredential(address.host)}`;
    } catch (error) {
      if (address.host !== 'github.com') throw error;
    }
    return new ProviderHttp(
      address.host === 'github.com' ? 'https://api.github.com' : `https://${address.host}/api/v3`,
      headers,
      this.fetcher,
    );
  }
  async read(input: string): Promise<{ source: TicketSource; ref: TicketRef }> {
    const address = parseTicket(input);
    let source: TicketSource;
    if (address.kind === 'github_issue') {
      const http = this.github(address),
        path = `/repos/${address.repo}/issues/${address.number}`;
      const issue = await http.request<{
        title: string;
        body: string | null;
        state: string;
        updated_at: string;
        pull_request?: unknown;
      }>('GET', path);
      if (issue.pull_request)
        throw new AppError('not_an_issue', 'Use Attach PR for a pull request', 400);
      const comments: { id: number; body: string; user?: { login: string } }[] = [];
      for (let page = 1; page <= 100; page++) {
        const list = await http.request<typeof comments>(
          'GET',
          `${path}/comments?per_page=100&page=${page}`,
        );
        if (!Array.isArray(list)) throw new Error('GitHub returned an invalid comment list');
        comments.push(...list);
        if (JSON.stringify(comments).length > 250000)
          throw new AppError(
            'ticket_too_large',
            'Comment history exceeds the context limit; use a smaller child ticket',
            422,
          );
        if (list.length < 100) break;
        if (page === 100) throw new Error('Issue comment pagination exceeded its limit');
      }
      source = {
        kind: address.kind,
        key: address.key,
        url: address.url,
        title: issue.title,
        body: issue.body ?? '',
        state: issue.state,
        updatedAt: issue.updated_at,
        fetchedAt: now(),
        comments: comments.map((comment) => ({
          id: String(comment.id),
          author: comment.user?.login ?? '',
          body: comment.body,
        })),
      };
    } else {
      const token = this.trackerCredential();
      const read = async (path: string) => {
        const response = await this.fetcher(`https://st-api.yandex-team.ru/v3${path}`, {
          headers: { Authorization: `OAuth ${token}` },
          redirect: 'error',
          signal: AbortSignal.timeout(30000),
        });
        if (!response.ok)
          throw new AppError(
            'tracker_unreachable',
            `Tracker returned HTTP ${response.status}; check the ticket and local account access`,
            502,
          );
        return parseTrackerJson(await response.text());
      };
      const issue = (await read(`/issues/${address.key}`)) as {
        summary: string;
        description?: string;
        status?: { key: string };
        updatedAt?: string;
      };
      const comments: NonNullable<TicketSource['comments']> = [];
      let cursor = '';
      const seen = new Set<string>();
      for (let page = 1; page <= 20; page++) {
        const list = (await read(
          `/issues/${address.key}/comments?perPage=100${cursor ? `&id=${encodeURIComponent(cursor)}` : ''}`,
        )) as { id: string; text?: string; createdBy?: { display?: string; id: string } }[];
        if (!Array.isArray(list)) throw new Error('Tracker returned an invalid comment list');
        for (const comment of list) {
          if (!comment.id || seen.has(String(comment.id)))
            throw new Error(
              'Tracker comment pagination did not advance; no partial ticket was imported',
            );
          seen.add(String(comment.id));
        }
        cursor = String(list.at(-1)?.id ?? '');
        comments.push(
          ...list.map((comment) => ({
            id: String(comment.id),
            author: comment.createdBy?.display ?? comment.createdBy?.id ?? '',
            body: comment.text ?? '',
          })),
        );
        if (JSON.stringify(comments).length > 250000)
          throw new AppError(
            'ticket_too_large',
            'Comment history exceeds the context limit; use a smaller child ticket',
            422,
          );
        if (list.length < 100) break;
        if (page === 20)
          throw new AppError(
            'ticket_too_large',
            'Ticket comment history is too large; use a smaller child ticket',
            422,
          );
      }
      source = {
        kind: address.kind,
        key: address.key,
        url: address.url,
        title: issue.summary,
        body: issue.description ?? '',
        state: issue.status?.key ?? '',
        fetchedAt: now(),
        updatedAt: issue.updatedAt,
        comments,
      };
    }
    if (
      !source.title ||
      source.title.length > 500 ||
      source.body.length > 100000 ||
      JSON.stringify(source).length > 300000
    )
      throw new AppError(
        'ticket_too_large',
        'The ticket exceeds the context limit; split it into child tickets',
        422,
      );
    return {
      source,
      ref: {
        kind: 'ticket',
        provider: address.kind === 'tracker' ? 'arcadia' : 'github',
        host: address.host,
        repo: address.repo,
        number: address.number,
        key: address.key,
        url: address.url,
      },
    };
  }
}
