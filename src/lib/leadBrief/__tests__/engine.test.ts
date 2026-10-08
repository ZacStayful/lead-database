import { describe, it, expect } from "vitest";
import { contentionShare, type AreaContention, type GrossBand } from "@/lib/filterPrediction";
import { computeFirstPicks, computePaceOutcodes, tierForArea, tierForOutcode } from "@/lib/leadBrief/areas";
import {
  filteredCompetitors,
  leadShare,
  meetsEssentials,
  otherBriefCoverage,
  weightedSupplyByOutcode,
} from "@/lib/leadBrief/eligibility";
import { distancesFrom, outcodesWithin } from "@/lib/leadBrief/geo";
import { capMilesFor, radiusLadder, supplyTargetFor } from "@/lib/leadBrief/plans";
import { computeServiceArea } from "@/lib/leadBrief/serviceArea";
import { lead, leads, otherBrief, supply } from "./fixtures";

const noEss = { minBedrooms: null, minGross: null };

describe("plans", () => {
  it("caps at the smaller of the travel limit and the plan maximum (A3)", () => {
    expect(capMilesFor(10, null)).toBe(40);
    expect(capMilesFor(20, null)).toBe(75);
    expect(capMilesFor(20, 25)).toBe(25);
    expect(capMilesFor(10, 50)).toBe(40);
    expect(capMilesFor(20, 10)).toBe(10);
  });

  it("targets the plan with a 30% buffer", () => {
    expect(supplyTargetFor(10)).toBe(13);
    expect(supplyTargetFor(20)).toBe(26);
  });

  it("widens in ten-mile steps and always ends on the cap", () => {
    expect(radiusLadder(75)).toEqual([10, 20, 30, 40, 50, 60, 70, 75]);
    expect(radiusLadder(40)).toEqual([10, 20, 30, 40]);
    expect(radiusLadder(25)).toEqual([10, 20, 25]);
    expect(radiusLadder(10)).toEqual([10]);
  });
});

describe("eligibility", () => {
  it("an essential is met only by a figure that clears it", () => {
    expect(meetsEssentials(lead("YO10", { bedrooms: 3 }), { minBedrooms: 3, minGross: null })).toBe(true);
    expect(meetsEssentials(lead("YO10", { bedrooms: 2 }), { minBedrooms: 3, minGross: null })).toBe(false);
    expect(meetsEssentials(lead("YO10", { gross: 50000 }), { minBedrooms: null, minGross: 50000 })).toBe(true);
    expect(meetsEssentials(lead("YO10", { gross: 49999 }), { minBedrooms: null, minGross: 50000 })).toBe(false);
  });

  it("⚠️ a missing figure does NOT meet an essential", () => {
    expect(meetsEssentials(lead("YO10", { bedrooms: null }), { minBedrooms: 2, minGross: null })).toBe(false);
    expect(meetsEssentials(lead("YO10", { gross: null }), { minBedrooms: null, minGross: 25000 })).toBe(false);
  });

  it("no essentials admits every lead, figures or not", () => {
    expect(meetsEssentials(lead("YO10", { bedrooms: null, gross: null }), noEss)).toBe(true);
  });

  it("⚠️ with no other briefs, the share agrees with contentionShare for every area and band", () => {
    const contention: AreaContention = {
      filteredCustomers: { YO: 5, LS: 2 },
      byBand: { YO: { none: 5, "0": 5, "40000": 3 }, LS: { "40000": 2 } },
      everywhereByBand: { "40000": 1, none: 6 },
      maxPerLead: 4,
    };
    const cases: { area: string; gross: number | null; band: GrossBand }[] = [
      { area: "YO", gross: null, band: "none" },
      { area: "YO", gross: 10000, band: "0" },
      { area: "YO", gross: 45000, band: "40000" },
      { area: "LS", gross: 45000, band: "40000" },
      { area: "HG", gross: 45000, band: "40000" },
      { area: "HG", gross: null, band: "none" },
    ];
    for (const c of cases) {
      const l = lead(`${c.area}1`, { area: c.area, gross: c.gross });
      expect(leadShare(l, contention, new Map())).toBeCloseTo(
        contentionShare(c.area, c.band, contention),
        10
      );
    }
  });

  it("counts other brief customers as competitors for their service and first-pick outcodes", () => {
    const coverage = otherBriefCoverage([
      otherBrief({ serviceOutcodes: ["YO10", "YO1"], firstPickOutcodes: ["YO31"] }),
      otherBrief({ serviceOutcodes: ["YO10"] }),
      otherBrief({ serviceOutcodes: ["YO10"] }),
      otherBrief({ serviceOutcodes: ["YO10"] }),
    ]);
    expect(coverage.get("YO10")).toBe(4);
    expect(coverage.get("YO31")).toBe(1);
    // Four others plus the customer being quoted: five for four slots.
    expect(leadShare(lead("YO10"), null, coverage)).toBeCloseTo(4 / 5);
    expect(leadShare(lead("YO1"), null, coverage)).toBe(1);
  });

  it("filteredCompetitors is zero with no contention or no area", () => {
    expect(filteredCompetitors(lead("YO10"), null)).toBe(0);
    expect(
      filteredCompetitors(lead(null, { area: null }), {
        byBand: {},
        everywhereByBand: { none: 3 },
        maxPerLead: 4,
      })
    ).toBe(0);
  });

  it("weighted supply drops leads with no outcode or a failed essential", () => {
    const s = supply({
      leads: [lead("YO10"), lead("YO10", { bedrooms: 1 }), lead(null), lead("YO1")],
    });
    const w = weightedSupplyByOutcode({ minBedrooms: 2, minGross: null }, s);
    expect(w.get("YO10")).toBe(1);
    expect(w.get("YO1")).toBe(1);
    expect(w.size).toBe(2);
  });
});

describe("computeServiceArea", () => {
  const distances = distancesFrom("YO10")!;
  const area = (weighted: Map<string, number>, plan: 10 | 20, travel: 10 | 25 | 50 | null, priority: string[] = []) =>
    computeServiceArea({
      plan,
      travelLimitMiles: travel,
      priorityOutcodes: priority,
      distances,
      weightedSupply: weighted,
      weeks: 13,
    });

  it("stops at the first step that can deliver the plan with its buffer", () => {
    // 200 leads in YO10 over 13 weeks is ~67 a month: ten miles is plenty.
    const a = area(new Map([["YO10", 200]]), 20, null);
    expect(a.radiusMiles).toBe(10);
    expect(a.meetsTarget).toBe(true);
    expect(a.outcodes[0]).toBe("YO10");
  });

  it("widens until supply further out is reached", () => {
    // Supply only in Leeds, ~22 miles away.
    const a = area(new Map([["LS1", 200]]), 20, null);
    expect(a.radiusMiles).toBe(30);
    expect(a.meetsTarget).toBe(true);
    expect(a.outcodes).toContain("LS1");
  });

  it("⚠️ widens to the cap and says so when the plan cannot be filled (widen, never block)", () => {
    const a = area(new Map([["YO10", 3]]), 20, null);
    expect(a.radiusMiles).toBe(75);
    expect(a.capMiles).toBe(75);
    expect(a.meetsTarget).toBe(false);
  });

  it("never passes the customer's own travel limit", () => {
    const a = area(new Map([["LS1", 200]]), 20, 10);
    expect(a.radiusMiles).toBe(10);
    expect(a.meetsTarget).toBe(false);
  });

  it("includes a priority outcode inside the cap, and counts its supply", () => {
    // HG1 is ~22 miles away: with supply only there, a 10-mile circle plus HG1 is enough.
    const a = area(new Map([["HG1", 200]]), 20, 50, ["HG1"]);
    expect(a.radiusMiles).toBe(10);
    expect(a.outcodes).toContain("HG1");
    expect(a.meetsTarget).toBe(true);
  });

  it("reports a priority outcode beyond the cap rather than stretching to it", () => {
    const a = area(new Map(), 10, 25, ["LS1", "M1"]);
    expect(a.priorityOutsideCap).toEqual(["M1"]);
    expect(a.outcodes).toContain("LS1");
    expect(a.outcodes).not.toContain("M1");
  });

  it("is the same circle whichever plan, until the cap differs", () => {
    const w = new Map([["YO10", 3]]);
    expect(area(w, 10, null).radiusMiles).toBe(40);
    expect(area(w, 20, null).radiusMiles).toBe(75);
  });
});

describe("first picks", () => {
  const distances = distancesFrom("YO10")!;
  const picks = (over: Parameters<typeof supply>[0] = {}, today = "2026-10-08") =>
    computeFirstPicks({ baseOutcode: "YO10", capMiles: 25, distances, supply: supply(over), today });

  it("with nobody else around, every outcode inside the cap is a first pick, nearest first", () => {
    const p = picks();
    expect(p[0]).toBe("YO10");
    expect(p).toEqual(outcodesWithin(distances, 25));
  });

  it("leaves out areas a legacy filter names", () => {
    const p = picks({ filteredAreas: ["YO"] });
    expect(p.some((oc) => oc.startsWith("YO"))).toBe(false);
    expect(p.length).toBeGreaterThan(0);
  });

  it("leaves out another brief customer's service area", () => {
    expect(picks({ otherBriefs: [otherBrief({ baseOutcode: "ZE1", capMiles: 10, serviceOutcodes: ["YO1"] })] })).not.toContain("YO1");
  });

  it("respects another customer's first picks while their lock holds, and not after", () => {
    const other = otherBrief({ baseOutcode: "ZE1", capMiles: 10, firstPickOutcodes: ["YO1"], lockedUntil: "2026-10-08" });
    expect(picks({ otherBriefs: [other] }, "2026-10-08")).not.toContain("YO1");
    expect(picks({ otherBriefs: [other] }, "2026-10-09")).toContain("YO1");
  });

  it("gives an outcode to the nearer brief customer, and a tie to the one already there", () => {
    // A customer based in YO1 is nearer YO1 than we are; YO10 is our own base.
    const p = picks({ otherBriefs: [otherBrief({ baseOutcode: "YO1", capMiles: 75 })] });
    expect(p).not.toContain("YO1");
    expect(p).toContain("YO10");
    const same = picks({ otherBriefs: [otherBrief({ baseOutcode: "YO10", capMiles: 75 })] });
    expect(same).toEqual([]);
  });

  it("a nearer brief customer whose own cap does not reach the outcode does not take it", () => {
    // HG1 is ~22 miles from YO10; a customer based in HG1 with a 10-mile cap reaches HG1 itself.
    const withReach = picks({ otherBriefs: [otherBrief({ baseOutcode: "HG1", capMiles: 10 })] });
    expect(withReach).not.toContain("HG1");
    // A customer in YO1 with a cap of under a mile reaches only its own outcode.
    const noReach = picks({ otherBriefs: [otherBrief({ baseOutcode: "YO1", capMiles: 0.1 })] });
    expect(noReach).not.toContain("YO1");
    expect(noReach).toContain("YO31");
  });
});

describe("behind-pace outcodes (A11)", () => {
  const distances = distancesFrom("YO10")!;

  it("are the ring beyond the service area, out to the cap, nearest first", () => {
    const service = outcodesWithin(distances, 10);
    const pace = computePaceOutcodes({ capMiles: 25, distances, serviceOutcodes: service, firstPickOutcodes: [] });
    expect(pace.length).toBeGreaterThan(0);
    for (const oc of pace) {
      expect(distances.get(oc)!).toBeGreaterThan(10);
      expect(distances.get(oc)!).toBeLessThanOrEqual(25);
      expect(service).not.toContain(oc);
    }
    const d = pace.map((oc) => distances.get(oc)!);
    for (let i = 1; i < d.length; i++) expect(d[i]).toBeGreaterThanOrEqual(d[i - 1]);
  });

  it("leave out first picks and are empty when the area already reaches the cap", () => {
    const service = outcodesWithin(distances, 10);
    const ring = computePaceOutcodes({ capMiles: 25, distances, serviceOutcodes: service, firstPickOutcodes: [] });
    const withPicks = computePaceOutcodes({ capMiles: 25, distances, serviceOutcodes: service, firstPickOutcodes: [ring[0]] });
    expect(withPicks).not.toContain(ring[0]);
    expect(
      computePaceOutcodes({ capMiles: 25, distances, serviceOutcodes: outcodesWithin(distances, 25), firstPickOutcodes: [] })
    ).toEqual([]);
  });
});

describe("competition tiers", () => {
  const competition = { "outcode:YO10": "low" as const, "postcode_area:YO": "high" as const };

  it("an outcode's own tier wins over its area's", () => {
    expect(tierForOutcode("YO10", competition)).toBe("low");
    expect(tierForOutcode("YO1", competition)).toBe("high");
    expect(tierForOutcode("LS1", competition)).toBeNull();
    expect(tierForArea("YO", competition)).toBe("high");
  });
});
