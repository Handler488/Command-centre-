import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ChartNote, CorrelationMatrix, HBars, LineChart, PriceChart } from '../charts/charts.tsx';
import { api, type Company, type Note, type RangeKey, todayLocal } from '../lib/api.ts';
import { ago, dateTime, day, money, num, pct, price, share, signed, tone } from '../lib/format.ts';
import { useAct, useBoard, useCompany, useHistory, useNotes, usePortfolio, usePortfolioRisk, useSymbolSearch, useTransactions, useWatchlist } from '../lib/queries.ts';
import { ConfirmButton, Empty, ErrorBox, Field, Freshness, Icon, Load, Modal, Panel, Seg, Skeleton, Stat } from '../ui/kit.tsx';

const RANGE_KEYS: RangeKey[] = ['1D', '5D', '1M', '6M', 'YTD', '1Y', '5Y'];
const symPath = (s: string) => `/markets/${encodeURIComponent(s)}`;

function SymbolSearch({ onPick, placeholder = 'Find a ticker or company', autoFocus }: { onPick: (symbol: string) => void; placeholder?: string; autoFocus?: boolean }) {
  const [term, setTerm] = useState('');
  const [debounced, setDebounced] = useState('');
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(term.trim()), 250);
    return () => clearTimeout(t);
  }, [term]);
  const hits = useSymbolSearch(debounced);
  const pick = (s: string) => { onPick(s.toUpperCase()); setTerm(''); setOpen(false); };
  const submit = () => {
    const t = term.trim();
    if (!t) return;
    // Only trust search results that belong to what is typed right now.
    const fresh = debounced === t ? (hits.data ?? []) : [];
    pick(fresh.find((h) => h.symbol.toUpperCase() === t.toUpperCase())?.symbol ?? fresh[0]?.symbol ?? t);
  };
  return (
    <form style={{ position: 'relative', width: 280, maxWidth: '100%' }} onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <input className="input" autoFocus={autoFocus} value={term} placeholder={placeholder} aria-label={placeholder} onChange={(e) => { setTerm(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)} />
      {open && debounced && debounced === term.trim() && (
        <div className="tip wrap" style={{ pointerEvents: 'auto', top: 34, left: 0, right: 0, maxWidth: 'none', padding: 4 }}>
          {hits.isFetching && <div className="muted" style={{ padding: 8 }}>Searching…</div>}
          {hits.isError && <div className="muted" style={{ padding: 8 }}>Search is unavailable. Press Enter to open “{term.trim().toUpperCase()}” directly.</div>}
          {hits.data?.length === 0 && <div className="muted" style={{ padding: 8 }}>No instruments match.</div>}
          {hits.data?.map((h) => (
            <button type="button" key={h.symbol} className="palette-item" onMouseDown={(e) => e.preventDefault()} onClick={() => pick(h.symbol)}>
              <span className="sym">{h.symbol}</span><span className="truncate muted">{h.name}</span><span className="faint nowrap">{h.exchange}</span>
            </button>
          ))}
        </div>
      )}
    </form>
  );
}

function Change({ pctValue, abs }: { pctValue: number | null | undefined; abs?: number | null }) {
  return <span className={tone(pctValue)}>{abs != null && `${signed(abs)}  `}{pct(pctValue)}</span>;
}

// ---- overview ---------------------------------------------------------------------
function Overview() {
  const navigate = useNavigate();
  const board = useBoard();
  const watch = useWatchlist();
  const add = useAct((symbol: string) => api.post<{ symbol: string }>('/markets/watchlist', { symbol }), { invalidate: ['markets'], success: (r) => `${r.symbol} added to watchlist` });
  const remove = useAct((symbol: string) => api.del(`/markets/watchlist/${encodeURIComponent(symbol)}`), { invalidate: ['markets'] });
  const groups = [...new Set((board.data ?? []).map((b) => b.group))];
  const newest = (board.data ?? []).map((b) => b.quote?.asOf).filter(Boolean).sort().at(-1);
  return (
    <div className="grid split">
      <Panel title="Market board" flush foot={<><span className="chip outline">Delayed</span><span>Indicative prices from Yahoo Finance, not real-time.{newest ? ` Latest trade ${ago(newest)}.` : ''}</span></>}>
        <Load q={board} rows={12}>
          {(rows) => (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Instrument</th><th className="num">Last</th><th className="num">Change</th><th className="num hide-sm">Day range</th><th className="num hide-sm">As of</th></tr></thead>
                {groups.map((g) => (
                  <tbody key={g}>
                    <tr><td colSpan={5} className="faint small" style={{ paddingTop: 12, paddingBottom: 4, borderBottom: 0 }}>{g}</td></tr>
                    {rows.filter((r) => r.group === g).map((r) => (
                      <tr key={r.symbol} className="clickable" onClick={() => navigate(symPath(r.symbol))}>
                        <td><Link to={symPath(r.symbol)} className="sym" onClick={(e) => e.stopPropagation()}>{r.label}</Link> {r.stale && <span className="chip warn">Stale</span>}</td>
                        {r.quote ? (
                          <>
                            <td className="num"><b>{price(r.quote.price)}</b></td>
                            <td className="num"><Change pctValue={r.quote.changePct} /></td>
                            <td className="num hide-sm muted">{r.quote.dayLow != null && r.quote.dayHigh != null ? `${price(r.quote.dayLow)} – ${price(r.quote.dayHigh)}` : '–'}</td>
                            <td className="num hide-sm faint">{dateTime(r.quote.asOf)}</td>
                          </>
                        ) : <td colSpan={4} className="num faint">Unavailable: {r.error}</td>}
                      </tr>
                    ))}
                  </tbody>
                ))}
              </table>
            </div>
          )}
        </Load>
      </Panel>
      <Panel title="Watchlist" flush actions={<SymbolSearch placeholder="Add a ticker" onPick={(s) => add.mutate(s)} />}>
        <Load q={watch} rows={6}>
          {(rows) =>
            rows.length === 0 ? (
              <Empty title="Your watchlist is empty">Search for a ticker above to start following it. Try AAPL, ^FTSE or BTC-USD.</Empty>
            ) : (
              <table className="table">
                <thead><tr><th>Symbol</th><th className="num">Last</th><th className="num">Change</th><th /></tr></thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.symbol} className="clickable" onClick={() => navigate(symPath(r.symbol))}>
                      <td><Link to={symPath(r.symbol)} className="sym" onClick={(e) => e.stopPropagation()}>{r.symbol}</Link><div className="small faint truncate" style={{ maxWidth: 180 }}>{r.quote?.name ?? r.name}</div></td>
                      <td className="num"><b>{r.quote ? price(r.quote.price) : '–'}</b>{r.quote?.currency && <div className="small faint">{r.quote.currency}</div>}</td>
                      <td className="num">{r.quote ? <Change pctValue={r.quote.changePct} /> : <span className="faint small">{r.error}</span>}</td>
                      <td className="num"><ConfirmButton label={`Remove ${r.symbol} from watchlist`} onConfirm={() => remove.mutate(r.symbol)} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          }
        </Load>
      </Panel>
    </div>
  );
}

// ---- instrument -------------------------------------------------------------------
function TransactionModal({ symbol, onClose }: { symbol?: string; onClose: () => void }) {
  const [form, setForm] = useState({ symbol: symbol ?? '', side: 'buy' as 'buy' | 'sell', quantity: '', price: '', fee: '', tradedOn: todayLocal(), note: '' });
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm({ ...form, [k]: e.target.value });
  const save = useAct(() => api.post('/markets/transactions', { symbol: form.symbol, side: form.side, quantity: Number(form.quantity), price: Number(form.price), fee: form.fee ? Number(form.fee) : 0, tradedOn: form.tradedOn, note: form.note }), { invalidate: ['markets'], success: 'Transaction recorded', onDone: onClose, quietError: true });
  return (
    <Modal title="Record a transaction" onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); save.mutate(undefined); }}>
        <div className="modal-body form">
          <div className="form-row">
            <Field label="Ticker"><input className="input" value={form.symbol} onChange={set('symbol')} placeholder="AAPL" required maxLength={15} style={{ textTransform: 'uppercase' }} /></Field>
            <Field label="Side"><select className="select" value={form.side} onChange={set('side')}><option value="buy">Buy</option><option value="sell">Sell</option></select></Field>
            <Field label="Trade date"><input className="input" type="date" value={form.tradedOn} max={todayLocal()} onChange={set('tradedOn')} required /></Field>
          </div>
          <div className="form-row">
            <Field label="Quantity"><input className="input" type="number" step="any" min="0" value={form.quantity} onChange={set('quantity')} required /></Field>
            <Field label="Price per unit (USD)"><input className="input" type="number" step="any" min="0" value={form.price} onChange={set('price')} required /></Field>
            <Field label="Fees (USD)"><input className="input" type="number" step="any" min="0" value={form.fee} onChange={set('fee')} placeholder="0" /></Field>
          </div>
          <Field label="Note (optional)"><input className="input" value={form.note} onChange={set('note')} maxLength={500} /></Field>
          <p className="small faint">Enter prices in US dollars. Positions use average cost; current values use delayed quotes converted to USD.</p>
          {save.isError && <div className="form-error" role="alert">{save.error.message}</div>}
        </div>
        <div className="modal-foot">
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Record transaction'}</button>
        </div>
      </form>
    </Modal>
  );
}

function NoteModal({ symbol, note, onClose }: { symbol: string; note?: Note; onClose: () => void }) {
  const [form, setForm] = useState({ title: note?.title ?? '', body: note?.body ?? '', stance: note?.stance ?? 'neutral', targetPrice: note?.targetPrice ? String(note.targetPrice) : '' });
  const payload = { symbol, title: form.title, body: form.body, stance: form.stance, targetPrice: form.targetPrice ? Number(form.targetPrice) : null };
  const save = useAct(() => (note ? api.put(`/markets/notes/${note.id}`, payload) : api.post('/markets/notes', payload)), { invalidate: ['markets'], success: 'Note saved', onDone: onClose, quietError: true });
  return (
    <Modal title={`${note ? 'Edit' : 'New'} research note: ${symbol}`} onClose={onClose} wide>
      <form onSubmit={(e) => { e.preventDefault(); save.mutate(undefined); }}>
        <div className="modal-body form">
          <Field label="Title"><input className="input" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} required maxLength={160} placeholder="Thesis in one line" /></Field>
          <div className="form-row">
            <Field label="Stance"><select className="select" value={form.stance} onChange={(e) => setForm({ ...form, stance: e.target.value as Note['stance'] })}><option value="bullish">Bullish</option><option value="neutral">Neutral</option><option value="bearish">Bearish</option></select></Field>
            <Field label="Target price (optional)"><input className="input" type="number" step="any" min="0" value={form.targetPrice} onChange={(e) => setForm({ ...form, targetPrice: e.target.value })} /></Field>
          </div>
          <Field label="Reasoning"><textarea className="textarea" rows={9} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} placeholder="What do you believe, what would prove you wrong, and what are you watching?" style={{ fontFamily: 'var(--serif)', fontSize: 15 }} /></Field>
          {save.isError && <div className="form-error" role="alert">{save.error.message}</div>}
        </div>
        <div className="modal-foot">
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Save note'}</button>
        </div>
      </form>
    </Modal>
  );
}

function Fundamentals({ c }: { c: Company }) {
  const f = c.fundamentals;
  if (!f) return <Panel title="Financial statements"><Empty title="No filed financials">{c.fundamentalsNote}</Empty></Panel>;
  const years = f.years;
  const row = (label: string, cell: (y: (typeof years)[number]) => string, strong = false) => (
    <tr><td className={strong ? '' : 'muted'}>{strong ? <b>{label}</b> : label}</td>{years.map((y) => <td key={y.periodEnd} className="num">{cell(y)}</td>)}</tr>
  );
  const m = (v: number | null) => money(v, { compact: true });
  return (
    <Panel title="Financial statements" meta={f.entityName} flush
      foot={<><span>Annual figures as filed with the SEC (10-K, XBRL).{f.stale ? ' Showing the last copy fetched; EDGAR is unreachable.' : ''}</span><a href={f.filingsUrl} target="_blank" rel="noreferrer">View filings on EDGAR</a></>}>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Fiscal year ending</th>{years.map((y) => <th key={y.periodEnd} className="num">{day(y.periodEnd)}</th>)}</tr></thead>
          <tbody>
            {row('Revenue', (y) => m(y.revenue), true)}
            {row('Revenue growth', (y) => (y.revenueGrowth == null ? '–' : pct(y.revenueGrowth * 100, 1)))}
            {row('Gross margin', (y) => share(y.grossMargin))}
            {row('Operating income', (y) => m(y.operatingIncome), true)}
            {row('Operating margin', (y) => share(y.operatingMargin))}
            {row('Net income', (y) => m(y.netIncome), true)}
            {row('Diluted EPS', (y) => num(y.epsDiluted))}
            {row('Operating cash flow', (y) => m(y.operatingCashFlow))}
            {row('Free cash flow', (y) => m(y.freeCashFlow), true)}
            {row('Cash', (y) => m(y.cash))}
            {row('Long-term debt', (y) => m(y.longTermDebt))}
            {row('Shareholders’ equity', (y) => m(y.equity))}
            {row('Return on equity', (y) => share(y.returnOnEquity))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function Instrument({ symbol }: { symbol: string }) {
  const [range, setRange] = useState<RangeKey>('1Y');
  const [mode, setMode] = useState<'line' | 'candles'>('line');
  const [smas, setSmas] = useState<number[]>([]);
  const [tx, setTx] = useState(false);
  const [noteModal, setNoteModal] = useState<{ note?: Note } | null>(null);
  const company = useCompany(symbol);
  const history = useHistory(symbol, range);
  const notes = useNotes(symbol);
  const watch = useWatchlist();
  const watched = watch.data?.some((w) => w.symbol === symbol);
  const add = useAct(() => api.post('/markets/watchlist', { symbol }), { invalidate: ['markets'], success: `${symbol} added to watchlist` });
  const remove = useAct(() => api.del(`/markets/watchlist/${encodeURIComponent(symbol)}`), { invalidate: ['markets'], success: `${symbol} removed from watchlist` });
  const delNote = useAct((id: number) => api.del(`/markets/notes/${id}`), { invalidate: ['markets'], success: 'Note deleted' });
  const toggleSma = (w: number) => setSmas((s) => (s.includes(w) ? s.filter((x) => x !== w) : [...s, w].sort((a, b) => a - b)));

  if (company.isError && !company.data) {
    return <Panel><Empty title={`No data for “${symbol}”`} icon={Icon.alert} action={<Link className="btn" to="/markets">Back to markets</Link>}>{company.error.message}. Check the ticker; symbols follow Yahoo Finance conventions, for example VOD.L, ^GSPC or EURUSD=X.</Empty></Panel>;
  }
  const c = company.data;
  const q = c?.quote?.quote;
  const candles = history.data?.candles ?? [];
  const periodReturn = candles.length > 1 ? (candles.at(-1)!.c / candles[0]!.c - 1) * 100 : null;
  const v = c?.valuation;
  const r = c?.risk;

  return (
    <div className="grid">
      <div className="row wrap" style={{ alignItems: 'flex-end', gap: 18 }}>
        <div className="grow">
          <div className="row" style={{ gap: 8 }}><Link to="/markets" className="small">Markets</Link><span className="faint">/</span><span className="small muted">{q?.exchange ?? ''}</span></div>
          <h2 className="headline lg" style={{ marginTop: 4 }}>{q?.name ?? symbol} <span className="faint" style={{ fontWeight: 500 }}>{symbol}</span></h2>
        </div>
        {q ? (
          <div className="right">
            <div style={{ font: '650 30px/1 var(--sans)' }}>{price(q.price)} <span className="faint" style={{ fontSize: 13, fontWeight: 500 }}>{q.currency}</span></div>
            <div style={{ marginTop: 5, fontWeight: 600 }}><Change pctValue={q.changePct} abs={q.change} /> <span className="faint" style={{ fontWeight: 400 }}>on the day</span></div>
          </div>
        ) : company.isPending ? <div className="skel" style={{ width: 160, height: 34 }} /> : null}
        <div className="row">
          <button className="btn" onClick={() => (watched ? remove.mutate(undefined) : add.mutate(undefined))} disabled={add.isPending || remove.isPending || watch.isPending}>{watched ? 'Unwatch' : 'Watch'}</button>
          <button className="btn" onClick={() => setTx(true)}>Record trade</button>
          <Link className="btn primary" to={`/analyst?q=${encodeURIComponent(`Give me a research briefing on ${symbol}: financials, valuation, risk and anything relevant in the news.`)}`}>Ask the analyst</Link>
        </div>
      </div>
      {c?.quote && <div className="small muted"><Freshness asOf={q?.asOf} provider={q?.provider} stale={c.quote.stale} fetchedAt={c.quote.fetchedAt} /></div>}

      <div className="grid split">
        <Panel title="Price" meta={periodReturn !== null ? <span className={tone(periodReturn)}>{pct(periodReturn)} over the period shown</span> : undefined}
          actions={<>
            <Seg label="Chart style" value={mode} onChange={setMode} options={[{ value: 'line', label: 'Line' }, { value: 'candles', label: 'Candles' }]} />
            <div className="seg hide-sm" role="group" aria-label="Moving averages">{[20, 50].map((w) => <button key={w} aria-pressed={smas.includes(w)} onClick={() => toggleSma(w)}>SMA {w}</button>)}</div>
          </>}
          foot={history.data ? <span>{history.data.provider}{history.data.stale ? ' (stale: provider unreachable)' : ''}. {range === '1D' || range === '5D' ? 'Intraday bars, delayed.' : range === '5Y' ? 'Weekly bars.' : 'Daily bars.'} Times are local.</span> : undefined}>
          <div style={{ marginBottom: 10 }}><Seg label="Range" value={range} onChange={setRange} options={RANGE_KEYS} /></div>
          {history.isPending ? <Skeleton rows={9} pad={false} /> : history.isError ? <ErrorBox what="Price history is unavailable" error={history.error} retry={() => void history.refetch()} /> : candles.length < 2 ? <Empty title="Not enough trading data for this range" /> : (
            <div style={{ opacity: history.isPlaceholderData ? 0.5 : 1, transition: 'opacity .15s' }}><PriceChart candles={candles} mode={mode} smas={smas} /></div>
          )}
        </Panel>
        <div className="stack" style={{ gap: 14 }}>
          <Panel title="Key figures">
            {!c ? <Skeleton rows={6} pad={false} /> : (
              <dl className="kv">
                <dt>Previous close</dt><dd>{price(q?.previousClose)}</dd>
                <dt>Day range</dt><dd>{q?.dayLow != null ? `${price(q.dayLow)} – ${price(q.dayHigh)}` : '–'}</dd>
                <dt>52-week range</dt><dd>{q?.fiftyTwoWeekLow != null ? `${price(q.fiftyTwoWeekLow)} – ${price(q.fiftyTwoWeekHigh)}` : '–'}</dd>
                <dt>Volume</dt><dd>{num(q?.volume, 0)}</dd>
                {v && <><dt>Market cap</dt><dd>{money(v.marketCap, { compact: true })}</dd>
                  <dt>Price / earnings</dt><dd>{num(v.priceToEarnings, 1)}</dd>
                  <dt>Price / sales</dt><dd>{num(v.priceToSales, 1)}</dd>
                  <dt>Price / book</dt><dd>{num(v.priceToBook, 1)}</dd>
                  <dt>Free cash flow yield</dt><dd>{share(v.freeCashFlowYield)}</dd></>}
              </dl>
            )}
            {v && <ChartNote>Multiples: {v.basis.toLowerCase()}, shares outstanding from the latest filing cover page.</ChartNote>}
          </Panel>
          <Panel title="Risk profile" meta={r ? `${r.observations} trading days` : undefined}>
            {!c ? <Skeleton rows={5} pad={false} /> : !r || r.annualisedVolatility === null ? <p className="muted">Not enough price history to measure risk.</p> : (
              <>
                <dl className="kv">
                  <dt>Annualised volatility</dt><dd>{share(r.annualisedVolatility)}</dd>
                  <dt>Maximum drawdown</dt><dd className="down">{share(r.maxDrawdown)}</dd>
                  <dt>One-day 95% value at risk</dt><dd>{share(r.valueAtRisk95)}</dd>
                  <dt>Beta against S&amp;P 500</dt><dd>{num(r.beta)}</dd>
                  <dt>Sharpe ratio (0% risk-free)</dt><dd>{num(r.sharpe)}</dd>
                </dl>
                <ChartNote>From daily closes, {r.from && day(r.from)} to {r.to && day(r.to)}. Historical measures describe the past, not a forecast.</ChartNote>
              </>
            )}
          </Panel>
        </div>
      </div>

      {c ? <Fundamentals c={c} /> : <Panel title="Financial statements"><Skeleton rows={8} pad={false} /></Panel>}

      <Panel title="Research notes" meta="your own analysis" actions={<button className="btn sm" onClick={() => setNoteModal({})}>{Icon.plus}New note</button>}>
        <Load q={notes} rows={3}>
          {(list) => list.length === 0 ? <Empty title="No notes on this instrument" action={<button className="btn sm" onClick={() => setNoteModal({})}>Write a note</button>}>Record your thesis, what would change your mind, and a target. The analyst can read these.</Empty> : (
            <div className="stack" style={{ gap: 18 }}>
              {list.map((n) => (
                <article key={n.id}>
                  <div className="row wrap">
                    <h3 className="headline">{n.title}</h3>
                    <span className={`chip ${n.stance === 'bullish' ? 'ok' : n.stance === 'bearish' ? 'bad' : ''}`}>{n.stance[0]!.toUpperCase() + n.stance.slice(1)}</span>
                    {n.targetPrice && <span className="chip outline">Target {price(n.targetPrice)}{q ? ` (${pct((n.targetPrice / q.price - 1) * 100, 0)} from last)` : ''}</span>}
                    <span className="faint small">Updated {ago(n.updatedAt)}</span>
                    <div className="grow" />
                    <button className="btn ghost icon" aria-label="Edit note" onClick={() => setNoteModal({ note: n })}>{Icon.edit}</button>
                    <ConfirmButton label="Delete note" onConfirm={() => delNote.mutate(n.id)} />
                  </div>
                  {n.body && <p className="assess" style={{ marginTop: 6, whiteSpace: 'pre-wrap', maxWidth: '72ch' }}>{n.body}</p>}
                </article>
              ))}
            </div>
          )}
        </Load>
      </Panel>
      {tx && <TransactionModal symbol={symbol} onClose={() => setTx(false)} />}
      {noteModal && <NoteModal symbol={symbol} note={noteModal.note} onClose={() => setNoteModal(null)} />}
    </div>
  );
}

// ---- portfolio --------------------------------------------------------------------
function PortfolioView() {
  const navigate = useNavigate();
  const [tx, setTx] = useState(false);
  const pf = usePortfolio();
  const txs = useTransactions();
  const hasPositions = (pf.data?.positions.length ?? 0) > 0;
  const riskQ = usePortfolioRisk(hasPositions);
  const del = useAct((id: number) => api.del(`/markets/transactions/${id}`), { invalidate: ['markets'], success: 'Transaction deleted' });

  return (
    <div className="grid">
      <Load q={pf} rows={6}>
        {(p) => !hasPositions && (txs.data?.length ?? 0) === 0 ? (
          <Panel><Empty title="Start your portfolio" action={<button className="btn primary" onClick={() => setTx(true)}>Record a transaction</button>}>Enter the trades you have made. Command Centre derives positions at average cost, values them at delayed market prices, and analyses the risk.</Empty></Panel>
        ) : (
          <>
            <Panel title="Summary" meta="US dollars" actions={<button className="btn sm primary" onClick={() => setTx(true)}>{Icon.plus}Record transaction</button>}>
              <div className="stats">
                <Stat large label="Market value" value={money(p.totals.marketValue)} />
                <Stat label="Today" value={money(p.totals.dayChange, { sign: true })} tone={tone(p.totals.dayChange)} />
                <Stat label="Unrealised gain" value={money(p.totals.unrealised, { sign: true })} sub={pct(p.totals.unrealisedPct, 1)} tone={tone(p.totals.unrealised)} />
                <Stat label="Realised gain" value={money(p.totals.realised, { sign: true })} tone={tone(p.totals.realised)} />
                <Stat label="Cost basis" value={money(p.totals.costBasis)} />
              </div>
              {p.totals.unpricedPositions > 0 && <p className="notice" style={{ marginTop: 14 }}><b>{p.totals.unpricedPositions} position{p.totals.unpricedPositions === 1 ? '' : 's'} could not be priced</b> and {p.totals.unpricedPositions === 1 ? 'is' : 'are'} left out of the totals.</p>}
            </Panel>
            <Panel title="Positions" flush foot={<><span className="chip outline">Delayed</span><span>Valued at the latest delayed quotes; non-USD holdings converted at the current FX quote. {p.costBasisNote}</span></>}>
              {p.positions.length === 0 ? <Empty title="No open positions">Every position has been sold. Realised gains are in the summary above.</Empty> : (
                <div className="table-wrap">
                  <table className="table">
                    <thead><tr><th>Holding</th><th className="num">Quantity</th><th className="num hide-sm">Avg cost</th><th className="num">Last</th><th className="num">Value</th><th className="num hide-sm">Weight</th><th className="num">Today</th><th className="num">Unrealised</th></tr></thead>
                    <tbody>
                      {p.positions.map((x) => (
                        <tr key={x.symbol} className="clickable" onClick={() => navigate(symPath(x.symbol))}>
                          <td><Link to={symPath(x.symbol)} className="sym" onClick={(e) => e.stopPropagation()}>{x.symbol}</Link>{x.stale && <span className="chip warn" style={{ marginLeft: 6 }}>Stale</span>}<div className="small faint truncate" style={{ maxWidth: 200 }}>{x.error ? <span className="down">{x.error}</span> : x.name}</div></td>
                          <td className="num">{num(x.quantity, x.quantity % 1 ? 4 : 0)}</td>
                          <td className="num hide-sm muted">{money(x.avgCost)}</td>
                          <td className="num">{price(x.price)}{x.currency && x.currency !== 'USD' && <span className="faint small"> {x.currency}</span>}</td>
                          <td className="num"><b>{money(x.marketValue)}</b></td>
                          <td className="num hide-sm muted">{share(x.weight)}</td>
                          <td className={`num ${tone(x.changePct)}`}>{pct(x.changePct)}</td>
                          <td className={`num ${tone(x.unrealised)}`}>{money(x.unrealised, { sign: true })}<div className="small">{pct(x.unrealisedPct, 1)}</div></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Panel>
          </>
        )}
      </Load>

      {hasPositions && (
        <Panel title="Risk analysis" meta="one year of daily returns, at current weights">
          {riskQ.isPending ? <Skeleton rows={8} pad={false} /> : riskQ.isError ? <ErrorBox what="Risk analysis failed" error={riskQ.error} retry={() => void riskQ.refetch()} /> : !riskQ.data.available ? <Empty title="Risk analysis is not available yet">{riskQ.data.reason}</Empty> : (() => {
            const r = riskQ.data;
            return (
              <div className="stack" style={{ gap: 20 }}>
                <div className="stats">
                  <Stat label="Annualised volatility" value={share(r.annualisedVolatility)} />
                  <Stat label="One-day 95% VaR" value={money(r.valueAtRisk95Usd)} sub={`${share(r.valueAtRisk95)} of value`} />
                  <Stat label="Maximum drawdown" value={share(r.maxDrawdown)} tone="down" />
                  <Stat label="Beta against S&P 500" value={num(r.beta)} />
                  <Stat label="Sharpe ratio" value={num(r.sharpe)} sub="0% risk-free rate" />
                  <Stat label="Effective holdings" value={num(r.effectiveHoldings, 1)} sub={`of ${r.holdings.length} held`} />
                </div>
                <div className="grid split">
                  <div>
                    <h3 className="headline" style={{ marginBottom: 8 }}>Growth of 100, against the S&amp;P 500</h3>
                    <LineChart ariaLabel="Portfolio indexed to 100 against the S&P 500" height={240} format={(v) => num(v, 0)} series={[
                      { name: 'Portfolio at current weights', color: 'var(--s1)', points: r.path.map((x) => ({ t: x.t, v: x.v })) },
                      ...(r.benchmarkPath ? [{ name: 'S&P 500', color: 'var(--ink-3)', dashed: true, points: r.benchmarkPath.map((x) => ({ t: x.t, v: x.v })) }] : []),
                    ]} />
                  </div>
                  <div className="stack" style={{ gap: 18 }}>
                    <div>
                      <h3 className="headline" style={{ marginBottom: 8 }}>Share of portfolio risk, by holding</h3>
                      <HBars data={r.holdings.map((h) => ({ label: `${h.symbol} (${share(h.weight, 0)} of value)`, value: h.riskContribution ?? 0, display: share(h.riskContribution, 0) }))} />
                    </div>
                    <div>
                      <h3 className="headline" style={{ marginBottom: 8 }}>Correlation of daily returns</h3>
                      <CorrelationMatrix symbols={r.correlation.symbols} matrix={r.correlation.matrix} />
                    </div>
                  </div>
                </div>
                <p className="small faint">
                  Method: {r.observations} overlapping trading days from {day(r.from)} to {day(r.to)}, with today's weights held constant, so it describes the portfolio you hold now rather than your actual trading history. Value at risk is the historical 5th-percentile daily loss.
                  A holding's risk share above its value share means it adds more volatility than its size suggests.{r.missing.length ? ` No price history for ${r.missing.join(', ')}; excluded.` : ''} Past behaviour does not predict future returns.
                </p>
              </div>
            );
          })()}
        </Panel>
      )}

      {(txs.data?.length ?? 0) > 0 && (
        <Panel title="Transactions" flush>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Date</th><th>Ticker</th><th>Side</th><th className="num">Quantity</th><th className="num">Price</th><th className="num hide-sm">Fees</th><th className="hide-sm">Note</th><th /></tr></thead>
              <tbody>
                {txs.data!.map((t) => (
                  <tr key={t.id}>
                    <td className="nowrap">{day(t.tradedOn)}</td><td className="sym">{t.symbol}</td>
                    <td><span className={`chip ${t.side === 'buy' ? 'ok' : 'bad'}`}>{t.side === 'buy' ? 'Buy' : 'Sell'}</span></td>
                    <td className="num">{num(t.quantity, t.quantity % 1 ? 4 : 0)}</td><td className="num">{money(t.price)}</td><td className="num hide-sm muted">{money(t.fee)}</td>
                    <td className="hide-sm muted truncate" style={{ maxWidth: 220 }}>{t.note}</td>
                    <td className="num"><ConfirmButton label="Delete transaction" onConfirm={() => del.mutate(t.id)} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}
      {tx && <TransactionModal onClose={() => setTx(false)} />}
    </div>
  );
}

function Research() {
  const notes = useNotes();
  return (
    <Panel title="Research notes" meta="across all instruments" flush>
      <Load q={notes} rows={5}>
        {(list) => list.length === 0 ? <Empty title="No research notes yet">Open any instrument and write a note to record your thesis. Notes are stored locally and are available to the analyst.</Empty> : (
          <table className="table">
            <thead><tr><th>Ticker</th><th>Note</th><th>Stance</th><th className="num hide-sm">Target</th><th className="num hide-sm">Updated</th></tr></thead>
            <tbody>
              {list.map((n) => (
                <tr key={n.id}>
                  <td><Link className="sym" to={symPath(n.symbol)}>{n.symbol}</Link></td>
                  <td><b>{n.title}</b><div className="muted truncate" style={{ maxWidth: 520 }}>{n.body}</div></td>
                  <td><span className={`chip ${n.stance === 'bullish' ? 'ok' : n.stance === 'bearish' ? 'bad' : ''}`}>{n.stance}</span></td>
                  <td className="num hide-sm">{price(n.targetPrice)}</td>
                  <td className="num hide-sm muted">{ago(n.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Load>
    </Panel>
  );
}

const TABS = [{ id: 'overview', label: 'Overview' }, { id: 'portfolio', label: 'Portfolio' }, { id: 'research', label: 'Research notes' }];

export default function Markets() {
  const { symbol } = useParams();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const tab = symbol ? '' : TABS.some((t) => t.id === params.get('tab')) ? params.get('tab')! : 'overview';
  return (
    <div className="reveal">
      <div className="row" style={{ alignItems: 'flex-start', gap: 12, position: 'relative', zIndex: 6 }}>
        <div className="tabs grow" role="tablist">
          {TABS.map((t) => <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => navigate(t.id === 'overview' ? '/markets' : `/markets?tab=${t.id}`)}>{t.label}</button>)}
        </div>
        <SymbolSearch onPick={(s) => navigate(symPath(s))} />
      </div>
      {symbol ? <Instrument key={symbol} symbol={decodeURIComponent(symbol).toUpperCase()} /> : tab === 'portfolio' ? <PortfolioView /> : tab === 'research' ? <Research /> : <Overview />}
    </div>
  );
}
