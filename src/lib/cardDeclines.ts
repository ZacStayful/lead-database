import type { SupabaseClient } from "@supabase/supabase-js";
import type Stripe from "stripe";

import {
  customerSafeDecline,
  declineDetailFrom,
  paymentIntentIdFromInvoice,
  type DeclineDetail,
} from "@/lib/declineDetail";
import { isSuppressedKey } from "@/lib/declineReason";
import { sendCardDeclinedEmail } from "@/lib/emails";
import { PRODUCT_COPY } from "@/lib/products";
import type { LeadType } from "@/lib/types";

/**
 * Telling a customer their card was declined, and recording why.
 *
 * ⚠️ NOTHING IN HERE MAY THROW. The Stripe webhook deletes its stripe_events
 * idempotency claim on any thrown error so Stripe retries — so an exception
 * escaping this function would make Stripe redeliver an event that has already
 * written past_due, a payments row and a Monday label. Every path returns a
 * result object instead, the same contract setEnquiryStatus and
 * syncCustomerMondayStatus hold for the same reason.
 *
 * ORDER IS THE RULE: claim the audit row by INSERT, and only then send. The
 * unique index on (stripe_invoice_id, attempt_count) is what makes a redelivered
 * event a no-op. Checking "have we sent?" and then sending leaves a window;
 * claiming by write does not. A claim that succeeds and a send that then fails
 * means that attempt is never emailed — accepted openly, because MISSING BEATS
 * DUPLICATE and Stripe has three more attempts coming.
 */

export interface CardDeclineOutcome {
  sent: boolean;
  skipped?:
    | "no_invoice_id"
    | "no_email"
    | "already_sent"
    | "claim_failed"
    | "not_a_subscription";
  reasonKey?: string;
  error?: string;
}

interface DeclineCustomer {
  id: string;
  email: string | null;
  contact_name: string | null;
}

/**
 * Read the decline detail out of Stripe. The ONE network call in this feature.
 *
 * `expand: ["latest_charge"]` and nothing more: payment_method_details is
 * already inline on an expanded Charge, and last_payment_error.payment_method
 * comes back embedded on the PaymentIntent without an expand — which is the
 * fallback when the failure never produced a Charge at all (an off-session
 * intent that lands in requires_payment_method has latest_charge: null).
 *
 * A lookup failure is NOT fatal. We record it and carry on with invoice-level
 * facts and the generic copy, because the customer still needs to fix the card
 * whether or not Stripe would tell us why.
 */
async function loadDetail(
  stripe: Stripe,
  invoice: Stripe.Invoice
): Promise<DeclineDetail> {
  const piId = paymentIntentIdFromInvoice(invoice);
  if (!piId) {
    // A normal outcome, not an exception — but a tripwire worth seeing, because
    // if it starts happening on every decline the version-tolerant reader has
    // stopped matching the account's payload shape.
    console.error("[card-declined] no payment intent on invoice", {
      invoice: invoice.id,
    });
    return declineDetailFrom(invoice, null, "no_payment_intent_on_invoice");
  }

  try {
    const pi = await stripe.paymentIntents.retrieve(piId, {
      expand: ["latest_charge"],
    });
    return declineDetailFrom(invoice, pi);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[card-declined] payment intent lookup failed", {
      invoice: invoice.id,
      paymentIntent: piId,
      error: message,
    });
    return declineDetailFrom(invoice, null, message);
  }
}

export async function notifyCardDeclined(
  admin: SupabaseClient,
  stripe: Stripe,
  params: {
    invoice: Stripe.Invoice;
    customer: DeclineCustomer;
    leadType: LeadType;
    /** Null for a one-off invoice — see the guard in the webhook. */
    subscriptionId: string | null;
  }
): Promise<CardDeclineOutcome> {
  const { invoice, customer, leadType, subscriptionId } = params;

  try {
    if (!invoice.id) return { sent: false, skipped: "no_invoice_id" };

    // Checked BEFORE the claim so a customer whose address lands later can
    // still be emailed by a future backfill rather than being permanently
    // marked as handled.
    if (!customer.email) {
      console.error("[card-declined] customer has no email", {
        customer: customer.id,
        invoice: invoice.id,
      });
      return { sent: false, skipped: "no_email" };
    }

    const detail = await loadDetail(stripe, invoice);

    // ⚠️ Never default a missing attempt_count silently. It is half the claim
    // key, so if it were absent and we quietly used 0, every attempt on this
    // invoice would collapse onto one row and only the first would ever email.
    if (detail.attemptCount === null) {
      console.error("[card-declined] invoice carried no attempt_count", {
        invoice: invoice.id,
        customer: customer.id,
      });
    }

    const { data: claimed, error: claimError } = await admin
      .from("card_decline_events")
      .insert({
        customer_id: customer.id,
        lead_type: leadType,
        stripe_invoice_id: invoice.id,
        attempt_count: detail.attemptCount ?? 0,
        stripe_subscription_id: subscriptionId,
        stripe_payment_intent_id: detail.paymentIntentId,
        stripe_charge_id: detail.chargeId,
        decline_code: detail.declineCode,
        failure_code: detail.failureCode ?? detail.code,
        failure_message: detail.failureMessage,
        outcome_type: detail.outcomeType,
        outcome_reason: detail.outcomeReason,
        outcome_network_status: detail.outcomeNetworkStatus,
        outcome_seller_message: detail.outcomeSellerMessage,
        outcome_risk_level: detail.outcomeRiskLevel,
        card_brand: detail.cardBrand,
        card_last4: detail.cardLast4,
        card_exp_month: detail.cardExpMonth,
        card_exp_year: detail.cardExpYear,
        card_funding: detail.cardFunding,
        card_country: detail.cardCountry,
        amount_due_pence: detail.amountDuePence ?? 0,
        currency: detail.currency,
        next_payment_attempt_at: detail.nextAttemptIso,
        hosted_invoice_url: detail.hostedInvoiceUrl,
        reason_key: detail.reasonKey,
        reason_suppressed: isSuppressedKey(detail.reasonKey),
        pi_resolved: detail.piResolved,
        stripe_lookup_error: detail.stripeLookupError,
        emailed_to: customer.email,
      })
      .select("id")
      .single();

    if (claimError) {
      // 23505 — another delivery of this event already handled this attempt.
      // Ordinary and silent; the whole reason the unique index exists.
      if (claimError.code === "23505") {
        return { sent: false, skipped: "already_sent" };
      }
      // Anything else and we do NOT send: an unrecorded email cannot be
      // deduped, and there are more attempts coming.
      return {
        sent: false,
        skipped: "claim_failed",
        error: claimError.message,
      };
    }

    const safe = customerSafeDecline(detail);
    const { id: emailId, error: emailError } = await sendCardDeclinedEmail({
      to: customer.email,
      contactName: customer.contact_name ?? "there",
      productName: PRODUCT_COPY[leadType].name,
      ...safe,
    });

    if (emailError) {
      const message =
        emailError instanceof Error ? emailError.message : String(emailError);
      await admin
        .from("card_decline_events")
        .update({ email_error: message.slice(0, 300) })
        .eq("id", claimed.id);
      return { sent: false, reasonKey: detail.reasonKey, error: message };
    }

    await admin
      .from("card_decline_events")
      .update({ email_id: emailId })
      .eq("id", claimed.id);

    return { sent: true, reasonKey: detail.reasonKey };
  } catch (error) {
    // The contract. Nothing reaches the webhook's outer catch from here.
    return {
      sent: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Close every open decline for a product once its payment goes through.
 *
 * ⚠️ A BLANKET UPDATE IS RIGHT HERE, and that is a deliberate departure from
 * stampEpisodeEnded() and closeOpenCancellation(), which both forbid one. Their
 * reasoning is that an older un-stamped row would be given today's date and so
 * invent an episode boundary that never happened. Here every open row for the
 * product genuinely IS resolved by this payment — they all describe attempts on
 * the same unpaid cycle. A reader who knows the other helpers will otherwise
 * read this as the bug those comments warn about.
 *
 * Best-effort and audit-only: the admin badge gates on the live
 * (gr_)subscription_status, never on resolved_at, so a failure here costs
 * tidiness and nothing else.
 */
export async function resolveCardDeclines(
  admin: SupabaseClient,
  customerId: string,
  leadType: LeadType,
  source: string
): Promise<void> {
  try {
    const { error } = await admin
      .from("card_decline_events")
      .update({ resolved_at: new Date().toISOString() })
      .eq("customer_id", customerId)
      .eq("lead_type", leadType)
      .is("resolved_at", null);
    if (error) {
      console.error(`[${source}] resolving card declines failed`, {
        customer: customerId,
        error: error.message,
      });
    }
  } catch (error) {
    console.error(`[${source}] resolving card declines threw`, error);
  }
}
