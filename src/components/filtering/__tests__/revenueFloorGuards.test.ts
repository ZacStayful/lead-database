import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  canFilterByGross,
  GROSS_THRESHOLDS,
  INGEST_EPOCH_ISO,
  type ProductVolume,
} from "@/lib/filterPrediction";

/**
 * ⚠️ FILE-TEXT, BECAUSE NOTHING ELSE CAN SEE THIS.
 *
 * `vitest.config.mts` is PURE UNITS ONLY — no React — so a dropped prop, a
 * missing dep in a `useEffect`, or a control that is simply never mounted is
 * invisible to the entire suite. §66.2 is the standing proof: `radiusCoverage`
 * was correct and unit-tested, and `LeadEstimator` never called it, so every
 * Northern Ireland postcode read the wrong advice on two landing pages for a
 * fortnight. A behavioural test could not have caught it; this shape can.
 *
 * Comments are stripped first: several of these files EXPLAIN the rule they
 * follow and name the very tokens being matched, so a naive substring check
 * passes on the explanation and trains the next person to delete it (§46).
 */
const strip = (p: string) =>
  readFileSync(resolve(__dirname, p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const flat = (p: string) => strip(p).replace(/\s+/g, " ");

const panel = flat("../../dashboard/LeadFilteringPanel.tsx");
const estimator = flat("../../marketing/LeadEstimator.tsx");
const control = flat("../RevenueFloor.tsx");

describe("⚠️ the control is MOUNTED on both surfaces", () => {
  it("the dashboard renders it with the draft state", () => {
    expect(panel).toContain("<RevenueFloor");
    expect(panel).toMatch(/<RevenueFloor[\s\S]{0,200}value=\{minGross\}/);
    expect(panel).toMatch(/<RevenueFloor[\s\S]{0,200}onChange=\{setMinGross\}/);
  });

  it("the public estimator renders it too", () => {
    expect(estimator).toContain("<RevenueFloor");
    expect(estimator).toMatch(/<RevenueFloor[\s\S]{0,200}value=\{minGross\}/);
  });

  it("⚠️ both pass a REAL volume, not a literal", () => {
    // `canFilterByGross` is the gate, and it reads the volume. A hard-coded
    // object would satisfy a naive "passes the prop" assertion while the gate
    // decided on data that is not the page's.
    expect(panel).toMatch(/<RevenueFloor[\s\S]{0,200}volume=\{props\.volume\}\s/);
    expect(estimator).toMatch(/<RevenueFloor[\s\S]{0,200}volume=\{volume\}\s/);
    // A synthesised volume would decide the gate on data that is not the
    // page's — the control would offer itself against bands nobody measured.
    expect(panel).not.toMatch(/<RevenueFloor[\s\S]{0,200}areaBedBandCounts/);
    expect(estimator).not.toMatch(/<RevenueFloor[\s\S]{0,200}areaBedBandCounts/);
  });
});

describe("⚠️ the floor is in EVERY dependency list it belongs in", () => {
  it("the draft selection memo carries the DRAFT floor, and depends on it", () => {
    // ⚠️ The shorthand `minGross,` with no `.` before it. `props.minGross,`
    // contains the substring `minGross,`, so a looser pattern passes while
    // the memo silently reads the SAVED floor and the control changes
    // nothing — which is exactly what the mutation run found.
    expect(panel).toMatch(
      /const draftSelection[\s\S]{0,700}[^.\w]minGross,[\s\S]{0,120}\[selectedAreas, minBeds, maxBeds, minGross\]/
    );
    expect(panel).not.toMatch(/const draftSelection[\s\S]{0,700}minGross: props\.minGross/);
  });

  it("⚠️ THE ACKNOWLEDGEMENT-VOIDING EFFECT DEPENDS ON IT", () => {
    // The single most consequential line in this change. Without it the
    // customer acknowledges one forecast, changes the floor, and applies
    // against a stale acknowledgement — defeating §39.8's fixed refusal order,
    // which exists precisely so the number they were shown is the whole of
    // what they were told. Nothing warns: there is no ESLint config (§11).
    expect(panel).toMatch(
      /setReleaseDecision\(null\);[\s\S]{0,200}\}, \[selectedAreas, minBeds, maxBeds, minGross\]\);/
    );
  });

  it("the estimator's constraints memo depends on it", () => {
    expect(estimator).toMatch(/minGross,[\s\S]{0,60}\[minBeds, maxBeds, minGross\]/);
  });
});

describe("⚠️ a floor alone counts as a selection", () => {
  it("the dashboard does not read it as 'nothing selected'", () => {
    // PredictionBox renders its "pick something" state off this. A floor on
    // its own is a real selection, and the route accepts it.
    expect(panel).toMatch(
      /selectedAreas\.length === 0 && minBeds === "" && maxBeds === "" && minGross === null/
    );
  });

  it("the estimator's hasSelection includes it", () => {
    expect(estimator).toMatch(/constraints\.maxBedrooms != null \|\| constraints\.minGross != null/);
  });
});

describe("⚠️ the apply request carries it", () => {
  it("the POST body sends min_gross", () => {
    expect(panel).toMatch(/action: "apply",[\s\S]{0,400}min_gross: minGross,/);
  });
});

describe("⚠️ the control withholds itself rather than quoting zero", () => {
  it("returns null for GR and for a source that cannot answer", () => {
    expect(control).toMatch(
      /if \(product !== "management" \|\| !canFilterByGross\(volume\)\) return null;/
    );
  });

  it("offers exactly the thresholds, from the constant", () => {
    expect(control).toContain("GROSS_THRESHOLDS.map");
    expect(control).toContain("formatGrossThreshold(t)");
    // Never a hand-written list: the SQL CHECK is asserted against the same
    // constant, so a literal here is how the two drift.
    for (const t of GROSS_THRESHOLDS) {
      expect(control).not.toContain(`value="${t}"`);
    }
  });

  it("⚠️ names it as the PROPERTY's revenue, not the operator's", () => {
    expect(control).toContain("Minimum property revenue");
    expect(control).toContain("the property would gross");
  });

  it("says the no-figure leads are excluded, because they are", () => {
    expect(control).toContain("no revenue analysis for are excluded");
  });
});

describe("canFilterByGross — the gate the control keys on", () => {
  const base = {
    windowStart: INGEST_EPOCH_ISO,
    weeksElapsed: 7.5,
    totalLeads: 20,
    matchableLeads: 20,
    areaBedCounts: { LS: { "3": 20 } },
  };

  it("false for a source with NULL bands — an old public payload", () => {
    expect(canFilterByGross({ ...base, areaBedBandCounts: null } as ProductVolume)).toBe(false);
  });

  it("true once the bands are there", () => {
    expect(
      canFilterByGross({
        ...base,
        areaBedBandCounts: { LS: { "3": { "50000": 20 } } },
      } as ProductVolume)
    ).toBe(true);
  });
});
