import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { CLOSE_REASONS, isCloseReason } from "@/lib/closeReasons";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/leads/[id]/close
 *
 * Record what happened to a lead the operator has actually worked, and take the
 * landlord out of circulation.
 *
 * This is the third exit, and the only one available after real work has
 * happened. Reject requires pipeline_stage = 'cold' and discard requires an
 * untouched 'new' assignment, so both refuse the operator who rang, got an
 * answer, and wants to file it — which is the one outcome worth recording.
 *
 * NOT A REFUND ROUTE. The lead stays chargeable (invariant 4). Wrong or
 * unusable contact details are a different problem and go through the support
 * desk, which is deliberate: because closing can never return a credit, there
 * is nothing to gain by misreporting it.
 *
 * Eligibility and ownership live entirely in close_lead_assignment, so this
 * route runs no pre-flight check of its own and the two cannot disagree — the
 * same arrangement as reject (§5E).
 */
export async function POST(req: NextRequest) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  let assignment_id: string | undefined;
  let reason: string | undefined;
  try {
    ({ assignment_id, reason } = await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!assignment_id) {
    return NextResponse.json({ error: "assignment_id required" }, { status: 400 });
  }
  if (!isCloseReason(reason)) {
    return NextResponse.json(
      { error: `reason must be one of: ${Object.keys(CLOSE_REASONS).join(", ")}` },
      { status: 400 }
    );
  }

  const admin = createAdminClient();

  const { data: customer, error: customerError } = await admin
    .from("customers")
    .select("id")
    .eq("user_id", user.id)
    .single();
  if (customerError || !customer) {
    return NextResponse.json({ error: "Customer not found" }, { status: 404 });
  }

  const { error: closeError } = await admin.rpc("close_lead_assignment", {
    p_assignment_id: assignment_id,
    p_customer_id: customer.id,
    p_reason: reason,
  });
  if (closeError) {
    return NextResponse.json({ error: closeError.message }, { status: 400 });
  }

  return NextResponse.json({ ok: true, reason });
}
