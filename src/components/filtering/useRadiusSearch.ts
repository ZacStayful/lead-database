"use client";

import { useEffect, useMemo, useState } from "react";
import {
  UNRESOLVED_RADIUS,
  parseRadiusCentre,
  resolveRadius,
  type RadiusResolution,
} from "@/components/filtering/radiusSearch";
import {
  indexPlaces,
  type PlaceIndex,
  type PlaceTuple,
} from "@/lib/places";
import type {
  AreaContention,
  FilterSelection,
  ProductVolume,
} from "@/lib/filterPrediction";
import type { AreaFeature } from "@/lib/geoRadius";

/**
 * The two fetches, the debounce and the memos behind a radius search.
 *
 * ⚠️ IT CONTAINS NO DECISIONS. vitest.config.mts is PURE UNITS ONLY — no React
 * — so anything branching in here is a branch no test can reach. Every rule
 * lives in parseRadiusCentre/resolveRadius, which are plain functions; this
 * only fetches, debounces and memoises.
 *
 * ⚠️ TWO FETCHES, NOT ONE, because the gazetteer is ~250 KB and the boundary
 * file is ~562 KB. Splitting lets the town dropdown work while the boundaries
 * are still in flight; one combined load makes the box do nothing for the best
 * part of a megabyte.
 *
 * ⚠️ `enabled` is THE CALLER'S OWN GATE, passed in rather than decided here.
 * §28.6 records a geojson fetch that fired for every visitor to both landing
 * pages because its gate was `mode !== "radius"` and radius is the DEFAULT
 * mode — a mount-time cost with no network request to see in devtools. The
 * dashboard passes `locationMode === "radius"`, the estimator passes its own
 * `wantsGeo`, and each one stays visible at its call site.
 */

const GEOJSON_URL = "/data/uk-postcode-areas.geojson";
const PLACES_URL = "/data/uk-places.json";

/**
 * ⚠️ Debounced on the RESOLVE, not on the suggestions. Suggestions are one
 * pass over a prebuilt index (~1 ms) and must feel instant; the resolve is
 * what costs a boundary scan per widening step and redraws the coverage
 * paragraph, the map and — on the dashboard — the area selection. Typing
 * "Salisbury" goes from nine resolves to one.
 */
export const RADIUS_DEBOUNCE_MS = 250;

export interface RadiusSearchState {
  resolution: RadiusResolution | null;
  features: AreaFeature[] | null;
  /** Either file still in flight, while the caller wants them. */
  loading: boolean;
  /** Either file failed — the search cannot work at all. */
  failed: boolean;
}

export function useRadiusSearch(args: {
  enabled: boolean;
  query: string;
  miles: number;
  volume: ProductVolume | null;
  bedrooms: Pick<FilterSelection, "minBedrooms" | "maxBedrooms">;
  contention?: AreaContention | null;
}): RadiusSearchState {
  const { enabled, query, miles, volume, bedrooms, contention } = args;

  const [features, setFeatures] = useState<AreaFeature[] | null>(null);
  const [places, setPlaces] = useState<PlaceTuple[] | null>(null);
  const [geoFailed, setGeoFailed] = useState(false);
  const [placesFailed, setPlacesFailed] = useState(false);

  useEffect(() => {
    if (!enabled || features || geoFailed) return;
    let live = true;
    fetch(GEOJSON_URL)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => live && setFeatures(d.features as AreaFeature[]))
      .catch(() => live && setGeoFailed(true));
    return () => {
      live = false;
    };
  }, [enabled, features, geoFailed]);

  useEffect(() => {
    if (!enabled || places || placesFailed) return;
    let live = true;
    fetch(PLACES_URL)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => live && setPlaces(d.places as PlaceTuple[]))
      .catch(() => live && setPlacesFailed(true));
    return () => {
      live = false;
    };
  }, [enabled, places, placesFailed]);

  const index: PlaceIndex | null = useMemo(
    () => (places ? indexPlaces(places) : null),
    [places]
  );

  // Suggestions track the box; the expensive half waits for the typing to stop.
  const [settled, setSettled] = useState(query);
  useEffect(() => {
    const t = setTimeout(() => setSettled(query), RADIUS_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [query]);

  const live = useMemo(
    () => parseRadiusCentre(query, index),
    [query, index]
  );
  const forCoverage = useMemo(
    () => parseRadiusCentre(settled, index),
    [settled, index]
  );

  const resolution = useMemo((): RadiusResolution | null => {
    // ⚠️ Tidiness, not a guard: a mutation run confirmed that removing this
    // changes nothing observable. Both fetches early-return on `!enabled`, so
    // `features` stays null and the memo would answer UNRESOLVED_RADIUS
    // instead of null — and every consumer of `resolution` is already gated on
    // its own mode. The gates that DO matter are the two fetches above, which
    // radiusGuards.test.ts pins literally.
    if (!enabled) return null;
    // The dropdown is the fast half and does not wait for the boundaries.
    const head = {
      centre: live.centre,
      suggestions: live.suggestions,
      looksLikePostcode: live.looksLikePostcode,
    };
    if (!features || !volume) return { ...UNRESOLVED_RADIUS, ...head };
    // ⚠️ Coverage is computed for the DEBOUNCED centre, so a half-typed name
    // cannot redraw the map; the dropdown above it is still live.
    if (!forCoverage.centre) return { ...UNRESOLVED_RADIUS, ...head };
    const { covered, upside } = resolveRadius(
      features,
      forCoverage.centre.centre,
      miles,
      volume,
      bedrooms,
      contention
    );
    return { ...head, centre: forCoverage.centre, covered, upside };
  }, [enabled, live, forCoverage, features, volume, miles, bedrooms, contention]);

  return {
    resolution,
    features,
    loading: enabled && !geoFailed && !placesFailed && (!features || !places),
    failed: geoFailed || placesFailed,
  };
}
