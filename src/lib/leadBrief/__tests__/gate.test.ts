import { describe, it, expect } from "vitest";
import { briefPlanFor, needsLeadBrief, type BriefGateFields } from "@/lib/leadBrief/gate";

const base: BriefGateFields = {
  account_status: "active",
  subscription_status: "active",
  gr_subscription_status: "inactive",
  lead_brief_required: true,
  lead_brief_completed_at: null,
};

describe("needsLeadBrief", () => {
  it("gates a flagged Management customer with no completed brief", () => {
    expect(needsLeadBrief(base)).toBe(true);
  });

  it("never gates a customer who is not flagged (every pre-brief customer)", () => {
    expect(needsLeadBrief({ ...base, lead_brief_required: false })).toBe(false);
  });

  it("releases the gate once the brief is confirmed", () => {
    expect(needsLeadBrief({ ...base, lead_brief_completed_at: "2026-10-09T10:00:00Z" })).toBe(false);
  });

  it("never gates a GR-only customer, even if flagged (invariant 6)", () => {
    expect(
      needsLeadBrief({
        ...base,
        account_status: "waitlisted",
        subscription_status: "inactive",
        gr_subscription_status: "active",
      })
    ).toBe(false);
  });

  it("treats a past-due Management customer as still holding Management", () => {
    expect(
      needsLeadBrief({ ...base, account_status: "invited", subscription_status: "past_due" })
    ).toBe(true);
  });

  it("is false with no customer row", () => {
    expect(needsLeadBrief(null)).toBe(false);
    expect(needsLeadBrief(undefined)).toBe(false);
  });
});

describe("briefPlanFor", () => {
  it("reads the plan from the allocation", () => {
    expect(briefPlanFor({ monthly_allocation: 20, pending_monthly_allocation: null })).toBe(20);
    expect(briefPlanFor({ monthly_allocation: 10, pending_monthly_allocation: null })).toBe(10);
  });

  it("a pending switch to 10 (§24) wins over the current allocation", () => {
    expect(briefPlanFor({ monthly_allocation: 20, pending_monthly_allocation: 10 })).toBe(10);
  });

  it("a bespoke allocation above 20 is the 20-lead plan (§33)", () => {
    expect(briefPlanFor({ monthly_allocation: 30, pending_monthly_allocation: null })).toBe(20);
  });
});
