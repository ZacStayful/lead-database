"use client";

/**
 * Interactive UK postcode-area choropleth of where leads come from, shaded by
 * lead volume. Self-contained inline SVG — no map library, no tiles — reading
 * the postcode-area boundaries from public/data/uk-postcode-areas.geojson.
 *
 * Used inside the lead-filtering panel: clicking an area toggles it in the
 * customer's filter selection, so they can see where volume actually is before
 * narrowing. Only areas that have leads are selectable (they line up with the
 * checklist); empty areas render grey.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { areaLabel } from "@/lib/postcode";

interface Feature {
  properties: { area: string };
  geometry: { type: "MultiPolygon"; coordinates: number[][][][] };
}

const NO_DATA_FILL = "#eef0ec";
const RAMP_LO = [225, 236, 216]; // pale sage
const RAMP_HI = [45, 66, 40]; // deep Stayful green
const TARGET_STROKE = "#5d8156"; // brand green outline for selected areas
const W = 760;
const H = 920;

function greenRamp(t: number): string {
  const c = Math.max(0, Math.min(1, t));
  const ch = (i: number) => Math.round(RAMP_LO[i] + (RAMP_HI[i] - RAMP_LO[i]) * c);
  return `rgb(${ch(0)}, ${ch(1)}, ${ch(2)})`;
}

// sqrt keeps the long tail of small areas visible next to a few big ones.
function intensity(count: number, max: number): number {
  if (count <= 0 || max <= 0) return 0;
  return Math.sqrt(count) / Math.sqrt(max);
}

export function LeadSourceMap({
  counts,
  maxCount,
  selectable,
  selected,
  onToggle,
}: {
  counts: Record<string, number>;
  maxCount: number;
  selectable: string[]; // area codes that have leads (clickable)
  selected: string[]; // currently selected filter areas
  onToggle: (area: string) => void;
}) {
  const [features, setFeatures] = useState<Feature[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [hover, setHover] = useState<string | null>(null);
  const [view, setView] = useState({ k: 1, x: 0, y: 0 });
  const drag = useRef<{ px: number; py: number; vx: number; vy: number } | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    fetch("/data/uk-postcode-areas.geojson")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => alive && setFeatures(d.features as Feature[]))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, []);

  const selectableSet = useMemo(
    () => new Set(selectable.map((s) => s.toUpperCase())),
    [selectable]
  );
  const selectedSet = useMemo(
    () => new Set(selected.map((s) => s.toUpperCase())),
    [selected]
  );

  const project = useMemo(() => {
    if (!features) return null;
    let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
    for (const f of features)
      for (const poly of f.geometry.coordinates)
        for (const ring of poly)
          for (const [lng, lat] of ring) {
            if (lng < minLng) minLng = lng;
            if (lng > maxLng) maxLng = lng;
            if (lat < minLat) minLat = lat;
            if (lat > maxLat) maxLat = lat;
          }
    const latMid = (minLat + maxLat) / 2;
    const cos = Math.cos((latMid * Math.PI) / 180);
    const spanX = (maxLng - minLng) * cos;
    const spanY = maxLat - minLat;
    const pad = 16;
    const k = Math.min((W - 2 * pad) / spanX, (H - 2 * pad) / spanY);
    const offX = (W - spanX * k) / 2;
    const offY = (H - spanY * k) / 2;
    return (lng: number, lat: number): [number, number] => [
      offX + (lng - minLng) * cos * k,
      offY + (maxLat - lat) * k,
    ];
  }, [features]);

  const paths = useMemo(() => {
    if (!features || !project) return [];
    return features.map((f) => {
      let d = "";
      for (const poly of f.geometry.coordinates)
        for (const ring of poly) {
          ring.forEach(([lng, lat], i) => {
            const [x, y] = project(lng, lat);
            d += (i === 0 ? "M" : "L") + x.toFixed(1) + " " + y.toFixed(1);
          });
          d += "Z";
        }
      return { area: f.properties.area.toUpperCase(), d };
    });
  }, [features, project]);

  function zoomBy(factor: number, cx = W / 2, cy = H / 2) {
    setView((v) => {
      const k = Math.min(12, Math.max(1, v.k * factor));
      const x = cx - ((cx - v.x) * k) / v.k;
      const y = cy - ((cy - v.y) * k) / v.k;
      return k === 1 ? { k: 1, x: 0, y: 0 } : { k, x, y };
    });
  }
  function onWheel(e: React.WheelEvent) {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect) return;
    const cx = ((e.clientX - rect.left) / rect.width) * W;
    const cy = ((e.clientY - rect.top) / rect.height) * H;
    zoomBy(e.deltaY < 0 ? 1.15 : 1 / 1.15, cx, cy);
  }
  function onPointerDown(e: React.PointerEvent) {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    drag.current = { px: e.clientX, py: e.clientY, vx: view.x, vy: view.y };
  }
  function onPointerMove(e: React.PointerEvent) {
    if (!drag.current || !wrapRef.current) return;
    const rect = wrapRef.current.getBoundingClientRect();
    const sx = W / rect.width;
    const sy = H / rect.height;
    setView((v) => ({
      ...v,
      x: drag.current!.vx + (e.clientX - drag.current!.px) * sx,
      y: drag.current!.vy + (e.clientY - drag.current!.py) * sy,
    }));
  }
  function onPointerUp() {
    drag.current = null;
  }

  function fillFor(code: string): string {
    const c = counts[code] ?? 0;
    if (c <= 0) return NO_DATA_FILL;
    return greenRamp(intensity(c, maxCount));
  }

  if (failed) {
    return (
      <div className="rounded-md border-[0.5px] border-dashed border-border p-6 text-center text-sm text-muted-foreground">
        Map unavailable — use the area list below.
      </div>
    );
  }

  return (
    <div className="relative overflow-hidden rounded-md border-[0.5px] border-border bg-card">
      <div
        ref={wrapRef}
        className="relative touch-none select-none"
        style={{ cursor: drag.current ? "grabbing" : "grab" }}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
      >
        {!features ? (
          <div className="py-24 text-center text-sm text-muted-foreground">
            Loading map…
          </div>
        ) : (
          <svg
            viewBox={`0 0 ${W} ${H}`}
            className="block h-auto max-h-[460px] w-full"
            role="img"
            aria-label="Map of the UK shaded by how many leads come from each postcode area"
          >
            <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
              {paths.map((p) => {
                const has = selectableSet.has(p.area);
                const isSel = selectedSet.has(p.area);
                const isHover = hover === p.area;
                return (
                  <path
                    key={p.area}
                    d={p.d}
                    fill={fillFor(p.area)}
                    stroke={isSel ? TARGET_STROKE : "#ffffff"}
                    strokeWidth={(isSel ? 2.4 : isHover ? 1.2 : 0.4) / view.k}
                    fillOpacity={(counts[p.area] ?? 0) > 0 ? (isHover || isSel ? 1 : 0.94) : 0.75}
                    style={{ cursor: has ? "pointer" : "default" }}
                    onMouseEnter={() => setHover(p.area)}
                    onMouseLeave={() => setHover((h) => (h === p.area ? null : h))}
                    onClick={() => has && onToggle(p.area)}
                  />
                );
              })}
            </g>
          </svg>
        )}

        {/* Zoom controls */}
        <div className="absolute right-3 top-3 flex flex-col gap-1.5">
          {[
            { label: "+", aria: "Zoom in", fn: () => zoomBy(1.4) },
            { label: "−", aria: "Zoom out", fn: () => zoomBy(1 / 1.4) },
            { label: "⟲", aria: "Reset", fn: () => setView({ k: 1, x: 0, y: 0 }) },
          ].map((b) => (
            <button
              key={b.aria}
              type="button"
              aria-label={b.aria}
              onClick={b.fn}
              className="flex h-7 w-7 items-center justify-center rounded-md border-[0.5px] border-border bg-background text-base leading-none text-foreground shadow-sm hover:bg-accent"
            >
              {b.label}
            </button>
          ))}
        </div>

        {/* Legend */}
        <div className="absolute bottom-3 left-3 rounded-md border-[0.5px] border-border bg-background/95 p-2 text-xs shadow-sm">
          <div className="mb-1 font-semibold text-foreground">Leads per area</div>
          <div
            className="h-2.5 w-32 rounded"
            style={{ background: `linear-gradient(90deg, ${greenRamp(0.08)}, ${greenRamp(1)})` }}
          />
          <div className="mt-0.5 flex justify-between text-muted-foreground">
            <span>Fewer</span>
            <span>{maxCount || 0}</span>
          </div>
        </div>

        {/* Hover tooltip */}
        {hover && (
          <div className="pointer-events-none absolute left-3 top-3 rounded-md border-[0.5px] border-border bg-background/95 px-2.5 py-1.5 text-xs shadow-sm">
            <span className="font-semibold text-foreground">{areaLabel(hover)}</span>{" "}
            <span className="text-muted-foreground">({hover})</span>
            <span className="ml-1.5 text-muted-foreground">
              · {counts[hover] ?? 0} lead{(counts[hover] ?? 0) === 1 ? "" : "s"}
              {selectableSet.has(hover) ? "" : " · not selectable"}
            </span>
          </div>
        )}
      </div>
      <p className="border-t-[0.5px] border-border px-3 py-1.5 text-xs text-muted-foreground">
        Click an area to add or remove it from your filter. Darker = more leads.
      </p>
    </div>
  );
}
