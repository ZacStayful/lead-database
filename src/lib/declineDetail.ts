import type Stripe from "stripe";

import { declineReasonKey, type DeclineReasonKey } from "@/lib/declineReason";

/**
 * Reading a declined payment out of a Stripe invoice, across two API versions.
 *
 * Pure — every function here takes plain objects and returns plain objects, so
 * both payload shapes are unit-testable with no network. The single network
 * call (retrieving the PaymentIntent) lives in cardDeclines.ts.
 *
 * ⚠️ THE TRAP THIS FILE EXISTS FOR
 * --------------------------------
 * getStripe() pins no apiVersion, so the ACCOUNT DEFAULT decides the payload
 * shape — the same hazard subscriptionIdFromInvoice, priceIdsFromInvoice and
 * subscriptionPeriodEnd already work around. This account is on a version where
 * the legacy invoice fields are gone: the webhook's own comment says "the old
 * invoice.subscription field is gone on this account's API version", and
 * invoice.payment_intent went the same way.
 *
 * The evidence is in production. Both credit_invoice call sites pass
 * `(invoice.payment_intent as string | null) ?? null`, and:
 *
 *   select count(*), count(stripe_payment_intent_id) from payments
 *    where status='paid' and payment_type in ('subscription','gr_subscription');
 *   → 30 rows, 0 with an intent id
 *
 * Read naively, this whole feature would report "no reason given" for every
 * decline — silently, plausibly, and indistinguishably from Stripe not telling
 * us. Hence the both-shapes readers below, and the tests that pin them.
 *
 * The stripe package is ^17.2.0, whose TYPES are the older (acacia) shape, so
 * the newer fields are reached through `as unknown as {...}` exactly as
 * subscriptionIdFromInvoice does. Do not "fix" this by bumping the SDK: that
 * changes the default API version under a client that pins none, which is a far
 * larger change than this feature.
 */

/** Everything we learned about one declined attempt. All optional by design. */
export interface DeclineDetail {
  invoiceId: string | null;
  /** Which attempt this was. Stripe increments it as part of the attempt. */
  attemptCount: number | null;
  nextAttemptIso: string | null;
  hostedInvoiceUrl: string | null;
  amountDuePence: number | null;
  currency: string | null;

  paymentIntentId: string | null;
  chargeId: string | null;
  /** False when no PaymentIntent could be found or retrieved — see below. */
  piResolved: boolean;
  stripeLookupError: string | null;

  // Raw, merchant-facing. Stored for admin, never rendered to a customer.
  declineCode: string | null;
  code: string | null;
  failureCode: string | null;
  failureMessage: string | null;
  outcomeType: string | null;
  outcomeReason: string | null;
  outcomeNetworkStatus: string | null;
  outcomeSellerMessage: string | null;
  outcomeRiskLevel: string | null;

  // Card. brand/last4/expiry are safe to show; funding/country are not useful
  // to a customer and are kept for admin only.
  cardBrand: string | null;
  cardLast4: string | null;
  cardExpMonth: number | null;
  cardExpYear: number | null;
  cardFunding: string | null;
  cardCountry: string | null;

  reasonKey: DeclineReasonKey;
}

type MaybeRef = string | { id?: string | null } | null | undefined;

function refId(value: MaybeRef): string | null {
  if (typeof value === "string") return value || null;
  if (value && typeof value === "object" && typeof value.id === "string") {
    return value.id || null;
  }
  return null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * The PaymentIntent behind this invoice, in whichever shape the account emits.
 *
 * ⚠️ The basil branch iterates `payments.data` IN REVERSE. That array
 * accumulates one entry per attempt, newest last, so reading it forwards would
 * attribute attempt 1's decline reason to attempt 4's email — wrong, plausible,
 * and permanent. There is a test named for this.
 */
export function paymentIntentIdFromInvoice(
  invoice: Stripe.Invoice
): string | null {
  const inv = invoice as unknown as {
    payment_intent?: MaybeRef;
    payments?: {
      data?: Array<{
        payment?: { payment_intent?: MaybeRef } | null;
      } | null> | null;
    } | null;
  };

  // Legacy (acacia and earlier). Kept first because when it is present it is
  // unambiguous — there is only ever one.
  const legacy = refId(inv.payment_intent);
  if (legacy) return legacy;

  // Basil+. Newest attempt last.
  const attempts = inv.payments?.data;
  if (Array.isArray(attempts)) {
    for (let i = attempts.length - 1; i >= 0; i -= 1) {
      const id = refId(attempts[i]?.payment?.payment_intent);
      if (id) return id;
    }
  }

  return null;
}

/**
 * The Charge id off the invoice, legacy shape only.
 *
 * Basil has no invoice-level charge — it hangs off the PaymentIntent instead,
 * and declineDetailFrom picks it up from there. This is a best-effort extra for
 * the audit row and is never load-bearing.
 */
export function chargeIdFromInvoice(invoice: Stripe.Invoice): string | null {
  const inv = invoice as unknown as { charge?: MaybeRef };
  return refId(inv.charge);
}

/** Invoice-level fields, identical in both API versions. */
function invoiceFacts(invoice: Stripe.Invoice) {
  const inv = invoice as unknown as {
    id?: string | null;
    attempt_count?: number | null;
    next_payment_attempt?: number | null;
    hosted_invoice_url?: string | null;
    amount_due?: number | null;
    currency?: string | null;
  };
  const nextAttempt = num(inv.next_payment_attempt);
  return {
    invoiceId: str(inv.id),
    attemptCount: num(inv.attempt_count),
    nextAttemptIso: nextAttempt ? new Date(nextAttempt * 1000).toISOString() : null,
    hostedInvoiceUrl: str(inv.hosted_invoice_url),
    amountDuePence: num(inv.amount_due),
    currency: str(inv.currency),
  };
}

/**
 * Merge an invoice and (optionally) its retrieved PaymentIntent into one record.
 *
 * A null `pi` is a NORMAL outcome, not an error: an invoice that failed at
 * finalisation, an unusual payment method, or a shape we did not guess. The
 * customer still gets an email — with the generic copy — because they still
 * need to fix it. Only `piResolved` records that we could not say why.
 */
export function declineDetailFrom(
  invoice: Stripe.Invoice,
  pi: Stripe.PaymentIntent | null,
  stripeLookupError?: string | null
): DeclineDetail {
  const facts = invoiceFacts(invoice);

  const lastError = (pi?.last_payment_error ?? null) as {
    code?: string | null;
    decline_code?: string | null;
    message?: string | null;
    payment_method?: { card?: Record<string, unknown> | null } | null;
  } | null;

  // Only when EXPANDED. An unexpanded latest_charge is a bare id string, and
  // property-accessing it would silently yield undefined everywhere.
  const rawCharge = pi?.latest_charge;
  const charge =
    rawCharge && typeof rawCharge === "object"
      ? (rawCharge as unknown as {
          id?: string | null;
          failure_code?: string | null;
          failure_message?: string | null;
          outcome?: {
            type?: string | null;
            reason?: string | null;
            network_status?: string | null;
            seller_message?: string | null;
            risk_level?: string | null;
          } | null;
          payment_method_details?: { card?: Record<string, unknown> | null } | null;
        })
      : null;

  const card =
    charge?.payment_method_details?.card ?? lastError?.payment_method?.card ?? null;

  const declineCode = str(lastError?.decline_code) ?? str(charge?.outcome?.reason);
  const code = str(lastError?.code);
  const failureCode = str(charge?.failure_code);

  return {
    ...facts,
    paymentIntentId: pi?.id ?? paymentIntentIdFromInvoice(invoice),
    chargeId: str(charge?.id) ?? chargeIdFromInvoice(invoice),
    piResolved: Boolean(pi),
    stripeLookupError: str(stripeLookupError),

    declineCode,
    code,
    failureCode,
    failureMessage: str(lastError?.message) ?? str(charge?.failure_message),
    outcomeType: str(charge?.outcome?.type),
    outcomeReason: str(charge?.outcome?.reason),
    outcomeNetworkStatus: str(charge?.outcome?.network_status),
    outcomeSellerMessage: str(charge?.outcome?.seller_message),
    outcomeRiskLevel: str(charge?.outcome?.risk_level),

    cardBrand: str(card?.brand),
    cardLast4: str(card?.last4),
    cardExpMonth: num(card?.exp_month),
    cardExpYear: num(card?.exp_year),
    cardFunding: str(card?.funding),
    cardCountry: str(card?.country),

    reasonKey: declineReasonKey({ declineCode, code, failureCode }),
  };
}

/**
 * The subset of a DeclineDetail that may cross into an email.
 *
 * ⚠️ This is a LEAK GUARD, not a convenience. Everything omitted is
 * merchant-facing: outcomeSellerMessage spells out a suppressed decline code in
 * plain English, failureMessage is Stripe's own wording rather than ours, and
 * the raw codes are the thing declineReason.ts exists to translate. There is a
 * test asserting this object's exact key set, so adding a field here fails the
 * build rather than quietly reaching a customer.
 */
export function customerSafeDecline(detail: DeclineDetail): {
  reasonKey: DeclineReasonKey;
  cardBrand: string | null;
  cardLast4: string | null;
  amountDuePence: number | null;
  currency: string | null;
  hostedInvoiceUrl: string | null;
  nextAttemptIso: string | null;
} {
  return {
    reasonKey: detail.reasonKey,
    cardBrand: detail.cardBrand,
    cardLast4: detail.cardLast4,
    amountDuePence: detail.amountDuePence,
    currency: detail.currency,
    hostedInvoiceUrl: detail.hostedInvoiceUrl,
    nextAttemptIso: detail.nextAttemptIso,
  };
}
