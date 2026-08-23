import { areasWithinRadius, type AreaFeature } from "@/lib/geoRadius";
import {
  predictMonthlyVolume,
  type AreaContention,
  type FilterSelection,
  type ProductVolume,
} from "@/lib/filterPrediction";
import { MILES_TO_KM } from "@/components/filtering/format";

/**
 * Resolving a radius search, and finding the smallest widening worth offering.
 *
 * Lifted out of LeadFilteringPanel's memo so the public estimator can offer the
 * same "another 5 miles brings in Gloucester, about +2/month" prompt — and,
 * being pure, so the scan can be tested directly instead of only through a
 * component.
 */

export interface RadiusUpside {
  extraMiles: number;
  newAreas: string[];
  extraRate: number;
}

export interface RadiusResolution {
  /** Null when the typed postcode is not one we recognise. */
  outcode: string | null;
  /** Postcode areas the circle touches, closest first. */
  covered: string[];
  /** The first widening that adds volume, or null if none within 30 miles. */
  upside: RadiusUpside | null;
}

/** Nothing typed yet, or nothing we could resolve. */
export const UNRESOLVED_RADIUS: RadiusResolution = {
  outcode: null,
  covered: [],
  upside: null,
};

/**
 * Areas within `miles` of `centre`, plus the smallest step outwards that would
 * actually add leads.
 *
 * The scan stops at the FIRST step that gains volume rather than reporting the
 * best of the six: the offer is "widen a little", and naming the 30-mile jump
 * when 5 would do buys volume the operator cannot service. A step that touches
 * no new areas is skipped rather than counted as no gain — the same circle with
 * a bigger radius is not a widening.
 */
export function resolveRadius(
  features: AreaFeature[],
  centre: [number, number],
  miles: number,
  volume: ProductVolume,
  bedrooms: Pick<FilterSelection, "minBedrooms" | "maxBedrooms">,
  contention?: AreaContention | null
): Omit<RadiusResolution, "outcode"> {
  const covered = areasWithinRadius(features, centre, miles * MILES_TO_KM);
  const current = predictMonthlyVolume(
    volume,
    { areas: covered, ...bedrooms },
    contention
  );

  for (const extra of [5, 10, 15, 20, 25, 30]) {
    const wider = areasWithinRadius(
      features,
      centre,
      (miles + extra) * MILES_TO_KM
    );
    if (wider.length === covered.length) continue;
    const p = predictMonthlyVolume(
      volume,
      { areas: wider, ...bedrooms },
      contention
    );
    if (p.displayRate > current.displayRate) {
      return {
        covered,
        upside: {
          extraMiles: extra,
          newAreas: wider.filter((a) => !covered.includes(a)),
          extraRate: p.displayRate - current.displayRate,
        },
      };
    }
  }
  return { covered, upside: null };
}
