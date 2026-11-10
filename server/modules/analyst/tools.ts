import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { TOPICS } from '../news/classify.ts';
import { COUNTRY_BY_ISO } from '../news/gazetteer.ts';
import type { NewsService, StoryDto } from '../news/service.ts';
import type { MarketsService } from '../markets/service.ts';
import type { PersonalService } from '../personal/service.ts';

export interface Services {
  news: NewsService;
  markets: MarketsService;
  personal: PersonalService;
}

export interface SourceRef {
  title: string;
  url: string;
  publisher: string;
  kind: 'news' | 'market-data' | 'filing';
  publishedAt?: string;
}

interface ToolSpec<S extends z.ZodType> {
  description: string;
  schema: S;
  jsonSchema: Anthropic.Tool['input_schema'];
  /** Short human label shown in the UI while the tool runs. */
  label: (input: z.infer<S>) => string;
  run: (input: z.infer<S>, ctx: { services: Services; today: string; cite: (s: SourceRef) => void }) => Promise<unknown>;
}

const tool = <S extends z.ZodType>(spec: ToolSpec<S>) => spec;
const topicIds = TOPICS.map((t) => t.id) as [string, ...string[]];
const countryName = (iso: string) => COUNTRY_BY_ISO.get(iso)?.name ?? iso;
const round = (n: number | null | undefined, dp = 2) => (n == null ? null : Math.round(n * 10 ** dp) / 10 ** dp);

function storyOut(s: StoryDto, cite: (s: SourceRef) => void) {
  for (const a of s.articles.slice(0, 5)) cite({ title: a.title, url: a.url, publisher: a.sourceName, kind: 'news', publishedAt: a.publishedAt });
  return {
    headline: s.headline,
    summary: s.summary.slice(0, 320),
    verification: s.verification,
    independent_outlets: s.sourceCount,
    significance_score: s.significance.score,
    first_seen: s.firstSeenAt,
    latest: s.latestAt,
    countries: s.countries.map(countryName),
    topics: s.topics,
    coverage: s.articles.slice(0, 5).map((a) => ({ publisher: a.sourceName, title: a.title, url: a.url, published: a.publishedAt, type: a.kind })),
  };
}

export const TOOLS = {
  get_top_stories: tool({
    description:
      'Ranked list of the most significant news developments in the platform archive for a recent window, optionally filtered by country or topic. Each story lists the outlets covering it with URLs, and whether it is corroborated by 2+ independent outlets or single-source. Use this first for "what is happening" questions.',
    schema: z.object({
      hours: z.number().int().min(1).max(336).optional(),
      country_iso3: z.string().length(3).optional(),
      topic: z.enum(topicIds).optional(),
      limit: z.number().int().min(1).max(20).optional(),
    }),
    jsonSchema: {
      type: 'object',
      properties: {
        hours: { type: 'integer', description: 'Look-back window in hours (default 48, max 336).' },
        country_iso3: { type: 'string', description: 'ISO 3166-1 alpha-3 code, e.g. UKR, USA, CHN.' },
        topic: { type: 'string', enum: topicIds },
        limit: { type: 'integer', description: 'Max stories (default 10).' },
      },
    },
    label: (i) => `Reading top stories${i.country_iso3 ? ` for ${countryName(i.country_iso3.toUpperCase())}` : ''}${i.topic ? ` on ${i.topic}` : ''}`,
    run: async (i, { services, cite }) => {
      const stories = services.news.stories({ hours: i.hours ?? 48, country: i.country_iso3?.toUpperCase(), topic: i.topic, limit: i.limit ?? 10 });
      return { window_hours: i.hours ?? 48, count: stories.length, stories: stories.map((s) => storyOut(s, cite)), archive: services.news.meta().archiveStart ? undefined : 'The news archive is empty: no feeds have been ingested yet.' };
    },
  }),

  search_news: tool({
    description:
      'Keyword search over archived article headlines and summaries, newest first. Supports country, topic and date filters. Returns publisher, URL and whether each item is straight reporting or analysis/opinion.',
    schema: z.object({
      query: z.string().max(120).optional(),
      country_iso3: z.string().length(3).optional(),
      topic: z.enum(topicIds).optional(),
      since: z.string().optional(),
      before: z.string().optional(),
      limit: z.number().int().min(1).max(30).optional(),
    }),
    jsonSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keywords; all must appear.' },
        country_iso3: { type: 'string' },
        topic: { type: 'string', enum: topicIds },
        since: { type: 'string', description: 'ISO date/time lower bound.' },
        before: { type: 'string', description: 'ISO date/time upper bound.' },
        limit: { type: 'integer', description: 'Default 12.' },
      },
    },
    label: (i) => `Searching the news archive${i.query ? ` for “${i.query}”` : ''}`,
    run: async (i, { services, cite }) => {
      const date = (s?: string) => (s && !Number.isNaN(Date.parse(s)) ? new Date(s).toISOString() : undefined);
      const { total, items } = services.news.articles({ q: i.query, country: i.country_iso3?.toUpperCase(), topic: i.topic, since: date(i.since), before: date(i.before), limit: i.limit ?? 12 });
      for (const a of items) cite({ title: a.title, url: a.url, publisher: a.sourceName, kind: 'news', publishedAt: a.publishedAt });
      return {
        total_matches: total,
        articles: items.map((a) => ({ publisher: a.sourceName, title: a.title, summary: a.summary.slice(0, 280), url: a.url, published: a.publishedAt, type: a.kind, countries: a.countries.map(countryName), topics: a.topics })),
      };
    },
  }),

  news_coverage_trend: tool({
    description:
      'Daily count of archived articles for a country and/or topic over N days, with the preceding period for comparison and the topic mix. Measures coverage volume in this platform\'s own archive only; check archive_start before comparing periods.',
    schema: z.object({ country_iso3: z.string().length(3).optional(), topic: z.enum(topicIds).optional(), days: z.number().int().min(2).max(365).optional() }),
    jsonSchema: {
      type: 'object',
      properties: { country_iso3: { type: 'string' }, topic: { type: 'string', enum: topicIds }, days: { type: 'integer', description: 'Default 14.' } },
    },
    label: (i) => `Measuring coverage trend${i.country_iso3 ? ` for ${countryName(i.country_iso3.toUpperCase())}` : ''}`,
    run: async (i, { services }) => {
      const t = services.news.trend({ country: i.country_iso3?.toUpperCase(), topic: i.topic, days: i.days ?? 14 });
      return { days: t.days, current_total: t.currentTotal, previous_total: t.previousTotal, previous_period_fully_covered: t.previousPeriodCovered, archive_start: t.archiveStart, daily: t.current, topic_mix: t.topicMix };
    },
  }),

  get_quotes: tool({
    description: 'Latest available prices for up to 12 ticker symbols (Yahoo Finance symbology, e.g. AAPL, ^GSPC, EURUSD=X, BTC-USD). Prices are delayed, not real-time; each carries its as-of time and provider.',
    schema: z.object({ symbols: z.array(z.string().min(1).max(15)).min(1).max(12) }),
    jsonSchema: { type: 'object', properties: { symbols: { type: 'array', items: { type: 'string' } } }, required: ['symbols'] },
    label: (i) => `Fetching quotes for ${i.symbols.join(', ')}`,
    run: async (i, { services, cite }) => {
      const rows = await services.markets.quotes(i.symbols);
      return rows.map((r) => {
        if (!r.quote) return { symbol: r.symbol, error: r.error };
        cite({ title: `${r.symbol} quote`, url: `https://finance.yahoo.com/quote/${encodeURIComponent(r.symbol)}`, publisher: r.quote.provider, kind: 'market-data', publishedAt: r.quote.asOf });
        return { symbol: r.symbol, name: r.quote.name, price: r.quote.price, currency: r.quote.currency, change_pct: round(r.quote.changePct), previous_close: r.quote.previousClose, as_of: r.quote.asOf, provider: r.quote.provider, stale: r.stale, fifty_two_week_high: r.quote.fiftyTwoWeekHigh, fifty_two_week_low: r.quote.fiftyTwoWeekLow };
      });
    },
  }),

  get_price_history: tool({
    description: 'Price performance summary for one symbol over a range (1M, 6M, YTD, 1Y, 5Y): start/end, total return, high/low, plus ~24 evenly sampled closes.',
    schema: z.object({ symbol: z.string().min(1).max(15), range: z.enum(['1M', '6M', 'YTD', '1Y', '5Y']).optional() }),
    jsonSchema: { type: 'object', properties: { symbol: { type: 'string' }, range: { type: 'string', enum: ['1M', '6M', 'YTD', '1Y', '5Y'] } }, required: ['symbol'] },
    label: (i) => `Loading ${i.range ?? '1Y'} price history for ${i.symbol.toUpperCase()}`,
    run: async (i, { services, cite }) => {
      const h = await services.markets.history(i.symbol, i.range ?? '1Y');
      const c = h.candles;
      if (c.length < 2) return { symbol: h.symbol, error: 'not enough price history' };
      cite({ title: `${h.symbol} price history`, url: `https://finance.yahoo.com/quote/${encodeURIComponent(h.symbol)}/history`, publisher: h.provider, kind: 'market-data' });
      const step = Math.max(1, Math.floor(c.length / 24));
      return {
        symbol: h.symbol,
        range: h.range,
        provider: h.provider,
        from: c[0]!.t,
        to: c.at(-1)!.t,
        start_close: c[0]!.c,
        end_close: c.at(-1)!.c,
        total_return_pct: round((c.at(-1)!.c / c[0]!.c - 1) * 100),
        period_high: Math.max(...c.map((x) => x.h)),
        period_low: Math.min(...c.map((x) => x.l)),
        sampled_closes: c.filter((_, idx) => idx % step === 0 || idx === c.length - 1).map((x) => ({ date: x.t, close: round(x.c) })),
      };
    },
  }),

  get_company_financials: tool({
    description: 'Company profile for a ticker: delayed quote, up to five fiscal years of company-filed financials from SEC EDGAR (US registrants only), valuation multiples and one-year price-risk statistics (volatility, beta vs S&P 500, max drawdown, 95% one-day VaR).',
    schema: z.object({ symbol: z.string().min(1).max(15) }),
    jsonSchema: { type: 'object', properties: { symbol: { type: 'string' } }, required: ['symbol'] },
    label: (i) => `Pulling financials for ${i.symbol.toUpperCase()}`,
    run: async (i, { services, cite }) => {
      const c = await services.markets.company(i.symbol);
      if (c.fundamentals) cite({ title: `${c.fundamentals.entityName} annual filings (10-K)`, url: c.fundamentals.filingsUrl, publisher: 'SEC EDGAR', kind: 'filing' });
      if (c.quote) cite({ title: `${c.symbol} quote`, url: `https://finance.yahoo.com/quote/${encodeURIComponent(c.symbol)}`, publisher: c.quote.quote.provider, kind: 'market-data', publishedAt: c.quote.quote.asOf });
      return {
        symbol: c.symbol,
        quote: c.quote ? { price: c.quote.quote.price, currency: c.quote.quote.currency, change_pct: round(c.quote.quote.changePct), as_of: c.quote.quote.asOf, name: c.quote.quote.name } : null,
        fundamentals: c.fundamentals ? { entity: c.fundamentals.entityName, source: c.fundamentals.provider, filings_url: c.fundamentals.filingsUrl, shares_outstanding: c.fundamentals.sharesOutstanding, fiscal_years: c.fundamentals.years } : null,
        fundamentals_note: c.fundamentalsNote,
        valuation: c.valuation,
        price_risk_1y: c.risk,
      };
    },
  }),

  get_portfolio: tool({
    description: "The user's own investment portfolio: positions valued at delayed quotes in USD, P&L, weights, and a one-year risk profile (volatility, beta, VaR, drawdown, concentration, per-holding risk contribution). Also returns the watchlist and any research notes the user has written.",
    schema: z.object({ include_risk: z.boolean().optional() }),
    jsonSchema: { type: 'object', properties: { include_risk: { type: 'boolean', description: 'Include risk analysis (slower). Default true.' } } },
    label: () => 'Reviewing your portfolio',
    run: async (i, { services }) => {
      const pf = await services.markets.portfolio();
      const riskProfile = i.include_risk === false ? undefined : await services.markets.portfolioRisk();
      return {
        base_currency: pf.baseCurrency,
        totals: pf.totals,
        positions: pf.positions.map((p) => ({ symbol: p.symbol, name: p.name, quantity: p.quantity, avg_cost: round(p.avgCost), price: p.price, market_value_usd: round(p.marketValue), weight_pct: round(p.weight === null ? null : p.weight * 100, 1), unrealised_usd: round(p.unrealised), unrealised_pct: round(p.unrealisedPct), as_of: p.asOf, error: p.error })),
        risk: riskProfile && riskProfile.available ? { ...riskProfile, path: undefined, benchmarkPath: undefined, method: 'One year of daily returns at current weights held constant; Sharpe uses a zero risk-free rate.' } : riskProfile,
        watchlist: services.markets.watchlistSymbols().map((w) => w.symbol),
        research_notes: services.markets.notes().map((n) => ({ symbol: n.symbol, title: n.title, stance: n.stance, target_price: n.targetPrice, body: n.body.slice(0, 600), updated: n.updatedAt })),
      };
    },
  }),

  get_personal_dashboard: tool({
    description: "The user's personal data: running log analytics (weekly distance, pace, load ratio, bests), objectives with progress and pace against deadline, open tasks, task completion stats and upcoming deadlines.",
    schema: z.object({}),
    jsonSchema: { type: 'object', properties: {} },
    label: () => 'Reading your personal dashboard',
    run: async (_i, { services, today }) => {
      const p = services.personal.performance(today);
      const { paceSeries, ...fitness } = p.fitness;
      return {
        today,
        fitness: { ...fitness, recent_runs: services.personal.runs().slice(0, 10) },
        objectives: p.objectives.map(({ history, ...o }) => ({ ...o, updates_logged: history.length - 1 })),
        tasks: { stats: { ...p.tasks, daily: undefined }, open: services.personal.tasks().filter((t) => !t.doneAt).slice(0, 30) },
        upcoming_deadlines: p.upcoming,
      };
    },
  }),
};

export type ToolName = keyof typeof TOOLS;

export const TOOL_DEFINITIONS = (Object.keys(TOOLS) as ToolName[]).map((name) => ({
  name,
  description: TOOLS[name].description,
  input_schema: TOOLS[name].jsonSchema,
  eager_input_streaming: true,
}));
