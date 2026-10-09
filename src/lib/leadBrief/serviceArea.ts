import { deliverableAtConfidence } from "@/lib/filterForecast";
import { areaOfOutcode, distancesFromNearest } from "@/lib/leadBrief/geo";
import {
  capMilesFor,
  radiusLadder,
  supplyTargetFor,
  type BriefPlan,
  type TravelLimit,
} from "@/lib/leadBrief/plans";

/**
 * The service area: the areas the customer picked, grown together until they
 * can deliver the plan with a 30% buffer at the forecast's own confidence.
 *
 * ⚠️ IT GROWS AROUND EVERY AREA THE CUSTOMER PICKS, NOT AROUND THE BASE ALONE.
 * The build prompt says "from base_outcode and priority outcodes", and the
 * customer is choosing the areas closest to them: someone who works YO10 and
 * LS6 gets the districts near either, at one shared distance, so the copy can
 * say "within X miles of your areas". The first cut grew a circle round the
 * base only and added each extra area as a single district, so a customer who
 * picked one area got one circle stretched until it covered the plan.
 *
 * Three things make up the area:
 *   - the CENTRES: the base, plus every priority outcode within the cap;
 *   - every outcode within the current radius of any centre;
 *   - every outcode of a similar area the customer ticked (D4: postcode areas).
 *
 * All of it stays within the A3 cap of the BASE — the smaller of the travel
 * limit and the plan maximum is how far from their base they will travel. A
 * priority outcode beyond the cap is left out and reported, never stretched to.
 *
 * Widen, never block (locked decision 3): when the cap is reached first the
 * area stops at the cap, `meetsTarget` is false, and the mix leans to Nearby.
 */
export interface ServiceArea {
  capMiles: number;
  radiusMiles: number;
  /** The base first, then nearest to any of the customer's areas first. */
  outcodes: string[];
  meetsTarget: boolean;
  /** The base plus the priority outcodes inside the cap: what the area grows around. */
  centres: string[];
  /** Priority outcodes left out because they lie beyond the cap. */
  priorityOutsideCap: string[];
  /**
   * SERVER-ONLY. The plan with its buffer, and what the area can deliver at
   * confidence (capped at the target). Forecast counts never reach a client (A4).
   */
  target: number;
  deliverable: number;
}

export function computeServiceArea(args: {
  plan: BriefPlan;
  travelLimitMiles: TravelLimit;
  baseOutcode: string;
  priorityOutcodes: string[];
  /** Postcode areas the customer ticked from the similar-area suggestions. */
  similarAreas: string[];
  /** Distances from the BASE (distancesFrom): what the A3 cap is measured on. */
  baseDistances: Map<string, number>;
  weightedSupply: Map<string, number>;
  weeks: number;
}): ServiceArea {
  const capMiles = capMilesFor(args.plan, args.travelLimitMiles);
  const target = supplyTargetFor(args.plan);
  const inCap = (oc: string) => {
    const d = args.baseDistances.get(oc);
    return d !== undefined && d <= capMiles;
  };

  const centres = [args.baseOutcode];
  const priorityOutsideCap: string[] = [];
  for (const oc of args.priorityOutcodes) {
    if (oc === args.baseOutcode || centres.includes(oc)) continue;
    if (inCap(oc)) centres.push(oc);
    else priorityOutsideCap.push(oc);
  }

  // Nearest to any centre first. The base and the other centres are all at
  // zero; the base is put first explicitly so the list always starts with it.
  const nearest = distancesFromNearest(centres) ?? new Map<string, number>();
  const ordered = Array.from(nearest).filter(([oc]) => oc !== args.baseOutcode && inCap(oc));

  const similar = new Set(args.similarAreas);
  const fromSimilar = similar.size === 0
    ? []
    : ordered.filter(([oc]) => similar.has(areaOfOutcode(oc))).map(([oc]) => oc);

  let radiusMiles = capMiles;
  let outcodes: string[] = [];
  let deliverable = 0;
  for (const r of radiusLadder(capMiles)) {
    const seen = new Set<string>([args.baseOutcode]);
    outcodes = [args.baseOutcode];
    for (const [oc, d] of ordered) {
      if (d > r) break;
      seen.add(oc);
      outcodes.push(oc);
    }
    for (const oc of fromSimilar) {
      if (!seen.has(oc)) {
        seen.add(oc);
        outcodes.push(oc);
      }
    }
    let m = 0;
    for (const oc of outcodes) m += args.weightedSupply.get(oc) ?? 0;
    deliverable = deliverableAtConfidence(m, args.weeks, target).expected;
    radiusMiles = r;
    if (deliverable >= target) break;
  }

  return {
    capMiles,
    radiusMiles,
    outcodes,
    meetsTarget: deliverable >= target,
    centres,
    priorityOutsideCap,
    target,
    deliverable,
  };
}
