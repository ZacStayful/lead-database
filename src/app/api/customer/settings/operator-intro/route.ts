/**
 * The operator's own introduction (§41).
 *
 * A route of its own rather than a widening of /api/customer/settings, which is
 * documented as being about the SMS opt-in and validates exactly one boolean —
 * the same call /api/customer/messaging/booking-link made, and for the same
 * reason.
 *
 * Session auth, service-role write: `customers` has one SELECT policy and no
 * write policy, so this column stays non-writable from any browser (invariant 7).
 */
import { NextResponse, type NextRequest } from "next/server";
import { getCurrentCustomer } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { validateOperatorIntro } from "@/lib/operatorIntro";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(request: NextRequest) {
  const { user, customer } = await getCurrentCustomer();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!customer) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let body: { operator_intro?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const verdict = validateOperatorIntro(body.operator_intro);
  if (!verdict.ok) {
    return NextResponse.json({ error: verdict.message }, { status: 400 });
  }

  const admin = createAdminClient();
  const { error } = await admin
    .from("customers")
    .update({
      operator_intro: verdict.value,
      // Its own timestamp, deliberately NOT presentation_settings_updated_at:
      // that column is the "have they set their terms up yet" test (§26.5), and
      // sharing it would mean writing an intro silently answers a question
      // nobody asked.
      operator_intro_updated_at: new Date().toISOString(),
    })
    .eq("id", customer.id);

  if (error) {
    console.error("[settings/operator-intro] save failed", error);
    return NextResponse.json({ error: "Could not save that." }, { status: 500 });
  }

  return NextResponse.json({ ok: true, operator_intro: verdict.value });
}
