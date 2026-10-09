import { describe, it, expect } from "vitest";
import { selectCombinedCandidates } from "@/lib/ingest";
import {
  briefCustomerRoutable,
  firstSaleOrder,
  paceLeadsFor,
} from "@/lib/leadBrief/briefRelease";
import { isBriefCustomer } from "@/lib/leadBrief/routing";
import { briefPacePctFrom, isBehindBriefPace, BRIEF_PACE_DEFICIT_PCT_DEFAULT } from "@/lib/pacing";
import { CONTENDED_FILTERED_CUSTOMERS, type Customer, type Lead } from "@/lib/types";

const f = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ customer_id: `filtered-${i}`, priority_score: 10 - i }));
const u = (deficits: number[]) =>
  deficits.map((d, i) => ({ customer_id: `unfiltered-${i}`, deficit: d }));

describe("selectCombinedCandidates — brief last (Phase 0 §2)", () => {
  it("gives brief customers only the slots legacy customers leave", () => {
    expect(selectCombinedCandidates(f(1), u([0]), 3, ["brief-0", "brief-1"])).toEqual([
      "filtered-0",
      "unfiltered-0",
      "brief-0",
    ]);
  });

  it("gives them nothing when legacy customers fill the lead", () => {
    expect(selectCombinedCandidates(f(2), u([0]), 3, ["brief-0"])).toEqual([
      "filtered-0",
      "filtered-1",
      "unfiltered-0",
    ]);
  });

  it("never changes a legacy customer's place, for any pool shape", () => {
    const shapes: [number, number[], number][] = [
      [0, [], 3],
      [1, [9], 3],
      [2, [1, 0], 2],
      [CONTENDED_FILTERED_CUSTOMERS, [99], CONTENDED_FILTERED_CUSTOMERS],
      [3, [5, 5, 5], 4],
    ];
    for (const [nf, ud, max] of shapes) {
      const before = selectCombinedCandidates(f(nf), u(ud), max);
      const after = selectCombinedCandidates(f(nf), u(ud), max, ["brief-0", "brief-1", "brief-2"]);
      expect(after.slice(0, before.length)).toEqual(before);
    }
  });

  it("is the old function exactly when no brief list is passed (escalation)", () => {
    expect(selectCombinedCandidates(f(1), u([9, 0]), 3)).toEqual(
      selectCombinedCandidates(f(1), u([9, 0]), 3, [])
    );
  });

  it("fills a brief-only pass from the brief list in its order", () => {
    expect(selectCombinedCandidates([], [], 2, ["b-2", "b-0", "b-1"])).toEqual(["b-2", "b-0"]);
  });

  it("never lists one customer twice", () => {
    expect(selectCombinedCandidates(f(1), [], 3, ["filtered-0", "brief-0"])).toEqual([
      "filtered-0",
      "brief-0",
    ]);
  });
});

const leadAt = (id: string, postcode: string | null, count: number, created: string) =>
  ({ id, postcode, assignment_count: count, created_at: created }) as unknown as Lead;

describe("firstSaleOrder — the morning release's brief pass", () => {
  it("offers a lead nobody has bought before any lead's second sale, then oldest first", () => {
    const leads = [
      leadAt("sold-old", "YO1 1AA", 1, "2026-09-01T00:00:00Z"),
      leadAt("new-young", "YO1 1AA", 0, "2026-10-05T00:00:00Z"),
      leadAt("new-old", "YO1 1AA", 0, "2026-09-20T00:00:00Z"),
      leadAt("sold-twice", "YO1 1AA", 2, "2026-08-01T00:00:00Z"),
    ];
    expect([...leads].sort(firstSaleOrder).map((l) => l.id)).toEqual([
      "new-old",
      "new-young",
      "sold-twice",
      "sold-old",
    ]);
  });
});

describe("paceLeadsFor — behind-pace widening, nearest first", () => {
  it("orders by the stored pace list, then oldest, and drops everything else", () => {
    const leads = [
      leadAt("far", "YO8 1AA", 0, "2026-09-01T00:00:00Z"),
      leadAt("near-young", "YO7 1AA", 0, "2026-10-01T00:00:00Z"),
      leadAt("near-old", "YO7 2BB", 1, "2026-09-10T00:00:00Z"),
      leadAt("in-area", "YO1 1AA", 0, "2026-09-01T00:00:00Z"),
      leadAt("no-postcode", null, 0, "2026-09-01T00:00:00Z"),
    ];
    expect(paceLeadsFor(leads, ["YO7", "YO8"]).map((l) => l.id)).toEqual([
      "near-old",
      "near-young",
      "far",
    ]);
  });
});

const customer = (over: Partial<Customer> = {}) =>
  ({
    is_active: true,
    lead_brief_required: true,
    lead_brief_completed_at: "2026-10-01T00:00:00Z",
    account_status: "active",
    subscription_status: "active",
    lead_balance: 5,
    paused_at: null,
    monthly_allocation: 20,
    pool_debit: 0,
    leads_received_this_month: 0,
    billing_cycle_anchor: "2026-10-01",
    created_at: "2026-09-01T00:00:00Z",
    ...over,
  }) as unknown as Customer;

describe("who a brief pass considers", () => {
  it("a confirmed, paying, unpaused brief customer with credit", () => {
    expect(briefCustomerRoutable(customer())).toBe(true);
    expect(isBriefCustomer(customer())).toBe(true);
  });

  it("never an unconfirmed, unflagged, paused, empty or archived one", () => {
    for (const over of [
      { lead_brief_completed_at: null },
      { lead_brief_required: false },
      { paused_at: "2026-10-02T00:00:00Z" },
      { lead_balance: 0 },
      { is_active: false },
      { subscription_status: "past_due" },
      { account_status: "waitlisted" },
    ] as Partial<Customer>[]) {
      expect(briefCustomerRoutable(customer(over))).toBe(false);
    }
    expect(isBriefCustomer(customer({ lead_brief_completed_at: null }))).toBe(false);
    expect(isBriefCustomer(customer({ lead_brief_required: false }))).toBe(false);
  });
});

describe("the behind-pace mirror (A11, D9)", () => {
  it("reads the percentage the way 0163 does", () => {
    expect(briefPacePctFrom("25")).toBe(25);
    expect(briefPacePctFrom(" 12.5 ")).toBe(12.5);
    for (const bad of [null, undefined, "", "abc", "-5", "1e2", "20%"]) {
      expect(briefPacePctFrom(bad)).toBe(BRIEF_PACE_DEFICIT_PCT_DEFAULT);
    }
  });

  it("is behind when the deficit reaches ceil(allocation × pct / 100)", () => {
    const now = new Date("2026-10-16T12:00:00Z"); // 15 days into a cycle anchored 1 Oct
    // expected = round(15/30 × 20) = 10; threshold at 20% of 20 = 4.
    expect(isBehindBriefPace(customer({ leads_received_this_month: 6 }), 20, now)).toBe(true);
    expect(isBehindBriefPace(customer({ leads_received_this_month: 7 }), 20, now)).toBe(false);
    // 10 leads: threshold ceil(2) = 2, expected 5.
    expect(isBehindBriefPace(customer({ monthly_allocation: 10, leads_received_this_month: 3 }), 20, now)).toBe(true);
    expect(isBehindBriefPace(customer({ monthly_allocation: 10, leads_received_this_month: 4 }), 20, now)).toBe(false);
    // ceil, not round: 10 × 25% = 2.5 → 3.
    expect(isBehindBriefPace(customer({ monthly_allocation: 10, leads_received_this_month: 3 }), 25, now)).toBe(false);
  });

  it("is never behind with no allocation, as the SQL's null comparison is false", () => {
    expect(isBehindBriefPace(customer({ monthly_allocation: null as unknown as number }), 20)).toBe(false);
  });
});
