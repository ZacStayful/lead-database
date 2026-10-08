import { areaOfOutcode, milesBetween, outcodesWithin } from "@/lib/leadBrief/geo";
import type { BriefSupply, CompetitionTier } from "@/lib/leadBrief/types";

/**
 * First-pick and behind-pace outcodes, and competition tiers.
 */

/**
 * First-pick areas: outcodes within the cap that no other customer is set up
 * to receive leads in, and where this customer is the nearest brief customer.
 *
 * An outcode is NOT a first pick when:
 *   - its postcode area is named by an active legacy filter (C7: unfiltered
 *     and bedroom-only customers cover everywhere, so they are left out of
 *     this test rather than ruling out every outcode in the country);
 *   - it is in another brief customer's service area;
 *   - another brief customer holds it as a first pick and their lock has not
 *     run out (first picks are locked per billing cycle);
 *   - another brief customer whose cap reaches it is nearer to it, or exactly
 *     as near — the customer who was there first keeps a tie.
 *
 * ⚠️ NEVER A CLAIM OF EXCLUSIVITY (locked decision 7). Other operators can
 * still receive these leads; "first pick" means this customer is closest.
 *
 * Nearest first.
 */
export function computeFirstPicks(args: {
  baseOutcode: string;
  capMiles: number;
  distances: Map<string, number>;
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
  for (const oc of outcodesWithin(args.distances, args.capMiles)) {
    if (filtered.has(areaOfOutcode(oc))) continue;
    if (othersService.has(oc) || othersLocked.has(oc)) continue;
    const own = args.distances.get(oc)!;
    const someoneNearer = args.supply.otherBriefs.some((b) => {
      const theirs = milesBetween(b.baseOutcode, oc);
      return theirs !== null && theirs <= b.capMiles && theirs <= own;
    });
    if (someoneNearer) continue;
    out.push(oc);
  }
  return out;
}

/**
 * A11: outcodes beyond the service area, out to the cap, nearest first — the
 * order routing offers them in while the customer is behind pace.
 *
 * The cap is the same A3 cap the service area uses (the smaller of the travel
 * limit and the plan maximum), so a behind-pace lead never comes from further
 * than the customer said they would travel. First picks are left out: routing
 * admits them anyway, so listing them twice would only blur the order.
 */
export function computePaceOutcodes(args: {
  capMiles: number;
  distances: Map<string, number>;
  serviceOutcodes: string[];
  firstPickOutcodes: string[];
}): string[] {
  const skip = new Set([...args.serviceOutcodes, ...args.firstPickOutcodes]);
  return outcodesWithin(args.distances, args.capMiles).filter((oc) => !skip.has(oc));
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
