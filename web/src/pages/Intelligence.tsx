import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { HBars, LineChart, ScoreRing, ChartNote } from '../charts/charts.tsx';
import { WorldMap } from '../charts/WorldMap.tsx';
import { api, type ArticleDto, type NewsMeta, type RefreshResult, type StoryDto } from '../lib/api.ts';
import { ago, dateTime, day, num, signed } from '../lib/format.ts';
import { useAct, useArticles, useGdelt, useMap, useNewsMeta, useSources, useStories, useStory, useTrend } from '../lib/queries.ts';
import { ConfirmButton, Drawer, Empty, ErrorBox, Field, Icon, Load, Panel, Seg, Skeleton, Stat } from '../ui/kit.tsx';
import { RefreshFeeds, VerifyChip } from './Situation.tsx';

const WINDOWS = [{ value: '24', label: '24h' }, { value: '48', label: '48h' }, { value: '168', label: '7d' }] as const;
const KIND_LABEL: Record<string, string> = { report: 'Reporting', live: 'Live coverage', analysis: 'Analysis', opinion: 'Opinion' };

function useParam(key: string): [string | null, (v: string | null) => void] {
  const [params, setParams] = useSearchParams();
  return [
    params.get(key),
    (v) => {
      const next = new URLSearchParams(params);
      if (v === null || v === '') next.delete(key);
      else next.set(key, v);
      setParams(next, { replace: true });
    },
  ];
}

function Filters({ meta, country, topic, onCountry, onTopic }: { meta?: NewsMeta; country: string | null; topic: string | null; onCountry: (v: string | null) => void; onTopic: (v: string | null) => void }) {
  return (
    <>
      <select className="select" style={{ width: 190 }} value={country ?? ''} onChange={(e) => onCountry(e.target.value || null)} aria-label="Filter by country">
        <option value="">All countries</option>
        {[...(meta?.countries ?? [])].sort((a, b) => a.name.localeCompare(b.name)).map((c) => <option key={c.iso3} value={c.iso3}>{c.name}</option>)}
      </select>
      <select className="select" style={{ width: 200 }} value={topic ?? ''} onChange={(e) => onTopic(e.target.value || null)} aria-label="Filter by subject">
        <option value="">All subjects</option>
        {(meta?.topics ?? []).map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
      </select>
    </>
  );
}

function ArticleLine({ a }: { a: ArticleDto }) {
  return (
    <div className="source-line">
      <div>
        <a className="headline" style={{ fontSize: 14 }} href={a.url} target="_blank" rel="noreferrer">{a.title}</a>
        {a.summary && <p className="muted" style={{ marginTop: 3 }}>{a.summary}</p>}
      </div>
      <div className="right small nowrap">
        <b>{a.sourceName}</b>
        <div className="faint">{dateTime(a.publishedAt)}</div>
      </div>
    </div>
  );
}

function StoryDrawer({ id, meta, onClose }: { id: number; meta?: NewsMeta; onClose: () => void }) {
  const story = useStory(id);
  const s = story.data;
  const lead = s?.countries[0];
  const earlier = useArticles({ country: lead, topic: s?.topics[0], before: s?.firstSeenAt, limit: 5 }, Boolean(s && lead));
  const countryName = (iso: string) => meta?.countries.find((c) => c.iso3 === iso)?.name ?? iso;
  const topicName = (t: string) => meta?.topics.find((x) => x.id === t)?.label ?? t;
  return (
    <Drawer title="Development" onClose={onClose}>
      {story.isPending && <Skeleton rows={8} pad={false} />}
      {story.isError && <ErrorBox error={story.error} retry={() => void story.refetch()} />}
      {s && (() => {
        const reporting = s.articles.filter((a) => a.kind === 'report' || a.kind === 'live');
        const commentary = s.articles.filter((a) => a.kind === 'analysis' || a.kind === 'opinion');
        const spanH = Math.max(1, Math.round((Date.parse(s.latestAt) - Date.parse(s.firstSeenAt)) / 3_600_000));
        return (
          <div className="stack" style={{ gap: 22 }}>
            <div className="row" style={{ alignItems: 'flex-start', gap: 14 }}>
              <ScoreRing score={s.significance.score} size={52} />
              <div>
                <h3 className="headline lg">{s.headline}</h3>
                <div className="story-meta">
                  <VerifyChip v={s.verification} n={s.sourceCount} />
                  {s.countries.slice(0, 4).map((c) => <span className="chip" key={c}>{countryName(c)}</span>)}
                  {s.topics.slice(0, 3).map((t) => <span className="chip outline" key={t}>{topicName(t)}</span>)}
                </div>
              </div>
            </div>

            <section>
              <h4 className="headline" style={{ marginBottom: 2 }}>What the sources report</h4>
              <p className="small faint">Headlines and summaries exactly as published. Follow the links for the full reports.</p>
              {reporting.length ? reporting.map((a) => <ArticleLine key={a.id} a={a} />) : <p className="muted" style={{ paddingTop: 10 }}>No straight news reports are attached to this development, only commentary.</p>}
            </section>

            {commentary.length > 0 && (
              <section>
                <h4 className="headline" style={{ marginBottom: 2 }}>Analysis and opinion</h4>
                <p className="small faint">Labelled as commentary by the publisher. These are interpretations, not confirmed facts.</p>
                {commentary.map((a) => <ArticleLine key={a.id} a={a} />)}
              </section>
            )}

            <section className="stack">
              <div>
                <h4 className="headline">Platform assessment</h4>
                <p className="small faint">Computed by Command Centre from the headlines above. A machine reading, not a verified finding.</p>
              </div>
              <p className="assess">
                {s.verification === 'corroborated'
                  ? `${s.sourceCount} independent outlets carried this within ${spanH} hour${spanH === 1 ? '' : 's'} of each other, which makes the core event unlikely to be a single outlet's error. Details may still differ between reports.`
                  : 'Only one outlet in the archive has reported this. It may be accurate, but nothing here confirms it; look for a second source before relying on it.'}
                {' '}It was first seen {ago(s.firstSeenAt)} and last updated {ago(s.latestAt)}.
              </p>
              <HBars maxValue={40} data={[
                { label: 'Corroboration', value: s.significance.corroboration, display: `${num(s.significance.corroboration, 0)} / 40` },
                { label: 'Severity of terms', value: s.significance.severity, display: `${num(s.significance.severity, 0)} / 30` },
                { label: 'Recency', value: s.significance.recency, display: `${num(s.significance.recency, 0)} / 20` },
                { label: 'Coverage volume', value: s.significance.volume, display: `${num(s.significance.volume, 0)} / 10` },
              ]} />
              <p className="small faint">Significance {s.significance.score} of 100 is the sum of these four parts.</p>
            </section>

            {lead && (
              <section>
                <h4 className="headline" style={{ marginBottom: 2 }}>Earlier coverage</h4>
                <p className="small faint">{countryName(lead)}{s.topics[0] ? `, ${topicName(s.topics[0]).toLowerCase()}` : ''}, before this development.</p>
                {earlier.isPending ? <Skeleton rows={3} pad={false} /> : earlier.data?.items.length ? earlier.data.items.map((a) => <ArticleLine key={a.id} a={a} />) : (
                  <p className="muted" style={{ paddingTop: 10 }}>Nothing earlier in the archive{meta?.archiveStart ? `, which begins ${day(meta.archiveStart)}` : ''}.</p>
                )}
              </section>
            )}

            <div className="row wrap">
              <Link className="btn primary" to={`/analyst?q=${encodeURIComponent(`Brief me on this development and what it means: "${s.headline}"`)}`}>Ask the analyst</Link>
              {lead && <Link className="btn" to={`/intel?tab=compare&a=${lead}`} onClick={onClose}>Coverage history for {countryName(lead)}</Link>}
            </div>
          </div>
        );
      })()}
    </Drawer>
  );
}

function Developments({ meta }: { meta?: NewsMeta }) {
  const [country, setCountry] = useParam('country');
  const [topic, setTopic] = useParam('topic');
  const [storyId, setStoryId] = useParam('story');
  const [, setParams] = useSearchParams();
  const [hours, setHours] = useState<(typeof WINDOWS)[number]['value']>('48');
  const stories = useStories({ hours: Number(hours), country, topic, limit: 40 });
  const map = useMap(Number(hours));
  const trend = useTrend({ country, topic, days: 14 }, Boolean(country || topic));
  const countryName = meta?.countries.find((c) => c.iso3 === country)?.name;
  const topicName = meta?.topics.find((t) => t.id === topic)?.label;
  const scope = [countryName, topicName].filter(Boolean).join(', ');

  return (
    <>
      <div className="row wrap" style={{ marginBottom: 14 }}>
        <Seg label="Time window" value={hours} options={WINDOWS} onChange={setHours} />
        <Filters meta={meta} country={country} topic={topic} onCountry={setCountry} onTopic={setTopic} />
        {(country || topic) && <button className="btn ghost sm" onClick={() => setParams({}, { replace: true })}>Clear filters</button>}
        <div className="grow" />
        <RefreshFeeds />
      </div>
      <div className="grid split">
        <div className="stack" style={{ gap: 14 }}>
          <Panel title="Coverage map" meta="select a country to filter" flush>
            <Load q={map} rows={9}>{(data) => <WorldMap data={data} selected={country} onSelect={setCountry} />}</Load>
          </Panel>
          {(country || topic) && (
            <Panel title={`Coverage volume: ${scope}`} meta="articles per day, last 14 days">
              <Load q={trend} rows={5}>
                {(t) => (
                  <>
                    <LineChart ariaLabel={`Daily article count for ${scope}`} height={170} zeroBased format={(v) => num(v, 0)} series={[{ name: 'Articles per day', color: 'var(--s1)', points: t.current.map((d) => ({ t: d.date, v: d.count })), area: true }]} />
                    <ChartNote>
                      {t.currentTotal} articles in this period{t.previousPeriodCovered ? `, against ${t.previousTotal} in the 14 days before (${signed(t.currentTotal - t.previousTotal, 0)}).` : '. The archive does not yet reach back far enough for a period-on-period comparison.'}
                      {' '}<Link to={`/intel?tab=compare${country ? `&a=${country}` : ''}`}>Compare in detail</Link>
                    </ChartNote>
                  </>
                )}
              </Load>
            </Panel>
          )}
        </div>
        <Panel title="Developments" meta={stories.data ? `${stories.data.length} ranked by significance` : undefined} flush>
          <Load q={stories} rows={10}>
            {(list) =>
              list.length === 0 ? (
                <Empty title={meta?.articleCount === 0 ? 'The archive is empty' : 'No developments match'} action={meta?.articleCount === 0 ? <RefreshFeeds /> : undefined}>
                  {meta?.articleCount === 0 ? 'Refresh the feeds to ingest headlines from the configured sources.' : 'Widen the time window or clear the filters.'}
                </Empty>
              ) : (
                list.map((s) => <StoryRow key={s.id} s={s} current={String(s.id) === storyId} onOpen={() => setStoryId(String(s.id))} />)
              )
            }
          </Load>
        </Panel>
      </div>
      {storyId && /^\d+$/.test(storyId) && <StoryDrawer id={Number(storyId)} meta={meta} onClose={() => setStoryId(null)} />}
    </>
  );
}

function StoryRow({ s, current, onOpen }: { s: StoryDto; current: boolean; onOpen: () => void }) {
  return (
    <button className="story" aria-current={current} onClick={onOpen}>
      <ScoreRing score={s.significance.score} />
      <div>
        <div className="headline">{s.headline}</div>
        {s.summary && <p className="muted" style={{ marginTop: 3, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{s.summary}</p>}
        <div className="story-meta">
          <VerifyChip v={s.verification} n={s.sourceCount} />
          <span>{[...new Set(s.articles.map((a) => a.sourceName))].slice(0, 3).join(', ')}</span>
          <span>{ago(s.latestAt)}</span>
        </div>
      </div>
    </button>
  );
}

function Wire({ meta }: { meta?: NewsMeta }) {
  const [kind, setKind] = useState<'all' | 'reporting' | 'commentary'>('all');
  const [country, setCountry] = useState<string | null>(null);
  const [topic, setTopic] = useState<string | null>(null);
  const [term, setTerm] = useState('');
  const [q, setQ] = useState('');
  const [limit, setLimit] = useState(40);
  useEffect(() => {
    const t = setTimeout(() => setQ(term.trim()), 300);
    return () => clearTimeout(t);
  }, [term]);
  useEffect(() => setLimit(40), [kind, country, topic, q]);
  const articles = useArticles({ kind: kind === 'all' ? undefined : kind, country, topic, q, limit });
  return (
    <>
      <div className="row wrap" style={{ marginBottom: 14 }}>
        <Seg label="Type of coverage" value={kind} onChange={setKind} options={[{ value: 'all', label: 'All' }, { value: 'reporting', label: 'Reporting' }, { value: 'commentary', label: 'Analysis & opinion' }]} />
        <input className="input" style={{ width: 240 }} placeholder="Search headlines and summaries" value={term} onChange={(e) => setTerm(e.target.value)} aria-label="Search the archive" />
        <Filters meta={meta} country={country} topic={topic} onCountry={setCountry} onTopic={setTopic} />
      </div>
      <Panel title="Wire" meta={articles.data ? `${articles.data.total} article${articles.data.total === 1 ? '' : 's'}, newest first` : undefined} flush
        foot={<span>Reporting and commentary are separated using each publisher's own section and headline labels.</span>}>
        <Load q={articles} rows={10}>
          {(data) =>
            data.items.length === 0 ? (
              <Empty title="No articles match">{meta?.articleCount === 0 ? 'The archive is empty. Refresh the feeds first.' : 'Try fewer search words or clear the filters.'}</Empty>
            ) : (
              <>
                {data.items.map((a) => (
                  <article className="wire-item" key={a.id}>
                    <a className="headline" href={a.url} target="_blank" rel="noreferrer">{a.title}</a>
                    {a.summary && <p className="muted">{a.summary}</p>}
                    <div className="story-meta" style={{ marginTop: 2 }}>
                      <span className={`chip ${a.kind === 'report' || a.kind === 'live' ? '' : 'amber'}`}>{KIND_LABEL[a.kind] ?? a.kind}</span>
                      <b className="muted">{a.sourceName}</b>
                      <span>{dateTime(a.publishedAt)}</span>
                      {a.countries.slice(0, 3).map((c) => <button key={c} className="chip outline" onClick={() => setCountry(c)}>{meta?.countries.find((x) => x.iso3 === c)?.name ?? c}</button>)}
                    </div>
                  </article>
                ))}
                {data.total > data.items.length && (
                  <div style={{ padding: 12, textAlign: 'center' }}>
                    <button className="btn" onClick={() => setLimit((l) => Math.min(200, l + 40))} disabled={limit >= 200 || articles.isFetching}>
                      {limit >= 200 ? 'Showing the newest 200. Narrow the search to see older items.' : articles.isFetching ? 'Loading…' : 'Show more'}
                    </button>
                  </div>
                )}
              </>
            )
          }
        </Load>
      </Panel>
    </>
  );
}

function Compare({ meta }: { meta?: NewsMeta }) {
  const [a, setA] = useParam('a');
  const [b, setB] = useParam('b');
  const [topic, setTopic] = useState<string | null>(null);
  const [days, setDays] = useState<'7' | '14' | '30' | '90'>('14');
  const [span, setSpan] = useState<'3m' | '6m' | '12m'>('6m');
  const ta = useTrend({ country: a, topic, days: Number(days) }, Boolean(a));
  const tb = useTrend({ country: b, topic, days: Number(days) }, Boolean(b));
  const name = (iso: string | null) => meta?.countries.find((c) => c.iso3 === iso)?.name ?? null;
  const ga = useGdelt(name(a), span);
  const gb = useGdelt(name(b), span);
  const countries = useMemo(() => [...(meta?.countries ?? [])].sort((x, y) => x.name.localeCompare(y.name)), [meta]);
  const pick = (value: string | null, set: (v: string | null) => void, label: string) => (
    <select className="select" style={{ width: 190 }} value={value ?? ''} onChange={(e) => set(e.target.value || null)} aria-label={label}>
      <option value="">{label}</option>
      {countries.map((c) => <option key={c.iso3} value={c.iso3}>{c.name}</option>)}
    </select>
  );
  const sides = [{ iso: a, t: ta, color: 'var(--s1)' }, { iso: b, t: tb, color: 'var(--s2)' }].filter((s) => s.iso);
  const topicLabel = (id: string) => meta?.topics.find((t) => t.id === id)?.label ?? id;

  return (
    <>
      <div className="row wrap" style={{ marginBottom: 14 }}>
        {pick(a, setA, 'First country')}
        <span className="faint">against</span>
        {pick(b, setB, 'Second country (optional)')}
        <select className="select" style={{ width: 200 }} value={topic ?? ''} onChange={(e) => setTopic(e.target.value || null)} aria-label="Subject">
          <option value="">All subjects</option>
          {(meta?.topics ?? []).map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
        </select>
        <Seg label="Period" value={days} onChange={setDays} options={[{ value: '7', label: '7d' }, { value: '14', label: '14d' }, { value: '30', label: '30d' }, { value: '90', label: '90d' }]} />
      </div>
      {!a ? (
        <Panel><Empty title="Choose a country to compare">See how coverage of a country has changed against the preceding period, set it beside a second country, and check long-range attention from GDELT.</Empty></Panel>
      ) : (
        <div className="grid">
          <Panel title="Coverage in this archive" meta={`articles per day, last ${days} days`}
            foot={<span>Counts are articles ingested by this platform from your configured feeds. {meta?.archiveStart ? `The archive begins ${day(meta.archiveStart)}.` : 'The archive is empty.'}</span>}>
            {sides.some((s) => s.t.isPending) ? <Skeleton rows={6} pad={false} /> : sides.some((s) => s.t.isError) ? <ErrorBox error={sides.find((s) => s.t.isError)!.t.error} /> : (
              <LineChart ariaLabel="Daily article counts compared" zeroBased height={230} format={(v) => num(v, 0)} series={sides.map((s) => ({ name: name(s.iso)!, color: s.color, points: s.t.data!.current.map((d) => ({ t: d.date, v: d.count })) }))} />
            )}
          </Panel>
          <div className={`grid ${sides.length > 1 ? 'cols-2' : ''}`}>
            {sides.map((s) => (
              <Panel key={s.iso} title={name(s.iso)} meta={`this period against the previous ${days} days`}>
                <Load q={s.t} rows={5}>
                  {(t) => (
                    <div className="stack" style={{ gap: 16 }}>
                      <div className="stats">
                        <Stat label={`Last ${days} days`} value={t.currentTotal} sub="articles" />
                        <Stat label={`Previous ${days} days`} value={t.previousPeriodCovered ? t.previousTotal : '–'} sub={t.previousPeriodCovered ? 'articles' : 'before the archive began'} />
                        <Stat label="Change" value={t.previousPeriodCovered && t.previousTotal > 0 ? signed(((t.currentTotal - t.previousTotal) / t.previousTotal) * 100, 0, '%') : '–'} sub={t.previousPeriodCovered ? (t.previousTotal > 0 ? 'period on period' : 'no earlier coverage') : 'not comparable yet'} />
                      </div>
                      {t.topicMix.length ? (
                        <div>
                          <p className="small faint" style={{ marginBottom: 8 }}>Subjects covered (an article can have several)</p>
                          <HBars data={t.topicMix.slice(0, 6).map((m) => ({ label: topicLabel(m.topic), value: m.count, display: String(m.count), color: s.color }))} />
                        </div>
                      ) : <p className="muted">No articles in this period.</p>}
                    </div>
                  )}
                </Load>
              </Panel>
            ))}
          </div>
          <Panel title="Long-range global attention" meta="share of worldwide news coverage, %" actions={<Seg label="GDELT time span" value={span} onChange={setSpan} options={[{ value: '3m', label: '3m' }, { value: '6m', label: '6m' }, { value: '12m', label: '12m' }]} />}
            foot={<span>Source: <a href="https://www.gdeltproject.org/" target="_blank" rel="noreferrer">GDELT Project</a>, an independent index of global news media. It reaches back further than this platform's own archive.</span>}>
            {ga.isPending || (b && gb.isPending) ? <Skeleton rows={6} pad={false} /> : ga.isError && (!b || gb.isError) ? (
              <ErrorBox what="GDELT is unavailable" error={ga.error} retry={() => { void ga.refetch(); void gb.refetch(); }} />
            ) : (
              <LineChart ariaLabel="GDELT coverage share over time" height={230} format={(v) => num(v, 2)} series={[
                ...(ga.data ? [{ name: name(a)!, color: 'var(--s1)', points: ga.data.points.map((p) => ({ t: p.date, v: p.value })) }] : []),
                ...(b && gb.data ? [{ name: name(b)!, color: 'var(--s2)', points: gb.data.points.map((p) => ({ t: p.date, v: p.value })) }] : []),
              ]} />
            )}
          </Panel>
        </div>
      )}
    </>
  );
}

function Sources() {
  const sources = useSources();
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [results, setResults] = useState<RefreshResult[] | null>(null);
  const refresh = useAct(() => api.post<{ results: RefreshResult[]; inserted: number; failed: number }>('/news/refresh'), { invalidate: ['news', 'status'], success: (r) => `Refreshed: ${r.inserted} new articles`, onDone: (r) => setResults(r.results) });
  const add = useAct(() => api.post('/news/sources', { name, url }), { invalidate: ['news', 'status'], success: 'Source added. Refresh to fetch it.', onDone: () => { setName(''); setUrl(''); } });
  const toggle = useAct((v: { id: string; enabled: boolean }) => api.patch(`/news/sources/${v.id}`, { enabled: v.enabled }), { invalidate: ['news', 'status'] });
  const remove = useAct((id: string) => api.del(`/news/sources/${id}`), { invalidate: ['news', 'status'], success: 'Source removed' });
  return (
    <div className="grid split">
      <Panel title="Feeds" flush actions={<button className="btn sm" disabled={refresh.isPending} onClick={() => refresh.mutate(undefined)}>{refresh.isPending ? <span className="spin" /> : Icon.refresh}{refresh.isPending ? 'Fetching…' : 'Fetch all now'}</button>}
        foot={<span>Feeds are fetched automatically in the background. Each article keeps a link to the original publisher.</span>}>
        <Load q={sources} rows={8}>
          {(list) => (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Source</th><th>Status</th><th className="num hide-sm">Items</th><th className="hide-sm">Last success</th><th /></tr></thead>
                <tbody>
                  {list.map((s) => {
                    const r = results?.find((x) => x.sourceId === s.id);
                    return (
                      <tr key={s.id}>
                        <td>
                          <b>{s.name}</b> {s.region && <span className="faint small">{s.region}</span>}
                          <div className="small faint truncate" style={{ maxWidth: 320 }}><a href={s.homepage ?? s.url} target="_blank" rel="noreferrer" style={{ color: 'inherit' }}>{new URL(s.url).hostname}</a></div>
                          {s.enabled && s.lastError && <div className="small down">{s.lastError}</div>}
                        </td>
                        <td>{!s.enabled ? <span className="chip">Paused</span> : s.lastError ? <span className="chip bad">Failing</span> : s.lastOkAt ? <span className="chip ok">Healthy</span> : <span className="chip outline">Not fetched yet</span>}</td>
                        <td className="num hide-sm">{r ? `${r.fetched} (+${r.inserted})` : (s.lastItemCount ?? '–')}</td>
                        <td className="hide-sm muted">{ago(s.lastOkAt)}</td>
                        <td className="num nowrap">
                          <button className="btn sm ghost" onClick={() => toggle.mutate({ id: s.id, enabled: !s.enabled })}>{s.enabled ? 'Pause' : 'Resume'}</button>
                          {!s.builtin && <ConfirmButton label={`Remove ${s.name}`} onConfirm={() => remove.mutate(s.id)} />}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Load>
      </Panel>
      <Panel title="Add a feed">
        <form className="form" onSubmit={(e) => { e.preventDefault(); add.mutate(undefined); }}>
          <Field label="Name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Financial Times World" required maxLength={80} /></Field>
          <Field label="RSS or Atom URL" hint="Any public RSS 2.0, RDF or Atom feed."><input className="input" type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" required /></Field>
          <div><button className="btn primary" disabled={add.isPending}>{add.isPending ? 'Adding…' : 'Add feed'}</button></div>
        </form>
      </Panel>
    </div>
  );
}

const TABS = [{ id: 'developments', label: 'Developments' }, { id: 'wire', label: 'Wire' }, { id: 'compare', label: 'Compare' }, { id: 'sources', label: 'Sources' }];

export default function Intelligence() {
  const [params, setParams] = useSearchParams();
  const tab = TABS.some((t) => t.id === params.get('tab')) ? params.get('tab')! : 'developments';
  const meta = useNewsMeta();
  return (
    <div className="reveal">
      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setParams(t.id === 'developments' ? {} : { tab: t.id })}>{t.label}</button>
        ))}
      </div>
      <div role="tabpanel">
        {tab === 'developments' && <Developments meta={meta.data} />}
        {tab === 'wire' && <Wire meta={meta.data} />}
        {tab === 'compare' && <Compare meta={meta.data} />}
        {tab === 'sources' && <Sources />}
      </div>
    </div>
  );
}
