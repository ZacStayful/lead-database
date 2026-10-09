import { GROSS_THRESHOLDS } from "@/lib/filterPrediction";
import type { NormalisedBrief } from "@/lib/leadBrief/input";
import { MAX_TRADEOFFS } from "@/lib/leadBrief/plans";
import type { ServiceArea } from "@/lib/leadBrief/serviceArea";
import type { EssentialKey } from "@/lib/leadBrief/types";

/**
 * A6: up to three trade-offs, each relaxing one essential by one step, ranked
 * by how many miles it brings the service area in.
 *
 * Only essentials change the radius — priorities rank and never exclude
 * (locked decision 6) — so the steps are:
 *
 *   revenue   one threshold down GROSS_THRESHOLDS (£75k → £50k); from the
 *             lowest (£25k) the essential is dropped
 *   bedrooms  one bedroom fewer (4+ → 3+); from 2+ the essential is dropped
 *
 * A trade-off is offered only when it brings the area in (A6: ranked by miles
 * saved). When the essentials are what keeps the area from covering the plan
 * at all, that is the bottleneck's job (bottleneck.ts), not a trade-off's.
 * The engine returns facts; the wording — always a gain, never "drop your
 * requirement" (A6) — belongs to the copy module (Phase 3).
 */
export interface Tradeoff {
  essential: EssentialKey;
  from: number;
  /** The relaxed threshold, or null when the essential is dropped. */
  to: number | null;
  radiusMiles: number;
  milesSaved: number;
}

export function relaxedThreshold(essential: EssentialKey, current: number): number | null {
  if (essential === "revenue") {
    const i = (GROSS_THRESHOLDS as readonly number[]).indexOf(current);
    return i > 0 ? GROSS_THRESHOLDS[i - 1] : null;
  }
  return current > 2 ? current - 1 : null;
}

/** The brief with one essential set to `to`, or dropped when `to` is null. */
export function relaxBrief(
  brief: NormalisedBrief,
  essential: EssentialKey,
  to: number | null
): NormalisedBrief {
  const essentials = to === null ? brief.essentials.filter((e) => e !== essential) : brief.essentials;
  return essential === "revenue"
    ? { ...brief, minGross: to, essentials }
    : { ...brief, minBedrooms: to, essentials };
}

/** The current threshold of an essential, or null when it is not one. */
export function essentialThreshold(brief: NormalisedBrief, essential: EssentialKey): number | null {
  return essential === "revenue" ? brief.minGross : brief.minBedrooms;
}

export function computeTradeoffs(args: {
  brief: NormalisedBrief;
  current: ServiceArea;
  /** Recompute the service area for a modified brief (same plan, same supply). */
  areaFor: (brief: NormalisedBrief) => ServiceArea;
}): Tradeoff[] {
  const out: Tradeoff[] = [];
  const { brief, current } = args;

  const candidates: { essential: EssentialKey; from: number; relaxed: NormalisedBrief; to: number | null }[] = [];
  for (const essential of ["revenue", "bedrooms"] as const) {
    const from = essentialThreshold(brief, essential);
    if (from === null) continue;
    const to = relaxedThreshold(essential, from);
    candidates.push({ essential, from, to, relaxed: relaxBrief(brief, essential, to) });
  }

  for (const c of candidates) {
    const area = args.areaFor(c.relaxed);
    const milesSaved = current.radiusMiles - area.radiusMiles;
    if (milesSaved > 0) {
      out.push({
        essential: c.essential,
        from: c.from,
        to: c.to,
        radiusMiles: area.radiusMiles,
        milesSaved,
      });
    }
  }

  out.sort((a, b) => b.milesSaved - a.milesSaved);
  return out.slice(0, MAX_TRADEOFFS);
}
