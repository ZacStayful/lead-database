import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isAdminUser } from "@/lib/auth";
import type { PostCallOffer } from "@/lib/postCallOffers";
import { issuePostCallOffer } from "@/lib/postCallOfferIssue";
import { computeCheckoutUrls, payTokenSecret } from "@/lib/checkout/payToken";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

  // Lowercased so lookups are a plain case-insensitive exact match. (Matching
  // with .ilike would treat any `_` or `%` in the address as a SQL wildcard.)
  const prospectEmail =
    typeof body.prospect_email === "string"
      ? body.prospect_email.trim().toLowerCase()
      : "";
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
  // promo code we can't build URLs for. The links are /pay/[offerToken]
  // (batch 02 Phase 4), which need MESSAGING_TOKEN_SECRET to sign.
  if (!payTokenSecret()) {
    return NextResponse.json(
      { error: "Cannot build payment links: MESSAGING_TOKEN_SECRET is not set." },
      { status: 500 }
    );
  }

  const admin = createAdminClient();

  // The issuing itself (live offer returned unchanged, expired row reused,
  // a lost race returned as existing) is shared with the funnel's discount
  // (batch 02 Phase 5), so there is one path to a code.
  const issued = await issuePostCallOffer(admin, {
    email: prospectEmail,
    name: prospectName,
    phone: prospectPhone,
    source,
    createdBy: adminUserId,
  });

  if (!issued.ok && issued.reason === "stripe_failed") {
    return NextResponse.json({ error: issued.message }, { status: 502 });
  }
  if (!issued.ok) {
    return NextResponse.json(
      { error: issued.message, orphaned_stripe_promo_code_id: issued.orphanedPromoCodeId },
      { status: 500 }
    );
  }

  return NextResponse.json({
    status: issued.status,
    promo_code_string: issued.promoCode,
    ...computeCheckoutUrls(issued.offerId),
  });
}
