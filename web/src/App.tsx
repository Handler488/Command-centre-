import { Component, lazy, type ReactNode, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Link, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { ago } from './lib/format.ts';
import { useNewsMeta, useStatus, useSymbolSearch } from './lib/queries.ts';
import { Empty, ErrorBox, Icon, Modal, Skeleton } from './ui/kit.tsx';

const Situation = lazy(() => import('./pages/Situation.tsx'));
const Intelligence = lazy(() => import('./pages/Intelligence.tsx'));
const Markets = lazy(() => import('./pages/Markets.tsx'));
const Personal = lazy(() => import('./pages/Personal.tsx'));
const Analyst = lazy(() => import('./pages/Analyst.tsx'));

const DESKS = [
  { to: '/', label: 'Situation', icon: Icon.situation, end: true },
  { to: '/intel', label: 'Intelligence', icon: Icon.intel },
  { to: '/markets', label: 'Markets', icon: Icon.markets },
  { to: '/personal', label: 'Personal', icon: Icon.personal },
  { to: '/analyst', label: 'Analyst', icon: Icon.analyst },
];

function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  const utc = now.toISOString().slice(11, 19);
  const local = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const date = now.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  return (
    <div className="clock" aria-label="Current time">
      <span className="local">{date}, <b>{local}</b> local</span>
      <span><b>{utc}</b> UTC</span>
    </div>
  );
}

function SystemStatus() {
  const { data, isError } = useStatus();
  if (isError) return <div className="rail-foot"><div className="feed-row"><span className="dot bad" /><span>Server unreachable</span></div></div>;
  if (!data) return <div className="rail-foot"><Skeleton rows={3} pad={false} /></div>;
  const n = data.news;
  const newsState = n.sourcesEnabled === 0 ? 'off' : n.sourcesFailing === n.sourcesEnabled ? 'bad' : n.sourcesFailing > 0 ? 'warn' : n.lastIngestAt ? 'ok' : 'off';
  return (
    <div className="rail-foot" aria-label="System status">
      <Link to="/intel?tab=sources" className="feed-row" style={{ color: 'inherit' }} title={`${n.sourcesEnabled - n.sourcesFailing} of ${n.sourcesEnabled} feeds healthy`}>
        <span className={`dot ${newsState}`} /><span>News feeds</span><span>{n.lastIngestAt ? ago(n.lastIngestAt) : 'no data'}</span>
      </Link>
      <div className="feed-row" title="Prices come from public delayed feeds, never real-time">
        <span className="dot ok" /><span>Market data</span><span>delayed</span>
      </div>
      <Link to="/analyst" className="feed-row" style={{ color: 'inherit' }} title={data.analyst.model ?? 'Set ANTHROPIC_API_KEY to enable'}>
        <span className={`dot ${data.analyst.configured ? 'ok' : 'off'}`} /><span>AI analyst</span><span>{data.analyst.configured ? 'ready' : 'no key'}</span>
      </Link>
    </div>
  );
}

interface PaletteItem { group: string; label: string; hint?: string; to: string }

function CommandPalette({ onClose }: { onClose: () => void }) {
  const [term, setTerm] = useState('');
  const [debounced, setDebounced] = useState('');
  const [active, setActive] = useState(0);
  const navigate = useNavigate();
  const meta = useNewsMeta();
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(term.trim()), 220);
    return () => clearTimeout(t);
  }, [term]);
  const symbols = useSymbolSearch(debounced);

  const items = useMemo<PaletteItem[]>(() => {
    const t = term.trim().toLowerCase();
    const out: PaletteItem[] = DESKS.filter((d) => !t || d.label.toLowerCase().includes(t)).map((d) => ({ group: 'Desks', label: d.label, to: d.to }));
    const extra: PaletteItem[] = [
      { group: 'Desks', label: 'Portfolio', hint: 'Markets', to: '/markets?tab=portfolio' },
      { group: 'Desks', label: 'News sources', hint: 'Intelligence', to: '/intel?tab=sources' },
      { group: 'Desks', label: 'Compare coverage', hint: 'Intelligence', to: '/intel?tab=compare' },
      { group: 'Desks', label: 'Reports', hint: 'Analyst', to: '/analyst?tab=reports' },
      { group: 'Desks', label: 'Training log', hint: 'Personal', to: '/personal?tab=training' },
    ];
    if (t) out.push(...extra.filter((e) => e.label.toLowerCase().includes(t)));
    if (t.length >= 2) {
      out.push(...(meta.data?.countries ?? []).filter((c) => c.name.toLowerCase().includes(t) || c.iso3.toLowerCase() === t).slice(0, 5).map((c) => ({ group: 'Countries', label: c.name, hint: 'Intelligence', to: `/intel?country=${c.iso3}` })));
    }
    if (debounced && debounced.toLowerCase() === t) {
      out.push(...(symbols.data ?? []).slice(0, 6).map((s) => ({ group: 'Instruments', label: `${s.symbol}  ${s.name}`, hint: [s.type, s.exchange].filter(Boolean).join(', '), to: `/markets/${encodeURIComponent(s.symbol)}` })));
    }
    return out;
  }, [term, debounced, meta.data, symbols.data]);

  useEffect(() => setActive(0), [term]);
  useEffect(() => {
    // Braces matter: scrollIntoView returns a Promise in current browsers, and an effect must not return one.
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active]);
  const go = (item?: PaletteItem) => {
    if (!item) return;
    navigate(item.to);
    onClose();
  };
  let lastGroup = '';
  return (
    <Modal title="Go to" onClose={onClose}>
      <div className="palette">
        <input
          autoFocus
          placeholder="Search desks, countries, tickers…"
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          aria-label="Search"
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(items.length - 1, a + 1)); }
            if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
            if (e.key === 'Enter') go(items[active]);
          }}
        />
        <div className="palette-list" ref={listRef} role="listbox">
          {items.map((item, i) => {
            const head = item.group !== lastGroup ? <div className="palette-group">{item.group}</div> : null;
            lastGroup = item.group;
            return (
              <div key={`${item.group}-${item.label}`}>
                {head}
                <button className="palette-item" role="option" aria-selected={i === active} onMouseEnter={() => setActive(i)} onClick={() => go(item)}>
                  <span className="truncate">{item.label}</span>
                  {item.hint && <span className="faint nowrap">{item.hint}</span>}
                </button>
              </div>
            );
          })}
          {items.length === 0 && <div className="empty" style={{ padding: 22 }}>{symbols.isFetching ? 'Searching…' : symbols.isError ? 'Ticker search is unavailable right now.' : `Nothing matches “${term}”.`}</div>}
        </div>
      </div>
    </Modal>
  );
}

/** Contains a rendering failure to the current desk so navigation keeps working. */
class DeskBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error) {
    console.error('[desk]', error);
  }
  render() {
    if (!this.state.error) return this.props.children;
    return <ErrorBox what="This desk hit an unexpected error" error={this.state.error} retry={() => this.setState({ error: null })} />;
  }
}

function NotFound() {
  return <Empty title="There is nothing at this address" action={<Link className="btn" to="/">Go to Situation</Link>}>The page may have moved, or the link is mistyped.</Empty>;
}

export function App() {
  const location = useLocation();
  const navigate = useNavigate();
  const [palette, setPalette] = useState(false);
  const desk = DESKS.find((d) => (d.end ? location.pathname === d.to : location.pathname.startsWith(d.to)));

  useEffect(() => {
    document.title = desk ? `${desk.label} · Command Centre` : 'Command Centre';
  }, [desk]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const typing = target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette(true);
      } else if (!typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (e.key === '/') { e.preventDefault(); setPalette(true); }
        const idx = Number(e.key) - 1;
        if (Number.isInteger(idx) && DESKS[idx] && !document.querySelector('[role="dialog"]')) navigate(DESKS[idx].to);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate]);

  return (
    <div className="shell">
      <aside className="rail">
        <Link to="/" className="wordmark" aria-label="Command Centre home">
          <svg className="reticle" viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="16" cy="16" r="9" /><path d="M16 2v9M16 21v9M2 16h9M21 16h9" /></svg>
          <span>COMMAND<br />CENTRE</span>
        </Link>
        <nav className="nav" aria-label="Desks">
          {DESKS.map((d, i) => (
            <NavLink key={d.to} to={d.to} end={d.end}>
              {d.icon}{d.label}<kbd>{i + 1}</kbd>
            </NavLink>
          ))}
        </nav>
        <SystemStatus />
      </aside>
      <div className="main">
        <header className="topbar">
          <h1>{desk?.label ?? 'Command Centre'}</h1>
          <div className="spacer" />
          <Clock />
          <button className="palette-btn" onClick={() => setPalette(true)} aria-label="Open search">
            {Icon.search}<span>Search or jump to…</span><kbd>/</kbd>
          </button>
        </header>
        <main className="content" key={location.pathname.split('/')[1]}>
          <DeskBoundary>
          <Suspense fallback={<Skeleton rows={6} />}>
            <Routes>
              <Route path="/" element={<Situation />} />
              <Route path="/intel" element={<Intelligence />} />
              <Route path="/markets" element={<Markets />} />
              <Route path="/markets/:symbol" element={<Markets />} />
              <Route path="/personal" element={<Personal />} />
              <Route path="/analyst" element={<Analyst />} />
              <Route path="*" element={<NotFound />} />
            </Routes>
          </Suspense>
          </DeskBoundary>
        </main>
      </div>
      <nav className="tabbar" aria-label="Desks">
        {DESKS.map((d) => (
          <NavLink key={d.to} to={d.to} end={d.end}>{d.icon}{d.label}</NavLink>
        ))}
      </nav>
      {palette && <CommandPalette onClose={() => setPalette(false)} />}
    </div>
  );
}
