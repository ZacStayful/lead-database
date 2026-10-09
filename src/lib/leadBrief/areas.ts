import { areaOfOutcode, milesBetween, outcodesWithin } from "@/lib/leadBrief/geo";
import type { BriefSupply, CompetitionTier } from "@/lib/leadBrief/types";

/**
 * First-pick and behind-pace outcodes, and competition tiers.
 */

/**
 * First-pick areas: outcodes within the customer's travel limit of their
 * nearest area that no other customer is set up to receive leads in, and
 * where this customer is the nearest brief customer.
 *
 * Reach is the build prompt's "within travel_limit_miles of the customer",
 * measured from whichever of their areas is nearest. ⚠️ For "anywhere" there
 * is no limit: first picks are nationwide (Zac, 9 Oct). That departs from
 * A3's "anywhere still respects the plan cap", and because routing admits
 * first picks, an "anywhere" customer can receive a first-pick lead from
 * anywhere in the country. Recorded, not silent.
 *
 * An outcode is NOT a first pick when:
 *   - its postcode area is named by an active legacy filter (C7: unfiltered
 *     and bedroom-only customers cover everywhere, so they are left out of
 *     this test rather than ruling out every outcode in the country);
 *   - it is in another brief customer's service area;
 *   - another brief customer holds it as a first pick and their lock has not
 *     run out (first picks are locked per billing cycle);
 *   - another brief customer whose reach includes it is nearer to it (from
 *     their nearest area), or exactly as near — the customer who was there
 *     first keeps a tie.
 *
 * ⚠️ NEVER A CLAIM OF EXCLUSIVITY (locked decision 7). Other operators can
 * still receive these leads; "first pick" means this customer is closest.
 *
 * Nearest first.
 */
export function computeFirstPicks(args: {
  /** Miles from the customer's nearest area (distancesFromNearest). */
  nearestDistances: Map<string, number>;
  /** The travel limit, or null for "anywhere" (nationwide). */
  reachMiles: number | null;
  supply: Pick<BriefSupply, "filteredAreas" | "otherBriefs">;
  /** ISO date (YYYY-MM-DD); a lock running until today is still held. */
  today: string;
}): string[] {
  const filtered = new Set(args.supply.filteredAreas);
  const othersService = new Set<string>();
  const othersLocked = new Set<string>();
  for (const b of args.supply.otherBriefs) {
    for (const oc of b.serviceOutcodes) othersService.add(oc);
    if (b.lockedUntil !== null && b.lockedUntil >= args.today) {
      for (const oc of b.firstPickOutcodes) othersLocked.add(oc);
    }
  }

  const out: string[] = [];
  const within =
    args.reachMiles === null
      ? Array.from(args.nearestDistances.keys())
      : outcodesWithin(args.nearestDistances, args.reachMiles);
  for (const oc of within) {
    if (filtered.has(areaOfOutcode(oc))) continue;
    if (othersService.has(oc) || othersLocked.has(oc)) continue;
    const own = args.nearestDistances.get(oc)!;
    const someoneNearer = args.supply.otherBriefs.some((b) => {
      const theirs = nearestOf(b.areaOutcodes, oc);
      return theirs !== null && (b.reachMiles === null || theirs <= b.reachMiles) && theirs <= own;
    });
    if (someoneNearer) continue;
    out.push(oc);
  }
  return out;
}

/** Miles from `outcode` to the nearest of `areas`, or null when none can be placed. */
export function nearestOf(areas: string[], outcode: string): number | null {
  let best: number | null = null;
  for (const a of areas) {
    const d = milesBetween(a, outcode);
    if (d !== null && (best === null || d < best)) best = d;
  }
  return best;
}

/**
 * A11: outcodes beyond the service area, within the cap of the base, nearest
 * to the customer's areas first — the order routing offers them in while the
 * customer is behind pace.
 *
 * The cap is the same A3 cap the service area uses (the smaller of the travel
 * limit and the plan maximum, measured from the base), so a behind-pace lead
 * never comes from further than the customer said they would travel. First
 * picks are left out: routing admits them anyway, so listing them twice would
 * only blur the order.
 */
export function computePaceOutcodes(args: {
  capMiles: number;
  /** Miles from the base: what the cap is measured on. */
  baseDistances: Map<string, number>;
  /** Miles from the customer's nearest area: the order. */
  nearestDistances: Map<string, number>;
  serviceOutcodes: string[];
  firstPickOutcodes: string[];
}): string[] {
  const skip = new Set([...args.serviceOutcodes, ...args.firstPickOutcodes]);
  const out: string[] = [];
  for (const oc of Array.from(args.nearestDistances.keys())) {
    if (skip.has(oc)) continue;
    const d = args.baseDistances.get(oc);
    if (d !== undefined && d <= args.capMiles) out.push(oc);
  }
  return out;
}

/** The key area_competition rows are held under in BriefSupply.competition. */
export function competitionKey(kind: "outcode" | "postcode_area", code: string): string {
  return `${kind}:${code.toUpperCase()}`;
}

/** An outcode's tier, falling back to its postcode area's. Null when none is set. */
export function tierForOutcode(
  outcode: string,
  competition: Record<string, CompetitionTier>
): CompetitionTier | null {
  return (
    competition[competitionKey("outcode", outcode)] ??
    competition[competitionKey("postcode_area", areaOfOutcode(outcode))] ??
    null
  );
}

export function tierForArea(
  area: string,
  competition: Record<string, CompetitionTier>
): CompetitionTier | null {
  return competition[competitionKey("postcode_area", area)] ?? null;
}
