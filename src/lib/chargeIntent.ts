/**
 * The one place money moves.
 *
 * Extracted from `topupCharge.ts` when paid lead analysis needed the same
 * behaviour for a different product. It is a pure extraction: the branches, the
 * ordering and the wording are unchanged, and `chargeClaimedTopup` is now a
 * thin wrapper over it. Two copies of this would have been two places to get
 * the rule below wrong.
 *
 * THE RULE. Never finalise a claim as failed unless the outcome is DEFINITIVE.
 * A Stripe connection error or timeout can be thrown after the charge was
 * captured, and an intent can settle asynchronously — treating either as
 * failure would take the customer's money and give them nothing, with no way
 * back. On an indeterminate outcome we RELEASE the claim instead, so the same
 * claim can be retried; the Stripe idempotency key (derived from the claim id)
 * means a retry returns the ORIGINAL intent rather than charging again.
 *
 * The caller supplies what to do at each of the three finalisation points, so
 * this function decides WHEN they happen and the product decides WHAT they
 * mean. That split is the point: whether a charge grants lead credit or starts
 * an analysis job is not this module's business, but whether it is safe to say
 * the charge failed very much is.
 */
import type Stripe from "stripe";

export type ChargeOutcome =
  /** Charged. The caller's `onSuccess` has already run. */
  | { kind: "success"; paymentIntentId: string }
  /** No reusable card — send the customer to a hosted Stripe page. */
  | { kind: "redirect"; url: string }
  /** Definitive failure. The claim is finalised; retrying needs a new one. */
  | { kind: "failed"; message: string }
  /**
   * Outcome unknown or still settling. The claim has been released so the SAME
   * claim can be retried safely; nothing has been finalised.
   */
  | { kind: "pending"; message: string };

export interface ChargeSpec {
  /** Stripe customer to charge. Null means no billing account on file. */
  stripeCustomerId: string | null;
  amountPence: number;
  /** Shown on the statement and on the hosted page. */
  description: string;
  /** Carried onto the intent AND the session, so the webhook can route it. */
  metadata: Record<string, string>;
  /** Derived from the claim id, so a retry returns the original intent. */
  idempotencyKey: string;
  successUrl: string;
  cancelUrl: string;

  /** Record the charge and grant whatever it bought. */
  onSuccess: (paymentIntentId: string) => Promise<void>;
  /** Record a DEFINITIVE failure. Never called on an ambiguous outcome. */
  onFailed: (paymentIntentId: string | null) => Promise<void>;
  /** Undo the claim so the same one can be retried. */
  onRelease: () => Promise<void>;

  /**
   * Skip the saved card and go straight to the hosted page.
   *
   * For amounts large enough that an unannounced off-session charge is likely
   * to be declined by the issuer. Putting the cardholder in front of it turns a
   * silent decline into a 3-D Secure prompt they can actually answer.
   */
  forceHosted?: boolean;
}

/** Internal signal for `forceHosted`; never escapes this module. */
class SkipSavedCard extends Error {}

/** Stripe error classes that are NOT proof the charge failed. */
export function isIndeterminate(err: Stripe.errors.StripeError): boolean {
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

export async function chargeClaimedIntent(
  stripe: Stripe,
  spec: ChargeSpec
): Promise<ChargeOutcome> {
  const { stripeCustomerId, amountPence, description, metadata } = spec;

  if (!stripeCustomerId) {
    await spec.onFailed(null);
    return {
      kind: "failed",
      message: "We couldn't find a billing account on file. Please contact support.",
    };
  }

  // Resolve a reusable card: the customer's default, then any attached card.
  // Skipped entirely when the caller wants the cardholder present.
  let paymentMethodId: string | null = null;
  try {
    if (spec.forceHosted) throw new SkipSavedCard();
    const customer = await stripe.customers.retrieve(stripeCustomerId);
    if (!("deleted" in customer && customer.deleted)) {
      const dpm = (customer as Stripe.Customer).invoice_settings?.default_payment_method;
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
    if (!(err instanceof SkipSavedCard)) {
      // Couldn't determine the card — indeterminate, not a failure. Release so
      // the customer can try again rather than burning their claim.
      console.error("resolving default payment method failed", err);
      await spec.onRelease();
      return {
        kind: "pending",
        message: "We couldn't reach our payment provider. Please try again.",
      };
    }
  }

  // ── Fallback: no reusable card → hosted Stripe page. ────────────────────
  // Restricted to card so the charge completes synchronously: a delayed
  // notification method (Bacs, Klarna) would finish via
  // checkout.session.async_payment_succeeded, and pay-now-deliver-later is
  // exactly the failure mode this module exists to prevent.
  // setup_future_usage saves the card, so the customer's NEXT purchase takes
  // the one-tap path instead of the fallback again.
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
              unit_amount: amountPence,
              product_data: { name: description },
            },
          },
        ],
        payment_intent_data: { metadata, setup_future_usage: "off_session" },
        metadata,
        success_url: spec.successUrl,
        cancel_url: spec.cancelUrl,
      });
      if (!session.url) throw new Error("Checkout session has no URL");
      return { kind: "redirect", url: session.url };
    } catch (err) {
      // The session was never handed over, so no money can have moved: release
      // the claim so the customer can retry.
      console.error("checkout fallback failed", err);
      await spec.onRelease();
      return { kind: "pending", message: "We couldn't start the payment. Please try again." };
    }
  }

  // ── Happy path: off-session charge against the saved card. ──────────────
  try {
    const intent = await stripe.paymentIntents.create(
      {
        amount: amountPence,
        currency: "gbp",
        customer: stripeCustomerId,
        payment_method: paymentMethodId,
        off_session: true,
        confirm: true,
        description,
        metadata,
      },
      { idempotencyKey: spec.idempotencyKey }
    );

    if (intent.status === "succeeded") {
      await spec.onSuccess(intent.id);
      return { kind: "success", paymentIntentId: intent.id };
    }

    // Definitively dead: the card needs the cardholder present (3-D Secure) or
    // was rejected outright. Finalise so it isn't retried indefinitely.
    if (intent.status === "requires_action" || intent.status === "requires_payment_method") {
      await spec.onFailed(intent.id);
      return {
        kind: "failed",
        message:
          "Your card needs extra verification we can't complete automatically. Please contact support or update your card on file.",
      };
    }

    // Still settling ('processing', 'requires_capture'). It may well succeed —
    // do NOT finalise. The payment_intent.succeeded webhook finishes it when it
    // lands; releasing lets the customer retry harmlessly meanwhile.
    await spec.onRelease();
    return {
      kind: "pending",
      message: "Your payment is still going through. We'll finish up as soon as it clears.",
    };
  } catch (err) {
    const stripeErr = err as Stripe.errors.StripeError;

    if (isIndeterminate(stripeErr)) {
      // The charge MAY have been captured. Never finalise as failed here.
      console.error("indeterminate charge error — released for retry", {
        idempotencyKey: spec.idempotencyKey,
        type: stripeErr?.type,
        message: stripeErr?.message,
      });
      await spec.onRelease();
      return {
        kind: "pending",
        message:
          "We couldn't confirm whether your payment went through. Please try again in a moment — you won't be charged twice.",
      };
    }

    // Definitive decline / invalid request.
    const intentId = stripeErr?.payment_intent?.id ?? null;
    await spec.onFailed(intentId);
    return {
      kind: "failed",
      message:
        stripeErr?.type === "StripeCardError"
          ? "Your card was declined. Please update your card on file or contact support."
          : "The payment couldn't be completed. Please contact support.",
    };
  }
}
