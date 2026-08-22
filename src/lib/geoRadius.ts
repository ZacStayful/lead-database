import type { LatLng } from "@/lib/areaCentroids";

/**
 * Which postcode areas a radius search actually touches, computed against the
 * REAL area boundaries (public/data/uk-postcode-areas.geojson — the same file
 * the selection map draws), not centroids: a 10-mile circle near an area's
 * edge must include that neighbour even though its centroid is 40 miles off.
 *
 * Client-side geometry on ~120 multipolygons; a full pass is a few
 * milliseconds. Planar approximation with cos(lat) scaling — exact enough at
 * radius-search distances, and the alternative (true geodesic point-to-
 * segment) buys nothing a customer could see.
 */

/** The geojson feature shape the boundary file uses (as LeadSourceMap reads it). */
export interface AreaFeature {
  properties: { area: string };
  geometry: { type: "MultiPolygon"; coordinates: number[][][][] };
}

const KM_PER_DEG_LAT = 110.57;
const KM_PER_DEG_LNG_EQUATOR = 111.32;

/** Squared planar distance in km² from point p to segment a-b (km space). */
function segDist2(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t =
    len2 === 0
      ? 0
      : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  const cx = ax + t * dx - px;
  const cy = ay + t * dy - py;
  return cx * cx + cy * cy;
}

/**
 * Distance in km from `centre` to the boundary of `feature`, 0 when the
 * point lies inside any of its polygons.
 */
export function distanceToAreaKm(centre: LatLng, feature: AreaFeature): number {
  const [lat, lng] = centre;
  const kx = KM_PER_DEG_LNG_EQUATOR * Math.cos((lat * Math.PI) / 180);
  const px = lng * kx;
  const py = lat * KM_PER_DEG_LAT;

  let best2 = Infinity;
  for (const polygon of feature.geometry.coordinates) {
    // Ray-cast against the outer ring for containment. Holes are ignored:
    // a postcode-area "hole" is another postcode area, and a search centred
    // in it belongs to that other area, whose own polygon test catches it.
    const outer = polygon[0];
    let inside = false;
    for (let i = 0, j = outer.length - 1; i < outer.length; j = i++) {
      const [xi, yi] = outer[i];
      const [xj, yj] = outer[j];
      if (
        yi > lat !== yj > lat &&
        lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi
      ) {
        inside = !inside;
      }
    }
    if (inside) return 0;

    for (let i = 0, j = outer.length - 1; i < outer.length; j = i++) {
      const [lngA, latA] = outer[i];
      const [lngB, latB] = outer[j];
      const d2 = segDist2(
        px,
        py,
        lngA * kx,
        latA * KM_PER_DEG_LAT,
        lngB * kx,
        latB * KM_PER_DEG_LAT
      );
      if (d2 < best2) best2 = d2;
    }
  }
  return Math.sqrt(best2);
}

/**
 * Every area whose boundary lies within `radiusKm` of `centre`, uppercase,
 * sorted with the containing/closest area first.
 */
export function areasWithinRadius(
  features: AreaFeature[],
  centre: LatLng,
  radiusKm: number
): string[] {
  const hits: Array<{ area: string; d: number }> = [];
  for (const f of features) {
    const area = f.properties.area?.toUpperCase();
    if (!area) continue;
    const d = distanceToAreaKm(centre, f);
    if (d <= radiusKm) hits.push({ area, d });
  }
  hits.sort((a, b) => a.d - b.d || a.area.localeCompare(b.area));
  return hits.map((h) => h.area);
}
