import { describe, it, expect } from "vitest";
import {
  areaOfOutcode,
  distancesFrom,
  milesBetween,
  outcodeOfPostcode,
  outcodesWithin,
} from "@/lib/leadBrief/geo";
import { defaultRanking, normaliseBriefInput, parseBasePostcode } from "@/lib/leadBrief/input";

describe("outcodeOfPostcode — the JS mirror of leads.outcode (0161)", () => {
  // The same cases supabase/tests/0162_lead_brief_schema_test.sql runs
  // against the generated column, so the two are checked on one list.
  it.each([
    ["YO10 5DD", "YO10"],
    [" yo10 5dd ", "YO10"],
    ["M50 2HN", "M50"],
    ["EC1A 1BB", "EC1A"],
    ["LS2", null],
    [null, null],
    ["YO105DD", "YO10"],
    ["B22 2AX", "B22"],
  ])("%s → %s", (postcode, outcode) => {
    expect(outcodeOfPostcode(postcode)).toBe(outcode);
  });

  it("⚠️ trims spaces only, as btrim does — a leading tab is not a postcode", () => {
    expect(outcodeOfPostcode("\tYO10 5DD")).toBeNull();
  });
});

describe("distances", () => {
  it("puts the base first at zero and orders the rest nearest first", () => {
    const d = distancesFrom("YO10")!;
    const first = Array.from(d)[0];
    expect(first).toEqual(["YO10", 0]);
    const values = Array.from(d.values());
    for (let i = 1; i < values.length; i++) expect(values[i]).toBeGreaterThanOrEqual(values[i - 1]);
  });

  it("returns null for an outcode with no centroid", () => {
    expect(distancesFrom("M50")).toBeNull();
    expect(milesBetween("M50", "YO10")).toBeNull();
  });

  it("measures York to Leeds at roughly 22 miles", () => {
    const miles = milesBetween("YO1", "LS1")!;
    expect(miles).toBeGreaterThan(18);
    expect(miles).toBeLessThan(26);
  });

  it("outcodesWithin stops at the radius", () => {
    const d = distancesFrom("YO10")!;
    const within = outcodesWithin(d, 10);
    expect(within[0]).toBe("YO10");
    for (const oc of within) expect(d.get(oc)!).toBeLessThanOrEqual(10);
    expect(within).not.toContain("LS1");
  });

  it("areaOfOutcode takes the leading letters", () => {
    expect(areaOfOutcode("YO10")).toBe("YO");
    expect(areaOfOutcode("EC1A")).toBe("EC");
    expect(areaOfOutcode("M5")).toBe("M");
  });
});

describe("parseBasePostcode", () => {
  it.each([
    ["YO10 5DD", "YO10 5DD", "YO10"],
    ["yo105dd", "YO10 5DD", "YO10"],
    ["  YO10   5DD ", "YO10 5DD", "YO10"],
    ["YO10", "YO10", "YO10"],
    // The outward/inward split is decided by the inward code's shape.
    ["YO10DD", "YO1 0DD", "YO1"],
    ["M11AE", "M1 1AE", "M1"],
    ["EC1A1BB", "EC1A 1BB", "EC1A"],
  ])("%s → %s (%s)", (raw, postcode, outcode) => {
    expect(parseBasePostcode(raw)).toEqual({ basePostcode: postcode, baseOutcode: outcode });
  });

  it.each(["", "York", "12345", "YO10 5D"])("refuses %j", (raw) => {
    expect(parseBasePostcode(raw)).toBeNull();
  });

  it("⚠️ always produces what the 0162 base_postcode CHECK accepts", () => {
    const re = /^[A-Z]{1,2}[0-9][A-Z0-9]?( [0-9][A-Z]{2})?$/;
    for (const raw of ["yo105dd", "YO10", "M11AE", "ec1a1bb", " ls6 1aa "]) {
      expect(parseBasePostcode(raw)!.basePostcode).toMatch(re);
    }
  });
});

describe("defaultRanking (A8)", () => {
  it("is location, revenue, bedrooms, occupancy with no essentials", () => {
    expect(defaultRanking([])).toEqual(["location", "revenue", "bedrooms", "occupancy"]);
  });

  it("puts a chosen essential straight after location", () => {
    expect(defaultRanking(["bedrooms"])).toEqual(["location", "bedrooms", "revenue", "occupancy"]);
    expect(defaultRanking(["revenue"])).toEqual(["location", "revenue", "bedrooms", "occupancy"]);
  });

  it("does not depend on the order the essentials were ticked in", () => {
    expect(defaultRanking(["bedrooms", "revenue"])).toEqual(defaultRanking(["revenue", "bedrooms"]));
  });
});

describe("normaliseBriefInput", () => {
  it("accepts a plain brief and derives the mode", () => {
    const r = normaliseBriefInput({ basePostcode: "yo10 5dd", travelLimitMiles: 25 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.brief).toMatchObject({
      basePostcode: "YO10 5DD",
      baseOutcode: "YO10",
      operatingMode: "growing",
      essentials: [],
      minBedrooms: null,
      minGross: null,
      ranking: ["location", "revenue", "bedrooms", "occupancy"],
    });
  });

  it("lists essentials and their thresholds", () => {
    const r = normaliseBriefInput({
      basePostcode: "YO10",
      travelLimitMiles: null,
      minBedrooms: 3,
      minGross: 50000,
    });
    expect(r.ok && r.brief.essentials).toEqual(["revenue", "bedrooms"]);
  });

  it("allows a bedroom minimum or threshold up to 5, and no higher", () => {
    const r = normaliseBriefInput({
      basePostcode: "YO10",
      travelLimitMiles: null,
      minBedrooms: 5,
      thresholds: { bedrooms: 5 },
    });
    expect(r.ok && r.brief.minBedrooms).toBe(5);
    expect(r.ok && r.brief.thresholds.bedrooms).toBe(5);
  });

  it("⚠️ refuses a base with no centroid (M50 is real but cannot be placed)", () => {
    const r = normaliseBriefInput({ basePostcode: "M50 2HN", travelLimitMiles: 10 });
    expect(r).toEqual({ ok: false, issues: [{ code: "base_outcode_unplaceable", outcode: "M50" }] });
  });

  it.each([
    [{ travelLimitMiles: 30 as never }, "travel_limit_invalid"],
    [{ minGross: 45000 }, "min_gross_invalid"],
    [{ minBedrooms: 0 }, "min_bedrooms_invalid"],
    [{ minBedrooms: 2.5 }, "min_bedrooms_invalid"],
    [{ minBedrooms: 6 }, "min_bedrooms_invalid"],
    [{ ranking: ["location", "location"] as never }, "ranking_invalid"],
    [{ similarAreas: ["YO10"] }, "similar_area_invalid"],
    [{ thresholds: { revenue: -1 } }, "threshold_invalid"],
    [{ thresholds: { bedrooms: 6 } }, "threshold_invalid"],
    [{ thresholds: { bedrooms: 3.5 } }, "threshold_invalid"],
  ])("refuses %j", (extra, code) => {
    const r = normaliseBriefInput({ basePostcode: "YO10", travelLimitMiles: 25, ...extra });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues.map((i) => i.code)).toContain(code);
  });

  it("dedupes priority outcodes and drops the base", () => {
    const r = normaliseBriefInput({
      basePostcode: "YO10 5DD",
      travelLimitMiles: 50,
      priorityOutcodes: ["hg1", "HG1 2AB", "YO10"],
    });
    expect(r.ok && r.brief.priorityOutcodes).toEqual(["HG1"]);
  });

  it("refuses a priority outcode it cannot place", () => {
    const r = normaliseBriefInput({
      basePostcode: "YO10",
      travelLimitMiles: 50,
      priorityOutcodes: ["nowhere"],
    });
    expect(r.ok).toBe(false);
  });
});
