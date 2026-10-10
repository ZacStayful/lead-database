import { NextResponse, type NextRequest } from "next/server";
import { getCurrentCustomer } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { confirmPendingArea, type AreaConfirmCustomer } from "@/lib/briefAreaConfirm";
import { AREA_CONFIRM_COPY } from "@/lib/leadBrief/areaConfirmCopy";
import { canEditLeadBrief } from "@/lib/leadBrief/gate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const SOURCE = "lead-brief/area/confirm";

/**
 * Confirm a recalculated coverage area (batch 04 Phase 3, locked decision 4).
 * Session only; identity from the session, never the body. An admin viewing as
 * the customer is refused upstream by the read-only middleware (§62).
 *
 * Body: { pendingId, forSwitch? }. `pendingId` is the version the screen
 * showed; a different one is 409 `conflict`. `forSwitch` is "Switch to 10
 * leads" (C5): the plan cannot change while paused, so a return's leads
 * restart now rather than on the return date.
 *
 * Everything is in confirmPendingArea: the first picks recomputed, the 0169
 * confirm under the brief's lock, then the restart when it is due.
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
  const pendingId = typeof body.pendingId === "string" ? body.pendingId : "";
  if (!pendingId) return NextResponse.json({ code: "pending_id_required" }, { status: 400 });

  const result = await confirmPendingArea(createAdminClient(), customer as AreaConfirmCustomer, {
    expectedPendingId: pendingId,
    auto: false,
    now: new Date(),
    source: SOURCE,
    restartNow: body.forSwitch === true,
  });

  switch (result.kind) {
    case "confirmed":
      return NextResponse.json({
        ok: true,
        isReturn: result.isReturn,
        resume: result.resume,
        restartYmd: result.restartYmd,
      });
    case "conflict":
    case "not_pending":
      // Not pending any more (confirmed in another tab, or set aside by an
      // extension): the screen they were looking at is stale either way.
      return NextResponse.json({ code: "conflict", error: AREA_CONFIRM_COPY.errorConflict }, { status: 409 });
    case "not_brief_customer":
      return NextResponse.json({ error: "Not available", code: "not_brief_customer" }, { status: 403 });
    case "not_due":
    case "retry":
      console.error(`[${SOURCE}] confirm failed`, { customer: customer.id, result });
      return NextResponse.json({ code: "retry", error: AREA_CONFIRM_COPY.errorGeneric }, { status: 503 });
  }
}
