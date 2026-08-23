import { describe, it, expect } from "vitest";
import { recommendedDowngrade } from "@/lib/filterGuarantee";
import { planForProductAllocation } from "@/lib/plans";

/**
 * The reprice applied when a pending plan change takes effect. Mirrors
 * repriceFilterGuarantee in src/lib/planChanges.ts — if one changes, so must
 * the other.
 */
function repriced(guaranteed: number, newAllocation: number, leadType: "management") {
  const plan = planForProductAllocation(leadType, newAllocation);
  const planPricePence = Math.round(plan.priceGbp * 100);
  const capped = Math.min(guaranteed, newAllocation);
  return {
    guaranteed: capped,
    planPricePence,
    costPerLeadPence: Math.ceil(planPricePence / capped),
  };
}

describe("repricing a guarantee when the plan changes", () => {
  it("halves the cost per lead on the downgrade we recommended", () => {
    // Allan's shape: 20-lead plan, guarantee 4 -> £300/4 = £75 a lead.
    const before = Math.ceil(30000 / 4);
    expect(before).toBe(7500);

    const plan = recommendedDowngrade(4, 20, "management");
    expect(plan?.leads).toBe(10);

    const after = repriced(4, plan!.leads, "management");
    expect(after.guaranteed).toBe(4); // unchanged, which is the whole point
    expect(after.costPerLeadPence).toBe(3750); // £37.50
    expect(after.costPerLeadPence).toBeLessThan(before);
  });

  it("never lets an in-force guarantee exceed the new allocation", () => {
    // An upgrade-then-downgrade could otherwise owe leads nobody bought.
    const after = repriced(16, 10, "management");
    expect(after.guaranteed).toBe(10);
    expect(after.costPerLeadPence).toBe(1500);
  });

  it("leaves a guarantee that still fits alone on an upgrade", () => {
    const after = repriced(6, 20, "management");
    expect(after.guaranteed).toBe(6);
    expect(after.costPerLeadPence).toBe(5000); // £300/6
  });

  it("keeps the ceil invariant after repricing", () => {
    for (const allocation of [10, 20]) {
      for (let g = 1; g <= 20; g++) {
        const r = repriced(g, allocation, "management");
        expect(r.guaranteed * r.costPerLeadPence).toBeGreaterThanOrEqual(
          r.planPricePence
        );
      }
    }
  });

  // A downgrade is only ever recommended when the smaller plan covers the whole
  // guarantee, so repricing can never reduce what was promised.
  it("a recommended downgrade never cuts the guaranteed count", () => {
    for (let g = 1; g <= 20; g++) {
      const plan = recommendedDowngrade(g, 20, "management");
      if (!plan) continue;
      expect(repriced(g, plan.leads, "management").guaranteed).toBe(g);
    }
  });
});
