/**
 * Mock upstream used ONLY by the automated tests. It imitates the wire format
 * of each external provider (RSS/Atom/RDF feeds, Yahoo Finance chart API,
 * Stooq CSV, SEC EDGAR company facts, GDELT, Anthropic Messages streaming)
 * with synthetic content, so the suite is deterministic and offline.
 * Nothing here is ever served by the real application.
 */
import http from 'node:http';

const H = 3_600_000;
const rfc822 = (msAgo: number) => new Date(Date.now() - msAgo).toUTCString();

interface Item { title: string; path: string; desc: string; hoursAgo: number | null }

const WIRE: Item[] = [
  { title: 'Ceasefire talks resume in Cairo as mediators press Israel and Hamas', path: '/world/ceasefire-talks-cairo', desc: '<p>Negotiators from <b>Egypt</b> and Qatar met delegations on Tuesday &amp; said gaps remain.</p>', hoursAgo: 2 },
  { title: 'Earthquake of magnitude 6.8 strikes northern Japan, tsunami warning issued', path: '/world/japan-earthquake', desc: 'Authorities in Tokyo urged coastal residents to evacuate.', hoursAgo: 3 },
  { title: 'Federal Reserve holds interest rates steady, signals patience on inflation', path: '/business/fed-holds-rates', desc: 'The US central bank left rates unchanged for a third meeting.', hoursAgo: 5 },
  { title: 'Opinion: Why Europe must rethink its energy strategy', path: '/opinion/europe-energy-strategy', desc: 'A columnist argues the case.', hoursAgo: 6 },
  { title: 'Kenya launches nationwide measles vaccination campaign after outbreak', path: '/world/kenya-measles', desc: 'Health officials in Nairobi aim to reach four million children.', hoursAgo: 9 },
  { title: 'Item without a publication date', path: '/world/undated', desc: 'Should be dropped by the parser.', hoursAgo: null },
  { title: 'Scheduled item dated tomorrow', path: '/world/future', desc: 'Should be dropped.', hoursAgo: -30 },
];
const HERALD: Item[] = [
  { title: 'Mediators press Israel and Hamas as Cairo ceasefire talks resume', path: '/news/cairo-ceasefire-talks-resume', desc: 'Officials said talks would continue on Wednesday.', hoursAgo: 1.5 },
  { title: 'Strong earthquake strikes northern Japan; tsunami warning issued for coast', path: '/news/japan-quake-tsunami-warning', desc: 'The quake was felt in Sapporo.', hoursAgo: 2.5 },
  { title: 'Ukraine reports overnight drone attack on Odesa port', path: '/news/ukraine-odesa-drones', desc: 'Kyiv said air defences intercepted most of the drones.', hoursAgo: 4 },
  { title: 'Brazil central bank raises growth forecast as exports climb', path: '/news/brazil-growth-forecast', desc: 'Brasilia now expects the economy to expand faster this year.', hoursAgo: 30 },
  { title: 'Chipmakers rally after Taiwan export data beats expectations', path: '/news/taiwan-chip-exports', desc: 'Semiconductor shipments from Taipei rose sharply.', hoursAgo: 80 },
];
const DISPATCH: Item[] = [
  { title: 'Japan earthquake: tsunami warning issued after magnitude 6.8 tremor strikes north', path: '/japan-earthquake-tsunami', desc: 'Rail services were suspended.', hoursAgo: 2 },
  { title: 'Germany and France agree joint position ahead of EU summit', path: '/germany-france-eu-summit', desc: 'Berlin and Paris will push for a common defence fund.', hoursAgo: 12 },
];

const rss = (name: string, base: string, items: Item[]) => `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel><title>${name}</title><link>${base}</link>
${items.map((i) => `<item><title><![CDATA[${i.title}]]></title><link>${base}${i.path}?utm_source=rss</link><description><![CDATA[${i.desc}]]></description>${i.hoursAgo === null ? '' : `<pubDate>${rfc822(i.hoursAgo * H)}</pubDate>`}<guid isPermaLink="false">${i.path}</guid></item>`).join('\n')}
</channel></rss>`;

const atom = (name: string, base: string, items: Item[]) => `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>${name}</title>
${items.map((i) => `<entry><title type="html">${i.title.replace(/&/g, '&amp;')}</title><link rel="alternate" href="${base}${i.path}"/><link rel="self" href="${base}/self"/><summary>${i.desc}</summary><updated>${new Date(Date.now() - (i.hoursAgo ?? 0) * H).toISOString()}</updated></entry>`).join('\n')}
</feed>`;

const rdf = (name: string, base: string, items: Item[]) => `<?xml version="1.0" encoding="UTF-8"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
<channel><title>${name}</title></channel>
${items.map((i) => `<item rdf:about="${base}${i.path}"><title>${i.title}</title><link>${base}${i.path}</link><description>${i.desc}</description><dc:date>${new Date(Date.now() - (i.hoursAgo ?? 0) * H).toISOString()}</dc:date></item>`).join('\n')}
</rdf:RDF>`;

// ---- synthetic price series ---------------------------------------------------

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}
const hash = (s: string) => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);

const SYMBOLS: Record<string, { name: string; base: number; currency: string; type: string; exch: string }> = {
  AAPL: { name: 'Apple Inc.', base: 190, currency: 'USD', type: 'EQUITY', exch: 'NasdaqGS' },
  MSFT: { name: 'Microsoft Corporation', base: 410, currency: 'USD', type: 'EQUITY', exch: 'NasdaqGS' },
  NVDA: { name: 'NVIDIA Corporation', base: 120, currency: 'USD', type: 'EQUITY', exch: 'NasdaqGS' },
  'VOD.L': { name: 'Vodafone Group Plc', base: 72, currency: 'GBp', type: 'EQUITY', exch: 'LSE' },
  '^GSPC': { name: 'S&P 500', base: 5400, currency: 'USD', type: 'INDEX', exch: 'SNP' },
  '^IXIC': { name: 'NASDAQ Composite', base: 17000, currency: 'USD', type: 'INDEX', exch: 'Nasdaq GIDS' },
  '^DJI': { name: 'Dow Jones Industrial Average', base: 39000, currency: 'USD', type: 'INDEX', exch: 'DJI' },
  '^FTSE': { name: 'FTSE 100', base: 8200, currency: 'GBP', type: 'INDEX', exch: 'FTSE' },
  '^GDAXI': { name: 'DAX', base: 18300, currency: 'EUR', type: 'INDEX', exch: 'XETRA' },
  '^N225': { name: 'Nikkei 225', base: 38500, currency: 'JPY', type: 'INDEX', exch: 'Osaka' },
  '^TNX': { name: 'CBOE 10 Year Treasury Yield', base: 4.3, currency: 'USD', type: 'INDEX', exch: 'Cboe' },
  'EURUSD=X': { name: 'EUR/USD', base: 1.08, currency: 'USD', type: 'CURRENCY', exch: 'CCY' },
  'GBPUSD=X': { name: 'GBP/USD', base: 1.27, currency: 'USD', type: 'CURRENCY', exch: 'CCY' },
  'USDJPY=X': { name: 'USD/JPY', base: 155, currency: 'JPY', type: 'CURRENCY', exch: 'CCY' },
  'GC=F': { name: 'Gold Futures', base: 2350, currency: 'USD', type: 'FUTURE', exch: 'COMEX' },
  'CL=F': { name: 'Crude Oil Futures', base: 78, currency: 'USD', type: 'FUTURE', exch: 'NYMEX' },
  'BTC-USD': { name: 'Bitcoin USD', base: 65000, currency: 'USD', type: 'CRYPTOCURRENCY', exch: 'CCC' },
};

/** Weekday daily bars ending at the most recent weekday; deterministic per symbol. */
export function syntheticDaily(symbol: string, days: number) {
  const spec = SYMBOLS[symbol]!;
  const rand = rng(hash(symbol));
  const dates: Date[] = [];
  const d = new Date();
  d.setUTCHours(14, 30, 0, 0);
  while (dates.length < days) {
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) dates.unshift(new Date(d));
    d.setUTCDate(d.getUTCDate() - 1);
  }
  // Generate from a fixed epoch so overlapping ranges agree with each other.
  let price = spec.base * 0.8;
  const all: { ts: number; o: number; h: number; l: number; c: number; v: number }[] = [];
  const total = 1400;
  const series: number[] = [];
  for (let i = 0; i < total; i++) {
    price *= 1 + (rand() - 0.48) * 0.03;
    series.push(price);
  }
  const tail = series.slice(-days);
  tail.forEach((c, i) => {
    const o = i === 0 ? c * 0.995 : tail[i - 1]!;
    all.push({ ts: Math.floor(dates[i]!.getTime() / 1000), o, h: Math.max(o, c) * 1.006, l: Math.min(o, c) * 0.994, c, v: Math.round(1e6 + (hash(symbol + i) % 5e6)) });
  });
  return all;
}

function yahooChart(symbol: string, range: string, interval: string) {
  const spec = SYMBOLS[symbol];
  if (!spec) return { status: 404, body: { chart: { result: null, error: { code: 'Not Found', description: 'No data found, symbol may be delisted' } } } };
  const days = ({ '1d': 2, '5d': 5, '1mo': 22, '6mo': 126, ytd: 200, '1y': 252, '5y': 260 } as Record<string, number>)[range] ?? 252;
  let bars = syntheticDaily(symbol, days);
  if (/m$/.test(interval)) {
    // Intraday: split the last sessions into bars.
    const last = bars.slice(range === '1d' ? -1 : -5);
    bars = last.flatMap((b) => Array.from({ length: 13 }, (_, i) => ({ ...b, ts: b.ts + i * 1800, c: b.o + ((b.c - b.o) * (i + 1)) / 13, o: b.o + ((b.c - b.o) * i) / 13 })));
  }
  const lastBar = bars.at(-1)!;
  return {
    status: 200,
    body: {
      chart: {
        result: [
          {
            meta: { currency: spec.currency, symbol, exchangeName: spec.exch, fullExchangeName: spec.exch, instrumentType: spec.type, regularMarketTime: lastBar.ts + 3600, gmtoffset: 0, timezone: 'UTC', regularMarketPrice: lastBar.c, fiftyTwoWeekHigh: Math.max(...syntheticDaily(symbol, 252).map((b) => b.h)), fiftyTwoWeekLow: Math.min(...syntheticDaily(symbol, 252).map((b) => b.l)), regularMarketDayHigh: lastBar.h, regularMarketDayLow: lastBar.l, regularMarketVolume: lastBar.v, longName: spec.name, shortName: spec.name, chartPreviousClose: bars[0]!.o },
            timestamp: bars.map((b) => b.ts),
            indicators: { quote: [{ open: bars.map((b) => b.o), high: bars.map((b) => b.h), low: bars.map((b) => b.l), close: bars.map((b, i) => (i === 1 && range === '6mo' ? null : b.c)), volume: bars.map((b) => b.v) }] },
          },
        ],
        error: null,
      },
    },
  };
}

function secFacts() {
  const fy = (y: number, val: number, extra: object = {}) => ({ start: `${y - 1}-10-01`, end: `${y}-09-30`, val, fy: y, fp: 'FY', form: '10-K', filed: `${y}-11-01`, ...extra });
  const inst = (y: number, val: number) => ({ end: `${y}-09-30`, val, fy: y, fp: 'FY', form: '10-K', filed: `${y}-11-01` });
  const years = [2021, 2022, 2023, 2024, 2025];
  const usd = (vals: number[], f: (y: number, v: number) => object) => ({ units: { USD: years.map((y, i) => f(y, vals[i]!)) } });
  return {
    cik: 320193,
    entityName: 'Apple Inc.',
    facts: {
      dei: { EntityCommonStockSharesOutstanding: { units: { shares: [{ end: '2025-10-17', val: 15_000_000_000, form: '10-K', filed: '2025-11-01' }] } } },
      'us-gaap': {
        RevenueFromContractWithCustomerExcludingAssessedTax: { units: { USD: [...years.map((y, i) => fy(y, [365e9, 394e9, 383e9, 391e9, 410e9][i]!)), { start: '2025-07-01', end: '2025-09-30', val: 95e9, fy: 2025, fp: 'Q4', form: '10-K', filed: '2025-11-01' }, fy(2023, 380e9, { filed: '2023-11-01' }), fy(2023, 383e9, { filed: '2024-11-01' })] } },
        GrossProfit: usd([153e9, 171e9, 169e9, 181e9, 190e9], fy),
        OperatingIncomeLoss: usd([109e9, 119e9, 114e9, 123e9, 130e9], fy),
        NetIncomeLoss: usd([95e9, 100e9, 97e9, 94e9, 105e9], fy),
        EarningsPerShareDiluted: { units: { 'USD/shares': years.map((y, i) => fy(y, [5.61, 6.11, 6.13, 6.08, 7.0][i]!)) } },
        NetCashProvidedByUsedInOperatingActivities: usd([104e9, 122e9, 111e9, 118e9, 125e9], fy),
        PaymentsToAcquirePropertyPlantAndEquipment: usd([11e9, 11e9, 11e9, 9e9, 10e9], fy),
        Assets: usd([351e9, 353e9, 353e9, 365e9, 370e9], inst),
        Liabilities: usd([288e9, 302e9, 290e9, 308e9, 300e9], inst),
        StockholdersEquity: usd([63e9, 51e9, 62e9, 57e9, 70e9], inst),
        CashAndCashEquivalentsAtCarryingValue: usd([35e9, 24e9, 30e9, 30e9, 32e9], inst),
        LongTermDebtNoncurrent: usd([109e9, 99e9, 95e9, 86e9, 80e9], inst),
      },
    },
  };
}

// ---- Anthropic Messages (streaming) mock ---------------------------------------

export const anthropicRequests: any[] = [];

function anthropicStream(body: any): string {
  const last = body.messages.at(-1);
  const isToolResult = Array.isArray(last?.content) && last.content.some((b: any) => b.type === 'tool_result');
  const userText = typeof body.messages[0]?.content === 'string' ? body.messages[0].content : '';
  const ev = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  const start = ev('message_start', { message: { id: 'msg_mock', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } });
  const stop = (reason: string) => ev('message_delta', { delta: { stop_reason: reason, stop_sequence: null }, usage: { output_tokens: 20 } }) + ev('message_stop', {});
  const textBlock = (index: number, chunks: string[]) =>
    ev('content_block_start', { index, content_block: { type: 'text', text: '' } }) + chunks.map((t) => ev('content_block_delta', { index, delta: { type: 'text_delta', text: t } })).join('') + ev('content_block_stop', { index });
  if (/REFUSE/.test(userText)) {
    return start + ev('message_delta', { delta: { stop_reason: 'refusal', stop_sequence: null, stop_details: { type: 'refusal', category: null, explanation: null } }, usage: { output_tokens: 0 } }) + ev('message_stop', {});
  }
  if (!isToolResult) {
    const badInput = /BADTOOL/.test(userText);
    const input = badInput ? '{"hours":"many"}' : '{"hours":48,"limit":5}';
    return (
      start +
      textBlock(0, ['Checking the ', 'archive.']) +
      ev('content_block_start', { index: 1, content_block: { type: 'tool_use', id: 'toolu_mock_1', name: 'get_top_stories', input: {} } }) +
      ev('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: input.slice(0, 8) } }) +
      ev('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: input.slice(8) } }) +
      ev('content_block_stop', { index: 1 }) +
      stop('tool_use')
    );
  }
  const result = last.content.find((b: any) => b.type === 'tool_result');
  let headline = 'no stories';
  let url = '';
  try {
    if (result.is_error) throw new Error('tool reported an error');
    const parsed = JSON.parse(result.content);
    headline = parsed.stories?.[0]?.headline ?? headline;
    url = parsed.stories?.[0]?.coverage?.[0]?.url ?? '';
  } catch {
    headline = `tool error: ${String(result.content).slice(0, 80)}`;
  }
  return start + textBlock(0, ['## Bottom line\n\n', `The lead story is [${headline}](${url}).`, '\n\n## Assessment\n\nModerate confidence.']) + stop('end_turn');
}

// ---- server ---------------------------------------------------------------------

export function startMockUpstream(port: number): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    const p = url.pathname;
    const send = (status: number, type: string, body: string) => {
      res.writeHead(status, { 'Content-Type': type });
      res.end(body);
    };
    const json = (status: number, body: unknown) => send(status, 'application/json', JSON.stringify(body));
    const base = `http://127.0.0.1:${port}`;

    if (p === '/feeds/wire.xml') return send(200, 'application/rss+xml', rss('Fixture Wire', `${base}/articles/wire`, WIRE));
    if (p === '/feeds/herald.atom') return send(200, 'application/atom+xml', atom('Fixture Herald', `${base}/articles/herald`, HERALD));
    if (p === '/feeds/dispatch.rdf') return send(200, 'application/rdf+xml', rdf('Fixture Dispatch', `${base}/articles/dispatch`, DISPATCH));
    if (p === '/feeds/broken.xml') return send(200, 'text/html', '<html><body>Not a feed</body></html>');
    if (p === '/feeds/down.xml') return send(503, 'text/plain', 'unavailable');

    let m = p.match(/^\/yahoo\/v8\/finance\/chart\/(.+)$/);
    if (m) {
      const symbol = decodeURIComponent(m[1]!);
      if (symbol === 'OUTG') return send(500, 'text/plain', 'boom');
      const r = yahooChart(symbol, url.searchParams.get('range') ?? '1y', url.searchParams.get('interval') ?? '1d');
      return json(r.status, r.body);
    }
    if (p === '/yahoo/v1/finance/search') {
      const q = (url.searchParams.get('q') ?? '').toLowerCase();
      return json(200, { quotes: Object.entries(SYMBOLS).filter(([s, v]) => s.toLowerCase().includes(q) || v.name.toLowerCase().includes(q)).slice(0, 8).map(([symbol, v]) => ({ symbol, longname: v.name, exchDisp: v.exch, typeDisp: v.type })) });
    }
    if (p === '/stooq/q/d/l/') {
      const s = url.searchParams.get('s');
      if (s !== 'outg.us') return send(200, 'text/csv', 'No data');
      return send(200, 'text/csv', 'Date,Open,High,Low,Close,Volume\n2026-11-05,10,11,9.5,10.5,1000\n2026-11-06,10.5,12,10,11.55,1200\n');
    }
    if (p === '/sec/files/company_tickers.json') return json(200, { 0: { cik_str: 320193, ticker: 'AAPL', title: 'Apple Inc.' }, 1: { cik_str: 789019, ticker: 'MSFT', title: 'MICROSOFT CORP' } });
    if (p === '/sec/api/xbrl/companyfacts/CIK0000320193.json') return json(200, secFacts());
    if (p.startsWith('/sec/api/xbrl/companyfacts/')) return send(500, 'text/plain', 'error');
    if (p === '/gdelt/api/v2/doc/doc') {
      return json(200, { timeline: [{ series: 'Volume Intensity', data: Array.from({ length: 30 }, (_, i) => ({ date: `202610${String(i + 1).padStart(2, '0')}T000000Z`, value: 1 + (i % 7) * 0.2 })) }] });
    }
    if (p === '/anthropic/v1/messages' && req.method === 'POST') {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const body = JSON.parse(raw);
        anthropicRequests.push({ body, headers: req.headers });
        if (req.headers['x-api-key'] !== 'test-key' && req.headers.authorization !== 'Bearer test-key') return json(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } });
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(anthropicStream(body));
      });
      return;
    }
    if (p === '/anthropic/_requests') return json(200, anthropicRequests);
    send(404, 'text/plain', 'not found');
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}
