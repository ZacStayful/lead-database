import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isAdminUser } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Update overridable lead fields (currently max_assignments). Admin only. */
export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!isAdminUser(user)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: { max_assignments?: number };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (
    !Number.isInteger(body.max_assignments) ||
    body.max_assignments! < 1 ||
    body.max_assignments! > 4
  ) {
    return NextResponse.json(
      { error: "max_assignments must be between 1 and 4" },
      { status: 400 }
    );
  }

  const admin = createAdminClient();

  // A customer's own lead has a hard reach of two — its uploader plus at most
  // one buyer (§32) — and this is the one place an admin could raise that by
  // hand. Every SQL path is guarded (0107); this is the last one, and it is
  // outside SQL.
  //
  // FAILS CLOSED. This is the only guard on a path that writes max_assignments
  // directly, so a dropped error would read as "not owned" and let the write
  // through — the one outcome that cannot be undone by retrying.
  const { data: owned, error: ownedError } = await admin
    .from("leads")
    .select("owner_customer_id")
    .eq("id", params.id)
    .maybeSingle();

  if (ownedError) {
    console.error("admin lead PATCH: ownership lookup failed", params.id, ownedError);
    return NextResponse.json(
      { error: "Could not check this lead. Please try again." },
      { status: 500 }
    );
  }

  if ((owned as { owner_customer_id?: string | null } | null)?.owner_customer_id) {
    return NextResponse.json(
      {
        error:
          "This lead was added by a customer. Its reach is fixed at the customer who added it plus at most one other operator, and cannot be raised.",
      },
      { status: 400 }
    );
  }

  const { data, error } = await admin
    .from("leads")
    .update({ max_assignments: body.max_assignments })
    .eq("id", params.id)
    .select("id, max_assignments, assignment_count")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  return NextResponse.json({ status: "ok", ...data });
}
