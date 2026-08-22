import { describe, expect, it } from "vitest";
import {
  mondayStatusLabelFor,
  type MondayStatusCandidate,
} from "@/lib/mondayStatus";

/**
 * The label rule is ORDER-SENSITIVE and a pure function of the customer row —
 * the property 0087 was written to establish, after a version taking the
 * pending-cancellation flag as a parameter let four of six hooks silently write
 * `Management Customer` over `Cancelled`. These cases exist so a reordering or a
 * new clause cannot quietly break a branch that only one caller reaches.
 */
const base: MondayStatusCandidate = {
  is_active: true,
  paused_at: null,
  account_status: "active",
  subscription_status: "active",
  gr_subscription_status: "inactive",
  cancel_at_period_end: false,
  gr_cancel_at_period_end: false,
  lapsed_at: null,
  gr_lapsed_at: null,
};
const label = (over: Partial<MondayStatusCandidate>) =>
  mondayStatusLabelFor({ ...base, ...over });

const LAPSED = "2026-08-22T06:00:00Z";

describe("mondayStatusLabelFor — the lapse (0097)", () => {
  it("reads a lapsed management customer as Cancelled", () => {
    expect(label({ subscription_status: "past_due", lapsed_at: LAPSED })).toBe(
      "Cancelled"
    );
  });

  it("leaves a declined customer on card-declined until they lapse", () => {
    expect(label({ subscription_status: "past_due" })).toBe(
      "Wants to pay card declined"
    );
  });

  it("keeps a paying GR customer off the Cancelled label when management lapses", () => {
    // The defect this suite caught. Rule 1 deliberately steps aside for a live
    // GR subscription, so without the `and not cancelling` guard on the
    // card-declined rule this fell through and read "Wants to pay card
    // declined" — while the identical customer with management cancelled
    // OUTRIGHT read "Guaranteed rent customer". A paying GR customer must never
    // be described by their dead management subscription.
    expect(
      label({
        subscription_status: "past_due",
        lapsed_at: LAPSED,
        gr_subscription_status: "active",
      })
    ).toBe("Guaranteed rent customer");
  });

  it("reads a lapsed GR-only customer as Cancelled", () => {
    expect(
      label({
        account_status: "waitlisted",
        subscription_status: "inactive",
        gr_subscription_status: "past_due",
        gr_lapsed_at: LAPSED,
      })
    ).toBe("Cancelled");
  });

  it("keeps a live management customer when only GR has lapsed", () => {
    expect(
      label({ gr_subscription_status: "past_due", gr_lapsed_at: LAPSED })
    ).toBe("Management Customer");
  });

  it("puts Cancelled ahead of Paused", () => {
    expect(
      label({
        subscription_status: "past_due",
        paused_at: "2026-08-01T00:00:00Z",
        lapsed_at: LAPSED,
      })
    ).toBe("Cancelled");
  });

  it("returns them to Management Customer once the stamps are cleared", () => {
    // Recovery. invoice.paid clears lapsed_at and past_due_since and promotes
    // account_status, so no separate un-lapse path is needed.
    expect(label({})).toBe("Management Customer");
  });

  it("still writes nothing for an archived row, lapsed or not", () => {
    expect(
      label({ is_active: false, subscription_status: "past_due", lapsed_at: LAPSED })
    ).toBeNull();
  });
});

describe("mondayStatusLabelFor — existing behaviour", () => {
  it("labels a plain management customer", () => {
    expect(label({})).toBe("Management Customer");
  });

  it("labels a pending cancellation immediately", () => {
    expect(label({ cancel_at_period_end: true })).toBe("Cancelled");
  });

  it("labels a paused customer", () => {
    expect(label({ paused_at: "2026-08-01T00:00:00Z" })).toBe("Paused");
  });

  it("labels a cancelled subscription", () => {
    expect(
      label({ subscription_status: "canceled", account_status: "cancelled" })
    ).toBe("Cancelled");
  });

  it("labels a GR-only subscriber, who is waitlisted for management for ever", () => {
    expect(
      label({
        account_status: "waitlisted",
        subscription_status: "inactive",
        gr_subscription_status: "active",
      })
    ).toBe("Guaranteed rent customer");
  });

  it("keeps a live GR subscription ahead of a management cancellation", () => {
    expect(
      label({ cancel_at_period_end: true, gr_subscription_status: "active" })
    ).toBe("Guaranteed rent customer");
  });

  it("writes nothing for a prospect, so their hand-set sales label survives", () => {
    expect(
      label({ account_status: "waitlisted", subscription_status: "inactive" })
    ).toBeNull();
  });

  it("lets a paying customer outvote a stale cancelled account_status", () => {
    // The re-subscribe trap: account_status could sit at 'cancelled' for ever
    // (§23.9). The rule keys on subscription_status so it does not depend on
    // that fix having run.
    expect(
      label({ account_status: "cancelled", subscription_status: "active" })
    ).toBe("Management Customer");
  });

  it("does not let a stale cancelled account_status turn a decline into Cancelled", () => {
    // Why lapsed_at had to be its own column rather than a widening of the
    // account_status clause: that clause excludes past_due on purpose.
    expect(
      label({ account_status: "cancelled", subscription_status: "past_due" })
    ).toBe("Wants to pay card declined");
  });
});
