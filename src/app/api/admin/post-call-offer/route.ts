import { NextResponse, type NextRequest } from "next/server";
import { randomInt } from "crypto";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getStripe } from "@/lib/stripe";
import { isAdminUser } from "@/lib/auth";
import { requireEnv } from "@/lib/env";
import {
  OFFER_TTL_MS,
  computeCheckoutUrls,
  type PostCallOffer,
} from "@/lib/postCallOffers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Readable code alphabet — no 0/O/1/I/L to avoid transcription errors when a
// prospect types the code from an SMS.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function randomCode(): string {
  let suffix = "";
  for (let i = 0; i < 4; i += 1) {
    suffix += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return `FOUNDING15-${suffix}`;
}

/**
 * Create a single-use, 24h-expiring Promotion Code wrapping the post-call
 * coupon. NOT restricted to any price/product, so it works on either Management
 * Payment Link unmodified. Retries a couple of times if Stripe reports the
 * random code already exists.
 */
async function createPromoCode(
  expiresUnix: number
): Promise<{ id: string; code: string }> {
  const stripe = getStripe();
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
  throw lastErr instanceof Error
    ? lastErr
    : new Error("Could not allocate a unique promotion code");
}

/**
 * POST /api/admin/post-call-offer
 *
 * Generate (or return the existing active) post-call discount offer for a
 * prospect. Dual-auth, mirroring /api/monday/sync exactly: EITHER a valid admin
 * session (the manual admin button) OR a bearer token matching
 * N8N_WEBHOOK_SECRET (the automatic Monday.com → n8n door). The door identity
 * IS the source: session → 'manual', bearer → 'auto_monday'.
 */
export async function POST(request: NextRequest) {
  const auth = request.headers.get("authorization");
  const n8nSecret = process.env.N8N_WEBHOOK_SECRET;
  const viaBearer = Boolean(n8nSecret) && auth === `Bearer ${n8nSecret}`;

  let adminUserId: string | null = null;
  if (!viaBearer) {
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!isAdminUser(user)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    adminUserId = user?.id ?? null;
  }

  const source: PostCallOffer["source"] = viaBearer ? "auto_monday" : "manual";

  // Parse + validate the body (same shape from either door).
  let body: {
    prospect_name?: unknown;
    prospect_email?: unknown;
    prospect_phone?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const prospectEmail =
    typeof body.prospect_email === "string" ? body.prospect_email.trim() : "";
  const prospectName =
    typeof body.prospect_name === "string" && body.prospect_name.trim()
      ? body.prospect_name.trim()
      : null;
  const prospectPhone =
    typeof body.prospect_phone === "string" && body.prospect_phone.trim()
      ? body.prospect_phone.trim()
      : null;

  if (!prospectEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(prospectEmail)) {
    return NextResponse.json(
      { error: "A valid prospect_email is required" },
      { status: 400 }
    );
  }

  // Fail fast on missing link config before touching Stripe, so we never mint a
  // promo code we can't build URLs for.
  try {
    computeCheckoutUrls("probe");
  } catch (err) {
    const message = err instanceof Error ? err.message : "Configuration error";
    return NextResponse.json({ error: message }, { status: 500 });
  }

  const admin = createAdminClient();

  // Duplicate check FIRST. At most one unredeemed row can exist per email
  // (enforced by uq_post_call_offers_unredeemed_email).
  const { data: existing } = await admin
    .from("post_call_offers")
    .select("*")
    .ilike("prospect_email", prospectEmail)
    .is("redeemed_at", null)
    .maybeSingle<PostCallOffer>();

  const nowMs = Date.now();

  if (existing && new Date(existing.expires_at).getTime() > nowMs) {
    // Active offer already exists — return it unchanged, no new live code.
    return NextResponse.json({
      status: "existing",
      promo_code_string: existing.promo_code_string,
      ...computeCheckoutUrls(existing.promo_code_string),
    });
  }

  // No active offer. Mint a fresh Stripe promo code.
  const offerCreatedAt = new Date(nowMs);
  const expiresAt = new Date(nowMs + OFFER_TTL_MS);
  const expiresUnix = Math.floor(expiresAt.getTime() / 1000);

  let promo: { id: string; code: string };
  try {
    promo = await createPromoCode(expiresUnix);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Stripe promotion code creation failed";
    console.error("post-call-offer: Stripe promo create failed", err);
    return NextResponse.json({ error: message }, { status: 502 });
  }

  const rowValues = {
    prospect_email: prospectEmail,
    prospect_phone: prospectPhone,
    prospect_name: prospectName,
    stripe_promo_code_id: promo.id,
    promo_code_string: promo.code,
    offer_created_at: offerCreatedAt.toISOString(),
    expires_at: expiresAt.toISOString(),
    source,
    // Reset reminder flags when reusing an expired row.
    reminder_12h_sent_at: null,
    reminder_4h_sent_at: null,
    reminder_1h_sent_at: null,
    created_by: adminUserId,
  };

  let dbError: { message?: string } | null = null;
  if (existing) {
    // Expired-unused row → reuse it in place so we never hold two unredeemed
    // rows for one email (and the unique index never conflicts).
    const { error } = await admin
      .from("post_call_offers")
      .update(rowValues)
      .eq("id", existing.id);
    dbError = error;
  } else {
    const { error } = await admin.from("post_call_offers").insert(rowValues);
    dbError = error;
  }

  if (dbError) {
    // Stripe succeeded but the DB write failed: the promo code is now orphaned
    // in Stripe. Surface its id for manual reconciliation — we deliberately do
    // NOT auto-rollback the Stripe side.
    console.error("post-call-offer: DB write failed after Stripe create", {
      stripe_promo_code_id: promo.id,
      dbError,
    });
    return NextResponse.json(
      {
        error:
          "Offer created in Stripe but failed to persist. Manually reconcile " +
          `the orphaned Stripe promotion code: ${promo.id}`,
        orphaned_stripe_promo_code_id: promo.id,
      },
      { status: 500 }
    );
  }

  return NextResponse.json({
    status: "created",
    promo_code_string: promo.code,
    ...computeCheckoutUrls(promo.code),
  });
}
