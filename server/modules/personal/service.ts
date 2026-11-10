import { type DB, nowIso } from '../../db.ts';
import { notFound } from '../../lib/errors.ts';
import { daysBetween, objectiveProgress, parseGpx, type Run, runAnalytics, taskAnalytics } from './analytics.ts';

type Row = Record<string, unknown>;
const str = (v: unknown) => (v == null ? null : String(v));

export class PersonalService {
  constructor(private db: DB) {}

  private must(res: { changes: number | bigint }, what: string) {
    if (Number(res.changes) === 0) throw notFound(what);
  }

  // ---- runs ------------------------------------------------------------------

  private runRow = (r: Row): Run => ({
    id: Number(r.id),
    runOn: String(r.run_on),
    distanceKm: Number(r.distance_km),
    durationS: Number(r.duration_s),
    kind: String(r.kind),
    avgHr: r.avg_hr == null ? null : Number(r.avg_hr),
    elevationM: r.elevation_m == null ? null : Number(r.elevation_m),
    notes: String(r.notes),
    origin: String(r.origin),
  });

  runs(): Run[] {
    return this.db.prepare('SELECT * FROM runs ORDER BY run_on DESC, id DESC').all().map(this.runRow);
  }

  addRun(i: { runOn: string; distanceKm: number; durationS: number; kind?: string; avgHr?: number | null; elevationM?: number | null; notes?: string; origin?: string }) {
    const res = this.db
      .prepare('INSERT INTO runs (run_on, distance_km, duration_s, kind, avg_hr, elevation_m, notes, origin, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(i.runOn, i.distanceKm, i.durationS, i.kind ?? 'easy', i.avgHr ?? null, i.elevationM ?? null, i.notes ?? '', i.origin ?? 'manual', nowIso());
    return { id: Number(res.lastInsertRowid) };
  }

  importGpx(xml: string) {
    const g = parseGpx(xml);
    const { id } = this.addRun({ runOn: g.runOn, distanceKm: g.distanceKm, durationS: g.durationS, elevationM: g.elevationM, avgHr: g.avgHr, notes: g.name, origin: 'gpx' });
    return { id, ...g };
  }

  deleteRun(id: number) {
    this.must(this.db.prepare('DELETE FROM runs WHERE id = ?').run(id), 'Run');
  }

  fitness(today: string) {
    return runAnalytics(this.runs(), today);
  }

  // ---- objectives --------------------------------------------------------------

  objectives(today: string) {
    const logs = this.db.prepare('SELECT * FROM objective_logs ORDER BY logged_at').all();
    return this.db
      .prepare("SELECT * FROM objectives ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, due_on IS NULL, due_on, id")
      .all()
      .map((r) => {
        const o = {
          id: Number(r.id),
          title: String(r.title),
          description: String(r.description),
          category: String(r.category),
          unit: String(r.unit),
          startValue: Number(r.start_value),
          targetValue: Number(r.target_value),
          currentValue: Number(r.current_value),
          dueOn: str(r.due_on),
          status: String(r.status),
          createdAt: String(r.created_at),
        };
        return {
          ...o,
          ...objectiveProgress(o, today),
          history: [
            { at: o.createdAt, value: o.startValue, note: 'Start' },
            ...logs.filter((l) => Number(l.objective_id) === o.id).map((l) => ({ at: String(l.logged_at), value: Number(l.value), note: String(l.note) })),
          ],
        };
      });
  }

  addObjective(i: { title: string; description?: string; category?: string; unit?: string; startValue?: number; targetValue: number; dueOn?: string | null }) {
    const start = i.startValue ?? 0;
    const res = this.db
      .prepare('INSERT INTO objectives (title, description, category, unit, start_value, target_value, current_value, due_on, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(i.title, i.description ?? '', i.category ?? 'general', i.unit ?? '', start, i.targetValue, start, i.dueOn ?? null, nowIso());
    return { id: Number(res.lastInsertRowid) };
  }

  /** Record a new measured value; marks the objective achieved when it reaches target. */
  logObjective(id: number, value: number, note = '') {
    const o = this.db.prepare('SELECT start_value, target_value FROM objectives WHERE id = ?').get(id);
    if (!o) throw notFound('Objective');
    const start = Number(o.start_value);
    const target = Number(o.target_value);
    const reached = target >= start ? value >= target : value <= target;
    this.db.prepare('INSERT INTO objective_logs (objective_id, value, note, logged_at) VALUES (?, ?, ?, ?)').run(id, value, note, nowIso());
    this.db.prepare("UPDATE objectives SET current_value = ?, status = CASE WHEN ? THEN 'achieved' WHEN status = 'achieved' THEN 'active' ELSE status END WHERE id = ?").run(value, reached ? 1 : 0, id);
  }

  setObjectiveStatus(id: number, status: 'active' | 'achieved' | 'dropped') {
    this.must(this.db.prepare('UPDATE objectives SET status = ? WHERE id = ?').run(status, id), 'Objective');
  }

  deleteObjective(id: number) {
    this.must(this.db.prepare('DELETE FROM objectives WHERE id = ?').run(id), 'Objective');
  }

  // ---- tasks -------------------------------------------------------------------

  tasks() {
    return this.db
      .prepare('SELECT * FROM tasks ORDER BY done_at IS NOT NULL, due_on IS NULL, due_on, priority, id DESC')
      .all()
      .map((r) => ({
        id: Number(r.id),
        title: String(r.title),
        notes: String(r.notes),
        dueOn: str(r.due_on),
        priority: Number(r.priority),
        doneAt: str(r.done_at),
        createdAt: String(r.created_at),
      }));
  }

  addTask(i: { title: string; notes?: string; dueOn?: string | null; priority?: number }) {
    const res = this.db
      .prepare('INSERT INTO tasks (title, notes, due_on, priority, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(i.title, i.notes ?? '', i.dueOn ?? null, i.priority ?? 2, nowIso());
    return { id: Number(res.lastInsertRowid) };
  }

  updateTask(id: number, patch: { title?: string; notes?: string; dueOn?: string | null; priority?: number; done?: boolean }) {
    const cur = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
    if (!cur) throw notFound('Task');
    const doneAt = patch.done === undefined ? cur.done_at : patch.done ? (cur.done_at ?? nowIso()) : null;
    this.db
      .prepare('UPDATE tasks SET title = ?, notes = ?, due_on = ?, priority = ?, done_at = ? WHERE id = ?')
      .run(patch.title ?? String(cur.title), patch.notes ?? String(cur.notes), patch.dueOn === undefined ? str(cur.due_on) : patch.dueOn, patch.priority ?? Number(cur.priority), str(doneAt), id);
  }

  deleteTask(id: number) {
    this.must(this.db.prepare('DELETE FROM tasks WHERE id = ?').run(id), 'Task');
  }

  // ---- deadlines ---------------------------------------------------------------

  deadlines() {
    return this.db.prepare('SELECT * FROM deadlines ORDER BY done_at IS NOT NULL, due_on').all().map((r) => ({
      id: Number(r.id),
      title: String(r.title),
      dueOn: String(r.due_on),
      category: String(r.category),
      notes: String(r.notes),
      doneAt: str(r.done_at),
    }));
  }

  addDeadline(i: { title: string; dueOn: string; category?: string; notes?: string }) {
    const res = this.db.prepare('INSERT INTO deadlines (title, due_on, category, notes, created_at) VALUES (?, ?, ?, ?, ?)').run(i.title, i.dueOn, i.category ?? 'general', i.notes ?? '', nowIso());
    return { id: Number(res.lastInsertRowid) };
  }

  setDeadlineDone(id: number, done: boolean) {
    this.must(this.db.prepare('UPDATE deadlines SET done_at = ? WHERE id = ?').run(done ? nowIso() : null, id), 'Deadline');
  }

  deleteDeadline(id: number) {
    this.must(this.db.prepare('DELETE FROM deadlines WHERE id = ?').run(id), 'Deadline');
  }

  /** Everything with a date attached, soonest first: deadlines, dated tasks and objective due dates. */
  upcoming(today: string, horizonDays = 60) {
    const items = [
      ...this.deadlines().filter((d) => !d.doneAt).map((d) => ({ type: 'deadline' as const, id: d.id, title: d.title, dueOn: d.dueOn, detail: d.category })),
      ...this.tasks().filter((t) => !t.doneAt && t.dueOn).map((t) => ({ type: 'task' as const, id: t.id, title: t.title, dueOn: t.dueOn!, detail: `Priority ${t.priority}` })),
      ...this.objectives(today).filter((o) => o.status === 'active' && o.dueOn).map((o) => ({ type: 'objective' as const, id: o.id, title: o.title, dueOn: o.dueOn!, detail: `${Math.round(o.progress * 100)}% complete` })),
    ];
    return items
      .map((i) => ({ ...i, daysLeft: daysBetween(today, i.dueOn) }))
      .filter((i) => i.daysLeft <= horizonDays)
      .sort((a, b) => a.dueOn.localeCompare(b.dueOn));
  }

  performance(today: string) {
    return {
      today,
      fitness: this.fitness(today),
      tasks: taskAnalytics(this.tasks(), today),
      objectives: this.objectives(today),
      upcoming: this.upcoming(today),
    };
  }
}
