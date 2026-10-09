/**
 * Shared types for the Lead Brief engine. Import-free (see plans.ts).
 */

export type PriorityKey = "location" | "revenue" | "bedrooms" | "occupancy";
export const PRIORITY_KEYS: readonly PriorityKey[] = [
  "location",
  "revenue",
  "bedrooms",
  "occupancy",
];

/** A8 essentials: up to two, each with a threshold. */
export type EssentialKey = "bedrooms" | "revenue";

/**
 * One entry in the ranked priorities, as stored in
 * customer_lead_briefs.priorities (0162). `threshold` is in the priority's own
 * unit: miles for location, pounds for revenue, bedrooms, and percent (63, not
 * 0.63) for occupancy. Null when it could not be resolved, in which case the
 * priority is not judged at all.
 */
export interface BriefPriority {
  key: PriorityKey;
  threshold: number | null;
}

export type MatchLabel = "top_match" | "strong_match" | "first_pick" | "nearby_opportunity";
export const MATCH_LABELS: readonly MatchLabel[] = [
  "top_match",
  "strong_match",
  "first_pick",
  "nearby_opportunity",
];

export type CompetitionTier = "high" | "medium" | "low";

/**
 * One lead of supply, as the engine sees it. SERVER-SIDE ONLY: a list of these
 * is a map of where leads come from, which A4 and locked decision 9 forbid
 * sending to a client.
 */
export interface SupplyLead {
  /** Syntactic outcode of the postcode (0161's rule), or null. */
  outcode: string | null;
  /** Postcode area (uppercase), or null. */
  area: string | null;
  /** First run of digits in `bedrooms` (the SQL parser's rule), or null. */
  bedrooms: number | null;
  /** Projected gross annual revenue in POUNDS (§25), or null. */
  gross: number | null;
  /** Average nightly rate in pounds (§25), or null. */
  nightly: number | null;
  /** Occupancy as printed: 63, not 0.63 (§25), or null. */
  occupancy: number | null;
}

/** Another customer's active brief, as far as first picks and contention need it. */
export interface OtherBrief {
  customerId: string;
  /** Their base outcode first, then their priority outcodes. */
  areaOutcodes: string[];
  /**
   * How far from their nearest area their first picks reach: their travel
   * limit, or null for "anywhere" (nationwide).
   */
  reachMiles: number | null;
  serviceOutcodes: string[];
  firstPickOutcodes: string[];
  /** ISO date; their first picks are theirs until then. Null means unlocked. */
  lockedUntil: string | null;
}

/**
 * Filtered legacy customers competing for a lead, by postcode area and gross
 * band — the structure `fetchAreaContention` returns (filterPrediction.ts),
 * restated as a type so the pure modules need not import that file's runtime.
 */
export interface BriefContention {
  byBand: Record<string, Partial<Record<string, number>>>;
  everywhereByBand: Partial<Record<string, number>>;
  maxPerLead: number;
}

/**
 * Everything the engine reads about the world. Built server-side by
 * `loadBriefSupply` (supply.ts) and passed into the pure functions, so they
 * can be tested with fixtures and never fetch anything themselves.
 */
export interface BriefSupply {
  /** The observation window in weeks (≥ 1). */
  weeks: number;
  leads: SupplyLead[];
  contention: BriefContention | null;
  /**
   * Postcode areas named by an active legacy filter. A bedroom-only filter
   * (no areas) names none: like an unfiltered customer it covers everywhere,
   * and the approved rule (C7) leaves those out of first-pick checks.
   */
  filteredAreas: string[];
  otherBriefs: OtherBrief[];
  /**
   * Admin-set competition tiers, keyed "outcode:YO10" or "postcode_area:YO".
   * ⚠️ ADMIN ROWS ONLY (D5, C9). A contention-derived tier is a coarse count
   * of our own subscribers and is never shown to a customer.
   */
  competition: Record<string, CompetitionTier>;
}
