const nf = (min: number, max: number) => new Intl.NumberFormat('en-GB', { minimumFractionDigits: min, maximumFractionDigits: max });
const NF = { 0: nf(0, 0), 1: nf(1, 1), 2: nf(2, 2), 4: nf(4, 4) } as const;

export const DASH = '–';

export function num(n: number | null | undefined, dp: 0 | 1 | 2 | 4 = 2): string {
  return n == null || !Number.isFinite(n) ? DASH : NF[dp].format(n);
}

/** Prices: more decimals for small values such as FX rates. */
export function price(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return DASH;
  return Math.abs(n) < 10 ? NF[4].format(n) : NF[2].format(n);
}

export function signed(n: number | null | undefined, dp: 0 | 1 | 2 = 2, suffix = ''): string {
  if (n == null || !Number.isFinite(n)) return DASH;
  return `${n > 0 ? '+' : n < 0 ? '−' : ''}${NF[dp].format(Math.abs(n))}${suffix}`;
}

export const pct = (n: number | null | undefined, dp: 0 | 1 | 2 = 2) => signed(n, dp, '%');
/** Fraction (0.123) to "12.3%". */
export const share = (n: number | null | undefined, dp: 0 | 1 | 2 = 1) => (n == null || !Number.isFinite(n) ? DASH : `${NF[dp].format(n * 100)}%`);

export function money(n: number | null | undefined, opts: { compact?: boolean; sign?: boolean; currency?: string } = {}): string {
  if (n == null || !Number.isFinite(n)) return DASH;
  const a = Math.abs(n);
  const sym = opts.currency ?? '$';
  const body = opts.compact
    ? a >= 1e12 ? `${NF[2].format(a / 1e12)}T` : a >= 1e9 ? `${NF[2].format(a / 1e9)}B` : a >= 1e6 ? `${NF[1].format(a / 1e6)}M` : a >= 1e4 ? `${NF[1].format(a / 1e3)}K` : NF[0].format(a)
    : NF[2].format(a);
  const s = n < 0 ? '−' : opts.sign && n > 0 ? '+' : '';
  return `${s}${sym}${body}`;
}

export const tone = (n: number | null | undefined) => (n == null || n === 0 ? 'flat' : n > 0 ? 'up' : 'down');

export function pace(sPerKm: number | null | undefined): string {
  if (sPerKm == null || !Number.isFinite(sPerKm)) return DASH;
  const total = Math.round(sPerKm);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

export function duration(s: number | null | undefined): string {
  if (s == null) return DASH;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.round(s % 60);
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

/** "mm:ss" or "h:mm:ss" to seconds; null when malformed. */
export function parseDuration(input: string): number | null {
  const parts = input.trim().split(':').map((p) => p.trim());
  if (parts.length < 2 || parts.length > 3 || parts.some((p) => !/^\d+$/.test(p))) return null;
  const n = parts.map(Number);
  if (n.slice(1).some((x) => x >= 60)) return null;
  const s = n.length === 3 ? n[0]! * 3600 + n[1]! * 60 + n[2]! : n[0]! * 60 + n[1]!;
  return s > 0 ? s : null;
}

export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'never';
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}

const DT = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const D = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const DS = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const T = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' });
export const dateTime = (iso: string) => DT.format(new Date(iso));
export const timeOnly = (iso: string) => T.format(new Date(iso));
/** Calendar date (YYYY-MM-DD) rendered without timezone shifting. */
export const day = (d: string) => D.format(new Date(`${d.slice(0, 10)}T00:00:00Z`));
export const dayShort = (d: string) => DS.format(new Date(`${d.slice(0, 10)}T00:00:00Z`));

export function dueLabel(daysLeft: number): string {
  if (daysLeft < 0) return `${-daysLeft}d overdue`;
  if (daysLeft === 0) return 'Today';
  if (daysLeft === 1) return 'Tomorrow';
  return `In ${daysLeft} days`;
}
