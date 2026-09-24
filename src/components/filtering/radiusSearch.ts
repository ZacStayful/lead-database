import { areasWithinRadius, type AreaFeature } from "@/lib/geoRadius";
import {
  predictMonthlyVolume,
  type AreaContention,
  type FilterSelection,
  type ProductVolume,
} from "@/lib/filterPrediction";
import { MILES_TO_KM } from "@/components/filtering/format";
import { outcodeCentroid, parseOutcode } from "@/lib/outcodes";
import {
  PLACE_MIN_QUERY,
  exactPlaces,
  placeLabel,
  searchPlaces,
  type PlaceIndex,
  type PlaceMatch,
} from "@/lib/places";
import type { LatLng } from "@/lib/areaCentroids";

/**
 * Resolving a radius search, and finding the smallest widening worth offering.
 *
 * Lifted out of LeadFilteringPanel's memo so the public estimator can offer the
 * same "another 5 miles brings in Gloucester, about +2/month" prompt — and,
 * being pure, so the scan can be tested directly instead of only through a
 * component.
 */

/**
 * What the radius is measured FROM — a postcode the customer typed, or a town
 * they picked. Both carry an outcode, because that is what gets persisted and
 * what admin reads back; a place carries its name as well so the filter can
 * say "40 mi from Salisbury (SP1)" rather than just "from SP1".
 */
export type RadiusCentre =
  | { kind: "outcode"; outcode: string; centre: LatLng; label: string }
  | {
      kind: "place";
      name: string;
      outcode: string;
      centre: LatLng;
      label: string;
    };

export interface RadiusCentreParse {
  /** Null until something unambiguously resolves. */
  centre: RadiusCentre | null;
  /** Towns to offer when nothing resolved, or when the name is ambiguous. */
  suggestions: PlaceMatch[];
  /**
   * Whether the box looks like a postcode attempt rather than a town, so the
   * "we don't know that" copy can name the right thing. Decided here rather
   * than re-derived in the component, which would be a second copy of the
   * rule.
   */
  looksLikePostcode: boolean;
}

const NOTHING_TYPED: RadiusCentreParse = {
  centre: null,
  suggestions: [],
  looksLikePostcode: false,
};

/**
 * Resolve what the customer typed into a centre, or into a list to pick from.
 *
 * ⚠️ POSTCODE IS TRIED FIRST, AND THE RULE IS UNAMBIGUOUS BY CONSTRUCTION:
 * parseOutcode only succeeds against the 2,856 known outcodes, every one of
 * them contains a digit, and NO PLACE NAME IN THE GAZETTEER CONTAINS ONE
 * (0 of 6,222, asserted in ukPlaces.test.ts). So a town can never be swallowed
 * by the postcode branch, and there is no ordering hazard to reason about.
 *
 * ⚠️ IT NEVER AUTO-PICKS THE TOP HIT WHILE SOMEBODY IS TYPING. "New" resolving
 * to Newcastle would redraw a coverage paragraph mid-word and, on the
 * dashboard, silently rewrite the saved area selection. A name resolves only
 * when it matches EXACTLY and matches exactly ONE place — so "Salisbury" typed
 * in full just works, and "Newport" (six towns) offers a choice instead.
 *
 * ⚠️ `index` may be null, and the postcode branch must still work: the
 * gazetteer is a separate fetch and the box has to be usable before it lands.
 */
export function parseRadiusCentre(
  raw: string,
  index: PlaceIndex | null
): RadiusCentreParse {
  const typed = raw.trim();
  if (typed === "") return NOTHING_TYPED;

  // No place name contains a digit, so this cannot swallow a town.
  const outcode = parseOutcode(typed);
  if (outcode) {
    const centre = outcodeCentroid(outcode);
    if (centre) {
      return {
        centre: { kind: "outcode", outcode, centre, label: outcode },
        suggestions: [],
        looksLikePostcode: true,
      };
    }
  }

  // ⚠️ The same signal, and the reason it is honest: a digit means they were
  // typing a postcode, because no town in the gazetteer has one.
  const looksLikePostcode = /\d/.test(typed);

  if (typed.length < PLACE_MIN_QUERY || !index) {
    return { centre: null, suggestions: [], looksLikePostcode };
  }

  const exact = exactPlaces(index, typed);
  if (exact.length === 1) {
    const [p] = exact;
    return {
      centre: {
        kind: "place",
        name: p.name,
        outcode: p.outcode,
        centre: p.centre,
        label: placeLabel(p.name, p.outcode),
      },
      suggestions: [],
      looksLikePostcode,
    };
  }

  // Several exact matches (Newport) offer a choice rather than a guess.
  return {
    centre: null,
    suggestions: exact.length > 1 ? exact : searchPlaces(index, typed),
    looksLikePostcode,
  };
}

/**
 * ⚠️ THE ONE LIST OF RADIUS DISTANCES. The `<select>`, the widening scan and
 * the tests all read it, because they must agree: a widening the scan proposes
 * has to be a setting the dropdown can actually show.
 *
 * It did not. The scan tried a literal `[5,10,15,20,25,30]` of EXTRA miles
 * against this list of ABSOLUTE ones, so "Widen search" from 50 miles offered
 * 55, 60, 65, 70, 75 or 80 — none of them an <option>, so accepting one left
 * the select rendering with nothing selected. Not an edge case: from 30, 40 or
 * 50 miles most of the offered steps missed, and only 40 and 50 could ever be
 * reached by widening at all.
 *
 * ⚠️ DROPPING 5 MILES IS A REAL REGRESSION FOR DENSE-URBAN OPERATORS, taken
 * knowingly. From EC1 a 10-mile circle already returns 19 postcode areas, so
 * there is no longer a precise setting for inside London. It is one entry to
 * add back if it ever costs somebody a sale.
 *
 * At the other end, 100 miles from Northampton touches 78 of the ~120 areas —
 * which is why the coverage list truncates and gains a "that's most of Great
 * Britain" caveat past NEAR_NATIONAL_AREAS.
 */
export const RADIUS_MILE_OPTIONS = [
  10, 20, 30, 40, 50, 60, 70, 80, 90, 100,
] as const;

/**
 * What the box starts on.
 *
 * ⚠️ Named rather than indexed. Both callers used to hold their own literal —
 * the dashboard 15, which was not even on the old list, so its <select>
 * rendered with nothing selected on first open.
 */
export const RADIUS_DEFAULT_MILES: number = 20;

/**
 * The widening steps reachable from `miles` — the gap to each larger option,
 * so every `miles + step` is itself an option. Empty at the top of the list,
 * which is what stops an offer being made that cannot be taken.
 *
 * An off-list current value still widens ONTO the list (from 35: +5, +15).
 *
 * ⚠️ CAPPED AT THREE, and the cap only started earning its keep once the list
 * went to 100. From 10 miles there are nine larger options, and offering the
 * ninety-mile jump when ten would do buys volume the operator cannot service
 * — which is the argument `resolveRadius`'s own docstring already made while
 * the six-long literal above it contradicted it. Stopping at the first GAINING
 * step is the other half of the same rule; this bounds how far it looks.
 */
export const RADIUS_WIDENING_STEPS = 3;

export function wideningStepsFrom(miles: number): number[] {
  const next = RADIUS_MILE_OPTIONS.findIndex((m) => m > miles);
  if (next < 0) return [];
  return RADIUS_MILE_OPTIONS.slice(next)
    .map((m) => m - miles)
    .slice(0, RADIUS_WIDENING_STEPS);
}

export interface RadiusUpside {
  extraMiles: number;
  newAreas: string[];
  extraRate: number;
}

/** What the geojson half answers: which areas, and the smallest useful widening. */
export interface RadiusCoverage {
  covered: string[];
  upside: RadiusUpside | null;
}

export interface RadiusResolution {
  /**
   * What the circle is centred on, or null when nothing resolved.
   *
   * ⚠️ This replaced a bare `outcode: string | null`, which carried TWO
   * meanings — "did this resolve" and "the value to POST" — and the town
   * branch would have inherited that conflation, with a place resolving but
   * having no separate name to persist.
   */
  centre: RadiusCentre | null;
  /** Postcode areas the circle touches, closest first. */
  covered: string[];
  /** The first widening that adds volume, or null if no larger option gains any. */
  upside: RadiusUpside | null;
  /** Towns to pick from when nothing resolved or the name is ambiguous. */
  suggestions: PlaceMatch[];
  /** Whether the box reads as a postcode attempt, for the failure copy. */
  looksLikePostcode: boolean;
}

/** Nothing typed yet, or nothing we could resolve. */
export const UNRESOLVED_RADIUS: RadiusResolution = {
  centre: null,
  covered: [],
  upside: null,
  suggestions: [],
  looksLikePostcode: false,
};

/**
 * Every filter dimension the widening scan has to honour, other than location.
 *
 * ⚠️ NOT NAMED `bedrooms`, and not a two-key Pick, deliberately. It was both
 * until a revenue floor existed, and a parameter called `bedrooms` is one the
 * next person drops a new dimension from without noticing — at which point a
 * customer with a £50k floor is told "widen to 40 miles for 8 more leads a
 * month" on a figure computed over stock the floor excludes. An OVERSTATED
 * gain, plausible, with nothing erroring. Widen this type, never work round it.
 */
export type RadiusConstraints = Pick<
  FilterSelection,
  "minBedrooms" | "maxBedrooms" | "minGross"
>;

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
  constraints: RadiusConstraints,
  contention?: AreaContention | null
): RadiusCoverage {
  const covered = areasWithinRadius(features, centre, miles * MILES_TO_KM);
  const current = predictMonthlyVolume(
    volume,
    { areas: covered, ...constraints },
    contention
  );

  for (const extra of wideningStepsFrom(miles)) {
    const wider = areasWithinRadius(
      features,
      centre,
      (miles + extra) * MILES_TO_KM
    );
    if (wider.length === covered.length) continue;
    const p = predictMonthlyVolume(
      volume,
      { areas: wider, ...constraints },
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
 * ⚠️ `unresolved` IS THE SAME BUG THROUGH A WIDER DOOR, and the first cut of
 * this function missed it. `empty` only fires once a centre HAS resolved — so
 * with nothing typed yet, or while the 562 KB boundary file is still in
 * flight, `covered` is `[]`, nothing was blocked, and Apply wrote the same
 * "anywhere" filter. In radius mode a selection only means anything once the
 * circle has actually resolved to areas, so the caller blocks on either.
 *
 * ⚠️ An empty area list is NOT wrong in itself — a bedroom-only filter is a
 * real thing a customer has today (0 areas, 2+ beds). It is wrong when they
 * asked for a RADIUS and got nothing, which is why this is scoped to radius
 * mode and hand-picking is never gated by it.
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
}): { empty: boolean; areaUncovered: boolean; unresolved: boolean } {
  const { isRadiusMode, resolvedOutcode, covered, knownAreas } = args;
  // Scoped to a centre that actually RESOLVED, so an empty box or an
  // unrecognised postcode still reads as "nothing typed yet", not an error.
  const empty = isRadiusMode && resolvedOutcode !== null && covered.length === 0;
  const unresolved = isRadiusMode && resolvedOutcode === null;
  if (!empty || knownAreas === null) {
    return { empty, areaUncovered: false, unresolved };
  }
  const area = resolvedOutcode!.toUpperCase().match(/^[A-Z]{1,2}/)?.[0] ?? null;
  const areaUncovered =
    area !== null && !knownAreas.some((a) => a.toUpperCase() === area);
  return { empty, areaUncovered, unresolved };
}
