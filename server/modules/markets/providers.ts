import { config } from '../../config.ts';
import { UpstreamError } from '../../lib/errors.ts';
import { fetchJson, fetchText } from '../../lib/http.ts';

export interface Candle {
  /** Bar date (YYYY-MM-DD) for daily+ bars, ISO timestamp for intraday bars. */
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number | null;
}

export interface Quote {
  symbol: string;
  name: string | null;
  currency: string | null;
  exchange: string | null;
  instrumentType: string | null;
  price: number;
  previousClose: number | null;
  change: number | null;
  changePct: number | null;
  dayHigh: number | null;
  dayLow: number | null;
  volume: number | null;
  fiftyTwoWeekHigh: number | null;
  fiftyTwoWeekLow: number | null;
  /** Time of the last trade the provider reported. */
  asOf: string;
  provider: string;
}

export const RANGES = {
  '1D': { range: '1d', interval: '5m' },
  '5D': { range: '5d', interval: '30m' },
  '1M': { range: '1mo', interval: '1d' },
  '6M': { range: '6mo', interval: '1d' },
  'YTD': { range: 'ytd', interval: '1d' },
  '1Y': { range: '1y', interval: '1d' },
  '5Y': { range: '5y', interval: '1wk' },
} as const;
export type RangeKey = keyof typeof RANGES;

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

interface YahooChart {
  chart?: {
    result?: {
      meta?: Record<string, unknown>;
      timestamp?: number[];
      indicators?: { quote?: { open?: (number | null)[]; high?: (number | null)[]; low?: (number | null)[]; close?: (number | null)[]; volume?: (number | null)[] }[] };
    }[];
    error?: { code?: string; description?: string } | null;
  };
}

async function yahooChart(symbol: string, range: string, interval: string) {
  const url = `${config.upstream.yahooChart}/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}&includePrePost=false&events=div%2Csplit`;
  let body: YahooChart;
  try {
    body = await fetchJson<YahooChart>(url, { provider: 'Yahoo Finance', retries: 1 });
  } catch (err) {
    if (err instanceof UpstreamError && err.upstreamStatus === 404) {
      throw new UpstreamError('Yahoo Finance', `no data for symbol "${symbol}"`, 404);
    }
    throw err;
  }
  const result = body.chart?.result?.[0];
  if (!result?.meta) {
    throw new UpstreamError('Yahoo Finance', body.chart?.error?.description ?? `no data for symbol "${symbol}"`, 404);
  }
  const intraday = /m$|h$/.test(interval);
  const q = result.indicators?.quote?.[0] ?? {};
  const offset = (num(result.meta.gmtoffset) ?? 0) * 1000;
  const candles: Candle[] = [];
  (result.timestamp ?? []).forEach((ts, i) => {
    const c = num(q.close?.[i]);
    if (c === null) return; // halted / not-yet-traded bars come back null
    const o = num(q.open?.[i]) ?? c;
    candles.push({
      // Daily bars are stamped in exchange-local time so the date is the session date.
      t: intraday ? new Date(ts * 1000).toISOString() : new Date(ts * 1000 + offset).toISOString().slice(0, 10),
      o,
      h: num(q.high?.[i]) ?? Math.max(o, c),
      l: num(q.low?.[i]) ?? Math.min(o, c),
      c,
      v: num(q.volume?.[i]),
    });
  });
  return { meta: result.meta, candles, offset };
}

export async function yahooHistory(symbol: string, key: RangeKey) {
  const { range, interval } = RANGES[key];
  const { meta, candles } = await yahooChart(symbol, range, interval);
  return {
    candles,
    currency: (meta.currency as string) ?? null,
    name: (meta.longName as string) ?? (meta.shortName as string) ?? null,
    provider: 'Yahoo Finance',
  };
}

export async function yahooQuote(symbol: string): Promise<Quote> {
  const { meta, candles, offset } = await yahooChart(symbol, '5d', '1d');
  const price = num(meta.regularMarketPrice) ?? candles.at(-1)?.c ?? null;
  const time = num(meta.regularMarketTime);
  if (price === null || time === null) throw new UpstreamError('Yahoo Finance', `no quote for "${symbol}"`, 404);
  // Previous close = last daily bar from a session before the latest trade's session.
  const session = new Date(time * 1000 + offset).toISOString().slice(0, 10);
  const prior = candles.filter((c) => c.t < session).at(-1);
  const previousClose = prior?.c ?? num(meta.chartPreviousClose);
  const change = previousClose !== null ? price - previousClose : null;
  return {
    symbol: String(meta.symbol ?? symbol).toUpperCase(),
    name: (meta.longName as string) ?? (meta.shortName as string) ?? null,
    currency: (meta.currency as string) ?? null,
    exchange: (meta.fullExchangeName as string) ?? (meta.exchangeName as string) ?? null,
    instrumentType: (meta.instrumentType as string) ?? null,
    price,
    previousClose,
    change,
    changePct: change !== null && previousClose ? (change / previousClose) * 100 : null,
    dayHigh: num(meta.regularMarketDayHigh),
    dayLow: num(meta.regularMarketDayLow),
    volume: num(meta.regularMarketVolume),
    fiftyTwoWeekHigh: num(meta.fiftyTwoWeekHigh),
    fiftyTwoWeekLow: num(meta.fiftyTwoWeekLow),
    asOf: new Date(time * 1000).toISOString(),
    provider: 'Yahoo Finance',
  };
}

export interface SearchHit {
  symbol: string;
  name: string;
  exchange: string | null;
  type: string | null;
}

export async function yahooSearch(q: string): Promise<SearchHit[]> {
  const url = `${config.upstream.yahooSearch}/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=8&newsCount=0&listsCount=0`;
  const body = await fetchJson<{ quotes?: Record<string, unknown>[] }>(url, { provider: 'Yahoo Finance', retries: 0, timeoutMs: 8000 });
  return (body.quotes ?? [])
    .filter((x) => typeof x.symbol === 'string')
    .map((x) => ({
      symbol: String(x.symbol),
      name: String(x.longname ?? x.shortname ?? x.symbol),
      exchange: (x.exchDisp as string) ?? (x.exchange as string) ?? null,
      type: (x.typeDisp as string) ?? (x.quoteType as string) ?? null,
    }));
}

// ---- Stooq (fallback, end-of-day) -------------------------------------------

/** Stooq uses lower-case tickers with a market suffix; plain US tickers need ".us". */
function stooqSymbol(symbol: string): string | null {
  if (/^\^/.test(symbol)) return ({ '^GSPC': '^spx', '^DJI': '^dji', '^IXIC': '^ndq', '^FTSE': '^ukx', '^GDAXI': '^dax', '^N225': '^nkx' } as Record<string, string>)[symbol] ?? null;
  if (/[=]/.test(symbol)) return null;
  if (/^[A-Z]{1,5}(-[A-Z])?$/.test(symbol)) return `${symbol.toLowerCase().replace('-', '-')}.us`;
  const m = symbol.match(/^([A-Z0-9]+)\.(L|DE|PA|TO|HK|T)$/);
  if (m) return `${m[1]!.toLowerCase()}.${{ L: 'uk', DE: 'de', PA: 'fr', TO: 'ca', HK: 'hk', T: 'jp' }[m[2] as 'L']}`;
  return null;
}

function parseStooqCsv(csv: string): Candle[] {
  const lines = csv.trim().split(/\r?\n/);
  if (lines.length < 2 || !/^Date,Open,High,Low,Close/i.test(lines[0] ?? '')) return [];
  const out: Candle[] = [];
  for (const line of lines.slice(1)) {
    const [t, o, h, l, c, v] = line.split(',');
    const close = Number(c);
    if (!t || !Number.isFinite(close)) continue;
    out.push({ t, o: Number(o), h: Number(h), l: Number(l), c: close, v: v && Number.isFinite(Number(v)) ? Number(v) : null });
  }
  return out;
}

const RANGE_DAYS: Record<RangeKey, number> = { '1D': 5, '5D': 8, '1M': 31, '6M': 183, 'YTD': 366, '1Y': 366, '5Y': 1830 };

export async function stooqHistory(symbol: string, key: RangeKey) {
  const s = stooqSymbol(symbol);
  if (!s) throw new UpstreamError('Stooq', `symbol "${symbol}" is not covered`, 404);
  const to = new Date();
  let from = new Date(to.getTime() - RANGE_DAYS[key] * 86_400_000);
  if (key === 'YTD') from = new Date(Date.UTC(to.getUTCFullYear(), 0, 1));
  const fmt = (d: Date) => d.toISOString().slice(0, 10).replaceAll('-', '');
  const url = `${config.upstream.stooq}/q/d/l/?s=${encodeURIComponent(s)}&i=${key === '5Y' ? 'w' : 'd'}&d1=${fmt(from)}&d2=${fmt(to)}`;
  const candles = parseStooqCsv(await fetchText(url, { provider: 'Stooq', retries: 0 }));
  if (candles.length === 0) throw new UpstreamError('Stooq', `no data for symbol "${symbol}"`, 404);
  return { candles, currency: null, name: null, provider: 'Stooq (end-of-day)' };
}

export async function stooqQuote(symbol: string): Promise<Quote> {
  const { candles } = await stooqHistory(symbol, '1M');
  const last = candles.at(-1)!;
  const prev = candles.at(-2) ?? null;
  const change = prev ? last.c - prev.c : null;
  return {
    symbol,
    name: null,
    currency: null,
    exchange: null,
    instrumentType: null,
    price: last.c,
    previousClose: prev?.c ?? null,
    change,
    changePct: change !== null && prev ? (change / prev.c) * 100 : null,
    dayHigh: last.h,
    dayLow: last.l,
    volume: last.v,
    fiftyTwoWeekHigh: null,
    fiftyTwoWeekLow: null,
    // Stooq gives a session date only; stamp the close of that UTC day.
    asOf: `${last.t}T21:00:00.000Z`,
    provider: 'Stooq (end-of-day)',
  };
}
