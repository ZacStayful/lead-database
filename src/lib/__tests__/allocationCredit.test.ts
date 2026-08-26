import { describe, expect, it } from "vitest";
import {
  driftMessage,
  resolveCreditAllocation,
  type CreditAllocationInput,
} from "../allocationCredit";

const PRICE_10 = "price_ten";
const PRICE_20 = "price_twenty";

/** Defaults are a settled 10-lead customer renewing: nothing to decide. */
function input(over: Partial<CreditAllocationInput> = {}): CreditAllocationInput {
  return {
    invoiceAllocation: 10,
    rowAllocation: 10,
    invoicePriceId: PRICE_10,
    recordedPriceId: PRICE_10,
    pendingAllocation: null,
    ...over,
  };
}

describe("resolveCreditAllocation", () => {
  it("credits the row when everything agrees", () => {
    const d = resolveCreditAllocation(input());
    expect(d).toEqual({ allocation: 10, fromInvoice: false, drift: false });
  });

  it("THE BUG: a first payment credits what was actually paid for", () => {
    // The customer clicked the £300/20 plan, so the row says 20 — then paid the
    // £150/10 session they had opened first. Before this, we credited 20 leads a
    // month for £150, for ever. The recorded price is null because no
    // subscription event has landed yet, so the price has "moved" by definition.
    const d = resolveCreditAllocation(
      input({
        invoiceAllocation: 10,
        rowAllocation: 20,
        invoicePriceId: PRICE_10,
        recordedPriceId: null,
      })
    );
    expect(d.allocation).toBe(10);
    expect(d.fromInvoice).toBe(true);
    expect(d.drift).toBe(true);
  });

  it("does not under-credit the mirror case", () => {
    // The same accident in the other direction: row left on 10, paid £300.
    // Crediting the row would short-change a customer who paid us more.
    const d = resolveCreditAllocation(
      input({
        invoiceAllocation: 20,
        rowAllocation: 10,
        invoicePriceId: PRICE_20,
        recordedPriceId: null,
      })
    );
    expect(d.allocation).toBe(20);
    expect(d.fromInvoice).toBe(true);
  });

  it("KEEPS A COMP: row edited, price never moved", () => {
    // An admin deliberately gave this customer 20 leads on a £150 subscription.
    // The price is the same one we recorded, so nothing here may overrule them —
    // this is the line §17 and §24 both drew, and the whole reason the test is
    // "has the price moved" rather than "do they disagree".
    const d = resolveCreditAllocation(
      input({
        invoiceAllocation: 10,
        rowAllocation: 20,
        invoicePriceId: PRICE_10,
        recordedPriceId: PRICE_10,
      })
    );
    expect(d.allocation).toBe(20);
    expect(d.fromInvoice).toBe(false);
    // Still reported — a human has to be able to tell a comp from a mistake.
    expect(d.drift).toBe(true);
  });

  it("follows a genuine tier change made outside the app", () => {
    // A plan switch in the Stripe portal, or an admin editing the subscription
    // directly. The price moved and the row is stale, so the money wins.
    const d = resolveCreditAllocation(
      input({
        invoiceAllocation: 20,
        rowAllocation: 10,
        invoicePriceId: PRICE_20,
        recordedPriceId: PRICE_10,
      })
    );
    expect(d.allocation).toBe(20);
    expect(d.fromInvoice).toBe(true);
  });

  it("stands down for a pending self-serve tier change (§24)", () => {
    // applyPendingPlanChange is applying this very change at this very moment,
    // and it applies exactly when the invoice price agrees with the pending
    // figure. Two writers for one decision is how they come to disagree.
    const d = resolveCreditAllocation(
      input({
        invoiceAllocation: 20,
        rowAllocation: 10,
        invoicePriceId: PRICE_20,
        recordedPriceId: PRICE_10,
        pendingAllocation: 20,
      })
    );
    expect(d.allocation).toBe(10);
    expect(d.fromInvoice).toBe(false);
    expect(d.drift).toBe(false);
  });

  it("does not stand down for an unrelated pending change", () => {
    // A pending change to a DIFFERENT tier than this invoice is for. That change
    // is not being applied by this invoice, so it must not shield the drift.
    const d = resolveCreditAllocation(
      input({
        invoiceAllocation: 10,
        rowAllocation: 20,
        invoicePriceId: PRICE_10,
        recordedPriceId: null,
        pendingAllocation: 20,
      })
    );
    expect(d.allocation).toBe(10);
    expect(d.fromInvoice).toBe(true);
  });

  it("leaves the row alone for a price it does not recognise", () => {
    // A Payment Link on a price object that is not in env, or a bespoke
    // subscription. We know nothing, so we overrule nothing — and we must not
    // report drift we cannot substantiate.
    const d = resolveCreditAllocation(
      input({
        invoiceAllocation: null,
        rowAllocation: 20,
        invoicePriceId: "price_bespoke",
        recordedPriceId: null,
      })
    );
    expect(d).toEqual({ allocation: 20, fromInvoice: false, drift: false });
  });

  it("does not re-credit on a renewal once the row has been corrected", () => {
    // The cycle after the fix has fired: row and price now agree and the price
    // id has been recorded, so this is an ordinary renewal again.
    const d = resolveCreditAllocation(
      input({ invoiceAllocation: 10, rowAllocation: 10, recordedPriceId: PRICE_10 })
    );
    expect(d).toEqual({ allocation: 10, fromInvoice: false, drift: false });
  });

  it("tolerates an unreadable invoice price id", () => {
    // A null invoice price against a null recorded price is not a move.
    const d = resolveCreditAllocation(
      input({
        invoiceAllocation: 10,
        rowAllocation: 20,
        invoicePriceId: null,
        recordedPriceId: null,
      })
    );
    expect(d.fromInvoice).toBe(false);
    expect(d.allocation).toBe(20);
    expect(d.drift).toBe(true);
  });
});

describe("driftMessage", () => {
  it("says the price moved when the invoice won", () => {
    const d = { allocation: 10, fromInvoice: true, drift: true };
    const msg = driftMessage("cus-1", "management", d, 10, 20);
    expect(msg).toContain("cus-1");
    expect(msg).toContain("has changed");
    expect(msg).toContain("crediting 10");
  });

  it("says the price did NOT move when the row won, and points at admin", () => {
    // This is the comp case, and the wording has to make a human look — from the
    // numbers alone a deliberate comp and a mistake are indistinguishable.
    const d = { allocation: 20, fromInvoice: false, drift: true };
    const msg = driftMessage("cus-2", "management", d, 10, 20);
    expect(msg).toContain("has NOT changed");
    expect(msg).toContain("Correct it in admin");
  });
});
