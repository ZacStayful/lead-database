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

/**
 * Whether a resolved radius covers nothing, and whether widening could help.
 *
 * ⚠️ A RADIUS THAT COVERS NOTHING MUST NOT APPLY AS AN "ANYWHERE" FILTER.
 * The chain that made it one: covered = [] -> the panel sets selectedAreas to
 * [] -> the apply route writes filter_areas = null -> and
 * lead_matches_customer_filter (0074) reads a null area list as MATCH EVERY
 * AREA. With no areas the forecast also reads high, so `reducesVolume` is
 * false and the acknowledgement gate never fired — a customer asking for a
 * 10-mile radius could end up unfiltered.
 *
 * `areaUncovered` separates "this circle is empty" from "we hold no boundary
 * for that postcode area at all". The second is reachable today with any
 * Northern Ireland postcode — OUTCODE_CENTROIDS carries 80 BT outcodes and
 * the boundary file has no BT feature — and for it "widen the radius" is
 * advice that can never work.
 *
 * Pure so the rule is unit-tested directly rather than through a component,
 * which `vitest.config.mts` cannot render.
 */
export function radiusCoverage(args: {
  /** Radius mode only; hand-picking is never gated by this. */
  isRadiusMode: boolean;
  /** The outcode the typed postcode resolved to, or null if it resolved to none. */
  resolvedOutcode: string | null;
  covered: string[];
  /** Postcode areas we hold a boundary for. Null while they are still loading. */
  knownAreas: string[] | null;
}): { empty: boolean; areaUncovered: boolean } {
  const { isRadiusMode, resolvedOutcode, covered, knownAreas } = args;
  // Scoped to a centre that actually RESOLVED, so an empty box or an
  // unrecognised postcode still reads as "nothing typed yet", not an error.
  const empty = isRadiusMode && resolvedOutcode !== null && covered.length === 0;
  if (!empty || knownAreas === null) return { empty, areaUncovered: false };
  const area = resolvedOutcode!.toUpperCase().match(/^[A-Z]{1,2}/)?.[0] ?? null;
  const areaUncovered =
    area !== null && !knownAreas.some((a) => a.toUpperCase() === area);
  return { empty, areaUncovered };
}
