import { TOPICS } from '../news/classify.ts';
import { COUNTRY_BY_ISO } from '../news/gazetteer.ts';
import type { StoryDto } from '../news/service.ts';
import { badRequest } from '../../lib/errors.ts';
import type { Services, SourceRef } from './tools.ts';

/**
 * Deterministic "data digest" reports. They are assembled purely from data
 * the platform holds, contain no generated analysis, and say so. They exist so
 * reporting works without an AI key and as a verifiable baseline next to it.
 */
export type ReportRequest =
  | { kind: 'daily-brief' }
  | { kind: 'country'; iso3: string }
  | { kind: 'company'; symbol: string }
  | { kind: 'comparison'; subject: 'countries' | 'companies'; a: string; b: string }
  | { kind: 'custom'; prompt: string };

const topicLabel = (id: string) => TOPICS.find((t) => t.id === id)?.label ?? id;
const country = (iso: string) => {
  const c = COUNTRY_BY_ISO.get(iso.toUpperCase());
  if (!c) throw badRequest(`Unknown country code "${iso}"`);
  return c;
};
const pct = (n: number | null | undefined, dp = 1) => (n == null ? 'n/a' : `${n >= 0 ? '+' : ''}${n.toFixed(dp)}%`);
const frac = (n: number | null | undefined) => (n == null ? 'n/a' : `${(n * 100).toFixed(1)}%`);
const num = (n: number | null | undefined, dp = 2) => (n == null ? 'n/a' : n.toLocaleString('en-US', { maximumFractionDigits: dp, minimumFractionDigits: dp }));
const money = (n: number | null | undefined) => {
  if (n == null) return 'n/a';
  const a = Math.abs(n);
  const s = a >= 1e12 ? `${(a / 1e12).toFixed(2)}T` : a >= 1e9 ? `${(a / 1e9).toFixed(2)}B` : a >= 1e6 ? `${(a / 1e6).toFixed(1)}M` : a.toLocaleString('en-US', { maximumFractionDigits: 0 });
  return `${n < 0 ? '-' : ''}$${s}`;
};
const when = (iso: string) => `${iso.slice(0, 16).replace('T', ' ')} UTC`;

export function reportTitle(r: ReportRequest, today: string): string {
  switch (r.kind) {
    case 'daily-brief':
      return `Daily brief, ${today}`;
    case 'country':
      return `Country report: ${country(r.iso3).name}`;
    case 'company':
      return `Company report: ${r.symbol.toUpperCase()}`;
    case 'comparison':
      return r.subject === 'countries' ? `Comparison: ${country(r.a).name} and ${country(r.b).name}` : `Comparison: ${r.a.toUpperCase()} and ${r.b.toUpperCase()}`;
    case 'custom':
      return r.prompt.length > 70 ? `${r.prompt.slice(0, 67)}…` : r.prompt;
  }
}

/** The instruction given to the AI analyst for each report type. */
export function reportPrompt(r: ReportRequest, today: string): string {
  const frame = `Write this as a finished intelligence report in markdown, dated ${today}. Start with a three-to-five line "Bottom line" section. Keep sourced facts and your assessment in separately headed sections, cite every factual statement with a link, and end with "Gaps and confidence" listing what the platform's data could not tell you.`;
  switch (r.kind) {
    case 'daily-brief':
      return `Produce my daily brief. Cover: the most significant world developments in the last 24-48 hours; the state of markets and anything notable in my portfolio and watchlist; and my personal agenda (tasks due, deadlines, training and objectives). ${frame}`;
    case 'country':
      return `Produce a country report on ${country(r.iso3).name} (${r.iso3.toUpperCase()}): the main current developments, how coverage volume and themes have shifted against the preceding period, and what to watch next. ${frame}`;
    case 'company':
      return `Produce an investment research report on ${r.symbol.toUpperCase()}: what the business's filed financials show (growth, margins, cash generation, balance sheet), valuation, price behaviour and risk, any relevant recent news in the archive, whether I hold it or have notes on it, and the main bull and bear considerations. ${frame}`;
    case 'comparison':
      return r.subject === 'countries'
        ? `Compare ${country(r.a).name} and ${country(r.b).name}: current developments in each, coverage volume and topic mix, and where their situations connect or diverge. Use a comparison table where it helps. ${frame}`
        : `Compare ${r.a.toUpperCase()} and ${r.b.toUpperCase()} as investments: put growth, margins, cash flow, balance sheet strength, valuation and price risk side by side in a table, then discuss the differences. ${frame}`;
    case 'custom':
      return `${r.prompt}\n\n${frame}`;
  }
}

class Doc {
  private lines: string[] = [];
  readonly sources = new Map<string, SourceRef>();
  h(level: number, text: string) {
    this.lines.push('', `${'#'.repeat(level)} ${text}`, '');
  }
  p(text: string) {
    this.lines.push(text, '');
  }
  table(head: string[], rows: string[][]) {
    this.lines.push(`| ${head.join(' | ')} |`, `| ${head.map((_, i) => (i === 0 ? ':--' : '--:')).join(' | ')} |`, ...rows.map((r) => `| ${r.join(' | ')} |`), '');
  }
  cite(s: SourceRef) {
    if (!this.sources.has(s.url)) this.sources.set(s.url, s);
  }
  stories(list: StoryDto[], empty: string) {
    if (list.length === 0) return this.p(`_${empty}_`);
    for (const s of list) {
      const links = s.articles.slice(0, 4).map((a) => {
        this.cite({ title: a.title, url: a.url, publisher: a.sourceName, kind: 'news', publishedAt: a.publishedAt });
        return `[${a.sourceName}](${a.url})`;
      });
      const tier = s.verification === 'corroborated' ? `Corroborated by ${s.sourceCount} outlets` : 'Single source, unverified';
      this.lines.push(`- **${s.headline}**${s.summary ? ` ${s.summary}` : ''}  \n  ${tier}. Significance ${s.significance.score}/100. Latest ${when(s.latestAt)}. Coverage: ${links.join(', ')}`);
    }
    this.lines.push('');
  }
  toString() {
    return this.lines.join('\n').trim();
  }
}

const PREAMBLE = '> **Data digest.** Assembled directly from platform data with no AI-written analysis. Every line is a retrieved record or a calculation on retrieved records.';

async function companyBlock(doc: Doc, services: Services, symbol: string) {
  const c = await services.markets.company(symbol);
  const q = c.quote?.quote;
  if (q) {
    doc.cite({ title: `${c.symbol} quote`, url: `https://finance.yahoo.com/quote/${encodeURIComponent(c.symbol)}`, publisher: q.provider, kind: 'market-data', publishedAt: q.asOf });
    doc.p(`**${q.name ?? c.symbol}** last traded at **${num(q.price)} ${q.currency ?? ''}** (${pct(q.changePct, 2)} on the day), as of ${when(q.asOf)}. Delayed quote from ${q.provider}.`);
  } else doc.p('_No quote available from the market-data provider._');
  if (c.fundamentals) {
    const f = c.fundamentals;
    doc.cite({ title: `${f.entityName} annual filings (10-K)`, url: f.filingsUrl, publisher: 'SEC EDGAR', kind: 'filing' });
    doc.p(`Financials as filed by ${f.entityName} with the SEC ([10-K filings](${f.filingsUrl})):`);
    doc.table(
      ['Fiscal year ending', ...f.years.map((y) => y.periodEnd)],
      [
        ['Revenue', ...f.years.map((y) => money(y.revenue))],
        ['Revenue growth', ...f.years.map((y) => (y.revenueGrowth == null ? 'n/a' : pct(y.revenueGrowth * 100)))],
        ['Operating margin', ...f.years.map((y) => frac(y.operatingMargin))],
        ['Net income', ...f.years.map((y) => money(y.netIncome))],
        ['Free cash flow', ...f.years.map((y) => money(y.freeCashFlow))],
        ['Diluted EPS', ...f.years.map((y) => num(y.epsDiluted))],
        ['Return on equity', ...f.years.map((y) => frac(y.returnOnEquity))],
        ['Long-term debt / equity', ...f.years.map((y) => num(y.debtToEquity))],
      ],
    );
  } else doc.p(`_${c.fundamentalsNote}_`);
  if (c.valuation) {
    doc.p(`Valuation (${c.valuation.basis}): market cap ${money(c.valuation.marketCap)}, P/E ${num(c.valuation.priceToEarnings, 1)}, P/S ${num(c.valuation.priceToSales, 1)}, P/B ${num(c.valuation.priceToBook, 1)}, free-cash-flow yield ${frac(c.valuation.freeCashFlowYield)}.`);
  }
  if (c.risk) {
    doc.p(`Price risk over ${c.risk.observations} trading days (${c.risk.from} to ${c.risk.to}): annualised volatility ${frac(c.risk.annualisedVolatility)}, maximum drawdown ${frac(c.risk.maxDrawdown)}, one-day 95% VaR ${frac(c.risk.valueAtRisk95)}, beta against the S&P 500 ${num(c.risk.beta)}.`);
  }
  return c;
}

function countryBlock(doc: Doc, services: Services, iso3: string) {
  const c = country(iso3);
  const t = services.news.trend({ country: c.iso3, days: 14 });
  const cmp = t.previousPeriodCovered ? `against ${t.previousTotal} in the 14 days before` : 'the archive does not yet cover the full preceding 14 days, so no period comparison is made';
  doc.p(`The archive holds **${t.currentTotal} articles** mentioning ${c.name} in the last 14 days; ${cmp}.`);
  if (t.topicMix.length) doc.p(`Topic mix: ${t.topicMix.slice(0, 5).map((m) => `${topicLabel(m.topic)} (${m.count})`).join(', ')}.`);
  doc.stories(services.news.stories({ hours: 96, country: c.iso3, limit: 8 }), `No stories mentioning ${c.name} in the last four days.`);
  return t;
}

export async function buildDigest(r: ReportRequest, services: Services, today: string): Promise<{ body: string; sources: SourceRef[] }> {
  const doc = new Doc();
  doc.p(PREAMBLE);
  switch (r.kind) {
    case 'daily-brief': {
      doc.h(2, 'World developments, last 48 hours');
      doc.stories(services.news.stories({ hours: 48, limit: 8 }), 'The news archive has nothing from the last 48 hours. Refresh the feeds from the Intelligence desk.');
      doc.h(2, 'Markets');
      const board = await services.markets.board();
      const priced = board.filter((b) => b.quote);
      if (priced.length) {
        doc.table(['Instrument', 'Last', 'Day change', 'As of'], priced.map((b) => [b.label, num(b.quote!.price), pct(b.quote!.changePct, 2), when(b.quote!.asOf)]));
        doc.p('_Delayed prices from the market-data provider._');
        for (const b of priced) doc.cite({ title: `${b.label} quote`, url: `https://finance.yahoo.com/quote/${encodeURIComponent(b.symbol)}`, publisher: b.quote!.provider, kind: 'market-data', publishedAt: b.quote!.asOf });
      } else doc.p('_Market data is unavailable right now._');
      const pf = await services.markets.portfolio();
      if (pf.positions.length) {
        doc.h(3, 'Portfolio');
        doc.p(`Market value ${money(pf.totals.marketValue)}, day change ${money(pf.totals.dayChange)}, unrealised ${money(pf.totals.unrealised)} (${pct(pf.totals.unrealisedPct)}).`);
        doc.table(['Holding', 'Weight', 'Day', 'Unrealised'], pf.positions.map((p) => [p.symbol, frac(p.weight), pct(p.changePct, 2), pct(p.unrealisedPct)]));
      }
      doc.h(2, 'Personal agenda');
      const perf = services.personal.performance(today);
      doc.p(`Tasks: ${perf.tasks.open} open, ${perf.tasks.dueToday} due today, ${perf.tasks.overdue} overdue. Completed in the last 7 days: ${perf.tasks.last7Completed}.`);
      const soon = perf.upcoming.filter((u) => u.daysLeft <= 14);
      if (soon.length) doc.p(soon.map((u) => `- ${u.dueOn}: ${u.title} (${u.type}, ${u.daysLeft < 0 ? `${-u.daysLeft} days overdue` : u.daysLeft === 0 ? 'today' : `in ${u.daysLeft} days`})`).join('\n'));
      else doc.p('_Nothing due in the next 14 days._');
      if (perf.fitness.totalRuns) doc.p(`Running: ${num(perf.fitness.thisWeekKm, 1)} km this week, ${num(perf.fitness.lastWeekKm, 1)} km last week, four-week average ${num(perf.fitness.fourWeekAvgKm, 1)} km.`);
      const active = perf.objectives.filter((o) => o.status === 'active');
      if (active.length) doc.p(active.map((o) => `- ${o.title}: ${Math.round(o.progress * 100)}% (${o.pace})`).join('\n'));
      break;
    }
    case 'country': {
      doc.h(2, `${country(r.iso3).name}: current coverage`);
      countryBlock(doc, services, r.iso3);
      break;
    }
    case 'company': {
      doc.h(2, r.symbol.toUpperCase());
      const c = await companyBlock(doc, services, r.symbol);
      const name = c.quote?.quote.name?.split(/[ ,]/)[0];
      if (name && name.length > 2) {
        doc.h(3, 'Mentions in the news archive');
        const { items } = services.news.articles({ q: name, limit: 6 });
        if (items.length) {
          doc.p(items.map((a) => `- [${a.title}](${a.url}) (${a.sourceName}, ${when(a.publishedAt)})`).join('\n'));
          for (const a of items) doc.cite({ title: a.title, url: a.url, publisher: a.sourceName, kind: 'news', publishedAt: a.publishedAt });
        } else doc.p(`_No archived headlines mention “${name}”._`);
      }
      const notes = services.markets.notes(r.symbol);
      if (notes.length) {
        doc.h(3, 'Your research notes');
        doc.p(notes.map((n) => `- **${n.title}** (${n.stance}${n.targetPrice ? `, target ${num(n.targetPrice)}` : ''}): ${n.body.slice(0, 300)}`).join('\n'));
      }
      break;
    }
    case 'comparison': {
      if (r.subject === 'countries') {
        for (const iso of [r.a, r.b]) {
          doc.h(2, country(iso).name);
          countryBlock(doc, services, iso);
        }
      } else {
        for (const s of [r.a, r.b]) {
          doc.h(2, s.toUpperCase());
          await companyBlock(doc, services, s);
        }
      }
      break;
    }
    case 'custom':
      throw badRequest('Custom reports need the AI analyst. Set ANTHROPIC_API_KEY to enable it.');
  }
  return { body: doc.toString(), sources: [...doc.sources.values()] };
}
