import { useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { BarChart, ChartNote, HBars, LineChart } from '../charts/charts.tsx';
import { api, type Objective, type Task, todayLocal } from '../lib/api.ts';
import { ago, day, dayShort, dueLabel, duration, num, pace, parseDuration, share, signed } from '../lib/format.ts';
import { useAct, useDeadlines, usePersonal, useRuns, useTasks } from '../lib/queries.ts';
import { ConfirmButton, Empty, Field, Icon, Load, Modal, Panel, Seg, Stat, useToast } from '../ui/kit.tsx';

const INV = ['personal'];
const RUN_KINDS = ['easy', 'long', 'tempo', 'intervals', 'race', 'recovery'] as const;
const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);

// ---- today ------------------------------------------------------------------------
function TaskEditor({ task, onClose }: { task: Task; onClose: () => void }) {
  const [form, setForm] = useState({ title: task.title, notes: task.notes, dueOn: task.dueOn ?? '', priority: String(task.priority) });
  const save = useAct(() => api.patch(`/personal/tasks/${task.id}`, { title: form.title, notes: form.notes, dueOn: form.dueOn || null, priority: Number(form.priority) }), { invalidate: INV, success: 'Task updated', onDone: onClose, quietError: true });
  return (
    <Modal title="Edit task" onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); save.mutate(undefined); }}>
        <div className="modal-body form">
          <Field label="Task"><input className="input" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} required maxLength={200} /></Field>
          <div className="form-row">
            <Field label="Due date"><input className="input" type="date" value={form.dueOn} onChange={(e) => setForm({ ...form, dueOn: e.target.value })} /></Field>
            <Field label="Priority"><select className="select" value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })}><option value="1">High</option><option value="2">Normal</option><option value="3">Low</option></select></Field>
          </div>
          <Field label="Notes"><textarea className="textarea" rows={3} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} maxLength={2000} /></Field>
          {save.isError && <div className="form-error" role="alert">{save.error.message}</div>}
        </div>
        <div className="modal-foot"><button type="button" className="btn ghost" onClick={onClose}>Cancel</button><button className="btn primary" disabled={save.isPending}>Save changes</button></div>
      </form>
    </Modal>
  );
}

function Today() {
  const today = todayLocal();
  const tasks = useTasks();
  const overview = usePersonal();
  const deadlines = useDeadlines();
  const [title, setTitle] = useState('');
  const [due, setDue] = useState(today);
  const [priority, setPriority] = useState('2');
  const [show, setShow] = useState<'open' | 'done'>('open');
  const [editing, setEditing] = useState<Task | null>(null);
  const [dl, setDl] = useState({ title: '', dueOn: '', category: '' });
  const add = useAct(() => api.post('/personal/tasks', { title, dueOn: due || null, priority: Number(priority) }), { invalidate: INV, onDone: () => setTitle('') });
  const toggle = useAct((t: Task) => api.patch(`/personal/tasks/${t.id}`, { done: !t.doneAt }), { invalidate: INV });
  const remove = useAct((id: number) => api.del(`/personal/tasks/${id}`), { invalidate: INV, success: 'Task deleted' });
  const addDeadline = useAct(() => api.post('/personal/deadlines', { title: dl.title, dueOn: dl.dueOn, category: dl.category || undefined }), { invalidate: INV, success: 'Deadline added', onDone: () => setDl({ title: '', dueOn: '', category: '' }) });
  const doneDeadline = useAct((id: number) => api.patch(`/personal/deadlines/${id}`, { done: true }), { invalidate: INV, success: 'Deadline marked done' });
  const delDeadline = useAct((id: number) => api.del(`/personal/deadlines/${id}`), { invalidate: INV });

  return (
    <div className="grid split">
      <Panel title="Tasks" flush actions={<Seg label="Show tasks" value={show} onChange={setShow} options={[{ value: 'open', label: 'Open' }, { value: 'done', label: 'Completed' }]} />}>
        <form className="row wrap" style={{ padding: '12px 14px', borderBottom: '1px solid var(--line-soft)' }} onSubmit={(e) => { e.preventDefault(); if (title.trim()) add.mutate(undefined); }}>
          <input className="input grow" style={{ width: 'auto', minWidth: 160 }} placeholder="Add a task and press Enter" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="New task" maxLength={200} />
          <input className="input" style={{ width: 142 }} type="date" value={due} onChange={(e) => setDue(e.target.value)} aria-label="Due date" />
          <select className="select" style={{ width: 96 }} value={priority} onChange={(e) => setPriority(e.target.value)} aria-label="Priority"><option value="1">High</option><option value="2">Normal</option><option value="3">Low</option></select>
          <button className="btn primary" disabled={!title.trim() || add.isPending}>Add task</button>
        </form>
        <Load q={tasks} rows={6}>
          {(all) => {
            const list = all.filter((t) => (show === 'open' ? !t.doneAt : t.doneAt));
            if (list.length === 0) return <Empty title={show === 'open' ? (all.length ? 'All clear' : 'No tasks yet') : 'Nothing completed yet'}>{show === 'open' ? (all.length ? 'Every task is done.' : 'Add what you need to do today in the box above.') : 'Completed tasks are kept here and feed your analytics.'}</Empty>;
            return list.map((t) => {
              const days = t.dueOn ? Math.round((Date.parse(t.dueOn) - Date.parse(today)) / 86_400_000) : null;
              return (
                <div key={t.id} className={`task ${t.doneAt ? 'done' : ''}`}>
                  <span className={`prio p${t.priority}`} title={['', 'High priority', 'Normal priority', 'Low priority'][t.priority]} />
                  <button className="check" role="checkbox" aria-checked={Boolean(t.doneAt)} aria-label={`Mark “${t.title}” ${t.doneAt ? 'not done' : 'done'}`} onClick={() => toggle.mutate(t)}>{Icon.check}</button>
                  <div className="grow">
                    <div className="title">{t.title}</div>
                    {t.notes && <div className="small muted">{t.notes}</div>}
                    <div className="small faint" style={{ marginTop: 2 }}>
                      {t.doneAt ? `Completed ${ago(t.doneAt)}` : days === null ? 'No due date' : <span className={days < 0 ? 'down' : days === 0 ? '' : ''} style={days === 0 ? { color: 'var(--amber)' } : undefined}>{dueLabel(days)}, {dayShort(t.dueOn!)}</span>}
                    </div>
                  </div>
                  <div className="tools">
                    {!t.doneAt && <button className="btn ghost icon" aria-label="Edit task" onClick={() => setEditing(t)}>{Icon.edit}</button>}
                    <ConfirmButton label="Delete task" onConfirm={() => remove.mutate(t.id)} />
                  </div>
                </div>
              );
            });
          }}
        </Load>
      </Panel>

      <div className="stack" style={{ gap: 14 }}>
        <Panel title="Upcoming" meta="next 60 days" flush>
          <Load q={overview} rows={5}>
            {(o) => o.upcoming.length === 0 ? <Empty title="Nothing on the horizon">Dated tasks, deadlines and objective due dates are gathered here, soonest first.</Empty> : o.upcoming.map((u) => (
              <div className="agenda-item" key={`${u.type}-${u.id}`}>
                <span className="agenda-date">{dayShort(u.dueOn)}</span>
                <div className="grow"><div className="truncate">{u.title}</div><div className="small faint">{cap(u.type)}, {u.detail}</div></div>
                <span className="row" style={{ gap: 4 }}>
                  <span className={`chip ${u.daysLeft < 0 ? 'bad' : u.daysLeft <= 1 ? 'amber' : ''}`}>{dueLabel(u.daysLeft)}</span>
                  {u.type === 'deadline' && <button className="btn ghost icon" aria-label={`Mark deadline “${u.title}” done`} title="Mark done" onClick={() => doneDeadline.mutate(u.id)}>{Icon.check}</button>}
                </span>
              </div>
            ))}
          </Load>
        </Panel>
        <Panel title="Add a deadline">
          <form className="form" onSubmit={(e) => { e.preventDefault(); addDeadline.mutate(undefined); }}>
            <Field label="What is due"><input className="input" value={dl.title} onChange={(e) => setDl({ ...dl, title: e.target.value })} required maxLength={200} placeholder="e.g. Tax return" /></Field>
            <div className="form-row">
              <Field label="Date"><input className="input" type="date" value={dl.dueOn} onChange={(e) => setDl({ ...dl, dueOn: e.target.value })} required /></Field>
              <Field label="Category"><input className="input" value={dl.category} onChange={(e) => setDl({ ...dl, category: e.target.value })} placeholder="finance, work…" maxLength={40} /></Field>
            </div>
            <div><button className="btn" disabled={addDeadline.isPending}>Add deadline</button></div>
          </form>
          {(deadlines.data?.filter((d) => d.doneAt).length ?? 0) > 0 && (
            <details style={{ marginTop: 14 }}>
              <summary className="small muted" style={{ cursor: 'pointer' }}>Completed deadlines ({deadlines.data!.filter((d) => d.doneAt).length})</summary>
              {deadlines.data!.filter((d) => d.doneAt).map((d) => (
                <div key={d.id} className="row small" style={{ marginTop: 6 }}><span className="grow muted truncate">{d.title}, {dayShort(d.dueOn)}</span><ConfirmButton label="Delete deadline" onConfirm={() => delDeadline.mutate(d.id)} /></div>
              ))}
            </details>
          )}
        </Panel>
      </div>
      {editing && <TaskEditor task={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

// ---- training -----------------------------------------------------------------------
function RunModal({ onClose }: { onClose: () => void }) {
  const [form, setForm] = useState({ runOn: todayLocal(), distanceKm: '', time: '', kind: 'easy', avgHr: '', elevationM: '', notes: '' });
  const [error, setError] = useState('');
  const save = useAct((body: object) => api.post('/personal/runs', body), { invalidate: INV, success: 'Run logged', onDone: onClose, quietError: true });
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm({ ...form, [k]: e.target.value });
  const seconds = parseDuration(form.time);
  const km = Number(form.distanceKm);
  return (
    <Modal title="Log a run" onClose={onClose}>
      <form onSubmit={(e) => {
        e.preventDefault();
        if (seconds === null) return setError('Enter the time as mm:ss or h:mm:ss, for example 48:30.');
        setError('');
        save.mutate({ runOn: form.runOn, distanceKm: km, durationS: seconds, kind: form.kind, avgHr: form.avgHr ? Number(form.avgHr) : null, elevationM: form.elevationM ? Number(form.elevationM) : null, notes: form.notes });
      }}>
        <div className="modal-body form">
          <div className="form-row">
            <Field label="Date"><input className="input" type="date" value={form.runOn} max={todayLocal()} onChange={set('runOn')} required /></Field>
            <Field label="Type"><select className="select" value={form.kind} onChange={set('kind')}>{RUN_KINDS.map((k) => <option key={k} value={k}>{cap(k)}</option>)}</select></Field>
          </div>
          <div className="form-row">
            <Field label="Distance (km)"><input className="input" type="number" step="0.01" min="0.1" max="500" value={form.distanceKm} onChange={set('distanceKm')} required /></Field>
            <Field label="Time" hint={seconds && km > 0 ? `Pace ${pace(seconds / km)} per km` : 'mm:ss or h:mm:ss'}><input className="input" value={form.time} onChange={set('time')} placeholder="48:30" required inputMode="numeric" /></Field>
          </div>
          <div className="form-row">
            <Field label="Average heart rate (optional)"><input className="input" type="number" min="30" max="250" value={form.avgHr} onChange={set('avgHr')} /></Field>
            <Field label="Elevation gain, m (optional)"><input className="input" type="number" min="0" value={form.elevationM} onChange={set('elevationM')} /></Field>
          </div>
          <Field label="Notes"><input className="input" value={form.notes} onChange={set('notes')} maxLength={1000} placeholder="How it felt, route, conditions" /></Field>
          {(error || save.isError) && <div className="form-error" role="alert">{error || save.error?.message}</div>}
        </div>
        <div className="modal-foot"><button type="button" className="btn ghost" onClick={onClose}>Cancel</button><button className="btn primary" disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Log run'}</button></div>
      </form>
    </Modal>
  );
}

function Training() {
  const overview = usePersonal();
  const runs = useRuns();
  const [modal, setModal] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const toast = useToast();
  const importGpx = useAct(async (files: File[]) => {
    let ok = 0;
    const failed: string[] = [];
    for (const f of files) {
      try {
        await api.upload('/personal/runs/import-gpx', await f.text(), 'application/gpx+xml');
        ok++;
      } catch (err) {
        failed.push(`${f.name}: ${err instanceof Error ? err.message : 'failed'}`);
      }
    }
    return { ok, failed };
  }, { invalidate: INV, onDone: (r) => { if (r.ok) toast(`Imported ${r.ok} run${r.ok === 1 ? '' : 's'} from GPX`); for (const f of r.failed) toast(f, true); } });
  const remove = useAct((id: number) => api.del(`/personal/runs/${id}`), { invalidate: INV, success: 'Run deleted' });
  const actions = (
    <>
      <input ref={fileRef} type="file" accept=".gpx,application/gpx+xml" multiple hidden onChange={(e) => { const files = [...(e.target.files ?? [])]; if (files.length) importGpx.mutate(files); e.target.value = ''; }} />
      <button className="btn sm" onClick={() => fileRef.current?.click()} disabled={importGpx.isPending}>{importGpx.isPending ? <span className="spin" /> : Icon.upload}Import GPX</button>
      <button className="btn sm primary" onClick={() => setModal(true)}>{Icon.plus}Log a run</button>
    </>
  );
  return (
    <>
      <Load q={overview} rows={8}>
        {({ fitness: f }) => f.totalRuns === 0 ? (
          <Panel><Empty title="Your training log is empty" action={<div className="row">{actions}</div>}>Log runs by hand, or import GPX files exported from your watch, Strava or Garmin. Distance, time, elevation and heart rate are read from the track.</Empty></Panel>
        ) : (
          <div className="grid">
            <Panel title="Running" actions={actions}>
              <div className="stats">
                <Stat large label="This week" value={`${num(f.thisWeekKm, 1)} km`} sub={`${signed(f.thisWeekKm - f.lastWeekKm, 1)} km on last week`} />
                <Stat label="Four-week average" value={`${num(f.fourWeekAvgKm, 1)} km`} sub="completed weeks" />
                <Stat label="Load ratio" value={f.loadRatio === null ? '–' : num(f.loadRatio)} sub={f.loadRatio === null ? 'needs 28 days of data' : f.loadRatio > 1.5 ? 'sharp increase' : f.loadRatio < 0.8 ? 'below recent load' : 'steady range'} tone={f.loadRatio !== null && f.loadRatio > 1.5 ? 'down' : ''} />
                <Stat label="Year to date" value={`${num(f.yearToDate.distanceKm, 0)} km`} sub={`${f.yearToDate.runs} runs, ${duration(f.yearToDate.durationS)}`} />
                <Stat label="Weekly streak" value={`${f.weekStreak} wk`} sub="weeks in a row with a run" />
                <Stat label="Longest run" value={f.longestRun ? `${num(f.longestRun.distanceKm, 1)} km` : '–'} sub={f.longestRun ? day(f.longestRun.runOn) : undefined} />
              </div>
            </Panel>
            <div className="grid cols-2">
              <Panel title="Weekly distance" meta="km, last 12 weeks">
                <BarChart ariaLabel="Weekly running distance in kilometres" height={210} highlightLast format={(v) => num(v, 0)} reference={f.fourWeekAvgKm > 0 ? { value: f.fourWeekAvgKm, label: `4-week average ${num(f.fourWeekAvgKm, 1)}` } : undefined}
                  data={f.weekly.map((w) => ({ key: w.weekStart, label: dayShort(w.weekStart), value: w.distanceKm, note: `Week of ${dayShort(w.weekStart)}: ${w.runs} run${w.runs === 1 ? '' : 's'}${w.paceSPerKm ? `, ${pace(w.paceSPerKm)}/km` : ''}` }))} />
                <ChartNote>The current week is shown lighter because it is still in progress. Load ratio is the last 7 days against the 28-day weekly average.</ChartNote>
              </Panel>
              <Panel title="Pace" meta="minutes per km, each run">
                {f.paceSeries.length < 2 ? <Empty title="Log two runs to see a pace trend" /> : (
                  <LineChart ariaLabel="Pace per run over time" height={210} format={(v) => pace(v)} series={[{ name: 'Pace per km (lower is faster)', color: 'var(--s3)', points: collapseByDay(f.paceSeries) }]} />
                )}
                <div className="row wrap small muted" style={{ marginTop: 10, gap: 16 }}>
                  {([['5 km+', f.bestPace.over5k], ['10 km+', f.bestPace.over10k], ['Half marathon+', f.bestPace.overHalf]] as const).map(([label, b]) => b && <span key={label}>Best pace, {label}: <b style={{ color: 'var(--ink)' }}>{pace(b.paceSPerKm)}</b> ({dayShort(b.runOn)})</span>)}
                </div>
              </Panel>
            </div>
            <Panel title="Log" meta={`${f.totalRuns} run${f.totalRuns === 1 ? '' : 's'}`} flush>
              <Load q={runs} rows={5}>
                {(list) => (
                  <div className="table-wrap" style={{ maxHeight: 420, overflowY: 'auto' }}>
                    <table className="table">
                      <thead><tr><th>Date</th><th>Type</th><th className="num">Distance</th><th className="num">Time</th><th className="num">Pace</th><th className="num hide-sm">Heart rate</th><th className="num hide-sm">Climb</th><th className="hide-sm">Notes</th><th /></tr></thead>
                      <tbody>
                        {list.map((r) => (
                          <tr key={r.id}>
                            <td className="nowrap">{day(r.runOn)}</td>
                            <td><span className="chip">{cap(r.kind)}</span>{r.origin === 'gpx' && <span className="chip outline" style={{ marginLeft: 4 }}>GPX</span>}</td>
                            <td className="num"><b>{num(r.distanceKm)} km</b></td><td className="num">{duration(r.durationS)}</td><td className="num">{pace(r.durationS / r.distanceKm)}</td>
                            <td className="num hide-sm muted">{r.avgHr ?? '–'}</td><td className="num hide-sm muted">{r.elevationM != null ? `${num(r.elevationM, 0)} m` : '–'}</td>
                            <td className="hide-sm muted truncate" style={{ maxWidth: 220 }}>{r.notes}</td>
                            <td className="num"><ConfirmButton label="Delete run" onConfirm={() => remove.mutate(r.id)} /></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Load>
            </Panel>
          </div>
        )}
      </Load>
      {modal && <RunModal onClose={() => setModal(false)} />}
    </>
  );
}

/** Several runs on one day share an x position: keep the distance-weighted pace. */
function collapseByDay(series: { runOn: string; paceSPerKm: number; distanceKm: number }[]) {
  const byDay = new Map<string, { s: number; km: number }>();
  for (const r of series) {
    const cur = byDay.get(r.runOn) ?? { s: 0, km: 0 };
    byDay.set(r.runOn, { s: cur.s + r.paceSPerKm * r.distanceKm, km: cur.km + r.distanceKm });
  }
  return [...byDay.entries()].map(([t, v]) => ({ t, v: v.s / v.km }));
}

// ---- objectives -----------------------------------------------------------------------
const PACE_LABEL: Record<Objective['pace'], { text: string; cls: string }> = {
  achieved: { text: 'Achieved', cls: 'ok' },
  ahead: { text: 'Ahead of schedule', cls: 'ok' },
  'on-track': { text: 'On track', cls: '' },
  behind: { text: 'Behind schedule', cls: 'warn' },
  overdue: { text: 'Past due', cls: 'bad' },
  'no-deadline': { text: 'No deadline', cls: 'outline' },
};

function ObjectiveModal({ onClose }: { onClose: () => void }) {
  const [f, setF] = useState({ title: '', description: '', category: '', unit: '', startValue: '0', targetValue: '', dueOn: '' });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });
  const save = useAct(() => api.post('/personal/objectives', { title: f.title, description: f.description, category: f.category || undefined, unit: f.unit, startValue: Number(f.startValue || 0), targetValue: Number(f.targetValue), dueOn: f.dueOn || null }), { invalidate: INV, success: 'Objective created', onDone: onClose, quietError: true });
  return (
    <Modal title="New objective" onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); save.mutate(undefined); }}>
        <div className="modal-body form">
          <Field label="Objective"><input className="input" value={f.title} onChange={set('title')} required maxLength={160} placeholder="e.g. Run a sub-45 10K" /></Field>
          <div className="form-row">
            <Field label="Starting value"><input className="input" type="number" step="any" value={f.startValue} onChange={set('startValue')} required /></Field>
            <Field label="Target value" hint="Can be lower than the start, e.g. a race time."><input className="input" type="number" step="any" value={f.targetValue} onChange={set('targetValue')} required /></Field>
            <Field label="Unit"><input className="input" value={f.unit} onChange={set('unit')} placeholder="km, min, £, books" maxLength={20} /></Field>
          </div>
          <div className="form-row">
            <Field label="Target date (optional)"><input className="input" type="date" value={f.dueOn} onChange={set('dueOn')} /></Field>
            <Field label="Category"><input className="input" value={f.category} onChange={set('category')} placeholder="fitness, career, finance" maxLength={40} /></Field>
          </div>
          <Field label="Why it matters (optional)"><textarea className="textarea" rows={2} value={f.description} onChange={set('description')} maxLength={2000} /></Field>
          {save.isError && <div className="form-error" role="alert">{save.error.message}</div>}
        </div>
        <div className="modal-foot"><button type="button" className="btn ghost" onClick={onClose}>Cancel</button><button className="btn primary" disabled={save.isPending}>Create objective</button></div>
      </form>
    </Modal>
  );
}

function ObjectiveCard({ o }: { o: Objective }) {
  const [value, setValue] = useState('');
  const [note, setNote] = useState('');
  const log = useAct(() => api.post(`/personal/objectives/${o.id}/progress`, { value: Number(value), note }), { invalidate: INV, success: 'Progress recorded', onDone: () => { setValue(''); setNote(''); } });
  const status = useAct((s: string) => api.patch(`/personal/objectives/${o.id}`, { status: s }), { invalidate: INV });
  const remove = useAct(() => api.del(`/personal/objectives/${o.id}`), { invalidate: INV, success: 'Objective deleted' });
  const p = o.status === 'dropped' ? { text: 'Dropped', cls: '' } : PACE_LABEL[o.pace];
  const points = collapseHistory(o.history);
  return (
    <Panel title={o.title} meta={o.category !== 'general' ? o.category : undefined} actions={<><span className={`chip ${p.cls}`}>{p.text}</span><ConfirmButton label="Delete objective" onConfirm={() => remove.mutate(undefined)} /></>}>
      <div className="stack" style={{ gap: 12 }}>
        {o.description && <p className="muted">{o.description}</p>}
        <div className="row between" style={{ alignItems: 'flex-end' }}>
          <div><span style={{ font: '650 26px/1 var(--sans)' }}>{num(o.currentValue, o.currentValue % 1 ? 2 : 0)}</span> <span className="muted">of {num(o.targetValue, o.targetValue % 1 ? 2 : 0)} {o.unit}</span></div>
          <div className="right small muted">{Math.round(o.progress * 100)}% complete{o.dueOn && <div>{o.daysLeft !== null && o.daysLeft >= 0 ? `${o.daysLeft} days left, due ${dayShort(o.dueOn)}` : `was due ${dayShort(o.dueOn)}`}</div>}</div>
        </div>
        <div className="bar-track" style={{ height: 8 }} role="progressbar" aria-valuenow={Math.round(o.progress * 100)} aria-valuemin={0} aria-valuemax={100} aria-label={`${o.title} progress`}>
          <div className="bar-fill" style={{ width: `${o.progress * 100}%`, background: o.pace === 'behind' || o.pace === 'overdue' ? 'var(--warn)' : o.progress >= 1 ? 'var(--up)' : 'var(--s1)' }} />
          {o.expected !== null && o.expected >= 0.01 && o.progress < 1 && <div className="bar-mark" style={{ left: `calc(${o.expected * 100}% - 1px)` }} title="Where you would be if progress were even" />}
        </div>
        {o.expected !== null && o.expected >= 0.01 && o.progress < 1 && <p className="small faint">The marker shows even progress to date: {Math.round(o.expected * 100)}%.</p>}
        {points.length > 1 && <LineChart ariaLabel={`${o.title} progress history`} height={120} format={(v) => num(v, 0)} series={[{ name: o.unit || 'Value', color: 'var(--s1)', points }]} />}
        {o.status === 'active' ? (
          <form className="row wrap" onSubmit={(e) => { e.preventDefault(); if (value !== '') log.mutate(undefined); }}>
            <input className="input" style={{ width: 130 }} type="number" step="any" placeholder="New value" value={value} onChange={(e) => setValue(e.target.value)} aria-label="New value" required />
            <input className="input grow" style={{ width: 'auto', minWidth: 120 }} placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} aria-label="Note" />
            <button className="btn" disabled={log.isPending}>Record progress</button>
            <button type="button" className="btn ghost sm" onClick={() => status.mutate('dropped')}>Drop</button>
          </form>
        ) : <div><button className="btn sm" onClick={() => status.mutate('active')}>Reopen</button></div>}
      </div>
    </Panel>
  );
}

function collapseHistory(history: Objective['history']) {
  const byDay = new Map<string, number>();
  for (const h of history) byDay.set(h.at.slice(0, 10), h.value);
  return [...byDay.entries()].map(([t, v]) => ({ t, v }));
}

function Objectives() {
  const overview = usePersonal();
  const [modal, setModal] = useState(false);
  return (
    <>
      <div className="row between" style={{ marginBottom: 14 }}>
        <p className="muted">Measurable goals with a start, a target and optionally a date.</p>
        <button className="btn primary sm" onClick={() => setModal(true)}>{Icon.plus}New objective</button>
      </div>
      <Load q={overview} rows={6}>
        {({ objectives }) => objectives.length === 0 ? (
          <Panel><Empty title="No objectives set" action={<button className="btn" onClick={() => setModal(true)}>Set an objective</button>}>Define what you are aiming for in numbers. Record progress as you go and see whether you are keeping pace with the deadline.</Empty></Panel>
        ) : <div className="grid cols-2">{objectives.map((o) => <ObjectiveCard key={o.id} o={o} />)}</div>}
      </Load>
      {modal && <ObjectiveModal onClose={() => setModal(false)} />}
    </>
  );
}

// ---- analytics ------------------------------------------------------------------------
function Analytics() {
  const overview = usePersonal();
  return (
    <Load q={overview} rows={8}>
      {({ tasks: t, fitness: f, objectives }) => {
        const active = objectives.filter((o) => o.status === 'active');
        const nothing = t.completed === 0 && t.open === 0 && f.totalRuns === 0 && objectives.length === 0;
        if (nothing) return <Panel><Empty title="No activity to analyse yet">Analytics are calculated from what you record: completed tasks, logged runs and objective progress.</Empty></Panel>;
        return (
          <div className="grid">
            <Panel title="Execution" meta="last 30 days">
              <div className="stats">
                <Stat large label="Tasks completed" value={t.completed} sub={`${t.created} created`} />
                <Stat label="Last 7 days" value={t.last7Completed} sub={`${signed(t.last7Completed - t.prev7Completed, 0)} on the week before`} />
                <Stat label="Finished on time" value={t.onTimeRate === null ? '–' : share(t.onTimeRate, 0)} sub={t.onTimeRate === null ? 'no dated tasks completed' : 'of dated tasks'} />
                <Stat label="Open now" value={t.open} sub={`${t.overdue} overdue`} tone={t.overdue ? 'down' : ''} />
                <Stat label="Objectives on pace" value={active.length ? `${active.filter((o) => o.pace === 'on-track' || o.pace === 'ahead' || o.pace === 'no-deadline').length} of ${active.length}` : '–'} sub="active objectives" />
              </div>
            </Panel>
            <div className="grid cols-2">
              <Panel title="Tasks completed per day" meta="last 30 days">
                <BarChart ariaLabel="Tasks completed per day over the last 30 days" height={190} format={(v) => num(v, 0)} color="var(--s3)" data={t.daily.map((d) => ({ key: d.date, label: dayShort(d.date), value: d.completed, note: `${dayShort(d.date)}: ${d.completed} completed, ${d.created} created` }))} />
              </Panel>
              <Panel title="Objectives" meta="progress against target">
                {objectives.length === 0 ? <Empty title="No objectives set" /> : (
                  <HBars maxValue={1} data={objectives.map((o) => ({ label: o.title, value: o.progress, display: `${Math.round(o.progress * 100)}%`, color: o.status === 'achieved' ? 'var(--up)' : o.pace === 'behind' || o.pace === 'overdue' ? 'var(--warn)' : 'var(--s1)' }))} />
                )}
                {active.some((o) => o.pace === 'behind' || o.pace === 'overdue') && <ChartNote>Amber bars are behind the even pace needed to reach the target by its date.</ChartNote>}
              </Panel>
            </div>
            {f.totalRuns > 0 && (
              <Panel title="Training volume and pace" meta="by week, last 12 weeks">
                <div className="grid cols-2">
                  <LineChart ariaLabel="Weekly distance trend" height={190} zeroBased format={(v) => num(v, 0)} series={[{ name: 'Distance, km per week', color: 'var(--s1)', points: f.weekly.map((w) => ({ t: w.weekStart, v: w.distanceKm })), area: true }]} />
                  {f.weekly.filter((w) => w.paceSPerKm).length > 1 ? (
                    <LineChart ariaLabel="Average weekly pace trend" height={190} format={(v) => pace(v)} series={[{ name: 'Average pace, min per km', color: 'var(--s3)', points: f.weekly.filter((w) => w.paceSPerKm).map((w) => ({ t: w.weekStart, v: w.paceSPerKm! })) }]} />
                  ) : <Empty title="Pace trend needs runs in two different weeks" />}
                </div>
                <ChartNote>Each chart has its own scale. Lower pace values are faster.</ChartNote>
              </Panel>
            )}
          </div>
        );
      }}
    </Load>
  );
}

const TABS = [{ id: 'today', label: 'Today' }, { id: 'training', label: 'Training' }, { id: 'objectives', label: 'Objectives' }, { id: 'analytics', label: 'Analytics' }];

export default function Personal() {
  const [params, setParams] = useSearchParams();
  const tab = TABS.some((t) => t.id === params.get('tab')) ? params.get('tab')! : 'today';
  return (
    <div className="reveal">
      <div className="tabs" role="tablist">
        {TABS.map((t) => <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setParams(t.id === 'today' ? {} : { tab: t.id })}>{t.label}</button>)}
      </div>
      {tab === 'today' && <Today />}
      {tab === 'training' && <Training />}
      {tab === 'objectives' && <Objectives />}
      {tab === 'analytics' && <Analytics />}
    </div>
  );
}
