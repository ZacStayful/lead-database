/**
 * The Lead Brief's fixed numbers (docs/build/, A3 and A8).
 *
 * Import-free on purpose: the questionnaire (Phase 3) is a client component
 * and needs the travel options and plan caps, and nothing here may drag the
 * supply loader or supabase-js into the browser bundle (the featureRequest.ts
 * rule, CLAUDE.md §21.8).
 *
 * ⚠️ PLAN_MAX_MILES, TRAVEL_LIMIT_OPTIONS and the plan list are also written
 * into the CHECKs on customer_lead_briefs (0162). A guard test asserts the two
 * agree, so changing one without the other fails the build rather than a
 * customer's brief insert.
 */

/** The two Management plans a brief is computed for: leads a month. */
export const BRIEF_PLANS = [10, 20] as const;
export type BriefPlan = (typeof BRIEF_PLANS)[number];

export function isBriefPlan(v: unknown): v is BriefPlan {
  return v === 10 || v === 20;
}

/**
 * A3: the furthest a service area may reach, by plan. The cap a brief actually
 * uses is the smaller of this and the customer's own travel limit.
 */
export const PLAN_MAX_MILES: Record<BriefPlan, number> = {
  10: 40,
  20: 75,
};

/** A8 Q2: the travel distances offered. Null means "anywhere". */
export const TRAVEL_LIMIT_OPTIONS = [10, 25, 50] as const;
export type TravelLimit = (typeof TRAVEL_LIMIT_OPTIONS)[number] | null;

export function isTravelLimit(v: unknown): v is TravelLimit {
  return v === null || v === 10 || v === 25 || v === 50;
}

export type OperatingMode = "local" | "growing" | "anywhere";

/** A8: derived, never asked. 10 → local, 25 or 50 → growing, anywhere → anywhere. */
export function operatingModeFor(travel: TravelLimit): OperatingMode {
  if (travel === null) return "anywhere";
  return travel <= 10 ? "local" : "growing";
}

/** A3: the smaller of the travel limit and the plan maximum. */
export function capMilesFor(plan: BriefPlan, travel: TravelLimit): number {
  const planMax = PLAN_MAX_MILES[plan];
  return travel === null ? planMax : Math.min(travel, planMax);
}

/**
 * The service area must be able to deliver the allocation with this much to
 * spare (the build prompt's "× a 1.3 buffer"), measured at the forecast's own
 * confidence (FORECAST_CONFIDENCE in filterForecast.ts).
 */
export const SUPPLY_BUFFER = 1.3;

export function supplyTargetFor(plan: BriefPlan): number {
  return Math.ceil(plan * SUPPLY_BUFFER);
}

/**
 * The radii the service area widens through, in miles, before the cap.
 *
 * Its own list rather than RADIUS_MILE_OPTIONS from the filter page: the brief
 * ladder has to stop at a cap (25, 40, 75) that is not on that list, and the
 * filter page's options are free to change for reasons of their own.
 */
export const RADIUS_STEPS_MILES = [10, 20, 30, 40, 50, 60, 70] as const;

/** The ladder for one cap: every step below it, then the cap itself. */
export function radiusLadder(capMiles: number): number[] {
  const steps: number[] = RADIUS_STEPS_MILES.filter((m) => m < capMiles);
  steps.push(capMiles);
  return steps;
}

/** A similar area is only compared once it has at least this many leads. */
export const MIN_SIMILAR_AREA_LEADS = 5;

/** How many similar areas the preview offers. */
export const MAX_SIMILAR_AREAS = 5;

/** A6: at most this many trade-offs. */
export const MAX_TRADEOFFS = 3;

/**
 * The highest bedroom minimum a customer can set, as an essential or as a
 * priority threshold. Also the CHECK on customer_lead_briefs.min_bedrooms
 * (0162); a guard test keeps the two equal.
 */
export const MAX_MIN_BEDROOMS = 5;

/**
 * Below this many values in the service area, a "typical for your area"
 * threshold falls back to the national figure (the MIN_RELIABLE_MATCHES idea
 * from filterPrediction.ts, at the same size).
 */
export const MIN_TYPICAL_SAMPLE = 5;

/** The default location threshold: half the service radius, never under 5 miles. */
export const MIN_LOCATION_THRESHOLD_MILES = 5;

/** How many first-pick outcodes the client preview names (nearest first). */
export const PREVIEW_FIRST_PICKS = 10;
