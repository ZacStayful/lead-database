/**
 * The picker's status word (§62), over the row shapes the book actually
 * holds. The first version labelled every unpaused customer "cancelling"
 * because it tested an object as a boolean; the "active" cases here are the
 * ones that would have caught it.
 */
import { describe, expect, it } from "vitest";
import { portalProducts, portalStatus, type PortalStatusFields } from "../portalStatus";

function row(over: Partial<PortalStatusFields> = {}): PortalStatusFields {
  return {
    account_status: "waitlisted",
    subscription_status: "inactive",
    gr_subscription_status: "inactive",
    paused_at: null,
    cancel_at_period_end: false,
    gr_cancel_at_period_end: false,
    cancel_effective_at: null,
    gr_cancel_effective_at: null,
    ...over,
  };
}

const mgmt = row({ account_status: "active", subscription_status: "active" });
// A GR-only subscriber sits at account_status = 'waitlisted' for ever (§18A).
const grOnly = row({ gr_subscription_status: "active" });

describe("portalStatus", () => {
  it("reads an active management subscriber as active", () => {
    expect(portalStatus(mgmt)).toBe("active");
    expect(portalProducts(mgmt)).toBe("Management");
  });

  it("reads a GR-only subscriber as active despite account_status = waitlisted", () => {
    expect(portalStatus(grOnly)).toBe("active");
    expect(portalProducts(grOnly)).toBe("Guaranteed Rent");
  });

  it("lists both products for a customer holding both", () => {
    expect(portalProducts(row({ ...mgmt, gr_subscription_status: "active" }))).toBe(
      "Management · Guaranteed Rent"
    );
  });

  it("does not call an active customer cancelling just because the helper returns an object", () => {
    // cancel_at_period_end false on both products — the shape of most of the book.
    expect(portalStatus(mgmt)).not.toBe("cancelling");
    expect(portalStatus(grOnly)).not.toBe("cancelling");
  });

  it("reads a pending cancellation on either product as cancelling", () => {
    expect(portalStatus(row({ ...mgmt, cancel_at_period_end: true }))).toBe("cancelling");
    expect(portalStatus(row({ ...grOnly, gr_cancel_at_period_end: true }))).toBe("cancelling");
  });

  it("puts a pause ahead of active and ahead of cancelling", () => {
    expect(portalStatus(row({ ...mgmt, paused_at: "2026-09-01T00:00:00Z" }))).toBe("paused");
    expect(
      portalStatus(row({ ...mgmt, paused_at: "2026-09-01T00:00:00Z", cancel_at_period_end: true }))
    ).toBe("paused");
  });

  it("reads past_due on either product as declined", () => {
    expect(portalStatus(row({ ...mgmt, subscription_status: "past_due" }))).toBe("declined");
    expect(portalStatus(row({ gr_subscription_status: "past_due" }))).toBe("declined");
  });

  it("reads the non-holders by their account status", () => {
    expect(portalStatus(row())).toBe("waitlisted");
    expect(portalStatus(row({ account_status: "invited" }))).toBe("invited");
    expect(portalStatus(row({ account_status: "cancelled", subscription_status: "canceled" }))).toBe(
      "cancelled"
    );
    expect(portalProducts(row())).toBe("");
  });
});
