import { describe, expect, it } from "vitest";
import {
  topupIneligibilityReason,
  type TopupCustomerFields,
} from "@/lib/topupCharge";

/**
 * The rule being enforced: never sell credit the customer cannot spend.
 */
const base: TopupCustomerFields = {
  account_status: "active",
  paused_at: null,
  subscription_status: "active",
  gr_subscription_status: "inactive",
};
const management = (over: Partial<TopupCustomerFields>) =>
  topupIneligibilityReason({ ...base, ...over }, "management");

describe("topupIneligibilityReason — management", () => {
  it("refuses a declined customer", () => {
    // The hole 0097 closed. Every check in this function read account_status,
    // which a decline never changes, while delivery is gated on
    // subscription_status by both candidate functions — so a declined customer
    // passed everything and could be charged £75 for credit routing would never
    // spend, which is exactly what this function exists to prevent.
    expect(management({ subscription_status: "past_due" })).not.toBeNull();
  });

  it("points a declined customer at the portal, not at support", () => {
    // Unlike a cancellation, this one the customer can fix themselves.
    expect(management({ subscription_status: "past_due" })).toMatch(/portal/i);
  });

  it("allows an active customer", () => {
    expect(management({})).toBeNull();
  });

  it.each([
    ["cancelled", { account_status: "cancelled" }],
    ["paused", { paused_at: "2026-08-01T00:00:00Z" }],
    ["not yet active", { account_status: "waitlisted" }],
  ])("refuses a %s customer", (_name, over) => {
    expect(management(over)).not.toBeNull();
  });
});

describe("topupIneligibilityReason — guaranteed rent", () => {
  it("never consults management columns (invariant 6)", () => {
    // account_status and paused_at are management-only, so a dead management
    // subscription must not block a perfectly healthy GR one.
    expect(
      topupIneligibilityReason(
        {
          account_status: "cancelled",
          paused_at: "2026-08-01T00:00:00Z",
          subscription_status: "past_due",
          gr_subscription_status: "active",
        },
        "guaranteed_rent"
      )
    ).toBeNull();
  });

  it("refuses a GR customer who is not active", () => {
    expect(
      topupIneligibilityReason(
        { ...base, gr_subscription_status: "past_due" },
        "guaranteed_rent"
      )
    ).not.toBeNull();
  });
});
