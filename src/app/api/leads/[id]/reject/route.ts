import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  OWNED_LEAD_OUTCOME_REFUSAL,
  getAssignmentLeadOwnership,
} from "@/lib/customerLeads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Mark a lead assignment as rejected. Rejection is a pipeline/feedback signal
 * only: the lead still counts toward the customer's monthly leads and remains
 * chargeable, no credit is refunded, and no replacement is assigned.
 *
 * Eligibility is decided entirely inside reject_lead_assignment — this route
 * runs no pre-flight status check of its own, so the two cannot disagree. Since
 * 0043 the rule is pipeline_stage = 'cold' (nothing built on the lead yet)
 * rather than status = 'new', because status now moves by itself on the first
 * sign of activity and would otherwise lock an operator out of passing on a
 * lead they had merely rung. Terminal statuses ('won', 'rejected') stay barred.
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
  try {
    ({ assignment_id } = await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!assignment_id) {
    return NextResponse.json(
      { error: "assignment_id required" },
      { status: 400 }
    );
  }

  const admin = createAdminClient();

  // Resolve customer_id from the session user.
  const { data: customer, error: customerError } = await admin
    .from("customers")
    .select("id")
    .eq("user_id", user.id)
    .single();
  if (customerError || !customer) {
    return NextResponse.json({ error: "Customer not found" }, { status: 404 });
  }

  // A lead the customer added themselves cannot be rejected: rejection is a
  // settled, chargeable outcome on a lead WE sold them (0019), and nothing was
  // sold here. Delete is the verb for their own leads.
  const ownership = await getAssignmentLeadOwnership(admin, assignment_id);
  if (ownership?.ownerCustomerId) {
    return NextResponse.json(
      { error: OWNED_LEAD_OUTCOME_REFUSAL, code: "owned_lead" },
      { status: 400 }
    );
  }

  // Atomic status flip. Fails (400) if the assignment is not owned by this
  // customer or is no longer in 'new' status. No refund, no reassignment.
  const { error: rejectError } = await admin.rpc("reject_lead_assignment", {
    p_assignment_id: assignment_id,
    p_customer_id: customer.id,
  });
  if (rejectError) {
    return NextResponse.json({ error: rejectError.message }, { status: 400 });
  }

  return NextResponse.json({ ok: true });
}
