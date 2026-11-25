import type { Store } from '../core/store.js';
import { AppError, type Task } from '../core/types.js';

type Limit = { until: number; delay: number };
const minute = 60_000;

export class GitHubRetryError extends AppError {
  constructor(
    code: string,
    message: string,
    readonly until: number,
    readonly refusedWrite: boolean,
    status: number,
  ) {
    super(code, message, status);
  }
  beforeWrite() {
    return new GitHubRetryError(this.code, this.message, this.until, true, this.statusCode);
  }
}
export class GitHubQuotaError extends GitHubRetryError {
  constructor(until: number, refusedWrite = false) {
    super(
      'github_rate_limit',
      `GitHub API quota is unavailable until ${new Date(until).toISOString()}`,
      until,
      refusedWrite,
      429,
    );
  }
}

export function isQuotaMessage(message: string) {
  return /^(?:API rate limit exceeded\b|You have exceeded a secondary rate limit\b|You have exceeded a rate limit\b)/i.test(
    message,
  );
}

export function legacyQuotaRead(error?: string) {
  const match = /^AppError: GET [^\s]+: HTTP (?:403|429) (\{[\s\S]+\})$/.exec(
    error?.trimEnd() ?? '',
  );
  if (!match) return false;
  try {
    return isQuotaMessage(JSON.parse(match[1]).message ?? '');
  } catch {
    return false;
  }
}

const key = (host: string) => 'github.quota:' + host;
type ReadBackoff = Limit & { status?: number };
const readKey = (host: string) => 'github.read-backoff:' + host;
export function githubBackoff(store: Store, ref: Pick<Task['ref'], 'provider' | 'host'>) {
  if (ref.provider !== 'github') return;
  const quota = store.setting<Limit>(key(ref.host));
  const read = store.setting<ReadBackoff>(readKey(ref.host));
  const now = Date.now();
  if (read && read.until > now && (!quota || read.until > quota.until))
    return { kind: 'read' as const, ...read };
  if (quota && quota.until > now) return { kind: 'quota' as const, ...quota };
}
export function githubWait(store: Store, ref: Task['ref']) {
  return githubBackoff(store, ref)?.until;
}
// All GitHub PR clients of one installation share its configured account for this host.
export class GitHubQuota {
  constructor(
    private store: Store,
    private host: string,
  ) {}
  check(method: string) {
    const limit = githubBackoff(this.store, { provider: 'github', host: this.host });
    if (!limit) return;
    if (limit.kind === 'quota') throw new GitHubQuotaError(limit.until, method !== 'GET');
    throw this.readError(limit, method !== 'GET');
  }
  private readError(wait: ReadBackoff, refusedWrite: boolean) {
    return new GitHubRetryError(
      'github_read_unavailable',
      `GitHub read failed (${wait.status ? 'HTTP ' + wait.status : 'connection failure'}). Retrying at ${new Date(wait.until).toISOString()}.`,
      wait.until,
      refusedWrite,
      503,
    );
  }
  unavailable(method: string, status?: number, retryAfter?: string | null) {
    if (method !== 'GET') return;
    const previous = this.store.setting<ReadBackoff>(readKey(this.host)),
      now = Date.now();
    const delay =
      previous && now - previous.until < 10 * minute
        ? Math.min(5 * minute, previous.until > now ? previous.delay : previous.delay * 2)
        : 15000;
    const specified =
      retryAfter && /^\d+$/.test(retryAfter)
        ? now + Number(retryAfter) * 1000
        : Date.parse(retryAfter ?? '');
    const until = Math.max(
      previous && previous.until > now ? previous.until : now + delay,
      Number.isFinite(specified) ? specified : 0,
    );
    const wait = { until, delay, status };
    this.store.setSetting(readKey(this.host), wait);
    throw this.readError(wait, false);
  }
  observe(response: Response, method: string, body: string) {
    if ([408, 500, 502, 503, 504].includes(response.status))
      this.unavailable(method, response.status, response.headers.get('retry-after'));
    if (response.status !== 403 && response.status !== 429) return;
    const headers = response.headers;
    let message = '';
    try {
      message = JSON.parse(body).message ?? '';
    } catch {
      /* Headers can identify throttling without JSON. */
    }
    if (
      response.status !== 429 &&
      headers.get('x-ratelimit-remaining') !== '0' &&
      !headers.has('retry-after') &&
      !isQuotaMessage(message)
    )
      return;
    const now = Date.now(),
      previous = this.store.setting<Limit>(key(this.host));
    const retry = headers.get('retry-after');
    const after =
      retry && /^\d+$/.test(retry) ? now + Number(retry) * 1000 : Date.parse(retry ?? '');
    const reset =
      headers.get('x-ratelimit-remaining') === '0'
        ? Number(headers.get('x-ratelimit-reset')) * 1000
        : 0;
    const delay =
      previous && previous.until <= now && now - previous.until < minute
        ? Math.min(previous.delay * 2, 60 * minute)
        : minute;
    const specified = Math.max(
      Number.isFinite(after) ? after : 0,
      Number.isFinite(reset) ? reset : 0,
    );
    const until = Math.max(previous?.until ?? 0, specified > now ? specified + 1000 : now + delay);
    this.store.setSetting(key(this.host), { until, delay });
    throw new GitHubQuotaError(until, method !== 'GET');
  }
}
