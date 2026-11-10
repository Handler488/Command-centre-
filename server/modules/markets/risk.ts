/**
 * Portfolio and single-asset risk statistics computed from daily closes.
 * Pure functions: everything here is unit-tested against hand-worked values.
 */
const TRADING_DAYS = 252;

export function dailyReturns(closes: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const prev = closes[i - 1]!;
    if (prev > 0) out.push(closes[i]! / prev - 1);
  }
  return out;
}

export const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
}

export function covariance(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;
  const ma = mean(a.slice(0, n));
  const mb = mean(b.slice(0, n));
  let s = 0;
  for (let i = 0; i < n; i++) s += (a[i]! - ma) * (b[i]! - mb);
  return s / (n - 1);
}

export function correlation(a: number[], b: number[]): number | null {
  const n = Math.min(a.length, b.length);
  const sa = stdev(a.slice(0, n));
  const sb = stdev(b.slice(0, n));
  if (n < 2 || sa === 0 || sb === 0) return null;
  return covariance(a, b) / (sa * sb);
}

export const annualisedVolatility = (returns: number[]) => stdev(returns) * Math.sqrt(TRADING_DAYS);

/** Largest peak-to-trough decline, as a negative fraction (e.g. -0.23). */
export function maxDrawdown(closes: number[]): number {
  let peak = -Infinity;
  let worst = 0;
  for (const c of closes) {
    if (c > peak) peak = c;
    if (peak > 0) worst = Math.min(worst, c / peak - 1);
  }
  return worst;
}

/** One-day historical value-at-risk at the given confidence, as a negative fraction. */
export function historicalVaR(returns: number[], confidence = 0.95): number | null {
  if (returns.length < 20) return null;
  const sorted = [...returns].sort((a, b) => a - b);
  const idx = Math.floor((1 - confidence) * sorted.length);
  return Math.min(0, sorted[Math.min(idx, sorted.length - 1)]!);
}

export function beta(asset: number[], benchmark: number[]): number | null {
  const n = Math.min(asset.length, benchmark.length);
  if (n < 20) return null;
  const varB = covariance(benchmark.slice(-n), benchmark.slice(-n));
  if (varB === 0) return null;
  return covariance(asset.slice(-n), benchmark.slice(-n)) / varB;
}

/** Sharpe ratio with a zero risk-free rate (stated as such wherever shown). */
export function sharpe(returns: number[]): number | null {
  const sd = stdev(returns);
  if (returns.length < 20 || sd === 0) return null;
  return (mean(returns) * TRADING_DAYS) / (sd * Math.sqrt(TRADING_DAYS));
}

/** Herfindahl-Hirschman index of weights (1/n = evenly spread, 1 = single holding). */
export const concentration = (weights: number[]) => weights.reduce((a, w) => a + w * w, 0);

/**
 * Align several close series on the dates they all share, so cross-asset
 * statistics never compare different trading days.
 */
export function alignCloses(series: Record<string, { t: string; c: number }[]>): { dates: string[]; closes: Record<string, number[]> } {
  const symbols = Object.keys(series);
  if (symbols.length === 0) return { dates: [], closes: {} };
  const maps = symbols.map((s) => new Map(series[s]!.map((p) => [p.t, p.c])));
  const dates = [...maps[0]!.keys()].filter((d) => maps.every((m) => m.has(d))).sort();
  const closes: Record<string, number[]> = {};
  symbols.forEach((s, i) => {
    closes[s] = dates.map((d) => maps[i]!.get(d)!);
  });
  return { dates, closes };
}

export interface Lot {
  side: 'buy' | 'sell';
  quantity: number;
  price: number;
  fee: number;
}

/**
 * Average-cost position accounting. Sells realise P&L against the running
 * average cost; fees on buys are capitalised into cost, fees on sells reduce
 * proceeds. Selling more than is held throws rather than going short.
 */
export function positionFromLots(lots: Lot[]): { quantity: number; costBasis: number; avgCost: number; realised: number } {
  let quantity = 0;
  let costBasis = 0;
  let realised = 0;
  for (const lot of lots) {
    if (lot.side === 'buy') {
      quantity += lot.quantity;
      costBasis += lot.quantity * lot.price + lot.fee;
    } else {
      if (lot.quantity > quantity + 1e-9) throw new Error('sell exceeds held quantity');
      const avg = quantity > 0 ? costBasis / quantity : 0;
      realised += lot.quantity * (lot.price - avg) - lot.fee;
      quantity -= lot.quantity;
      costBasis -= lot.quantity * avg;
      if (quantity < 1e-9) {
        quantity = 0;
        costBasis = 0;
      }
    }
  }
  return { quantity, costBasis, avgCost: quantity > 0 ? costBasis / quantity : 0, realised };
}
