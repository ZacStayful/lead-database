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
import { areasWithinRadius, type AreaFeature } from "@/lib/geoRadius";
import { LeadSourceMap } from "@/components/dashboard/LeadSourceMap";
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
  quoteGuarantee,
  recommendedDowngrade,
  type GuaranteeQuote,
} from "@/lib/filterGuarantee";
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
  // draft quote matches what routing will actually deliver.
  contention?: AreaContention | null;
  // The ACCEPTED guarantee, as persisted. The summary view renders these, never
  // a freshly computed quote: the stored figures are the contract, and a
  // recomputed one would drift with ingest and show terms nobody agreed to.
  guaranteedLeads?: number | null;
  guaranteeLikelihoodPct?: number | null;
  guaranteeCostPerLeadPence?: number | null;
  guaranteeAcceptedAt?: string | null;
  /** Leads credited so far for missed guarantees. */
  guaranteeCredit?: number;
}

/** "£21.43" from 2143. */
function poundsFromPence(pence: number): string {
  return `£${(pence / 100).toFixed(2)}`;
}

// Shown when a filter is wide enough that the full allocation is still
// guaranteed — the reassuring case, and no consent is needed for it.
const CONSENT_FULL =
  "This selection is big enough that we can still guarantee your full monthly allocation, at your usual price per lead. Nothing about your subscription changes.";

// The one remaining case where the guarantee really is lifted: too little
// history through these areas to promise anything yet.
const CONSENT_UNRELIABLE =
  "Too few leads have come through this selection for us to predict its volume, so we can't put a guarantee on it yet. You may receive fewer leads some months, and your monthly subscription amount stays the same regardless. Once enough leads have come through these areas, we'll offer you a guaranteed number.";

const MINI_GUIDE =
  "Applying or editing your filter takes effect immediately — you'll only be matched to leads in your chosen locations and bedroom range, and the guarantee you accept is the one that applies from then on. Lifting your filter does not take effect immediately. You'll keep receiving only leads matching your current filter until your next billing cycle starts. From that date, your filter guarantee ends and you return to the standard full allocation.";

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
  const [acceptedGuarantee, setAcceptedGuarantee] = useState(false);
  // A second, explicit step for a poor offer. Separate from the acceptance so
  // ticking one does not imply the other.
  const [acknowledgedPoorValue, setAcknowledgedPoorValue] = useState(false);
  // The server's quote when it disagreed with ours (409) — volumes moved while
  // the customer was choosing.
  const [restatedQuote, setRestatedQuote] = useState<GuaranteeQuote | null>(null);

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
  const quote = useMemo(
    () => quoteGuarantee(prediction, props.monthlyAllocation, product),
    [prediction, props.monthlyAllocation, product]
  );
  // A cheaper plan that still covers the whole guarantee. Only ever suggested
  // when it cannot cost the customer a lead, so it is advice, not a trade-off.
  const downgrade = useMemo(
    () =>
      quote.offerable
        ? recommendedDowngrade(quote.guaranteed, props.monthlyAllocation, product)
        : null,
    [quote, props.monthlyAllocation, product]
  );
  // The expansion chips still key off "too small for your plan" — that is the
  // question they answer, and it is not the same question as whether the
  // guarantee is reduced.
  const isBelow = belowAllocation(prediction, props.monthlyAllocation);
  // The gate. Note this is NOT `isBelow`: a filter estimated at exactly the
  // allocation raises no "too small" warning yet still carries a reduced
  // guarantee, and that reduction is a term the customer has to agree to.
  const needsAcceptance = quote.offerable && quote.reducesGuarantee;
  const blocked =
    (needsAcceptance && !acceptedGuarantee) ||
    (quote.requiresExtraConfirm && !acknowledgedPoorValue);
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

  // Consent is to a specific number: any change of selection voids it.
  // Keyed on the raw inputs, not the memoised object — React may recompute a
  // useMemo without its inputs changing, which must not untick the box.
  useEffect(() => {
    setAcceptedGuarantee(false);
    setAcknowledgedPoorValue(false);
    setRestatedQuote(null);
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
  // What was ACCEPTED, not what today's data would quote. The two drift as
  // ingest moves, and only one of them is the agreement.
  const acceptedLeads = props.guaranteedLeads ?? null;
  const acceptedCostPence = props.guaranteeCostPerLeadPence ?? null;
  const acceptedLikelihood = props.guaranteeLikelihoodPct ?? null;
  const savedDowngrade = useMemo(
    () =>
      acceptedLeads != null
        ? recommendedDowngrade(acceptedLeads, props.monthlyAllocation, product)
        : null,
    [acceptedLeads, props.monthlyAllocation, product]
  );

  // Radius mode: resolve the typed postcode + radius to the postcode areas
  // the circle touches, and work out the smallest widening that would add
  // more leads — "another 5 miles brings in Gloucester, about +2/month".
  const MILES_TO_KM = 1.60934;
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

    const covered = areasWithinRadius(
      geoFeatures,
      centre,
      radiusMiles * MILES_TO_KM
    );
    const bedSel = {
      minBedrooms: minBeds === "" ? null : parseInt(minBeds, 10),
      maxBedrooms: maxBeds === "" ? null : parseInt(maxBeds, 10),
    };
    const current = predictMonthlyVolume(props.volume, {
      areas: covered,
      ...bedSel,
    });

    // Scan outwards in 5-mile steps for the first widening that adds leads.
    let upside: {
      extraMiles: number;
      newAreas: string[];
      extraRate: number;
    } | null = null;
    for (const extra of [5, 10, 15, 20, 25, 30]) {
      const wider = areasWithinRadius(
        geoFeatures,
        centre,
        (radiusMiles + extra) * MILES_TO_KM
      );
      if (wider.length === covered.length) continue;
      const p = predictMonthlyVolume(props.volume, {
        areas: wider,
        ...bedSel,
      });
      if (p.displayRate > current.displayRate) {
        upside = {
          extraMiles: extra,
          newAreas: wider.filter((a) => !covered.includes(a)),
          extraRate: p.displayRate - current.displayRate,
        };
        break;
      }
    }
    return { outcode, covered, upside };
  }, [
    locationMode,
    geoFeatures,
    radiusPostcode,
    radiusMiles,
    minBeds,
    maxBeds,
    props.volume,
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
        // The server re-derives the guarantee and refuses if ours is stale
        // (409) or unaccepted (400). Both carry the current quote, so show
        // that rather than the number the customer was looking at.
        if (data?.guarantee) {
          setRestatedQuote(data.guarantee as GuaranteeQuote);
          setAcceptedGuarantee(false);
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
      accept_guarantee: acceptedGuarantee,
      // The number on screen. If the server derives a different one, it
      // refuses and restates rather than binding the customer to terms they
      // never saw.
      quoted_guaranteed_leads: quote.offerable ? quote.guaranteed : null,
    });
    if (ok) setEditing(false);
  }

  async function lift() {
    if (
      !window.confirm(
        acceptedLeads != null
          ? `This ends your filter guarantee of ${acceptedLeads} leads a month and returns you to the standard full allocation. Continue?`
          : "This returns you to the standard guaranteed lead allocation. Continue?"
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
              {acceptedLeads != null && acceptedCostPence != null ? (
                <div className="space-y-1 rounded-md border-[0.5px] border-border bg-muted/40 px-3 py-2">
                  <p className="text-xs">
                    We guarantee{" "}
                    <span className="font-semibold">
                      {acceptedLeads} lead{acceptedLeads === 1 ? "" : "s"} a month
                    </span>{" "}
                    on this filter, at{" "}
                    <span className="font-semibold">
                      {poundsFromPence(acceptedCostPence)}
                    </span>{" "}
                    per guaranteed lead
                    {acceptedLikelihood != null && (
                      <> — {acceptedLikelihood}% likely to be met</>
                    )}
                    .
                    {props.guaranteeAcceptedAt && (
                      <> Accepted {formatDate(props.guaranteeAcceptedAt)}.</>
                    )}
                  </p>
                  {(props.guaranteeCredit ?? 0) > 0 && (
                    <p className="text-xs text-muted-foreground">
                      {props.guaranteeCredit} lead
                      {props.guaranteeCredit === 1 ? "" : "s"} credited to your
                      balance so far for months we fell short.
                    </p>
                  )}
                  {savedDowngrade && (
                    <p className="text-xs text-amber-700">
                      On the {poundsFromPence(savedDowngrade.priceGbp * 100)}{" "}
                      plan you would get the same {acceptedLeads} guaranteed
                      lead{acceptedLeads === 1 ? "" : "s"} at{" "}
                      {poundsFromPence(
                        Math.ceil((savedDowngrade.priceGbp * 100) / acceptedLeads)
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
                    too little history through these areas to guarantee a
                    number yet.
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
                fewer leads a month — we'll tell you the number we can guarantee
                and what that works out at per lead before you apply. Leave a
                control open to accept anything for that dimension.
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

            {quote.offerable && quote.reducesGuarantee ? (
              <div className="space-y-3 rounded-md border-[0.5px] border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                <dl className="space-y-1">
                  <div className="flex items-baseline justify-between gap-4">
                    <dt>This selection is worth about</dt>
                    <dd className="font-semibold tabular-nums">
                      {quote.estimate} lead{quote.estimate === 1 ? "" : "s"} a month
                    </dd>
                  </div>
                  <div className="flex items-baseline justify-between gap-4">
                    <dt>We guarantee</dt>
                    <dd className="font-semibold tabular-nums">
                      {quote.guaranteed} lead{quote.guaranteed === 1 ? "" : "s"} a month
                    </dd>
                  </div>
                  <div className="flex items-baseline justify-between gap-4">
                    <dt>Cost per guaranteed lead</dt>
                    <dd className="font-semibold tabular-nums">
                      {poundsFromPence(quote.costPerLeadPence!)}
                    </dd>
                  </div>
                  {quote.likelihoodPct != null && (
                    <div className="flex items-baseline justify-between gap-4">
                      <dt>Likelihood of meeting it</dt>
                      <dd className="font-semibold tabular-nums">
                        {quote.likelihoodPct}%
                      </dd>
                    </div>
                  )}
                </dl>
                <p className="text-xs">
                  Based on your plan price of{" "}
                  {poundsFromPence(quote.planPricePence)} a month for{" "}
                  {quote.allocation} leads. If we deliver fewer than{" "}
                  {quote.guaranteed} in a billing month, we add the difference to
                  your lead balance and it carries forward — your subscription
                  amount does not change.
                </p>

                {downgrade && (
                  <p className="rounded-md bg-amber-100/70 px-3 py-2 text-xs">
                    On the {poundsFromPence(downgrade.priceGbp * 100)} plan you
                    would get the same {quote.guaranteed} guaranteed lead
                    {quote.guaranteed === 1 ? "" : "s"} at{" "}
                    <span className="font-semibold">
                      {poundsFromPence(
                        Math.ceil((downgrade.priceGbp * 100) / quote.guaranteed)
                      )}
                    </span>{" "}
                    each instead of{" "}
                    {poundsFromPence(quote.costPerLeadPence!)}.{" "}
                    <a href="/dashboard/settings" className="underline">
                      Change your plan
                    </a>{" "}
                    — it takes effect at your next billing cycle.
                  </p>
                )}

                <label className="flex cursor-pointer items-start gap-2">
                  <input
                    type="checkbox"
                    checked={acceptedGuarantee}
                    onChange={(e) => setAcceptedGuarantee(e.target.checked)}
                    className="mt-0.5 h-4 w-4 shrink-0"
                  />
                  <span>
                    I accept a guarantee of {quote.guaranteed} lead
                    {quote.guaranteed === 1 ? "" : "s"} a month for this filter,
                    at {poundsFromPence(quote.costPerLeadPence!)} per guaranteed
                    lead.
                  </span>
                </label>

                {/* A poor offer is still shown — the customer may have good
                    reasons — but it gets a second, separate step, and the
                    thing that actually helps sits next to it. */}
                {quote.requiresExtraConfirm && (
                  <div className="space-y-2 rounded-md border-[0.5px] border-amber-400 bg-amber-100/70 px-3 py-2">
                    <p className="text-xs">
                      That is a high price per lead. Widening your selection is
                      usually the better move: a bigger area raises the number
                      we can guarantee and brings the cost per lead down.
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
            ) : quote.reason === "unreliable" ? (
              <p className="rounded-md border-[0.5px] border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                {CONSENT_UNRELIABLE}
              </p>
            ) : (
              <p className="rounded-md border-[0.5px] border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
                {quote.offerable
                  ? CONSENT_FULL
                  : "Choose at least one area or a bedroom range to see what we can guarantee."}
              </p>
            )}

            {/* Volumes moved between rendering the quote and accepting it. The
                server refused rather than substituting a number the customer
                never saw. */}
            {restatedQuote && (
              <p className="rounded-md border-[0.5px] border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                Lead volumes have moved since this was quoted. We can now
                guarantee{" "}
                <span className="font-semibold">
                  {restatedQuote.guaranteed} lead
                  {restatedQuote.guaranteed === 1 ? "" : "s"} a month
                </span>
                {restatedQuote.costPerLeadPence != null && (
                  <>
                    {" "}
                    at {poundsFromPence(restatedQuote.costPerLeadPence)} each
                  </>
                )}
                . Review the figures above and accept again to continue.
              </p>
            )}

            {error && <p className="text-sm text-amber-600">{error}</p>}

            <div className="flex flex-wrap gap-2">
              <Button onClick={apply} disabled={busy || blocked}>
                {busy
                  ? "Saving…"
                  : needsAcceptance
                    ? "Accept and apply"
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
function VolumeBar({
  rate,
  allocation,
  amber,
}: {
  rate: number;
  allocation: number;
  amber: boolean;
}) {
  if (allocation <= 0) return null;
  const pct = Math.min(100, Math.max(0, (rate / allocation) * 100));
  return (
    <div
      className="h-2 w-full max-w-xs overflow-hidden rounded-full bg-muted"
      role="img"
      aria-label={`~${rate} of ${allocation} plan leads per month`}
    >
      <div
        className={`h-full rounded-full ${amber ? "bg-amber-500" : "bg-brand"}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

/**
 * The live prediction for the draft selection. Three variants: reliable and at
 * or above the plan (neutral), reliable but below it (amber warning +
 * expansion chips), and too little data to extrapolate (no number shown —
 * a precise rate built on a handful of leads would be false confidence).
 */
function PredictionBox({
  prediction,
  allocation,
  volume,
  productLabel,
  isBelow,
  nothingSelected,
  suggestions,
  onAddArea,
}: {
  prediction: VolumePrediction;
  allocation: number;
  volume: ProductVolume;
  productLabel: string;
  isBelow: boolean;
  nothingSelected: boolean;
  suggestions: ExpansionSuggestion[];
  onAddArea: (area: string) => void;
}) {
  const basis = (
    <p className="text-xs text-muted-foreground">
      Based on {prediction.matchingLeads} matching lead
      {prediction.matchingLeads === 1 ? "" : "s"} since 1 July. Filtered
      matching can only consider leads with a readable postcode and bedroom
      count — {volume.matchableLeads} of {volume.totalLeads}{" "}
      {productLabel.toLowerCase()} leads so far.
    </p>
  );

  const chips = suggestions.length > 0 && (
    <div>
      <p className="text-xs font-medium">
        Nearby areas that would get you closer:
      </p>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {suggestions.map((s) => (
          <button
            key={s.area}
            type="button"
            onClick={() => onAddArea(s.area)}
            className="rounded-full border-[0.5px] border-amber-300 bg-white px-2.5 py-1 text-xs font-medium text-amber-800 hover:bg-amber-100"
          >
            + Add {s.area}
            {s.city !== s.area ? ` (${s.city})` : ""} · +~{s.monthlyRate}/mo
            {s.distanceKm != null &&
              ` · ${Math.max(1, Math.round(s.distanceKm * 0.621))} mi from ${
                s.nearestSelectedArea
                  ? cityForArea(s.nearestSelectedArea) || s.nearestSelectedArea
                  : "your areas"
              }`}
          </button>
        ))}
      </div>
    </div>
  );

  if (!prediction.reliable) {
    return (
      <div className="space-y-3 rounded-md border-[0.5px] border-border bg-muted/40 px-4 py-3">
        <p className="text-sm">
          Only {prediction.matchingLeads} lead
          {prediction.matchingLeads === 1 ? "" : "s"} matching this selection
          {prediction.matchingLeads === 1 ? " has" : " have"} arrived since 1
          July — too little data to predict monthly volume reliably.
        </p>
        {chips}
        {basis}
      </div>
    );
  }

  if (isBelow) {
    return (
      <div className="space-y-3 rounded-md border-[0.5px] border-amber-300 bg-amber-50 px-4 py-3 text-amber-800">
        <p className="text-sm">
          This selection is predicted to produce{" "}
          <span className="font-semibold">
            ~{prediction.displayRate} lead
            {prediction.displayRate === 1 ? "" : "s"}/month — below your plan
            of {allocation}
          </span>
          . This selection is too small to support your full allocation, so the
          number we can guarantee drops with it. Adding areas raises the
          guarantee and lowers the cost per lead.
        </p>
        <VolumeBar
          rate={prediction.displayRate}
          allocation={allocation}
          amber
        />
        {chips}
        {basis}
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded-md border-[0.5px] border-border bg-muted/40 px-4 py-3">
      <p className="text-sm">
        <span className="font-semibold">
          ~{prediction.displayRate} lead
          {prediction.displayRate === 1 ? "" : "s"}/month
        </span>{" "}
        {nothingSelected
          ? "arrive across all areas and sizes — narrow your selection to see its prediction."
          : "match this selection."}{" "}
        {allocation > 0 && (
          <span className="text-muted-foreground">
            Your plan includes {allocation} leads/month.
          </span>
        )}
      </p>
      <VolumeBar
        rate={prediction.displayRate}
        allocation={allocation}
        amber={false}
      />
      {basis}
    </div>
  );
}

function StatusBadge({ status }: { status: FilterStatus }) {
  if (status === "active") return <Badge variant="brand">Filter active</Badge>;
  if (status === "pending_lift")
    return <Badge variant="muted">Lift scheduled</Badge>;
  return <Badge variant="muted">No filter</Badge>;
}

function summariseBedrooms(min: number | null, max: number | null): string {
  if (min == null && max == null) return "Any bedroom size";
  if (min != null && max != null) {
    return min === max
      ? `Exactly ${min} bedroom${min === 1 ? "" : "s"}`
      : `${min}–${max} bedrooms`;
  }
  if (min != null) return `${min}+ bedrooms`;
  return `Up to ${max} bedrooms`;
}

function labelFor(area: string, options: AreaOption[]): string {
  return options.find((o) => o.area === area)?.label ?? area;
}
