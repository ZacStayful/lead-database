import { randomInt } from "node:crypto";
import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getStripe } from "@/lib/stripe";
import { requireEnv } from "@/lib/env";
import { OFFER_TTL_MS, type PostCallOffer } from "@/lib/postCallOffers";

/**
 * Issuing a post-call discount offer: the single-use, 24-hour `FOUNDING10-`
 * code. Lifted verbatim out of POST /api/admin/post-call-offer (batch 02
 * Phase 5) so the funnel's discount goes through the same path rather than a
 * second copy: one code per person across both routes (locked decision 3).
 *
 * The order is the rule:
 *   1. a LIVE unredeemed offer for this email is returned unchanged, so nobody
 *      ever holds two live codes;
 *   2. otherwise a fresh Stripe promotion code is minted;
 *   3. an EXPIRED unredeemed row is reused in place, because the unique index
 *      (uq_post_call_offers_unredeemed_email, 0037) allows one unredeemed row
 *      per email;
 *   4. a concurrent insert that wins the race is returned as existing.
 *
 * SERVER-ONLY (node:crypto, Stripe). Never throws: a failure is a result.
 */

// Readable code alphabet — no 0/O/1/I/L to avoid transcription errors when a
// prospect types the code from an SMS.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function randomCode(): string {
  let suffix = "";
  for (let i = 0; i < 4; i += 1) {
    suffix += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return `FOUNDING10-${suffix}`;
}

/**
 * Create a single-use, 24h-expiring Promotion Code wrapping the post-call
 * coupon. NOT restricted to any price/product, so it works on either Management
 * plan's checkout unmodified. Retries a couple of times if Stripe reports the
 * random code already exists.
 */
async function createPromoCode(stripe: Stripe, expiresUnix: number): Promise<{ id: string; code: string }> {
  const coupon = requireEnv("STRIPE_POST_CALL_COUPON_ID");
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const code = randomCode();
    try {
      const promo = await stripe.promotionCodes.create({
        coupon,
        code,
        max_redemptions: 1,
        expires_at: expiresUnix,
      });
      return { id: promo.id, code: promo.code };
    } catch (err) {
      // Only a duplicate-code collision is worth retrying; rethrow anything else.
      const message = err instanceof Error ? err.message : String(err);
      lastErr = err;
      if (!/already exists/i.test(message)) throw err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("Could not allocate a unique promotion code");
}

export interface IssueOfferInput {
  /** Already trimmed and lower-cased by the caller. */
  email: string;
  name: string | null;
  phone: string | null;
  source: PostCallOffer["source"];
  createdBy: string | null;
}

export type IssueOfferResult =
  | { ok: true; status: "existing" | "created"; offerId: string; promoCode: string }
  | { ok: false; reason: "stripe_failed"; message: string }
  | { ok: false; reason: "db_failed"; orphanedPromoCodeId: string; message: string };

export async function issuePostCallOffer(
  admin: SupabaseClient,
  input: IssueOfferInput,
  deps: { stripe?: Stripe; now?: () => number } = {}
): Promise<IssueOfferResult> {
  // Duplicate check FIRST. At most one unredeemed row can exist per email
  // (enforced by uq_post_call_offers_unredeemed_email).
  const { data: existing } = await admin
    .from("post_call_offers")
    .select("*")
    .eq("prospect_email", input.email)
    .is("redeemed_at", null)
    .maybeSingle<PostCallOffer>();

  const nowMs = deps.now?.() ?? Date.now();

  if (existing && new Date(existing.expires_at).getTime() > nowMs) {
    // Active offer already exists — return it unchanged, no new live code.
    return { ok: true, status: "existing", offerId: existing.id, promoCode: existing.promo_code_string };
  }

  // No active offer. Mint a fresh Stripe promo code.
  const offerCreatedAt = new Date(nowMs);
  const expiresAt = new Date(nowMs + OFFER_TTL_MS);
  const expiresUnix = Math.floor(expiresAt.getTime() / 1000);

  let promo: { id: string; code: string };
  try {
    promo = await createPromoCode(deps.stripe ?? getStripe(), expiresUnix);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Stripe promotion code creation failed";
    console.error("post-call-offer: Stripe promo create failed", err);
    return { ok: false, reason: "stripe_failed", message };
  }

  const rowValues = {
    prospect_email: input.email,
    prospect_phone: input.phone,
    prospect_name: input.name,
    stripe_promo_code_id: promo.id,
    promo_code_string: promo.code,
    offer_created_at: offerCreatedAt.toISOString(),
    expires_at: expiresAt.toISOString(),
    source: input.source,
    // Reset reminder flags when reusing an expired row.
    reminder_12h_sent_at: null,
    reminder_4h_sent_at: null,
    reminder_1h_sent_at: null,
    created_by: input.createdBy,
  };

  let dbError: { code?: string; message?: string } | null = null;
  // The row's id signs its /pay links, so the insert reads it back.
  let offerId: string | null = existing?.id ?? null;
  if (existing) {
    // Expired-unused row → reuse it in place so we never hold two unredeemed
    // rows for one email (and the unique index never conflicts).
    const { error } = await admin.from("post_call_offers").update(rowValues).eq("id", existing.id);
    dbError = error;
  } else {
    const { data: inserted, error } = await admin
      .from("post_call_offers")
      .insert(rowValues)
      .select("id")
      .maybeSingle<{ id: string }>();
    dbError = error;
    offerId = inserted?.id ?? null;
  }

  if (dbError && !existing && dbError.code === "23505") {
    // Lost a concurrent generation race (e.g. an n8n retry firing twice): another
    // request created the active offer between our duplicate check and this
    // insert. Return the winning offer instead of a 500. Our just-created promo
    // code is a harmless 24h orphan (logged, not auto-deleted).
    console.error("post-call-offer: concurrent insert lost; orphaned promo", promo.id);
    const { data: winner } = await admin
      .from("post_call_offers")
      .select("*")
      .eq("prospect_email", input.email)
      .is("redeemed_at", null)
      .maybeSingle<PostCallOffer>();
    if (winner) {
      return { ok: true, status: "existing", offerId: winner.id, promoCode: winner.promo_code_string };
    }
  }

  if (dbError || !offerId) {
    // Stripe succeeded but the DB write failed: the promo code is now orphaned
    // in Stripe. Surface its id for manual reconciliation — we deliberately do
    // NOT auto-rollback the Stripe side.
    console.error("post-call-offer: DB write failed after Stripe create", {
      stripe_promo_code_id: promo.id,
      dbError,
    });
    return {
      ok: false,
      reason: "db_failed",
      orphanedPromoCodeId: promo.id,
      message:
        "Offer created in Stripe but failed to persist. Manually reconcile " +
        `the orphaned Stripe promotion code: ${promo.id}`,
    };
  }

  return { ok: true, status: "created", offerId, promoCode: promo.code };
}
