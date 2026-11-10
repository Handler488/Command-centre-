import { randomUUID } from 'node:crypto';
import { type DB, nowIso, transaction } from '../../db.ts';
import { AppError, badRequest, notFound } from '../../lib/errors.ts';
import { fetchText, mapLimit } from '../../lib/http.ts';
import { classify, TOPICS } from './classify.ts';
import { clusterArticles, significance, type Significance } from './cluster.ts';
import { DEFAULT_SOURCES, parseFeed } from './feeds.ts';
import { COUNTRIES, COUNTRY_BY_ISO } from './gazetteer.ts';

export interface ArticleDto {
  id: number;
  url: string;
  title: string;
  summary: string;
  sourceId: string;
  sourceName: string;
  publishedAt: string;
  kind: string;
  storyId: number | null;
  countries: string[];
  topics: string[];
}

export interface StoryDto {
  id: number;
  headline: string;
  summary: string;
  firstSeenAt: string;
  latestAt: string;
  /** 'corroborated' = reported by 2+ independent outlets, else 'single-source'. */
  verification: 'corroborated' | 'single-source';
  sourceCount: number;
  articleCount: number;
  significance: Significance;
  countries: string[];
  topics: string[];
  articles: ArticleDto[];
}

export interface RefreshResult {
  sourceId: string;
  name: string;
  ok: boolean;
  fetched: number;
  inserted: number;
  error?: string;
}

const day = (iso: string) => iso.slice(0, 10);

export class NewsService {
  private refreshing: Promise<RefreshResult[]> | null = null;

  constructor(private db: DB) {
    const insert = db.prepare(
      'INSERT OR IGNORE INTO news_sources (id, name, url, homepage, region, enabled, builtin) VALUES (?, ?, ?, ?, ?, 1, 1)',
    );
    for (const s of DEFAULT_SOURCES) insert.run(s.id, s.name, s.url, s.homepage, s.region);
  }

  // ---- sources -------------------------------------------------------------

  listSources() {
    return this.db
      .prepare('SELECT * FROM news_sources ORDER BY builtin DESC, name')
      .all()
      .map((r) => ({
        id: String(r.id),
        name: String(r.name),
        url: String(r.url),
        homepage: r.homepage as string | null,
        region: r.region as string | null,
        enabled: Boolean(r.enabled),
        builtin: Boolean(r.builtin),
        lastAttemptAt: r.last_attempt_at as string | null,
        lastOkAt: r.last_ok_at as string | null,
        lastError: r.last_error as string | null,
        lastItemCount: r.last_item_count as number | null,
      }));
  }

  addSource(name: string, url: string) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw badRequest('Feed URL is not a valid URL');
    }
    if (!/^https?:$/.test(parsed.protocol)) throw badRequest('Feed URL must be http(s)');
    const id = `custom-${randomUUID().slice(0, 8)}`;
    try {
      this.db
        .prepare('INSERT INTO news_sources (id, name, url, homepage, region, enabled, builtin) VALUES (?, ?, ?, ?, NULL, 1, 0)')
        .run(id, name, parsed.toString(), parsed.origin);
    } catch {
      throw new AppError(409, 'conflict', 'That feed is already configured');
    }
    return this.listSources().find((s) => s.id === id)!;
  }

  setSourceEnabled(id: string, enabled: boolean) {
    const res = this.db.prepare('UPDATE news_sources SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
    if (res.changes === 0) throw notFound('Source');
  }

  removeSource(id: string) {
    const row = this.db.prepare('SELECT builtin FROM news_sources WHERE id = ?').get(id);
    if (!row) throw notFound('Source');
    if (row.builtin) throw badRequest('Built-in sources can be disabled but not removed');
    this.db.prepare('DELETE FROM news_sources WHERE id = ?').run(id);
  }

  // ---- ingest --------------------------------------------------------------

  /** Fetch every enabled feed. Concurrent calls share one run. */
  refresh(): Promise<RefreshResult[]> {
    this.refreshing ??= this.runRefresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async runRefresh(): Promise<RefreshResult[]> {
    const sources = this.listSources().filter((s) => s.enabled);
    const results = await mapLimit(sources, 4, async (s): Promise<RefreshResult> => {
      const attempt = nowIso();
      try {
        const xml = await fetchText(s.url, { provider: s.name, timeoutMs: 15_000, retries: 1 });
        const items = parseFeed(xml);
        const inserted = this.storeItems(s.id, s.name, items);
        this.db
          .prepare('UPDATE news_sources SET last_attempt_at = ?, last_ok_at = ?, last_error = NULL, last_item_count = ? WHERE id = ?')
          .run(attempt, attempt, items.length, s.id);
        return { sourceId: s.id, name: s.name, ok: true, fetched: items.length, inserted };
      } catch (err) {
        const message = err instanceof Error ? err.message : 'unknown error';
        this.db.prepare('UPDATE news_sources SET last_attempt_at = ?, last_error = ? WHERE id = ?').run(attempt, message, s.id);
        return { sourceId: s.id, name: s.name, ok: false, fetched: 0, inserted: 0, error: message };
      }
    });
    if (results.some((r) => r.inserted > 0)) this.recluster();
    return results;
  }

  storeItems(sourceId: string, sourceName: string, items: ReturnType<typeof parseFeed>): number {
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO articles (url, title, summary, source_id, source_name, published_at, fetched_at, kind, severity)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const addCountry = this.db.prepare('INSERT OR IGNORE INTO article_countries (article_id, iso3) VALUES (?, ?)');
    const addTopic = this.db.prepare('INSERT OR IGNORE INTO article_topics (article_id, topic) VALUES (?, ?)');
    const fetchedAt = nowIso();
    let inserted = 0;
    transaction(this.db, () => {
      for (const it of items) {
        const c = classify(it.title, it.summary, it.url);
        const res = insert.run(it.url, it.title, it.summary, sourceId, sourceName, it.publishedAt.toISOString(), fetchedAt, c.kind, c.severity);
        if (res.changes === 0) continue;
        inserted++;
        const id = Number(res.lastInsertRowid);
        for (const iso of c.countries) addCountry.run(id, iso);
        for (const t of c.topics) addTopic.run(id, t);
      }
    });
    return inserted;
  }

  /** Re-derive story groupings for recent coverage (last 4 days). */
  recluster(): void {
    const since = new Date(Date.now() - 4 * 86_400_000).toISOString();
    const rows = this.db.prepare('SELECT id, title, published_at FROM articles WHERE published_at >= ?').all(since);
    const assignment = clusterArticles(
      rows.map((r) => ({ id: Number(r.id), title: String(r.title), publishedAt: Date.parse(String(r.published_at)) })),
    );
    const update = this.db.prepare('UPDATE articles SET story_id = ? WHERE id = ? AND story_id IS NOT ?');
    transaction(this.db, () => {
      for (const [id, storyId] of assignment) update.run(storyId, id, storyId);
    });
  }

  // ---- queries -------------------------------------------------------------

  private hydrate(rows: Record<string, unknown>[]): ArticleDto[] {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => Number(r.id));
    const marks = ids.map(() => '?').join(',');
    const countries = new Map<number, string[]>();
    const topics = new Map<number, string[]>();
    for (const r of this.db.prepare(`SELECT article_id, iso3 FROM article_countries WHERE article_id IN (${marks})`).all(...ids)) {
      const k = Number(r.article_id);
      countries.set(k, [...(countries.get(k) ?? []), String(r.iso3)]);
    }
    for (const r of this.db.prepare(`SELECT article_id, topic FROM article_topics WHERE article_id IN (${marks})`).all(...ids)) {
      const k = Number(r.article_id);
      topics.set(k, [...(topics.get(k) ?? []), String(r.topic)]);
    }
    return rows.map((r) => ({
      id: Number(r.id),
      url: String(r.url),
      title: String(r.title),
      summary: String(r.summary),
      sourceId: String(r.source_id),
      sourceName: String(r.source_name),
      publishedAt: String(r.published_at),
      kind: String(r.kind),
      storyId: r.story_id == null ? null : Number(r.story_id),
      countries: countries.get(Number(r.id)) ?? [],
      topics: topics.get(Number(r.id)) ?? [],
    }));
  }

  private filterSql(f: ArticleFilter): { where: string; params: (string | number)[] } {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (f.country) {
      where.push('a.id IN (SELECT article_id FROM article_countries WHERE iso3 = ?)');
      params.push(f.country);
    }
    if (f.topic) {
      where.push('a.id IN (SELECT article_id FROM article_topics WHERE topic = ?)');
      params.push(f.topic);
    }
    if (f.kind === 'reporting') where.push("a.kind IN ('report','live')");
    else if (f.kind === 'commentary') where.push("a.kind IN ('analysis','opinion')");
    if (f.source) {
      where.push('a.source_id = ?');
      params.push(f.source);
    }
    if (f.q) {
      for (const term of f.q.split(/\s+/).filter(Boolean).slice(0, 6)) {
        where.push("(a.title LIKE ? ESCAPE '\\' OR a.summary LIKE ? ESCAPE '\\')");
        const like = `%${term.replace(/[\\%_]/g, '\\$&')}%`;
        params.push(like, like);
      }
    }
    if (f.since) {
      where.push('a.published_at >= ?');
      params.push(f.since);
    }
    if (f.before) {
      where.push('a.published_at < ?');
      params.push(f.before);
    }
    return { where: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
  }

  articles(f: ArticleFilter & { limit?: number; offset?: number }) {
    const { where, params } = this.filterSql(f);
    const limit = Math.min(f.limit ?? 50, 200);
    const total = Number(this.db.prepare(`SELECT COUNT(*) AS n FROM articles a ${where}`).get(...params)?.n ?? 0);
    const rows = this.db
      .prepare(`SELECT a.* FROM articles a ${where} ORDER BY a.published_at DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, f.offset ?? 0);
    return { total, items: this.hydrate(rows) };
  }

  /** Ranked developments in the window. */
  stories(opts: { hours?: number; country?: string; topic?: string; limit?: number; q?: string } = {}): StoryDto[] {
    const hours = Math.min(opts.hours ?? 48, 24 * 14);
    const since = new Date(Date.now() - hours * 3_600_000).toISOString();
    const { where, params } = this.filterSql({ since, q: opts.q });
    const rows = this.db.prepare(`SELECT a.* FROM articles a ${where} ORDER BY a.published_at DESC LIMIT 3000`).all(...params);
    let stories = this.buildStories(this.hydrate(rows), this.severities(rows));
    if (opts.country) stories = stories.filter((s) => s.countries.includes(opts.country!));
    if (opts.topic) stories = stories.filter((s) => s.topics.includes(opts.topic!));
    stories.sort((a, b) => b.significance.score - a.significance.score || b.latestAt.localeCompare(a.latestAt));
    return stories.slice(0, Math.min(opts.limit ?? 30, 100));
  }

  story(id: number): StoryDto {
    const rows = this.db.prepare('SELECT * FROM articles WHERE story_id = ? OR id = ? ORDER BY published_at DESC').all(id, id);
    const built = this.buildStories(this.hydrate(rows), this.severities(rows));
    const s = built.find((x) => x.id === id) ?? built[0];
    if (!s) throw notFound('Story');
    return s;
  }

  private severities(rows: Record<string, unknown>[]): Map<number, number> {
    return new Map(rows.map((r) => [Number(r.id), Number(r.severity)]));
  }

  private buildStories(articles: ArticleDto[], severity: Map<number, number>): StoryDto[] {
    const groups = new Map<number, ArticleDto[]>();
    for (const a of articles) {
      const key = a.storyId ?? a.id;
      groups.set(key, [...(groups.get(key) ?? []), a]);
    }
    const out: StoryDto[] = [];
    for (const [id, members] of groups) {
      members.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
      // Lead with straight reporting where it exists.
      const lead = members.find((m) => m.kind === 'report') ?? (members[0] as ArticleDto);
      const sources = new Set(members.map((m) => m.sourceName.replace(/ (Business|World)$/, '')));
      const count = (xs: string[][]) => {
        const tally = new Map<string, number>();
        for (const x of xs.flat()) tally.set(x, (tally.get(x) ?? 0) + 1);
        return [...tally.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
      };
      const latestAt = (members[0] as ArticleDto).publishedAt;
      out.push({
        id,
        headline: lead.title,
        summary: lead.summary,
        firstSeenAt: (members[members.length - 1] as ArticleDto).publishedAt,
        latestAt,
        verification: sources.size >= 2 ? 'corroborated' : 'single-source',
        sourceCount: sources.size,
        articleCount: members.length,
        significance: significance({
          sourceCount: sources.size,
          articleCount: members.length,
          maxSeverity: Math.max(...members.map((m) => severity.get(m.id) ?? 0)),
          latestAt: Date.parse(latestAt),
        }),
        countries: count(members.map((m) => m.countries)),
        topics: count(members.map((m) => m.topics)),
        articles: members,
      });
    }
    return out;
  }

  /** Per-country coverage for the map. */
  mapData(hours = 48) {
    const since = new Date(Date.now() - hours * 3_600_000).toISOString();
    const counts = this.db
      .prepare(
        `SELECT c.iso3, COUNT(*) AS n, COUNT(DISTINCT a.source_id) AS sources, MAX(a.severity) AS severity
         FROM article_countries c JOIN articles a ON a.id = c.article_id
         WHERE a.published_at >= ? GROUP BY c.iso3`,
      )
      .all(since);
    const top = new Map<string, StoryDto>();
    for (const s of this.stories({ hours, limit: 100 })) {
      for (const iso of s.countries) if (!top.has(iso)) top.set(iso, s);
    }
    return counts
      .map((r) => {
        const c = COUNTRY_BY_ISO.get(String(r.iso3));
        if (!c) return null;
        const t = top.get(c.iso3);
        return {
          ...c,
          articles: Number(r.n),
          sources: Number(r.sources),
          severity: Number(r.severity),
          topStory: t ? { id: t.id, headline: t.headline, score: t.significance.score, verification: t.verification } : null,
        };
      })
      .filter((x) => x !== null)
      .sort((a, b) => b.articles - a.articles);
  }

  archiveStart(): string | null {
    const r = this.db.prepare('SELECT MIN(fetched_at) AS first FROM articles').get();
    return (r?.first as string | null) ?? null;
  }

  /**
   * Daily coverage volume for a country and/or topic, with the immediately
   * preceding period for comparison. Days are UTC. Counts come only from this
   * platform's own archive, so history starts when ingestion started.
   */
  trend(f: { country?: string; topic?: string; q?: string; days?: number }) {
    const days = Math.min(Math.max(f.days ?? 30, 2), 365);
    const end = new Date();
    end.setUTCHours(24, 0, 0, 0);
    const start = new Date(end.getTime() - days * 86_400_000);
    const prevStart = new Date(start.getTime() - days * 86_400_000);
    const series = (from: Date, to: Date) => {
      const { where, params } = this.filterSql({ ...f, since: from.toISOString(), before: to.toISOString() });
      const rows = this.db
        .prepare(`SELECT substr(a.published_at, 1, 10) AS d, COUNT(*) AS n FROM articles a ${where} GROUP BY d`)
        .all(...params);
      const byDay = new Map(rows.map((r) => [String(r.d), Number(r.n)]));
      const out: { date: string; count: number }[] = [];
      for (let t = from.getTime(); t < to.getTime(); t += 86_400_000) {
        const d = day(new Date(t).toISOString());
        out.push({ date: d, count: byDay.get(d) ?? 0 });
      }
      return out;
    };
    const current = series(start, end);
    const previous = series(prevStart, start);
    const sum = (xs: { count: number }[]) => xs.reduce((a, x) => a + x.count, 0);
    const { where, params } = this.filterSql({ ...f, since: start.toISOString() });
    const topicMix = this.db
      .prepare(
        `SELECT t.topic, COUNT(*) AS n FROM article_topics t JOIN articles a ON a.id = t.article_id ${where} GROUP BY t.topic ORDER BY n DESC`,
      )
      .all(...params)
      .map((r) => ({ topic: String(r.topic), count: Number(r.n) }));
    const archiveStart = this.archiveStart();
    return {
      days,
      current,
      previous,
      currentTotal: sum(current),
      previousTotal: sum(previous),
      topicMix,
      archiveStart,
      /** False when the archive does not yet reach back over the whole comparison period. */
      previousPeriodCovered: archiveStart !== null && Date.parse(archiveStart) <= prevStart.getTime(),
    };
  }

  meta() {
    const totals = this.db.prepare('SELECT COUNT(*) AS n, MAX(fetched_at) AS last FROM articles').get();
    return {
      countries: COUNTRIES,
      topics: TOPICS,
      articleCount: Number(totals?.n ?? 0),
      lastIngestAt: (totals?.last as string | null) ?? null,
      archiveStart: this.archiveStart(),
    };
  }
}

export interface ArticleFilter {
  country?: string;
  topic?: string;
  kind?: 'reporting' | 'commentary';
  source?: string;
  q?: string;
  since?: string;
  before?: string;
}
