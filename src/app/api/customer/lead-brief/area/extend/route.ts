import { NextResponse, type NextRequest } from "next/server";
import { getCurrentCustomer } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { extendLongPause, type AreaConfirmCustomer } from "@/lib/briefAreaConfirm";
import { AREA_CONFIRM_COPY } from "@/lib/leadBrief/areaConfirmCopy";
import { canEditLeadBrief } from "@/lib/leadBrief/gate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SOURCE = "lead-brief/area/extend";

/**
 * "Extend my pause" on the confirm screen (batch 04 Phase 3). Body:
 * { returnDate: "YYYY-MM-DD" }. A long brief pause only; the new date is
 * judged by extend_brief_pause (0169) against the pause itself: later than the
 * current return date, from tomorrow, and no more than 3 months from the day
 * they paused. The waiting area is set aside and recalculated again 7 days
 * before the new date. Session only; refused while an admin is viewing (§62).
 */
export async function POST(req: NextRequest) {
  const { user, customer } = await getCurrentCustomer();
  if (!user) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  if (!customer || !canEditLeadBrief(customer)) {
    return NextResponse.json({ error: "Not available", code: "not_brief_customer" }, { status: 403 });
  }

  let body: Record<string, unknown> = {};
  try {
    const raw = await req.json();
    if (raw && typeof raw === "object") body = raw as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const result = await extendLongPause(createAdminClient(), customer as AreaConfirmCustomer, body.returnDate, {
    source: SOURCE,
  });
  if (result.ok) return NextResponse.json({ ok: true, returnDate: result.returnYmd });
  if (result.code === "retry") {
    console.error(`[${SOURCE}] extend failed`, { customer: customer.id, error: result.error });
    return NextResponse.json({ code: "retry", error: AREA_CONFIRM_COPY.errorGeneric }, { status: 503 });
  }
  return NextResponse.json({ code: result.code, error: result.error }, { status: result.status });
}
