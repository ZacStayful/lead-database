import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  RADIUS_MILE_OPTIONS,
  resolveRadius,
  wideningStepsFrom,
} from "@/components/filtering/radiusSearch";
import type { ProductVolume } from "@/lib/filterPrediction";
import type { AreaFeature } from "@/lib/geoRadius";

/**
 * "Widen search" offered distances the dropdown could not show.
 *
 * The scan tried a literal `[5,10,15,20,25,30]` of EXTRA miles against a list
 * of ABSOLUTE ones, so from 50 miles it proposed 55…80 — none an <option>, and
 * accepting one left the select with nothing selected. From 30 and 40 most
 * steps missed too. Both now derive from RADIUS_MILE_OPTIONS.
 *
 * ⚠️ These live under src/components/ rather than src/lib/ — inside
 * vitest.config.mts's glob, and radiusSearch.ts has no React in it, so the
 * suite stays within the "pure units only" constraint that gates the build.
 */

// ── synthetic geography ──────────────────────────────────────────────────
// Square areas due east of the centre, so an area's NEAREST boundary sits at a
// chosen mile distance. Real boundaries are not used: the point is which step
// the scan takes, not whether the geojson is right.
const CENTRE: [number, number] = [51.5, 0];
const MILES_PER_DEG_LNG = (111.32 * Math.cos((51.5 * Math.PI) / 180)) / 1.60934;

function areaAtMiles(area: string, milesEast: number): AreaFeature {
  const w = milesEast / MILES_PER_DEG_LNG;
  const e = (milesEast + 1) / MILES_PER_DEG_LNG;
  return {
    properties: { area },
    geometry: {
      type: "MultiPolygon",
      coordinates: [
        [
          [
            [w, 51.4],
            [e, 51.4],
            [e, 51.6],
            [w, 51.6],
            [w, 51.4],
          ],
        ],
      ],
    },
  };
}

/** One lead per area, so every area added by a widening raises the rate. */
function volumeFor(areas: string[]): ProductVolume {
  const areaBedCounts: Record<string, Record<string, number>> = {};
  for (const a of areas) areaBedCounts[a] = { "3": 40 };
  return {
    windowStart: "2026-01-01T00:00:00.000Z",
    weeksElapsed: 4,
    totalLeads: areas.length * 40,
    matchableLeads: areas.length * 40,
    areaBedCounts,
  };
}

const ANY_BEDS = { minBedrooms: null, maxBedrooms: null };

describe("wideningStepsFrom", () => {
  it("⚠️ every step it offers lands on the option list", () => {
    // The whole bug in one assertion. Run from every option AND from off-list
    // values, because a saved filter can carry one.
    const options = [...RADIUS_MILE_OPTIONS] as number[];
    for (const from of [...options, 1, 7, 12, 35, 45, 60, 100]) {
      for (const step of wideningStepsFrom(from)) {
        expect(options, `widening ${from} by ${step}`).toContain(from + step);
      }
    }
  });

  it("offers nothing at the top of the list", () => {
    // Not "offers the biggest step": there is no larger setting to move to, so
    // proposing one is an offer that cannot be taken. Derived from the
    // constant, so it stays true if the list is ever re-scaled.
    const max = Math.max(...RADIUS_MILE_OPTIONS);
    expect(wideningStepsFrom(max)).toEqual([]);
    expect(wideningStepsFrom(max + 30)).toEqual([]);
  });

  it("widens an off-list value onto the list", () => {
    // A radius saved before the list changed must still be able to widen.
    expect(wideningStepsFrom(35)).toEqual([5, 15]);
  });

  it("offers every larger option, smallest first", () => {
    // ⚠️ Deliberately literal, against TODAY's list. Re-scaling the distances
    // should fail here and be re-read, not quietly pass.
    expect(wideningStepsFrom(30)).toEqual([10, 20]);
    expect(wideningStepsFrom(5)).toEqual([5, 10, 15, 20, 25, 35, 45]);
    expect([...RADIUS_MILE_OPTIONS]).toEqual([5, 10, 15, 20, 25, 30, 40, 50]);
  });

  it("every step is a real increase", () => {
    for (const from of [...RADIUS_MILE_OPTIONS]) {
      for (const step of wideningStepsFrom(from)) expect(step).toBeGreaterThan(0);
    }
  });
});

describe("resolveRadius uses the option list", () => {
  const features = [
    areaAtMiles("AA", 3),
    areaAtMiles("BB", 12),
    areaAtMiles("CC", 28),
    areaAtMiles("DD", 45),
    areaAtMiles("EE", 70),
  ];
  const volume = volumeFor(["AA", "BB", "CC", "DD", "EE"]);
  const run = (miles: number) =>
    resolveRadius(features, CENTRE, miles, volume, ANY_BEDS);

  it("⚠️ never proposes a distance the dropdown cannot show", () => {
    const options = [...RADIUS_MILE_OPTIONS] as number[];
    for (const miles of options) {
      const { upside } = run(miles);
      if (upside) expect(options).toContain(miles + upside.extraMiles);
    }
  });

  it("stops at the FIRST gaining step, not the best one", () => {
    // From 5 miles BB sits at 12, so 15 is the smallest option that gains.
    const { upside } = run(5);
    expect(upside?.extraMiles).toBe(10);
    expect(upside?.newAreas).toEqual(["BB"]);
  });

  it("skips a step that touches no new areas", () => {
    // From 30, 40 miles adds nothing (DD is at 45); 50 does.
    const { upside } = run(30);
    expect(upside?.extraMiles).toBe(20);
    expect(upside?.newAreas).toEqual(["DD"]);
  });

  it("⚠️ offers nothing from the largest option, even with leads beyond it", () => {
    // EE sits at 70 miles and is genuinely there. Offering it would have named
    // 55–80, which is exactly the defect.
    expect(run(50).covered).toEqual(["AA", "BB", "CC", "DD"]);
    expect(run(50).upside).toBeNull();
  });
});

/**
 * ⚠️ Comments stripped: both files explain the rule, and explaining it means
 * naming the constant — so a raw substring check passes on the explanation and
 * trains the next person to delete the explanation (§51.11). Whitespace is
 * collapsed too, because Prettier wraps a JSX map freely.
 */
describe("one list, read by everything", () => {
  const source = (file: string) =>
    readFileSync(resolve(__dirname, "..", file), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/\s+/g, " ");

  it("the dropdown maps the constant and carries no list of its own", () => {
    const src = source("RadiusControls.tsx");
    expect(src).toContain("RADIUS_MILE_OPTIONS.map(");
    expect(src).not.toMatch(/\[\s*5\s*,\s*10\s*,/);
  });

  it("the scan reads it too, rather than a literal of extra miles", () => {
    const src = source("radiusSearch.ts");
    expect(src).toContain("for (const extra of wideningStepsFrom(miles))");
    expect(src).not.toMatch(/of \[\s*5\s*,\s*10\s*,/);
  });
});
