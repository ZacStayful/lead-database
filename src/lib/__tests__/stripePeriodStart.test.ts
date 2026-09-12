import { describe, expect, it } from "vitest";
import type Stripe from "stripe";
import { subscriptionPeriodStartFromInvoice } from "../stripe";

const AUG_1 = Date.UTC(2026, 7, 1) / 1000;
const SEP_1 = Date.UTC(2026, 8, 1) / 1000;
const OCT_1 = Date.UTC(2026, 9, 1) / 1000;
const SEP_15 = Date.UTC(2026, 8, 15) / 1000;

type Line = Record<string, unknown>;

function invoice(over: {
  period_start?: number;
  lines: Line[];
}): Stripe.Invoice {
  return {
    id: "in_test",
    period_start: over.period_start ?? SEP_1,
    lines: { data: over.lines },
  } as unknown as Stripe.Invoice;
}

/** The legacy line shape: `type: "subscription"` with `subscription` set. */
function legacyLine(start: number, end: number, over: Line = {}): Line {
  return {
    type: "subscription",
    subscription: "sub_1",
    proration: false,
    period: { start, end },
    ...over,
  };
}

/** The basil line shape: no `type`, the subscription sits under `parent`. */
function basilLine(start: number, end: number, over: Line = {}): Line {
  return {
    parent: { subscription_item_details: { subscription: "sub_1" } },
    proration: false,
    period: { start, end },
    ...over,
  };
}

describe("subscriptionPeriodStartFromInvoice", () => {
  it("a first invoice: the line period and invoice.period_start agree", () => {
    const inv = invoice({ period_start: SEP_1, lines: [legacyLine(SEP_1, OCT_1)] });
    expect(subscriptionPeriodStartFromInvoice(inv)).toBe(SEP_1);
  });

  it("THE BUG: a renewal invoice's period_start is the PREVIOUS period, the line is the new one", () => {
    // Stripe's one-period lookback: the invoice raised on 1 Sep for Sep says
    // period_start = 1 Aug. Anchoring on that put customers a month behind.
    const inv = invoice({ period_start: AUG_1, lines: [legacyLine(SEP_1, OCT_1)] });
    expect(subscriptionPeriodStartFromInvoice(inv)).toBe(SEP_1);
    expect(subscriptionPeriodStartFromInvoice(inv)).not.toBe(inv.period_start);
  });

  it("reads the basil line shape too", () => {
    const inv = invoice({ period_start: AUG_1, lines: [basilLine(SEP_1, OCT_1)] });
    expect(subscriptionPeriodStartFromInvoice(inv)).toBe(SEP_1);
  });

  it("skips proration lines so a mid-cycle upgrade does not move the anchor", () => {
    // Upgrade on 15 Sep with default proration: a credit for the unused half of
    // the old price and a charge for the new — both prorations dated 15 Sep —
    // plus, on the NEXT renewal, the ordinary line. A pure-proration invoice
    // has nothing to anchor on.
    const pure = invoice({
      period_start: SEP_1,
      lines: [
        legacyLine(SEP_15, OCT_1, { proration: true }),
        legacyLine(SEP_15, OCT_1, { proration: true }),
      ],
    });
    expect(subscriptionPeriodStartFromInvoice(pure)).toBeNull();

    // A renewal that also carries a leftover proration line still anchors on
    // the ordinary line, not the proration's later date.
    const mixed = invoice({
      period_start: AUG_1,
      lines: [legacyLine(SEP_1, OCT_1), legacyLine(SEP_15, OCT_1, { proration: true })],
    });
    expect(subscriptionPeriodStartFromInvoice(mixed)).toBe(SEP_1);
  });

  it("takes the latest ordinary subscription line when there are several", () => {
    const inv = invoice({
      period_start: AUG_1,
      lines: [legacyLine(AUG_1, SEP_1), legacyLine(SEP_1, OCT_1)],
    });
    expect(subscriptionPeriodStartFromInvoice(inv)).toBe(SEP_1);
  });

  it("returns null for an invoice with no subscription line — never period_start or created", () => {
    const oneOff = invoice({
      period_start: SEP_1,
      lines: [{ type: "invoiceitem", proration: false, period: { start: SEP_15, end: SEP_15 } }],
    });
    expect(subscriptionPeriodStartFromInvoice(oneOff)).toBeNull();

    const empty = invoice({ period_start: SEP_1, lines: [] });
    expect(subscriptionPeriodStartFromInvoice(empty)).toBeNull();

    const noLines = { id: "in_x", period_start: SEP_1 } as unknown as Stripe.Invoice;
    expect(subscriptionPeriodStartFromInvoice(noLines)).toBeNull();
  });

  it("ignores a malformed period", () => {
    const inv = invoice({
      period_start: SEP_1,
      lines: [legacyLine(0, OCT_1), { type: "subscription", subscription: "sub_1", period: null }],
    });
    expect(subscriptionPeriodStartFromInvoice(inv)).toBeNull();
  });
});
