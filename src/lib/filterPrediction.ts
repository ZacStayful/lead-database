import type { SupabaseClient } from "@supabase/supabase-js";
import { cityForArea } from "@/lib/postcode";
import { distanceToNearestKm } from "@/lib/areaCentroids";
import type { LeadType } from "@/lib/types";

/**
 * Predicting a lead filter's monthly volume from real ingest history.
 *
 * When a customer narrows their leads by postcode area and bedroom range, the
 * volume guarantee lifts (see the filtering panel's consent copy). This module
 * quantifies what they are consenting TO: given the leads that have actually
 * arrived since ingest began, how many per month would have matched this
 * selection? The customer panel, its expansion suggestions, and both admin
 * surfaces all call the same functions here — one definition, the
 * `announcementTargetsCustomer()` discipline — so a customer and an admin
 * always see the same number for the same filter.
 *
 * The matching rules deliberately mirror `get_filtered_candidates_for_lead`
 * (migration 0026), including its silent exclusion: a lead with no parseable
 * postcode area OR no parseable bedroom count is invisible to EVERY filtered
 * customer, so such leads never enter `areaBedCounts` and are excluded from
 * every prediction by construction. `matchableLeads` vs `totalLeads` is how
 * the UI surfaces that honestly.
 *
 * Display only — nothing here is persisted and nothing gates routing. The
 * guarantee lifts on any filter regardless of what the prediction says.
 */

/** Day 1 of real ingest history. Verified: no leads.created_at precedes it. */
export const INGEST_EPOCH_ISO = "2026-07-01";

export const WEEKS_PER_MONTH = 4.33;

/** Below this many total matches the extrapolation is too thin to show as a number. */
export const MIN_RELIABLE_MATCHES = 5;

/** Per-product ingest history, restricted to what filtered routing can see. */
export interface ProductVolume {
  /** INGEST_EPOCH_ISO — kept on the object so the UI can name its basis. */
  windowStart: string;
  /** Server-computed at render time, floored at 1 so early weeks cannot blow up the rate. */
  weeksElapsed: number;
  /** ALL leads of this product since windowStart, unparseable ones included. */
  totalLeads: number;
  /** The subset with a non-null postcode area AND a parseable bedroom count. */
  matchableLeads: number;
  /** postcode area (uppercase) -> parsed bedroom count (string key) -> lead count. */
  areaBedCounts: Record<string, Record<string, number>>;
}

export type LeadVolumeAggregate = Record<LeadType, ProductVolume>;

export interface FilterSelection {
  /** Empty = anywhere, matching the SQL's null/empty-array rule. */
  areas: string[];
  minBedrooms: number | null;
  maxBedrooms: number | null;
}

export interface VolumePrediction {
  /** Raw matches since windowStart. */
  matchingLeads: number;
  /** matchingLeads / weeksElapsed * WEEKS_PER_MONTH, unrounded. */
  monthlyRate: number;
  /** Math.round(monthlyRate) — what the UI prints as "~N". */
  displayRate: number;
  /** matchingLeads >= MIN_RELIABLE_MATCHES. */
  reliable: boolean;
}

export interface ExpansionSuggestion {
  area: string;
  /** cityForArea(area), or the code itself when unknown. */
  city: string;
  /** Matches under the CURRENT bedroom range. */
  matchingLeads: number;
  /** Rounded leads/month the chip displays as "+~N/mo". */
  monthlyRate: number;
  /** Km to the nearest selected area; null when no centroid is known. */
  distanceKm: number | null;
}

/**
 * JS mirror of the SQL bedroom parser in `get_filtered_candidates_for_lead`:
 * `nullif(substring(coalesce(bedrooms, '') from '\d+'), '')::int` — the first
 * run of digits ("3 bed" -> 3, "2-3" -> 2), null when none ("studio").
 * The two must stay identical or the prediction diverges from routing.
 */
export function parseBedrooms(
  bedrooms: string | null | undefined
): number | null {
  const m = /\d+/.exec(bedrooms ?? "");
  return m ? parseInt(m[0], 10) : null;
}

/** Whole weeks-and-fraction since startIso, floored at 1. */
export function weeksElapsedSince(startIso: string, now: Date = new Date()): number {
  const start = new Date(`${startIso}T00:00:00Z`).getTime();
  const weeks = (now.getTime() - start) / (7 * 24 * 60 * 60 * 1000);
  return Math.max(weeks, 1);
}

/**
 * The one matching rule, mirroring `get_filtered_candidates_for_lead`:
 * empty areas = any location; a null bound = open on that side. Unparseable
 * leads are already absent from `areaBedCounts`, so they can never match.
 */
export function predictMonthlyVolume(
  volume: ProductVolume,
  sel: FilterSelection
): VolumePrediction {
  const wantedAreas =
    sel.areas.length > 0
      ? new Set(sel.areas.map((a) => a.toUpperCase()))
      : null;

  let matchingLeads = 0;
  for (const [area, beds] of Object.entries(volume.areaBedCounts)) {
    if (wantedAreas && !wantedAreas.has(area)) continue;
    for (const [bed, count] of Object.entries(beds)) {
      const b = Number(bed);
      if (sel.minBedrooms != null && b < sel.minBedrooms) continue;
      if (sel.maxBedrooms != null && b > sel.maxBedrooms) continue;
      matchingLeads += count;
    }
  }

  const monthlyRate =
    (matchingLeads / volume.weeksElapsed) * WEEKS_PER_MONTH;
  return {
    matchingLeads,
    monthlyRate,
    displayRate: Math.round(monthlyRate),
    reliable: matchingLeads >= MIN_RELIABLE_MATCHES,
  };
}

/**
 * True when the "too small for your plan" warning applies. Compared on the
 * ROUNDED figure so the displayed "~N" can never contradict the warning state
 * (a rate of 9.6 shown as "~10 of 10" must not carry a below-plan warning).
 */
export function belowAllocation(
  prediction: VolumePrediction,
  allocation: number
): boolean {
  return allocation > 0 && prediction.displayRate < allocation;
}

/**
 * Proximity-score tuning. The soften constant (km, roughly half a postcode
 * area's width) stops a next-door area with one lead from always outranking a
 * slightly farther area with real volume; the exponent makes distance decay
 * superlinear, so a hotspot 200km away cannot outrank a genuine neighbour —
 * checked against live data: a Canterbury (CT) operator is offered Tunbridge
 * Wells, not Nottingham.
 */
const DISTANCE_SOFTEN_KM = 25;
const DISTANCE_EXPONENT = 1.5;

/**
 * Unselected areas the customer would plausibly expand INTO: close to the
 * areas they already selected, and carrying real volume under the CURRENT
 * bedroom range. Zero-volume areas are dropped; empty when no areas are
 * selected — the customer is already taking everything.
 *
 * Ranking blends the two things the suggestion is for — getting the customer
 * closer to their allocation, from somewhere that still looks like THEIR
 * patch — as `matchingLeads / (distanceKm + soften)^exponent`. A neighbouring
 * area with decent volume beats both a distant hotspot and an adjacent dead
 * zone; among near neighbours the richer one wins, because the point is
 * closing the gap. Areas with no known centroid (e.g. BT, absent from the
 * boundary file) rank after every area whose distance is known, by volume.
 */
export function expansionSuggestions(
  volume: ProductVolume,
  sel: FilterSelection,
  limit = 3
): ExpansionSuggestion[] {
  if (sel.areas.length === 0) return [];
  const selectedList = sel.areas.map((a) => a.toUpperCase());
  const selected = new Set(selectedList);

  const scored: Array<ExpansionSuggestion & { score: number | null }> = [];
  for (const area of Object.keys(volume.areaBedCounts)) {
    if (selected.has(area)) continue;
    const p = predictMonthlyVolume(volume, { ...sel, areas: [area] });
    if (p.matchingLeads === 0) continue;
    const distanceKm = distanceToNearestKm(area, selectedList);
    scored.push({
      area,
      city: cityForArea(area) || area,
      matchingLeads: p.matchingLeads,
      monthlyRate: p.displayRate,
      distanceKm,
      score:
        distanceKm === null
          ? null
          : p.matchingLeads /
            (distanceKm + DISTANCE_SOFTEN_KM) ** DISTANCE_EXPONENT,
    });
  }

  scored.sort((a, b) => {
    if (a.score !== null && b.score !== null) {
      return b.score - a.score || (a.distanceKm! - b.distanceKm!);
    }
    if (a.score !== null) return -1;
    if (b.score !== null) return 1;
    return b.matchingLeads - a.matchingLeads || a.area.localeCompare(b.area);
  });
  return scored
    .slice(0, limit)
    .map(({ score: _score, ...suggestion }) => suggestion);
}

/** Row shape both fetch paths produce (the filtering page's own loop, and fetchLeadVolumeAggregate). */
export interface LeadVolumeRow {
  postcode_area: string | null;
  bedrooms: string | null;
  lead_type: LeadType | string | null;
  created_at: string;
}

function emptyVolume(now: Date): ProductVolume {
  return {
    windowStart: INGEST_EPOCH_ISO,
    weeksElapsed: weeksElapsedSince(INGEST_EPOCH_ISO, now),
    totalLeads: 0,
    matchableLeads: 0,
    areaBedCounts: {},
  };
}

/**
 * Pure aggregate builder — rows in, aggregate out. Rows before the epoch are
 * dropped defensively: none exist today, but a future backfill of historical
 * leads must inflate neither the rate's numerator without its denominator.
 */
export function buildLeadVolumeAggregate(
  rows: LeadVolumeRow[],
  now: Date = new Date()
): LeadVolumeAggregate {
  const agg: LeadVolumeAggregate = {
    management: emptyVolume(now),
    guaranteed_rent: emptyVolume(now),
  };

  for (const row of rows) {
    const product: ProductVolume | undefined =
      row.lead_type === "guaranteed_rent"
        ? agg.guaranteed_rent
        : row.lead_type === "management"
          ? agg.management
          : undefined;
    if (!product) continue;
    if (!row.created_at || row.created_at.slice(0, 10) < INGEST_EPOCH_ISO) {
      continue;
    }

    product.totalLeads += 1;

    const area = row.postcode_area?.trim().toUpperCase();
    const bed = parseBedrooms(row.bedrooms);
    if (!area || bed == null) continue;

    product.matchableLeads += 1;
    const beds = (product.areaBedCounts[area] ??= {});
    beds[String(bed)] = (beds[String(bed)] ?? 0) + 1;
  }

  return agg;
}

/**
 * Fetch every lead's prediction-relevant columns (paginated — a single select
 * is capped at 1000 rows) and build the aggregate. The admin client is a
 * parameter so this module stays importable from client components.
 */
export async function fetchLeadVolumeAggregate(
  admin: SupabaseClient
): Promise<LeadVolumeAggregate> {
  const rows: LeadVolumeRow[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await admin
      .from("leads")
      .select("postcode_area, bedrooms, lead_type, created_at")
      .gte("created_at", INGEST_EPOCH_ISO)
      .range(from, from + PAGE - 1);
    if (error || !data || data.length === 0) break;
    rows.push(...(data as LeadVolumeRow[]));
    if (data.length < PAGE) break;
  }
  return buildLeadVolumeAggregate(rows);
}
