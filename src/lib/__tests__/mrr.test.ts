import { describe, expect, it } from "vitest";
import {
  customerMrrPence,
  mrrTotals,
  planPricePence,
  poundsFromPence,
} from "@/lib/mrr";
import { GR_PLANS, PLANS } from "@/lib/plans";
import type { Customer } from "@/lib/types";

const base = (o: Partial<Customer> = {}): Customer =>
  ({
    id: "c1",
    is_active: true,
    subscription_status: "inactive",
    gr_subscription_status: "inactive",
    monthly_allocation: 20,
    gr_monthly_allocation: 10,
    paused_at: null,
    stripe_subscription_id: null,
    gr_stripe_subscription_id: null,
    ...o,
  }) as unknown as Customer;

describe("planPricePence", () => {
  it("prices both tiers of both products in pence", () => {
    expect(planPricePence("management", 10)).toBe(PLANS.lead_10.priceGbp * 100);
    expect(planPricePence("management", 20)).toBe(PLANS.lead_20.priceGbp * 100);
    expect(planPricePence("guaranteed_rent", 10)).toBe(GR_PLANS.lead_10.priceGbp * 100);
    expect(planPricePence("guaranteed_rent", 20)).toBe(GR_PLANS.lead_20.priceGbp * 100);
  });

  it("treats a null or zero allocation as the small tier, never a crash", () => {
    expect(planPricePence("management", null)).toBe(PLANS.lead_10.priceGbp * 100);
    expect(planPricePence("management", 0)).toBe(PLANS.lead_10.priceGbp * 100);
    expect(planPricePence("guaranteed_rent", null)).toBe(GR_PLANS.lead_10.priceGbp * 100);
  });

  it("crosses to the large tier above 10, as planForAllocation does", () => {
    expect(planPricePence("management", 11)).toBe(PLANS.lead_20.priceGbp * 100);
    expect(planPricePence("management", 999)).toBe(PLANS.lead_20.priceGbp * 100);
  });

  it("routes GR through the GR plan table", () => {
    // ⚠️ HONEST NOTE: while PLANS and GR_PLANS carry identical prices this
    // assertion passes against the OLD, buggy serviceHealth code too — it
    // priced GR from the management table. No value test can distinguish them
    // today. This is a REGRESSION GUARD for after either product reprices, not
    // proof the bug is fixed; the proof is that the GR branch now calls
    // grPlanForAllocation, which is a code-reading matter.
    expect(planPricePence("guaranteed_rent", 20)).toBe(GR_PLANS.lead_20.priceGbp * 100);
  });
});

describe("customerMrrPence", () => {
  it("counts an active management subscriber with a Stripe subscription", () => {
    const m = customerMrrPence(
      base({ subscription_status: "active", stripe_subscription_id: "sub", monthly_allocation: 20 })
    );
    expect(m.managementPence).toBe(30000);
    expect(m.pausedManagementPence).toBe(0);
    expect(m.grPence).toBe(0);
  });

  it("ignores an active customer with no Stripe subscription (comped/owner)", () => {
    const m = customerMrrPence(base({ subscription_status: "active" }));
    expect(m.managementPence).toBe(0);
  });

  it("ignores an archived row entirely, on both products", () => {
    const m = customerMrrPence(
      base({
        is_active: false,
        subscription_status: "active",
        stripe_subscription_id: "sub",
        gr_subscription_status: "active",
        gr_stripe_subscription_id: "grsub",
      })
    );
    expect(m.managementPence).toBe(0);
    expect(m.grPence).toBe(0);
  });

  it("moves a paused subscriber's revenue into the paused bucket, never the billed one", () => {
    const m = customerMrrPence(
      base({
        subscription_status: "active",
        stripe_subscription_id: "sub",
        monthly_allocation: 10,
        paused_at: "2026-08-01T00:00:00Z",
      })
    );
    expect(m.managementPence).toBe(0);
    expect(m.pausedManagementPence).toBe(15000);
  });

  it("never lets paused_at suppress GR — it is management-only (invariant 6)", () => {
    const m = customerMrrPence(
      base({
        paused_at: "2026-08-01T00:00:00Z",
        gr_subscription_status: "active",
        gr_stripe_subscription_id: "grsub",
        gr_monthly_allocation: 10,
      })
    );
    expect(m.grPence).toBe(15000);
  });

  it("counts both products for a customer holding both", () => {
    const m = customerMrrPence(
      base({
        subscription_status: "active",
        stripe_subscription_id: "sub",
        monthly_allocation: 20,
        gr_subscription_status: "active",
        gr_stripe_subscription_id: "grsub",
        gr_monthly_allocation: 10,
      })
    );
    expect(m.managementPence).toBe(30000);
    expect(m.grPence).toBe(15000);
  });

  it("does not count past_due as billing revenue", () => {
    const m = customerMrrPence(
      base({ subscription_status: "past_due", stripe_subscription_id: "sub" })
    );
    expect(m.managementPence).toBe(0);
  });
});

describe("mrrTotals", () => {
  it("reproduces the live figures exactly", () => {
    // The real production population as at 2026-08-23: management £3,600 over
    // 17 customers, GR £150 over 1, paused £600 over 4. Checked against the SQL
    // reproduction of the pre-refactor inline arithmetic in admin/page.tsx —
    // the whole point of extracting it was that the number must not move.
    // 7 x £300 + 10 x £150 = £3,600 across 17 customers.
    const mgmt20 = Array.from({ length: 7 }, () =>
      base({ subscription_status: "active", stripe_subscription_id: "s", monthly_allocation: 20 })
    );
    const mgmt10 = Array.from({ length: 10 }, () =>
      base({ subscription_status: "active", stripe_subscription_id: "s", monthly_allocation: 10 })
    );
    const paused = Array.from({ length: 4 }, () =>
      base({
        subscription_status: "active",
        stripe_subscription_id: "s",
        monthly_allocation: 10,
        paused_at: "2026-08-01T00:00:00Z",
      })
    );
    const gr = [
      base({
        gr_subscription_status: "active",
        gr_stripe_subscription_id: "g",
        gr_monthly_allocation: 10,
      }),
    ];
    const t = mrrTotals([...mgmt20, ...mgmt10, ...paused, ...gr]);
    expect(poundsFromPence(t.managementPence)).toBe(3600);
    expect(poundsFromPence(t.grPence)).toBe(150);
    expect(poundsFromPence(t.pausedPence)).toBe(600);
    expect(poundsFromPence(t.totalPence)).toBe(3750);
    expect(t.managementCustomers).toBe(17);
    expect(t.grCustomers).toBe(1);
    expect(t.pausedCustomers).toBe(4);
  });

  it("never folds paused revenue into the total (§21)", () => {
    const t = mrrTotals([
      base({
        subscription_status: "active",
        stripe_subscription_id: "s",
        monthly_allocation: 10,
        paused_at: "2026-08-01T00:00:00Z",
      }),
    ]);
    expect(t.totalPence).toBe(0);
    expect(t.pausedPence).toBe(15000);
  });

  it("returns zeros for an empty book rather than throwing", () => {
    const t = mrrTotals([]);
    expect(t.totalPence).toBe(0);
    expect(t.managementCustomers).toBe(0);
  });
});
