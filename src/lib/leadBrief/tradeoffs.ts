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
 * A trade-off is offered when it brings the area in, or when the area could
 * not fill the plan at all and the relaxed brief can (`fillsPlan`). The
 * engine returns facts; the wording — always a gain, never "drop your
 * requirement" (A6) — belongs to the copy module (Phase 3).
 */
export interface Tradeoff {
  essential: EssentialKey;
  from: number;
  /** The relaxed threshold, or null when the essential is dropped. */
  to: number | null;
  radiusMiles: number;
  milesSaved: number;
  /** The current brief cannot fill the plan from its area; this one can. */
  fillsPlan: boolean;
}

export function relaxedThreshold(essential: EssentialKey, current: number): number | null {
  if (essential === "revenue") {
    const i = (GROSS_THRESHOLDS as readonly number[]).indexOf(current);
    return i > 0 ? GROSS_THRESHOLDS[i - 1] : null;
  }
  return current > 2 ? current - 1 : null;
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
  if (brief.minGross !== null) {
    const to = relaxedThreshold("revenue", brief.minGross);
    candidates.push({
      essential: "revenue",
      from: brief.minGross,
      to,
      relaxed: {
        ...brief,
        minGross: to,
        essentials: to === null ? brief.essentials.filter((e) => e !== "revenue") : brief.essentials,
      },
    });
  }
  if (brief.minBedrooms !== null) {
    const to = relaxedThreshold("bedrooms", brief.minBedrooms);
    candidates.push({
      essential: "bedrooms",
      from: brief.minBedrooms,
      to,
      relaxed: {
        ...brief,
        minBedrooms: to,
        essentials: to === null ? brief.essentials.filter((e) => e !== "bedrooms") : brief.essentials,
      },
    });
  }

  for (const c of candidates) {
    const area = args.areaFor(c.relaxed);
    const milesSaved = current.radiusMiles - area.radiusMiles;
    const fillsPlan = !current.meetsTarget && area.meetsTarget;
    if (milesSaved > 0 || fillsPlan) {
      out.push({
        essential: c.essential,
        from: c.from,
        to: c.to,
        radiusMiles: area.radiusMiles,
        milesSaved: Math.max(milesSaved, 0),
        fillsPlan,
      });
    }
  }

  out.sort((a, b) => b.milesSaved - a.milesSaved || Number(b.fillsPlan) - Number(a.fillsPlan));
  return out.slice(0, MAX_TRADEOFFS);
}
