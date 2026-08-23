"use client";

import { Input } from "@/components/ui/input";
import { cityForArea } from "@/lib/postcode";
import type { RadiusResolution } from "@/components/filtering/radiusSearch";

/**
 * Radius search: the postcode box, the distance select, and everything that
 * follows from resolving them — the coverage sentence, the "leads are matched
 * by whole postcode area" caveat, the widen-search prompt, and the three
 * failure states.
 *
 * Lifted verbatim out of LeadFilteringPanel. Presentational only: it resolves
 * nothing itself, because `resolveRadius` is already pure and the caller owns
 * the geojson. That split is what lets the public estimator show the same
 * failure states instead of swallowing them in a `.catch(() => {})`.
 */
export function RadiusControls({
  idPrefix,
  postcode,
  miles,
  onPostcodeChange,
  onMilesChange,
  geoFailed,
  geoLoading,
  resolution,
}: {
  idPrefix: string;
  postcode: string;
  miles: number;
  onPostcodeChange: (v: string) => void;
  onMilesChange: (v: number) => void;
  /** Boundaries could not be loaded at all — radius search is unavailable. */
  geoFailed: boolean;
  /** Boundaries still in flight. */
  geoLoading: boolean;
  /** Null until there is something to resolve. */
  resolution: RadiusResolution | null;
}) {
  return (
    <div className="mt-2 space-y-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="flex-1">
          <label
            htmlFor={`${idPrefix}-radius-postcode`}
            className="block text-xs text-muted-foreground"
          >
            Your business postcode
          </label>
          <Input
            id={`${idPrefix}-radius-postcode`}
            value={postcode}
            onChange={(e) => onPostcodeChange(e.target.value)}
            placeholder="e.g. LE67 8QN"
            autoComplete="postal-code"
          />
        </div>
        <div>
          <label
            htmlFor={`${idPrefix}-radius-miles`}
            className="block text-xs text-muted-foreground"
          >
            Radius
          </label>
          <select
            id={`${idPrefix}-radius-miles`}
            value={miles}
            onChange={(e) => onMilesChange(parseInt(e.target.value, 10))}
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
      {geoLoading && !geoFailed && (
        <p className="text-sm text-muted-foreground">
          Loading area boundaries…
        </p>
      )}
      {resolution &&
        resolution.outcode === null &&
        postcode.trim() !== "" && (
          <p className="text-sm text-amber-600">
            We don't recognise that postcode — check it, or
            try just its first half (e.g. LE67).
          </p>
        )}

      {resolution && resolution.outcode !== null && (
        <div className="space-y-2">
          <p className="text-sm">
            Within {miles} miles of{" "}
            <span className="font-semibold">
              {resolution.outcode}
            </span>{" "}
            you'd receive leads from:{" "}
            {resolution.covered.length > 0 ? (
              <span className="font-medium">
                {resolution.covered
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
          {resolution.upside && (
            <p className="text-sm">
              Widening to{" "}
              <span className="font-semibold">
                {miles + resolution.upside.extraMiles} miles
              </span>{" "}
              would add{" "}
              {resolution.upside.newAreas
                .map((a) => cityForArea(a) || a)
                .join(", ")}{" "}
              — about{" "}
              <span className="font-semibold">
                +{resolution.upside.extraRate} lead
                {resolution.upside.extraRate === 1 ? "" : "s"}
                /month
              </span>
              .{" "}
              <button
                type="button"
                onClick={() =>
                  onMilesChange(miles + resolution.upside!.extraMiles)
                }
                className="font-medium text-brand hover:underline"
              >
                Widen search
              </button>
            </p>
          )}
        </div>
      )}
    </div>  );
}
