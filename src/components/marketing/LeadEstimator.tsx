"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { areaLabel } from "@/lib/postcode";
import type { AreaFeature } from "@/lib/geoRadius";
import {
  predictMonthlyVolume,
  belowAllocation,
  expansionSuggestions,
} from "@/lib/filterPrediction";
import { forecastVolume, recommendedDowngrade } from "@/lib/filterForecast";
import { plansFor } from "@/lib/plans";
import {
  toProductVolume,
  areasInPayload,
  type PublicFilterVolume,
} from "@/lib/publicFilterVolume";
import type { LeadType } from "@/lib/types";
import { LeadSourceMap } from "@/components/dashboard/LeadSourceMap";
import { PredictionBox } from "@/components/filtering/PredictionBox";
import { AreaPicker, type AreaOption } from "@/components/filtering/AreaPicker";
import { BedroomRange } from "@/components/filtering/BedroomRange";
import { RadiusControls } from "@/components/filtering/RadiusControls";
import {
  RADIUS_DEFAULT_MILES,
  radiusCoverage,
} from "@/components/filtering/radiusSearch";
import { useRadiusSearch } from "@/components/filtering/useRadiusSearch";
import {
  formatPence,
  formatPlanPrice,
  bedroomInputValue,
} from "@/components/filtering/format";

/**
 * "What would I actually get?", answered before signing up.
 *
 * Composed from the SAME components the dashboard panel uses — AreaPicker,
 * RadiusControls, BedroomRange, PredictionBox, LeadSourceMap — over the same
 * maths, against a cached, already-contention-adjusted payload. A first cut
 * shared only the maths and reimplemented a thinner UI, which meant a prospect
 * could not filter by bedrooms, see per-area counts, or be told when their
 * selection was too narrow. The parity is the point: a prospect shown four
 * leads a month at £25 should see exactly that on their first day.
 *
 * ⚠️ NOTHING HERE MAY PROMISE ANYTHING. This is the surface where an
 * over-promise is least recoverable, because a prospect quotes it back at
 * signup. It says what they can expect and how confident we are; it never says
 * what we would do if we fell short, because the answer is nothing.
 */

export function LeadEstimator({
  product,
  signupHref = "/signup",
}: {
  product: LeadType;
  signupHref?: string;
}) {
  const [payload, setPayload] = useState<PublicFilterVolume | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [mode, setMode] = useState<"radius" | "areas">("radius");
  const [query, setQuery] = useState("");
  const [miles, setMiles] = useState<number>(RADIUS_DEFAULT_MILES);
  const [picked, setPicked] = useState<string[]>([]);
  const [areaQuery, setAreaQuery] = useState("");
  const [minBeds, setMinBeds] = useState("");
  const [maxBeds, setMaxBeds] = useState("");
  const [showMap, setShowMap] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch("/api/filter-estimate/public")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => alive && setPayload(d as PublicFilterVolume))
      .catch(() => alive && setLoadFailed(true));
    return () => {
      alive = false;
    };
  }, []);

  /**
   * ⚠️ THE BOUNDARY FILE IS ~562 KB AND THE GAZETTEER ~250 KB, AND NEITHER MAY
   * LOAD ON MOUNT.
   *
   * A previous version gated the boundaries on `mode !== "radius"` and
   * commented that they were "fetched only if the visitor actually uses radius
   * mode" — but radius IS the default mode, so it fired for every visitor to
   * the landing page whether or not they touched the estimator. A marketing
   * page must not spend half a megabyte on something nobody asked for.
   *
   * The gate is genuine INTENT: something typed, the map opened, or a switch
   * to hand-picking (whose map button is the next thing they will reach for).
   * It is passed INTO useRadiusSearch rather than decided inside it, so it
   * stays visible here — the dashboard's own gate is different and correct for
   * a customer who already opened the filtering page.
   */
  const wantsGeo = query.trim() !== "" || showMap || mode === "areas";

  const volume = useMemo(
    () => (payload ? toProductVolume(payload, product) : null),
    [payload, product]
  );

  const availableAreas: AreaOption[] = useMemo(
    () =>
      payload
        ? areasInPayload(payload, product).map((a) => ({
            area: a,
            label: areaLabel(a),
          }))
        : [],
    [payload, product]
  );

  /**
   * Per-area totals for the map, summed across the bed buckets.
   *
   * ⚠️ These are CONTENTION-SCALED — applyContention runs when the payload is
   * built (see publicFilterVolume.ts), so this map shades by "what you would
   * get" while the dashboard's identical component shades by raw national
   * volume. That is the more honest number for a prospect, but it IS a
   * different number from the same component. Do not "fix" the discrepancy.
   */
  const areaCounts = useMemo(() => {
    const out: Record<string, number> = {};
    if (!volume) return out;
    for (const [area, beds] of Object.entries(volume.areaBedCounts)) {
      out[area] = Object.values(beds).reduce((a, b) => a + b, 0);
    }
    return out;
  }, [volume]);
  const maxAreaCount = useMemo(
    () => Math.max(0, ...Object.values(areaCounts)),
    [areaCounts]
  );
  const selectableAreas = useMemo(
    () => availableAreas.map((a) => a.area),
    [availableAreas]
  );

  const constraints = useMemo(
    () => ({
      minBedrooms: bedroomInputValue(minBeds),
      maxBedrooms: bedroomInputValue(maxBeds),
      // No revenue control here yet, and the cached public payload cannot
      // answer one until it carries bands — `canFilterByGross` is the gate
      // that decides whether to offer it at all. Null means "no floor", which
      // is byte-identical to the behaviour before revenue banding existed.
      minGross: null,
    }),
    [minBeds, maxBeds]
  );

  const {
    resolution: radius,
    features,
    loading: radiusLoading,
    failed: geoFailed,
  } = useRadiusSearch({
    enabled: wantsGeo,
    query,
    miles,
    volume,
    constraints,
  });

  // ⚠️ THE ESTIMATOR MUST ASK THIS TOO, and shipping without it is why a
  // Northern Ireland postcode read "widen the radius before applying" on both
  // landing pages — advice §66.2 records as one that can never work, because
  // OUTCODE_CENTROIDS carries 80 BT outcodes and the boundary file has no BT
  // feature at all.
  //
  // `radiusCoverage` was right and its unit tests passed; the defect was that
  // nothing here called it, so `coverageUnavailable` fell to its `= false`
  // default and RadiusControls took the other branch. A correct pure function
  // whose caller never reads it is invisible to this repo's whole suite —
  // `vitest.config.mts` is PURE UNITS ONLY, no React — which is the seam §42.8
  // and §65 both record. The file-text guards in `radiusGuards.test.ts` stand
  // in for the browser test nothing here can run, and all five were
  // mutation-checked (including that they do not pass on this comment).
  //
  // Only `areaUncovered` is taken: the other two verdicts gate Apply, and the
  // estimator has no Apply — it quotes, it never writes a filter. That is also
  // why the "anywhere filter" half of §66.2 was never reachable from here.
  const { areaUncovered: radiusAreaUncovered } = radiusCoverage({
    isRadiusMode: mode === "radius",
    resolvedOutcode: radius?.centre?.outcode ?? null,
    covered: radius?.covered ?? [],
    knownAreas: features?.map((f) => f.properties.area) ?? null,
  });

  // Memoised so the forecast below is not recomputed on every render — the
  // conditional would otherwise produce a fresh array identity each time.
  const selectedAreas = useMemo(
    () => (mode === "radius" ? (radius?.covered ?? []) : picked),
    [mode, radius, picked]
  );
  const hasSelection =
    selectedAreas.length > 0 ||
    constraints.minBedrooms != null ||
    constraints.maxBedrooms != null;

  const selection = useMemo(
    () => ({ areas: selectedAreas, ...constraints }),
    [selectedAreas, constraints]
  );

  const prediction = useMemo(
    () => (volume ? predictMonthlyVolume(volume, selection) : null),
    [volume, selection]
  );

  const quote = useMemo(() => {
    if (!prediction) return null;
    // Forecast against the largest plan, then step down to the cheapest one
    // that still covers it — the same helper the dashboard uses to advise a
    // downgrade, run in reverse. A prospect should land on the plan that makes
    // their selection cheapest per lead, not the biggest one.
    const plans = Object.values(plansFor(product)).sort(
      (a, b) => b.leads - a.leads
    );
    const largest = plans[0];
    const first = forecastVolume(prediction, largest.leads, product);
    if (!first.offerable) return { quote: first, plan: largest };
    const cheaper = recommendedDowngrade(first.expected, largest.leads, product);
    const plan = cheaper ?? largest;
    return { quote: forecastVolume(prediction, plan.leads, product), plan };
  }, [prediction, product]);

  // The plan they would actually buy, so VolumeBar reads as progress toward it
  // and the amber "adding areas raises the volume" variant fires when it should.
  const allocation = quote?.plan.leads ?? 0;
  const isBelow =
    prediction != null && allocation > 0
      ? belowAllocation(prediction, allocation)
      : false;
  const suggestions = useMemo(
    () =>
      isBelow && mode === "areas" && volume
        ? expansionSuggestions(volume, selection)
        : [],
    [isBelow, mode, volume, selection]
  );

  function toggleArea(area: string) {
    setPicked((p) =>
      p.includes(area) ? p.filter((x) => x !== area) : [...p, area]
    );
  }

  // A map click while in radius mode is the visitor taking over by hand —
  // switch to area mode first, or the radius-derived selection would win.
  function toggleFromMap(area: string) {
    if (mode === "radius") {
      setMode("areas");
      setPicked(selectedAreas);
    }
    toggleArea(area);
  }

  if (loadFailed) return null;

  return (
    <div className="rounded-lg border-[0.5px] border-border bg-card p-5">
      <h3 className="text-lg font-semibold">
        See what you&rsquo;d get in your area
      </h3>
      <p className="mt-1 text-sm text-muted-foreground">
        Pick where you work and the sizes you take on, and we&rsquo;ll show you
        the leads a month you can expect and what that works out at each —
        before you sign up.
      </p>

      <div className="mt-4 flex flex-wrap gap-2 text-sm">
        <button
          type="button"
          onClick={() => setMode("radius")}
          className={`rounded-md px-3 py-1.5 ${mode === "radius" ? "bg-primary text-primary-foreground" : "bg-muted"}`}
        >
          Around a postcode or town
        </button>
        <button
          type="button"
          onClick={() => setMode("areas")}
          className={`rounded-md px-3 py-1.5 ${mode === "areas" ? "bg-primary text-primary-foreground" : "bg-muted"}`}
        >
          Pick areas
        </button>
        <button
          type="button"
          onClick={() => setShowMap((v) => !v)}
          className="ml-auto rounded-md px-3 py-1.5 text-muted-foreground hover:text-foreground"
        >
          {showMap ? "Hide map" : "Show map"}
        </button>
      </div>

      {/* Behind a toggle on purpose: the map loads the boundary file, and it is
          orientation rather than part of the estimate. */}
      {showMap && maxAreaCount > 0 && (
        <div className="mt-3">
          <LeadSourceMap
            counts={areaCounts}
            maxCount={maxAreaCount}
            selectable={selectableAreas}
            selected={selectedAreas}
            onToggle={toggleFromMap}
            caption="Click an area to add it to your selection. Darker = more leads."
          />
        </div>
      )}

      {mode === "radius" ? (
        <RadiusControls
          idPrefix={`est-${product}`}
          query={query}
          miles={miles}
          onQueryChange={setQuery}
          onMilesChange={setMiles}
          geoFailed={geoFailed}
          loading={radiusLoading}
          resolution={radius}
          coverageUnavailable={radiusAreaUncovered}
        />
      ) : availableAreas.length > 0 ? (
        <AreaPicker
          availableAreas={availableAreas}
          areaCounts={areaCounts}
          selected={picked}
          query={areaQuery}
          onQueryChange={setAreaQuery}
          onToggle={toggleArea}
        />
      ) : (
        <p className="mt-3 text-sm text-muted-foreground">
          No postcode areas are available yet.
        </p>
      )}

      <div className="mt-4">
        <BedroomRange
          idPrefix={`est-${product}`}
          min={minBeds}
          max={maxBeds}
          onMinChange={setMinBeds}
          onMaxChange={setMaxBeds}
        />
      </div>

      {prediction && volume && hasSelection && (
        <div className="mt-4">
          <PredictionBox
            prediction={prediction}
            allocation={allocation}
            volume={volume}
            productLabel={
              product === "guaranteed_rent" ? "Guaranteed Rent" : "Management"
            }
            isBelow={isBelow}
            nothingSelected={false}
            suggestions={suggestions}
            onAddArea={(a) => {
              if (mode === "radius") {
                setMode("areas");
                setPicked(selectedAreas);
              }
              toggleArea(a);
            }}
          />
        </div>
      )}

      {quote && hasSelection && (
        <div className="mt-4 rounded-md border-[0.5px] border-border bg-muted/40 p-4">
          {quote.quote.offerable ? (
            <>
              <dl className="space-y-1 text-sm">
                <div className="flex items-baseline justify-between gap-4">
                  <dt className="text-muted-foreground">
                    Leads a month in your area
                  </dt>
                  <dd className="font-semibold tabular-nums">
                    about {quote.quote.estimate}
                  </dd>
                </div>
                <div className="flex items-baseline justify-between gap-4">
                  <dt className="text-muted-foreground">You could expect</dt>
                  <dd className="font-semibold tabular-nums">
                    at least {quote.quote.expected} a month
                  </dd>
                </div>
                {quote.quote.likelihoodPct != null && (
                  <div className="flex items-baseline justify-between gap-4">
                    <dt className="text-muted-foreground">Likelihood of that</dt>
                    <dd className="font-semibold tabular-nums">
                      {quote.quote.likelihoodPct}%
                    </dd>
                  </div>
                )}
                <div className="flex items-baseline justify-between gap-4">
                  <dt className="text-muted-foreground">Cost per lead</dt>
                  <dd className="font-semibold tabular-nums">
                    {formatPence(quote.quote.costPerLeadPence!)}
                  </dd>
                </div>
              </dl>

              {/* The caveat without the checkbox: a visitor has nothing to
                  acknowledge, but quoting £150 a lead in silence on a marketing
                  page is the one thing this must never do. */}
              {quote.quote.requiresExtraConfirm && (
                <p className="mt-3 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  That is a high price per lead. Widening your selection is
                  usually the better move: a bigger area raises the number you
                  can expect and brings the cost per lead down.
                  {suggestions.length > 0 && " Nearby areas are suggested above."}
                </p>
              )}

              <p className="mt-3 text-xs text-muted-foreground">
                On the {formatPlanPrice(quote.plan.priceGbp * 100)} a month plan,
                based on how many matching leads have actually come through
                these areas. It is a forecast rather than a promise — some
                months are quieter than others.
              </p>
              <Button asChild className="mt-4">
                <a href={signupHref}>Get started</a>
              </Button>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              Not many leads have come through this selection yet, so we
              can&rsquo;t put a number on it. Try a wider radius, a few more
              areas, or a broader bedroom range.
            </p>
          )}
        </div>
      )}

      {!payload && !loadFailed && (
        <p className="mt-4 text-xs text-muted-foreground">Loading lead volume…</p>
      )}
    </div>
  );
}
