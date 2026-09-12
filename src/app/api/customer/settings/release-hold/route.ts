import { NextResponse, type NextRequest } from "next/server";
import { getCurrentCustomer } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { addDays, londonDate } from "@/lib/pacing";
import type { LeadType } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * "Hold my leads until <date>" (§54).
 *
 * NOT a pause. Billing continues, credits are kept, nothing is voided at
 * Stripe; ordinary routing simply refuses to hand this customer a lead while
 * today is before the date, and the entitlement catches up at the daily cap
 * once it passes. That is the whole point — a week's leads must not die in an
 * inbox nobody is reading.
 *
 * Per product (invariant 6): a management hold never gates GR. The ceiling is
 * `release_hold_max_days` (14 by default), enforced HERE rather than in the
 * form, because the form is a courtesy and the route is the control. A null
 * clears the hold.
 *
 * Identity from the session, never the body — the §8 pattern.
 */
export async function POST(request: NextRequest) {
  const { user, customer } = await getCurrentCustomer();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!customer) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let body: { lead_type?: string; hold_until?: string | null };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const leadType: LeadType =
    body.lead_type === "guaranteed_rent" ? "guaranteed_rent" : "management";
  const column = leadType === "guaranteed_rent" ? "gr_release_hold_until" : "release_hold_until";

  const admin = createAdminClient();

  let value: string | null = null;
  if (body.hold_until != null && body.hold_until !== "") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(body.hold_until)) {
      return NextResponse.json({ error: "hold_until must be a date (YYYY-MM-DD)." }, { status: 400 });
    }
    const today = londonDate(new Date());
    if (body.hold_until <= today) {
      return NextResponse.json(
        { error: "Choose a date after today — that is the day your leads start again." },
        { status: 400 }
      );
    }
    const { data: maxRow } = await admin
      .from("system_settings")
      .select("value")
      .eq("key", "release_hold_max_days")
      .maybeSingle();
    const maxDays = Number((maxRow as { value?: string } | null)?.value);
    const ceiling = Number.isFinite(maxDays) && maxDays > 0 ? maxDays : 14;
    if (body.hold_until > addDays(today, ceiling)) {
      return NextResponse.json(
        { error: `A hold can be at most ${ceiling} days. For longer, pause your subscription instead.` },
        { status: 400 }
      );
    }
    value = body.hold_until;
  }

  const { error } = await admin
    .from("customers")
    .update({ [column]: value, updated_at: new Date().toISOString() })
    .eq("id", customer.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  return NextResponse.json({ ok: true, lead_type: leadType, hold_until: value });
}
