import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Add a timestamped note to one of the authenticated customer's own lead
 * assignments. Ownership is verified before insert; the note's created_at
 * timestamp is set by the database default.
 */
export async function POST(request: NextRequest) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { lead_assignment_id?: string; body?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const text = body.body?.trim();
  if (!body.lead_assignment_id || !text) {
    return NextResponse.json(
      { error: "lead_assignment_id and a non-empty body are required" },
      { status: 400 }
    );
  }

  const admin = createAdminClient();

  // Confirm the assignment belongs to this user before attaching a note.
  const { data: assignment } = await admin
    .from("lead_assignments")
    .select("id, customer_id, customers!inner(user_id)")
    .eq("id", body.lead_assignment_id)
    .maybeSingle();

  const ownerId = (assignment as { customers?: { user_id?: string } } | null)
    ?.customers?.user_id;
  const customerId = (assignment as { customer_id?: string } | null)?.customer_id;

  if (!assignment || ownerId !== user.id || !customerId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const { data: note, error } = await admin
    .from("lead_notes")
    .insert({
      lead_assignment_id: body.lead_assignment_id,
      customer_id: customerId,
      body: text,
    })
    .select("id, lead_assignment_id, customer_id, body, created_at")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  return NextResponse.json({ ok: true, note });
}
