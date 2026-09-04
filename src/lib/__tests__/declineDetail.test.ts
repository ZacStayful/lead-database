import { describe, expect, it } from "vitest";
import type Stripe from "stripe";

import {
  chargeIdFromInvoice,
  customerSafeDecline,
  declineDetailFrom,
  paymentIntentIdFromInvoice,
} from "@/lib/declineDetail";

/** The stripe types are acacia-shaped; these fixtures are deliberately loose. */
const inv = (shape: Record<string, unknown>) =>
  shape as unknown as Stripe.Invoice;
const pi = (shape: Record<string, unknown>) =>
  shape as unknown as Stripe.PaymentIntent;

describe("paymentIntentIdFromInvoice — both API versions", () => {
  it("reads the legacy (acacia) invoice.payment_intent", () => {
    expect(paymentIntentIdFromInvoice(inv({ payment_intent: "pi_1" }))).toBe(
      "pi_1"
    );
  });

  it("reads a legacy expanded payment intent object", () => {
    expect(
      paymentIntentIdFromInvoice(inv({ payment_intent: { id: "pi_1" } }))
    ).toBe("pi_1");
  });

  /**
   * The shape this account actually returns. Production evidence: 0 of 30 paid
   * subscription payments carry a payment intent id, because invoice.paid reads
   * the legacy field and it is gone on basil.
   */
  it("reads the basil invoice.payments[].payment.payment_intent", () => {
    expect(
      paymentIntentIdFromInvoice(
        inv({
          payments: {
            data: [{ payment: { type: "payment_intent", payment_intent: "pi_2" } }],
          },
        })
      )
    ).toBe("pi_2");
  });

  it("reads a basil expanded payment intent object", () => {
    expect(
      paymentIntentIdFromInvoice(
        inv({ payments: { data: [{ payment: { payment_intent: { id: "pi_2" } } }] } })
      )
    ).toBe("pi_2");
  });

  /**
   * ⚠️ The trap. payments.data accumulates one entry per attempt, NEWEST LAST.
   * Reading it forwards attributes attempt 1's decline reason to attempt 3's
   * email — wrong, plausible, and permanent.
   */
  it("takes the MOST RECENT attempt, not the first", () => {
    expect(
      paymentIntentIdFromInvoice(
        inv({
          payments: {
            data: [
              { payment: { payment_intent: "pi_attempt_1" } },
              { payment: { payment_intent: "pi_attempt_2" } },
              { payment: { payment_intent: "pi_attempt_3" } },
            ],
          },
        })
      )
    ).toBe("pi_attempt_3");
  });

  it("skips entries carrying no payment intent", () => {
    expect(
      paymentIntentIdFromInvoice(
        inv({
          payments: {
            data: [{ payment: { payment_intent: "pi_1" } }, { payment: null }, null],
          },
        })
      )
    ).toBe("pi_1");
  });

  it("returns null for every empty shape, without throwing", () => {
    expect(paymentIntentIdFromInvoice(inv({}))).toBeNull();
    expect(paymentIntentIdFromInvoice(inv({ payments: null }))).toBeNull();
    expect(paymentIntentIdFromInvoice(inv({ payments: { data: [] } }))).toBeNull();
    expect(paymentIntentIdFromInvoice(inv({ payment_intent: null }))).toBeNull();
    expect(paymentIntentIdFromInvoice(inv({ payment_intent: "" }))).toBeNull();
  });

  it("chargeIdFromInvoice reads the legacy field only", () => {
    expect(chargeIdFromInvoice(inv({ charge: "ch_1" }))).toBe("ch_1");
    expect(chargeIdFromInvoice(inv({ charge: { id: "ch_1" } }))).toBe("ch_1");
    expect(chargeIdFromInvoice(inv({}))).toBeNull();
  });
});

describe("declineDetailFrom — invoice-level facts", () => {
  const invoice = inv({
    id: "in_1",
    attempt_count: 2,
    next_payment_attempt: 1789000000,
    hosted_invoice_url: "https://pay.stripe.com/invoice/abc",
    amount_due: 15000,
    currency: "gbp",
  });

  it("reads them without needing a payment intent", () => {
    const d = declineDetailFrom(invoice, null);
    expect(d.invoiceId).toBe("in_1");
    expect(d.attemptCount).toBe(2);
    expect(d.nextAttemptIso).toBe(new Date(1789000000 * 1000).toISOString());
    expect(d.hostedInvoiceUrl).toBe("https://pay.stripe.com/invoice/abc");
    expect(d.amountDuePence).toBe(15000);
    expect(d.currency).toBe("gbp");
  });

  /**
   * A null PI is a NORMAL outcome — the customer still gets an email, with the
   * generic copy, because they still need to fix the card.
   */
  it("degrades to unknown with piResolved false", () => {
    const d = declineDetailFrom(invoice, null, "lookup exploded");
    expect(d.piResolved).toBe(false);
    expect(d.reasonKey).toBe("unknown");
    expect(d.stripeLookupError).toBe("lookup exploded");
    expect(d.declineCode).toBeNull();
  });

  it("reports a missing attempt_count as null rather than 0", () => {
    // The caller logs on null; silently defaulting would collapse every attempt
    // on an invoice onto one claim row and email only the first.
    expect(declineDetailFrom(inv({ id: "in_1" }), null).attemptCount).toBeNull();
    expect(declineDetailFrom(inv({ id: "in_1" }), null).nextAttemptIso).toBeNull();
  });
});

describe("declineDetailFrom — merge precedence", () => {
  const charge = {
    id: "ch_1",
    failure_code: "card_declined",
    failure_message: "Stripe's own wording",
    outcome: {
      type: "issuer_declined",
      reason: "generic_decline",
      network_status: "declined_by_network",
      seller_message: "The bank returned the decline code insufficient_funds.",
      risk_level: "normal",
    },
    payment_method_details: {
      card: { brand: "visa", last4: "4242", exp_month: 4, exp_year: 2030, funding: "credit", country: "GB" },
    },
  };

  it("last_payment_error outranks the charge", () => {
    const d = declineDetailFrom(
      inv({ id: "in_1" }),
      pi({
        id: "pi_1",
        last_payment_error: {
          code: "card_declined",
          decline_code: "insufficient_funds",
          message: "our preferred source",
        },
        latest_charge: charge,
      })
    );
    expect(d.declineCode).toBe("insufficient_funds");
    expect(d.code).toBe("card_declined");
    expect(d.failureMessage).toBe("our preferred source");
    expect(d.reasonKey).toBe("insufficient_funds");
  });

  it("falls back to the charge when there is no payment error", () => {
    const d = declineDetailFrom(
      inv({ id: "in_1" }),
      pi({ id: "pi_1", latest_charge: charge })
    );
    expect(d.declineCode).toBe("generic_decline");
    expect(d.failureCode).toBe("card_declined");
    expect(d.failureMessage).toBe("Stripe's own wording");
    expect(d.reasonKey).toBe("generic_decline");
  });

  it("keeps the merchant-only outcome fields for the audit row", () => {
    const d = declineDetailFrom(inv({ id: "in_1" }), pi({ id: "pi_1", latest_charge: charge }));
    expect(d.outcomeSellerMessage).toContain("The bank returned");
    expect(d.outcomeRiskLevel).toBe("normal");
    expect(d.outcomeNetworkStatus).toBe("declined_by_network");
    expect(d.outcomeType).toBe("issuer_declined");
    expect(d.chargeId).toBe("ch_1");
  });

  it("reads the card off the charge", () => {
    const d = declineDetailFrom(inv({ id: "in_1" }), pi({ id: "pi_1", latest_charge: charge }));
    expect(d.cardBrand).toBe("visa");
    expect(d.cardLast4).toBe("4242");
    expect(d.cardExpMonth).toBe(4);
    expect(d.cardExpYear).toBe(2030);
  });

  it("falls back to last_payment_error.payment_method when there is no charge", () => {
    const d = declineDetailFrom(
      inv({ id: "in_1" }),
      pi({
        id: "pi_1",
        latest_charge: null,
        last_payment_error: {
          decline_code: "expired_card",
          payment_method: { card: { brand: "mastercard", last4: "9999" } },
        },
      })
    );
    expect(d.cardBrand).toBe("mastercard");
    expect(d.cardLast4).toBe("9999");
    expect(d.reasonKey).toBe("expired_card");
  });

  it("yields nulls rather than undefined when no card is anywhere", () => {
    // Guards against an email rendering "ending undefined".
    const d = declineDetailFrom(inv({ id: "in_1" }), pi({ id: "pi_1" }));
    expect(d.cardBrand).toBeNull();
    expect(d.cardLast4).toBeNull();
    expect(d.cardExpMonth).toBeNull();
  });

  /**
   * An unexpanded latest_charge is a bare id string. Property-accessing it
   * yields undefined for everything, silently.
   */
  it("treats an unexpanded latest_charge as absent", () => {
    const d = declineDetailFrom(
      inv({ id: "in_1" }),
      pi({ id: "pi_1", latest_charge: "ch_unexpanded" })
    );
    expect(d.cardLast4).toBeNull();
    expect(d.outcomeSellerMessage).toBeNull();
    expect(d.failureCode).toBeNull();
    expect(d.reasonKey).toBe("unknown");
  });

  it("suppresses a fraud code end to end", () => {
    const d = declineDetailFrom(
      inv({ id: "in_1" }),
      pi({
        id: "pi_1",
        last_payment_error: { code: "card_declined", decline_code: "stolen_card" },
      })
    );
    // The truth is stored…
    expect(d.declineCode).toBe("stolen_card");
    // …and the customer is told something neutral.
    expect(d.reasonKey).toBe("bank_declined");
  });
});

describe("customerSafeDecline — the leak guard", () => {
  /**
   * ⚠️ Adding a field to customerSafeDecline must fail this test rather than
   * quietly reaching a cardholder. Everything omitted is merchant-facing.
   */
  it("exposes exactly the allow-listed keys", () => {
    const d = declineDetailFrom(
      inv({ id: "in_1", attempt_count: 1, amount_due: 15000, currency: "gbp" }),
      pi({
        id: "pi_1",
        last_payment_error: { decline_code: "stolen_card" },
        latest_charge: {
          outcome: { seller_message: "The bank returned the decline code stolen_card." },
          payment_method_details: { card: { brand: "visa", last4: "4242" } },
        },
      })
    );
    const safe = customerSafeDecline(d);
    expect(Object.keys(safe).sort()).toEqual([
      "amountDuePence",
      "cardBrand",
      "cardLast4",
      "currency",
      "hostedInvoiceUrl",
      "nextAttemptIso",
      "reasonKey",
    ]);
  });

  it("carries no raw code and no seller message", () => {
    const d = declineDetailFrom(
      inv({ id: "in_1" }),
      pi({
        id: "pi_1",
        last_payment_error: { decline_code: "lost_card", message: "Your card was reported lost." },
        latest_charge: {
          outcome: { seller_message: "The bank returned the decline code lost_card." },
        },
      })
    );
    const serialised = JSON.stringify(customerSafeDecline(d));
    expect(serialised).not.toMatch(/lost_card|reported lost|seller/i);
    expect(serialised).toContain("bank_declined");
  });
});
