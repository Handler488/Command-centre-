import { Link, useNavigate } from 'react-router-dom';
import { BarChart, ScoreRing } from '../charts/charts.tsx';
import { WorldMap } from '../charts/WorldMap.tsx';
import { api } from '../lib/api.ts';
import { ago, dayShort, dueLabel, money, num, pct, price, tone } from '../lib/format.ts';
import { useAct, useBoard, useMap, usePersonal, usePortfolio, useStatus, useStories } from '../lib/queries.ts';
import { Empty, Icon, Load, Panel, Stat } from '../ui/kit.tsx';

export function VerifyChip({ v, n }: { v: 'corroborated' | 'single-source'; n: number }) {
  return v === 'corroborated' ? <span className="chip ok" title="Reported independently by more than one outlet">{n} outlets</span> : <span className="chip outline" title="Only one outlet has reported this; treat as unverified">Single source</span>;
}

export function RefreshFeeds({ label = 'Refresh feeds' }: { label?: string }) {
  const refresh = useAct(() => api.post<{ inserted: number; failed: number; results: unknown[] }>('/news/refresh'), {
    invalidate: ['news', 'status'],
    success: (r) => `Feeds refreshed: ${r.inserted} new article${r.inserted === 1 ? '' : 's'}${r.failed ? `, ${r.failed} source${r.failed === 1 ? '' : 's'} failed` : ''}`,
  });
  return (
    <button className="btn sm" onClick={() => refresh.mutate(undefined)} disabled={refresh.isPending}>
      {refresh.isPending ? <span className="spin" /> : Icon.refresh}{refresh.isPending ? 'Refreshing…' : label}
    </button>
  );
}

function MarketStrip() {
  const board = useBoard();
  if (board.isPending) return <div className="strip" style={{ padding: 14 }}><div className="skel" style={{ width: '100%' }} /></div>;
  const rows = (board.data ?? []).filter((b) => b.quote);
  if (board.isError || rows.length === 0) {
    return <div className="notice">Market data is unavailable right now. <button className="btn sm ghost" onClick={() => void board.refetch()}>Try again</button></div>;
  }
  return (
    <nav className="strip" aria-label="Market board, delayed prices">
      {rows.map((b) => (
        <Link key={b.symbol} to={`/markets/${encodeURIComponent(b.symbol)}`}>
          <span className="l">{b.label}</span>
          <span className="v">{price(b.quote!.price)}</span>
          <span className={`c ${tone(b.quote!.changePct)}`}>{pct(b.quote!.changePct)}</span>
        </Link>
      ))}
    </nav>
  );
}

export default function Situation() {
  const navigate = useNavigate();
  const stories = useStories({ hours: 48, limit: 6 });
  const map = useMap(48);
  const portfolio = usePortfolio();
  const personal = usePersonal();
  const status = useStatus();
  const archiveEmpty = status.data?.news.articleCount === 0;

  return (
    <div className="grid reveal">
      <MarketStrip />
      <div className="grid split">
        <Panel title="World coverage" meta="last 48 hours" flush actions={<Link className="btn sm ghost" to="/intel">Open Intelligence</Link>}>
          <Load q={map} rows={8}>
            {(data) => <WorldMap data={data} compact onSelect={(iso) => iso && navigate(`/intel?country=${iso}`)} />}
          </Load>
        </Panel>
        <Panel title="Significant developments" meta={status.data?.news.lastIngestAt ? `feeds updated ${ago(status.data.news.lastIngestAt)}` : undefined} flush actions={<RefreshFeeds label="Refresh" />}>
          <Load q={stories} rows={7}>
            {(list) =>
              list.length === 0 ? (
                <Empty title={archiveEmpty ? 'No news has been ingested yet' : 'Nothing in the last 48 hours'}>
                  {archiveEmpty ? 'Refresh the feeds to pull the latest headlines from the configured sources.' : 'The feeds have not carried anything new. Check source health on the Intelligence desk.'}
                </Empty>
              ) : (
                list.map((s) => (
                  <button key={s.id} className="story" onClick={() => navigate(`/intel?story=${s.id}`)}>
                    <ScoreRing score={s.significance.score} />
                    <div>
                      <div className="headline">{s.headline}</div>
                      <div className="story-meta"><VerifyChip v={s.verification} n={s.sourceCount} /><span>{ago(s.latestAt)}</span></div>
                    </div>
                  </button>
                ))
              )
            }
          </Load>
        </Panel>
      </div>

      <div className="grid cols-3">
        <Panel title="Portfolio" actions={<Link className="btn sm ghost" to="/markets?tab=portfolio">Open</Link>}>
          <Load q={portfolio} rows={4}>
            {(pf) =>
              pf.positions.length === 0 ? (
                <Empty title="No holdings recorded" action={<Link className="btn sm" to="/markets?tab=portfolio">Add a transaction</Link>}>Record your buys and sells to track value, P&amp;L and risk.</Empty>
              ) : (
                <div className="stack" style={{ gap: 14 }}>
                  <div className="row between" style={{ alignItems: 'flex-end' }}>
                    <Stat label="Market value (USD)" value={money(pf.totals.marketValue)} large />
                    <Stat label="Today" value={money(pf.totals.dayChange, { sign: true })} tone={tone(pf.totals.dayChange)} />
                    <Stat label="Unrealised" value={pct(pf.totals.unrealisedPct, 1)} tone={tone(pf.totals.unrealised)} />
                  </div>
                  <table className="table" style={{ margin: '0 -14px', width: 'calc(100% + 28px)' }}>
                    <tbody>
                      {pf.positions.slice(0, 5).map((p) => (
                        <tr key={p.symbol} className="clickable" onClick={() => navigate(`/markets/${encodeURIComponent(p.symbol)}`)}>
                          <td><span className="sym">{p.symbol}</span></td>
                          <td className="num muted">{p.weight === null ? '–' : `${num(p.weight * 100, 1)}%`}</td>
                          <td className="num">{money(p.marketValue, { compact: true })}</td>
                          <td className={`num ${tone(p.changePct)}`}>{pct(p.changePct)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )
            }
          </Load>
        </Panel>

        <Panel title="Agenda" flush actions={<Link className="btn sm ghost" to="/personal">Open</Link>}>
          <Load q={personal} rows={5}>
            {(p) =>
              p.upcoming.length === 0 && p.tasks.open === 0 ? (
                <Empty title="Nothing scheduled" action={<Link className="btn sm" to="/personal">Add a task</Link>}>Tasks, deadlines and objective due dates appear here.</Empty>
              ) : (
                <>
                  <div className="row" style={{ padding: '12px 14px', gap: 22, borderBottom: '1px solid var(--line-soft)' }}>
                    <Stat label="Open tasks" value={p.tasks.open} />
                    <Stat label="Due today" value={p.tasks.dueToday} tone={p.tasks.dueToday ? 'amber' : ''} />
                    <Stat label="Overdue" value={p.tasks.overdue} tone={p.tasks.overdue ? 'down' : ''} />
                  </div>
                  {p.upcoming.slice(0, 5).map((u) => (
                    <div className="agenda-item" key={`${u.type}-${u.id}`}>
                      <span className="agenda-date">{dayShort(u.dueOn)}</span>
                      <span className="truncate">{u.title}</span>
                      <span className={`chip ${u.daysLeft < 0 ? 'bad' : u.daysLeft <= 1 ? 'amber' : ''}`}>{dueLabel(u.daysLeft)}</span>
                    </div>
                  ))}
                  {p.upcoming.length === 0 && <p className="muted" style={{ padding: 14 }}>No dated items in the next 60 days.</p>}
                </>
              )
            }
          </Load>
        </Panel>

        <Panel title="Training" actions={<Link className="btn sm ghost" to="/personal?tab=training">Open</Link>}>
          <Load q={personal} rows={5}>
            {(p) =>
              p.fitness.totalRuns === 0 ? (
                <Empty title="No runs logged" action={<Link className="btn sm" to="/personal?tab=training">Log a run</Link>}>Add runs by hand or import GPX files to see weekly volume and pace.</Empty>
              ) : (
                <div className="stack">
                  <div className="row" style={{ gap: 22 }}>
                    <Stat label="This week" value={`${num(p.fitness.thisWeekKm, 1)} km`} />
                    <Stat label="4-week average" value={`${num(p.fitness.fourWeekAvgKm, 1)} km`} />
                  </div>
                  <BarChart ariaLabel="Weekly running distance, last 8 weeks" height={130} highlightLast format={(v) => num(v, 0)} data={p.fitness.weekly.slice(-8).map((w) => ({ key: w.weekStart, label: dayShort(w.weekStart), value: w.distanceKm, note: `Week of ${dayShort(w.weekStart)}: ${w.runs} run${w.runs === 1 ? '' : 's'}` }))} />
                </div>
              )
            }
          </Load>
        </Panel>
      </div>
    </div>
  );
}
