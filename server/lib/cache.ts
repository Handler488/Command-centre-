import type { DB } from '../db.ts';

export interface Cached<T> {
  value: T;
  /** Epoch ms at which the value was fetched from its origin. */
  storedAt: number;
  /** True when the entry is past its TTL and is being served as a fallback. */
  stale: boolean;
}

/**
 * SQLite-backed TTL cache for upstream responses. Survives restarts and keeps
 * expired entries so we can serve clearly-labelled stale data when a provider
 * is down, rather than nothing.
 */
export class Cache {
  private inflight = new Map<string, Promise<Cached<unknown>>>();
  constructor(private db: DB) {}

  get<T>(key: string): Cached<T> | undefined {
    const row = this.db
      .prepare('SELECT value, stored_at, expires_at FROM kv_cache WHERE key = ?')
      .get(key);
    if (!row) return undefined;
    return {
      value: JSON.parse(String(row.value)) as T,
      storedAt: Number(row.stored_at),
      stale: Number(row.expires_at) <= Date.now(),
    };
  }

  set<T>(key: string, value: T, ttlMs: number): Cached<T> {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO kv_cache (key, value, stored_at, expires_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, stored_at = excluded.stored_at, expires_at = excluded.expires_at`,
      )
      .run(key, JSON.stringify(value), now, now + ttlMs);
    return { value, storedAt: now, stale: false };
  }

  /**
   * Fresh hit -> cached. Otherwise load; concurrent callers share one request.
   * If loading fails and an expired entry exists, return it flagged stale.
   */
  async wrap<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<Cached<T>> {
    const hit = this.get<T>(key);
    if (hit && !hit.stale) return hit;
    const pending = this.inflight.get(key) as Promise<Cached<T>> | undefined;
    if (pending) return pending;
    const p = (async () => {
      try {
        return this.set(key, await load(), ttlMs);
      } catch (err) {
        if (hit) return hit;
        throw err;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, p as Promise<Cached<unknown>>);
    return p;
  }

  prune(olderThanMs = 14 * 86_400_000): void {
    this.db.prepare('DELETE FROM kv_cache WHERE expires_at < ?').run(Date.now() - olderThanMs);
  }
}
