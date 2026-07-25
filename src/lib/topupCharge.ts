/**
 * The single top-up charge path.
 *
 * Both entry points — the emailed/SMS single-use link (`/topup/[token]`) and
 * the in-portal "Top up leads" tab — funnel through `chargeClaimedTopup`, so
 * there is exactly one place where money moves and one place where credit is
 * granted. Do not add a second charge path.
 *
 * The hard rule here is: NEVER finalise a token as failed unless the outcome is
 * DEFINITIVE. A Stripe connection error or timeout can be thrown after the
 * charge was captured, and an intent can settle asynchronously — treating
 * either as failure would take £75 and grant nothing, with no way back. On an
 * indeterminate outcome we release the claim instead, so the customer can retry
 * the same token; the Stripe idempotency key (derived from the token id) means
 * a retry returns the ORIGINAL intent rather than charging again.
 */
import type Stripe from "stripe";
import type { createAdminClient } from "@/lib/supabase/admin";
import { APP_URL } from "@/lib/env";
import { productLabel } from "@/lib/topup";
import type { Customer, LeadType } from "@/lib/types";

type Admin = ReturnType<typeof createAdminClient>;

/** The row returned by claim_lead_topup_token. */
export interface ClaimedTopup {
  token_id: string;
  customer_id: string;
  lead_type: LeadType;
  credits: number;
  amount_pence: number;
  stripe_customer_id: string | null;
}

export type ChargeOutcome =
  /** Charged and credited. */
  | { kind: "success"; credits: number; leadType: LeadType }
  /** No reusable card — send the customer to a hosted Stripe page. */
  | { kind: "redirect"; url: string }
  /** Definitive failure. The token is finalised; retrying needs a new one. */
  | { kind: "failed"; message: string }
  /**
   * Outcome unknown or still settling. The claim has been released so the SAME
   * token can be retried safely; nothing has been finalised.
   */
  | { kind: "pending"; message: string };

/** Stripe error classes that are NOT proof the charge failed. */
function isIndeterminate(err: Stripe.errors.StripeError): boolean {
  switch (err?.type) {
    case "StripeCardError":
    case "StripeInvalidRequestError":
      return false;
    default:
      // Connection, API, rate-limit, auth, permission, unknown — the charge may
      // or may not have been captured.
      return true;
  }
}

/**
 * Release an indeterminate claim so the token can be retried. Best-effort: if
 * the release itself fails the token simply stays claimed, which is the safe
 * direction (no double charge), and the payment_intent.succeeded webhook is the
 * backstop that still credits a charge that actually landed.
 */
async function release(supabase: Admin, tokenId: string): Promise<void> {
  const { error } = await supabase.rpc("release_lead_topup_token", {
    p_token_id: tokenId,
  });
  if (error) console.error("release_lead_topup_token failed", { tokenId, error });
}

/** Record a definitive failure (no credit, token finalised). */
async function finaliseFailed(
  supabase: Admin,
  tokenId: string,
  intentId: string | null
): Promise<void> {
  const { error } = await supabase.rpc("record_lead_topup_failure", {
    p_token_id: tokenId,
    p_payment_intent_id: intentId,
  });
  if (error) console.error("record_lead_topup_failure failed", { tokenId, error });
}

/**
 * Credit a successful charge. The RPC returns FALSE when it declined to credit
 * (unknown token, or already paid). Anything other than a clean `true` on a
 * charge we know succeeded is a money-moved-but-not-credited event and is
 * logged loudly — this is the tripwire for manual reconciliation.
 */
async function finaliseSuccess(
  supabase: Admin,
  tokenId: string,
  intentId: string
): Promise<void> {
  const { data, error } = await supabase.rpc("record_lead_topup_success", {
    p_token_id: tokenId,
    p_payment_intent_id: intentId,
  });
  if (error) {
    console.error("CHARGED BUT NOT CREDITED — record_lead_topup_success errored", {
      tokenId,
      intentId,
      error,
    });
    throw new Error(`record_lead_topup_success failed: ${error.message}`);
  }
  if (data === false) {
    console.error(
      "record_lead_topup_success returned false (already paid, or unknown token)",
      { tokenId, intentId }
    );
  }
}

/**
 * Eligibility for a top-up, checked BEFORE any money moves.
 *
 * A customer who is paused or cancelled cannot be assigned leads
 * (assign_lead_to_customer refuses them), so selling them credit would take £75
 * for something they cannot receive. Branches per product: the pause is
 * management-only, GR has its own subscription status.
 */
export function topupIneligibilityReason(
  customer: Pick<
    Customer,
    "account_status" | "paused_at" | "subscription_status" | "gr_subscription_status"
  >,
  leadType: LeadType
): string | null {
  if (customer.account_status === "cancelled") {
    return "Your account is cancelled, so leads can't be assigned. Please contact support.";
  }
  if (leadType === "guaranteed_rent") {
    if (customer.gr_subscription_status !== "active") {
      return "Your Guaranteed Rent subscription isn't active, so we can't add GR leads yet.";
    }
    return null;
  }
  if (customer.paused_at) {
    return "Your subscription is paused, so new leads can't be assigned. Resume it first and your balance will be waiting.";
  }
  return null;
}

/**
 * Charge an already-CLAIMED top-up and credit it on success.
 *
 * The caller must have claimed the token (claim_lead_topup_token) — that claim
 * is the single-charge guard. `returnToken` is the raw token used to build the
 * hosted-Checkout cancel URL; omit it for the in-portal path, which returns the
 * customer to the dashboard instead.
 */
export async function chargeClaimedTopup(
  supabase: Admin,
  stripe: Stripe,
  claim: ClaimedTopup,
  opts: { returnToken?: string } = {}
): Promise<ChargeOutcome> {
  const { token_id, lead_type, credits, amount_pence } = claim;
  const stripeCustomerId = claim.stripe_customer_id;

  const metadata = {
    kind: "lead_topup",
    token_id,
    customer_id: claim.customer_id,
    lead_type,
  };
  const description = `Lead top-up — ${credits} ${productLabel(lead_type)} leads`;

  if (!stripeCustomerId) {
    await finaliseFailed(supabase, token_id, null);
    return {
      kind: "failed",
      message:
        "We couldn't find a billing account on file. Please contact support.",
    };
  }

  // Resolve a reusable card: the customer's default, then any attached card.
  let paymentMethodId: string | null = null;
  try {
    const customer = await stripe.customers.retrieve(stripeCustomerId);
    if (!("deleted" in customer && customer.deleted)) {
      const dpm = (customer as Stripe.Customer).invoice_settings
        ?.default_payment_method;
      paymentMethodId = typeof dpm === "string" ? dpm : (dpm?.id ?? null);
      if (!paymentMethodId) {
        const cards = await stripe.paymentMethods.list({
          customer: stripeCustomerId,
          type: "card",
          limit: 1,
        });
        paymentMethodId = cards.data[0]?.id ?? null;
      }
    }
  } catch (err) {
    // Couldn't determine the card — indeterminate, not a failure. Release so
    // the customer can try again rather than burning their token.
    console.error("resolving default payment method failed", err);
    await release(supabase, token_id);
    return {
      kind: "pending",
      message: "We couldn't reach our payment provider. Please try again.",
    };
  }

  // ── Fallback: no reusable card → hosted Stripe page. ────────────────────
  // Restricted to card so the charge completes synchronously: a delayed
  // notification method (Bacs, Klarna) would finish via
  // checkout.session.async_payment_succeeded, and pay-now-credit-later is
  // exactly the failure mode this module exists to prevent.
  // setup_future_usage saves the card, so the customer's NEXT top-up takes the
  // one-tap path instead of the fallback again.
  if (!paymentMethodId) {
    try {
      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        customer: stripeCustomerId,
        payment_method_types: ["card"],
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: "gbp",
              unit_amount: amount_pence,
              product_data: { name: description },
            },
          },
        ],
        payment_intent_data: { metadata, setup_future_usage: "off_session" },
        metadata,
        success_url: `${APP_URL}/topup/success`,
        cancel_url: opts.returnToken
          ? `${APP_URL}/topup/${opts.returnToken}`
          : `${APP_URL}/dashboard/topup?checkout=cancelled`,
      });
      if (!session.url) throw new Error("Checkout session has no URL");
      return { kind: "redirect", url: session.url };
    } catch (err) {
      // The session was never handed over, so no money can have moved: release
      // the claim so the customer can retry.
      console.error("top-up checkout fallback failed", err);
      await release(supabase, token_id);
      return {
        kind: "pending",
        message: "We couldn't start the payment. Please try again.",
      };
    }
  }

  // ── Happy path: off-session charge against the saved card. ──────────────
  try {
    const intent = await stripe.paymentIntents.create(
      {
        amount: amount_pence,
        currency: "gbp",
        customer: stripeCustomerId,
        payment_method: paymentMethodId,
        off_session: true,
        confirm: true,
        description,
        metadata,
      },
      { idempotencyKey: `lead_topup_${token_id}` }
    );

    if (intent.status === "succeeded") {
      await finaliseSuccess(supabase, token_id, intent.id);
      return { kind: "success", credits, leadType: lead_type };
    }

    // Definitively dead: the card needs the cardholder present (3-D Secure) or
    // was rejected outright. Finalise so it isn't retried indefinitely.
    if (
      intent.status === "requires_action" ||
      intent.status === "requires_payment_method"
    ) {
      await finaliseFailed(supabase, token_id, intent.id);
      return {
        kind: "failed",
        message:
          "Your card needs extra verification we can't complete automatically. Please contact support or update your card on file.",
      };
    }

    // Still settling ('processing', 'requires_capture'). It may well succeed —
    // do NOT finalise. The payment_intent.succeeded webhook credits it when it
    // lands; releasing lets the customer retry harmlessly meanwhile.
    await release(supabase, token_id);
    return {
      kind: "pending",
      message:
        "Your payment is still going through. We'll add your leads as soon as it clears.",
    };
  } catch (err) {
    const stripeErr = err as Stripe.errors.StripeError;

    if (isIndeterminate(stripeErr)) {
      // The charge MAY have been captured. Never finalise as failed here.
      console.error("indeterminate top-up charge error — released for retry", {
        tokenId: token_id,
        type: stripeErr?.type,
        message: stripeErr?.message,
      });
      await release(supabase, token_id);
      return {
        kind: "pending",
        message:
          "We couldn't confirm whether your payment went through. Please try again in a moment — you won't be charged twice.",
      };
    }

    // Definitive decline / invalid request.
    const intentId = stripeErr?.payment_intent?.id ?? null;
    await finaliseFailed(supabase, token_id, intentId);
    return {
      kind: "failed",
      message:
        stripeErr?.type === "StripeCardError"
          ? "Your card was declined. Please update your card on file or contact support."
          : "The payment couldn't be completed. Please contact support.",
    };
  }
}
