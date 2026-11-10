import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { createPlatform, type Platform } from '../server/app.ts';
import { openDatabase } from '../server/db.ts';

const MOCK = 'http://127.0.0.1:4599';
let p: Platform;
let api: ReturnType<typeof request>;

/** Parse an SSE response body into its JSON events. */
const events = (text: string) => text.split('\n\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)));

beforeAll(() => {
  p = createPlatform(openDatabase(':memory:'));
  api = request(p.app);
});

describe('news intelligence', () => {
  it('seeds built-in sources and manages custom ones', async () => {
    const sources = (await api.get('/api/news/sources').expect(200)).body;
    expect(sources.length).toBeGreaterThanOrEqual(8);
    expect(sources.every((s: any) => s.builtin && s.enabled)).toBe(true);
    // Tests must never touch real feeds: disable the built-ins.
    for (const s of sources) await api.patch(`/api/news/sources/${s.id}`).send({ enabled: false }).expect(200);
    await api.delete(`/api/news/sources/${sources[0].id}`).expect(400);
    await api.post('/api/news/sources').send({ name: 'Bad', url: 'not a url' }).expect(400);
    for (const [name, file] of [['Fixture Wire', 'wire.xml'], ['Fixture Herald', 'herald.atom'], ['Fixture Dispatch', 'dispatch.rdf'], ['Broken', 'broken.xml'], ['Down', 'down.xml']]) {
      await api.post('/api/news/sources').send({ name, url: `${MOCK}/feeds/${file}` }).expect(201);
    }
    await api.post('/api/news/sources').send({ name: 'Dup', url: `${MOCK}/feeds/wire.xml` }).expect(409);
  });

  it('reports an empty archive honestly before the first refresh', async () => {
    expect((await api.get('/api/news/stories').expect(200)).body).toEqual([]);
    const meta = (await api.get('/api/news/meta').expect(200)).body;
    expect(meta).toMatchObject({ articleCount: 0, archiveStart: null, lastIngestAt: null });
  });

  it('ingests RSS, Atom and RDF, isolating per-source failures', async () => {
    const r = (await api.post('/api/news/refresh').expect(200)).body;
    const by = Object.fromEntries(r.results.map((x: any) => [x.name, x]));
    expect(by['Fixture Wire']).toMatchObject({ ok: true, fetched: 5, inserted: 5 });
    expect(by['Fixture Herald']).toMatchObject({ ok: true, inserted: 5 });
    expect(by['Fixture Dispatch']).toMatchObject({ ok: true, inserted: 2 });
    expect(by['Broken']).toMatchObject({ ok: false, error: 'not an RSS or Atom feed' });
    expect(by['Down'].ok).toBe(false);
    expect(by['Down'].error).toMatch(/HTTP 503/);
    expect(r.failed).toBe(2);
    // Re-running inserts nothing new (URL de-duplication).
    expect((await api.post('/api/news/refresh').expect(200)).body.inserted).toBe(0);
    const sources = (await api.get('/api/news/sources')).body;
    expect(sources.find((s: any) => s.name === 'Down').lastError).toMatch(/503/);
    expect(sources.find((s: any) => s.name === 'Fixture Wire').lastOkAt).toBeTruthy();
  });

  it('ranks corroborated developments above single-source ones', async () => {
    const stories = (await api.get('/api/news/stories?hours=48').expect(200)).body;
    const quake = stories[0];
    expect(quake.headline).toMatch(/earthquake/i);
    expect(quake).toMatchObject({ verification: 'corroborated', sourceCount: 3, articleCount: 3 });
    expect(quake.countries).toContain('JPN');
    expect(quake.topics).toContain('disaster');
    expect(quake.significance.corroboration).toBe(24);
    expect(quake.significance.score).toBeGreaterThan(60);
    const cairo = stories.find((s: any) => /Cairo/.test(s.headline));
    expect(cairo).toMatchObject({ verification: 'corroborated', sourceCount: 2 });
    const kenya = stories.find((s: any) => /Kenya/.test(s.headline));
    expect(kenya.verification).toBe('single-source');
    expect(kenya.significance.score).toBeLessThan(quake.significance.score);
    // Every article keeps its source link, with tracking parameters removed.
    for (const s of stories) for (const a of s.articles) expect(a.url).toMatch(/^http:\/\/127\.0\.0\.1:4599\/articles\/[a-z]+\/[^?]+$/);
    const single = (await api.get(`/api/news/stories/${quake.id}`).expect(200)).body;
    expect(single.articles).toHaveLength(3);
    await api.get('/api/news/stories/999999').expect(404);
  });

  it('filters by country, topic, kind and text', async () => {
    const jp = (await api.get('/api/news/articles?country=JPN').expect(200)).body;
    expect(jp.total).toBe(3);
    const commentary = (await api.get('/api/news/articles?kind=commentary')).body;
    expect(commentary.items.map((a: any) => a.kind)).toEqual(['opinion']);
    const reporting = (await api.get('/api/news/articles?kind=reporting&limit=100')).body;
    expect(reporting.total).toBe(11);
    expect((await api.get('/api/news/articles?q=drone%20odesa')).body.total).toBe(1);
    expect((await api.get('/api/news/articles?q=100%25')).body.total).toBe(0);
    expect((await api.get('/api/news/articles?topic=health')).body.items[0].title).toMatch(/measles/);
    expect((await api.get('/api/news/stories?country=UKR')).body).toHaveLength(1);
    await api.get('/api/news/articles?country=ZZZ').expect(400);
    await api.get('/api/news/articles?topic=sport').expect(400);
  });

  it('builds map data and historical comparisons from the archive', async () => {
    const map = (await api.get('/api/news/map?hours=48').expect(200)).body;
    const jp = map.find((c: any) => c.iso3 === 'JPN');
    expect(jp).toMatchObject({ articles: 3, sources: 3, numeric: '392' });
    expect(jp.topStory.headline).toMatch(/earthquake/i);
    expect(map.find((c: any) => c.iso3 === 'TWN')).toBeUndefined(); // 80h old
    const trend = (await api.get('/api/news/trends?country=JPN&days=7').expect(200)).body;
    expect(trend.current).toHaveLength(7);
    expect(trend.currentTotal).toBe(3);
    expect(trend.previousTotal).toBe(0);
    expect(trend.previousPeriodCovered).toBe(false);
    expect(trend.topicMix[0].topic).toBe('disaster');
  });

  it('proxies GDELT long-range attention', async () => {
    const g = (await api.get('/api/news/gdelt?q=Japan&span=1m').expect(200)).body;
    expect(g.points).toHaveLength(30);
    expect(g.points[0]).toEqual({ date: '2026-10-01', value: 1 });
    expect(g.provider).toBe('GDELT Project');
    await api.get('/api/news/gdelt').expect(400);
  });
});

describe('markets', () => {
  it('returns labelled, timestamped quotes and isolates bad symbols', async () => {
    const rows = (await api.get('/api/markets/quotes?symbols=AAPL,NOPE').expect(200)).body;
    const aapl = rows.find((r: any) => r.symbol === 'AAPL');
    expect(aapl.quote).toMatchObject({ symbol: 'AAPL', name: 'Apple Inc.', currency: 'USD', provider: 'Yahoo Finance' });
    expect(aapl.quote.price).toBeGreaterThan(0);
    expect(Date.parse(aapl.quote.asOf)).toBeGreaterThan(0);
    expect(aapl.fetchedAt).toBeTruthy();
    expect(aapl.stale).toBe(false);
    // Day change is measured against the previous session's close.
    expect(aapl.quote.change).toBeCloseTo(aapl.quote.price - aapl.quote.previousClose);
    const nope = rows.find((r: any) => r.symbol === 'NOPE');
    expect(nope.quote).toBeNull();
    expect(nope.error).toMatch(/no data/i);
    await api.get('/api/markets/quotes?symbols=bad%20symbol!').expect(400);
  });

  it('serves price history, skipping null bars', async () => {
    const h = (await api.get('/api/markets/history/AAPL?range=6M').expect(200)).body;
    expect(h.candles).toHaveLength(125); // fixture nulls one bar
    expect(h.candles[0].t).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(h.candles.every((c: any) => c.h >= c.l && c.c > 0)).toBe(true);
    const intraday = (await api.get('/api/markets/history/AAPL?range=1D').expect(200)).body;
    expect(intraday.candles[0].t).toMatch(/T/);
    await api.get('/api/markets/history/AAPL?range=10Y').expect(400);
    await api.get('/api/markets/history/NOPE').expect(502);
  });

  it('falls back to Stooq end-of-day data when the primary provider is down', async () => {
    const [row] = (await api.get('/api/markets/quotes?symbols=OUTG').expect(200)).body;
    expect(row.quote).toMatchObject({ price: 11.55, previousClose: 10.5, provider: 'Stooq (end-of-day)' });
    expect(row.quote.changePct).toBeCloseTo(10);
  });

  it('builds a company profile from filed financials', async () => {
    const c = (await api.get('/api/markets/company/AAPL').expect(200)).body;
    expect(c.fundamentals.entityName).toBe('Apple Inc.');
    expect(c.fundamentals.years).toHaveLength(5);
    const fy23 = c.fundamentals.years.find((y: any) => y.periodEnd === '2023-09-30');
    expect(fy23.revenue).toBe(383e9); // restated value from the later filing
    expect(fy23.freeCashFlow).toBe(100e9);
    const last = c.fundamentals.years.at(-1);
    expect(last.netMargin).toBeCloseTo(105 / 410);
    expect(last.revenueGrowth).toBeCloseTo(410 / 391 - 1);
    expect(c.valuation.marketCap).toBeCloseTo(c.quote.quote.price * 15e9);
    expect(c.valuation.priceToEarnings).toBeCloseTo(c.quote.quote.price / 7);
    expect(c.risk.observations).toBeGreaterThan(200);
    expect(c.risk.annualisedVolatility).toBeGreaterThan(0);
    expect(c.risk.maxDrawdown).toBeLessThanOrEqual(0);
    expect(c.fundamentals.filingsUrl).toContain('sec.gov');
    const idx = (await api.get('/api/markets/company/%5EGSPC').expect(200)).body;
    expect(idx.fundamentals).toBeNull();
    expect(idx.fundamentalsNote).toMatch(/No SEC filings/);
    const msft = (await api.get('/api/markets/company/MSFT').expect(200)).body;
    expect(msft.fundamentals).toBeNull();
    expect(msft.fundamentalsNote).toMatch(/unavailable/);
  });

  it('manages the watchlist, rejecting unknown symbols', async () => {
    expect((await api.get('/api/markets/watchlist').expect(200)).body).toEqual([]);
    await api.post('/api/markets/watchlist').send({ symbol: 'nvda' }).expect(201);
    await api.post('/api/markets/watchlist').send({ symbol: 'NVDA' }).expect(409);
    await api.post('/api/markets/watchlist').send({ symbol: 'NOPE' }).expect(502);
    const list = (await api.get('/api/markets/watchlist')).body;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ symbol: 'NVDA', name: 'NVIDIA Corporation' });
    expect(list[0].quote.price).toBeGreaterThan(0);
    await api.delete('/api/markets/watchlist/NVDA').expect(200);
    await api.delete('/api/markets/watchlist/NVDA').expect(404);
  });

  it('tracks a portfolio with validation, FX conversion and risk', async () => {
    const empty = (await api.get('/api/markets/portfolio').expect(200)).body;
    expect(empty.positions).toEqual([]);
    expect(empty.totals.marketValue).toBeNull();
    expect((await api.get('/api/markets/portfolio/risk')).body.available).toBe(false);

    const tx = (b: object) => api.post('/api/markets/transactions').send(b);
    await tx({ symbol: 'AAPL', side: 'sell', quantity: 1, price: 100, tradedOn: '2026-01-05' }).expect(400);
    await tx({ symbol: 'AAPL', side: 'buy', quantity: -1, price: 100, tradedOn: '2026-01-05' }).expect(400);
    await tx({ symbol: 'AAPL', side: 'buy', quantity: 1, price: 100, tradedOn: '2999-01-01' }).expect(400);
    await tx({ symbol: 'AAPL', side: 'buy', quantity: 1, price: 100, tradedOn: '2026-02-30' }).expect(400);
    const buy = (await tx({ symbol: 'aapl', side: 'buy', quantity: 10, price: 150, fee: 5, tradedOn: '2026-01-05' }).expect(201)).body;
    await tx({ symbol: 'AAPL', side: 'sell', quantity: 4, price: 180, tradedOn: '2026-03-01' }).expect(201);
    await tx({ symbol: 'AAPL', side: 'sell', quantity: 7, price: 180, tradedOn: '2026-03-02' }).expect(400);
    // A sell dated before the buy would be selling shares not yet held.
    await tx({ symbol: 'AAPL', side: 'sell', quantity: 1, price: 180, tradedOn: '2026-01-01' }).expect(400);
    await tx({ symbol: 'MSFT', side: 'buy', quantity: 5, price: 300, tradedOn: '2026-02-01' }).expect(201);
    await tx({ symbol: 'VOD.L', side: 'buy', quantity: 1000, price: 0.9, tradedOn: '2026-02-01' }).expect(201);
    await api.delete(`/api/markets/transactions/${buy.id}`).expect(400);

    const pf = (await api.get('/api/markets/portfolio').expect(200)).body;
    const aapl = pf.positions.find((x: any) => x.symbol === 'AAPL');
    expect(aapl.quantity).toBe(6);
    expect(aapl.avgCost).toBeCloseTo(150.5);
    expect(aapl.realised).toBeCloseTo(4 * (180 - 150.5));
    expect(aapl.marketValue).toBeCloseTo(aapl.price * 6);
    // London quote is in pence: convert to pounds, then to USD.
    const vod = pf.positions.find((x: any) => x.symbol === 'VOD.L');
    const gbp = (await api.get('/api/markets/quotes?symbols=GBPUSD%3DX')).body[0].quote.price;
    expect(vod.currency).toBe('GBp');
    expect(vod.marketValue).toBeCloseTo((vod.price / 100) * gbp * 1000);
    const weights = pf.positions.reduce((a: number, x: any) => a + x.weight, 0);
    expect(weights).toBeCloseTo(1);
    expect(pf.totals.marketValue).toBeCloseTo(pf.positions.reduce((a: number, x: any) => a + x.marketValue, 0));
    expect(pf.totals.unpricedPositions).toBe(0);

    const r = (await api.get('/api/markets/portfolio/risk').expect(200)).body;
    expect(r.available).toBe(true);
    expect(r.holdings).toHaveLength(3);
    expect(r.holdings.reduce((a: number, h: any) => a + h.riskContribution, 0)).toBeCloseTo(1);
    expect(r.correlation.matrix[0][0]).toBe(1);
    expect(r.correlation.matrix[0][1]).toBeCloseTo(r.correlation.matrix[1][0]);
    expect(r.annualisedVolatility).toBeGreaterThan(0);
    expect(r.valueAtRisk95).toBeLessThan(0);
    expect(r.valueAtRisk95Usd).toBeCloseTo(pf.totals.marketValue * r.valueAtRisk95, 0);
    expect(r.path[0].v).toBe(100);
    expect(r.effectiveHoldings).toBeGreaterThan(1);
    expect(r.beta).not.toBeNull();
  });

  it('stores research notes', async () => {
    await api.post('/api/markets/notes').send({ symbol: 'AAPL', title: '' }).expect(400);
    const { id } = (await api.post('/api/markets/notes').send({ symbol: 'aapl', title: 'Services thesis', body: 'Margins expanding.', stance: 'bullish', targetPrice: 250 }).expect(201)).body;
    await api.put(`/api/markets/notes/${id}`).send({ symbol: 'AAPL', title: 'Services thesis v2', body: 'Updated.', stance: 'neutral', targetPrice: null }).expect(200);
    const notes = (await api.get('/api/markets/notes?symbol=AAPL')).body;
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ title: 'Services thesis v2', stance: 'neutral', targetPrice: null });
    await api.put('/api/markets/notes/9999').send({ symbol: 'AAPL', title: 'x' }).expect(404);
  });

  it('searches symbols and serves the market board', async () => {
    const hits = (await api.get('/api/markets/search?q=micro').expect(200)).body;
    expect(hits[0]).toMatchObject({ symbol: 'MSFT', name: 'Microsoft Corporation' });
    const board = (await api.get('/api/markets/board').expect(200)).body;
    expect(board).toHaveLength(13);
    expect(board.every((b: any) => b.quote && b.quote.asOf)).toBe(true);
  });
});

describe('personal dashboard', () => {
  const today = '2026-11-10';
  it('starts empty', async () => {
    const o = (await api.get(`/api/personal/overview?today=${today}`).expect(200)).body;
    expect(o.fitness.totalRuns).toBe(0);
    expect(o.tasks).toMatchObject({ open: 0, completed: 0, onTimeRate: null });
    expect(o.objectives).toEqual([]);
    expect(o.upcoming).toEqual([]);
  });

  it('logs runs manually and from GPX', async () => {
    await api.post('/api/personal/runs').send({ runOn: today, distanceKm: 0, durationS: 100 }).expect(400);
    await api.post('/api/personal/runs').send({ runOn: 'yesterday', distanceKm: 5, durationS: 100 }).expect(400);
    await api.post('/api/personal/runs').send({ runOn: today, distanceKm: 10, durationS: 3000, kind: 'tempo', avgHr: 155 }).expect(201);
    await api.post('/api/personal/runs').send({ runOn: '2026-11-04', distanceKm: 6, durationS: 2100 }).expect(201);
    const gpx = '<gpx><trk><name>Loop</name><trkseg><trkpt lat="51.5" lon="-0.12"><time>2026-11-08T07:00:00Z</time></trkpt><trkpt lat="51.518" lon="-0.12"><time>2026-11-08T07:10:00Z</time></trkpt></trkseg></trk></gpx>';
    const imported = (await api.post('/api/personal/runs/import-gpx').set('Content-Type', 'application/gpx+xml').send(gpx).expect(201)).body;
    expect(imported.distanceKm).toBeCloseTo(2.0, 1);
    expect((await api.post('/api/personal/runs/import-gpx').set('Content-Type', 'text/plain').send('garbage').expect(400)).body.error.message).toMatch(/GPX/);
    const runs = (await api.get('/api/personal/runs')).body;
    expect(runs.map((r: any) => r.origin)).toEqual(['manual', 'gpx', 'manual']);
    const o = (await api.get(`/api/personal/overview?today=${today}`)).body;
    expect(o.fitness.thisWeekKm).toBe(10);
    expect(o.fitness.lastWeekKm).toBeCloseTo(8.0, 1);
    expect(o.fitness.bestPace.over5k.paceSPerKm).toBe(300);
    await api.delete(`/api/personal/runs/${runs[0].id}`).expect(200);
    await api.delete(`/api/personal/runs/${runs[0].id}`).expect(404);
  });

  it('tracks objectives with progress history', async () => {
    await api.post('/api/personal/objectives').send({ title: 'x', startValue: 5, targetValue: 5 }).expect(400);
    const { id } = (await api.post('/api/personal/objectives').send({ title: 'Run 1000 km this year', unit: 'km', targetValue: 1000, dueOn: '2026-12-31', category: 'fitness' }).expect(201)).body;
    await api.post(`/api/personal/objectives/${id}/progress`).send({ value: 400, note: 'spring block' }).expect(200);
    let [o] = (await api.get(`/api/personal/objectives?today=${today}`)).body;
    expect(o).toMatchObject({ currentValue: 400, progress: 0.4, status: 'active' });
    expect(o.history).toHaveLength(2);
    await api.post(`/api/personal/objectives/${id}/progress`).send({ value: 1000 }).expect(200);
    [o] = (await api.get(`/api/personal/objectives?today=${today}`)).body;
    expect(o).toMatchObject({ status: 'achieved', pace: 'achieved', progress: 1 });
    await api.post('/api/personal/objectives/999/progress').send({ value: 1 }).expect(404);
  });

  it('manages tasks and deadlines and merges what is upcoming', async () => {
    const t1 = (await api.post('/api/personal/tasks').send({ title: 'File expenses', dueOn: '2026-11-08', priority: 1 }).expect(201)).body.id;
    const t2 = (await api.post('/api/personal/tasks').send({ title: 'Book flights', dueOn: today }).expect(201)).body.id;
    await api.post('/api/personal/tasks').send({ title: '   ' }).expect(400);
    await api.post('/api/personal/deadlines').send({ title: 'Tax return', dueOn: '2026-11-30', category: 'finance' }).expect(201);
    await api.post('/api/personal/deadlines').send({ title: 'No date' }).expect(400);
    let o = (await api.get(`/api/personal/overview?today=${today}`)).body;
    expect(o.tasks).toMatchObject({ open: 2, overdue: 1, dueToday: 1 });
    expect(o.upcoming.map((u: any) => [u.type, u.title, u.daysLeft])).toEqual([['task', 'File expenses', -2], ['task', 'Book flights', 0], ['deadline', 'Tax return', 20]]);
    await api.patch(`/api/personal/tasks/${t2}`).send({ done: true }).expect(200);
    await api.patch(`/api/personal/tasks/${t1}`).send({ title: 'File Q3 expenses', dueOn: null }).expect(200);
    o = (await api.get(`/api/personal/overview?today=${today}`)).body;
    expect(o.tasks).toMatchObject({ open: 1, overdue: 0 });
    const tasks = (await api.get('/api/personal/tasks')).body;
    expect(tasks.find((t: any) => t.id === t1)).toMatchObject({ title: 'File Q3 expenses', dueOn: null, priority: 1 });
    await api.patch(`/api/personal/tasks/${t2}`).send({ done: false }).expect(200);
    expect((await api.get('/api/personal/tasks')).body.find((t: any) => t.id === t2).doneAt).toBeNull();
    await api.delete(`/api/personal/tasks/${t1}`).expect(200);
    await api.patch('/api/personal/tasks/9999').send({ done: true }).expect(404);
  });
});

describe('AI analyst', () => {
  it('reports its configuration', async () => {
    expect((await api.get('/api/analyst/status').expect(200)).body).toEqual({ configured: true, model: 'claude-opus-5-5' });
  });

  it('answers by calling platform tools and cites the sources it used', async () => {
    const res = await api.post('/api/analyst/chat').send({ text: 'What is the lead story?' }).expect(200);
    const ev = events(res.text);
    const text = ev.filter((e) => e.type === 'text').map((e) => e.delta).join('');
    expect(text).toMatch(/Checking the archive\./);
    expect(text).toMatch(/The lead story is \[.*earthquake.*\]\(http:\/\/127\.0\.0\.1:4599\/articles\//i);
    expect(ev.filter((e) => e.type === 'tool').map((e) => e.status)).toEqual(['running', 'done']);
    const sources = ev.find((e) => e.type === 'sources').sources;
    expect(sources.length).toBeGreaterThan(3);
    expect(sources[0]).toMatchObject({ kind: 'news' });
    expect(ev.at(-1)).toEqual({ type: 'done' });
    const conv = ev.find((e) => e.type === 'conversation');
    expect(conv.title).toBe('What is the lead story?');

    // The request sent to the model: grounded system prompt, tools, adaptive thinking.
    const sent = (await (await fetch(`${MOCK}/anthropic/_requests`)).json()) as any[];
    const first = sent.at(-2).body;
    expect(first.model).toBe('claude-opus-5-5');
    expect(first.thinking).toEqual({ type: 'adaptive' });
    expect(first.stream).toBe(true);
    expect(first.system[0].text).toMatch(/Never invent a figure/);
    expect(first.tools.map((t: any) => t.name)).toEqual(expect.arrayContaining(['get_top_stories', 'search_news', 'get_quotes', 'get_company_financials', 'get_portfolio', 'get_personal_dashboard']));
    const second = sent.at(-1).body;
    expect(second.messages.at(-1).content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_mock_1' });

    // Follow-up turn replays the stored history, including tool traffic.
    const res2 = await api.post('/api/analyst/chat').send({ conversationId: conv.id, text: 'And again?' }).expect(200);
    expect(events(res2.text).at(-1)).toEqual({ type: 'done' });
    const after = (await (await fetch(`${MOCK}/anthropic/_requests`)).json()) as any[];
    expect(after.at(-2).body.messages).toHaveLength(5);
    const stored = (await api.get(`/api/analyst/conversations/${conv.id}`).expect(200)).body;
    expect(stored.messages.map((m: any) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(stored.messages[1].sources.length).toBeGreaterThan(0);
    expect(stored.messages[1].steps).toEqual(['Reading top stories']);
    expect((await api.get('/api/analyst/conversations')).body).toHaveLength(1);
  });

  it('rejects invalid tool input from the model instead of running it', async () => {
    const res = await api.post('/api/analyst/chat').send({ text: 'BADTOOL please' }).expect(200);
    const ev = events(res.text);
    expect(ev.filter((e) => e.type === 'tool')).toEqual([]);
    expect(ev.filter((e) => e.type === 'text').map((e) => e.delta).join('')).toMatch(/tool error: \{"INVALID_INPUT"/);
  });

  it('surfaces refusals and validates input', async () => {
    const res = await api.post('/api/analyst/chat').send({ text: 'REFUSE this' }).expect(200);
    expect(events(res.text).find((e) => e.type === 'notice').message).toMatch(/declined/);
    await api.post('/api/analyst/chat').send({ text: '' }).expect(400);
    const missing = await api.post('/api/analyst/chat').send({ conversationId: 9999, text: 'hi' }).expect(200);
    expect(events(missing.text)[0]).toMatchObject({ type: 'error', code: 'not_found' });
  });

  it('generates deterministic data digests with sources and no AI', async () => {
    const before = ((await (await fetch(`${MOCK}/anthropic/_requests`)).json()) as any[]).length;
    const res = await api.post('/api/analyst/reports').send({ engine: 'digest', today: '2026-11-10', request: { kind: 'daily-brief' } }).expect(200);
    const report = events(res.text).find((e) => e.type === 'report').report;
    expect(report.engine).toBe('data-digest');
    expect(report.title).toBe('Daily brief, 2026-11-10');
    expect(report.body).toMatch(/no AI-written analysis/);
    expect(report.body).toMatch(/Corroborated by 3 outlets/);
    expect(report.body).toMatch(/Single source, unverified/);
    expect(report.body).toMatch(/\| S&P 500 \|/);
    expect(report.body).toMatch(/Book flights \(task, today\)/);
    expect(report.sources.some((s: any) => s.kind === 'news')).toBe(true);
    expect(report.sources.some((s: any) => s.kind === 'market-data')).toBe(true);
    expect(((await (await fetch(`${MOCK}/anthropic/_requests`)).json()) as any[]).length).toBe(before);

    const company = events((await api.post('/api/analyst/reports').send({ engine: 'digest', request: { kind: 'company', symbol: 'AAPL' } })).text).find((e) => e.type === 'report').report;
    expect(company.body).toMatch(/\| Revenue \| \$365\.00B \|/);
    expect(company.body).toMatch(/Services thesis v2/);
    expect(company.sources.some((s: any) => s.kind === 'filing')).toBe(true);

    const cmp = events((await api.post('/api/analyst/reports').send({ engine: 'digest', request: { kind: 'comparison', subject: 'countries', a: 'JPN', b: 'UKR' } })).text).find((e) => e.type === 'report').report;
    expect(cmp.title).toBe('Comparison: Japan and Ukraine');
    expect(cmp.body).toMatch(/does not yet cover the full preceding 14 days/);

    await api.post('/api/analyst/reports').send({ engine: 'digest', request: { kind: 'custom', prompt: 'anything' } }).expect(400);
    await api.post('/api/analyst/reports').send({ engine: 'digest', request: { kind: 'country', iso3: 'ZZZ' } }).expect(400);
    const list = (await api.get('/api/analyst/reports').expect(200)).body;
    expect(list).toHaveLength(3);
    await api.delete(`/api/analyst/reports/${list[0].id}`).expect(200);
    await api.get(`/api/analyst/reports/${list[0].id}`).expect(404);
  });

  it('generates and stores AI reports', async () => {
    const res = await api.post('/api/analyst/reports').send({ engine: 'ai', request: { kind: 'country', iso3: 'JPN' } }).expect(200);
    const report = events(res.text).find((e) => e.type === 'report').report;
    expect(report.engine).toBe('ai:claude-opus-5-5');
    expect(report.title).toBe('Country report: Japan');
    expect(report.body).toMatch(/Bottom line/);
    expect(report.sources.length).toBeGreaterThan(0);
  });
});

describe('platform behaviour', () => {
  it('reports status and handles malformed requests', async () => {
    const s = (await api.get('/api/status').expect(200)).body;
    expect(s.news).toMatchObject({ articleCount: 12, sourcesEnabled: 5, sourcesFailing: 2 });
    expect(s.analyst.configured).toBe(true);
    const nf = await api.get('/api/nope').expect(404);
    expect(nf.body.error.code).toBe('not_found');
    const bad = await api.post('/api/personal/tasks').set('Content-Type', 'application/json').send('{bad json').expect(400);
    expect(bad.body.error.message).toMatch(/not valid JSON/);
    await api.get('/api/news/stories/abc').expect(400);
  });

  it('serves last-known data flagged stale when a provider goes down', async () => {
    const fresh = await p.markets.quote('MSFT');
    expect(fresh.stale).toBe(false);
    // Expire the cache entry, then make the provider unreachable.
    const { config } = await import('../server/config.ts');
    const original = config.upstream.yahooChart;
    const db = (p.cache as any).db;
    db.prepare("UPDATE kv_cache SET expires_at = 0 WHERE key = 'quote:MSFT'").run();
    config.upstream.yahooChart = 'http://127.0.0.1:1';
    config.upstream.stooq = 'http://127.0.0.1:1';
    try {
      const fallback = await p.markets.quote('MSFT');
      expect(fallback.stale).toBe(true);
      expect(fallback.quote.price).toBe(fresh.quote.price);
      expect(fallback.fetchedAt).toBe(fresh.fetchedAt);
      await expect(p.markets.quote('NVDA')).resolves.toBeTruthy(); // still cached and fresh
      db.prepare("DELETE FROM kv_cache WHERE key = 'quote:NVDA'").run();
      await expect(p.markets.quote('NVDA')).rejects.toThrow(/Yahoo Finance/);
    } finally {
      config.upstream.yahooChart = original;
    }
  });
});
