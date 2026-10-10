import { NextResponse } from "next/server";
import { getCurrentCustomer } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { scheduleTighterArea, type AreaConfirmCustomer } from "@/lib/briefAreaConfirm";
import { canEditLeadBrief } from "@/lib/leadBrief/gate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const SOURCE = "lead-brief/area/tighten";

/**
 * The last step of "Switch to 10 leads" on the confirm screen (batch 04
 * Phase 3, C5): the area is confirmed, the plan switched (§24's route), and
 * now the 10-lead area for the customer's answers is saved as the one
 * scheduled change, starting at the renewal the plan changes at. No body: the
 * plan is read from the row (briefPlanFor), so a customer still on 20 leads is
 * refused (409 `not_switched`) rather than tightened.
 *
 * Session only; refused while an admin is viewing (§62).
 */
export async function POST() {
  const { user, customer } = await getCurrentCustomer();
  if (!user) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  if (!customer || !canEditLeadBrief(customer)) {
    return NextResponse.json({ error: "Not available", code: "not_brief_customer" }, { status: 403 });
  }

  const result = await scheduleTighterArea(createAdminClient(), customer as AreaConfirmCustomer, {
    now: new Date(),
  });
  switch (result.kind) {
    case "scheduled":
      return NextResponse.json({ ok: true, startsOn: result.startsOn, radiusMiles: result.radiusMiles });
    case "unchanged":
      return NextResponse.json({ ok: true, unchanged: true });
    case "not_switched":
      return NextResponse.json({ code: "not_switched" }, { status: 409 });
    case "conflict":
      return NextResponse.json({ code: "conflict" }, { status: 409 });
    case "retry":
      console.error(`[${SOURCE}] tighter area not saved`, { customer: customer.id, error: result.error });
      return NextResponse.json({ code: "retry" }, { status: 503 });
  }
}
