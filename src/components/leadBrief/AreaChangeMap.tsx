"use client";

/**
 * The confirm screen's map (batch 04 Phase 3): the old coverage area outlined,
 * the new one shaded, around the customer's base. Inline SVG over the
 * postcode-area boundaries, no map library and no tiles, like LeadSourceMap.
 *
 * ⚠️ IT IS GIVEN A POINT AND TWO RADII, NOTHING ELSE. The brief's outcode lists
 * stay on the server (A4), so the areas are drawn as circles around the base.
 * The engine's area is "every outcode within the radius of your areas", so a
 * circle is the honest picture of it; an extra area the customer added widens
 * it, which the text above the map says ("and your other areas").
 *
 * The boundary file is fetched only when this renders, which is only on this
 * screen. A failed fetch drops the backdrop and keeps the circles.
 */
import { useEffect, useMemo, useState } from "react";
import { AREA_CONFIRM_COPY } from "@/lib/leadBrief/areaConfirmCopy";

interface Feature {
  geometry: { type: "MultiPolygon"; coordinates: number[][][][] };
}

const W = 600;
const H = 600;
const PAD = 24;
/** Miles per degree of latitude. */
const MILES_PER_DEG_LAT = 69.05;
const NEW_FILL = "rgba(93, 129, 86, 0.28)";
const NEW_STROKE = "#5d8156";
const OLD_STROKE = "#2d4228";

export function AreaChangeMap({
  centre,
  newMiles,
  oldMiles,
}: {
  centre: { lat: number; lng: number };
  newMiles: number;
  oldMiles: number;
}) {
  const [features, setFeatures] = useState<Feature[] | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/data/uk-postcode-areas.geojson")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => alive && setFeatures(d.features as Feature[]))
      .catch(() => alive && setFeatures([]));
    return () => {
      alive = false;
    };
  }, []);

  // Fit the larger circle, with a margin, centred on the base.
  const cos = Math.cos((centre.lat * Math.PI) / 180);
  const spanMiles = Math.max(newMiles, oldMiles, 5) * 1.25;
  const k = (W / 2 - PAD) / (spanMiles / MILES_PER_DEG_LAT);
  const project = (lng: number, lat: number): [number, number] => [
    W / 2 + (lng - centre.lng) * cos * k,
    H / 2 - (lat - centre.lat) * k,
  ];
  const radiusPx = (miles: number) => (miles / MILES_PER_DEG_LAT) * k;

  const backdrop = useMemo(() => {
    if (!features) return "";
    let d = "";
    for (const f of features)
      for (const poly of f.geometry.coordinates)
        for (const ring of poly) {
          ring.forEach(([lng, lat], i) => {
            const [x, y] = project(lng, lat);
            d += (i === 0 ? "M" : "L") + x.toFixed(1) + " " + y.toFixed(1);
          });
          d += "Z";
        }
    return d;
    // project depends only on the props below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [features, centre.lat, centre.lng, newMiles, oldMiles]);

  return (
    <figure className="space-y-2">
      <div className="overflow-hidden rounded-md border-[0.5px] border-border bg-card">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="block h-auto max-h-[360px] w-full"
          role="img"
          aria-label={`${AREA_CONFIRM_COPY.mapLabel}: ${newMiles} miles shaded, ${oldMiles} miles outlined`}
        >
          {backdrop && <path d={backdrop} fill="#f4f5f1" stroke="#d6d9d2" strokeWidth={1} />}
          <circle cx={W / 2} cy={H / 2} r={radiusPx(newMiles)} fill={NEW_FILL} stroke={NEW_STROKE} strokeWidth={2} />
          <circle
            cx={W / 2}
            cy={H / 2}
            r={radiusPx(oldMiles)}
            fill="none"
            stroke={OLD_STROKE}
            strokeWidth={2}
            strokeDasharray="8 6"
          />
          <circle cx={W / 2} cy={H / 2} r={5} fill={OLD_STROKE} />
        </svg>
      </div>
      <figcaption className="flex flex-wrap gap-4 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-3 w-3 rounded-full border-2" style={{ borderColor: NEW_STROKE, background: NEW_FILL }} />
          {AREA_CONFIRM_COPY.mapKeyNew}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-3 w-3 rounded-full border-2 border-dashed" style={{ borderColor: OLD_STROKE }} />
          {AREA_CONFIRM_COPY.mapKeyOld}
        </span>
      </figcaption>
    </figure>
  );
}
