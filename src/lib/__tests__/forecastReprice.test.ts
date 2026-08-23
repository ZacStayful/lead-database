import { describe, it, expect } from "vitest";
import { recommendedDowngrade } from "@/lib/filterForecast";
import { planForProductAllocation } from "@/lib/plans";

/**
 * The reprice applied when a pending plan change takes effect. Mirrors
 * repriceFilterForecast in src/lib/planChanges.ts — if one changes, so must
 * the other.
 */
function repriced(expected: number, newAllocation: number, leadType: "management") {
  const plan = planForProductAllocation(leadType, newAllocation);
  const planPricePence = Math.round(plan.priceGbp * 100);
  const capped = Math.min(expected, newAllocation);
  return {
    expected: capped,
    planPricePence,
    costPerLeadPence: Math.ceil(planPricePence / capped),
  };
}

describe("repricing a forecast when the plan changes", () => {
  it("halves the cost per lead on the downgrade we recommended", () => {
    // Allan's shape: 20-lead plan, forecast 4 -> £300/4 = £75 a lead.
    const before = Math.ceil(30000 / 4);
    expect(before).toBe(7500);

    const plan = recommendedDowngrade(4, 20, "management");
    expect(plan?.leads).toBe(10);

    const after = repriced(4, plan!.leads, "management");
    expect(after.expected).toBe(4); // unchanged, which is the whole point
    expect(after.costPerLeadPence).toBe(3750); // £37.50
    expect(after.costPerLeadPence).toBeLessThan(before);
  });

  it("never lets an in-force forecast exceed the new allocation", () => {
    // An upgrade-then-downgrade would otherwise quote volume nobody bought.
    const after = repriced(16, 10, "management");
    expect(after.expected).toBe(10);
    expect(after.costPerLeadPence).toBe(1500);
  });

  it("leaves a forecast that still fits alone on an upgrade", () => {
    const after = repriced(6, 20, "management");
    expect(after.expected).toBe(6);
    expect(after.costPerLeadPence).toBe(5000); // £300/6
  });

  it("keeps the ceil invariant after repricing", () => {
    for (const allocation of [10, 20]) {
      for (let g = 1; g <= 20; g++) {
        const r = repriced(g, allocation, "management");
        expect(r.expected * r.costPerLeadPence).toBeGreaterThanOrEqual(
          r.planPricePence
        );
      }
    }
  });

  // A downgrade is only ever recommended when the smaller plan covers the whole
  // forecast, so repricing can never reduce what the customer was told to expect.
  it("a recommended downgrade never cuts the expected count", () => {
    for (let g = 1; g <= 20; g++) {
      const plan = recommendedDowngrade(g, 20, "management");
      if (!plan) continue;
      expect(repriced(g, plan.leads, "management").expected).toBe(g);
    }
  });
});
