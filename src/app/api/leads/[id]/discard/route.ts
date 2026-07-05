import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Discard a lead assignment owned by the authenticated customer. Only allowed
 * while the assignment is status = 'new' and has no notes — the same check the
 * UI uses to decide whether to show the button, enforced again here (and once
 * more atomically inside discard_lead_assignment). Frees the lead slot so it
 * becomes eligible for reassignment; the monthly allocation is not refunded.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
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
    return NextResponse.json({ error: "assignment_id required" }, { status: 400 });
  }

  const admin = createAdminClient();

  // Verify ownership and re-check the discard preconditions server-side.
  const { data: assignment } = await admin
    .from("lead_assignments")
    .select("id, lead_id, status, customer_id, customers!inner(user_id)")
    .eq("id", assignment_id)
    .eq("lead_id", params.id)
    .maybeSingle();

  const ownerId = (assignment as { customers?: { user_id?: string } } | null)
    ?.customers?.user_id;

  if (!assignment || ownerId !== user.id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if ((assignment as { status?: string }).status !== "new") {
    return NextResponse.json(
      { error: "Only a new lead can be discarded" },
      { status: 400 }
    );
  }

  const { count: noteCount } = await admin
    .from("lead_notes")
    .select("id", { count: "exact", head: true })
    .eq("lead_assignment_id", assignment_id);

  if ((noteCount ?? 0) > 0) {
    return NextResponse.json(
      { error: "A lead with notes cannot be discarded" },
      { status: 400 }
    );
  }

  // Atomic discard (re-validates status + notes inside the function).
  const { error } = await admin.rpc("discard_lead_assignment", {
    p_lead_assignment_id: assignment_id,
  });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  return NextResponse.json({ ok: true });
}
