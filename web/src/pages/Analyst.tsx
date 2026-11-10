import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import { useSearchParams } from 'react-router-dom';
import remarkGfm from 'remark-gfm';
import { api, type Report, type ReportRequest, type SourceRef, stream, type StreamEvent, todayLocal } from '../lib/api.ts';
import { ago, dateTime } from '../lib/format.ts';
import { useAct, useConversation, useConversations, useNewsMeta, useReport, useReports, useStatus } from '../lib/queries.ts';
import { ConfirmButton, Empty, ErrorBox, Field, Icon, Load, Panel, Seg, Skeleton, useToast } from '../ui/kit.tsx';

/** Analyst prose: serif body, links open in a new tab. */
export function Prose({ text, streaming }: { text: string; streaming?: boolean }) {
  return (
    <div className={`prose ${streaming ? 'cursor' : ''}`}>
      <Markdown remarkPlugins={[remarkGfm]} components={{ a: ({ node: _n, ...props }) => <a {...props} target="_blank" rel="noreferrer" /> }}>{text}</Markdown>
    </div>
  );
}

const KIND: Record<SourceRef['kind'], string> = { news: 'News', 'market-data': 'Market data', filing: 'Filing' };

function Sources({ sources, open }: { sources: SourceRef[]; open?: boolean }) {
  if (sources.length === 0) return null;
  return (
    <details className="sources" open={open}>
      <summary>{sources.length} source{sources.length === 1 ? '' : 's'} consulted</summary>
      <ol>
        {sources.map((s) => (
          <li key={s.url}>
            <a href={s.url} target="_blank" rel="noreferrer">{s.title}</a>
            <span className="faint"> {s.publisher}, {KIND[s.kind]}{s.publishedAt ? `, ${dateTime(s.publishedAt)}` : ''}</span>
          </li>
        ))}
      </ol>
    </details>
  );
}

function Steps({ steps, running }: { steps: { label: string; status: string; detail?: string }[]; running?: boolean }) {
  if (steps.length === 0) return null;
  return (
    <div className="steps" aria-label="Research steps">
      {steps.map((s, i) => (
        <div key={i}>
          {s.status === 'running' && running ? <span className="spin" style={{ width: 12, height: 12 }} /> : s.status === 'error' ? <span className="down">!</span> : Icon.check}
          <span>{s.label}{s.status === 'error' ? `: ${s.detail}` : ''}</span>
        </div>
      ))}
    </div>
  );
}

interface Live { question: string; text: string; steps: { id: string; label: string; status: string; detail?: string }[]; sources: SourceRef[]; notices: string[]; error?: string }

function NotConfigured() {
  return (
    <div className="notice" style={{ maxWidth: '72ch' }}>
      <b>The AI analyst is not configured.</b> Add an Anthropic API key to <code>.env</code> as <code>ANTHROPIC_API_KEY</code> and restart the server to enable chat and AI-written reports.
      Everything else works without it, including data digests on the Reports tab.
    </div>
  );
}

const SUGGESTIONS = [
  'What are the most significant developments right now, and how well corroborated are they?',
  'How is my portfolio positioned, and where is the risk concentrated?',
  'What should I focus on today across tasks, deadlines and training?',
  'Compare Apple and Microsoft on growth, margins and valuation.',
];

function Chat({ configured }: { configured: boolean }) {
  const [params, setParams] = useSearchParams();
  const [activeId, setActiveId] = useState<number | null>(null);
  const [input, setInput] = useState('');
  const [live, setLive] = useState<Live | null>(null);
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const qc = useQueryClient();
  const conversations = useConversations();
  const conversation = useConversation(activeId);
  const remove = useAct((id: number) => api.del(`/analyst/conversations/${id}`), { invalidate: ['analyst'], onDone: (_d, id) => { if (id === activeId) { setActiveId(null); setLive(null); } } });

  // Prefill from links such as "Ask the analyst" elsewhere in the platform.
  useEffect(() => {
    const q = params.get('q');
    if (q) {
      setInput(q);
      setActiveId(null);
      setLive(null);
      const next = new URLSearchParams(params);
      next.delete('q');
      setParams(next, { replace: true });
    }
  }, [params, setParams]);

  useEffect(() => {
    if (stick.current && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [live, conversation.data]);
  useEffect(() => () => abortRef.current?.abort(), []);

  const send = async (text: string) => {
    const question = text.trim();
    if (!question || busy) return;
    setInput('');
    setBusy(true);
    stick.current = true;
    const state: Live = { question, text: '', steps: [], sources: [], notices: [] };
    setLive({ ...state });
    const controller = new AbortController();
    abortRef.current = controller;
    let newId: number | null = null;
    const onEvent = (e: StreamEvent) => {
      if (e.type === 'text') state.text += e.delta;
      else if (e.type === 'tool') {
        const existing = state.steps.find((s) => s.id === e.id);
        if (existing) Object.assign(existing, { status: e.status, detail: e.detail });
        else state.steps.push({ id: e.id, label: e.label, status: e.status, detail: e.detail });
      } else if (e.type === 'sources') state.sources = e.sources;
      else if (e.type === 'notice') state.notices.push(e.message);
      else if (e.type === 'conversation') newId = e.id;
      else if (e.type === 'error') state.error = e.message;
      setLive({ ...state, steps: state.steps.map((s) => ({ ...s })) });
    };
    try {
      await stream('/analyst/chat', { conversationId: activeId ?? undefined, text: question, today: todayLocal() }, onEvent, controller.signal);
    } catch (err) {
      if ((err as Error).name === 'AbortError') state.error = 'Stopped. This exchange was not saved.';
      else state.error = err instanceof Error ? err.message : 'Request failed';
      setLive({ ...state });
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
    if (newId !== null && !state.error) {
      // Saved: reload the stored transcript and drop the live copy.
      await qc.invalidateQueries({ queryKey: ['analyst'] });
      await qc.fetchQuery({ queryKey: ['analyst', 'conversation', newId], queryFn: () => api.get(`/analyst/conversations/${newId}`) });
      setActiveId(newId);
      setLive(null);
    }
  };

  const messages = conversation.data?.messages ?? [];
  const blank = !activeId && !live;
  return (
    <div className="analyst">
      <Panel title="Conversations" flush className="threads" actions={<button className="btn sm" onClick={() => { abortRef.current?.abort(); setActiveId(null); setLive(null); }}>{Icon.plus}New</button>}>
        <div className="thread-list">
          <Load q={conversations} rows={4}>
            {(list) => list.length === 0 ? <p className="small faint" style={{ padding: '10px 10px' }}>Saved conversations appear here.</p> : list.map((c) => (
              <div key={c.id} className="thread" aria-current={c.id === activeId} role="button" tabIndex={0} onClick={() => { if (!busy) { setActiveId(c.id); setLive(null); } }} onKeyDown={(e) => e.key === 'Enter' && !busy && (setActiveId(c.id), setLive(null))}>
                <div className="grow"><div className="truncate">{c.title}</div><div className="small faint">{ago(c.updatedAt)}</div></div>
                <ConfirmButton label="Delete conversation" onConfirm={() => remove.mutate(c.id)} />
              </div>
            ))}
          </Load>
        </div>
      </Panel>

      <Panel flush className="chat" label="Analyst conversation">
        <div className="chat" style={{ height: '100%' }}>
          <div className="chat-scroll" ref={scrollRef} onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}>
            {blank && (
              <div className="stack" style={{ gap: 16, maxWidth: '72ch' }}>
                <div>
                  <h2 className="headline lg">Ask about anything on the platform</h2>
                  <p className="assess muted" style={{ marginTop: 6 }}>The analyst reads your news archive, market data, filed company financials, portfolio and personal records, then answers with links to what it used. It separates what sources report from its own assessment and says where it is unsure.</p>
                </div>
                {!configured && <NotConfigured />}
                <div className="suggest">{SUGGESTIONS.map((s) => <button key={s} className="btn" style={{ height: 'auto', padding: '7px 11px', whiteSpace: 'normal', textAlign: 'left' }} disabled={!configured} onClick={() => void send(s)}>{s}</button>)}</div>
              </div>
            )}
            {activeId && conversation.isPending && <Skeleton rows={6} pad={false} />}
            {activeId && conversation.isError && <ErrorBox error={conversation.error} retry={() => void conversation.refetch()} />}
            {messages.map((m) => m.role === 'user' ? <div key={m.id} className="msg-user">{m.text}</div> : (
              <div key={m.id} className="msg-ai">
                <Steps steps={(m.steps ?? []).map((label) => ({ label, status: 'done' }))} />
                <Prose text={m.text} />
                <Sources sources={m.sources ?? []} />
              </div>
            ))}
            {live && (
              <>
                <div className="msg-user">{live.question}</div>
                <div className="msg-ai" aria-live="polite" aria-busy={busy}>
                  <Steps steps={live.steps} running={busy} />
                  {live.text ? <Prose text={live.text} streaming={busy} /> : busy && live.steps.length === 0 && <div className="row muted"><span className="spin" />Thinking…</div>}
                  {live.notices.map((n) => <div key={n} className="notice">{n}</div>)}
                  {live.error && <ErrorBox what="The analyst could not finish" error={live.error} retry={() => void send(live.question)} />}
                  {!busy && <Sources sources={live.sources} />}
                </div>
              </>
            )}
          </div>
          <form className="composer" onSubmit={(e) => { e.preventDefault(); void send(input); }}>
            <div className="composer-row">
              <textarea className="textarea grow" rows={1} value={input} disabled={!configured} placeholder={configured ? 'Ask a question. Enter to send, Shift+Enter for a new line.' : 'Set ANTHROPIC_API_KEY to enable the analyst'} aria-label="Message the analyst" maxLength={8000}
                onChange={(e) => { setInput(e.target.value); e.target.style.height = 'auto'; e.target.style.height = `${Math.min(180, e.target.scrollHeight + 2)}px`; }}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(input); } }} />
              {busy ? <button type="button" className="btn" onClick={() => abortRef.current?.abort()}>{Icon.stop}Stop</button> : <button className="btn primary" disabled={!configured || !input.trim()}>{Icon.send}Send</button>}
            </div>
            <div className="small faint">Answers draw only on data held in this platform. Prices are delayed. Research, not financial advice.</div>
          </form>
        </div>
      </Panel>
    </div>
  );
}

// ---- reports ------------------------------------------------------------------------
const REPORT_KINDS = [
  { value: 'daily-brief', label: 'Daily brief' },
  { value: 'country', label: 'Country report' },
  { value: 'company', label: 'Company report' },
  { value: 'compare-countries', label: 'Compare two countries' },
  { value: 'compare-companies', label: 'Compare two companies' },
  { value: 'custom', label: 'Custom brief' },
] as const;
type KindValue = (typeof REPORT_KINDS)[number]['value'];

function download(report: Report) {
  const sources = report.sources.length ? `\n\n---\n\nSources\n\n${report.sources.map((s, i) => `${i + 1}. [${s.title}](${s.url}) — ${s.publisher}`).join('\n')}` : '';
  const blob = new Blob([`# ${report.title}\n\n_Generated ${report.createdAt} (${report.engine})_\n\n${report.body}${sources}\n`], { type: 'text/markdown' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${report.title.replace(/[^\w]+/g, '-').replace(/^-|-$/g, '').toLowerCase()}.md`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function Reports({ configured }: { configured: boolean }) {
  const toast = useToast();
  const qc = useQueryClient();
  const meta = useNewsMeta();
  const reports = useReports();
  const [selected, setSelected] = useState<number | null>(null);
  const report = useReport(selected);
  const [kind, setKind] = useState<KindValue>('daily-brief');
  const [engine, setEngine] = useState<'ai' | 'digest'>(configured ? 'ai' : 'digest');
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  const [prompt, setPrompt] = useState('');
  const [gen, setGen] = useState<{ text: string; steps: { id: string; label: string; status: string; detail?: string }[]; error?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const remove = useAct((id: number) => api.del(`/analyst/reports/${id}`), { invalidate: ['analyst'], success: 'Report deleted', onDone: (_d, id) => id === selected && setSelected(null) });
  useEffect(() => () => abortRef.current?.abort(), []);
  useEffect(() => { setA(''); setB(''); }, [kind]);
  useEffect(() => { if (kind === 'custom') setEngine('ai'); }, [kind]);

  const countries = [...(meta.data?.countries ?? [])].sort((x, y) => x.name.localeCompare(y.name));
  const countrySelect = (value: string, set: (v: string) => void, label: string) => (
    <Field label={label}><select className="select" value={value} onChange={(e) => set(e.target.value)} required><option value="">Choose…</option>{countries.map((c) => <option key={c.iso3} value={c.iso3}>{c.name}</option>)}</select></Field>
  );
  const tickerInput = (value: string, set: (v: string) => void, label: string) => (
    <Field label={label}><input className="input" value={value} onChange={(e) => set(e.target.value.toUpperCase())} placeholder="e.g. AAPL" required maxLength={15} /></Field>
  );
  const request = (): ReportRequest =>
    kind === 'daily-brief' ? { kind } : kind === 'country' ? { kind, iso3: a } : kind === 'company' ? { kind, symbol: a }
      : kind === 'compare-countries' ? { kind: 'comparison', subject: 'countries', a, b } : kind === 'compare-companies' ? { kind: 'comparison', subject: 'companies', a, b } : { kind: 'custom', prompt };

  const generate = async () => {
    setBusy(true);
    setSelected(null);
    const state = { text: '', steps: [] as { id: string; label: string; status: string; detail?: string }[], error: undefined as string | undefined };
    setGen({ ...state });
    const controller = new AbortController();
    abortRef.current = controller;
    let saved: Report | null = null;
    try {
      await stream('/analyst/reports', { engine, request: request(), today: todayLocal() }, (e) => {
        if (e.type === 'text') state.text += e.delta;
        else if (e.type === 'tool') {
          const s = state.steps.find((x) => x.id === e.id);
          if (s) Object.assign(s, { status: e.status, detail: e.detail }); else state.steps.push({ id: e.id, label: e.label, status: e.status, detail: e.detail });
        } else if (e.type === 'error') state.error = e.message;
        else if (e.type === 'report') saved = e.report;
        setGen({ ...state, steps: state.steps.map((s) => ({ ...s })) });
      }, controller.signal);
    } catch (err) {
      state.error = (err as Error).name === 'AbortError' ? 'Stopped. Nothing was saved.' : err instanceof Error ? err.message : 'Request failed';
      setGen({ ...state });
    } finally {
      setBusy(false);
    }
    if (saved) {
      const r = saved as Report;
      qc.setQueryData(['analyst', 'report', r.id], r);
      await qc.invalidateQueries({ queryKey: ['analyst', 'reports'] });
      setSelected(r.id);
      setGen(null);
      toast('Report saved');
    }
  };

  const view = report.data;
  return (
    <div className="grid split-r">
      <div className="stack" style={{ gap: 14 }}>
        <Panel title="Generate a report">
          <form className="form" onSubmit={(e) => { e.preventDefault(); void generate(); }}>
            <Field label="Report type"><select className="select" value={kind} onChange={(e) => setKind(e.target.value as KindValue)}>{REPORT_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}</select></Field>
            {kind === 'country' && countrySelect(a, setA, 'Country')}
            {kind === 'company' && tickerInput(a, setA, 'Ticker')}
            {kind === 'compare-countries' && <div className="form-row">{countrySelect(a, setA, 'First country')}{countrySelect(b, setB, 'Second country')}</div>}
            {kind === 'compare-companies' && <div className="form-row">{tickerInput(a, setA, 'First ticker')}{tickerInput(b, setB, 'Second ticker')}</div>}
            {kind === 'custom' && <Field label="What should the report cover?"><textarea className="textarea" rows={4} value={prompt} onChange={(e) => setPrompt(e.target.value)} required minLength={3} maxLength={4000} placeholder="e.g. How exposed is my portfolio to developments in Taiwan?" /></Field>}
            <Field group label="Written by" hint={engine === 'ai' ? 'The analyst researches platform data and writes sourced analysis.' : 'Tables and lists built directly from platform data. No AI, no interpretation.'}>
              <Seg label="Report engine" value={engine} onChange={setEngine} options={[{ value: 'ai', label: 'AI analyst' }, { value: 'digest', label: 'Data digest' }]} />
            </Field>
            {engine === 'ai' && !configured && <NotConfigured />}
            {kind === 'custom' && engine === 'digest' && <div className="form-error">Custom briefs need the AI analyst.</div>}
            <div className="row">
              <button className="btn primary" disabled={busy || (engine === 'ai' && !configured) || (kind === 'custom' && engine === 'digest')}>{busy ? <><span className="spin" />Generating…</> : 'Generate report'}</button>
              {busy && <button type="button" className="btn" onClick={() => abortRef.current?.abort()}>Stop</button>}
            </div>
          </form>
        </Panel>
        <Panel title="Saved reports" flush>
          <Load q={reports} rows={4}>
            {(list) => list.length === 0 ? <Empty title="No reports yet">Generated reports are saved here with their sources.</Empty> : (
              <div className="thread-list" style={{ maxHeight: 420 }}>
                {list.map((r) => (
                  <div key={r.id} className="thread" aria-current={r.id === selected} role="button" tabIndex={0} onClick={() => { setSelected(r.id); setGen(null); }} onKeyDown={(e) => e.key === 'Enter' && (setSelected(r.id), setGen(null))}>
                    <div className="grow"><div className="truncate">{r.title}</div><div className="small faint">{dateTime(r.createdAt)}, {r.engine === 'data-digest' ? 'data digest' : 'AI analyst'}</div></div>
                    <ConfirmButton label="Delete report" onConfirm={() => remove.mutate(r.id)} />
                  </div>
                ))}
              </div>
            )}
          </Load>
        </Panel>
      </div>

      <Panel title={gen ? 'Generating' : (view?.title ?? 'Report')} meta={!gen && view ? `${dateTime(view.createdAt)}, ${view.engine === 'data-digest' ? 'data digest' : `written by ${view.engine.replace('ai:', '')}`}` : undefined}
        actions={!gen && view ? <><button className="btn sm" onClick={() => download(view)}>Download</button><button className="btn sm hide-sm" onClick={() => window.print()}>Print</button></> : undefined}>
        {gen ? (
          <div className="stack" style={{ gap: 14 }} aria-live="polite">
            <StepsList steps={gen.steps} busy={busy} />
            {gen.text ? <Prose text={gen.text} streaming={busy} /> : busy && <div className="row muted"><span className="spin" />Gathering data…</div>}
            {gen.error && <ErrorBox what="The report could not be generated" error={gen.error} retry={() => void generate()} />}
          </div>
        ) : selected && report.isPending ? <Skeleton rows={10} pad={false} /> : selected && report.isError ? <ErrorBox error={report.error} /> : view ? (
          <div className="stack" style={{ gap: 18 }}>
            <Prose text={view.body} />
            <Sources sources={view.sources} open />
          </div>
        ) : <Empty title="Choose or generate a report" icon={Icon.file}>Reports combine the news archive, market data and your own records. Every factual line links to its source.</Empty>}
      </Panel>
    </div>
  );
}

function StepsList({ steps, busy }: { steps: { label: string; status: string; detail?: string }[]; busy: boolean }) {
  return <Steps steps={steps} running={busy} />;
}

const TABS = [{ id: 'chat', label: 'Ask' }, { id: 'reports', label: 'Reports' }];

export default function Analyst() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'reports' ? 'reports' : 'chat';
  const status = useStatus();
  return (
    <div className="reveal">
      <div className="tabs" role="tablist">
        {TABS.map((t) => <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setParams(t.id === 'chat' ? {} : { tab: t.id })}>{t.label}</button>)}
      </div>
      {status.isPending ? <Skeleton rows={6} /> : status.isError ? <ErrorBox error={status.error} retry={() => void status.refetch()} /> : tab === 'chat' ? <Chat configured={status.data.analyst.configured} /> : <Reports configured={status.data.analyst.configured} />}
    </div>
  );
}
