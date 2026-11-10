import { UpstreamError } from './errors.ts';

export interface FetchOptions {
  provider: string;
  timeoutMs?: number;
  retries?: number;
  headers?: Record<string, string>;
}

const BROWSER_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * GET with a hard timeout and bounded retries on transient failures
 * (network errors, 429, 5xx). Always throws UpstreamError so callers and the
 * API layer can tell "provider is down" apart from bugs.
 */
export async function fetchText(url: string, opts: FetchOptions): Promise<string> {
  const { provider, timeoutMs = 12_000, retries = 1 } = opts;
  let lastError: UpstreamError | undefined;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(400 * 2 ** (attempt - 1));
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': BROWSER_UA, Accept: '*/*', ...opts.headers },
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'follow',
      });
      if (res.ok) return await res.text();
      lastError = new UpstreamError(provider, `HTTP ${res.status}`, res.status);
      // Client errors other than 429 will not get better on retry.
      if (res.status < 500 && res.status !== 429) break;
    } catch (err) {
      const reason =
        err instanceof Error && err.name === 'TimeoutError'
          ? `timed out after ${timeoutMs}ms`
          : err instanceof Error
            ? (err.cause instanceof Error ? err.cause.message : err.message)
            : 'network error';
      lastError = new UpstreamError(provider, reason);
    }
  }
  throw lastError ?? new UpstreamError(provider, 'request failed');
}

export async function fetchJson<T = unknown>(url: string, opts: FetchOptions): Promise<T> {
  const text = await fetchText(url, { ...opts, headers: { Accept: 'application/json', ...opts.headers } });
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new UpstreamError(opts.provider, 'response was not valid JSON');
  }
}

/** Run async work over items with bounded concurrency, preserving order. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i] as T, i);
    }
  });
  await Promise.all(workers);
  return out;
}
