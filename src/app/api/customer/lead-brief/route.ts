import { NextResponse, type NextRequest } from "next/server";
import { getCurrentCustomer } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { holdsProduct } from "@/lib/products";
import { nextGrantDate } from "@/lib/quality/replacementEntitlement";
import { parseBriefBody } from "@/lib/leadBrief/briefRequest";
import { briefRowFromPreview, nextBriefVersion } from "@/lib/leadBrief/briefRow";
import { computeBriefForCustomer } from "@/lib/leadBrief/briefServer";
import { previewForClient } from "@/lib/leadBrief/preview";
import { BriefSupplyUnavailableError } from "@/lib/leadBrief/supply";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Confirm the Lead Brief (Phase 3). Saves version 1 as the active brief and
 * stamps `lead_brief_completed_at`, which releases the dashboard gate.
 *
 * - Recomputed against LIVE supply here, never trusted from the browser. If
 *   the radius has moved since the customer was shown it, they are told
 *   plainly (409 `radius_changed`, with the fresh preview) and confirm again
 *   (A8).
 * - A3: confirming always works. A thin area is stored with the mix leaning
 *   to Nearby; a shortfall rolls over. Nothing here refuses a brief for
 *   supply reasons.
 * - Idempotent. A double click, or a retry after the stamp failed, finds the
 *   active brief already saved (the one-active index, 0162) and only stamps.
 *   A customer whose brief is already complete gets a 200, not an error.
 * - No Monday, Stripe or email side effects. "Switch to 10 leads a month" is
 *   the existing §24 route, called by the screen before this one; the plan
 *   used here is read from the row (`briefPlanFor`).
 */
export async function POST(req: NextRequest) {
  const { user, customer } = await getCurrentCustomer();
  if (!user) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  if (!customer || !customer.lead_brief_required || !holdsProduct(customer, "management")) {
    return NextResponse.json({ error: "Not available", code: "not_brief_customer" }, { status: 403 });
  }
  if (customer.lead_brief_completed_at) {
    return NextResponse.json({ ok: true, alreadyComplete: true });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = parseBriefBody(body);
  if (parsed.shownRadiusMiles === null) {
    return NextResponse.json({ code: "radius_missing" }, { status: 400 });
  }

  const admin = createAdminClient();

  let preview;
  try {
    const result = await computeBriefForCustomer(admin, customer, parsed, {
      autoTickRecommended: false,
    });
    if (!result.ok) {
      return NextResponse.json({ code: "invalid_input", issues: result.issues }, { status: 400 });
    }
    preview = result.preview;
  } catch (err) {
    if (err instanceof BriefSupplyUnavailableError) {
      console.error("[lead-brief] supply unavailable", err.message);
      return NextResponse.json({ code: "supply_unavailable" }, { status: 503 });
    }
    console.error("[lead-brief] compute failed", err);
    return NextResponse.json({ code: "save_failed" }, { status: 500 });
  }

  if (preview.serviceRadiusMiles !== parsed.shownRadiusMiles) {
    return NextResponse.json(
      {
        code: "radius_changed",
        preview: previewForClient(preview),
        similarAreas: [...preview.brief.similarAreas],
      },
      { status: 409 }
    );
  }

  const { data: existing, error: readError } = await admin
    .from("customer_lead_briefs")
    .select("version, status")
    .eq("customer_id", customer.id);
  if (readError) {
    console.error("[lead-brief] versions read failed", readError.message);
    return NextResponse.json({ code: "save_failed" }, { status: 500 });
  }
  const rows = (existing ?? []) as { version: number; status: string }[];

  if (!rows.some((r) => r.status === "active")) {
    const row = briefRowFromPreview(preview, {
      customerId: customer.id,
      version: nextBriefVersion(rows.map((r) => r.version)),
      lockedUntil: nextGrantDate({
        billing_cycle_anchor: customer.billing_cycle_anchor,
        created_at: customer.created_at,
      }),
      now: new Date(),
    });
    const { error: insertError } = await admin.from("customer_lead_briefs").insert(row);
    if (insertError) {
      // 23505: a concurrent confirm saved it first (one-active index, or the
      // version). Anything else is a real failure.
      if (insertError.code !== "23505") {
        console.error("[lead-brief] insert failed", insertError.code, insertError.message);
        return NextResponse.json({ code: "save_failed" }, { status: 500 });
      }
      const { data: active, error: recheckError } = await admin
        .from("customer_lead_briefs")
        .select("id")
        .eq("customer_id", customer.id)
        .eq("status", "active")
        .maybeSingle();
      if (recheckError || !active) {
        console.error("[lead-brief] insert collided and no active brief found");
        return NextResponse.json({ code: "save_failed" }, { status: 500 });
      }
    }
  }

  // Only where still null: the first confirmation's date is the one that stands.
  const { error: stampError } = await admin
    .from("customers")
    .update({ lead_brief_completed_at: new Date().toISOString() })
    .eq("id", customer.id)
    .is("lead_brief_completed_at", null);
  if (stampError) {
    console.error("[lead-brief] completion stamp failed", stampError.message);
    return NextResponse.json({ code: "save_failed" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
