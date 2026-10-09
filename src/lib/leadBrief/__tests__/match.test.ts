import { describe, it, expect } from "vitest";
import { computeExpectedMix } from "@/lib/leadBrief/expectedMix";
import {
  evaluateLead,
  labelFor,
  median,
  prioritiesForStorage,
  resolvePriorities,
  type MatchContext,
} from "@/lib/leadBrief/match";
import { computeSimilarAreas, dissimilarity, figuresFor } from "@/lib/leadBrief/similarAreas";
import { computeTradeoffs, relaxedThreshold } from "@/lib/leadBrief/tradeoffs";
import type { NormalisedBrief } from "@/lib/leadBrief/input";
import type { ServiceArea } from "@/lib/leadBrief/serviceArea";
import type { BriefPriority } from "@/lib/leadBrief/types";
import { lead, leads } from "./fixtures";

const ctx: MatchContext = {
  baseOutcode: "YO10",
  priorityOutcodes: [],
  similarAreas: [],
  capMiles: 50,
};

describe("resolvePriorities (A8 defaults)", () => {
  const base = { ranking: ["location", "revenue", "bedrooms", "occupancy"] as const, thresholds: {}, minBedrooms: null, minGross: null };

  it("location defaults to half the service radius, never under five miles", () => {
    const at = (r: number) =>
      resolvePriorities({ brief: { ...base, ranking: ["location"] }, serviceRadiusMiles: r, areaLeads: [], allLeads: [] })[0].threshold;
    expect(at(40)).toBe(20);
    expect(at(25)).toBe(13);
    expect(at(10)).toBe(5);
    expect(at(6)).toBe(5);
  });

  it("revenue, bedrooms and occupancy default to the area's median", () => {
    const area = [
      ...leads(3, "YO10", { gross: 30000, bedrooms: 2, occupancy: 50 }),
      ...leads(2, "YO10", { gross: 60000, bedrooms: 4, occupancy: 70 }),
    ];
    const p = resolvePriorities({ brief: { ...base, ranking: [...base.ranking] }, serviceRadiusMiles: 20, areaLeads: area, allLeads: area });
    expect(p).toEqual([
      { key: "location", threshold: 10 },
      { key: "revenue", threshold: 30000 },
      { key: "bedrooms", threshold: 2 },
      { key: "occupancy", threshold: 50 },
    ]);
  });

  it("falls back to every lead when the area has too few figures", () => {
    const area = leads(2, "YO10", { gross: 90000 });
    const all = [...area, ...leads(5, "LS1", { gross: 30000 })];
    const p = resolvePriorities({ brief: { ...base, ranking: ["revenue"] }, serviceRadiusMiles: 20, areaLeads: area, allLeads: all });
    expect(p[0].threshold).toBe(30000);
  });

  it("an essential's threshold wins over the area median, and an explicit one wins over both", () => {
    const area = leads(6, "YO10", { gross: 30000, bedrooms: 2 });
    const p = resolvePriorities({
      brief: { ...base, ranking: ["revenue", "bedrooms"], minGross: 50000, minBedrooms: 3, thresholds: { bedrooms: 4 } },
      serviceRadiusMiles: 20,
      areaLeads: area,
      allLeads: area,
    });
    expect(p).toEqual([
      { key: "revenue", threshold: 50000 },
      { key: "bedrooms", threshold: 4 },
    ]);
  });

  it("a threshold with nothing to measure is null, not zero", () => {
    const p = resolvePriorities({ brief: { ...base, ranking: ["occupancy"] }, serviceRadiusMiles: 20, areaLeads: [], allLeads: [] });
    expect(p[0].threshold).toBeNull();
  });

  it("⚠️ storage omits a null threshold, which the 0162 CHECK would refuse as JSON null", () => {
    expect(prioritiesForStorage([{ key: "location", threshold: 10 }, { key: "occupancy", threshold: null }])).toEqual([
      { key: "location", threshold: 10 },
      { key: "occupancy" },
    ]);
  });

  it("median handles odd, even and empty", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([null, null])).toBeNull();
  });
});

describe("evaluateLead", () => {
  const priorities: BriefPriority[] = [
    { key: "location", threshold: 10 },
    { key: "revenue", threshold: 40000 },
    { key: "bedrooms", threshold: 3 },
    { key: "occupancy", threshold: 60 },
  ];

  it("a lead meeting everything scores 100", () => {
    const e = evaluateLead(lead("YO10"), priorities, ctx);
    expect(e).toMatchObject({ judged: 4, missed: 0, score: 100 });
  });

  it("missing the top priority costs more than missing the bottom one", () => {
    const farAway = evaluateLead(lead("LS1"), priorities, ctx); // ~22 miles: location missed
    const quiet = evaluateLead(lead("YO10", { occupancy: 30 }), priorities, ctx);
    expect(farAway.missed).toBe(1);
    expect(quiet.missed).toBe(1);
    expect(farAway.score).toBeLessThan(quiet.score);
  });

  it("partial credit reflects how close a miss came", () => {
    const near = evaluateLead(lead("YO10", { gross: 38000 }), priorities, ctx);
    const far = evaluateLead(lead("YO10", { gross: 20000 }), priorities, ctx);
    expect(near.score).toBeGreaterThan(far.score);
  });

  it("a missing figure is a miss with no credit; a null threshold is not judged", () => {
    const e = evaluateLead(lead("YO10", { gross: null }), priorities, ctx);
    expect(e.results[1]).toMatchObject({ met: false, credit: 0 });
    const unjudged = evaluateLead(lead("YO10"), [{ key: "occupancy", threshold: null }], ctx);
    expect(unjudged).toMatchObject({ judged: 0, missed: 0, score: 0 });
  });

  it("location is met inside a priority outcode's reach or an accepted similar area", () => {
    const p: BriefPriority[] = [{ key: "location", threshold: 5 }];
    expect(evaluateLead(lead("HG1"), p, ctx).results[0].met).toBe(false);
    expect(evaluateLead(lead("HG1"), p, { ...ctx, priorityOutcodes: ["HG1"] }).results[0].met).toBe(true);
    expect(evaluateLead(lead("HG1"), p, { ...ctx, similarAreas: ["HG"] }).results[0].met).toBe(true);
  });
});

describe("labelFor", () => {
  const flags = { inFirstPick: false, isFirstSale: true, paceOnly: false };

  it("top match when every judged priority is met", () => {
    expect(labelFor({ judged: 4, missed: 0 }, flags)).toEqual({ label: "top_match", firstPickTag: false });
  });

  it("strong match when exactly one of at least two is missed", () => {
    expect(labelFor({ judged: 4, missed: 1 }, flags).label).toBe("strong_match");
    expect(labelFor({ judged: 1, missed: 1 }, flags).label).toBe("nearby_opportunity");
  });

  it("nearby opportunity otherwise", () => {
    expect(labelFor({ judged: 4, missed: 2 }, flags).label).toBe("nearby_opportunity");
    expect(labelFor({ judged: 0, missed: 0 }, flags).label).toBe("nearby_opportunity");
  });

  it("first pick is the primary label over strong, and a tag on a top match", () => {
    const fp = { ...flags, inFirstPick: true };
    expect(labelFor({ judged: 4, missed: 1 }, fp)).toEqual({ label: "first_pick", firstPickTag: false });
    expect(labelFor({ judged: 4, missed: 0 }, fp)).toEqual({ label: "top_match", firstPickTag: true });
  });

  it("⚠️ never a first pick when someone else had the lead first (D6)", () => {
    const second = { ...flags, inFirstPick: true, isFirstSale: false };
    expect(labelFor({ judged: 4, missed: 1 }, second)).toEqual({ label: "strong_match", firstPickTag: false });
    expect(labelFor({ judged: 4, missed: 0 }, second)).toEqual({ label: "top_match", firstPickTag: false });
  });

  it("a behind-pace lead is always a nearby opportunity (A11)", () => {
    expect(labelFor({ judged: 4, missed: 0 }, { inFirstPick: true, isFirstSale: true, paceOnly: true })).toEqual({
      label: "nearby_opportunity",
      firstPickTag: false,
    });
  });
});

describe("computeExpectedMix", () => {
  it("always adds up to the plan", () => {
    const mix = computeExpectedMix({ plan: 20, deliverable: 20, labelWeights: { top_match: 7, strong_match: 5, first_pick: 2, nearby_opportunity: 3 } });
    expect(Object.values(mix).reduce((a, b) => a + b, 0)).toBe(20);
  });

  it("⚠️ splits the plan, never more, when the area could deliver more than it", () => {
    // The sum alone cannot catch this: an uncapped split of 50 plus -30 nearby
    // still adds up to 20. Every entry must be a share of the plan.
    const mix = computeExpectedMix({ plan: 20, deliverable: 50, labelWeights: { top_match: 1, strong_match: 1 } });
    expect(mix).toEqual({ top_match: 10, strong_match: 10, first_pick: 0, nearby_opportunity: 0 });
  });

  it("splits by the label shares when the area can deliver the plan", () => {
    expect(
      computeExpectedMix({ plan: 10, deliverable: 10, labelWeights: { top_match: 5, strong_match: 3, nearby_opportunity: 2 } })
    ).toEqual({ top_match: 5, strong_match: 3, first_pick: 0, nearby_opportunity: 2 });
  });

  it("⚠️ what the area cannot deliver is expected as nearby opportunities", () => {
    expect(computeExpectedMix({ plan: 20, deliverable: 10, labelWeights: { top_match: 1 } })).toEqual({
      top_match: 10,
      strong_match: 0,
      first_pick: 0,
      nearby_opportunity: 10,
    });
  });

  it("with no eligible leads the whole plan is nearby", () => {
    expect(computeExpectedMix({ plan: 10, deliverable: 0, labelWeights: {} }).nearby_opportunity).toBe(10);
    expect(computeExpectedMix({ plan: 10, deliverable: 10, labelWeights: {} }).nearby_opportunity).toBe(10);
  });

  it("rounds by largest remainder", () => {
    expect(computeExpectedMix({ plan: 10, deliverable: 10, labelWeights: { top_match: 1, strong_match: 1, first_pick: 1 } })).toEqual({
      top_match: 4,
      strong_match: 3,
      first_pick: 3,
      nearby_opportunity: 0,
    });
  });
});

describe("similar areas", () => {
  const reachable = new Set(["YO", "HG", "LS", "HU", "DL"]);
  const book = [
    ...leads(5, "YO10", { gross: 40000, nightly: 150, occupancy: 60 }),
    ...leads(5, "HG1", { gross: 41000, nightly: 152, occupancy: 61 }),
    ...leads(5, "LS1", { gross: 80000, nightly: 300, occupancy: 80 }),
    ...leads(5, "HU1", { gross: 42000, nightly: 150, occupancy: 59 }),
    ...leads(4, "DL1", { gross: 40000, nightly: 150, occupancy: 60 }),
    ...leads(6, "M1", { gross: 40000, nightly: 150, occupancy: 60 }),
  ];
  const run = (competition = {}) =>
    computeSimilarAreas({ referenceAreas: ["YO"], reachableAreas: reachable, leads: book, fallbackReferenceLeads: [], competition });

  it("ranks by likeness, needs five leads, stays within reach, and leaves out the customer's own", () => {
    const s = run();
    expect(s.map((a) => a.area)).toEqual(["HG", "HU", "LS"]);
    expect(s[0].recommended).toBe(true);
    expect(s.slice(1).every((a) => !a.recommended)).toBe(true);
    expect(s[0].reference).toEqual({ gross: 40000, nightly: 150, occupancy: 60 });
  });

  it("puts low competition first, then medium, then unknown, then high", () => {
    const s = run({ "postcode_area:HG": "high", "postcode_area:LS": "low" });
    expect(s.map((a) => [a.area, a.tier])).toEqual([
      ["LS", "low"],
      ["HU", null],
      ["HG", "high"],
    ]);
  });

  it("⚠️ returns figures and tiers only — no counts and no net-based gain", () => {
    const keys = new Set(run().flatMap((a) => [...Object.keys(a), ...Object.keys(a.figures)]));
    expect(Array.from(keys).sort()).toEqual(
      ["area", "city", "figures", "gross", "nightly", "occupancy", "recommended", "reference", "tier"].sort()
    );
  });

  it("figures round to £100, £1 and 1%", () => {
    expect(figuresFor([lead("YO1", { gross: 40049, nightly: 150.4, occupancy: 60.6 })])).toEqual({
      gross: 40000,
      nightly: 150,
      occupancy: 61,
    });
    expect(dissimilarity({ gross: 44000, nightly: null, occupancy: null }, { gross: 40000, nightly: 150, occupancy: 60 })).toBeCloseTo(0.1);
  });
});

describe("trade-offs (A6)", () => {
  it("relaxes one step at a time and drops an essential at the bottom", () => {
    expect(relaxedThreshold("revenue", 75000)).toBe(50000);
    expect(relaxedThreshold("revenue", 30000)).toBe(25000);
    expect(relaxedThreshold("revenue", 25000)).toBeNull();
    expect(relaxedThreshold("bedrooms", 4)).toBe(3);
    expect(relaxedThreshold("bedrooms", 2)).toBeNull();
  });

  const brief = {
    basePostcode: "YO10",
    baseOutcode: "YO10",
    priorityOutcodes: [],
    travelLimitMiles: null,
    operatingMode: "anywhere",
    essentials: ["revenue", "bedrooms"],
    minBedrooms: 3,
    minGross: 75000,
    ranking: ["location"],
    thresholds: {},
    similarAreas: [],
  } as NormalisedBrief;
  const sa = (radiusMiles: number, meetsTarget = true): ServiceArea => ({
    capMiles: 75,
    radiusMiles,
    outcodes: [],
    meetsTarget,
    centres: ["YO10"],
    priorityOutsideCap: [],
    target: 26,
    deliverable: meetsTarget ? 26 : 10,
  });

  it("offers only gains", () => {
    const t = computeTradeoffs({
      brief,
      current: sa(60),
      areaFor: (b) => (b.minGross === 50000 ? sa(30) : b.minBedrooms === 2 ? sa(60) : sa(60)),
    });
    expect(t).toEqual([
      { essential: "revenue", from: 75000, to: 50000, radiusMiles: 30, milesSaved: 30, fillsPlan: false },
    ]);
  });

  it("ranks by miles saved, whatever order the essentials are tried in", () => {
    // Revenue is tried first; bedrooms saves more, so it must lead.
    const t = computeTradeoffs({
      brief,
      current: sa(60),
      areaFor: (b) => (b.minGross === 50000 ? sa(40) : b.minBedrooms === 2 ? sa(20) : sa(60)),
    });
    expect(t.map((x) => [x.essential, x.milesSaved])).toEqual([
      ["bedrooms", 40],
      ["revenue", 20],
    ]);
  });

  it("at equal miles, puts the relaxation that fills the plan first", () => {
    const t = computeTradeoffs({
      brief,
      current: sa(75, false),
      areaFor: (b) => (b.minGross === 50000 ? sa(70, false) : b.minBedrooms === 2 ? sa(70, true) : sa(75, false)),
    });
    expect(t.map((x) => [x.essential, x.fillsPlan])).toEqual([
      ["bedrooms", true],
      ["revenue", false],
    ]);
  });

  it("offers a relaxation that fills a plan the area could not", () => {
    const t = computeTradeoffs({
      brief,
      current: sa(75, false),
      areaFor: (b) => (b.minBedrooms === 2 ? sa(75, true) : sa(75, false)),
    });
    expect(t).toEqual([
      { essential: "bedrooms", from: 3, to: 2, radiusMiles: 75, milesSaved: 0, fillsPlan: true },
    ]);
  });

  it("offers nothing when there are no essentials", () => {
    expect(computeTradeoffs({ brief: { ...brief, essentials: [], minGross: null, minBedrooms: null }, current: sa(75, false), areaFor: () => sa(10) })).toEqual([]);
  });
});
