"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { areaLabel } from "@/lib/postcode";
import { parseOutcode, outcodeCentroid } from "@/lib/outcodes";
import { areasWithinRadius, type AreaFeature } from "@/lib/geoRadius";
import { predictMonthlyVolume } from "@/lib/filterPrediction";
import { forecastVolume, recommendedDowngrade } from "@/lib/filterForecast";
import { plansFor } from "@/lib/plans";
import {
  toProductVolume,
  areasInPayload,
  type PublicFilterVolume,
} from "@/lib/publicFilterVolume";
import type { LeadType } from "@/lib/types";

/**
 * "What would I actually get?", answered before signing up.
 *
 * Runs the SAME functions the dashboard does — predictMonthlyVolume,
 * forecastVolume — against a cached, already-contention-adjusted payload. That
 * parity is the point: a prospect shown four leads a month at £25 should see
 * exactly that on their first day, or the estimator is a lie with a signup
 * button under it.
 *
 * ⚠️ NOTHING HERE MAY PROMISE ANYTHING. This is the surface where an
 * over-promise is least recoverable, because a prospect quotes it back at
 * signup. It says what they can expect and how confident we are; it never says
 * what we would do if we fell short, because the answer is nothing.
 *
 * The markup is deliberately its own rather than shared with
 * LeadFilteringPanel. The two answer different questions — "should I buy this"
 * versus "let me adjust my filter" — and the duplication that would actually
 * hurt is duplicated MATHS, which the imports above prevent.
 */

const MILES_TO_KM = 1.60934;

function poundsFromPence(pence: number): string {
  const pounds = pence / 100;
  return `£${pounds % 1 === 0 ? pounds.toFixed(0) : pounds.toFixed(2)}`;
}

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
  const [postcode, setPostcode] = useState("");
  const [miles, setMiles] = useState(20);
  const [picked, setPicked] = useState<string[]>([]);
  const [features, setFeatures] = useState<AreaFeature[] | null>(null);

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

  // Boundary polygons, fetched only if the visitor actually uses radius mode.
  useEffect(() => {
    if (mode !== "radius" || features) return;
    let alive = true;
    fetch("/data/uk-postcode-areas.geojson")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => alive && setFeatures(d.features as AreaFeature[]))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [mode, features]);

  const volume = useMemo(
    () => (payload ? toProductVolume(payload, product) : null),
    [payload, product]
  );
  const allAreas = useMemo(
    () => (payload ? areasInPayload(payload) : []),
    [payload]
  );

  const radiusAreas = useMemo(() => {
    if (mode !== "radius" || !features) return null;
    const outcode = parseOutcode(postcode);
    if (!outcode) return null;
    const centre = outcodeCentroid(outcode);
    if (!centre) return null;
    return areasWithinRadius(features, centre, miles * MILES_TO_KM);
  }, [mode, features, postcode, miles]);

  // Memoised so the quote below is not recomputed on every render — the
  // conditional would otherwise produce a fresh array identity each time.
  const selectedAreas = useMemo(
    () => (mode === "radius" ? (radiusAreas ?? []) : picked),
    [mode, radiusAreas, picked]
  );
  const hasSelection = selectedAreas.length > 0;

  const quote = useMemo(() => {
    if (!volume || !hasSelection) return null;
    const prediction = predictMonthlyVolume(volume, {
      areas: selectedAreas,
      minBedrooms: null,
      maxBedrooms: null,
    });
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
  }, [volume, hasSelection, selectedAreas, product]);

  if (loadFailed) return null;

  return (
    <div className="rounded-lg border-[0.5px] border-border bg-card p-5">
      <h3 className="text-lg font-semibold">
        See what you&rsquo;d get in your area
      </h3>
      <p className="mt-1 text-sm text-muted-foreground">
        Pick where you work and we&rsquo;ll show you the leads a month you can
        expect, and what that works out at each — before you sign up.
      </p>

      <div className="mt-4 flex gap-2 text-sm">
        <button
          type="button"
          onClick={() => setMode("radius")}
          className={`rounded-md px-3 py-1.5 ${mode === "radius" ? "bg-primary text-primary-foreground" : "bg-muted"}`}
        >
          Around a postcode
        </button>
        <button
          type="button"
          onClick={() => setMode("areas")}
          className={`rounded-md px-3 py-1.5 ${mode === "areas" ? "bg-primary text-primary-foreground" : "bg-muted"}`}
        >
          Pick areas
        </button>
      </div>

      {mode === "radius" ? (
        <div className="mt-4 space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label className="text-xs text-muted-foreground">Your postcode</label>
              <Input
                value={postcode}
                onChange={(e) => setPostcode(e.target.value)}
                placeholder="e.g. LS1"
                className="mt-1 w-36"
              />
            </div>
            <div className="min-w-[10rem] flex-1">
              <label className="text-xs text-muted-foreground">
                Within {miles} miles
              </label>
              <input
                type="range"
                min={5}
                max={100}
                step={5}
                value={miles}
                onChange={(e) => setMiles(Number(e.target.value))}
                className="mt-2 w-full"
              />
            </div>
          </div>
          {postcode && !radiusAreas && (
            <p className="text-xs text-muted-foreground">
              Enter a postcode like LS1 or M20 to see the areas it covers.
            </p>
          )}
          {radiusAreas && radiusAreas.length > 0 && (
            <p className="text-xs text-muted-foreground">
              Covers {radiusAreas.slice(0, 8).join(", ")}
              {radiusAreas.length > 8 ? ` and ${radiusAreas.length - 8} more` : ""}.
            </p>
          )}
        </div>
      ) : (
        <div className="mt-4 flex max-h-40 flex-wrap gap-1.5 overflow-y-auto">
          {allAreas.map((a) => {
            const on = picked.includes(a);
            return (
              <button
                key={a}
                type="button"
                onClick={() =>
                  setPicked((p) =>
                    p.includes(a) ? p.filter((x) => x !== a) : [...p, a]
                  )
                }
                className={`rounded-md px-2 py-1 text-xs ${on ? "bg-primary text-primary-foreground" : "bg-muted"}`}
                title={areaLabel(a)}
              >
                {a}
              </button>
            );
          })}
        </div>
      )}

      {quote && (
        <div className="mt-5 rounded-md border-[0.5px] border-border bg-muted/40 p-4">
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
                    {poundsFromPence(quote.quote.costPerLeadPence!)}
                  </dd>
                </div>
              </dl>
              <p className="mt-3 text-xs text-muted-foreground">
                On the {poundsFromPence(quote.plan.priceGbp * 100)} a month plan,
                based on how many matching leads have actually come through these
                areas. It is a forecast rather than a promise — some months are
                quieter than others.
              </p>
              <Button asChild className="mt-4">
                <a href={signupHref}>Get started</a>
              </Button>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              Not many leads have come through this selection yet, so we
              can&rsquo;t put a number on it. Try a wider radius or a few more
              areas.
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
