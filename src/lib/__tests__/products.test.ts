import { describe, expect, it } from "vitest";
import {
  availableLeadTypes,
  holdsProduct,
  previouslyHeldProduct,
  type ProductHistoryFields,
} from "../products";

/**
 * A customer row carrying only the columns these predicates read. Defaults are
 * a never-subscribed waitlisted account — the case the §17 guard exists for —
 * so every test states exactly what it changes.
 */
function customer(over: Partial<ProductHistoryFields> = {}): ProductHistoryFields {
  return {
    account_status: "waitlisted",
    subscription_status: "inactive",
    gr_subscription_status: "inactive",
    cancelled_at: null,
    gr_cancelled_at: null,
    ...over,
  };
}

describe("previouslyHeldProduct", () => {
  it("is false for every never-subscribed status", () => {
    // THE test that keeps self-serve acquisition retired. If this ever goes
    // true, /api/customer/subscribe stops refusing waitlisted prospects.
    for (const account_status of ["waitlisted", "invited"]) {
      const c = customer({ account_status });
      expect(previouslyHeldProduct(c, "management")).toBe(false);
      expect(previouslyHeldProduct(c, "guaranteed_rent")).toBe(false);
    }
  });

  it("is true for a cancelled management customer", () => {
    expect(
      previouslyHeldProduct(
        customer({ account_status: "cancelled", cancelled_at: "2026-01-01T00:00:00Z" }),
        "management"
      )
    ).toBe(true);
  });

  it("accepts account_status alone, for a row cancelled before 0064", () => {
    expect(
      previouslyHeldProduct(customer({ account_status: "cancelled" }), "management")
    ).toBe(true);
  });

  it("reads GR from its own timestamp and never from account_status", () => {
    // A GR-only subscriber sits at account_status 'waitlisted' for ever (§18A),
    // so the management column says nothing about whether GR was ever held.
    const grLeft = customer({ gr_cancelled_at: "2026-01-01T00:00:00Z" });
    expect(previouslyHeldProduct(grLeft, "guaranteed_rent")).toBe(true);
    expect(previouslyHeldProduct(grLeft, "management")).toBe(false);

    const mgmtLeft = customer({
      account_status: "cancelled",
      cancelled_at: "2026-01-01T00:00:00Z",
    });
    expect(previouslyHeldProduct(mgmtLeft, "guaranteed_rent")).toBe(false);
  });

  it("is false while the product is still held", () => {
    // Held and previously-held are exclusive, so callers can OR them without
    // double-counting. A customer who cancelled and came back holds it again.
    const returned = customer({
      account_status: "active",
      subscription_status: "active",
      cancelled_at: "2026-01-01T00:00:00Z",
    });
    expect(holdsProduct(returned, "management")).toBe(true);
    expect(previouslyHeldProduct(returned, "management")).toBe(false);
  });
});

describe("availableLeadTypes", () => {
  it("is empty for a never-subscribed account", () => {
    expect(availableLeadTypes(customer())).toEqual([]);
  });

  it("gives an active management customer management only", () => {
    expect(
      availableLeadTypes(
        customer({ account_status: "active", subscription_status: "active" })
      )
    ).toEqual(["management"]);
  });

  it("keeps a paused customer's product", () => {
    // A paused customer's row is indistinguishable from an active one here:
    // account_status and subscription_status both stay 'active' through a pause
    // (§21), and paused_at is not a column these predicates read. Pinned because
    // the free-CRM promise depends on a pause never narrowing what they can add.
    expect(
      availableLeadTypes(
        customer({ account_status: "active", subscription_status: "active" })
      )
    ).toEqual(["management"]);
  });

  it("keeps a cancelled customer's product — the free CRM rule", () => {
    expect(
      availableLeadTypes(
        customer({ account_status: "cancelled", cancelled_at: "2026-01-01T00:00:00Z" })
      )
    ).toEqual(["management"]);
  });

  it("gives a cancelled GR-only customer guaranteed rent only", () => {
    expect(
      availableLeadTypes(customer({ gr_cancelled_at: "2026-01-01T00:00:00Z" }))
    ).toEqual(["guaranteed_rent"]);
  });

  it("gives both to a customer who has held both, live or not", () => {
    expect(
      availableLeadTypes(
        customer({
          account_status: "active",
          subscription_status: "active",
          gr_cancelled_at: "2026-01-01T00:00:00Z",
        })
      )
    ).toEqual(["management", "guaranteed_rent"]);
  });

  it("does not let a live GR-only customer file management leads", () => {
    // The gate is per product, not "are you a customer of ours" (invariant 6).
    expect(
      availableLeadTypes(customer({ gr_subscription_status: "active" }))
    ).toEqual(["guaranteed_rent"]);
  });

  it("treats past_due as held on both products", () => {
    expect(
      availableLeadTypes(customer({ subscription_status: "past_due" }))
    ).toEqual(["management"]);
    expect(
      availableLeadTypes(customer({ gr_subscription_status: "past_due" }))
    ).toEqual(["guaranteed_rent"]);
  });
});
