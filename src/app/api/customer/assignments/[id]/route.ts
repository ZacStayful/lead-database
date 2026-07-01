import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Update the authenticated customer's own lead assignment.
 * Supports: mark viewed (sets viewed_at) and mark contacted (status).
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { viewed?: boolean; contacted?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const admin = createAdminClient();

  // Confirm ownership before mutating.
  const { data: assignment } = await admin
    .from("lead_assignments")
    .select("id, customer_id, viewed_at, customers!inner(user_id)")
    .eq("id", params.id)
    .maybeSingle();

  const ownerId = (assignment as { customers?: { user_id?: string } } | null)
    ?.customers?.user_id;

  if (!assignment || ownerId !== user.id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const update: Record<string, unknown> = {};
  if (body.viewed && !(assignment as { viewed_at?: string }).viewed_at) {
    update.viewed_at = new Date().toISOString();
  }
  if (body.contacted) {
    update.status = "contacted";
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ status: "noop" });
  }

  const { data, error } = await admin
    .from("lead_assignments")
    .update(update)
    .eq("id", params.id)
    .select("id, viewed_at, status")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  return NextResponse.json({ ok: true, assignment: data });
}
