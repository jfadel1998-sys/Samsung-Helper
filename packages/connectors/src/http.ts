import { RateLimitError } from './types';

export interface HttpResult<T> {
  status: number;
  headers: Headers;
  body: T;
}

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

function parseRetryAfter(headers: Headers): number | null {
  const raw = headers.get('retry-after');
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds);
  // Retry-After may also be an HTTP date.
  const when = Date.parse(raw);
  return Number.isNaN(when) ? null : Math.max(0, Math.ceil((when - Date.now()) / 1000));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface RequestOptions extends RequestInit {
  /** Retries on 5xx and network errors. 429 is surfaced, not retried here. */
  retries?: number;
  timeoutMs?: number;
}

/**
 * JSON fetch with bounded retry.
 *
 * 429 becomes a RateLimitError carrying Retry-After rather than being retried
 * inline — the job queue is the right place to wait out a rate limit, not a
 * held-open HTTP request (§8: Graph returns 429 with Retry-After — honor it).
 */
export async function requestJson<T = unknown>(
  url: string,
  opts: RequestOptions = {},
): Promise<HttpResult<T>> {
  const { retries = 3, timeoutMs = 30_000, ...init } = opts;

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      const text = await res.text();
      const body = text ? safeJson(text) : (null as unknown);

      if (res.status === 429 || (res.status === 503 && res.headers.has('retry-after'))) {
        throw new RateLimitError(
          `${init.method ?? 'GET'} ${redact(url)} rate limited`,
          parseRetryAfter(res.headers) ?? 60,
        );
      }

      if (res.status >= 500 && attempt < retries) {
        lastError = new HttpError(`${res.status} from ${redact(url)}`, res.status, body);
        await sleep(2 ** attempt * 500);
        continue;
      }

      if (!res.ok) {
        throw new HttpError(
          `${res.status} ${res.statusText} from ${redact(url)}`,
          res.status,
          body,
        );
      }

      return { status: res.status, headers: res.headers, body: body as T };
    } catch (err) {
      if (err instanceof RateLimitError || err instanceof HttpError) throw err;
      lastError = err;
      if (attempt < retries) {
        await sleep(2 ** attempt * 500);
        continue;
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Strips query strings so tokens in URLs never reach a log line. */
export function redact(url: string): string {
  const q = url.indexOf('?');
  return q === -1 ? url : `${url.slice(0, q)}?…`;
}
