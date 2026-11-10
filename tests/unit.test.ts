import { describe, expect, it } from 'vitest';
import { classify, detectKind, detectTopics, severityOf } from '../server/modules/news/classify.ts';
import { clusterArticles, significance, titleTokens } from '../server/modules/news/cluster.ts';
import { cleanText, parseFeed } from '../server/modules/news/feeds.ts';
import { detectCountries } from '../server/modules/news/gazetteer.ts';
import * as risk from '../server/modules/markets/risk.ts';
import { buildFundamentals } from '../server/modules/markets/sec.ts';
import { haversineKm, objectiveProgress, parseGpx, runAnalytics, taskAnalytics, weekStart } from '../server/modules/personal/analytics.ts';

describe('country detection', () => {
  it('tags names, demonyms, capitals and leaders', () => {
    expect(detectCountries('French and German leaders meet in Kyiv')).toEqual(expect.arrayContaining(['FRA', 'DEU', 'UKR']));
    expect(detectCountries('Kremlin dismisses US sanctions')).toEqual(expect.arrayContaining(['RUS', 'USA']));
  });
  it('respects word boundaries and unicode', () => {
    expect(detectCountries('New USB standard announced')).toEqual([]);
    expect(detectCountries('Nigeria votes')).toEqual(['NGA']);
    expect(detectCountries('Talks in Bogotá stall')).toEqual(['COL']);
  });
  it('does not confuse people with countries', () => {
    expect(detectCountries('Michael Jordan sells stake in team')).toEqual([]);
    expect(detectCountries('Jordan Peterson gives lecture')).toEqual([]);
    expect(detectCountries('In Jordan, refugees wait for aid')).toEqual(['JOR']);
    expect(detectCountries('Floods hit Chad and Niger')).toEqual(expect.arrayContaining(['TCD', 'NER']));
  });
  it('separates South Sudan from Sudan and Northern Ireland from Ireland', () => {
    expect(detectCountries('South Sudan declares emergency')).toEqual(['SSD']);
    expect(detectCountries('Sudan and South Sudan sign deal')).toEqual(expect.arrayContaining(['SDN', 'SSD']));
    expect(detectCountries('Northern Ireland assembly meets')).toEqual(['GBR']);
  });
  it('handles US-state Georgia and Thanksgiving turkey', () => {
    expect(detectCountries('Georgia governor signs bill in Atlanta')).not.toContain('GEO');
    expect(detectCountries('Protests in Tbilisi as Georgia delays vote')).toContain('GEO');
    expect(detectCountries('How to roast a Turkey for Thanksgiving')).not.toContain('TUR');
  });
});

describe('classification', () => {
  it('assigns topics', () => {
    expect(detectTopics('Central bank raises interest rates as inflation climbs')).toContain('economy');
    expect(detectTopics('Missile strike kills soldiers near frontline')).toContain('conflict');
    expect(detectTopics('WHO declares cholera outbreak')).toContain('health');
    expect(detectTopics('A quiet day')).toEqual([]);
  });
  it('grades severity', () => {
    expect(severityOf('Coup attempt in capital')).toBe(1);
    expect(severityOf('Earthquake death toll rises')).toBe(0.8);
    expect(severityOf('Local bakery opens')).toBe(0);
  });
  it('separates reporting from commentary using publisher signals only', () => {
    expect(detectKind('PM resigns', 'https://x.com/world/pm-resigns')).toBe('report');
    expect(detectKind('We must act', 'https://www.theguardian.com/commentisfree/2026/x')).toBe('opinion');
    expect(detectKind('Opinion: We must act', 'https://x.com/a')).toBe('opinion');
    expect(detectKind('Analysis: What the vote means', 'https://x.com/a')).toBe('analysis');
    expect(detectKind('Why did the talks fail?', 'https://x.com/a')).toBe('analysis');
    expect(detectKind('Election night – live', 'https://x.com/a')).toBe('live');
  });
  it('classify combines all signals', () => {
    const c = classify('Ceasefire agreed in Gaza', 'Israel and Hamas accept deal brokered by Egypt', 'https://x.com/world/1');
    expect(c.countries).toEqual(expect.arrayContaining(['ISR', 'PSE', 'EGY']));
    expect(c.topics).toContain('conflict');
    expect(c.kind).toBe('report');
    expect(c.severity).toBe(0.6);
  });
});

describe('feed parsing', () => {
  it('cleans html and entities', () => {
    expect(cleanText('<p>Tom &amp; Jerry&#39;s <b>show</b>&nbsp;returns</p>')).toBe("Tom & Jerry's show returns");
    expect(cleanText('x'.repeat(700)).length).toBeLessThanOrEqual(601);
  });
  it('parses RSS, drops undated and future items, strips tracking params', () => {
    const now = new Date('2026-11-10T12:00:00Z');
    const xml = `<rss><channel>
      <item><title>A</title><link>https://n.example/a?utm_source=x&amp;id=1</link><pubDate>Tue, 10 Nov 2026 10:00:00 GMT</pubDate><description>&lt;b&gt;Hi&lt;/b&gt;</description></item>
      <item><title>No date</title><link>https://n.example/b</link></item>
      <item><title>Future</title><link>https://n.example/c</link><pubDate>Thu, 12 Nov 2026 10:00:00 GMT</pubDate></item>
      <item><title>Dup</title><link>https://n.example/a?id=1</link><pubDate>Tue, 10 Nov 2026 10:00:00 GMT</pubDate></item>
      <item><title>Bad link</title><link>javascript:alert(1)</link><pubDate>Tue, 10 Nov 2026 10:00:00 GMT</pubDate></item>
    </channel></rss>`;
    const items = parseFeed(xml, now);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ title: 'A', url: 'https://n.example/a?id=1', summary: 'Hi' });
  });
  it('parses Atom and rejects non-feeds', () => {
    const items = parseFeed('<feed><entry><title>T</title><link rel="alternate" href="https://a.example/1"/><updated>2026-01-01T00:00:00Z</updated></entry></feed>');
    expect(items[0]?.url).toBe('https://a.example/1');
    expect(() => parseFeed('<html><body>nope</body></html>')).toThrow(/not an RSS or Atom feed/);
  });
});

describe('story clustering and significance', () => {
  it('groups matching headlines and keeps unrelated ones apart', () => {
    const t = Date.parse('2026-11-10T00:00:00Z');
    const map = clusterArticles([
      { id: 5, title: 'Earthquake of magnitude 6.8 strikes northern Japan, tsunami warning issued', publishedAt: t },
      { id: 9, title: 'Strong earthquake strikes northern Japan; tsunami warning issued for coast', publishedAt: t + 1000 },
      { id: 3, title: 'Japan earthquake: tsunami warning issued after magnitude 6.8 tremor strikes north', publishedAt: t + 2000 },
      { id: 7, title: 'Federal Reserve holds interest rates steady', publishedAt: t + 3000 },
    ]);
    expect(map.get(5)).toBe(3);
    expect(map.get(9)).toBe(3);
    expect(map.get(3)).toBe(3);
    expect(map.get(7)).toBe(7);
  });
  it('does not merge stories separated by more than the window', () => {
    const map = clusterArticles([
      { id: 1, title: 'Parliament passes annual budget bill after long debate', publishedAt: 0 },
      { id: 2, title: 'Parliament passes annual budget bill after long debate', publishedAt: 72 * 3_600_000 },
    ]);
    expect(map.get(2)).toBe(2);
  });
  it('tokenises without stopwords', () => {
    expect([...titleTokens("The UK's talks with France")]).toEqual(['talk', 'france']);
  });
  it('scores transparently', () => {
    const now = Date.parse('2026-11-10T12:00:00Z');
    const s = significance({ sourceCount: 5, articleCount: 8, maxSeverity: 1, latestAt: now, now });
    expect(s).toEqual({ score: 100, corroboration: 40, severity: 30, volume: 10, recency: 20 });
    const weak = significance({ sourceCount: 1, articleCount: 1, maxSeverity: 0, latestAt: now - 48 * 3_600_000, now });
    expect(weak.corroboration).toBe(8);
    expect(weak.recency).toBeCloseTo(2.7, 1);
  });
});

describe('risk maths', () => {
  it('computes returns, volatility and drawdown', () => {
    expect(risk.dailyReturns([100, 110, 99])).toEqual([expect.closeTo(0.1), expect.closeTo(-0.1)]);
    expect(risk.stdev([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.138, 3);
    expect(risk.maxDrawdown([100, 120, 90, 130, 117])).toBeCloseTo(-0.25);
    expect(risk.maxDrawdown([1, 2, 3])).toBe(0);
  });
  it('computes beta, correlation and VaR', () => {
    const bench = Array.from({ length: 60 }, (_, i) => Math.sin(i) * 0.01);
    const asset = bench.map((r) => r * 1.5);
    expect(risk.beta(asset, bench)).toBeCloseTo(1.5);
    expect(risk.correlation(asset, bench)).toBeCloseTo(1);
    expect(risk.correlation(asset, bench.map((r) => -r))).toBeCloseTo(-1);
    expect(risk.beta([0.01], [0.01])).toBeNull();
    const returns = Array.from({ length: 100 }, (_, i) => (i - 50) / 1000);
    expect(risk.historicalVaR(returns, 0.95)).toBeCloseTo(-0.045);
    expect(risk.historicalVaR([0.01, 0.02])).toBeNull();
  });
  it('aligns series on shared dates only', () => {
    const { dates, closes } = risk.alignCloses({ A: [{ t: '1', c: 1 }, { t: '2', c: 2 }, { t: '3', c: 3 }], B: [{ t: '2', c: 20 }, { t: '3', c: 30 }, { t: '4', c: 40 }] });
    expect(dates).toEqual(['2', '3']);
    expect(closes).toEqual({ A: [2, 3], B: [20, 30] });
  });
  it('accounts positions at average cost', () => {
    const p = risk.positionFromLots([
      { side: 'buy', quantity: 10, price: 100, fee: 10 },
      { side: 'buy', quantity: 10, price: 120, fee: 0 },
      { side: 'sell', quantity: 5, price: 150, fee: 5 },
    ]);
    expect(p.quantity).toBe(15);
    expect(p.avgCost).toBeCloseTo(110.5);
    expect(p.realised).toBeCloseTo(5 * (150 - 110.5) - 5);
    expect(() => risk.positionFromLots([{ side: 'sell', quantity: 1, price: 1, fee: 0 }])).toThrow();
    expect(risk.concentration([0.5, 0.5])).toBe(0.5);
  });
});

describe('SEC fundamentals', () => {
  const fact = (start: string | undefined, end: string, val: number, filed = '2025-01-01', form = '10-K') => ({ start, end, val, form, filed });
  it('keeps full-year 10-K values, prefers restatements and preferred concepts', () => {
    const f = buildFundamentals('TEST', '0000000001', {
      entityName: 'Test Co',
      facts: {
        'us-gaap': {
          Revenues: { units: { USD: [fact('2023-01-01', '2023-12-31', 999), fact('2022-01-01', '2022-12-31', 80)] } },
          RevenueFromContractWithCustomerExcludingAssessedTax: { units: { USD: [fact('2023-01-01', '2023-12-31', 100, '2024-02-01'), fact('2023-01-01', '2023-12-31', 110, '2025-02-01'), fact('2023-10-01', '2023-12-31', 30), fact('2023-01-01', '2023-12-31', 555, '2025-03-01', '10-Q')] } },
          NetIncomeLoss: { units: { USD: [fact('2023-01-01', '2023-12-31', 22), fact('2022-01-01', '2022-12-31', 8)] } },
          StockholdersEquity: { units: { USD: [fact(undefined, '2023-12-31', 44)] } },
        },
      },
    });
    expect(f.years.map((y) => y.periodEnd)).toEqual(['2022-12-31', '2023-12-31']);
    expect(f.years[1]).toMatchObject({ revenue: 110, netIncome: 22, netMargin: 0.2, returnOnEquity: 0.5 });
    expect(f.years[0]!.revenue).toBe(80);
    expect(f.years[1]!.revenueGrowth).toBeCloseTo(110 / 80 - 1);
    expect(f.years[1]!.freeCashFlow).toBeNull();
  });
});

describe('personal analytics', () => {
  const run = (runOn: string, distanceKm: number, durationS: number) => ({ id: 0, runOn, distanceKm, durationS, kind: 'easy', avgHr: null, elevationM: null, notes: '', origin: 'manual' });
  it('buckets weeks from Monday', () => {
    expect(weekStart('2026-11-10')).toBe('2026-11-09');
    expect(weekStart('2026-11-15')).toBe('2026-11-09');
    expect(weekStart('2026-11-09')).toBe('2026-11-09');
  });
  it('summarises running', () => {
    const a = runAnalytics([run('2026-11-10', 10, 3000), run('2026-11-08', 5, 1500), run('2026-11-03', 21.1, 7200), run('2026-10-20', 8, 2600)], '2026-11-10');
    expect(a.thisWeekKm).toBe(10);
    expect(a.lastWeekKm).toBeCloseTo(26.1);
    expect(a.weekly).toHaveLength(12);
    expect(a.weekly.at(-1)).toMatchObject({ weekStart: '2026-11-09', distanceKm: 10, runs: 1 });
    expect(a.last7Km).toBeCloseTo(15);
    expect(a.longestRun).toEqual({ distanceKm: 21.1, runOn: '2026-11-03' });
    expect(a.bestPace.over5k?.paceSPerKm).toBe(300);
    expect(a.bestPace.overHalf?.runOn).toBe('2026-11-03');
    expect(a.weekStreak).toBe(2);
    expect(a.loadRatio).toBeCloseTo(15 / (44.1 / 4));
  });
  it('handles an empty log', () => {
    const a = runAnalytics([], '2026-11-10');
    expect(a).toMatchObject({ thisWeekKm: 0, loadRatio: null, longestRun: null, weekStreak: 0, totalRuns: 0 });
  });
  it('rates objective pace against the calendar', () => {
    const base = { id: 1, startValue: 0, targetValue: 100, createdAt: '2026-11-01T00:00:00Z', dueOn: '2026-11-21', status: 'active' };
    expect(objectiveProgress({ ...base, currentValue: 50 }, '2026-11-11')).toMatchObject({ progress: 0.5, expected: 0.5, pace: 'on-track', daysLeft: 10 });
    expect(objectiveProgress({ ...base, currentValue: 10 }, '2026-11-11').pace).toBe('behind');
    expect(objectiveProgress({ ...base, currentValue: 80 }, '2026-11-11').pace).toBe('ahead');
    expect(objectiveProgress({ ...base, currentValue: 80 }, '2026-12-01').pace).toBe('overdue');
    expect(objectiveProgress({ ...base, currentValue: 100 }, '2026-11-11').pace).toBe('achieved');
    // Decreasing targets (e.g. weight, 5k time) work too.
    expect(objectiveProgress({ ...base, startValue: 30, targetValue: 25, currentValue: 27.5, dueOn: null }, '2026-11-11')).toMatchObject({ progress: 0.5, pace: 'no-deadline' });
  });
  it('measures task throughput and punctuality', () => {
    const t = taskAnalytics(
      [
        { createdAt: '2026-11-01T09:00:00Z', dueOn: '2026-11-05', doneAt: '2026-11-04T10:00:00Z' },
        { createdAt: '2026-11-01T09:00:00Z', dueOn: '2026-11-05', doneAt: '2026-11-07T10:00:00Z' },
        { createdAt: '2026-11-09T09:00:00Z', dueOn: '2026-11-08', doneAt: null },
        { createdAt: '2026-11-09T09:00:00Z', dueOn: '2026-11-10', doneAt: null },
        { createdAt: '2026-11-09T09:00:00Z', dueOn: null, doneAt: null },
      ],
      '2026-11-10',
    );
    expect(t).toMatchObject({ completed: 2, open: 3, overdue: 1, dueToday: 1, onTimeRate: 0.5, last7Completed: 2 });
  });
  it('parses GPX tracks', () => {
    expect(haversineKm(51.5, -0.12, 51.5, -0.12)).toBe(0);
    expect(haversineKm(0, 0, 0, 1)).toBeCloseTo(111.19, 1);
    const gpx = `<gpx><trk><name>Morning Run</name><trkseg>
      <trkpt lat="51.5000" lon="-0.1200"><ele>10</ele><time>2026-11-08T07:00:00Z</time><extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>140</gpxtpx:hr></gpxtpx:TrackPointExtension></extensions></trkpt>
      <trkpt lat="51.5090" lon="-0.1200"><ele>25</ele><time>2026-11-08T07:05:00Z</time><extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>160</gpxtpx:hr></gpxtpx:TrackPointExtension></extensions></trkpt>
      <trkpt lat="51.5180" lon="-0.1200"><ele>20</ele><time>2026-11-08T07:10:00Z</time></trkpt>
    </trkseg></trk></gpx>`;
    const g = parseGpx(gpx);
    expect(g).toMatchObject({ runOn: '2026-11-08', durationS: 600, elevationM: 15, avgHr: 150, name: 'Morning Run' });
    expect(g.distanceKm).toBeCloseTo(2.0, 1);
    expect(() => parseGpx('<gpx><trk><trkseg></trkseg></trk></gpx>')).toThrow(/at least two points/);
    expect(() => parseGpx('<kml/>')).toThrow(/not a GPX/);
  });
});
