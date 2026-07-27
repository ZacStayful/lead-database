import { NextResponse, type NextRequest } from "next/server";
import { getStripe } from "@/lib/stripe";
import { createAdminClient } from "@/lib/supabase/admin";
import { hashTopupToken } from "@/lib/topup";
import { chargeClaimedTopup, topupIneligibilityReason } from "@/lib/topupCharge";
import type { ClaimedTopup } from "@/lib/topupCharge";
import type { Customer } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Confirm a one-off lead top-up from the emailed / texted single-use link.
 *
 * 1. CLAIM the token atomically — the single-charge guard. A double-tap or a
 *    duplicate request finds it already used and gets no row back, so the card
 *    can never be charged twice.
 * 2. Check eligibility BEFORE any money moves (a paused or cancelled customer
 *    cannot be assigned leads, so selling them credit would be taking £75 for
 *    something they can't receive). Ineligible → release the claim so the link
 *    still works once they resume.
 * 3. Charge + credit via the shared path in lib/topupCharge.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: { token: string } }
) {
  const supabase = createAdminClient();
  const stripe = getStripe();

  const { data: claimed, error: claimError } = await supabase.rpc(
    "claim_lead_topup_token",
    { p_token_hash: hashTopupToken(params.token) }
  );
  if (claimError) {
    console.error("claim_lead_topup_token failed", claimError);
    return NextResponse.json(
      { status: "failed", message: "Something went wrong. Please try again." },
      { status: 500 }
    );
  }

  const claim = (Array.isArray(claimed) ? claimed[0] : claimed) as
    | ClaimedTopup
    | undefined;

  if (!claim) {
    return NextResponse.json(
      {
        status: "invalid",
        message:
          "This link is no longer valid — it may already have been used or expired.",
      },
      { status: 409 }
    );
  }

  // Eligibility gate. Release the claim on refusal so the same link still works
  // once the customer resumes — this is not a spent attempt.
  const { data: customerRow } = await supabase
    .from("customers")
    .select(
      "account_status, paused_at, subscription_status, gr_subscription_status"
    )
    .eq("id", claim.customer_id)
    .maybeSingle();

  if (customerRow) {
    const reason = topupIneligibilityReason(
      customerRow as Pick<
        Customer,
        | "account_status"
        | "paused_at"
        | "subscription_status"
        | "gr_subscription_status"
      >,
      claim.lead_type
    );
    if (reason) {
      await supabase.rpc("release_lead_topup_token", {
        p_token_id: claim.token_id,
      });
      return NextResponse.json(
        { status: "failed", message: reason },
        { status: 409 }
      );
    }
  }

  const outcome = await chargeClaimedTopup(supabase, stripe, claim, {
    returnToken: params.token,
  });

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
