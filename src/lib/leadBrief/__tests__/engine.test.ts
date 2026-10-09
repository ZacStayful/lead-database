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
import { distancesFrom, distancesFromNearest, outcodesWithin } from "@/lib/leadBrief/geo";
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
  const baseDistances = distancesFrom("YO10")!;
  const area = (
    weighted: Map<string, number>,
    plan: 10 | 20,
    travel: 10 | 25 | 50 | null,
    priority: string[] = [],
    similar: string[] = []
  ) =>
    computeServiceArea({
      plan,
      travelLimitMiles: travel,
      baseOutcode: "YO10",
      priorityOutcodes: priority,
      similarAreas: similar,
      baseDistances,
      weightedSupply: weighted,
      weeks: 13,
    });

  it("stops at the first step that can deliver the plan with its buffer", () => {
    // 200 leads in YO10 over 13 weeks is ~67 a month: ten miles is plenty.
    const a = area(new Map([["YO10", 200]]), 20, null);
    expect(a.radiusMiles).toBe(10);
    expect(a.meetsTarget).toBe(true);
    expect(a.outcodes[0]).toBe("YO10");
    expect(a.centres).toEqual(["YO10"]);
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
    // HG1 is ~20 miles away: with supply only there, ten miles round each area is enough.
    const a = area(new Map([["HG1", 200]]), 20, 50, ["HG1"]);
    expect(a.radiusMiles).toBe(10);
    expect(a.outcodes).toContain("HG1");
    expect(a.meetsTarget).toBe(true);
  });

  it("⚠️ grows around every area the customer picks, not around the base alone", () => {
    // Supply in LS6 (~25 miles from York, ~2 from LS1). With only the base
    // it takes thirty miles to reach; with LS1 picked too, ten miles round
    // LS1 already covers it.
    const supplyLS6 = new Map([["LS6", 200]]);
    expect(area(supplyLS6, 20, null).radiusMiles).toBe(30);
    const picked = area(supplyLS6, 20, null, ["LS1"]);
    expect(picked.radiusMiles).toBe(10);
    expect(picked.centres).toEqual(["YO10", "LS1"]);
    expect(picked.outcodes).toContain("LS6");
    // And at ten miles nothing ten miles beyond both areas is in.
    const d = distancesFromNearest(["YO10", "LS1"])!;
    for (const oc of picked.outcodes) expect(d.get(oc)!).toBeLessThanOrEqual(10);
  });

  it("orders the area base first, then nearest to any of the customer's areas", () => {
    const a = area(new Map(), 10, 25, ["LS1"]);
    expect(a.outcodes[0]).toBe("YO10");
    const d = distancesFromNearest(["YO10", "LS1"])!;
    const rest = a.outcodes.slice(1).map((oc) => d.get(oc)!);
    for (let i = 1; i < rest.length; i++) expect(rest[i]).toBeGreaterThanOrEqual(rest[i - 1]);
  });

  it("keeps everything inside the cap of the base, even round a priority area", () => {
    // LS1 is ~22 miles out; at a 25-mile cap the circle round LS1 must stop
    // where the base's 25 miles stops.
    const a = area(new Map(), 10, 25, ["LS1"]);
    for (const oc of a.outcodes) expect(baseDistances.get(oc)!).toBeLessThanOrEqual(25);
    expect(a.outcodes).not.toContain("BD1");
  });

  it("reports a priority outcode beyond the cap rather than stretching to it", () => {
    const a = area(new Map(), 10, 25, ["LS1", "M1"]);
    expect(a.priorityOutsideCap).toEqual(["M1"]);
    expect(a.centres).toEqual(["YO10", "LS1"]);
    expect(a.outcodes).toContain("LS1");
    expect(a.outcodes).not.toContain("M1");
  });

  it("⚠️ a ticked similar area joins the area, within the cap, and its supply counts", () => {
    // Supply only in Harrogate. Ticking HG brings every HG outcode inside the
    // cap in at the first step.
    const supplyHG = new Map([["HG1", 200]]);
    expect(area(supplyHG, 20, null).radiusMiles).toBe(20);
    const ticked = area(supplyHG, 20, null, [], ["HG"]);
    expect(ticked.radiusMiles).toBe(10);
    expect(ticked.meetsTarget).toBe(true);
    const hg = ticked.outcodes.filter((oc) => oc.startsWith("HG"));
    expect(hg).toContain("HG1");
    expect(hg).toEqual(outcodesWithin(baseDistances, 75).filter((oc) => oc.startsWith("HG")));
    // Never a district from beyond the cap, and never twice.
    expect(new Set(ticked.outcodes).size).toBe(ticked.outcodes.length);
    const small = area(new Map(), 10, 10, [], ["HG"]);
    expect(small.outcodes.some((oc) => oc.startsWith("HG"))).toBe(false);
  });

  it("is the same circle whichever plan, until the cap differs", () => {
    const w = new Map([["YO10", 3]]);
    expect(area(w, 10, null).radiusMiles).toBe(40);
    expect(area(w, 20, null).radiusMiles).toBe(75);
  });
});

describe("first picks", () => {
  const nearest = distancesFromNearest(["YO10"])!;
  const picks = (over: Parameters<typeof supply>[0] = {}, today = "2026-10-08", reach: number | null = 25, from = nearest) =>
    computeFirstPicks({ nearestDistances: from, reachMiles: reach, supply: supply(over), today });

  it("with nobody else around, every outcode inside the reach is a first pick, nearest first", () => {
    const p = picks();
    expect(p[0]).toBe("YO10");
    expect(p).toEqual(outcodesWithin(nearest, 25));
  });

  it("⚠️ reaches nationwide for a customer who will travel anywhere", () => {
    const p = picks({}, "2026-10-08", null);
    expect(p).toHaveLength(nearest.size);
    expect(p).toContain("TR1");
    expect(p[0]).toBe("YO10");
  });

  it("is measured from the customer's nearest area, not only the base", () => {
    const two = distancesFromNearest(["YO10", "M1"])!;
    const p = picks({}, "2026-10-08", 10, two);
    expect(p).toContain("M1");
    expect(p).toContain("M4");
    expect(picks({}, "2026-10-08", 10)).not.toContain("M1");
  });

  it("leaves out areas a legacy filter names", () => {
    const p = picks({ filteredAreas: ["YO"] });
    expect(p.some((oc) => oc.startsWith("YO"))).toBe(false);
    expect(p.length).toBeGreaterThan(0);
  });

  it("leaves out another brief customer's service area", () => {
    expect(picks({ otherBriefs: [otherBrief({ areaOutcodes: ["ZE1"], reachMiles: 10, serviceOutcodes: ["YO1"] })] })).not.toContain("YO1");
  });

  it("respects another customer's first picks while their lock holds, and not after", () => {
    const other = otherBrief({ areaOutcodes: ["ZE1"], reachMiles: 10, firstPickOutcodes: ["YO1"], lockedUntil: "2026-10-08" });
    expect(picks({ otherBriefs: [other] }, "2026-10-08")).not.toContain("YO1");
    expect(picks({ otherBriefs: [other] }, "2026-10-09")).toContain("YO1");
  });

  it("gives an outcode to the nearer brief customer, and a tie to the one already there", () => {
    // A customer based in YO1 is nearer YO1 than we are; YO10 is our own base.
    const p = picks({ otherBriefs: [otherBrief({ areaOutcodes: ["YO1"], reachMiles: 50 })] });
    expect(p).not.toContain("YO1");
    expect(p).toContain("YO10");
    const same = picks({ otherBriefs: [otherBrief({ areaOutcodes: ["YO10"], reachMiles: 50 })] });
    expect(same).toEqual([]);
  });

  it("measures the other customer from their nearest area too", () => {
    // Their base is in Scotland, but they also work YO1.
    const p = picks({ otherBriefs: [otherBrief({ areaOutcodes: ["ZE1", "YO1"], reachMiles: 10 })] });
    expect(p).not.toContain("YO1");
  });

  it("a nearer brief customer whose own reach does not include the outcode does not take it", () => {
    // HG1 is ~20 miles from YO10; a customer based in HG1 with a 10-mile reach reaches HG1 itself.
    const withReach = picks({ otherBriefs: [otherBrief({ areaOutcodes: ["HG1"], reachMiles: 10 })] });
    expect(withReach).not.toContain("HG1");
    // A customer in YO1 whose reach is under a mile reaches only its own outcode.
    const noReach = picks({ otherBriefs: [otherBrief({ areaOutcodes: ["YO1"], reachMiles: 0.1 })] });
    expect(noReach).not.toContain("YO1");
    expect(noReach).toContain("YO31");
    // "Anywhere" reaches everywhere: nothing nearer to them is ours.
    const anywhere = picks({ otherBriefs: [otherBrief({ areaOutcodes: ["HG1"], reachMiles: null })] });
    expect(anywhere).not.toContain("HG1");
  });
});

describe("behind-pace outcodes (A11)", () => {
  const baseDistances = distancesFrom("YO10")!;
  const nearest = distancesFromNearest(["YO10"])!;

  it("are the ring beyond the service area, out to the cap, nearest first", () => {
    const service = outcodesWithin(baseDistances, 10);
    const pace = computePaceOutcodes({ capMiles: 25, baseDistances, nearestDistances: nearest, serviceOutcodes: service, firstPickOutcodes: [] });
    expect(pace.length).toBeGreaterThan(0);
    for (const oc of pace) {
      expect(baseDistances.get(oc)!).toBeGreaterThan(10);
      expect(baseDistances.get(oc)!).toBeLessThanOrEqual(25);
      expect(service).not.toContain(oc);
    }
    const d = pace.map((oc) => nearest.get(oc)!);
    for (let i = 1; i < d.length; i++) expect(d[i]).toBeGreaterThanOrEqual(d[i - 1]);
  });

  it("are ordered by the customer's nearest area but bounded by the cap of the base", () => {
    const two = distancesFromNearest(["YO10", "LS1"])!;
    const service = ["YO10", "LS1"];
    const pace = computePaceOutcodes({ capMiles: 25, baseDistances, nearestDistances: two, serviceOutcodes: service, firstPickOutcodes: [] });
    // Districts next to Leeds come before districts 20 miles from both.
    expect(pace.indexOf("LS2")).toBeLessThan(pace.indexOf("YO62"));
    for (const oc of pace) expect(baseDistances.get(oc)!).toBeLessThanOrEqual(25);
  });

  it("leave out first picks and are empty when the area already reaches the cap", () => {
    const service = outcodesWithin(baseDistances, 10);
    const ring = computePaceOutcodes({ capMiles: 25, baseDistances, nearestDistances: nearest, serviceOutcodes: service, firstPickOutcodes: [] });
    const withPicks = computePaceOutcodes({ capMiles: 25, baseDistances, nearestDistances: nearest, serviceOutcodes: service, firstPickOutcodes: [ring[0]] });
    expect(withPicks).not.toContain(ring[0]);
    expect(
      computePaceOutcodes({ capMiles: 25, baseDistances, nearestDistances: nearest, serviceOutcodes: outcodesWithin(baseDistances, 25), firstPickOutcodes: [] })
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
