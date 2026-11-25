import type { Store } from '../core/store.js';
import { AppError, type Task } from '../core/types.js';

type Limit = { until: number; delay: number };
const minute = 60_000;

export class GitHubQuotaError extends AppError {
  constructor(
    readonly until: number,
    readonly refusedWrite = false,
  ) {
    super(
      'github_rate_limit',
      `GitHub API quota is unavailable until ${new Date(until).toISOString()}`,
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
export function githubWait(store: Store, ref: Task['ref']) {
  if (ref.provider !== 'github') return;
  const until = store.setting<Limit>(key(ref.host))?.until;
  return until && until > Date.now() ? until : undefined;
}

// All GitHub PR clients of one installation share its configured account for this host.
export class GitHubQuota {
  constructor(
    private store: Store,
    private host: string,
  ) {}
  check(method: string) {
    const limit = this.store.setting<Limit>(key(this.host));
    if (limit && limit.until > Date.now())
      throw new GitHubQuotaError(limit.until, method !== 'GET');
  }
  observe(response: Response, method: string, body: string) {
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
