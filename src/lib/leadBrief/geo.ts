import { haversineKm } from "@/lib/areaCentroids";
import { OUTCODE_CENTROIDS } from "@/lib/outcodes";

/**
 * Outcode geography for the Lead Brief: which outcode a postcode belongs to,
 * and how far every outcode is from a base.
 *
 * Distances are centroid to centroid (OUTCODE_CENTROIDS, 2,856 outcodes, ~110m
 * precision). An outcode with no centroid — M50 is a real one — has no
 * distance, so it is never inside a computed area; a lead there is simply not
 * reachable by distance, which is the safe direction.
 */

/**
 * ⚠️ THE SAME PATTERN AS leads.outcode (0161), character for character, and a
 * test reads the migration to keep it that way. The engine derives a lead's
 * outcode from its postcode rather than selecting the generated column, so it
 * does not depend on 0161 being applied, and the two must never disagree about
 * which outcode a lead is in.
 */
export const OUTCODE_PATTERN_SOURCE = "^([A-Z]{1,2}[0-9][A-Z0-9]?) ?[0-9][A-Z]{2}$";
const OUTCODE_PATTERN = new RegExp(OUTCODE_PATTERN_SOURCE);

/**
 * JS mirror of `substring(upper(btrim(postcode)) from <pattern>)`.
 * ⚠️ btrim with no argument strips SPACES only, not tabs or newlines, so this
 * does the same rather than calling String.trim().
 */
export function outcodeOfPostcode(postcode: string | null | undefined): string | null {
  if (postcode == null) return null;
  const m = OUTCODE_PATTERN.exec(postcode.replace(/^ +| +$/g, "").toUpperCase());
  return m ? m[1] : null;
}

/** The postcode area of an outcode: its leading letters ("YO10" → "YO"). */
export function areaOfOutcode(outcode: string): string {
  const m = /^[A-Z]{1,2}/.exec(outcode.toUpperCase());
  return m ? m[0] : outcode.toUpperCase();
}

/** Same value as MILES_TO_KM in components/filtering/format.ts; a test pins it. */
export const KM_PER_MILE = 1.60934;

export function hasCentroid(outcode: string): boolean {
  return OUTCODE_CENTROIDS[outcode.toUpperCase()] !== undefined;
}

export function milesBetween(a: string, b: string): number | null {
  const ca = OUTCODE_CENTROIDS[a.toUpperCase()];
  const cb = OUTCODE_CENTROIDS[b.toUpperCase()];
  if (!ca || !cb) return null;
  return haversineKm(ca, cb) / KM_PER_MILE;
}

/**
 * Distance in miles from `base` to every outcode with a centroid, nearest
 * first (ties by outcode, so the order is stable). Null when the base has no
 * centroid. Computed once per preview and reused by every step.
 */
export function distancesFrom(base: string): Map<string, number> | null {
  const centre = OUTCODE_CENTROIDS[base.toUpperCase()];
  if (!centre) return null;
  const rows: [string, number][] = [];
  for (const [outcode, c] of Object.entries(OUTCODE_CENTROIDS)) {
    rows.push([outcode, haversineKm(centre, c) / KM_PER_MILE]);
  }
  rows.sort((x, y) => x[1] - y[1] || (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
  return new Map(rows);
}

/** Outcodes within `miles` of the base, nearest first. */
export function outcodesWithin(distances: Map<string, number>, miles: number): string[] {
  const out: string[] = [];
  for (const [outcode, d] of Array.from(distances)) {
    if (d > miles) break;
    out.push(outcode);
  }
  return out;
}
