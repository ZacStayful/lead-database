import { describe, expect, it } from "vitest";
import type { Customer } from "@/lib/types";
import { deliveryDaysPerCustomer, releaseOverview, stockSummary } from "../releaseStats";

const ON = { enabled: true, maxPerDay: 2, cycleDays: 30 };
const at = new Date("2026-09-07T12:00:00Z"); // Monday

function customer(over: Partial<Customer> = {}): Customer {
  return {
    id: "c1",
    business_name: "Alpha",
    is_active: true,
    created_at: "2026-06-01T09:00:00Z",
    account_status: "active",
    subscription_status: "active",
    paused_at: null,
    gr_subscription_status: "inactive",
    monthly_allocation: 20,
    lead_balance: 20,
    leads_received_this_month: 0,
    billing_cycle_anchor: "2026-09-07",
    gr_monthly_allocation: 10,
    gr_lead_balance: 0,
    gr_leads_received_this_month: 0,
    gr_billing_cycle_anchor: null,
    release_mode: "daily",
    release_hold_until: null,
    gr_release_hold_until: null,
    ...over,
  } as unknown as Customer;
}

describe("releaseOverview", () => {
  it("one row per held product, and counts who has a slot open", () => {
    const both = customer({ id: "c2", business_name: "Both", gr_subscription_status: "active", gr_lead_balance: 10, gr_billing_cycle_anchor: "2026-09-07" });
    const o = releaseOverview([customer(), both], new Map(), ON, at);
    expect(o.rows.map((r) => `${r.customerId}:${r.leadType}`)).toEqual([
      "c1:management",
      "c2:management",
      "c2:guaranteed_rent",
    ]);
    expect(o.slotOpenToday).toBe(3);
    expect(o.heldAtCapToday).toBe(0);
  });

  it("a paused or inactive customer is not a row (mirrors the routing gates)", () => {
    const o = releaseOverview(
      [customer({ paused_at: "2026-09-01T00:00:00Z" }), customer({ id: "c3", is_active: false })],
      new Map(),
      ON,
      at
    );
    expect(o.rows).toHaveLength(0);
  });

  it("held at the cap, on hold, exhausted and stale anchors are each counted", () => {
    const behind = customer({ id: "cap", leads_received_this_month: 3, lead_balance: 17, billing_cycle_anchor: "2026-08-31" });
    const held = customer({ id: "hold", release_hold_until: "2026-09-10" });
    const done = customer({ id: "done", leads_received_this_month: 20, lead_balance: 0 });
    const stale = customer({ id: "stale", billing_cycle_anchor: "2026-07-20" });
    const o = releaseOverview(
      [behind, held, done, stale],
      new Map([["cap:management", 2]]),
      ON,
      at
    );
    expect(o.heldAtCapToday).toBe(1);
    expect(o.onHold).toBe(1);
    expect(o.exhausted).toBe(1);
    expect(o.staleAnchors).toBe(1);
    expect(o.rows.find((r) => r.customerId === "stale")?.anchorAgeDays).toBe(49);
  });
});

describe("deliveryDaysPerCustomer", () => {
  it("counts distinct London days per customer", () => {
    const k = deliveryDaysPerCustomer([
      { customer_id: "a", assigned_at: "2026-09-01T08:00:00Z" },
      { customer_id: "a", assigned_at: "2026-09-01T09:00:00Z" },
      { customer_id: "a", assigned_at: "2026-09-02T09:00:00Z" },
      { customer_id: "b", assigned_at: "2026-09-01T09:00:00Z" },
    ]);
    expect(k).toEqual({ customers: 2, deliveryDays: 3, perCustomer: 1.5 });
  });
  it("splits days on the London midnight, not UTC", () => {
    const k = deliveryDaysPerCustomer([
      { customer_id: "a", assigned_at: "2026-09-01T22:30:00Z" }, // 23:30 London, 1 Sep
      { customer_id: "a", assigned_at: "2026-09-01T23:30:00Z" }, // 00:30 London, 2 Sep
    ]);
    expect(k.deliveryDays).toBe(2);
  });
  it("is 0 with nothing", () => {
    expect(deliveryDaysPerCustomer([])).toEqual({ customers: 0, deliveryDays: 0, perCustomer: 0 });
  });
});

describe("stockSummary", () => {
  it("counts leads with a free slot and the oldest one's age", () => {
    const s = stockSummary(
      [
        { created_at: "2026-08-28T12:00:00Z", lead_type: "management", assignment_count: 1, max_assignments: 3 },
        { created_at: "2026-09-06T12:00:00Z", lead_type: "management", assignment_count: 3, max_assignments: 3 },
        { created_at: "2026-09-01T12:00:00Z", lead_type: "guaranteed_rent", assignment_count: 0, max_assignments: 3 },
      ],
      "management",
      at
    );
    expect(s).toEqual({ count: 1, oldestDays: 10 });
    expect(stockSummary([], "guaranteed_rent", at)).toEqual({ count: 0, oldestDays: null });
  });
});
