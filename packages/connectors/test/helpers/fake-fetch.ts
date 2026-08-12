import { vi } from 'vitest';

export interface FakeRoute {
  /** Substring or regex matched against the request URL. */
  match: string | RegExp;
  method?: string;
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** Serve this route only once, then fall through to later routes. */
  once?: boolean;
}

export interface FakeFetch {
  calls: Array<{ url: string; method: string; body: string | null }>;
  restore: () => void;
}

/**
 * Minimal fetch stub. §11: extraction and sync tests must never hit a real API,
 * so every provider interaction in tests goes through this.
 */
export function installFakeFetch(routes: FakeRoute[]): FakeFetch {
  const remaining = routes.map((r) => ({ ...r, served: false }));
  const calls: FakeFetch['calls'] = [];

  const impl = async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({ url, method, body: (init?.body as string | undefined) ?? null });

    const route = remaining.find((r) => {
      if (r.once && r.served) return false;
      if (r.method && r.method.toUpperCase() !== method) return false;
      return typeof r.match === 'string' ? url.includes(r.match) : r.match.test(url);
    });

    if (!route) {
      throw new Error(`fake-fetch: no route for ${method} ${url}`);
    }
    route.served = true;

    const status = route.status ?? 200;
    const payload =
      typeof route.body === 'string' ? route.body : JSON.stringify(route.body ?? {});

    return new Response(payload, {
      status,
      headers: { 'content-type': 'application/json', ...(route.headers ?? {}) },
    });
  };

  vi.stubGlobal('fetch', vi.fn(impl));

  return { calls, restore: () => vi.unstubAllGlobals() };
}
