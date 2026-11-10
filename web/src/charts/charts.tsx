import { extent, max, min } from 'd3-array';
import { scaleBand, scaleLinear } from 'd3-scale';
import { area, curveMonotoneX, line } from 'd3-shape';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import type { Candle } from '../lib/api.ts';
import { dayShort, num, price as fmtPrice, timeOnly } from '../lib/format.ts';

/** Track an element's width so SVG charts can lay out in real pixels. */
export function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.floor(entry!.contentRect.width)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

const isDay = (t: string) => t.length === 10;
const label = (t: string) => (isDay(t) ? dayShort(t) : timeOnly(t));

export interface Series {
  name: string;
  color: string;
  points: { t: string; v: number }[];
  dashed?: boolean;
  area?: boolean;
}

/**
 * Time-series line chart on a shared categorical time axis (no weekend gaps),
 * with crosshair and a tooltip listing every series at the hovered point.
 */
export function LineChart(props: { series: Series[]; height?: number; format?: (v: number) => string; yLabel?: string; zeroBased?: boolean; legend?: boolean; ariaLabel: string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const height = props.height ?? 220;
  const fmt = props.format ?? ((v: number) => num(v, 2));
  const m = { t: 10, r: 12, b: 22, l: 46 };
  const xs = useMemo(() => [...new Set(props.series.flatMap((s) => s.points.map((p) => p.t)))].sort(), [props.series]);
  const index = useMemo(() => new Map(xs.map((t, i) => [t, i])), [xs]);
  const all = props.series.flatMap((s) => s.points.map((p) => p.v));
  if (all.length === 0) return <div ref={ref} className="chart" style={{ height }} />;
  let [lo, hi] = extent(all) as [number, number];
  if (props.zeroBased) lo = Math.min(0, lo);
  if (lo === hi) { lo -= 1; hi += 1; }
  const pad = (hi - lo) * 0.08;
  // Round the domain outward to tick values so no gridline or label falls outside the plot.
  const y = scaleLinear().domain([props.zeroBased ? lo : lo - pad, hi + pad]).nice(4).range([height - m.b, m.t]);
  const x = scaleLinear().domain([0, Math.max(1, xs.length - 1)]).range([m.l, Math.max(m.l + 1, width - m.r)]);
  const ticks = y.ticks(4);
  const xTickCount = Math.max(2, Math.min(7, Math.floor(width / 90)));
  const xTicks = xs.length <= xTickCount ? xs.map((_, i) => i) : Array.from({ length: xTickCount }, (_, i) => Math.round((i * (xs.length - 1)) / (xTickCount - 1)));
  const path = line<{ t: string; v: number }>().x((p) => x(index.get(p.t)!)).y((p) => y(p.v)).curve(curveMonotoneX);
  const fill = area<{ t: string; v: number }>().x((p) => x(index.get(p.t)!)).y0(y(y.domain()[0]!)).y1((p) => y(p.v)).curve(curveMonotoneX);
  const hoverT = hover !== null ? xs[hover] : undefined;

  return (
    <div className="chart" ref={ref}>
      {props.legend !== false && props.series.length > 1 && (
        <div className="legend" style={{ marginBottom: 6 }}>
          {props.series.map((s) => (
            <span key={s.name}>
              <i className={s.dashed ? 'dash' : ''} style={{ background: s.color, color: s.color }} />
              {s.name}
            </span>
          ))}
        </div>
      )}
      {width > 0 && (
        <svg
          height={height}
          role="img"
          aria-label={props.ariaLabel}
          onPointerMove={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            setHover(Math.max(0, Math.min(xs.length - 1, Math.round(x.invert(e.clientX - rect.left)))));
          }}
          onPointerLeave={() => setHover(null)}
        >
          {ticks.map((t) => (
            <g key={t}>
              <line className="gridline" x1={m.l} x2={width - m.r} y1={y(t)} y2={y(t)} />
              <text x={m.l - 8} y={y(t)} dy="0.32em" textAnchor="end">{fmt(t)}</text>
            </g>
          ))}
          {xTicks.map((i, k) => (
            <text key={i} x={x(i)} y={height - 5} textAnchor={k === 0 ? 'start' : k === xTicks.length - 1 ? 'end' : 'middle'}>{label(xs[i]!)}</text>
          ))}
          {props.series.map((s) => s.area && s.points.length > 1 && <path key={`a-${s.name}`} d={fill(s.points) ?? ''} fill={s.color} opacity={0.1} />)}
          {props.series.map((s) =>
            s.points.length === 1 ? (
              <circle key={s.name} cx={x(index.get(s.points[0]!.t)!)} cy={y(s.points[0]!.v)} r={4} fill={s.color} />
            ) : (
              <path key={s.name} d={path(s.points) ?? ''} fill="none" stroke={s.color} strokeWidth={2} strokeDasharray={s.dashed ? '5 4' : undefined} strokeLinejoin="round" strokeLinecap="round" />
            ),
          )}
          {hover !== null && hoverT && (
            <g>
              <line className="cross" x1={x(hover)} x2={x(hover)} y1={m.t} y2={height - m.b} />
              {props.series.map((s) => {
                const p = s.points.find((q) => q.t === hoverT);
                return p ? <circle key={s.name} cx={x(hover)} cy={y(p.v)} r={4} fill={s.color} stroke="var(--hull)" strokeWidth={2} /> : null;
              })}
            </g>
          )}
        </svg>
      )}
      {hover !== null && hoverT && (
        <div className="tip" style={{ left: Math.min(Math.max(8, x(hover) + 12), Math.max(8, width - 170)), top: 4 }}>
          <b>{isDay(hoverT) ? dayShort(hoverT) : `${dayShort(hoverT.slice(0, 10))} ${timeOnly(hoverT)}`}</b>
          {props.series.map((s) => {
            const p = s.points.find((q) => q.t === hoverT);
            return (
              <div className="tip-row" key={s.name}>
                <span className="swatch" style={{ background: s.color }} />
                <span className="muted">{s.name}</span>
                <b style={{ marginLeft: 'auto', paddingLeft: 10 }}>{p ? fmt(p.v) : '–'}</b>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function sma(values: number[], window: number): (number | null)[] {
  let sum = 0;
  return values.map((v, i) => {
    sum += v;
    if (i >= window) sum -= values[i - window]!;
    return i >= window - 1 ? sum / window : null;
  });
}

/** Price chart: line or candlesticks, optional moving averages, and a separate volume pane. */
export function PriceChart(props: { candles: Candle[]; mode: 'line' | 'candles'; smas: number[]; height?: number; currency?: string | null }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const c = props.candles;
  const H = props.height ?? 340;
  const volH = c.some((d) => d.v) ? 54 : 0;
  const m = { t: 10, r: 56, b: 22, l: 8 };
  const plotH = H - volH - m.b - m.t;
  const closes = useMemo(() => c.map((d) => d.c), [c]);
  const averages = useMemo(() => props.smas.map((w) => ({ w, values: sma(closes, w) })), [closes, props.smas]);
  if (c.length === 0) return <div ref={ref} className="chart" style={{ height: H }} />;

  const lo = props.mode === 'candles' ? min(c, (d) => d.l)! : min(closes)!;
  const hi = props.mode === 'candles' ? max(c, (d) => d.h)! : max(closes)!;
  const pad = (hi - lo || 1) * 0.07;
  const y = scaleLinear().domain([lo - pad, hi + pad]).nice(5).range([m.t + plotH, m.t]);
  const band = scaleBand<number>().domain(c.map((_, i) => i)).range([m.l, Math.max(m.l + 1, width - m.r)]).paddingInner(0.3);
  const cx = (i: number) => band(i)! + band.bandwidth() / 2;
  const vy = scaleLinear().domain([0, max(c, (d) => d.v ?? 0) || 1]).range([H - m.b, H - m.b - volH + 6]);
  const ticks = y.ticks(5);
  const xTickCount = Math.max(2, Math.min(8, Math.floor(width / 100)));
  const xTicks = Array.from({ length: xTickCount }, (_, i) => Math.round((i * (c.length - 1)) / (xTickCount - 1)));
  const up = closes.at(-1)! >= closes[0]!;
  const lineColor = up ? 'var(--up)' : 'var(--down)';
  const pathFor = (vals: (number | null)[]) => line<number | null>().defined((v) => v !== null).x((_, i) => cx(i)).y((v) => y(v!))(vals) ?? '';
  const SMA_COLORS = ['var(--s1)', 'var(--s2)'];
  const h = hover !== null ? c[hover] : null;
  const last = c.at(-1)!;

  return (
    <div className="chart" ref={ref}>
      {width > 0 && (
        <svg
          height={H}
          role="img"
          aria-label={`Price chart, ${c.length} bars from ${label(c[0]!.t)} to ${label(last.t)}`}
          onPointerMove={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const step = band.step();
            setHover(Math.max(0, Math.min(c.length - 1, Math.floor((e.clientX - rect.left - m.l) / step))));
          }}
          onPointerLeave={() => setHover(null)}
        >
          {ticks.map((t) => (
            <g key={t}>
              <line className="gridline" x1={m.l} x2={width - m.r} y1={y(t)} y2={y(t)} />
              <text x={width - m.r + 8} y={y(t)} dy="0.32em">{fmtPrice(t)}</text>
            </g>
          ))}
          {xTicks.map((i, k) => (
            <text key={`${i}-${k}`} x={cx(i)} y={H - 5} textAnchor={k === 0 ? 'start' : k === xTicks.length - 1 ? 'end' : 'middle'}>{label(c[i]!.t)}</text>
          ))}
          {volH > 0 && c.map((d, i) => d.v ? <rect key={i} x={band(i)} width={Math.max(1, band.bandwidth())} y={vy(d.v)} height={H - m.b - vy(d.v)} fill="var(--ink-3)" opacity={hover === i ? 0.75 : 0.32} /> : null)}
          {props.mode === 'line' ? (
            <>
              <path d={(area<number>().x((_, i) => cx(i)).y0(m.t + plotH).y1((v) => y(v))(closes)) ?? ''} fill={lineColor} opacity={0.08} />
              <path d={pathFor(closes)} fill="none" stroke={lineColor} strokeWidth={2} strokeLinejoin="round" />
            </>
          ) : (
            c.map((d, i) => {
              const rise = d.c >= d.o;
              const color = rise ? 'var(--up)' : 'var(--down)';
              const top = y(Math.max(d.o, d.c));
              return (
                <g key={i}>
                  <line x1={cx(i)} x2={cx(i)} y1={y(d.h)} y2={y(d.l)} stroke={color} strokeWidth={1} />
                  <rect x={band(i)} width={Math.max(1, band.bandwidth())} y={top} height={Math.max(1, y(Math.min(d.o, d.c)) - top)} fill={color} />
                </g>
              );
            })
          )}
          {averages.map((a, k) => <path key={a.w} d={pathFor(a.values)} fill="none" stroke={SMA_COLORS[k]} strokeWidth={1.5} />)}
          {/* last-price marker on the axis */}
          <g transform={`translate(${width - m.r + 2}, ${y(last.c)})`}>
            <rect x={0} y={-9} width={m.r - 4} height={18} rx={2} fill={lineColor} />
            <text x={6} dy="0.32em" style={{ fill: '#0b1118', fontWeight: 650 }}>{fmtPrice(last.c)}</text>
          </g>
          {hover !== null && h && (
            <g>
              <line className="cross" x1={cx(hover)} x2={cx(hover)} y1={m.t} y2={H - m.b} />
              <line className="cross" x1={m.l} x2={width - m.r} y1={y(h.c)} y2={y(h.c)} />
              {props.mode === 'line' && <circle cx={cx(hover)} cy={y(h.c)} r={4} fill={lineColor} stroke="var(--hull)" strokeWidth={2} />}
            </g>
          )}
        </svg>
      )}
      {hover !== null && h && (
        <div className="tip" style={{ left: cx(hover) > width / 2 ? 8 : undefined, right: cx(hover) > width / 2 ? undefined : m.r + 8, top: 6 }}>
          <b>{isDay(h.t) ? dayShort(h.t) : `${dayShort(h.t.slice(0, 10))} ${timeOnly(h.t)}`}</b>
          <div className="tip-row"><span className="muted">Open</span><b style={{ marginLeft: 'auto', paddingLeft: 14 }}>{fmtPrice(h.o)}</b></div>
          <div className="tip-row"><span className="muted">High</span><b style={{ marginLeft: 'auto' }}>{fmtPrice(h.h)}</b></div>
          <div className="tip-row"><span className="muted">Low</span><b style={{ marginLeft: 'auto' }}>{fmtPrice(h.l)}</b></div>
          <div className="tip-row"><span className="muted">Close</span><b style={{ marginLeft: 'auto' }}>{fmtPrice(h.c)}</b></div>
          {h.v != null && <div className="tip-row"><span className="muted">Volume</span><b style={{ marginLeft: 'auto' }}>{num(h.v, 0)}</b></div>}
          {averages.map((a, k) => a.values[hover] != null && (
            <div className="tip-row" key={a.w}><span className="swatch" style={{ background: SMA_COLORS[k] }} /><span className="muted">SMA {a.w}</span><b style={{ marginLeft: 'auto' }}>{fmtPrice(a.values[hover])}</b></div>
          ))}
        </div>
      )}
      {averages.length > 0 && (
        <div className="legend" style={{ marginTop: 4 }}>
          {averages.map((a, k) => <span key={a.w}><i style={{ background: SMA_COLORS[k] }} />{a.w}-bar moving average</span>)}
        </div>
      )}
    </div>
  );
}

/** Vertical bar chart for a small number of periods. */
export function BarChart(props: { data: { key: string; label: string; value: number; note?: string }[]; height?: number; format?: (v: number) => string; color?: string; highlightLast?: boolean; reference?: { value: number; label: string }; ariaLabel: string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const H = props.height ?? 180;
  const fmt = props.format ?? ((v: number) => num(v, 1));
  const m = { t: 14, r: 8, b: 22, l: 38 };
  const top = Math.max(max(props.data, (d) => d.value) ?? 0, props.reference?.value ?? 0) || 1;
  const y = scaleLinear().domain([0, top]).nice(4).range([H - m.b, m.t]);
  const x = scaleBand<string>().domain(props.data.map((d) => d.key)).range([m.l, Math.max(m.l + 1, width - m.r)]).paddingInner(0.28).paddingOuter(0.1);
  const bw = Math.min(28, x.bandwidth());
  const every = Math.ceil(props.data.length / Math.max(1, Math.floor(width / 64)));
  const hd = hover !== null ? props.data[hover] : null;
  return (
    <div className="chart" ref={ref}>
      {width > 0 && (
        <svg height={H} role="img" aria-label={props.ariaLabel} onPointerLeave={() => setHover(null)}>
          {y.ticks(4).map((t) => (
            <g key={t}>
              <line className="gridline" x1={m.l} x2={width - m.r} y1={y(t)} y2={y(t)} />
              <text x={m.l - 8} y={y(t)} dy="0.32em" textAnchor="end">{fmt(t)}</text>
            </g>
          ))}
          {props.data.map((d, i) => {
            const bx = x(d.key)! + (x.bandwidth() - bw) / 2;
            const by = y(d.value);
            const h = H - m.b - by;
            const r = Math.min(3, h);
            const isLast = props.highlightLast && i === props.data.length - 1;
            return (
              <g key={d.key} onPointerEnter={() => setHover(i)}>
                <rect x={x(d.key)} width={x.bandwidth()} y={m.t} height={H - m.b - m.t} fill="transparent" />
                {h > 0 && <path d={`M${bx},${H - m.b}V${by + r}q0,${-r} ${r},${-r}h${bw - 2 * r}q${r},0 ${r},${r}V${H - m.b}Z`} fill={props.color ?? 'var(--s1)'} opacity={hover === null || hover === i ? (isLast ? 0.55 : 1) : 0.45} />}
                {i % every === 0 && <text x={x(d.key)! + x.bandwidth() / 2} y={H - 5} textAnchor="middle">{d.label}</text>}
              </g>
            );
          })}
          {props.reference && (
            <g>
              <line x1={m.l} x2={width - m.r} y1={y(props.reference.value)} y2={y(props.reference.value)} stroke="var(--ink-2)" strokeDasharray="4 4" />
              <text x={width - m.r} y={y(props.reference.value) - 6} textAnchor="end" style={{ fill: 'var(--ink)', paintOrder: 'stroke', stroke: 'var(--hull)', strokeWidth: 5, strokeLinejoin: 'round' }}>{props.reference.label}</text>
            </g>
          )}
        </svg>
      )}
      {hover !== null && hd && (
        <div className="tip" style={{ left: Math.min(Math.max(8, x(hd.key)! - 30), Math.max(8, width - 150)), top: 0 }}>
          <b>{hd.note ?? hd.label}</b>
          <div className="tip-row"><b>{fmt(hd.value)}</b></div>
        </div>
      )}
    </div>
  );
}

/** Horizontal labelled bars; values are printed, so colour is never the only channel. */
export function HBars(props: { data: { label: string; value: number; display: string; color?: string }[]; maxValue?: number }) {
  const top = props.maxValue ?? Math.max(...props.data.map((d) => Math.abs(d.value)), 1e-9);
  return (
    <div className="breakdown">
      {props.data.map((d) => (
        <div key={d.label} style={{ display: 'contents' }}>
          <span className="muted truncate">{d.label}</span>
          <div className="bar-track"><div className="bar-fill" style={{ width: `${Math.min(100, (Math.abs(d.value) / top) * 100)}%`, background: d.color ?? 'var(--s1)' }} /></div>
          <b className="right">{d.display}</b>
        </div>
      ))}
    </div>
  );
}

export function Sparkline(props: { values: number[]; width?: number; height?: number }) {
  const { values, width = 84, height = 24 } = props;
  if (values.length < 2) return <svg width={width} height={height} aria-hidden="true" />;
  const [lo, hi] = extent(values) as [number, number];
  const x = scaleLinear().domain([0, values.length - 1]).range([1, width - 1]);
  const y = scaleLinear().domain(lo === hi ? [lo - 1, hi + 1] : [lo, hi]).range([height - 2, 2]);
  const color = values.at(-1)! >= values[0]! ? 'var(--up)' : 'var(--down)';
  return (
    <svg width={width} height={height} aria-hidden="true">
      <path d={line<number>().x((_, i) => x(i)).y((v) => y(v))(values) ?? ''} fill="none" stroke={color} strokeWidth={1.5} />
    </svg>
  );
}

/** Ring gauge for a 0-100 score, with the number printed in the centre. */
export function ScoreRing({ score, size = 44 }: { score: number; size?: number }) {
  const r = size / 2 - 3.5;
  const c = 2 * Math.PI * r;
  const color = score >= 60 ? 'var(--amber)' : score >= 40 ? 'var(--ink-2)' : 'var(--ink-3)';
  return (
    <div className="score" style={{ width: size, height: size, color: score >= 60 ? 'var(--amber)' : 'var(--ink)' }} title={`Significance ${score} of 100`}>
      <svg viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--hull-3)" strokeWidth={3} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={3} strokeDasharray={`${(score / 100) * c} ${c}`} strokeLinecap="round" />
      </svg>
      {score}
    </div>
  );
}

/** Diverging correlation matrix (-1 blue .. 0 neutral .. +1 red) with printed coefficients. */
export function CorrelationMatrix(props: { symbols: string[]; matrix: (number | null)[][] }) {
  const color = (v: number | null) => {
    if (v === null) return 'var(--hull-2)';
    const a = Math.min(1, Math.abs(v));
    const mix = Math.round(a * 78);
    return `color-mix(in oklab, ${v >= 0 ? '#e66767' : '#3987e5'} ${mix}%, #2b3643)`;
  };
  return (
    <div className="heat" style={{ gridTemplateColumns: `auto repeat(${props.symbols.length}, minmax(0, 1fr))` }} role="table" aria-label="Correlation of daily returns between holdings">
      <div className="hd" />
      {props.symbols.map((s) => <div key={s} className="hd truncate">{s}</div>)}
      {props.symbols.map((row, i) => (
        <div key={row} style={{ display: 'contents' }} role="row">
          <div className="hd" style={{ justifyItems: 'start' }}>{row}</div>
          {props.matrix[i]!.map((v, j) => (
            <div key={j} role="cell" style={{ background: color(v), color: '#fff', fontWeight: 550 }} title={`${row} vs ${props.symbols[j]}: ${v === null ? 'n/a' : v.toFixed(2)}`}>
              {v === null ? '–' : v.toFixed(2).replace('-', '−')}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

export function ChartNote({ children }: { children: ReactNode }) {
  return <p className="small faint" style={{ marginTop: 8 }}>{children}</p>;
}
