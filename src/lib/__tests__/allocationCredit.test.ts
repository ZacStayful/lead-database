import { describe, expect, it } from "vitest";
import { afterEach, beforeEach } from "vitest";
import {
  driftMessage,
  resolveCreditAllocation,
  type CreditAllocationInput,
} from "../allocationCredit";
import { allocationForPriceIds } from "../plans";

/** Defaults are a settled 10-lead customer renewing: nothing to decide. */
function input(over: Partial<CreditAllocationInput> = {}): CreditAllocationInput {
  return {
    invoiceAllocation: 10,
    rowAllocation: 10,
    isFirstPayment: false,
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
        isFirstPayment: true,
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
        isFirstPayment: true,
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
        isFirstPayment: false,
      })
    );
    expect(d.allocation).toBe(20);
    expect(d.fromInvoice).toBe(false);
    // Still reported — a human has to be able to tell a comp from a mistake.
    expect(d.drift).toBe(true);
  });

  it("does NOT chase a tier change at invoice time", () => {
    // A plan switch in the Stripe portal is the subscription branch's job: it
    // re-sizes the row from the subscription's CURRENT price, so by the time
    // this invoice is credited the row already says 20.
    //
    // Acting here instead would be actively dangerous, because an invoice does
    // not reliably report the current price. An upgrade with default proration
    // puts BOTH tiers on the next invoice, and a past_due charge collected after
    // an upgrade is at the price the customer has already left. Either would
    // downgrade them — permanently, since from the next renewal nothing
    // re-examines it.
    const d = resolveCreditAllocation(
      input({ invoiceAllocation: 20, rowAllocation: 10, isFirstPayment: false })
    );
    expect(d.allocation).toBe(10);
    expect(d.fromInvoice).toBe(false);
    // Still reported, so a genuine mismatch is visible in the logs.
    expect(d.drift).toBe(true);
  });

  it("stands down for a pending self-serve tier change (§24)", () => {
    // applyPendingPlanChange is applying this very change at this very moment,
    // and it applies exactly when the invoice price agrees with the pending
    // figure. Two writers for one decision is how they come to disagree.
    const d = resolveCreditAllocation(
      input({
        invoiceAllocation: 20,
        rowAllocation: 10,
        isFirstPayment: false,
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
        isFirstPayment: true,
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
        isFirstPayment: true,
      })
    );
    expect(d).toEqual({ allocation: 20, fromInvoice: false, drift: false });
  });

  it("does not re-credit on a renewal once the row has been corrected", () => {
    // The cycle after the fix has fired: row and price now agree and the price
    // id has been recorded, so this is an ordinary renewal again.
    const d = resolveCreditAllocation(
      input({ invoiceAllocation: 10, rowAllocation: 10 })
    );
    expect(d).toEqual({ allocation: 10, fromInvoice: false, drift: false });
  });

  it("never overrules the row after activation, in either direction", () => {
    // The blanket guard behind the two cases above. Whatever an invoice says,
    // once a customer has paid us once the row is the authority and the
    // subscription branch is what keeps it honest.
    for (const [invoiceAllocation, rowAllocation] of [
      [10, 20],
      [20, 10],
    ] as const) {
      const d = resolveCreditAllocation(
        input({ invoiceAllocation, rowAllocation, isFirstPayment: false })
      );
      expect(d.allocation).toBe(rowAllocation);
      expect(d.fromInvoice).toBe(false);
      expect(d.drift).toBe(true);
    }
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

describe("allocationForPriceIds", () => {
  const PRICE_10 = "price_ten";
  const PRICE_20 = "price_twenty";
  const LEGACY_20 = "price_legacy_twenty";
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {
      STRIPE_PRICE_ID_10: process.env.STRIPE_PRICE_ID_10,
      STRIPE_PRICE_ID_20: process.env.STRIPE_PRICE_ID_20,
      STRIPE_MONTHLY_PRICE_ID: process.env.STRIPE_MONTHLY_PRICE_ID,
    };
    process.env.STRIPE_PRICE_ID_10 = PRICE_10;
    process.env.STRIPE_PRICE_ID_20 = PRICE_20;
    process.env.STRIPE_MONTHLY_PRICE_ID = LEGACY_20;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("resolves each tier", () => {
    expect(allocationForPriceIds([PRICE_10])).toBe(10);
    expect(allocationForPriceIds([PRICE_20])).toBe(20);
  });

  it("honours the historical 20-lead price id", () => {
    // stripePriceIdFor still accepts STRIPE_MONTHLY_PRICE_ID, so an existing
    // 20-lead subscriber may be on it. Missing it would read them as unknown.
    expect(allocationForPriceIds([LEGACY_20])).toBe(20);
  });

  it("returns null for a price it does not know", () => {
    // A Payment Link on a price object that is not in env, or a bespoke
    // subscription. Null is what lets the caller leave the row alone.
    expect(allocationForPriceIds(["price_bespoke"])).toBeNull();
    expect(allocationForPriceIds([])).toBeNull();
  });

  it("REFUSES an invoice carrying two tiers", () => {
    // An upgrade made with default proration puts both prices on the next
    // invoice — the old one as a proration credit, the new one as the
    // subscription line. Picking the first match in plan order would read that
    // £300 invoice as the 10-lead plan, and it would never self-heal.
    expect(allocationForPriceIds([PRICE_10, PRICE_20])).toBeNull();
    expect(allocationForPriceIds([PRICE_20, PRICE_10])).toBeNull();
    expect(allocationForPriceIds([PRICE_10, LEGACY_20])).toBeNull();
  });

  it("is not confused by a repeat of the same tier", () => {
    // Two lines at the same price is one tier, not an ambiguity.
    expect(allocationForPriceIds([PRICE_10, PRICE_10])).toBe(10);
    expect(allocationForPriceIds([PRICE_20, LEGACY_20])).toBe(20);
  });

  it("ignores unknown prices alongside a known one", () => {
    // A one-off line item on an otherwise ordinary subscription invoice.
    expect(allocationForPriceIds([PRICE_10, "price_oneoff"])).toBe(10);
  });
});
