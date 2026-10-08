import { deliverableAtConfidence } from "@/lib/filterForecast";
import { outcodesWithin } from "@/lib/leadBrief/geo";
import {
  capMilesFor,
  radiusLadder,
  supplyTargetFor,
  type BriefPlan,
  type TravelLimit,
} from "@/lib/leadBrief/plans";

/**
 * The service area: the smallest radius around the base that can deliver the
 * plan with a 30% buffer, at the forecast's own confidence, capped at the
 * smaller of the travel limit and the plan maximum (A3).
 *
 * The area is a circle around the BASE, plus any priority outcodes inside the
 * cap. That keeps A5's copy true — "within X miles of YO10" — while an extra
 * area the customer named still counts as theirs. A priority outcode beyond
 * the cap is left out and reported, never silently stretched to.
 *
 * Widen, never block (locked decision 3): when the cap is reached first the
 * area stops at the cap, `meetsTarget` is false, and the mix leans to Nearby.
 */
export interface ServiceArea {
  capMiles: number;
  radiusMiles: number;
  /** Nearest first; the base is always first. Priority outcodes inside the cap follow. */
  outcodes: string[];
  meetsTarget: boolean;
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
  priorityOutcodes: string[];
  distances: Map<string, number>;
  weightedSupply: Map<string, number>;
  weeks: number;
}): ServiceArea {
  const capMiles = capMilesFor(args.plan, args.travelLimitMiles);
  const target = supplyTargetFor(args.plan);

  const priorityInCap: string[] = [];
  const priorityOutsideCap: string[] = [];
  for (const oc of args.priorityOutcodes) {
    const d = args.distances.get(oc);
    if (d !== undefined && d <= capMiles) priorityInCap.push(oc);
    else priorityOutsideCap.push(oc);
  }

  let radiusMiles = capMiles;
  let outcodes: string[] = [];
  let deliverable = 0;
  for (const r of radiusLadder(capMiles)) {
    const circle = outcodesWithin(args.distances, r);
    const inCircle = new Set(circle);
    outcodes = [...circle, ...priorityInCap.filter((oc) => !inCircle.has(oc))];
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
    priorityOutsideCap,
    target,
    deliverable,
  };
}
