import { config } from '../../config.ts';
import type { Cache } from '../../lib/cache.ts';
import { UpstreamError } from '../../lib/errors.ts';
import { fetchJson } from '../../lib/http.ts';

/**
 * Company fundamentals from SEC EDGAR XBRL "company facts": the figures
 * companies themselves file in their 10-K annual reports. US registrants only.
 */
interface Fact {
  start?: string;
  end: string;
  val: number;
  fy?: number;
  fp?: string;
  form?: string;
  filed?: string;
}
type Facts = Record<string, Record<string, { units?: Record<string, Fact[]> }>>;

const CONCEPTS = {
  revenue: ['RevenueFromContractWithCustomerExcludingAssessedTax', 'Revenues', 'SalesRevenueNet', 'RevenueFromContractWithCustomerIncludingAssessedTax'],
  grossProfit: ['GrossProfit'],
  operatingIncome: ['OperatingIncomeLoss'],
  netIncome: ['NetIncomeLoss', 'ProfitLoss'],
  epsDiluted: ['EarningsPerShareDiluted'],
  operatingCashFlow: ['NetCashProvidedByUsedInOperatingActivities'],
  capex: ['PaymentsToAcquirePropertyPlantAndEquipment', 'PaymentsToAcquireProductiveAssets'],
  totalAssets: ['Assets'],
  totalLiabilities: ['Liabilities'],
  equity: ['StockholdersEquity', 'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest'],
  cash: ['CashAndCashEquivalentsAtCarryingValue', 'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents'],
  longTermDebt: ['LongTermDebtNoncurrent', 'LongTermDebt'],
} as const;
type Metric = keyof typeof CONCEPTS;
const INSTANT: Metric[] = ['totalAssets', 'totalLiabilities', 'equity', 'cash', 'longTermDebt'];

const daysBetween = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 86_400_000;

/** Annual values keyed by period end date, from 10-K filings; latest filing wins on restatement. */
function annualSeries(facts: Facts, metric: Metric): Map<string, number> {
  const out = new Map<string, { val: number; filed: string; rank: number }>();
  CONCEPTS[metric].forEach((concept, rank) => {
    const units = facts['us-gaap']?.[concept]?.units;
    const rows = units?.USD ?? units?.['USD/shares'];
    if (!rows) return;
    for (const f of rows) {
      if (!f.form?.startsWith('10-K') && f.form !== '20-F' && f.form !== '40-F') continue;
      if (INSTANT.includes(metric)) {
        if (f.start) continue;
      } else {
        if (!f.start) continue;
        const d = daysBetween(f.start, f.end);
        if (d < 340 || d > 380) continue; // full fiscal years only
      }
      // Preferred concepts win; within a concept the latest filing (restatement) wins.
      const prev = out.get(f.end);
      const filed = f.filed ?? '';
      if (!prev || rank < prev.rank || (rank === prev.rank && filed > prev.filed)) out.set(f.end, { val: f.val, filed, rank });
    }
  });
  return new Map([...out.entries()].map(([k, v]) => [k, v.val]));
}

export interface FiscalYear {
  periodEnd: string;
  revenue: number | null;
  grossProfit: number | null;
  operatingIncome: number | null;
  netIncome: number | null;
  epsDiluted: number | null;
  operatingCashFlow: number | null;
  capex: number | null;
  freeCashFlow: number | null;
  totalAssets: number | null;
  totalLiabilities: number | null;
  equity: number | null;
  cash: number | null;
  longTermDebt: number | null;
  grossMargin: number | null;
  operatingMargin: number | null;
  netMargin: number | null;
  returnOnEquity: number | null;
  debtToEquity: number | null;
  revenueGrowth: number | null;
}

export interface Fundamentals {
  symbol: string;
  cik: string;
  entityName: string;
  years: FiscalYear[];
  sharesOutstanding: number | null;
  filingsUrl: string;
  provider: string;
}

const ratio = (a: number | null, b: number | null) => (a !== null && b !== null && b !== 0 ? a / b : null);

export function buildFundamentals(symbol: string, cik: string, body: { entityName?: string; facts?: Facts }): Fundamentals {
  const facts = body.facts ?? {};
  const series = Object.fromEntries((Object.keys(CONCEPTS) as Metric[]).map((m) => [m, annualSeries(facts, m)])) as Record<Metric, Map<string, number>>;
  // Fiscal years are anchored on periods that have an income statement.
  const ends = [...new Set([...series.revenue.keys(), ...series.netIncome.keys()])].sort().slice(-6);
  const years: FiscalYear[] = ends.map((end) => {
    const g = (m: Metric) => series[m].get(end) ?? null;
    const revenue = g('revenue');
    const ocf = g('operatingCashFlow');
    const capex = g('capex');
    return {
      periodEnd: end,
      revenue,
      grossProfit: g('grossProfit'),
      operatingIncome: g('operatingIncome'),
      netIncome: g('netIncome'),
      epsDiluted: g('epsDiluted'),
      operatingCashFlow: ocf,
      capex,
      freeCashFlow: ocf !== null && capex !== null ? ocf - capex : null,
      totalAssets: g('totalAssets'),
      totalLiabilities: g('totalLiabilities'),
      equity: g('equity'),
      cash: g('cash'),
      longTermDebt: g('longTermDebt'),
      grossMargin: ratio(g('grossProfit'), revenue),
      operatingMargin: ratio(g('operatingIncome'), revenue),
      netMargin: ratio(g('netIncome'), revenue),
      returnOnEquity: ratio(g('netIncome'), g('equity')),
      debtToEquity: ratio(g('longTermDebt'), g('equity')),
      revenueGrowth: null,
    };
  });
  years.forEach((y, i) => {
    const prev = years[i - 1];
    if (prev && y.revenue !== null && prev.revenue) y.revenueGrowth = y.revenue / prev.revenue - 1;
  });
  const shares = facts.dei?.EntityCommonStockSharesOutstanding?.units?.shares;
  const latestShares = shares?.length ? [...shares].sort((a, b) => a.end.localeCompare(b.end)).at(-1)!.val : null;
  return {
    symbol,
    cik,
    entityName: body.entityName ?? symbol,
    years: years.slice(-5),
    sharesOutstanding: latestShares,
    filingsUrl: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}&type=10-K&dateb=&owner=include&count=40`,
    provider: 'SEC EDGAR (company-filed XBRL)',
  };
}

export class SecClient {
  constructor(private cache: Cache) {}
  private headers = () => ({ 'User-Agent': config.secUserAgent });

  private async cikFor(symbol: string): Promise<string | null> {
    const { value } = await this.cache.wrap('sec:tickers', 7 * 86_400_000, async () => {
      const raw = await fetchJson<Record<string, { cik_str: number; ticker: string }>>(
        `${config.upstream.secWww}/files/company_tickers.json`,
        { provider: 'SEC EDGAR', headers: this.headers() },
      );
      const map: Record<string, string> = {};
      for (const row of Object.values(raw)) map[row.ticker.toUpperCase()] = String(row.cik_str).padStart(10, '0');
      return map;
    });
    return value[symbol.toUpperCase().replace('.', '-')] ?? null;
  }

  /** Returns null when the symbol is not an SEC registrant (e.g. non-US listings, indices). */
  async fundamentals(symbol: string) {
    const cik = await this.cikFor(symbol);
    if (!cik) return null;
    return this.cache.wrap(`sec:facts:${cik}`, 24 * 3_600_000, async () => {
      const body = await fetchJson<{ entityName?: string; facts?: Facts }>(
        `${config.upstream.secData}/api/xbrl/companyfacts/CIK${cik}.json`,
        { provider: 'SEC EDGAR', headers: this.headers(), timeoutMs: 25_000 },
      );
      const f = buildFundamentals(symbol.toUpperCase(), cik, body);
      if (f.years.length === 0) throw new UpstreamError('SEC EDGAR', 'no annual financial statements found for this company', 404);
      return f;
    });
  }
}
