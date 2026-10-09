import { describe, it, expect } from "vitest";
import { computeBottleneck } from "@/lib/leadBrief/bottleneck";
import type { NormalisedBrief } from "@/lib/leadBrief/input";
import type { BriefPlan } from "@/lib/leadBrief/plans";
import type { ServiceArea } from "@/lib/leadBrief/serviceArea";

const brief = (over: Partial<NormalisedBrief> = {}): NormalisedBrief =>
  ({
    basePostcode: "YO10",
    baseOutcode: "YO10",
    priorityOutcodes: [],
    travelLimitMiles: null,
    operatingMode: "anywhere",
    essentials: [],
    minBedrooms: null,
    minGross: null,
    ranking: ["location"],
    thresholds: {},
    similarAreas: [],
    ...over,
  }) as NormalisedBrief;

const area = (meetsTarget: boolean): ServiceArea => ({
  capMiles: 75,
  radiusMiles: 75,
  outcodes: [],
  meetsTarget,
  centres: ["YO10"],
  priorityOutsideCap: [],
  target: 26,
  deliverable: meetsTarget ? 26 : 10,
});

/** An area that covers the plan exactly when `covers` says the brief allows enough supply. */
function areaFor(covers: (b: NormalisedBrief, p: BriefPlan) => boolean) {
  return (b: NormalisedBrief, p: BriefPlan) => area(covers(b, p));
}

const bedrooms5 = brief({ essentials: ["bedrooms"], minBedrooms: 5 });
const revenue75 = brief({ essentials: ["revenue"], minGross: 75000 });
const both = brief({ essentials: ["revenue", "bedrooms"], minGross: 75000, minBedrooms: 5 });

describe("computeBottleneck — when it says nothing", () => {
  it("says nothing when the area covers the plan", () => {
    expect(computeBottleneck({ brief: bedrooms5, plan: 20, current: area(true), areaFor: areaFor(() => true) })).toBeNull();
  });

  it("says nothing when there are no essentials, however thin the area", () => {
    expect(computeBottleneck({ brief: brief(), plan: 20, current: area(false), areaFor: areaFor(() => false) })).toBeNull();
  });

  it("⚠️ says nothing when even no essentials could cover the plan: that is supply, never a customer message", () => {
    // The plan is always filled: a thin area widens to the cap, the mix leans
    // to Nearby and a short month rolls over (A3).
    expect(
      computeBottleneck({ brief: bedrooms5, plan: 20, current: area(false), areaFor: areaFor(() => false) })
    ).toBeNull();
  });
});

describe("computeBottleneck — naming the essential holding the area back", () => {
  it("walks bedrooms down one at a time and stops at the first that covers the plan", () => {
    const b = computeBottleneck({
      brief: bedrooms5,
      plan: 20,
      current: area(false),
      // 4+ bedrooms is enough; 3+ would be too, and must not be what is offered.
      areaFor: areaFor((x) => x.minBedrooms === null || x.minBedrooms <= 4),
    });
    expect(b!.causes).toEqual([{ essential: "bedrooms", relaxTo: 4 }]);
  });

  it("walks revenue down the threshold list and stops at the first that covers the plan", () => {
    const b = computeBottleneck({
      brief: revenue75,
      plan: 20,
      current: area(false),
      areaFor: areaFor((x) => x.minGross === null || x.minGross <= 40000),
    });
    expect(b!.causes).toEqual([{ essential: "revenue", relaxTo: 40000 }]);
  });

  it("names an essential as included in full when only dropping it covers the plan", () => {
    const b = computeBottleneck({
      brief: brief({ essentials: ["bedrooms"], minBedrooms: 2 }),
      plan: 20,
      current: area(false),
      areaFor: areaFor((x) => x.minBedrooms === null),
    });
    expect(b!.causes).toEqual([{ essential: "bedrooms", relaxTo: null }]);
  });

  it("names every essential that alone would do it, fewest steps first", () => {
    // Revenue is chosen first but needs three steps; bedrooms needs one.
    const b = computeBottleneck({
      brief: both,
      plan: 20,
      current: area(false),
      areaFor: areaFor(
        (x) => (x.minBedrooms === null || x.minBedrooms <= 4) || (x.minGross === null || x.minGross <= 30000)
      ),
    });
    expect(b!.causes).toEqual([
      { essential: "bedrooms", relaxTo: 4 },
      { essential: "revenue", relaxTo: 30000 },
    ]);
  });

  it("names both, each included in full, when only relaxing both together covers the plan", () => {
    const b = computeBottleneck({
      brief: both,
      plan: 20,
      current: area(false),
      areaFor: areaFor((x) => x.minBedrooms === null && x.minGross === null),
    });
    expect(b!.causes).toEqual([
      { essential: "revenue", relaxTo: null },
      { essential: "bedrooms", relaxTo: null },
    ]);
  });
});

describe("computeBottleneck — the A7 options, offered only when they would help", () => {
  const relaxOnly = (x: NormalisedBrief) => x.minBedrooms === null;

  it("always offers a call, and never a waitlist", () => {
    const b = computeBottleneck({ brief: bedrooms5, plan: 20, current: area(false), areaFor: areaFor(relaxOnly) });
    expect(b!.canBookCall).toBe(true);
    expect(Object.keys(b!).sort()).toEqual(["canBookCall", "canSwitchToSmallerPlan", "canWiden", "causes"]);
  });

  it("offers widening only when a larger travel limit would cover the plan", () => {
    const at25 = { ...bedrooms5, travelLimitMiles: 25 as const };
    const widerCovers = areaFor((x) => relaxOnly(x) || x.travelLimitMiles === null);
    expect(computeBottleneck({ brief: at25, plan: 20, current: area(false), areaFor: widerCovers })!.canWiden).toBe(true);
    expect(computeBottleneck({ brief: at25, plan: 20, current: area(false), areaFor: areaFor(relaxOnly) })!.canWiden).toBe(false);
    // Already at "anywhere", or past the plan maximum: there is nothing wider.
    expect(computeBottleneck({ brief: bedrooms5, plan: 20, current: area(false), areaFor: widerCovers })!.canWiden).toBe(false);
    const at50 = { ...bedrooms5, travelLimitMiles: 50 as const };
    expect(computeBottleneck({ brief: at50, plan: 10, current: area(false), areaFor: widerCovers })!.canWiden).toBe(false);
  });

  it("offers the 10-lead plan only from the 20-lead plan, and only when it would be covered", () => {
    const tenCovers = areaFor((x, p) => relaxOnly(x) || p === 10);
    expect(computeBottleneck({ brief: bedrooms5, plan: 20, current: area(false), areaFor: tenCovers })!.canSwitchToSmallerPlan).toBe(true);
    expect(computeBottleneck({ brief: bedrooms5, plan: 20, current: area(false), areaFor: areaFor(relaxOnly) })!.canSwitchToSmallerPlan).toBe(false);
    expect(computeBottleneck({ brief: bedrooms5, plan: 10, current: area(false), areaFor: tenCovers })!.canSwitchToSmallerPlan).toBe(false);
  });
});
