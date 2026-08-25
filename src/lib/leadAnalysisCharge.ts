/**
 * Paying for lead analysis.
 *
 * A sibling of `topupCharge.ts`, sharing its Stripe mechanics through
 * `chargeIntent.ts` and differing only where the product does. What is here is
 * the token, the eligibility rule, and the four RPCs that record the outcome.
 *
 * ⚠️ THIS NEVER CREDITS lead_balance. A top-up buys leads; this buys analysis
 * of leads the customer already owns. Crediting a balance would hand them
 * marketplace leads they did not pay for and move the pacing counters §13
 * measures delivery by. `record_lead_analysis_success` writes credits_added: 0
 * and flips the job to `running` instead — that flip is the only thing that
 * makes a row claimable, which is how "nothing is analysed before it is paid
 * for" ends up being a property of the schema rather than a rule in a route.
 */

import { createHash, randomBytes } from "crypto";
import type Stripe from "stripe";
import type { createAdminClient } from "@/lib/supabase/admin";
import { chargeClaimedIntent, type ChargeOutcome } from "@/lib/chargeIntent";
import { availableLeadTypes } from "@/lib/products";
import { APP_URL } from "@/lib/env";
import { HOSTED_CHECKOUT_THRESHOLD_PENCE, formatPence } from "@/lib/leadAnalysis";
import type { Customer, LeadType } from "@/lib/types";

type Admin = ReturnType<typeof createAdminClient>;

export type { ChargeOutcome };

/** The row returned by claim_lead_analysis_token. */
export interface ClaimedAnalysis {
  token_id: string;
  customer_id: string;
  job_id: string;
  lead_type: LeadType;
  row_count: number;
  amount_pence: number;
  stripe_customer_id: string | null;
}

/** Only the hash is ever stored, as with the top-up token. */
export function hashAnalysisToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export function generateAnalysisToken(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString("base64url");
  return { raw, hash: hashAnalysisToken(raw) };
}

/**
 * The token is claimed within the same request that mints it and is never sent
 * anywhere, so it needs no browsing window — only enough life to survive a slow
 * hosted-checkout redirect.
 */
export const ANALYSIS_TOKEN_TTL_MS = 60 * 60 * 1000;

/** The customer fields the eligibility rule reads. */
export type AnalysisCustomerFields = Pick<
  Customer,
  | "account_status"
  | "subscription_status"
  | "gr_subscription_status"
  | "cancelled_at"
  | "gr_cancelled_at"
>;

/**
 * Why this customer may not buy analysis right now, or null if they may.
 *
 * ⚠️ DELIBERATELY NOT `topupIneligibilityReason`, and the difference is the
 * point. That rule is "never sell credit the customer cannot spend" — a paused
 * or cancelled customer is refused assignment, so selling them lead credit
 * would be taking money for leads that can never arrive.
 *
 * Nothing here depends on assignment. These are leads the customer already
 * owns, sitting in their own pipeline, and the figures land on them whatever
 * their subscription is doing. A PAUSED customer may buy this; a paused
 * customer may not buy a top-up. Blocking them would be refusing money for a
 * service we can deliver.
 *
 * What is still required is that they hold — or once held — the product,
 * because an owned lead belongs to one product's pipeline and a customer who
 * never had that product has no such leads to analyse. A CANCELLED customer
 * keeps the database and keeps adding leads to it (§32), so they keep the paid
 * analysis that goes with those leads; the same argument that admits a paused
 * customer admits them, and `availableLeadTypes` is the single definition of
 * which pipelines are theirs.
 */
export function analysisIneligibilityReason(
  customer: AnalysisCustomerFields,
  leadType: LeadType
): string | null {
  if (availableLeadTypes(customer).includes(leadType)) return null;
  return leadType === "guaranteed_rent"
    ? "You don't currently hold Guaranteed Rent, so there are no GR leads to analyse."
    : "You don't currently hold Management, so there are no management leads to analyse.";
}

async function release(supabase: Admin, tokenId: string): Promise<void> {
  const { error } = await supabase.rpc("release_lead_analysis_token", { p_token_id: tokenId });
  if (error) console.error("release_lead_analysis_token failed", { tokenId, error });
}

async function finaliseFailed(
  supabase: Admin,
  tokenId: string,
  intentId: string | null
): Promise<void> {
  const { error } = await supabase.rpc("record_lead_analysis_failure", {
    p_token_id: tokenId,
    p_payment_intent_id: intentId,
  });
  if (error) console.error("record_lead_analysis_failure failed", { tokenId, error });
}

/**
 * Record a successful charge and let the work start.
 *
 * A `false` return on a charge we KNOW succeeded means money moved and no work
 * was authorised. Logged loudly — this is the tripwire for manual
 * reconciliation, exactly as it is on the top-up path.
 */
async function finaliseSuccess(
  supabase: Admin,
  tokenId: string,
  intentId: string
): Promise<void> {
  const { data, error } = await supabase.rpc("record_lead_analysis_success", {
    p_token_id: tokenId,
    p_payment_intent_id: intentId,
  });
  if (error) {
    console.error("CHARGED BUT NOT STARTED — record_lead_analysis_success errored", {
      tokenId,
      intentId,
      error,
    });
    throw new Error(`record_lead_analysis_success failed: ${error.message}`);
  }
  if (data === false) {
    console.error(
      "record_lead_analysis_success returned false (already paid, or unknown token)",
      { tokenId, intentId }
    );
  }
}

/**
 * Charge an already-CLAIMED analysis purchase and start the job on success.
 *
 * The caller must have claimed the token — that claim is the single-charge
 * guard, and two concurrent submits race for it so the card is charged once.
 */
export async function chargeClaimedAnalysis(
  supabase: Admin,
  stripe: Stripe,
  claim: ClaimedAnalysis
): Promise<ChargeOutcome> {
  const { token_id, job_id, lead_type, row_count, amount_pence } = claim;

  /**
   * A large off-session charge nobody is present for is exactly the shape
   * issuers decline — 200 leads is £600 appearing unannounced on a card. Above
   * the threshold we withhold the saved card so the flow falls through to the
   * hosted page, where the cardholder can answer a 3-D Secure prompt. Slower,
   * and far better than a silent decline on the batch they just asked for.
   */
  const overSoftCeiling = amount_pence > HOSTED_CHECKOUT_THRESHOLD_PENCE;

  return chargeClaimedIntent(stripe, {
    stripeCustomerId: claim.stripe_customer_id,
    amountPence: amount_pence,
    description: `Lead analysis — ${row_count} lead${row_count === 1 ? "" : "s"} (${formatPence(
      amount_pence
    )})`,
    metadata: {
      kind: "lead_analysis",
      token_id,
      job_id,
      customer_id: claim.customer_id,
      lead_type,
    },
    idempotencyKey: `lead_analysis_${token_id}`,
    successUrl: `${APP_URL}/dashboard/leads?analysis=started`,
    cancelUrl: `${APP_URL}/dashboard/leads?analysis=cancelled`,
    onSuccess: (intentId) => finaliseSuccess(supabase, token_id, intentId),
    onFailed: (intentId) => finaliseFailed(supabase, token_id, intentId),
    onRelease: () => release(supabase, token_id),
    forceHosted: overSoftCeiling,
  });
}
