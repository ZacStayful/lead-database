import { NextResponse, type NextRequest } from "next/server";
import { getStripe } from "@/lib/stripe";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  generateTopupToken,
  topupFilterWarning,
  TOPUP_CREDITS,
  TOPUP_AMOUNT_PENCE,
} from "@/lib/topup";
import { chargeClaimedTopup, topupIneligibilityReason } from "@/lib/topupCharge";
import type { ClaimedTopup } from "@/lib/topupCharge";
import type { Customer, LeadType } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * How recently a paid top-up for the same customer+product blocks another.
 *
 * The token claim stops one token being charged twice, but the in-portal path
 * mints its own token per request, so a double-submit would mint two. This
 * short window is the server-side backstop for that (the button also disables
 * on submit). It is deliberately brief — buying twice in a row is legitimate
 * and must stay possible.
 */
const REPEAT_GUARD_MS = 60_000;

/**
 * Buy a one-off top-up from inside the portal ("Top up leads").
 *
 * Same money path as the emailed link — it mints a token, claims it, and hands
 * off to chargeClaimedTopup — so there is one charge implementation, not two.
 * Available at ANY balance: buying early just stacks credit, which already
 * carries forward.
 *
 * If a live un-used token already exists for this customer+product (an
 * unredeemed exhausted-balance offer), that token is claimed instead of minting
 * a second one. This both satisfies the one-active-token index and means buying
 * in-portal consumes the outstanding offer rather than leaving it dangling.
 */
export async function POST(request: NextRequest) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { lead_type?: string; acknowledge_filter?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const leadType: LeadType =
    body.lead_type === "guaranteed_rent" ? "guaranteed_rent" : "management";

  const admin = createAdminClient();
  const { data: customer } = await admin
    .from("customers")
    .select("*")
    .eq("user_id", user.id)
    .maybeSingle();

  const typedCustomer = customer as Customer | null;
  if (!typedCustomer) {
    return NextResponse.json(
      { status: "failed", message: "We couldn't find your customer record." },
      { status: 404 }
    );
  }

  const reason = topupIneligibilityReason(typedCustomer, leadType);
  if (reason) {
    return NextResponse.json({ status: "failed", message: reason }, { status: 409 });
  }

  // ⚠️ §69. When the FILTER rather than the balance is what holds delivery
  // back, the purchase needs an explicit tick — §39.8's forecast
  // acknowledgement, one surface over. Until this existed the warning was
  // COSMETIC: neither charge route consulted the filter or the balance, so the
  // server charged regardless of what the screen had said, and §40.10's rule
  // is that a stated safety limit which does nothing is worse than none.
  //
  // It refuses an UN-ACKNOWLEDGED purchase, never the purchase. §16's rule is
  // never to turn away a sale, and unlike §59.8's past_due refusal — where
  // routing is structurally off and the credit can NEVER be spent — routing
  // here is on and the credit drains, just slowly.
  const filterWarning = topupFilterWarning(
    typedCustomer,
    leadType,
    TOPUP_CREDITS
  );
  if (filterWarning && body.acknowledge_filter !== true) {
    return NextResponse.json(
      {
        status: "failed",
        code: "topup_not_acknowledged",
        message: filterWarning,
      },
      { status: 400 }
    );
  }

  if (!typedCustomer.stripe_customer_id) {
    return NextResponse.json(
      {
        status: "failed",
        message:
          "We couldn't find a billing account on file. Please contact support.",
      },
      { status: 402 }
    );
  }

  // Double-submit backstop (see REPEAT_GUARD_MS).
  const since = new Date(Date.now() - REPEAT_GUARD_MS).toISOString();
  const { data: recent } = await admin
    .from("payments")
    .select("id")
    .eq("customer_id", typedCustomer.id)
    .eq("payment_type", "topup")
    .eq("status", "paid")
    .eq("lead_type", leadType)
    .gte("created_at", since)
    .limit(1);
  if (recent && recent.length > 0) {
    return NextResponse.json(
      {
        status: "failed",
        message:
          "You've just topped up — your leads have been added. Refresh to see your new balance.",
      },
      { status: 429 }
    );
  }

  // Reuse a live outstanding offer if there is one, else mint a fresh token.
  const { data: liveToken } = await admin
    .from("lead_topup_tokens")
    .select("token_hash")
    .eq("customer_id", typedCustomer.id)
    .eq("lead_type", leadType)
    .is("used_at", null)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();

  let tokenHash = liveToken?.token_hash ?? null;

  if (!tokenHash) {
    const { hash } = generateTopupToken();
    const { error: insertError } = await admin
      .from("lead_topup_tokens")
      .insert({
        customer_id: typedCustomer.id,
        lead_type: leadType,
        token_hash: hash,
        credits: TOPUP_CREDITS,
        amount_pence: TOPUP_AMOUNT_PENCE,
        // Short-lived: this token is claimed immediately below and never sent
        // anywhere, so it needs no browsing window.
        expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
      });
    if (insertError) {
      console.error("in-portal top-up token insert failed", insertError);
      return NextResponse.json(
        { status: "failed", message: "Something went wrong. Please try again." },
        { status: 500 }
      );
    }
    tokenHash = hash;
  }

  const { data: claimed, error: claimError } = await admin.rpc(
    "claim_lead_topup_token",
    { p_token_hash: tokenHash }
  );
  if (claimError) {
    console.error("claim_lead_topup_token failed (in-portal)", claimError);
    return NextResponse.json(
      { status: "failed", message: "Something went wrong. Please try again." },
      { status: 500 }
    );
  }

  const claim = (Array.isArray(claimed) ? claimed[0] : claimed) as
    | ClaimedTopup
    | undefined;
  if (!claim) {
    // Raced with another submit that claimed the same token.
    return NextResponse.json(
      {
        status: "failed",
        message: "That top-up is already being processed. Please refresh.",
      },
      { status: 409 }
    );
  }

  const outcome = await chargeClaimedTopup(admin, getStripe(), claim);

  switch (outcome.kind) {
    case "success":
      return NextResponse.json({
        status: "success",
        credits: outcome.credits,
        leadType: outcome.leadType,
      });
    case "redirect":
      return NextResponse.json({ status: "redirect", url: outcome.url });
    case "pending":
      return NextResponse.json(
        { status: "pending", message: outcome.message },
        { status: 202 }
      );
    case "failed":
      return NextResponse.json(
        { status: "failed", message: outcome.message },
        { status: 402 }
      );
  }
}
