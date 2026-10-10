import { describe, it, expect } from "vitest";
import { distancesFrom, distancesFromNearest } from "@/lib/leadBrief/geo";
import {
  briefTopupApplies,
  briefPlanCredits,
  briefTopupCredits,
  topupLeadsFor,
  topupReach,
  type TopupBrief,
} from "@/lib/leadBrief/topup";
import {
  briefCustomerRoutable,
  briefTopupRoutable,
  topupCustomerOrder,
} from "@/lib/leadBrief/briefRelease";
import { buildBriefMatch } from "@/lib/leadBrief/score";
import {
  TOPUP_REASON,
  nearbyTip,
  parseMatchReasons,
  reasonLine,
} from "@/lib/leadBrief/labelCopy";
import { BRIEF_TOPUP_NOTICE } from "@/lib/leadBrief/topupCopy";
import type { Customer, Lead } from "@/lib/types";
import { lead as supplyLead } from "./fixtures";

/**
 * Batch 04 Phase 4: top-ups for Lead Brief customers (locked decision 6).
 */

const brief = (over: Partial<TopupBrief> = {}): TopupBrief => ({
  allocation: 20,
  base_outcode: "HG2",
  priority_outcodes: [],
  service_outcodes: ["HG2", "HG1", "HG3"],
  ...over,
});

describe("whose top-up goes beyond their area", () => {
  it("a Lead Brief customer's Management top-up, and nobody else's", () => {
    expect(briefTopupApplies({ lead_brief_required: true }, "management")).toBe(true);
    expect(briefTopupApplies({ lead_brief_required: true }, "guaranteed_rent")).toBe(false);
    expect(briefTopupApplies({ lead_brief_required: false }, "management")).toBe(false);
  });
});

describe("plan credits and top-up credits (0170)", () => {
  it("top-up credits are part of the balance, never more than it holds", () => {
    expect(briefTopupCredits({ lead_balance: 7, brief_topup_credits: 5 })).toBe(5);
    expect(briefTopupCredits({ lead_balance: 3, brief_topup_credits: 5 })).toBe(3);
    expect(briefTopupCredits({ lead_balance: 0, brief_topup_credits: 5 })).toBe(0);
    expect(briefTopupCredits({ lead_balance: 4, brief_topup_credits: null })).toBe(0);
  });

  it("plan credits are what is left, and a credit spent elsewhere comes out of them first", () => {
    expect(briefPlanCredits({ lead_balance: 7, brief_topup_credits: 5 })).toBe(2);
    expect(briefPlanCredits({ lead_balance: 5, brief_topup_credits: 5 })).toBe(0);
    expect(briefPlanCredits({ lead_balance: 3, brief_topup_credits: 5 })).toBe(0);
    expect(briefPlanCredits({ lead_balance: 4, brief_topup_credits: null })).toBe(4);
  });
});

describe("topupReach: beyond the area, within the plan maximum, nearest first", () => {
  const base = distancesFrom("HG2")!;

  it("never an outcode inside the service area", () => {
    const reach = topupReach(brief());
    for (const oc of ["HG2", "HG1", "HG3"]) expect(reach).not.toContain(oc);
    expect(reach.length).toBeGreaterThan(0);
  });

  it("never beyond the plan maximum from the base: 75 miles on 20 leads, 40 on 10", () => {
    const twenty = topupReach(brief());
    const ten = topupReach(brief({ allocation: 10 }));
    expect(Math.max(...twenty.map((oc) => base.get(oc)!))).toBeLessThanOrEqual(75);
    expect(Math.max(...ten.map((oc) => base.get(oc)!))).toBeLessThanOrEqual(40);
    expect(Math.max(...twenty.map((oc) => base.get(oc)!))).toBeGreaterThan(40);
    expect(ten.every((oc) => twenty.includes(oc))).toBe(true);
  });

  it("C7: the plan maximum, not the travel limit, so it reaches past 25 miles", () => {
    // The brief's travel limit is not an input at all: locked decision 6's cap.
    const reach = topupReach(brief({ allocation: 10 }));
    expect(reach.some((oc) => base.get(oc)! > 25)).toBe(true);
  });

  it("nearest first, measured from the customer's nearest area", () => {
    const b = brief({ priority_outcodes: ["YO10"] });
    const reach = topupReach(b);
    const nearest = distancesFromNearest(["HG2", "YO10"])!;
    for (let i = 1; i < reach.length; i++) {
      expect(nearest.get(reach[i])!).toBeGreaterThanOrEqual(nearest.get(reach[i - 1])!);
    }
    // Something near the second area comes before something as far from the base alone.
    expect(reach.indexOf("YO1")).toBeLessThan(reach.indexOf("LS6"));
  });

  it("a brief that cannot be placed reaches nowhere, never everywhere", () => {
    expect(topupReach(brief({ allocation: 15 }))).toEqual([]);
    expect(topupReach(brief({ base_outcode: "ZZ99" }))).toEqual([]);
  });
});

const leadAt = (id: string, postcode: string | null, created: string) =>
  ({ id, postcode, created_at: created, assignment_count: 0, max_assignments: 3 }) as unknown as Lead;

describe("topupLeadsFor", () => {
  it("orders by the reach, then oldest, and drops everything else", () => {
    const leads = [
      leadAt("far", "LS6 1AA", "2026-09-01T00:00:00Z"),
      leadAt("near-young", "HG4 1AA", "2026-10-01T00:00:00Z"),
      leadAt("near-old", "HG4 2BB", "2026-09-10T00:00:00Z"),
      leadAt("in-area", "HG2 1AA", "2026-09-01T00:00:00Z"),
      leadAt("no-postcode", null, "2026-09-01T00:00:00Z"),
    ];
    expect(topupLeadsFor(leads, ["HG4", "LS6"]).map((l) => l.id)).toEqual(["near-old", "near-young", "far"]);
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
    brief_topup_credits: 0,
    paused_at: null,
    last_assignment_at: null,
    created_at: "2026-09-01T00:00:00Z",
    ...over,
  }) as unknown as Customer;

describe("who the release's passes consider", () => {
  it("passes 2 and 3 need a plan credit, so top-up credits alone send nothing inside the area", () => {
    expect(briefCustomerRoutable(customer({ lead_balance: 7, brief_topup_credits: 5 }))).toBe(true);
    expect(briefCustomerRoutable(customer({ lead_balance: 5, brief_topup_credits: 5 }))).toBe(false);
  });

  it("pass 4 needs a top-up credit the balance still holds", () => {
    expect(briefTopupRoutable(customer({ lead_balance: 5, brief_topup_credits: 5 }))).toBe(true);
    expect(briefTopupRoutable(customer({ lead_balance: 5, brief_topup_credits: 0 }))).toBe(false);
    expect(briefTopupRoutable(customer({ lead_balance: 0, brief_topup_credits: 5 }))).toBe(false);
    for (const over of [
      { paused_at: "2026-10-02T00:00:00Z" },
      { lead_brief_completed_at: null },
      { is_active: false },
      { subscription_status: "past_due" },
    ] as Partial<Customer>[]) {
      expect(briefTopupRoutable(customer({ brief_topup_credits: 5, ...over }))).toBe(false);
    }
  });

  it("pass 4 serves whoever has waited longest for a lead first", () => {
    const never = customer({ last_assignment_at: null });
    const old = customer({ last_assignment_at: "2026-10-01T00:00:00Z" });
    const recent = customer({ last_assignment_at: "2026-10-09T00:00:00Z" });
    expect([recent, old, never].sort(topupCustomerOrder)).toEqual([never, old, recent]);
  });
});

describe("the label and reason on a top-up lead (locked decision 6, C3)", () => {
  const scoringBrief = {
    allocation: 20,
    travel_limit_miles: 25,
    base_outcode: "YO1",
    priority_outcodes: [],
    similar_areas: [],
    priorities: [{ key: "location", threshold: 50 }],
    service_outcodes: ["YO1"],
    first_pick_outcodes: ["YO8"],
    pace_outcodes: ["YO7"],
  };

  it("always Nearby opportunity, even where it would score a Top match", () => {
    // The same lead and brief: routed it is a Top match, as a top-up it is not.
    const routed = buildBriefMatch(supplyLead("YO1"), scoringBrief, { isFirstSale: true });
    const topup = buildBriefMatch(supplyLead("YO1"), scoringBrief, { isFirstSale: true, topup: true });
    expect(routed.label).toBe("top_match");
    expect(topup.label).toBe("nearby_opportunity");
  });

  it("even in a first-pick outcode, and never claims a first pick", () => {
    const m = buildBriefMatch(supplyLead("YO8"), scoringBrief, {
      isFirstSale: true,
      topup: true,
      competition: "low",
    });
    expect(m.label).toBe("nearby_opportunity");
    expect(m.reasons.first_pick).toBe(false);
    expect(m.reasons).not.toHaveProperty("competition");
  });

  it("stores the top-up flag and no progress sentence", () => {
    const m = buildBriefMatch(supplyLead("YO7"), scoringBrief, {
      isFirstSale: false,
      topup: true,
      progress: { received: 3, allocation: 20, days_left: 10 },
    });
    expect(Object.keys(m.reasons).sort()).toEqual(["area", "first_pick", "priorities", "topup", "v"]);
    expect(m.reasons.topup).toBe(true);
    expect(parseMatchReasons(JSON.parse(JSON.stringify(m.reasons)))).toEqual(m.reasons);
  });

  it("reads, word for word: From just outside your area, as part of your top-up.", () => {
    const m = buildBriefMatch(supplyLead("YO7"), scoringBrief, { isFirstSale: false, topup: true });
    expect(reasonLine(m.label, m.reasons)).toBe("From just outside your area, as part of your top-up.");
    expect(TOPUP_REASON).toBe("From just outside your area, as part of your top-up.");
  });

  it("a routed lead is untouched: no flag, and its own reason", () => {
    const m = buildBriefMatch(supplyLead("YO7"), { ...scoringBrief, priorities: [{ key: "location", threshold: 1 }] }, {
      isFirstSale: false,
    });
    expect(m.reasons).not.toHaveProperty("topup");
    expect(reasonLine(m.label, m.reasons)).not.toBe(TOPUP_REASON);
  });

  it("only a literal true is read as a top-up", () => {
    const base = { v: 1, area: "pace", first_pick: false, priorities: [] };
    expect(parseMatchReasons({ ...base, topup: "yes" })).not.toHaveProperty("topup");
    expect(parseMatchReasons({ ...base, topup: true })?.topup).toBe(true);
    const r = parseMatchReasons({ ...base, topup: true })!;
    expect(reasonLine("nearby_opportunity", r)).toBe(TOPUP_REASON);
    expect(nearbyTip(r, "YO7")).toBe("Adding YO7 to your areas would bring leads like this into your service area.");
  });
});

describe("the notice on the top-up screen", () => {
  it("is the batch's copy, word for word", () => {
    expect(BRIEF_TOPUP_NOTICE.title).toBe("How top-ups are delivered");
    expect(BRIEF_TOPUP_NOTICE.body).toBe(
      "Top-up leads come from the closest matches to your brief, starting just outside your current area. " +
        "Your area's supply is already set by your plan, so a top-up won't add more leads inside it. " +
        "It extends how far your leads reach."
    );
  });

  it("keeps the rest of A9: only 'top-up' is allowed, because the notice is about buying one", () => {
    const text = `${BRIEF_TOPUP_NOTICE.title} ${BRIEF_TOPUP_NOTICE.body}`;
    for (const re of [/\bfilter/i, /\bminimum/i, /\brestricted/i, /\bexpanded/i, /\boverride/i, /outside your criteria/i, /non-?matching/i, /guarantee/i, /!/]) {
      expect(text).not.toMatch(re);
    }
  });
});
