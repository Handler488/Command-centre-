import { geoEqualEarth, geoGraticule10, geoPath } from 'd3-geo';
import { scaleLog } from 'd3-scale';
import { select } from 'd3-selection';
import 'd3-transition';
import { zoom, zoomIdentity, type ZoomBehavior } from 'd3-zoom';
import { useEffect, useMemo, useRef, useState } from 'react';
import { feature } from 'topojson-client';
import type { FeatureCollection, Geometry } from 'geojson';
import world from 'world-atlas/countries-110m.json';
import type { MapCountry } from '../lib/api.ts';
import { Icon } from '../ui/kit.tsx';

const W = 960;
const H = 470;
const land = feature(world as never, (world as never as { objects: { countries: never } }).objects.countries) as unknown as FeatureCollection<Geometry, { name: string }>;
const projection = geoEqualEarth().fitExtent([[8, 8], [W - 8, H - 8]], { type: 'Sphere' });
const path = geoPath(projection);
const SHAPES = land.features.filter((f) => f.properties.name !== 'Antarctica').map((f) => ({ id: String(f.id ?? ''), name: f.properties.name, d: path(f) ?? '' }));
const GRATICULE = path(geoGraticule10()) ?? '';
const SPHERE = path({ type: 'Sphere' }) ?? '';
const RAMP = ['#1c4a85', '#1f5fb0', '#2a78d6', '#5598e7', '#86b6ef', '#cde2fb'];

/**
 * Coverage map. Fill encodes article volume (single-hue ramp, log scale);
 * amber rings mark countries whose lead story scores 60+ for significance.
 */
export function WorldMap(props: { data: MapCountry[]; selected?: string | null; onSelect?: (iso3: string | null) => void; compact?: boolean }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const gRef = useRef<SVGGElement>(null);
  const zoomRef = useRef<ZoomBehavior<SVGSVGElement, unknown>>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [k, setK] = useState(1);
  const [tip, setTip] = useState<{ x: number; y: number; c: MapCountry } | null>(null);

  const byNumeric = useMemo(() => new Map(props.data.map((c) => [c.numeric, c])), [props.data]);
  const top = Math.max(2, ...props.data.map((c) => c.articles));
  const color = useMemo(() => scaleLog<number>().domain([1, top]).range([0, RAMP.length - 1]).clamp(true), [top]);
  const fill = (n: number) => RAMP[Math.round(color(n))]!;
  const points = useMemo(() => props.data.map((c) => ({ c, xy: projection([c.lon, c.lat]) })).filter((p): p is { c: MapCountry; xy: [number, number] } => p.xy !== null), [props.data]);

  useEffect(() => {
    if (!svgRef.current) return;
    const z = zoom<SVGSVGElement, unknown>()
      .scaleExtent([1, 8])
      .translateExtent([[0, 0], [W, H]])
      .on('zoom', (e) => {
        gRef.current?.setAttribute('transform', e.transform.toString());
        setK(e.transform.k);
        setTip(null);
      });
    zoomRef.current = z;
    select(svgRef.current).call(z).on('dblclick.zoom', null);
    return () => {
      if (svgRef.current) select(svgRef.current).on('.zoom', null);
    };
  }, []);

  const zoomBy = (factor: number) => svgRef.current && zoomRef.current && select(svgRef.current).transition().duration(220).call(zoomRef.current.scaleBy, factor);
  const reset = () => svgRef.current && zoomRef.current && select(svgRef.current).transition().duration(260).call(zoomRef.current.transform, zoomIdentity);
  const showTip = (e: React.PointerEvent, c: MapCountry) => {
    const rect = wrapRef.current!.getBoundingClientRect();
    setTip({ x: e.clientX - rect.left, y: e.clientY - rect.top, c });
  };

  return (
    <div className="map-wrap" ref={wrapRef}>
      <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`World map of news coverage. ${props.data.length} countries have coverage in this window.`}>
        <g ref={gRef}>
          <path d={SPHERE} fill="#0c1520" />
          <path d={GRATICULE} className="map-grat" />
          {SHAPES.map((s, i) => {
            const c = byNumeric.get(s.id);
            return (
              <path
                key={`${s.id}-${i}`}
                d={s.d}
                className={`map-land ${c ? 'has-data' : ''} ${c && props.selected === c.iso3 ? 'selected' : ''}`}
                fill={c ? fill(c.articles) : '#1f2d3d'}
                onPointerMove={c ? (e) => showTip(e, c) : undefined}
                onPointerLeave={c ? () => setTip(null) : undefined}
                onClick={c && props.onSelect ? () => props.onSelect!(props.selected === c.iso3 ? null : c.iso3) : undefined}
              />
            );
          })}
          {points.map(({ c, xy }) => {
            const hot = (c.topStory?.score ?? 0) >= 60;
            const r = (hot ? 4.5 : 3) / Math.sqrt(k);
            return (
              <g key={c.iso3} transform={`translate(${xy[0]},${xy[1]})`} style={{ pointerEvents: 'none' }}>
                {hot && <circle r={r * 1.9} className="map-pulse" />}
                <circle r={r} fill={hot ? 'var(--amber)' : '#dfe7ee'} stroke="#0b1118" strokeWidth={1.2 / Math.sqrt(k)} opacity={hot ? 1 : 0.75} />
              </g>
            );
          })}
        </g>
      </svg>
      <div className="map-tools">
        <button className="btn icon" onClick={() => zoomBy(1.6)} aria-label="Zoom in">{Icon.plus}</button>
        <button className="btn icon" onClick={() => zoomBy(1 / 1.6)} aria-label="Zoom out">{Icon.minus}</button>
        {k > 1.01 && <button className="btn icon" onClick={reset} aria-label="Reset map view">{Icon.situation}</button>}
      </div>
      {!props.compact && (
        <div className="map-legend">
          <span>Fewer</span><i /><span>More articles</span>
          <span className="row" style={{ gap: 5, marginLeft: 8 }}><span className="dot" style={{ background: 'var(--amber)' }} />Significance 60+</span>
        </div>
      )}
      {tip && (
        <div className="tip wrap" style={{ left: Math.min(tip.x + 14, (wrapRef.current?.clientWidth ?? 600) - 270), top: Math.max(6, tip.y - 12) }}>
          <b>{tip.c.name}</b>
          <div className="muted">{tip.c.articles} article{tip.c.articles === 1 ? '' : 's'} from {tip.c.sources} source{tip.c.sources === 1 ? '' : 's'}</div>
          {tip.c.topStory && <div style={{ marginTop: 5 }}>{tip.c.topStory.headline}</div>}
        </div>
      )}
    </div>
  );
}
