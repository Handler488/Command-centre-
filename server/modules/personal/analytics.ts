import { XMLParser } from 'fast-xml-parser';

export interface Run {
  id: number;
  runOn: string;
  distanceKm: number;
  durationS: number;
  kind: string;
  avgHr: number | null;
  elevationM: number | null;
  notes: string;
  origin: string;
}

const DAY = 86_400_000;
const toDate = (d: string) => new Date(`${d}T00:00:00Z`);
const iso = (d: Date) => d.toISOString().slice(0, 10);

/** Monday of the ISO week containing the date. */
export function weekStart(date: string): string {
  const d = toDate(date);
  const dow = (d.getUTCDay() + 6) % 7;
  return iso(new Date(d.getTime() - dow * DAY));
}

export const addDays = (date: string, n: number) => iso(new Date(toDate(date).getTime() + n * DAY));
export const daysBetween = (a: string, b: string) => Math.round((toDate(b).getTime() - toDate(a).getTime()) / DAY);

export function runAnalytics(runs: Run[], today: string, weeks = 12) {
  const thisWeek = weekStart(today);
  const buckets = Array.from({ length: weeks }, (_, i) => {
    const start = addDays(thisWeek, -7 * (weeks - 1 - i));
    return { weekStart: start, distanceKm: 0, durationS: 0, runs: 0 };
  });
  const byWeek = new Map(buckets.map((b) => [b.weekStart, b]));
  for (const r of runs) {
    const b = byWeek.get(weekStart(r.runOn));
    if (!b) continue;
    b.distanceKm += r.distanceKm;
    b.durationS += r.durationS;
    b.runs += 1;
  }
  const sumKm = (from: string, to: string) => runs.filter((r) => r.runOn >= from && r.runOn <= to).reduce((a, r) => a + r.distanceKm, 0);
  const last7 = sumKm(addDays(today, -6), today);
  const last28 = sumKm(addDays(today, -27), today);
  const year = today.slice(0, 4);
  const ytd = runs.filter((r) => r.runOn.startsWith(year));
  const pace = (r: Run) => r.durationS / r.distanceKm;
  const bestPaceOver = (minKm: number) => {
    const eligible = runs.filter((r) => r.distanceKm >= minKm);
    if (!eligible.length) return null;
    const best = eligible.reduce((a, r) => (pace(r) < pace(a) ? r : a));
    return { paceSPerKm: pace(best), runOn: best.runOn, distanceKm: best.distanceKm };
  };
  // Consecutive weeks (ending this or last week) with at least one run.
  let streak = 0;
  for (let i = buckets.length - 1; i >= 0; i--) {
    const b = buckets[i]!;
    if (b.runs > 0) streak++;
    else if (i === buckets.length - 1) continue; // current week may not have started
    else break;
  }
  const longest = runs.length ? runs.reduce((a, r) => (r.distanceKm > a.distanceKm ? r : a)) : null;
  const completed = buckets.slice(0, -1).slice(-4);
  return {
    weekly: buckets.map((b) => ({ ...b, distanceKm: Math.round(b.distanceKm * 100) / 100, paceSPerKm: b.distanceKm > 0 ? b.durationS / b.distanceKm : null })),
    thisWeekKm: byWeek.get(thisWeek)?.distanceKm ?? 0,
    lastWeekKm: byWeek.get(addDays(thisWeek, -7))?.distanceKm ?? 0,
    fourWeekAvgKm: completed.length ? completed.reduce((a, b) => a + b.distanceKm, 0) / completed.length : 0,
    last7Km: last7,
    last28Km: last28,
    /** Acute (7d) over chronic (28d weekly average) distance; ~0.8-1.3 is the commonly cited steady range. */
    loadRatio: last28 > 0 ? last7 / (last28 / 4) : null,
    yearToDate: { distanceKm: ytd.reduce((a, r) => a + r.distanceKm, 0), runs: ytd.length, durationS: ytd.reduce((a, r) => a + r.durationS, 0) },
    weekStreak: streak,
    longestRun: longest ? { distanceKm: longest.distanceKm, runOn: longest.runOn } : null,
    bestPace: { over5k: bestPaceOver(5), over10k: bestPaceOver(10), overHalf: bestPaceOver(21.0975) },
    paceSeries: [...runs].sort((a, b) => a.runOn.localeCompare(b.runOn)).slice(-40).map((r) => ({ runOn: r.runOn, paceSPerKm: pace(r), distanceKm: r.distanceKm, kind: r.kind })),
    totalRuns: runs.length,
  };
}

export interface ObjectiveRow {
  id: number;
  startValue: number;
  targetValue: number;
  currentValue: number;
  dueOn: string | null;
  createdAt: string;
  status: string;
}

/** Progress toward target (0..1) and whether it is keeping pace with the calendar. */
export function objectiveProgress(o: ObjectiveRow, today: string) {
  const span = o.targetValue - o.startValue;
  const progress = span === 0 ? (o.currentValue >= o.targetValue ? 1 : 0) : Math.min(1, Math.max(0, (o.currentValue - o.startValue) / span));
  let expected: number | null = null;
  let pace: 'achieved' | 'ahead' | 'on-track' | 'behind' | 'overdue' | 'no-deadline' = 'no-deadline';
  if (progress >= 1 || o.status === 'achieved') pace = 'achieved';
  else if (o.dueOn) {
    const start = o.createdAt.slice(0, 10);
    const total = Math.max(1, daysBetween(start, o.dueOn));
    expected = Math.min(1, Math.max(0, daysBetween(start, today) / total));
    if (today > o.dueOn) pace = 'overdue';
    else if (progress >= expected + 0.1) pace = 'ahead';
    else if (progress >= expected - 0.1) pace = 'on-track';
    else pace = 'behind';
  }
  return { progress, expected, pace, daysLeft: o.dueOn ? daysBetween(today, o.dueOn) : null };
}

export interface TaskRow {
  dueOn: string | null;
  doneAt: string | null;
  createdAt: string;
}

export function taskAnalytics(tasks: TaskRow[], today: string, days = 30) {
  const from = addDays(today, -(days - 1));
  const daily = Array.from({ length: days }, (_, i) => ({ date: addDays(from, i), completed: 0, created: 0 }));
  const byDay = new Map(daily.map((d) => [d.date, d]));
  let onTime = 0;
  let late = 0;
  for (const t of tasks) {
    const created = byDay.get(t.createdAt.slice(0, 10));
    if (created) created.created++;
    if (!t.doneAt) continue;
    const doneDay = t.doneAt.slice(0, 10);
    const d = byDay.get(doneDay);
    if (d) d.completed++;
    if (t.dueOn && doneDay >= from) {
      if (doneDay <= t.dueOn) onTime++;
      else late++;
    }
  }
  const open = tasks.filter((t) => !t.doneAt);
  const completedInWindow = daily.reduce((a, d) => a + d.completed, 0);
  return {
    days,
    daily,
    completed: completedInWindow,
    created: daily.reduce((a, d) => a + d.created, 0),
    open: open.length,
    overdue: open.filter((t) => t.dueOn && t.dueOn < today).length,
    dueToday: open.filter((t) => t.dueOn === today).length,
    /** Share of completed tasks with a due date that were finished on or before it. Null when none had due dates. */
    onTimeRate: onTime + late > 0 ? onTime / (onTime + late) : null,
    last7Completed: daily.slice(-7).reduce((a, d) => a + d.completed, 0),
    prev7Completed: daily.slice(-14, -7).reduce((a, d) => a + d.completed, 0),
  };
}

// ---- GPX import ---------------------------------------------------------------

const R = 6371.0088;
const rad = (d: number) => (d * Math.PI) / 180;
export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** Summarise a GPX track: distance, elapsed time, elevation gain and average HR if recorded. */
export function parseGpx(xml: string) {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', removeNSPrefix: true });
  let doc: any;
  try {
    doc = parser.parse(xml);
  } catch {
    throw new Error('File is not valid XML');
  }
  const arr = <T>(v: T | T[] | undefined): T[] => (v == null ? [] : Array.isArray(v) ? v : [v]);
  const points = arr(doc?.gpx?.trk).flatMap((trk: any) => arr(trk?.trkseg).flatMap((seg: any) => arr(seg?.trkpt)));
  if (!doc?.gpx) throw new Error('File is not a GPX document');
  if (points.length < 2) throw new Error('GPX file has no track with at least two points');
  let distance = 0;
  let gain = 0;
  const hrs: number[] = [];
  let prev: { lat: number; lon: number; ele: number | null } | null = null;
  for (const p of points as any[]) {
    const lat = Number(p['@_lat']);
    const lon = Number(p['@_lon']);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const ele = p.ele !== undefined && Number.isFinite(Number(p.ele)) ? Number(p.ele) : null;
    if (prev) {
      distance += haversineKm(prev.lat, prev.lon, lat, lon);
      if (ele !== null && prev.ele !== null && ele > prev.ele) gain += ele - prev.ele;
    }
    const hr = Number(p?.extensions?.TrackPointExtension?.hr ?? p?.extensions?.hr);
    if (Number.isFinite(hr) && hr > 0) hrs.push(hr);
    prev = { lat, lon, ele };
  }
  const first = new Date((points[0] as any).time);
  const last = new Date((points[points.length - 1] as any).time);
  if (Number.isNaN(first.getTime()) || Number.isNaN(last.getTime())) throw new Error('GPX track has no timestamps, so duration cannot be derived');
  const durationS = Math.round((last.getTime() - first.getTime()) / 1000);
  if (durationS <= 0 || distance <= 0) throw new Error('GPX track has zero distance or duration');
  return {
    runOn: first.toISOString().slice(0, 10),
    distanceKm: Math.round(distance * 1000) / 1000,
    durationS,
    elevationM: Math.round(gain),
    avgHr: hrs.length ? Math.round(hrs.reduce((a, b) => a + b, 0) / hrs.length) : null,
    name: typeof arr(doc.gpx.trk)[0]?.name === 'string' ? (arr(doc.gpx.trk)[0] as any).name : '',
  };
}
