import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Record metadata for a file the client has just uploaded to the private
 * 'lead-files' bucket. Verifies the assignment belongs to the caller and that
 * the storage path sits under the caller's own folder (<user_id>/…).
 */
export async function POST(request: NextRequest) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: {
    lead_assignment_id?: string;
    storage_path?: string;
    file_name?: string;
    size_bytes?: number;
    mime_type?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { lead_assignment_id, storage_path, file_name } = body;
  if (!lead_assignment_id || !storage_path || !file_name) {
    return NextResponse.json(
      { error: "lead_assignment_id, storage_path and file_name are required" },
      { status: 400 }
    );
  }

  // The upload must live in the caller's own folder.
  if (!storage_path.startsWith(`${user.id}/`)) {
    return NextResponse.json({ error: "Invalid storage path" }, { status: 400 });
  }

  const admin = createAdminClient();

  // Confirm the assignment belongs to this user and get the customer_id.
  const { data: assignment } = await admin
    .from("lead_assignments")
    .select("id, customer_id, customers!inner(user_id)")
    .eq("id", lead_assignment_id)
    .maybeSingle();

  const ownerId = (assignment as { customers?: { user_id?: string } } | null)
    ?.customers?.user_id;
  const customerId = (assignment as { customer_id?: string } | null)?.customer_id;

  if (!assignment || ownerId !== user.id || !customerId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const { data: file, error } = await admin
    .from("lead_files")
    .insert({
      lead_assignment_id,
      customer_id: customerId,
      file_name,
      storage_path,
      size_bytes: typeof body.size_bytes === "number" ? body.size_bytes : null,
      mime_type: body.mime_type ?? null,
    })
    .select("*")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  return NextResponse.json({ ok: true, file });
}
