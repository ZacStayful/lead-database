import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Mark a lead assignment as rejected. Rejection is a pipeline/feedback signal
 * only: the lead still counts toward the customer's monthly leads and remains
 * chargeable, no credit is refunded, and no replacement is assigned. The status
 * flip is atomic and only permitted while the assignment is still 'new'.
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
