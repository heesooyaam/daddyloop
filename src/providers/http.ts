import { AppError } from '../core/types.js';
import { redact } from '../core/security.js';
export type Fetch = typeof fetch;
export class ProviderHttp {
  constructor(
    readonly baseUrl: string,
    readonly headers: Record<string, string>,
    readonly fetcher: Fetch = fetch,
  ) {}
  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (!path.startsWith('/') || path.startsWith('//'))
      throw new AppError('invalid_path', 'Invalid provider API path', 400);
    let response: Response;
    try {
      response = await this.fetcher(this.baseUrl + path, {
        method,
        headers: { ...this.headers, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
        redirect: 'error',
      });
    } catch (error) {
      throw new AppError(
        'provider_unreachable',
        `Provider request did not finish: ${redact(String(error))}`,
        502,
      );
    }
    if (!response.ok) {
      const text = redact((await response.text()).slice(0, 1200));
      throw new AppError(
        `provider_${response.status}`,
        `${method} ${path.split('?')[0]}: HTTP ${response.status} ${text}`,
        response.status === 404 ? 404 : 502,
      );
    }
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    return text ? (JSON.parse(text) as T) : (undefined as T);
  }
  async pages<T>(path: string): Promise<T[]> {
    const all: T[] = [];
    for (let page = 1; page <= 100; page++) {
      const part = await this.request<T[]>(
        'GET',
        `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`,
      );
      if (!Array.isArray(part))
        throw new AppError('provider_shape', 'Provider returned an unexpected list response', 502);
      all.push(...part);
      if (part.length < 100) return all;
    }
    throw new AppError(
      'pagination_limit',
      'Provider response exceeds 10,000 items; refusing a partial snapshot',
      502,
    );
  }
}
