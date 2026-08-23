"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/lib/utils";
import { cityForArea } from "@/lib/postcode";
import { parseOutcode, outcodeCentroid } from "@/lib/outcodes";
import type { AreaFeature } from "@/lib/geoRadius";
import { LeadSourceMap } from "@/components/dashboard/LeadSourceMap";
import { PredictionBox } from "@/components/filtering/PredictionBox";
import { VolumeBar } from "@/components/filtering/VolumeBar";
import { resolveRadius } from "@/components/filtering/radiusSearch";
import {
  bedroomInputValue,
  formatPence as poundsFromPence,
  summariseBedrooms,
} from "@/components/filtering/format";
import {
  belowAllocation,
  expansionSuggestions,
  predictMonthlyVolume,
  type AreaContention,
  type ExpansionSuggestion,
  type FilterSelection,
  type ProductVolume,
  type VolumePrediction,
} from "@/lib/filterPrediction";
import {
  forecastVolume,
  recommendedDowngrade,
  type VolumeForecast,
} from "@/lib/filterForecast";
import type { FilterStatus, LeadType } from "@/lib/types";

export interface AreaOption {
  area: string;
  label: string;
}

export interface FilterPanelProps {
  product: LeadType;
  productLabel: string;
  status: FilterStatus;
  areas: string[];
  minBedrooms: number | null;
  maxBedrooms: number | null;
  liftEffectiveDate: string | null;
  availableAreas: AreaOption[];
  // Lead volume per postcode area (national), for the map + list hints.
  areaCounts?: Record<string, number>;
  maxAreaCount?: number;
  // Per-product ingest history the live volume prediction runs on.
  volume: ProductVolume;
  // The plan's monthly lead allocation for this product — what a selection is
  // judged "too small" against.
  monthlyAllocation: number;
  // How many other filtered customers already compete for each area, so the
  // draft forecast matches what routing will actually deliver.
  contention?: AreaContention | null;
  // The forecast the customer was SHOWN, as persisted. The summary view renders
  // these and never a freshly computed one: a recomputed figure drifts with
  // ingest and would display something they never actually read.
  expectedLeads?: number | null;
  forecastLikelihoodPct?: number | null;
  forecastCostPerLeadPence?: number | null;
  forecastAcknowledgedAt?: string | null;
}

/** "£21.43" from 2143. */
// Shown when a filter is wide enough that we still expect to deliver the full
// allocation — the reassuring case, and nothing to acknowledge.
const CONSENT_FULL =
  "This selection is big enough that we still expect to deliver your full monthly allocation, at your usual price per lead. Nothing about your subscription changes.";

// Too little history through these areas to forecast anything yet.
const CONSENT_UNRELIABLE =
  "Too few leads have come through this selection for us to forecast its volume, so we can't tell you what to expect from it yet. You may receive fewer leads some months, and your monthly subscription amount stays the same regardless. Once enough leads have come through these areas, we'll be able to show you a number.";

const MINI_GUIDE =
  "Applying or editing your filter takes effect immediately — you'll only be matched to leads in your chosen locations and bedroom range. Lifting your filter does not take effect immediately. You'll keep receiving only leads matching your current filter until your next billing cycle starts, and from that date you return to the standard full allocation.";

export function LeadFilteringPanel(props: FilterPanelProps) {
  const router = useRouter();
  const { product, productLabel, availableAreas } = props;
  const areaCounts = props.areaCounts ?? {};
  const maxAreaCount = props.maxAreaCount ?? 0;
  const selectableAreas = useMemo(
    () => availableAreas.map((a) => a.area),
    [availableAreas]
  );

  const [editing, setEditing] = useState(props.status === "off");
  const [selectedAreas, setSelectedAreas] = useState<string[]>(props.areas);
  const [minBeds, setMinBeds] = useState<string>(
    props.minBedrooms != null ? String(props.minBedrooms) : ""
  );
  const [maxBeds, setMaxBeds] = useState<string>(
    props.maxBedrooms != null ? String(props.maxBedrooms) : ""
  );
  const [areaQuery, setAreaQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [acknowledgedForecast, setAcknowledgedForecast] = useState(false);
  // A second, explicit step for poor value. Separate from the acknowledgement
  // so ticking one does not imply the other.
  const [acknowledgedPoorValue, setAcknowledgedPoorValue] = useState(false);
  // The server's forecast when it disagreed with ours (409) — volumes moved
  // while the customer was choosing.
  const [restatedForecast, setRestatedForecast] = useState<VolumeForecast | null>(null);

  // How the customer picks locations: hand-pick areas, or a radius around
  // their own postcode that resolves to the areas the circle touches. Radius
  // is a SELECTOR, not a different filter: routing matches on postcode areas,
  // so what is saved is always the resolved area set, through the same apply.
  const [locationMode, setLocationMode] = useState<"areas" | "radius">("areas");
  const [radiusPostcode, setRadiusPostcode] = useState("");
  const [radiusMiles, setRadiusMiles] = useState(15);
  const [geoFeatures, setGeoFeatures] = useState<AreaFeature[] | null>(null);
  const [geoFailed, setGeoFailed] = useState(false);

  // Boundary polygons for the radius test — fetched once, on first use of
  // radius mode (the map fetches the same file, so it is usually cached).
  useEffect(() => {
    if (locationMode !== "radius" || geoFeatures || geoFailed) return;
    let alive = true;
    fetch("/data/uk-postcode-areas.geojson")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => alive && setGeoFeatures(d.features as AreaFeature[]))
      .catch(() => alive && setGeoFailed(true));
    return () => {
      alive = false;
    };
  }, [locationMode, geoFeatures, geoFailed]);

  // Live prediction for the draft selection, recomputed on every toggle.
  const draftSelection: FilterSelection = useMemo(
    () => ({
      areas: selectedAreas,
      minBedrooms: minBeds === "" ? null : parseInt(minBeds, 10),
      maxBedrooms: maxBeds === "" ? null : parseInt(maxBeds, 10),
    }),
    [selectedAreas, minBeds, maxBeds]
  );
  const prediction = useMemo(
    () => predictMonthlyVolume(props.volume, draftSelection, props.contention),
    [props.volume, draftSelection, props.contention]
  );
  const forecast = useMemo(
    () => forecastVolume(prediction, props.monthlyAllocation, product),
    [prediction, props.monthlyAllocation, product]
  );
  // A cheaper plan that still covers the whole forecast. Only ever suggested
  // when it cannot cost the customer a lead, so it is advice, not a trade-off.
  const downgrade = useMemo(
    () =>
      forecast.offerable
        ? recommendedDowngrade(forecast.expected, props.monthlyAllocation, product)
        : null,
    [forecast, props.monthlyAllocation, product]
  );
  // The expansion chips still key off "too small for your plan" — that is the
  // question they answer, and it is not the same question as whether the
  // forecast is below the allocation.
  const isBelow = belowAllocation(prediction, props.monthlyAllocation);
  // The gate. Note this is NOT `isBelow`: a filter estimated at exactly the
  // allocation raises no "too small" warning yet is still forecast to deliver
  // less than the plan sells, which the customer should read before applying.
  const needsAcknowledgement = forecast.offerable && forecast.reducesVolume;
  const blocked =
    (needsAcknowledgement && !acknowledgedForecast) ||
    (forecast.requiresExtraConfirm && !acknowledgedPoorValue);
  // Nearest-area chips belong to hand-picking; in radius mode the "widen
  // search" line is the expansion mechanic, and a chip toggle would be undone
  // by the radius-to-selection sync anyway.
  const suggestions = useMemo(
    () =>
      isBelow && locationMode === "areas"
        ? expansionSuggestions(props.volume, draftSelection)
        : [],
    [isBelow, locationMode, props.volume, draftSelection]
  );

  // The acknowledgement is to a SPECIFIC number: any change of selection voids
  // it. Keyed on the raw inputs, not the memoised object — React may recompute a
  // useMemo without its inputs changing, which must not untick the box.
  useEffect(() => {
    setAcknowledgedForecast(false);
    setAcknowledgedPoorValue(false);
    setRestatedForecast(null);
  }, [selectedAreas, minBeds, maxBeds]);

  // The SAVED filter's prediction, for the read-only summary view — the same
  // number the admin surfaces show for this customer.
  const savedPrediction = useMemo(
    () =>
      predictMonthlyVolume(
        props.volume,
        {
          areas: props.areas,
          minBedrooms: props.minBedrooms,
          maxBedrooms: props.maxBedrooms,
        },
        props.contention
      ),
    [props.volume, props.areas, props.minBedrooms, props.maxBedrooms, props.contention]
  );
  const savedBelow = belowAllocation(savedPrediction, props.monthlyAllocation);
  // What the customer was SHOWN, not what today's data would quote. The two
  // drift as ingest moves, and only one of them is what they actually read.
  const shownLeads = props.expectedLeads ?? null;
  const shownCostPence = props.forecastCostPerLeadPence ?? null;
  const shownLikelihood = props.forecastLikelihoodPct ?? null;
  const savedDowngrade = useMemo(
    () =>
      shownLeads != null
        ? recommendedDowngrade(shownLeads, props.monthlyAllocation, product)
        : null,
    [shownLeads, props.monthlyAllocation, product]
  );

  // Radius mode: resolve the typed postcode + radius to the postcode areas
  // the circle touches, and work out the smallest widening that would add
  // more leads — "another 5 miles brings in Gloucester, about +2/month".
  const radius = useMemo((): {
    outcode: string | null;
    covered: string[];
    upside: { extraMiles: number; newAreas: string[]; extraRate: number } | null;
  } | null => {
    if (locationMode !== "radius" || !geoFeatures) return null;
    const unresolved = { outcode: null, covered: [], upside: null };
    const outcode = parseOutcode(radiusPostcode);
    if (!outcode) return unresolved;
    const centre = outcodeCentroid(outcode);
    if (!centre) return unresolved;

    const { covered, upside } = resolveRadius(
      geoFeatures,
      centre,
      radiusMiles,
      props.volume,
      {
        minBedrooms: bedroomInputValue(minBeds),
        maxBedrooms: bedroomInputValue(maxBeds),
      },
      props.contention
    );
    return { outcode, covered, upside };
  }, [
    locationMode,
    geoFeatures,
    radiusPostcode,
    radiusMiles,
    minBeds,
    maxBeds,
    props.volume,
    props.contention,
  ]);

  // In radius mode the covered areas ARE the selection, so the map, the
  // prediction, the consent gate and apply all run off the same state as
  // hand-picking. Keyed on the joined list to avoid a re-render loop.
  const coveredKey =
    radius && radius.outcode !== null ? radius.covered.join(",") : null;
  useEffect(() => {
    if (locationMode !== "radius" || coveredKey === null) return;
    setSelectedAreas((prev) =>
      prev.join(",") === coveredKey ? prev : coveredKey === "" ? [] : coveredKey.split(",")
    );
  }, [locationMode, coveredKey]);

  const visibleAreas = useMemo(() => {
    const q = areaQuery.trim().toLowerCase();
    if (!q) return availableAreas;
    return availableAreas.filter(
      (a) =>
        a.area.toLowerCase().includes(q) || a.label.toLowerCase().includes(q)
    );
  }, [availableAreas, areaQuery]);

  function toggleArea(area: string) {
    setSelectedAreas((prev) =>
      prev.includes(area) ? prev.filter((a) => a !== area) : [...prev, area]
    );
  }

  /**
   * A map click while in radius mode is the customer taking over by hand —
   * switch to area mode first, or the radius sync would immediately undo the
   * toggle. The radius-derived selection is kept as the starting point.
   */
  function toggleFromMap(area: string) {
    if (locationMode === "radius") setLocationMode("areas");
    toggleArea(area);
  }

  async function post(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/customer/filter", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ product, ...body }),
      });
      const data = await res.json();
      if (!res.ok) {
        // The server re-derives the forecast and refuses if ours is stale
        // (409) or unacknowledged (400). Both carry the current figures, so
        // show those rather than the number the customer was looking at.
        if (data?.forecast) {
          setRestatedForecast(data.forecast as VolumeForecast);
          setAcknowledgedForecast(false);
          setAcknowledgedPoorValue(false);
        }
        setError(data.error ?? "Something went wrong.");
        return false;
      }
      router.refresh();
      return true;
    } catch {
      setError("Something went wrong.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    // The radius details are recorded only when the selection genuinely came
    // from a resolved radius search — admin reads them to see what the
    // customer asked for. Routing reads the areas either way.
    const fromRadius =
      locationMode === "radius" && radius != null && radius.outcode !== null;
    const ok = await post({
      action: "apply",
      areas: selectedAreas,
      min_bedrooms: minBeds === "" ? null : parseInt(minBeds, 10),
      max_bedrooms: maxBeds === "" ? null : parseInt(maxBeds, 10),
      selection_mode: fromRadius ? "radius" : "areas",
      radius_outcode: fromRadius ? radius.outcode : null,
      radius_miles: fromRadius ? radiusMiles : null,
      acknowledge_forecast: acknowledgedForecast,
      // The number on screen. If the server derives a different one, it refuses
      // and restates rather than recording the customer against a figure they
      // never saw.
      quoted_expected_leads: forecast.offerable ? forecast.expected : null,
    });
    if (ok) setEditing(false);
  }

  async function lift() {
    if (
      !window.confirm(
        shownLeads != null
          ? `This removes your filter and returns you to your full allocation of ${props.monthlyAllocation} leads a month, from any location. Continue?`
          : "This removes your filter and returns you to your full lead allocation. Continue?"
      )
    ) {
      return;
    }
    await post({ action: "lift" });
  }

  async function cancelLift() {
    await post({ action: "cancel_lift" });
  }

  const bedroomSummary = summariseBedrooms(props.minBedrooms, props.maxBedrooms);
  const areaSummary =
    props.areas.length > 0
      ? props.areas
          .map((a) => labelFor(a, availableAreas))
          .join(", ")
      : "Any location";

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>{productLabel} lead filtering</CardTitle>
          <StatusBadge status={props.status} />
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {props.status === "off" && !editing && null}

        {/* Read-only summary for active / pending-lift states. */}
        {props.status !== "off" && !editing && (
          <div className="space-y-4">
            <dl className="grid gap-3 sm:grid-cols-2">
              <div>
                <dt className="text-xs text-muted-foreground">Areas</dt>
                <dd className="mt-0.5 text-sm font-medium">{areaSummary}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Bedrooms</dt>
                <dd className="mt-0.5 text-sm font-medium">{bedroomSummary}</dd>
              </div>
            </dl>

            <div className="space-y-1.5">
              {savedPrediction.reliable ? (
                <>
                  <p className="text-sm">
                    Predicted volume:{" "}
                    <span className="font-semibold">
                      ~{savedPrediction.displayRate} lead
                      {savedPrediction.displayRate === 1 ? "" : "s"}/month
                    </span>{" "}
                    <span className="text-muted-foreground">
                      of your {props.monthlyAllocation}/month plan
                    </span>
                  </p>
                  <VolumeBar
                    rate={savedPrediction.displayRate}
                    allocation={props.monthlyAllocation}
                    amber={savedBelow}
                  />
                </>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Only {savedPrediction.matchingLeads} matching lead
                  {savedPrediction.matchingLeads === 1 ? "" : "s"} since 1 July
                  — too little data to predict monthly volume reliably.
                </p>
              )}
              {shownLeads != null && shownCostPence != null ? (
                <div className="space-y-1 rounded-md border-[0.5px] border-border bg-muted/40 px-3 py-2">
                  {/*
                    "At least", never "we guarantee". shownLeads is a lower bound
                    at FORECAST_CONFIDENCE, so it is missed by design about one
                    month in six, and nothing credits the difference back.
                  */}
                  <p className="text-xs">
                    On this filter you can expect{" "}
                    <span className="font-semibold">
                      at least {shownLeads} lead
                      {shownLeads === 1 ? "" : "s"} a month
                    </span>
                    {shownLikelihood != null && (
                      <> — {shownLikelihood}% likely</>
                    )}
                    , which works out at{" "}
                    <span className="font-semibold">
                      {poundsFromPence(shownCostPence)}
                    </span>{" "}
                    a lead.
                    {props.forecastAcknowledgedAt && (
                      <> Based on volumes as at {formatDate(props.forecastAcknowledgedAt)}.</>
                    )}
                  </p>
                  {savedDowngrade && (
                    <p className="text-xs text-amber-700">
                      On the {poundsFromPence(savedDowngrade.priceGbp * 100)}{" "}
                      plan you would expect the same {shownLeads} lead
                      {shownLeads === 1 ? "" : "s"} at{" "}
                      {poundsFromPence(
                        Math.ceil((savedDowngrade.priceGbp * 100) / shownLeads)
                      )}{" "}
                      each.{" "}
                      <a href="/dashboard/settings" className="underline">
                        Change your plan
                      </a>
                      .
                    </p>
                  )}
                </div>
              ) : (
                savedBelow && (
                  <p className="text-xs text-amber-700">
                    Below your plan of {props.monthlyAllocation} leads/month —
                    too little history through these areas to forecast a number
                    yet.
                  </p>
                )
              )}
            </div>

            {props.status === "pending_lift" && props.liftEffectiveDate && (
              <div className="rounded-md border-[0.5px] border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                Your filter will lift on{" "}
                <span className="font-semibold">
                  {formatDate(props.liftEffectiveDate)}
                </span>
                . Until then you'll keep receiving only leads matching this
                filter.
              </div>
            )}

            <div className="flex flex-wrap gap-2">
              {props.status === "active" && (
                <>
                  <Button
                    variant="outline"
                    onClick={() => setEditing(true)}
                    disabled={busy}
                  >
                    Edit filter
                  </Button>
                  <Button variant="outline" onClick={lift} disabled={busy}>
                    Lift filter completely
                  </Button>
                </>
              )}
              {props.status === "pending_lift" && (
                <Button
                  variant="outline"
                  onClick={cancelLift}
                  disabled={busy}
                >
                  Cancel pending lift
                </Button>
              )}
            </div>
          </div>
        )}

        {/* Editable form: off state, or editing an active filter. */}
        {editing && (
          <div className="space-y-5">
            {props.status === "off" && (
              <p className="text-sm text-muted-foreground">
                Lead filtering lets you receive only leads in the locations and
                bedroom sizes you choose. It's useful if you focus on particular
                cities or property sizes. Narrowing your selection can mean
                fewer leads a month — we'll tell you how many to expect and what
                that works out at per lead before you apply. Leave a control
                open to accept anything for that dimension.
              </p>
            )}

            <div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <label className="text-sm font-medium">Locations</label>
                <div className="flex rounded-md border-[0.5px] border-border p-0.5 text-xs font-medium">
                  <button
                    type="button"
                    onClick={() => setLocationMode("areas")}
                    className={
                      "rounded px-2.5 py-1 " +
                      (locationMode === "areas"
                        ? "bg-brand/10 text-brand"
                        : "text-muted-foreground hover:text-foreground")
                    }
                  >
                    Pick areas
                  </button>
                  <button
                    type="button"
                    onClick={() => setLocationMode("radius")}
                    className={
                      "rounded px-2.5 py-1 " +
                      (locationMode === "radius"
                        ? "bg-brand/10 text-brand"
                        : "text-muted-foreground hover:text-foreground")
                    }
                  >
                    Radius search
                  </button>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                {locationMode === "areas"
                  ? "Choose the postcode areas you want leads from. Leave all unchecked to accept any location."
                  : "Enter your business postcode and how far you're willing to travel — we'll work out which postcode areas that covers."}
              </p>
              {availableAreas.length === 0 ? (
                <p className="mt-2 text-sm text-muted-foreground">
                  No postcode areas are available yet.
                </p>
              ) : (
                <>
                  {maxAreaCount > 0 && (
                    <div className="mt-2">
                      <LeadSourceMap
                        counts={areaCounts}
                        maxCount={maxAreaCount}
                        selectable={selectableAreas}
                        selected={selectedAreas}
                        onToggle={toggleFromMap}
                      />
                    </div>
                  )}
                  {locationMode === "areas" && (
                  <>
                  <Input
                    className="mt-2"
                    placeholder="Search areas…"
                    value={areaQuery}
                    onChange={(e) => setAreaQuery(e.target.value)}
                  />
                  <div className="mt-2 grid max-h-64 grid-cols-1 gap-1 overflow-y-auto rounded-md border-[0.5px] border-border p-2 sm:grid-cols-2 lg:grid-cols-3">
                    {visibleAreas.map((a) => {
                      const checked = selectedAreas.includes(a.area);
                      return (
                        <label
                          key={a.area}
                          className={
                            "flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm " +
                            (checked ? "bg-brand/10" : "hover:bg-accent")
                          }
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleArea(a.area)}
                            className="h-4 w-4 shrink-0"
                          />
                          <span className="truncate">{a.label}</span>
                          {areaCounts[a.area] != null && (
                            <span className="ml-auto shrink-0 tabular-nums text-xs text-muted-foreground">
                              {areaCounts[a.area]}
                            </span>
                          )}
                        </label>
                      );
                    })}
                    {visibleAreas.length === 0 && (
                      <p className="px-2 py-1.5 text-sm text-muted-foreground">
                        No areas match “{areaQuery}”.
                      </p>
                    )}
                  </div>
                  {selectedAreas.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {selectedAreas.map((a) => (
                        <span
                          key={a}
                          className="inline-flex items-center gap-1 rounded bg-brand/10 px-2 py-0.5 text-xs font-medium text-brand"
                        >
                          {labelFor(a, availableAreas)}
                          <button
                            type="button"
                            onClick={() => toggleArea(a)}
                            aria-label={`Remove ${a}`}
                            className="text-brand/70 hover:text-brand"
                          >
                            ×
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                  </>
                  )}

                  {locationMode === "radius" && (
                    <div className="mt-2 space-y-3">
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
                        <div className="flex-1">
                          <label
                            htmlFor={`${product}-radius-postcode`}
                            className="block text-xs text-muted-foreground"
                          >
                            Your business postcode
                          </label>
                          <Input
                            id={`${product}-radius-postcode`}
                            value={radiusPostcode}
                            onChange={(e) => setRadiusPostcode(e.target.value)}
                            placeholder="e.g. LE67 8QN"
                            autoComplete="postal-code"
                          />
                        </div>
                        <div>
                          <label
                            htmlFor={`${product}-radius-miles`}
                            className="block text-xs text-muted-foreground"
                          >
                            Radius
                          </label>
                          <select
                            id={`${product}-radius-miles`}
                            value={radiusMiles}
                            onChange={(e) =>
                              setRadiusMiles(parseInt(e.target.value, 10))
                            }
                            className="h-10 rounded-md border-[0.5px] border-border bg-background px-3 text-sm"
                          >
                            {[5, 10, 15, 20, 25, 30, 40, 50].map((m) => (
                              <option key={m} value={m}>
                                {m} miles
                              </option>
                            ))}
                          </select>
                        </div>
                      </div>

                      {geoFailed && (
                        <p className="text-sm text-amber-600">
                          The area boundaries could not be loaded, so radius
                          search is unavailable right now. You can still pick
                          areas by hand.
                        </p>
                      )}
                      {!geoFeatures && !geoFailed && (
                        <p className="text-sm text-muted-foreground">
                          Loading area boundaries…
                        </p>
                      )}
                      {radius &&
                        radius.outcode === null &&
                        radiusPostcode.trim() !== "" && (
                          <p className="text-sm text-amber-600">
                            We don't recognise that postcode — check it, or
                            try just its first half (e.g. LE67).
                          </p>
                        )}

                      {radius && radius.outcode !== null && (
                        <div className="space-y-2">
                          <p className="text-sm">
                            Within {radiusMiles} miles of{" "}
                            <span className="font-semibold">
                              {radius.outcode}
                            </span>{" "}
                            you'd receive leads from:{" "}
                            {radius.covered.length > 0 ? (
                              <span className="font-medium">
                                {radius.covered
                                  .map((a) => cityForArea(a) ? `${a} — ${cityForArea(a)}` : a)
                                  .join(", ")}
                              </span>
                            ) : (
                              <span className="text-muted-foreground">
                                no postcode areas — widen the radius.
                              </span>
                            )}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            Leads are matched by postcode area, so your filter
                            covers each of these areas in full — including the
                            parts beyond your radius.
                          </p>
                          {radius.upside && (
                            <p className="text-sm">
                              Widening to{" "}
                              <span className="font-semibold">
                                {radiusMiles + radius.upside.extraMiles} miles
                              </span>{" "}
                              would add{" "}
                              {radius.upside.newAreas
                                .map((a) => cityForArea(a) || a)
                                .join(", ")}{" "}
                              — about{" "}
                              <span className="font-semibold">
                                +{radius.upside.extraRate} lead
                                {radius.upside.extraRate === 1 ? "" : "s"}
                                /month
                              </span>
                              .{" "}
                              <button
                                type="button"
                                onClick={() =>
                                  setRadiusMiles(
                                    radiusMiles + radius.upside!.extraMiles
                                  )
                                }
                                className="font-medium text-brand hover:underline"
                              >
                                Widen search
                              </button>
                            </p>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>

            <div>
              <label className="text-sm font-medium">Bedroom range</label>
              <p className="text-xs text-muted-foreground">
                Leave both blank to accept any bedroom size. Setting the minimum
                and maximum to the same number requests an exact bedroom count.
              </p>
              <div className="mt-2 flex flex-col gap-3 sm:flex-row sm:items-start">
                <div className="flex-1">
                  <label
                    htmlFor={`${product}-min`}
                    className="block text-xs text-muted-foreground"
                  >
                    Minimum bedrooms
                  </label>
                  <Input
                    id={`${product}-min`}
                    type="number"
                    min={0}
                    inputMode="numeric"
                    value={minBeds}
                    onChange={(e) => setMinBeds(e.target.value)}
                    placeholder="Any"
                  />
                </div>
                <div className="flex-1">
                  <label
                    htmlFor={`${product}-max`}
                    className="block text-xs text-muted-foreground"
                  >
                    Maximum bedrooms
                  </label>
                  <Input
                    id={`${product}-max`}
                    type="number"
                    min={0}
                    inputMode="numeric"
                    value={maxBeds}
                    onChange={(e) => setMaxBeds(e.target.value)}
                    placeholder="Any"
                  />
                  <p className="mt-1 text-xs text-muted-foreground">
                    Requesting bedroom sizes beyond 5 will reduce the accuracy of
                    comparable data, as properties of this size are rarer to come
                    across.
                  </p>
                </div>
              </div>
            </div>

            <PredictionBox
              prediction={prediction}
              allocation={props.monthlyAllocation}
              volume={props.volume}
              productLabel={productLabel}
              isBelow={isBelow}
              nothingSelected={
                selectedAreas.length === 0 && minBeds === "" && maxBeds === ""
              }
              suggestions={suggestions}
              onAddArea={toggleArea}
            />

            {forecast.offerable && forecast.reducesVolume ? (
              <div className="space-y-3 rounded-md border-[0.5px] border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                {/*
                  THE WORDING IS THE HONESTY HERE. `expected` is the largest
                  number we can deliver with FORECAST_CONFIDENCE, so it is a
                  lower bound that will be missed about one month in six by
                  design, and no shortfall is credited back. "At least N, P%
                  likely" is therefore the only accurate way to say it — never
                  "we guarantee", and never a sentence about what happens if we
                  fall short, because the answer is "nothing".
                */}
                <dl className="space-y-1">
                  <div className="flex items-baseline justify-between gap-4">
                    <dt>This selection is worth about</dt>
                    <dd className="font-semibold tabular-nums">
                      {forecast.estimate} lead
                      {forecast.estimate === 1 ? "" : "s"} a month
                    </dd>
                  </div>
                  <div className="flex items-baseline justify-between gap-4">
                    <dt>You can expect</dt>
                    <dd className="font-semibold tabular-nums">
                      at least {forecast.expected} a month
                    </dd>
                  </div>
                  {forecast.likelihoodPct != null && (
                    <div className="flex items-baseline justify-between gap-4">
                      <dt>Likelihood of that</dt>
                      <dd className="font-semibold tabular-nums">
                        {forecast.likelihoodPct}%
                      </dd>
                    </div>
                  )}
                  <div className="flex items-baseline justify-between gap-4">
                    <dt>Works out at</dt>
                    <dd className="font-semibold tabular-nums">
                      {poundsFromPence(forecast.costPerLeadPence!)} a lead
                    </dd>
                  </div>
                </dl>
                <p className="text-xs">
                  Based on your plan price of{" "}
                  {poundsFromPence(forecast.planPricePence)} a month for{" "}
                  {forecast.allocation} leads, and on how many matching leads
                  have actually come through these areas. It is a forecast, not
                  a guarantee — some months will be quieter than others, and
                  your subscription amount stays the same either way.
                </p>

                {downgrade && (
                  <p className="rounded-md bg-amber-100/70 px-3 py-2 text-xs">
                    On the {poundsFromPence(downgrade.priceGbp * 100)} plan you
                    would expect the same {forecast.expected} lead
                    {forecast.expected === 1 ? "" : "s"} at{" "}
                    <span className="font-semibold">
                      {poundsFromPence(
                        Math.ceil((downgrade.priceGbp * 100) / forecast.expected)
                      )}
                    </span>{" "}
                    each instead of{" "}
                    {poundsFromPence(forecast.costPerLeadPence!)}.{" "}
                    <a href="/dashboard/settings" className="underline">
                      Change your plan
                    </a>{" "}
                    — it takes effect at your next billing cycle.
                  </p>
                )}

                <label className="flex cursor-pointer items-start gap-2">
                  <input
                    type="checkbox"
                    checked={acknowledgedForecast}
                    onChange={(e) => setAcknowledgedForecast(e.target.checked)}
                    className="mt-0.5 h-4 w-4 shrink-0"
                  />
                  <span>
                    I understand this filter is expected to deliver at least{" "}
                    {forecast.expected} lead
                    {forecast.expected === 1 ? "" : "s"} a month, working out at{" "}
                    {poundsFromPence(forecast.costPerLeadPence!)} a lead, and
                    that my subscription price is unchanged.
                  </span>
                </label>

                {/* Poor value is still allowed — the customer may have good
                    reasons — but it gets a second, separate step, and the thing
                    that actually helps sits next to it. */}
                {forecast.requiresExtraConfirm && (
                  <div className="space-y-2 rounded-md border-[0.5px] border-amber-400 bg-amber-100/70 px-3 py-2">
                    <p className="text-xs">
                      That is a high price per lead. Widening your selection is
                      usually the better move: a bigger area raises the number
                      you can expect and brings the cost per lead down.
                      {suggestions.length > 0 && " Nearby areas are suggested above."}
                    </p>
                    <label className="flex cursor-pointer items-start gap-2 text-xs">
                      <input
                        type="checkbox"
                        checked={acknowledgedPoorValue}
                        onChange={(e) =>
                          setAcknowledgedPoorValue(e.target.checked)
                        }
                        className="mt-0.5 h-4 w-4 shrink-0"
                      />
                      <span>
                        I have seen the suggestions and want this selection
                        anyway.
                      </span>
                    </label>
                  </div>
                )}
              </div>
            ) : forecast.reason === "unreliable" ? (
              <p className="rounded-md border-[0.5px] border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                {CONSENT_UNRELIABLE}
              </p>
            ) : (
              <p className="rounded-md border-[0.5px] border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
                {forecast.offerable
                  ? CONSENT_FULL
                  : "Choose at least one area or a bedroom range to see what you can expect."}
              </p>
            )}

            {/* Volumes moved between rendering the forecast and applying it.
                The server refused rather than recording the customer against a
                number they never saw. */}
            {restatedForecast && (
              <p className="rounded-md border-[0.5px] border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                Lead volumes have moved since this was worked out. You can now
                expect{" "}
                <span className="font-semibold">
                  at least {restatedForecast.expected} lead
                  {restatedForecast.expected === 1 ? "" : "s"} a month
                </span>
                {restatedForecast.costPerLeadPence != null && (
                  <>
                    {" "}
                    at {poundsFromPence(restatedForecast.costPerLeadPence)} each
                  </>
                )}
                . Review the figures above and confirm again to continue.
              </p>
            )}

            {error && <p className="text-sm text-amber-600">{error}</p>}

            <div className="flex flex-wrap gap-2">
              <Button onClick={apply} disabled={busy || blocked}>
                {busy
                  ? "Saving…"
                  : needsAcknowledgement
                    ? "Confirm and apply"
                    : props.status === "off"
                      ? "Apply filter"
                      : "Save changes"}
              </Button>
              {props.status !== "off" && (
                <Button
                  variant="outline"
                  onClick={() => {
                    setEditing(false);
                    setSelectedAreas(props.areas);
                    setMinBeds(
                      props.minBedrooms != null ? String(props.minBedrooms) : ""
                    );
                    setMaxBeds(
                      props.maxBedrooms != null ? String(props.maxBedrooms) : ""
                    );
                    setError(null);
                  }}
                  disabled={busy}
                >
                  Cancel
                </Button>
              )}
            </div>
          </div>
        )}

        {error && !editing && <p className="text-sm text-amber-600">{error}</p>}

        <div className="rounded-md bg-muted/40 px-4 py-3 text-xs leading-relaxed text-muted-foreground">
          {MINI_GUIDE}
        </div>
      </CardContent>
    </Card>
  );
}

/** Plain two-div progress bar: predicted volume against the plan allocation. */


function StatusBadge({ status }: { status: FilterStatus }) {
  if (status === "active") return <Badge variant="brand">Filter active</Badge>;
  if (status === "pending_lift")
    return <Badge variant="muted">Lift scheduled</Badge>;
  return <Badge variant="muted">No filter</Badge>;
}

function labelFor(area: string, options: AreaOption[]): string {
  return options.find((o) => o.area === area)?.label ?? area;
}
