"use client";

import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { cityForArea } from "@/lib/postcode";
import {
  RADIUS_MILE_OPTIONS,
  type RadiusResolution,
} from "@/components/filtering/radiusSearch";
import { summariseAreas } from "@/components/filtering/format";

/**
 * Radius search: one box taking a postcode OR a town, the distance select, and
 * everything that follows from resolving them — the town dropdown, the
 * coverage sentence, the whole-postcode-area caveat, the widen prompt and the
 * four failure states.
 *
 * Presentational only: it resolves nothing itself, because parseRadiusCentre
 * and resolveRadius are pure and the caller owns both fetches. That split is
 * what lets the public estimator show the same failure states instead of
 * swallowing them in a `.catch(() => {})`.
 */
export function RadiusControls({
  idPrefix,
  query,
  miles,
  onQueryChange,
  onMilesChange,
  geoFailed,
  loading,
  resolution,
  coverageUnavailable = false,
}: {
  idPrefix: string;
  /** A postcode or a town name — one box takes either. */
  query: string;
  miles: number;
  onQueryChange: (v: string) => void;
  onMilesChange: (v: number) => void;
  /** Either file could not be loaded — radius search is unavailable. */
  geoFailed: boolean;
  /**
   * Either file still in flight.
   *
   * ⚠️ Renamed from `geoLoading`: there are two fetches now and a visitor does
   * not care which of them is slow.
   */
  loading: boolean;
  /** Null until there is something to resolve. */
  resolution: RadiusResolution | null;
  /**
   * The circle resolved to no areas AND we hold no boundary for that postcode
   * area at all — so widening can never help and must not be suggested.
   */
  coverageUnavailable?: boolean;
}) {
  const suggestions = resolution?.suggestions ?? [];
  const centre = resolution?.centre ?? null;
  const listId = `${idPrefix}-radius-suggestions`;

  // Keyboard handling mirrors CommandPalette rather than inventing its own:
  // cursor reset per keystroke, clamped arrows with preventDefault, Enter
  // picks, hover moves. Escape closes without clearing what they typed.
  const [cursor, setCursor] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => setCursor(0), [query]);
  useEffect(() => setDismissed(false), [query]);
  const open = suggestions.length > 0 && !dismissed;

  function pick(index: number) {
    const hit = suggestions[index];
    if (!hit) return;
    // ⚠️ The canonical NAME, not the label: the box is a search box, and
    // putting "Newport (NP20)" in it makes the next keystroke unparseable.
    onQueryChange(hit.name);
    setDismissed(true);
  }

  const areas = summariseAreas(resolution?.covered ?? [], (a) =>
    cityForArea(a) && cityForArea(a) !== a ? `${a} — ${cityForArea(a)}` : a
  );

  return (
    <div className="mt-2 space-y-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="relative flex-1">
          <label
            htmlFor={`${idPrefix}-radius-centre`}
            className="block text-xs text-muted-foreground"
          >
            Your postcode or town
          </label>
          <Input
            id={`${idPrefix}-radius-centre`}
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder="e.g. SP1 or Salisbury"
            /* ⚠️ NOT autoComplete="postal-code". On a box that now takes town
               names Chrome offers the saved postcode over our own list, and
               can overwrite a half-typed name. */
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            role="combobox"
            aria-expanded={open}
            aria-controls={listId}
            aria-autocomplete="list"
            onKeyDown={(e) => {
              if (!open) return;
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setCursor((c) => Math.min(c + 1, suggestions.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setCursor((c) => Math.max(c - 1, 0));
              } else if (e.key === "Enter") {
                e.preventDefault();
                pick(cursor);
              } else if (e.key === "Escape") {
                e.preventDefault();
                setDismissed(true);
              }
            }}
          />
          {open && (
            <ul
              id={listId}
              role="listbox"
              className="absolute z-20 mt-1 w-full overflow-hidden rounded-md border-[0.5px] border-border bg-background shadow-lg"
            >
              {suggestions.map((s, i) => (
                <li key={`${s.name}:${s.outcode}`} role="option" aria-selected={i === cursor}>
                  <button
                    type="button"
                    onMouseEnter={() => setCursor(i)}
                    onClick={() => pick(i)}
                    className={`block w-full px-3 py-2 text-left text-sm ${
                      i === cursor ? "bg-muted" : ""
                    }`}
                  >
                    {s.label}
                  </button>
                </li>
              ))}
            </ul>
          )}
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
            {RADIUS_MILE_OPTIONS.map((m) => (
              <option key={m} value={m}>
                {m} miles
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Four states now, and the fourth is not an error. */}
      {geoFailed && (
        <p className="text-sm text-amber-600">
          The area boundaries could not be loaded, so radius search is
          unavailable right now. You can still pick areas by hand.
        </p>
      )}
      {loading && !geoFailed && (
        <p className="text-sm text-muted-foreground">Loading area data…</p>
      )}
      {open && !centre && (
        /* Neutral, deliberately: several towns share a name and picking one is
           an ordinary thing to ask, not a mistake to flag in amber. */
        <p className="text-sm text-muted-foreground">
          Which one did you mean? Pick from the list above.
        </p>
      )}
      {resolution &&
        !centre &&
        suggestions.length === 0 &&
        query.trim() !== "" &&
        !loading &&
        !geoFailed &&
        (resolution.looksLikePostcode ? (
          <p className="text-sm text-amber-600">
            We don&apos;t recognise that postcode — check it, or try just its
            first half (e.g. LE67).
          </p>
        ) : (
          <p className="text-sm text-amber-600">
            We don&apos;t know a place called &ldquo;{query.trim()}&rdquo;. Try
            a nearby town, or type your postcode.
          </p>
        ))}

      {resolution && centre && (
        <div className="space-y-2">
          <p className="text-sm">
            Within {miles} miles of{" "}
            <span className="font-semibold">{centre.label}</span> you&apos;d
            receive leads from:{" "}
            {resolution.covered.length > 0 ? (
              <span className="font-medium">
                {areas.head.join(", ")}
                {areas.rest.length > 0 && (
                  <>
                    {" "}
                    <details className="mt-1 inline">
                      <summary className="cursor-pointer font-normal text-muted-foreground">
                        and {areas.rest.length} more
                      </summary>
                      <span className="font-medium">{areas.rest.join(", ")}</span>
                    </details>
                  </>
                )}
              </span>
            ) : coverageUnavailable ? (
              <span className="text-amber-600">
                no postcode areas. We don&apos;t cover that part of the UK yet,
                so a wider radius won&apos;t help — pick areas by hand, or try a
                postcode on the mainland.
              </span>
            ) : (
              <span className="text-amber-600">
                no postcode areas — widen the radius before applying.
              </span>
            )}
          </p>
          <p className="text-xs text-muted-foreground">
            Leads are matched by postcode area, so your filter covers each of
            these areas in full — including the parts beyond your radius.
          </p>
          {areas.nearNational && (
            /* Past ~40 areas the caveat above stops being a footnote: a
               100-mile circle from Northampton touches 78 of ~120. */
            <p className="text-xs text-amber-600">
              That&apos;s most of Great Britain — leads will come from anywhere
              in these areas, not just within {miles} miles.
            </p>
          )}
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
    </div>
  );
}
