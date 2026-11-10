/**
 * End-to-end browser tests. Boots the app against the mock upstream, then
 * drives every desk through its main user journeys in Chromium.
 *
 *   npm run build && npm run test:e2e
 *
 * Set SHOTS=<dir> to also save screenshots of each desk.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const PORT = 4010;
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = process.env.SHOTS;
const results = [];
let failed = 0;

function startServer(env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'tests/e2e/serve.ts'], { env: { ...process.env, PORT: String(PORT), ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${out}`)), 30_000);
    const onData = (d) => {
      out += d;
      if (out.includes('E2E_READY')) {
        clearTimeout(timer);
        resolve(child);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => code && reject(new Error(`server exited ${code}:\n${out}`)));
  });
}
const stop = (child) => new Promise((r) => { child.on('exit', r); child.kill('SIGTERM'); });

function assert(cond, message) {
  if (!cond) throw new Error(message);
}
async function test(name, fn) {
  const started = Date.now();
  try {
    await fn();
    results.push(`  ok    ${name} (${Date.now() - started}ms)`);
  } catch (err) {
    failed++;
    results.push(`  FAIL  ${name}\n        ${String(err.message).split('\n').slice(0, 6).join('\n        ')}`);
  }
}
const api = (p, init) => fetch(`${BASE}/api${p}`, { ...init, headers: { 'Content-Type': 'application/json' }, body: init?.body ? JSON.stringify(init.body) : undefined }).then((r) => r.json());
const localDate = (offsetDays = 0) => {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

async function newPage(browser, opts = {}) {
  const ctx = await browser.newContext({ viewport: opts.mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 }, deviceScaleFactor: SHOTS ? 2 : 1, reducedMotion: 'reduce', hasTouch: Boolean(opts.mobile) });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(`console: ${m.text()}`));
  page.errors = errors;
  return page;
}
async function shot(page, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(350);
  // The app scrolls inside its content pane; unroll it so the capture shows the whole desk.
  const style = await page.addStyleTag({ content: 'html,body,#root,.shell{height:auto!important}.content{overflow:visible!important}.rail{position:sticky;top:0;height:100vh}.analyst{height:720px!important}' });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
  await style.evaluate((el) => el.remove());
}
const noErrors = (page) => assert(page.errors.length === 0, `browser errors:\n${page.errors.join('\n')}`);
const panel = (page, name) => page.locator(`section[aria-label="${name}"]`);

async function main() {
  // ------------------------------------------------------------------ run 1: full journeys
  const dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-e2e-')), 'e2e.db');
  let server = await startServer({ E2E_DB: dbFile });
  const browser = await chromium.launch();
  const page = await newPage(browser);

  await test('first run shows honest empty states on every desk', async () => {
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.getByText('No news has been ingested yet').waitFor();
    await page.getByText('No holdings recorded').waitFor();
    await page.getByText('Nothing scheduled').waitFor();
    await page.getByText('No runs logged').waitFor();
    assert((await page.locator('.strip a').count()) === 13, 'market strip should list 13 instruments');
    await shot(page, '01-situation-empty');
    await page.goto(`${BASE}/markets?tab=portfolio`, { waitUntil: 'networkidle' });
    await page.getByText('Start your portfolio').waitFor();
    await page.goto(`${BASE}/personal?tab=training`, { waitUntil: 'networkidle' });
    await page.getByText('Your training log is empty').waitFor();
    await page.goto(`${BASE}/personal?tab=analytics`, { waitUntil: 'networkidle' });
    await page.getByText('No activity to analyse yet').waitFor();
    noErrors(page);
  });

  await test('refreshing feeds ingests news and ranks developments', async () => {
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Refresh' }).click();
    await page.getByText(/Feeds refreshed: 12 new articles/).waitFor();
    const first = page.locator('.story').first();
    await first.getByText(/earthquake/i).waitFor();
    assert((await first.locator('.score').innerText()).trim() === '73', 'top story should score 73');
    await first.getByText('3 outlets').waitFor();
    assert((await page.locator('.map-land.has-data').count()) >= 8, 'map should colour countries with coverage');
    assert((await page.locator('.rail-foot').innerText()).includes('just now'), 'status footer should show a fresh ingest');
    noErrors(page);
  });

  await test('intelligence: filter by country from the map, open a development, see facts split from assessment', async () => {
    await page.goto(`${BASE}/intel`, { waitUntil: 'networkidle' });
    assert((await page.locator('.story').count()) === 8, 'eight developments in 48h');
    await page.getByLabel('Filter by country').selectOption('JPN');
    await page.waitForFunction(() => document.querySelectorAll('.story').length === 1);
    assert(page.url().includes('country=JPN'), 'filter should be reflected in the URL');
    await panel(page, 'Coverage volume: Japan').getByText(/3 articles in this period/).waitFor();
    await page.getByText(/does not yet reach back far enough/).waitFor();
    await page.locator('.story').first().click();
    const drawer = page.getByRole('dialog', { name: 'Development' });
    await drawer.getByText('What the sources report').waitFor();
    assert((await drawer.locator('.source-line a.headline').count()) >= 3, 'each report should link to its source');
    const href = await drawer.locator('.source-line a.headline').first().getAttribute('href');
    assert(/^http:\/\/127\.0\.0\.1:\d+\/articles\//.test(href), 'source link should point at the publisher');
    await drawer.getByText('Platform assessment').waitFor();
    await drawer.getByText(/3 independent outlets carried this/).waitFor();
    await drawer.getByText('24 / 40').waitFor();
    await shot(page, '03-intel-development');
    await page.keyboard.press('Escape');
    await drawer.waitFor({ state: 'detached' });
    await page.getByRole('button', { name: 'Clear filters' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.story').length === 8);
    // Clicking a country on the map applies the same filter.
    await page.locator('.map-land.has-data').first().click({ force: true });
    await page.waitForFunction(() => new URL(location.href).searchParams.has('country'));
    noErrors(page);
  });

  await test('intelligence: wire separates reporting from commentary and searches', async () => {
    await page.goto(`${BASE}/intel?tab=wire`, { waitUntil: 'networkidle' });
    await panel(page, 'Wire').getByText('12 articles, newest first').waitFor();
    await page.getByRole('button', { name: 'Analysis & opinion' }).click();
    await panel(page, 'Wire').getByText('1 article, newest first').waitFor();
    await page.locator('.wire-item .chip.amber', { hasText: 'Opinion' }).waitFor();
    await page.getByRole('button', { name: 'Reporting', exact: true }).click();
    await panel(page, 'Wire').getByText('11 articles, newest first').waitFor();
    await page.getByLabel('Search the archive').fill('drone odesa');
    await panel(page, 'Wire').getByText('1 article, newest first').waitFor();
    await page.getByLabel('Search the archive').fill('zzzz');
    await page.getByText('No articles match').waitFor();
    noErrors(page);
  });

  await test('intelligence: historical comparison and long-range attention', async () => {
    await page.goto(`${BASE}/intel?tab=compare`, { waitUntil: 'networkidle' });
    await page.getByText('Choose a country to compare').waitFor();
    await page.getByLabel('First country').selectOption('JPN');
    await page.getByLabel('Second country (optional)').selectOption('UKR');
    await panel(page, 'Japan').getByText('before the archive began').waitFor();
    await panel(page, 'Ukraine').getByText('Conflict & security').waitFor();
    await panel(page, 'Long-range global attention').locator('svg[role="img"]').waitFor();
    assert((await panel(page, 'Coverage in this archive').locator('.legend span').count()) === 2, 'two series in the legend');
    await shot(page, '04-intel-compare');
    noErrors(page);
  });

  await test('intelligence: manage sources and surface a failing feed', async () => {
    await page.goto(`${BASE}/intel?tab=sources`, { waitUntil: 'networkidle' });
    await page.getByLabel('Name').fill('Broken feed');
    await page.getByLabel('RSS or Atom URL').fill('http://127.0.0.1:4598/feeds/broken.xml');
    await page.getByRole('button', { name: 'Add feed' }).click();
    await page.getByText('Source added. Refresh to fetch it.').waitFor();
    await page.getByRole('button', { name: 'Fetch all now' }).click();
    const row = page.locator('tr', { hasText: 'Broken feed' });
    await row.getByText('Failing').waitFor();
    await row.getByText('not an RSS or Atom feed').waitFor();
    assert((await page.locator('.rail-foot .dot.warn').count()) === 1, 'status footer should warn about the failing feed');
    await row.getByRole('button', { name: 'Remove Broken feed' }).click();
    await row.getByRole('button', { name: 'Confirm: Remove Broken feed' }).click();
    await row.waitFor({ state: 'detached' });
    noErrors(page);
  });

  await test('markets: board, watchlist and instrument search', async () => {
    await page.goto(`${BASE}/markets`, { waitUntil: 'networkidle' });
    assert((await panel(page, 'Market board').locator('tr.clickable').count()) === 13, 'board lists 13 instruments');
    await panel(page, 'Market board').getByText('Delayed', { exact: true }).waitFor();
    await page.getByText('Your watchlist is empty').waitFor();
    await page.getByLabel('Add a ticker').fill('nvda');
    await page.getByRole('button', { name: /NVDA/ }).click();
    await page.getByText('NVDA added to watchlist').waitFor();
    await panel(page, 'Watchlist').getByText('NVIDIA Corporation').waitFor();
    await page.getByLabel('Add a ticker').fill('NOPE');
    await page.getByLabel('Add a ticker').press('Enter');
    await page.locator('.toast.error', { hasText: /no data/i }).waitFor();
    await shot(page, '05-markets');
    await page.getByLabel('Find a ticker or company').fill('apple');
    await page.getByRole('button', { name: /AAPL/ }).click();
    await page.waitForURL(/\/markets\/AAPL/);
    noErrors(page);
  });

  await test('markets: instrument page with chart controls, filed financials, risk and notes', async () => {
    await page.goto(`${BASE}/markets/AAPL`, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: /Apple Inc\./ }).waitFor();
    await page.getByText(/Last trade .* Yahoo Finance/).waitFor();
    const chart = panel(page, 'Price');
    await chart.locator('svg[role="img"]').waitFor();
    await chart.getByRole('button', { name: 'Candles' }).click();
    await page.waitForFunction(() => document.querySelectorAll('section[aria-label="Price"] svg rect').length > 200);
    await chart.getByRole('button', { name: 'SMA 20' }).click();
    await chart.getByText('20-bar moving average').waitFor();
    await chart.getByRole('button', { name: '1M', exact: true }).click();
    await chart.getByText(/Daily bars/).waitFor();
    await page.waitForFunction(() => { const n = document.querySelectorAll('section[aria-label="Price"] svg line').length; return n > 20 && n < 80; });
    await chart.getByRole('button', { name: '1D', exact: true }).click();
    await chart.getByText(/Intraday bars, delayed/).waitFor();
    await chart.getByRole('button', { name: '1Y', exact: true }).click();
    await chart.locator('svg[role="img"]').hover({ position: { x: 300, y: 120 } });
    await chart.locator('.tip', { hasText: 'Close' }).waitFor();
    const fin = panel(page, 'Financial statements');
    await fin.getByText('$410.00B').waitFor();
    await fin.getByRole('link', { name: 'View filings on EDGAR' }).waitFor();
    await panel(page, 'Key figures').getByText('Price / earnings').waitFor();
    await panel(page, 'Risk profile').getByText('Annualised volatility').waitFor();
    await page.getByRole('button', { name: 'New note' }).click();
    const dlg = page.getByRole('dialog');
    await dlg.getByLabel('Title').fill('Services margin thesis');
    await dlg.getByLabel('Stance').selectOption('bullish');
    await dlg.getByLabel('Target price (optional)').fill('400');
    await dlg.getByLabel('Reasoning').fill('Recurring revenue is growing faster than hardware.');
    await dlg.getByRole('button', { name: 'Save note' }).click();
    await panel(page, 'Research notes').getByText('Services margin thesis').waitFor();
    await panel(page, 'Research notes').getByText('Bullish').waitFor();
    await shot(page, '06-instrument');
    await page.goto(`${BASE}/markets/NOPE`, { waitUntil: 'networkidle' });
    await page.getByText('No data for “NOPE”').waitFor();
    await page.goto(`${BASE}/markets/%5EGSPC`, { waitUntil: 'networkidle' });
    await page.getByText(/No SEC filings for this symbol/).waitFor();
    noErrors(page);
  });

  await test('markets: portfolio transactions, validation, valuation and risk analysis', async () => {
    await page.goto(`${BASE}/markets?tab=portfolio`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Record a transaction' }).click();
    const dlg = page.getByRole('dialog');
    const record = async (symbol, side, qty, price, date) => {
      await dlg.getByLabel('Ticker').fill(symbol);
      await dlg.getByLabel('Side').selectOption(side);
      await dlg.getByLabel('Trade date').fill(date);
      await dlg.getByLabel('Quantity').fill(String(qty));
      await dlg.getByLabel('Price per unit (USD)').fill(String(price));
      await dlg.getByRole('button', { name: 'Record transaction' }).click();
    };
    await record('AAPL', 'sell', 5, 200, localDate(-30));
    await dlg.getByText(/Cannot sell 5 AAPL/).waitFor();
    await record('AAPL', 'buy', 40, 150, localDate(-200));
    await dlg.waitFor({ state: 'detached' });
    for (const [s, q, p] of [['MSFT', 12, 380], ['NVDA', 60, 70], ['VOD.L', 3000, 0.95]]) {
      await page.getByRole('button', { name: 'Record transaction' }).click();
      await record(s, 'buy', q, p, localDate(-120));
      await dlg.waitFor({ state: 'detached' });
    }
    await page.getByRole('button', { name: 'Record transaction' }).click();
    await record('AAPL', 'sell', 10, 210, localDate(-10));
    await dlg.waitFor({ state: 'detached' });
    const positions = panel(page, 'Positions');
    await page.waitForFunction(() => document.querySelectorAll('section[aria-label="Positions"] tbody tr').length === 4);
    const aapl = positions.locator('tr', { hasText: 'AAPL' });
    assert((await aapl.locator('td').nth(1).innerText()).trim() === '30', 'AAPL quantity should be 30 after the sell');
    await positions.locator('tr', { hasText: 'VOD.L' }).getByText('GBp').waitFor();
    await panel(page, 'Summary').getByText('Realised gain', { exact: true }).waitFor();
    const risk = panel(page, 'Risk analysis');
    await risk.getByText('One-day 95% VaR').waitFor({ timeout: 15_000 });
    await risk.getByText('Correlation of daily returns').waitFor();
    assert((await risk.locator('.heat [role="cell"]').count()) === 16, '4x4 correlation matrix');
    await risk.getByText(/with today's weights held constant/).waitFor();
    assert((await panel(page, 'Transactions').locator('tbody tr').count()) === 5, 'five transactions listed');
    await shot(page, '07-portfolio');
    noErrors(page);
  });

  await test('personal: tasks, deadlines and the merged agenda', async () => {
    await page.goto(`${BASE}/personal`, { waitUntil: 'networkidle' });
    await page.getByText('No tasks yet').waitFor();
    await page.getByLabel('New task').fill('Review Q3 portfolio');
    await page.getByRole('button', { name: 'Add task' }).click();
    await page.locator('.task', { hasText: 'Review Q3 portfolio' }).getByText(/Today/).waitFor();
    await page.getByLabel('New task').fill('Renew passport');
    await page.getByLabel('Due date').fill(localDate(-3));
    await page.getByLabel('Priority').selectOption('1');
    await page.getByLabel('New task').press('Enter');
    await page.locator('.task', { hasText: 'Renew passport' }).getByText(/3d overdue/).waitFor();
    await page.getByLabel('What is due').fill('Tax return');
    await page.getByLabel('Date', { exact: true }).fill(localDate(21));
    await page.getByLabel('Category').fill('finance');
    await page.getByRole('button', { name: 'Add deadline' }).click();
    const upcoming = panel(page, 'Upcoming');
    await upcoming.getByText('Tax return').waitFor();
    assert((await upcoming.locator('.agenda-item').count()) === 3, 'agenda merges two tasks and a deadline');
    assert((await upcoming.locator('.agenda-item').first().innerText()).includes('Renew passport'), 'soonest (overdue) item first');
    // Edit, complete, un-complete.
    await page.locator('.task', { hasText: 'Renew passport' }).hover();
    await page.locator('.task', { hasText: 'Renew passport' }).getByRole('button', { name: 'Edit task' }).click();
    await page.getByRole('dialog').getByLabel('Task').fill('Renew passport online');
    await page.getByRole('dialog').getByRole('button', { name: 'Save changes' }).click();
    await page.locator('.task', { hasText: 'Renew passport online' }).waitFor();
    await page.getByRole('checkbox', { name: /Review Q3 portfolio/ }).click();
    await page.locator('.task', { hasText: 'Review Q3 portfolio' }).waitFor({ state: 'detached' });
    await page.getByRole('button', { name: 'Completed' }).click();
    await page.locator('.task.done', { hasText: 'Review Q3 portfolio' }).waitFor();
    await page.getByRole('button', { name: 'Open', exact: true }).click();
    await shot(page, '08-personal-today');
    noErrors(page);
  });

  await test('personal: log runs by form and GPX, see training analytics', async () => {
    // Twelve weeks of history via the API, then the UI flows on top.
    for (let w = 11; w >= 1; w--) {
      for (const [dayOffset, km, paceS, kind] of [[1, 6 + (w % 3), 330 - w, 'easy'], [3, 8, 300 - w, 'tempo'], [6, 14 + (11 - w) * 0.5, 345 - w, 'long']]) {
        await api('/personal/runs', { method: 'POST', body: { runOn: localDate(-(w * 7) + dayOffset - 3), distanceKm: km, durationS: Math.round(km * paceS), kind } });
      }
    }
    await page.goto(`${BASE}/personal?tab=training`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Log a run' }).click();
    const dlg = page.getByRole('dialog');
    await dlg.getByLabel('Distance (km)').fill('10');
    await dlg.getByLabel('Time').fill('abc');
    await dlg.getByRole('button', { name: 'Log run' }).click();
    await dlg.getByText(/Enter the time as mm:ss/).waitFor();
    await dlg.getByLabel('Time').fill('47:30');
    await dlg.getByText('Pace 4:45 per km').waitFor();
    await dlg.getByLabel('Type').selectOption('tempo');
    await dlg.getByRole('button', { name: 'Log run' }).click();
    await page.getByText('Run logged').waitFor();
    const gpx = `<?xml version="1.0"?><gpx version="1.1"><trk><name>Riverside loop</name><trkseg>${Array.from({ length: 40 }, (_, i) => `<trkpt lat="${(51.5 + i * 0.0012).toFixed(5)}" lon="-0.12"><ele>${10 + (i % 5)}</ele><time>${new Date(Date.now() - 86_400_000 + i * 45_000).toISOString()}</time></trkpt>`).join('')}</trkseg></trk></gpx>`;
    await page.locator('input[type=file]').setInputFiles([{ name: 'run.gpx', mimeType: 'application/gpx+xml', buffer: Buffer.from(gpx) }, { name: 'bad.gpx', mimeType: 'application/gpx+xml', buffer: Buffer.from('not xml at all') }]);
    await page.getByText('Imported 1 run from GPX').waitFor();
    await page.locator('.toast.error', { hasText: /bad\.gpx/ }).waitFor();
    const log = panel(page, 'Log');
    await log.getByText('Riverside loop').waitFor();
    await log.locator('.chip', { hasText: 'GPX' }).waitFor();
    assert((await log.locator('tbody tr').count()) === 35, '33 seeded + 1 form + 1 GPX runs');
    await panel(page, 'Weekly distance').locator('svg[role="img"]').waitFor();
    assert((await panel(page, 'Weekly distance').locator('svg path').count()) >= 11, 'weekly bars rendered');
    await panel(page, 'Pace').getByText(/Best pace, 10 km\+/).waitFor();
    await panel(page, 'Running').getByText('Load ratio').waitFor();
    await shot(page, '09-personal-training');
    noErrors(page);
  });

  await test('personal: objectives track progress against the calendar', async () => {
    await page.goto(`${BASE}/personal?tab=objectives`, { waitUntil: 'networkidle' });
    await page.getByText('No objectives set').waitFor();
    await page.getByRole('button', { name: 'New objective' }).click();
    const dlg = page.getByRole('dialog');
    await dlg.getByLabel('Objective').fill('Run 1,200 km this year');
    await dlg.getByLabel('Target value').fill('0');
    await dlg.getByRole('button', { name: 'Create objective' }).click();
    await dlg.getByText(/Target must differ/).waitFor();
    await dlg.getByLabel('Target value').fill('1200');
    await dlg.getByLabel('Unit').fill('km');
    await dlg.getByLabel('Target date (optional)').fill(localDate(50));
    await dlg.getByRole('button', { name: 'Create objective' }).click();
    const card = panel(page, 'Run 1,200 km this year');
    await card.getByText('0% complete').waitFor();
    await card.getByLabel('New value').fill('900');
    await card.getByLabel('Note').fill('after autumn block');
    await card.getByRole('button', { name: 'Record progress' }).click();
    await card.getByText('75% complete').waitFor();
    await card.getByText('Ahead of schedule').waitFor();
    await card.getByLabel('New value').fill('1200');
    await card.getByRole('button', { name: 'Record progress' }).click();
    await card.getByText('Achieved').waitFor();
    await api('/personal/objectives', { method: 'POST', body: { title: 'Read 24 books', unit: 'books', targetValue: 24, dueOn: localDate(40), category: 'learning' } });
    await api('/personal/objectives', { method: 'POST', body: { title: 'Sub-45 minute 10K', unit: 'min', startValue: 49.5, targetValue: 45, dueOn: localDate(90), category: 'fitness' } });
    const list = await api('/personal/objectives');
    await api(`/personal/objectives/${list.find((o) => o.title === 'Sub-45 minute 10K').id}/progress`, { method: 'POST', body: { value: 47.5 } });
    await page.reload({ waitUntil: 'networkidle' });
    await panel(page, 'Sub-45 minute 10K').getByText('44% complete').waitFor();
    await shot(page, '10-personal-objectives');
    await page.goto(`${BASE}/personal?tab=analytics`, { waitUntil: 'networkidle' });
    await panel(page, 'Execution').getByText('Tasks completed').waitFor();
    await panel(page, 'Training volume and pace').locator('svg[role="img"]').first().waitFor();
    await shot(page, '11-personal-analytics');
    noErrors(page);
  });

  await test('analyst: streamed answer with research steps, sources and saved history', async () => {
    await page.goto(`${BASE}/analyst`, { waitUntil: 'networkidle' });
    await page.getByText('Ask about anything on the platform').waitFor();
    await page.getByLabel('Message the analyst').fill('What is the lead story?');
    await page.getByLabel('Message the analyst').press('Enter');
    await page.locator('.msg-user', { hasText: 'What is the lead story?' }).waitFor();
    await page.locator('.steps', { hasText: 'Reading top stories' }).waitFor();
    const answer = page.locator('.msg-ai .prose').last();
    await answer.getByRole('heading', { name: 'Bottom line' }).waitFor();
    const link = answer.getByRole('link').first();
    assert(/articles\//.test(await link.getAttribute('href')), 'answer should cite a source link');
    assert((await link.getAttribute('target')) === '_blank', 'source links open in a new tab');
    await page.locator('.sources summary', { hasText: /sources consulted/ }).click();
    assert((await page.locator('.sources li').count()) >= 3, 'sources list should be populated');
    await page.locator('.thread', { hasText: 'What is the lead story?' }).waitFor();
    await shot(page, '12-analyst-chat');
    // Reload: the conversation is persisted and can be reopened.
    await page.reload({ waitUntil: 'networkidle' });
    await page.locator('.thread', { hasText: 'What is the lead story?' }).click();
    await page.locator('.msg-ai .prose').getByRole('heading', { name: 'Bottom line' }).waitFor();
    // Deep link from another desk prefills the question.
    await page.goto(`${BASE}/analyst?q=${encodeURIComponent('REFUSE this please')}`, { waitUntil: 'networkidle' });
    assert((await page.getByLabel('Message the analyst').inputValue()) === 'REFUSE this please', 'question should be prefilled from the link');
    await page.getByRole('button', { name: 'Send' }).click();
    await page.getByText('The model declined to answer this request.').first().waitFor();
    assert((await page.locator('.thread', { hasText: 'REFUSE' }).count()) === 0, 'a declined request is not saved as a conversation');
    noErrors(page);
  });

  await test('analyst: generate, view, download and delete reports', async () => {
    await page.goto(`${BASE}/analyst?tab=reports`, { waitUntil: 'networkidle' });
    await page.getByText('Choose or generate a report').waitFor();
    await page.getByRole('button', { name: 'Data digest' }).click();
    await page.getByRole('button', { name: 'Generate report' }).click();
    await page.getByText('Report saved').waitFor();
    const viewer = page.locator('.prose').first();
    await viewer.getByText(/no AI-written analysis/).waitFor();
    await viewer.getByRole('heading', { name: 'World developments, last 48 hours' }).waitFor();
    await viewer.getByRole('heading', { name: 'Portfolio' }).waitFor();
    await viewer.getByText(/Renew passport online/).waitFor();
    assert((await viewer.locator('table').count()) >= 2, 'digest should contain market and portfolio tables');
    await shot(page, '13-analyst-report');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download' }).click()]);
    assert(/^daily-brief-.*\.md$/.test(dl.suggestedFilename()), `unexpected download name ${dl.suggestedFilename()}`);
    await page.getByLabel('Report type').selectOption('compare-companies');
    await page.getByLabel('First ticker').fill('AAPL');
    await page.getByLabel('Second ticker').fill('MSFT');
    await page.getByRole('button', { name: 'Generate report' }).click();
    await page.getByText('Report saved').nth(0).waitFor();
    await page.locator('.prose').first().getByRole('heading', { name: 'MSFT' }).waitFor();
    await page.getByLabel('Report type').selectOption('country');
    await page.getByLabel(/^Country/).selectOption('JPN');
    await page.getByRole('button', { name: 'AI analyst' }).click();
    await page.getByRole('button', { name: 'Generate report' }).click();
    await page.locator('.thread', { hasText: 'Country report: Japan' }).waitFor();
    assert((await page.locator('.panel-head .meta', { hasText: 'written by claude-opus-5-5' }).count()) === 1, 'AI report should name its engine');
    assert((await panel(page, 'Saved reports').locator('.thread').count()) === 3, 'three saved reports');
    const row = page.locator('.thread', { hasText: 'Comparison: AAPL and MSFT' });
    await row.hover();
    await row.getByRole('button', { name: 'Delete report' }).click();
    await row.getByRole('button', { name: 'Confirm: Delete report' }).click();
    await row.waitFor({ state: 'detached' });
    noErrors(page);
  });

  await test('navigation: command palette, keyboard shortcuts and deep links', async () => {
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await shot(page, '02-situation');
    await page.keyboard.press('3');
    await page.waitForURL(/\/markets$/);
    await page.keyboard.press('/');
    const palette = page.getByRole('dialog', { name: 'Go to' });
    await palette.getByLabel('Search').fill('japan');
    await palette.getByRole('option', { name: /Japan/ }).waitFor();
    await page.keyboard.press('Enter');
    await page.waitForURL(/\/intel\?country=JPN/);
    await page.keyboard.press('Control+k');
    await page.getByRole('dialog', { name: 'Go to' }).getByLabel('Search').fill('msft');
    await page.getByRole('option', { name: /MSFT/ }).click();
    await page.waitForURL(/\/markets\/MSFT/);
    await page.goto(`${BASE}/nowhere`, { waitUntil: 'networkidle' });
    await page.getByText('There is nothing at this address').waitFor();
    noErrors(page);
  });

  await test('data persists across a server restart', async () => {
    await stop(server);
    server = await startServer({ E2E_DB: dbFile });
    const status = await api('/status');
    assert(status.news.articleCount === 12, 'articles survive a restart');
    await page.goto(`${BASE}/markets?tab=portfolio`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => document.querySelectorAll('section[aria-label="Positions"] tbody tr').length === 4);
    await page.goto(`${BASE}/analyst`, { waitUntil: 'networkidle' });
    await page.locator('.thread', { hasText: 'What is the lead story?' }).waitFor();
    await page.goto(`${BASE}/personal?tab=objectives`, { waitUntil: 'networkidle' });
    await panel(page, 'Run 1,200 km this year').getByText('Achieved').waitFor();
    noErrors(page);
  });

  await test('mobile layout: bottom tab bar, no horizontal overflow', async () => {
    const m = await newPage(browser, { mobile: true });
    for (const [name, url] of [['situation', '/'], ['intel', '/intel'], ['markets', '/markets?tab=portfolio'], ['instrument', '/markets/AAPL'], ['personal', '/personal?tab=training'], ['analyst', '/analyst']]) {
      await m.goto(BASE + url, { waitUntil: 'networkidle' });
      await m.waitForTimeout(250);
      const overflow = await m.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert(overflow <= 1, `${name} overflows horizontally by ${overflow}px on mobile`);
      assert(await m.locator('.tabbar').isVisible(), 'bottom tab bar visible');
      assert(!(await m.locator('.rail').isVisible()), 'side rail hidden');
      await shot(m, `20-mobile-${name}`);
    }
    await m.locator('.tabbar a', { hasText: 'Markets' }).click();
    await m.waitForURL(/\/markets/);
    noErrors(m);
    await m.context().close();
  });

  await browser.close();
  await stop(server);

  // ------------------------------------------------------------------ run 2: no AI key, providers down
  server = await startServer({ E2E_NO_AI: '1' });
  const browser2 = await chromium.launch();
  const p2 = await newPage(browser2);

  await test('without an API key the analyst explains itself and digests still work', async () => {
    await p2.goto(`${BASE}/analyst`, { waitUntil: 'networkidle' });
    await p2.getByText('The AI analyst is not configured.').waitFor();
    assert(await p2.getByLabel('Message the analyst').isDisabled(), 'composer disabled without a key');
    assert((await p2.locator('.rail-foot').innerText()).includes('no key'), 'status footer shows no key');
    await p2.goto(`${BASE}/analyst?tab=reports`, { waitUntil: 'networkidle' });
    assert((await p2.getByRole('button', { name: 'Data digest' }).getAttribute('aria-pressed')) === 'true', 'digest is the default engine without a key');
    await p2.getByRole('button', { name: 'Generate report' }).click();
    await p2.getByText('Report saved').waitFor();
    await p2.locator('.prose').getByText(/The news archive has nothing from the last 48 hours/).waitFor();
    await p2.getByRole('button', { name: 'AI analyst' }).click();
    assert(await p2.getByRole('button', { name: 'Generate report' }).isDisabled(), 'AI report disabled without a key');
    await shot(p2, '14-analyst-no-key');
    noErrors(p2);
  });

  await test('when market data is unreachable the UI says so instead of showing numbers', async () => {
    await p2.route('**/api/markets/board', (r) => r.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: { code: 'upstream_unavailable', message: 'Yahoo Finance: timed out after 12000ms' } }) }));
    await p2.goto(`${BASE}/markets`, { waitUntil: 'networkidle' });
    await panel(p2, 'Market board').getByText('Yahoo Finance: timed out after 12000ms').waitFor({ timeout: 15_000 });
    await panel(p2, 'Market board').getByRole('button', { name: 'Try again' }).waitFor();
    await p2.unroute('**/api/markets/board');
    await panel(p2, 'Market board').getByRole('button', { name: 'Try again' }).click();
    await p2.waitForFunction(() => document.querySelectorAll('section[aria-label="Market board"] tr.clickable').length === 13);
  });

  await browser2.close();
  await stop(server);
}

try {
  await main();
} catch (err) {
  failed++;
  results.push(`  FAIL  harness: ${err.stack ?? err}`);
}
console.log(`\nEnd-to-end results\n${results.join('\n')}\n\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
