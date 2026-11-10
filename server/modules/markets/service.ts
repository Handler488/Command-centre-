import { type DB, nowIso } from '../../db.ts';
import type { Cache } from '../../lib/cache.ts';
import { AppError, badRequest, notFound, UpstreamError } from '../../lib/errors.ts';
import { mapLimit } from '../../lib/http.ts';
import { type Candle, type Quote, type RangeKey, RANGES, stooqHistory, stooqQuote, yahooHistory, yahooQuote, yahooSearch } from './providers.ts';
import * as risk from './risk.ts';
import { SecClient } from './sec.ts';

export const BENCHMARK = '^GSPC';
export const MARKET_BOARD = [
  { symbol: '^GSPC', label: 'S&P 500', group: 'Equities' },
  { symbol: '^IXIC', label: 'Nasdaq Composite', group: 'Equities' },
  { symbol: '^DJI', label: 'Dow Jones', group: 'Equities' },
  { symbol: '^FTSE', label: 'FTSE 100', group: 'Equities' },
  { symbol: '^GDAXI', label: 'DAX', group: 'Equities' },
  { symbol: '^N225', label: 'Nikkei 225', group: 'Equities' },
  { symbol: '^TNX', label: 'US 10Y yield', group: 'Rates & FX' },
  { symbol: 'EURUSD=X', label: 'EUR/USD', group: 'Rates & FX' },
  { symbol: 'GBPUSD=X', label: 'GBP/USD', group: 'Rates & FX' },
  { symbol: 'USDJPY=X', label: 'USD/JPY', group: 'Rates & FX' },
  { symbol: 'GC=F', label: 'Gold', group: 'Commodities & crypto' },
  { symbol: 'CL=F', label: 'WTI crude', group: 'Commodities & crypto' },
  { symbol: 'BTC-USD', label: 'Bitcoin', group: 'Commodities & crypto' },
];

export interface QuoteEnvelope {
  quote: Quote;
  /** When this platform fetched the quote from the provider. */
  fetchedAt: string;
  /** True when the provider is unreachable and this is the last known value. */
  stale: boolean;
}

const SYMBOL_RE = /^[A-Z0-9^][A-Z0-9.\-=^]{0,14}$/;
export function normaliseSymbol(raw: string): string {
  const s = raw.trim().toUpperCase();
  if (!SYMBOL_RE.test(s)) throw badRequest(`"${raw}" is not a valid ticker symbol`);
  return s;
}

export class MarketsService {
  readonly sec: SecClient;
  constructor(
    private db: DB,
    private cache: Cache,
  ) {
    this.sec = new SecClient(cache);
  }

  // ---- market data -----------------------------------------------------------

  async quote(symbolRaw: string): Promise<QuoteEnvelope> {
    const symbol = normaliseSymbol(symbolRaw);
    const hit = await this.cache.wrap<Quote>(`quote:${symbol}`, 60_000, async () => {
      try {
        return await yahooQuote(symbol);
      } catch (primary) {
        // An unknown symbol is a definitive answer; only fall back on outages.
        if (primary instanceof UpstreamError && primary.upstreamStatus === 404) throw primary;
        try {
          return await stooqQuote(symbol);
        } catch {
          throw primary;
        }
      }
    });
    return { quote: hit.value, fetchedAt: new Date(hit.storedAt).toISOString(), stale: hit.stale };
  }

  /** Quotes for many symbols; failures are reported per symbol, never thrown. */
  async quotes(symbols: string[]) {
    const unique = [...new Set(symbols.map(normaliseSymbol))];
    const results = await mapLimit(unique, 5, async (symbol) => {
      try {
        return { symbol, ...(await this.quote(symbol)), error: null as string | null };
      } catch (err) {
        return { symbol, quote: null, fetchedAt: null, stale: false, error: err instanceof Error ? err.message : 'unavailable' };
      }
    });
    return results;
  }

  async history(symbolRaw: string, range: RangeKey) {
    const symbol = normaliseSymbol(symbolRaw);
    if (!(range in RANGES)) throw badRequest(`Unknown range "${range}"`);
    const ttl = range === '1D' || range === '5D' ? 5 * 60_000 : 60 * 60_000;
    const hit = await this.cache.wrap(`hist:${symbol}:${range}`, ttl, async () => {
      try {
        return await yahooHistory(symbol, range);
      } catch (primary) {
        if (primary instanceof UpstreamError && primary.upstreamStatus === 404) throw primary;
        try {
          return await stooqHistory(symbol, range);
        } catch {
          throw primary;
        }
      }
    });
    return { symbol, range, ...hit.value, fetchedAt: new Date(hit.storedAt).toISOString(), stale: hit.stale };
  }

  async search(q: string) {
    const term = q.trim();
    if (term.length < 1) return [];
    return (await this.cache.wrap(`search:${term.toLowerCase()}`, 6 * 3_600_000, () => yahooSearch(term))).value;
  }

  board() {
    return this.quotes(MARKET_BOARD.map((b) => b.symbol)).then((rows) =>
      MARKET_BOARD.map((b) => ({ ...b, ...(rows.find((r) => r.symbol === b.symbol) ?? { quote: null, error: 'unavailable', stale: false, fetchedAt: null }) })),
    );
  }

  /** Company profile: quote, filed fundamentals, valuation multiples and price-risk stats. */
  async company(symbolRaw: string) {
    const symbol = normaliseSymbol(symbolRaw);
    const [quoteR, fundR, histR, benchR] = await Promise.allSettled([
      this.quote(symbol),
      this.sec.fundamentals(symbol),
      this.history(symbol, '1Y'),
      this.history(BENCHMARK, '1Y'),
    ]);
    if (quoteR.status === 'rejected' && histR.status === 'rejected') throw quoteR.reason;
    const quote = quoteR.status === 'fulfilled' ? quoteR.value : null;
    const fundamentals = fundR.status === 'fulfilled' && fundR.value ? { ...fundR.value.value, stale: fundR.value.stale } : null;
    const price = quote?.quote.price ?? null;
    const last = fundamentals?.years.at(-1) ?? null;
    const marketCap = price !== null && fundamentals?.sharesOutstanding ? price * fundamentals.sharesOutstanding : null;
    const valuation = fundamentals
      ? {
          marketCap,
          priceToEarnings: price !== null && last?.epsDiluted && last.epsDiluted > 0 ? price / last.epsDiluted : null,
          priceToSales: marketCap !== null && last?.revenue ? marketCap / last.revenue : null,
          priceToBook: marketCap !== null && last?.equity && last.equity > 0 ? marketCap / last.equity : null,
          freeCashFlowYield: marketCap !== null && last?.freeCashFlow != null ? last.freeCashFlow / marketCap : null,
          basis: `Latest price against fiscal year ending ${last?.periodEnd ?? 'n/a'}`,
        }
      : null;
    let riskStats = null;
    if (histR.status === 'fulfilled') {
      const series: Record<string, Candle[]> = { [symbol]: histR.value.candles };
      if (benchR.status === 'fulfilled' && symbol !== BENCHMARK) series[BENCHMARK] = benchR.value.candles;
      const { closes, dates } = risk.alignCloses(series);
      const r = risk.dailyReturns(closes[symbol] ?? []);
      const rb = closes[BENCHMARK] ? risk.dailyReturns(closes[BENCHMARK]) : null;
      riskStats = {
        observations: r.length,
        from: dates[0] ?? null,
        to: dates.at(-1) ?? null,
        annualisedVolatility: r.length >= 20 ? risk.annualisedVolatility(r) : null,
        maxDrawdown: r.length >= 20 ? risk.maxDrawdown(closes[symbol] ?? []) : null,
        valueAtRisk95: risk.historicalVaR(r),
        beta: rb ? risk.beta(r, rb) : null,
        sharpe: risk.sharpe(r),
        benchmark: BENCHMARK,
      };
    }
    return {
      symbol,
      quote,
      fundamentals,
      fundamentalsNote:
        fundR.status === 'rejected'
          ? `Fundamentals unavailable: ${fundR.reason instanceof Error ? fundR.reason.message : 'provider error'}`
          : fundR.value === null
            ? 'No SEC filings for this symbol. Fundamentals cover US-registered companies only.'
            : null,
      valuation,
      risk: riskStats,
    };
  }

  // ---- watchlist -------------------------------------------------------------

  watchlistSymbols(): { symbol: string; name: string | null; addedAt: string }[] {
    return this.db.prepare('SELECT symbol, name, added_at FROM watchlist ORDER BY added_at').all().map((r) => ({ symbol: String(r.symbol), name: r.name as string | null, addedAt: String(r.added_at) }));
  }

  async watchlist() {
    const items = this.watchlistSymbols();
    const quotes = await this.quotes(items.map((i) => i.symbol));
    return items.map((i) => ({ ...i, ...(quotes.find((q) => q.symbol === i.symbol) ?? { quote: null, error: 'unavailable', stale: false, fetchedAt: null }) }));
  }

  /** Adds a symbol after confirming a provider actually knows it. */
  async addToWatchlist(symbolRaw: string) {
    const symbol = normaliseSymbol(symbolRaw);
    if (this.db.prepare('SELECT 1 FROM watchlist WHERE symbol = ?').get(symbol)) throw new AppError(409, 'conflict', `${symbol} is already on the watchlist`);
    const { quote } = await this.quote(symbol);
    this.db.prepare('INSERT INTO watchlist (symbol, name, added_at) VALUES (?, ?, ?)').run(symbol, quote.name, nowIso());
    return { symbol, name: quote.name };
  }

  removeFromWatchlist(symbolRaw: string) {
    const res = this.db.prepare('DELETE FROM watchlist WHERE symbol = ?').run(normaliseSymbol(symbolRaw));
    if (res.changes === 0) throw notFound('Watchlist entry');
  }

  // ---- portfolio -------------------------------------------------------------

  transactions() {
    return this.db.prepare('SELECT * FROM transactions ORDER BY traded_on DESC, id DESC').all().map((r) => ({
      id: Number(r.id),
      symbol: String(r.symbol),
      side: String(r.side) as 'buy' | 'sell',
      quantity: Number(r.quantity),
      price: Number(r.price),
      fee: Number(r.fee),
      tradedOn: String(r.traded_on),
      note: String(r.note),
    }));
  }

  private lotsBySymbol() {
    const bySymbol = new Map<string, ReturnType<MarketsService['transactions']>>();
    for (const t of [...this.transactions()].reverse()) bySymbol.set(t.symbol, [...(bySymbol.get(t.symbol) ?? []), t]);
    return bySymbol;
  }

  addTransaction(input: { symbol: string; side: 'buy' | 'sell'; quantity: number; price: number; fee?: number; tradedOn: string; note?: string }) {
    const symbol = normaliseSymbol(input.symbol);
    if (input.tradedOn > new Date().toISOString().slice(0, 10)) throw badRequest('Trade date cannot be in the future');
    const lots = [...(this.lotsBySymbol().get(symbol) ?? []), { ...input, fee: input.fee ?? 0, tradedOn: input.tradedOn, id: Infinity }]
      .sort((a, b) => a.tradedOn.localeCompare(b.tradedOn) || a.id - b.id);
    try {
      risk.positionFromLots(lots.map((l) => ({ side: l.side, quantity: l.quantity, price: l.price, fee: l.fee ?? 0 })));
    } catch {
      throw badRequest(`Cannot sell ${input.quantity} ${symbol}: that is more than the position held on ${input.tradedOn}`);
    }
    const res = this.db
      .prepare('INSERT INTO transactions (symbol, side, quantity, price, fee, traded_on, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(symbol, input.side, input.quantity, input.price, input.fee ?? 0, input.tradedOn, input.note ?? '', nowIso());
    return { id: Number(res.lastInsertRowid) };
  }

  deleteTransaction(id: number) {
    const row = this.db.prepare('SELECT symbol FROM transactions WHERE id = ?').get(id);
    if (!row) throw notFound('Transaction');
    const remaining = (this.lotsBySymbol().get(String(row.symbol)) ?? []).filter((t) => t.id !== id);
    try {
      risk.positionFromLots(remaining);
    } catch {
      throw badRequest('Deleting this buy would leave later sells without shares to sell. Delete the sells first.');
    }
    this.db.prepare('DELETE FROM transactions WHERE id = ?').run(id);
  }

  /** FX rate from a quote currency into USD; null when unavailable. */
  private async toUsd(currency: string | null): Promise<{ rate: number | null; unitDivisor: number }> {
    if (!currency || currency === 'USD') return { rate: 1, unitDivisor: 1 };
    // London prices are quoted in pence ("GBp"/"GBX").
    const pence = currency === 'GBp' || currency === 'GBX';
    const iso = pence ? 'GBP' : currency.toUpperCase();
    try {
      const { quote } = await this.quote(`${iso}USD=X`);
      return { rate: quote.price, unitDivisor: pence ? 100 : 1 };
    } catch {
      return { rate: null, unitDivisor: pence ? 100 : 1 };
    }
  }

  /** Positions valued at the latest quotes, in USD. */
  async portfolio() {
    const lots = this.lotsBySymbol();
    const symbols = [...lots.keys()];
    const quotes = await this.quotes(symbols);
    const positions = await mapLimit(symbols, 4, async (symbol) => {
      const pos = risk.positionFromLots(lots.get(symbol)!);
      const q = quotes.find((x) => x.symbol === symbol);
      const quote = q?.quote ?? null;
      const fx = await this.toUsd(quote?.currency ?? null);
      const usd = quote && fx.rate !== null ? (quote.price / fx.unitDivisor) * fx.rate : null;
      const marketValue = usd !== null ? usd * pos.quantity : null;
      const dayChange = quote?.change != null && fx.rate !== null ? (quote.change / fx.unitDivisor) * fx.rate * pos.quantity : null;
      return {
        symbol,
        name: quote?.name ?? null,
        currency: quote?.currency ?? null,
        quantity: pos.quantity,
        avgCost: pos.avgCost,
        costBasis: pos.costBasis,
        realised: pos.realised,
        price: quote?.price ?? null,
        priceUsd: usd,
        marketValue,
        unrealised: marketValue !== null ? marketValue - pos.costBasis : null,
        unrealisedPct: marketValue !== null && pos.costBasis > 0 ? (marketValue / pos.costBasis - 1) * 100 : null,
        dayChange,
        changePct: quote?.changePct ?? null,
        asOf: quote?.asOf ?? null,
        provider: quote?.provider ?? null,
        stale: q?.stale ?? false,
        error: q?.error ?? (quote && fx.rate === null ? `No FX rate for ${quote.currency}` : null),
        weight: null as number | null,
      };
    });
    const open = positions.filter((p) => p.quantity > 0);
    const valued = open.filter((p) => p.marketValue !== null);
    const marketValue = valued.reduce((a, p) => a + p.marketValue!, 0);
    for (const p of valued) p.weight = marketValue > 0 ? p.marketValue! / marketValue : null;
    const costBasis = valued.reduce((a, p) => a + p.costBasis, 0);
    return {
      baseCurrency: 'USD',
      costBasisNote: 'Cost basis uses the prices you entered, assumed to be in USD.',
      positions: open.sort((a, b) => (b.marketValue ?? 0) - (a.marketValue ?? 0)),
      closed: positions.filter((p) => p.quantity === 0).map((p) => ({ symbol: p.symbol, realised: p.realised })),
      totals: {
        marketValue: valued.length ? marketValue : null,
        costBasis,
        unrealised: valued.length ? marketValue - costBasis : null,
        unrealisedPct: valued.length && costBasis > 0 ? (marketValue / costBasis - 1) * 100 : null,
        dayChange: valued.some((p) => p.dayChange !== null) ? valued.reduce((a, p) => a + (p.dayChange ?? 0), 0) : null,
        realised: positions.reduce((a, p) => a + p.realised, 0),
        unpricedPositions: open.length - valued.length,
      },
    };
  }

  /**
   * One-year risk profile of the current holdings. Uses today's weights held
   * constant over the lookback (a standard simplification, stated in the UI).
   */
  async portfolioRisk() {
    const pf = await this.portfolio();
    const held = pf.positions.filter((p) => p.weight !== null);
    if (held.length === 0) return { available: false as const, reason: 'Add a priced position to analyse portfolio risk.' };
    const symbols = held.map((p) => p.symbol);
    const histories = await mapLimit([...symbols, BENCHMARK], 4, async (s) => {
      try {
        return [s, (await this.history(s, '1Y')).candles] as const;
      } catch {
        return [s, null] as const;
      }
    });
    const missing = histories.filter(([s, c]) => !c && s !== BENCHMARK).map(([s]) => s);
    const series = Object.fromEntries(histories.filter(([, c]) => c).map(([s, c]) => [s, c!]));
    const usable = symbols.filter((s) => series[s]);
    if (usable.length === 0) return { available: false as const, reason: 'Price history is unavailable for every holding right now.' };
    const { dates, closes } = risk.alignCloses(series);
    if (dates.length < 30) return { available: false as const, reason: 'Not enough overlapping price history across holdings (need 30+ trading days).' };

    const wSum = held.filter((p) => usable.includes(p.symbol)).reduce((a, p) => a + p.weight!, 0);
    const weights = Object.fromEntries(held.filter((p) => usable.includes(p.symbol)).map((p) => [p.symbol, p.weight! / wSum]));
    const returns = Object.fromEntries(usable.map((s) => [s, risk.dailyReturns(closes[s]!)]));
    const n = returns[usable[0]!]!.length;
    const pfReturns = Array.from({ length: n }, (_, i) => usable.reduce((a, s) => a + weights[s]! * returns[s]![i]!, 0));
    const benchReturns = closes[BENCHMARK] ? risk.dailyReturns(closes[BENCHMARK]) : null;
    const pfVar = risk.covariance(pfReturns, pfReturns);

    // Indexed value path of the constant-weight portfolio (start = 100).
    const path: { t: string; v: number }[] = [{ t: dates[0]!, v: 100 }];
    pfReturns.forEach((r, i) => path.push({ t: dates[i + 1]!, v: path[i]!.v * (1 + r) }));
    const benchPath = closes[BENCHMARK] ? closes[BENCHMARK].map((c, i) => ({ t: dates[i]!, v: (c / closes[BENCHMARK]![0]!) * 100 })) : null;

    return {
      available: true as const,
      from: dates[0]!,
      to: dates.at(-1)!,
      observations: n,
      missing,
      benchmark: BENCHMARK,
      annualisedVolatility: risk.annualisedVolatility(pfReturns),
      valueAtRisk95: risk.historicalVaR(pfReturns),
      valueAtRisk95Usd: pf.totals.marketValue !== null && risk.historicalVaR(pfReturns) !== null ? pf.totals.marketValue * risk.historicalVaR(pfReturns)! : null,
      maxDrawdown: risk.maxDrawdown(path.map((p) => p.v)),
      beta: benchReturns ? risk.beta(pfReturns, benchReturns) : null,
      sharpe: risk.sharpe(pfReturns),
      concentration: risk.concentration(Object.values(weights)),
      effectiveHoldings: 1 / risk.concentration(Object.values(weights)),
      holdings: usable.map((s) => ({
        symbol: s,
        weight: weights[s]!,
        annualisedVolatility: risk.annualisedVolatility(returns[s]!),
        beta: benchReturns ? risk.beta(returns[s]!, benchReturns) : null,
        maxDrawdown: risk.maxDrawdown(closes[s]!),
        // Share of total portfolio variance attributable to this holding.
        riskContribution: pfVar > 0 ? (weights[s]! * risk.covariance(returns[s]!, pfReturns)) / pfVar : null,
      })),
      correlation: { symbols: usable, matrix: usable.map((a) => usable.map((b) => (a === b ? 1 : risk.correlation(returns[a]!, returns[b]!)))) },
      path,
      benchmarkPath: benchPath,
    };
  }

  // ---- research notes --------------------------------------------------------

  notes(symbol?: string) {
    const rows = symbol
      ? this.db.prepare('SELECT * FROM research_notes WHERE symbol = ? ORDER BY updated_at DESC').all(normaliseSymbol(symbol))
      : this.db.prepare('SELECT * FROM research_notes ORDER BY updated_at DESC').all();
    return rows.map((r) => ({
      id: Number(r.id),
      symbol: String(r.symbol),
      title: String(r.title),
      body: String(r.body),
      stance: String(r.stance) as 'bullish' | 'neutral' | 'bearish',
      targetPrice: r.target_price === null ? null : Number(r.target_price),
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    }));
  }

  saveNote(input: { id?: number; symbol: string; title: string; body: string; stance: string; targetPrice?: number | null }) {
    const symbol = normaliseSymbol(input.symbol);
    const now = nowIso();
    if (input.id) {
      const res = this.db
        .prepare('UPDATE research_notes SET symbol = ?, title = ?, body = ?, stance = ?, target_price = ?, updated_at = ? WHERE id = ?')
        .run(symbol, input.title, input.body, input.stance, input.targetPrice ?? null, now, input.id);
      if (res.changes === 0) throw notFound('Note');
      return { id: input.id };
    }
    const res = this.db
      .prepare('INSERT INTO research_notes (symbol, title, body, stance, target_price, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(symbol, input.title, input.body, input.stance, input.targetPrice ?? null, now, now);
    return { id: Number(res.lastInsertRowid) };
  }

  deleteNote(id: number) {
    if (this.db.prepare('DELETE FROM research_notes WHERE id = ?').run(id).changes === 0) throw notFound('Note');
  }
}
