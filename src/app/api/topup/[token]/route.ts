import { NextResponse, type NextRequest } from "next/server";
import type Stripe from "stripe";
import { getStripe } from "@/lib/stripe";
import { createAdminClient } from "@/lib/supabase/admin";
import { APP_URL } from "@/lib/env";
import { hashTopupToken, productLabel } from "@/lib/topup";
import type { LeadType } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Confirm a one-off lead top-up. POST is the only method: the confirmation page
 * fires it when the customer taps "Confirm".
 *
 * Flow:
 *   1. Atomically CLAIM the token (claim_lead_topup_token) — this is the
 *      single-charge guard: a double-tap or duplicate request finds it already
 *      used and gets no row, so the card is never charged twice.
 *   2. Resolve the customer's reusable default card.
 *   3a. Card present → off-session PaymentIntent for £75. On success, atomically
 *       credit +5 and record the payment (record_lead_topup_success).
 *   3b. No reusable card → fall back to a hosted Stripe payment page (Checkout,
 *       payment mode) so the charge still happens rather than failing silently;
 *       crediting is completed by the Stripe webhook on checkout.session.completed.
 *   On a real charge failure the token is marked failed (not retried) and a
 *   plain message is returned — never a silent failure.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: { token: string } }
) {
  const supabase = createAdminClient();
  const stripe = getStripe();
  const hash = hashTopupToken(params.token);

  // 1 — Atomic claim. A table-returning RPC yields an array of rows.
  const { data: claimed, error: claimError } = await supabase.rpc(
    "claim_lead_topup_token",
    { p_token_hash: hash }
  );
  if (claimError) {
    console.error("claim_lead_topup_token failed", claimError);
    return NextResponse.json(
      { status: "failed", message: "Something went wrong. Please try again." },
      { status: 500 }
    );
  }

  const row = (Array.isArray(claimed) ? claimed[0] : claimed) as
    | {
        token_id: string;
        customer_id: string;
        lead_type: LeadType;
        credits: number;
        amount_pence: number;
        stripe_customer_id: string | null;
      }
    | undefined;

  if (!row) {
    return NextResponse.json(
      {
        status: "invalid",
        message:
          "This link is no longer valid — it may already have been used or expired.",
      },
      { status: 409 }
    );
  }

  const { token_id, customer_id, lead_type, credits, amount_pence } = row;
  const stripeCustomerId = row.stripe_customer_id;
  const metadata = {
    kind: "lead_topup",
    token_id,
    customer_id,
    lead_type,
  };
  const description = `Lead top-up — ${credits} ${productLabel(lead_type)} leads`;

  if (!stripeCustomerId) {
    await supabase.rpc("record_lead_topup_failure", {
      p_token_id: token_id,
      p_payment_intent_id: null,
    });
    return NextResponse.json(
      {
        status: "failed",
        message:
          "We couldn't find a billing account on file. Please contact support.",
      },
      { status: 402 }
    );
  }

  // 2 — Resolve a reusable default payment method: the customer's default first,
  // then any attached card, then nothing (→ fallback).
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
    console.error("resolving default payment method failed", err);
  }

  // 3b — Fallback: no reusable card. Send them to a hosted Stripe payment page
  // for this specific customer + amount. Crediting happens in the webhook.
  if (!paymentMethodId) {
    try {
      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        customer: stripeCustomerId,
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
        payment_intent_data: { metadata },
        metadata,
        success_url: `${APP_URL}/topup/success`,
        cancel_url: `${APP_URL}/topup/${params.token}`,
      });
      if (!session.url) throw new Error("Checkout session has no URL");
      return NextResponse.json({ status: "redirect", url: session.url });
    } catch (err) {
      console.error("top-up checkout fallback failed", err);
      await supabase.rpc("record_lead_topup_failure", {
        p_token_id: token_id,
        p_payment_intent_id: null,
      });
      return NextResponse.json(
        {
          status: "failed",
          message:
            "We couldn't start the payment. Please try again or contact support.",
        },
        { status: 500 }
      );
    }
  }

  // 3a — Happy path: off-session charge against the saved card. The idempotency
  // key (token id) means a retried request never creates a second charge.
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
      const { error: recordError } = await supabase.rpc(
        "record_lead_topup_success",
        { p_token_id: token_id, p_payment_intent_id: intent.id }
      );
      if (recordError) {
        // The charge landed but crediting failed. Do NOT tell them to pay again.
        console.error("record_lead_topup_success failed", recordError);
        return NextResponse.json(
          {
            status: "failed",
            message:
              "Your payment went through but we hit a snag adding the leads. Please contact support — do not pay again.",
          },
          { status: 500 }
        );
      }
      return NextResponse.json({ status: "success", credits, leadType: lead_type });
    }

    // Off-session intents can't complete a step that needs the cardholder
    // present (e.g. 3-D Secure). Mark failed and surface it plainly.
    await supabase.rpc("record_lead_topup_failure", {
      p_token_id: token_id,
      p_payment_intent_id: intent.id,
    });
    return NextResponse.json(
      {
        status: "failed",
        message:
          "Your card needs extra verification we can't complete automatically. Please contact support.",
      },
      { status: 402 }
    );
  } catch (err) {
    const stripeErr = err as Stripe.errors.StripeError;
    const intentId = stripeErr?.payment_intent?.id ?? null;
    await supabase.rpc("record_lead_topup_failure", {
      p_token_id: token_id,
      p_payment_intent_id: intentId,
    });
    const declined = stripeErr?.type === "StripeCardError";
    return NextResponse.json(
      {
        status: "failed",
        message: declined
          ? "Your card was declined. Please contact support or update your card on file."
          : "The payment couldn't be completed. Please try again or contact support.",
      },
      { status: 402 }
    );
  }
}
