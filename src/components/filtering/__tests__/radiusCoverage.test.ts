import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { radiusCoverage } from "@/components/filtering/radiusSearch";

/**
 * ⚠️ First test directory under src/components/. `vitest.config.mts` includes
 * `src/**‍/__tests__/**‍/*.test.ts`, so it is picked up with no config change —
 * and radiusSearch.ts is plain TypeScript with no React in it, so the suite
 * stays inside the "pure units only" constraint that gates the build.
 */

const GB_AREAS = ["BS", "GL", "BA", "SP", "M", "E", "SW"]; // no BT, as shipped

describe("radiusCoverage", () => {
  it("never gates hand-picking", () => {
    expect(
      radiusCoverage({
        isRadiusMode: false,
        resolvedOutcode: "BT1",
        covered: [],
        knownAreas: GB_AREAS,
      })
    ).toEqual({ empty: false, areaUncovered: false, unresolved: false });
  });

  it("is quiet until a postcode actually resolves", () => {
    // An empty box, or a postcode we do not recognise, must read as "nothing
    // typed yet" rather than an error.
    expect(
      radiusCoverage({
        isRadiusMode: true,
        resolvedOutcode: null,
        covered: [],
        knownAreas: GB_AREAS,
      }).empty
    ).toBe(false);
  });

  it("is quiet when the circle covers something", () => {
    expect(
      radiusCoverage({
        isRadiusMode: true,
        resolvedOutcode: "BS1",
        covered: ["BS", "BA"],
        knownAreas: GB_AREAS,
      })
    ).toEqual({ empty: false, areaUncovered: false, unresolved: false });
  });

  it("flags a resolved circle that covers nothing", () => {
    // This is the case that used to apply as an "anywhere" filter.
    expect(
      radiusCoverage({
        isRadiusMode: true,
        resolvedOutcode: "SP1",
        covered: [],
        knownAreas: GB_AREAS,
      })
    ).toEqual({ empty: true, areaUncovered: false, unresolved: false });
  });

  it("⚠️ separates a Northern Ireland postcode from a too-tight circle", () => {
    // BT is in OUTCODE_CENTROIDS (80 outcodes) and absent from the boundary
    // file, so it resolves to a real centre and covers nothing at ANY radius.
    // "Widen the radius" is advice that can never work.
    expect(
      radiusCoverage({
        isRadiusMode: true,
        resolvedOutcode: "BT1",
        covered: [],
        knownAreas: GB_AREAS,
      })
    ).toEqual({ empty: true, areaUncovered: true, unresolved: false });
  });

  it("does not claim we lack coverage while the boundaries are still loading", () => {
    // knownAreas === null means "we do not know yet", which must never be
    // reported as "we do not cover there".
    expect(
      radiusCoverage({
        isRadiusMode: true,
        resolvedOutcode: "BT1",
        covered: [],
        knownAreas: null,
      })
    ).toEqual({ empty: true, areaUncovered: false, unresolved: false });
  });

  it("takes the area off one- and two-letter outcodes alike", () => {
    // E1 -> E, SW1A -> SW, BT1 -> BT. Getting this wrong would call a London
    // postcode uncovered.
    expect(
      radiusCoverage({
        isRadiusMode: true,
        resolvedOutcode: "E1",
        covered: [],
        knownAreas: GB_AREAS,
      }).areaUncovered
    ).toBe(false);
    expect(
      radiusCoverage({
        isRadiusMode: true,
        resolvedOutcode: "SW1A",
        covered: [],
        knownAreas: GB_AREAS,
      }).areaUncovered
    ).toBe(false);
  });

  it("compares areas case-insensitively in both directions", () => {
    expect(
      radiusCoverage({
        isRadiusMode: true,
        resolvedOutcode: "bs1",
        covered: [],
        knownAreas: ["bs"],
      }).areaUncovered
    ).toBe(false);
  });
});

describe("the panel actually gates on it", () => {
  const panel = readFileSync(
    join(process.cwd(), "src/components/dashboard/LeadFilteringPanel.tsx"),
    "utf8"
  )
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1 ")
    .replace(/\s+/g, " ");

  it("derives the state from radiusCoverage rather than a second inline copy", () => {
    expect(panel).toContain("radiusCoverage({");
  });

  it("⚠️ includes radiusEmpty in `blocked`", () => {
    // Without this the Apply button is live and filter_areas is written null,
    // which lead_matches_customer_filter reads as "match every area".
    expect(panel).toMatch(/const blocked =[^;]*radiusEmpty/);
  });

  it("tells the customer which of the two situations they are in", () => {
    expect(panel).toContain("coverageUnavailable={radiusAreaUncovered}");
  });

  it("⚠️ flags radius mode with nothing resolved — the wider door", () => {
    // `empty` only fires once a centre HAS resolved, so with nothing typed —
    // or while the 562 KB boundary file is still in flight — covered is [],
    // nothing was blocked, and Apply wrote the same "anywhere" filter. The
    // first cut of this fix closed one of the two.
    expect(
      radiusCoverage({
        isRadiusMode: true,
        resolvedOutcode: null,
        covered: [],
        knownAreas: GB_AREAS,
      })
    ).toEqual({ empty: false, areaUncovered: false, unresolved: true });
  });

  it("flags it while the boundaries are still loading too", () => {
    expect(
      radiusCoverage({
        isRadiusMode: true,
        resolvedOutcode: null,
        covered: [],
        knownAreas: null,
      }).unresolved
    ).toBe(true);
  });

  it("⚠️ never flags unresolved while hand-picking", () => {
    // An empty area list is a legitimate bedroom-only filter — a real
    // customer has one today — so this must only ever gate radius mode.
    expect(
      radiusCoverage({
        isRadiusMode: false,
        resolvedOutcode: null,
        covered: [],
        knownAreas: GB_AREAS,
      }).unresolved
    ).toBe(false);
  });

  it("stops flagging it once the circle resolves to areas", () => {
    expect(
      radiusCoverage({
        isRadiusMode: true,
        resolvedOutcode: "BS1",
        covered: ["BS"],
        knownAreas: GB_AREAS,
      }).unresolved
    ).toBe(false);
  });
});
