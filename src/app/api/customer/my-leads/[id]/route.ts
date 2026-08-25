import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getLeadOwnership } from "@/lib/customerLeads";
import type { Customer } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Delete a lead the customer added themselves.
 *
 * Delete rather than reject or discard, because those are marketplace verbs:
 * reject is a chargeable outcome on a lead we sold, close tells us not to
 * re-offer the landlord to anybody else, and discard decrements
 * `assignment_count` to put the lead back into circulation. Applied to an owned
 * lead, discard would leave the `leads` row alive with no assignment at all —
 * invisible to its owner under `leads_select_assigned`, absent from their feed,
 * and unreachable by any UI that could tidy it up.
 *
 * So this removes the lead row itself and lets the 0001 cascade take the
 * assignment, notes, files, events and notifications with it. The lead was
 * never ours and nothing was ever charged for it, so there is nothing to
 * preserve for accounting.
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();
  const { data: customer } = await admin
    .from("customers")
    .select("id")
    .eq("user_id", user.id)
    .maybeSingle();

  if (!customer) {
    return NextResponse.json({ error: "No customer record" }, { status: 404 });
  }

  const ownership = await getLeadOwnership(admin, params.id);

  // One indistinguishable 404 for "no such lead", "not yours" and "not an owned
  // lead", so this cannot be used to find out which leads exist or who holds
  // them.
  if (!ownership || ownership.ownerCustomerId !== (customer as Customer).id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Best-effort tidy-up of any files attached to the assignment. Storage
  // objects do not cascade with the row, and the lead is about to stop
  // existing, so nothing will ever reference them again.
  const { data: files } = await admin
    .from("lead_files")
    .select("storage_path, lead_assignments!inner(lead_id)")
    .eq("lead_assignments.lead_id", params.id);

  const paths = ((files ?? []) as { storage_path?: string }[])
    .map((f) => f.storage_path)
    .filter((p): p is string => Boolean(p));

  if (paths.length) {
    const { error: storageError } = await admin.storage.from("lead-files").remove(paths);
    // Not fatal: an orphaned object costs a little space, where refusing to
    // delete the lead would leave the customer stuck with a row they asked to
    // remove.
    if (storageError) {
      console.error("my-leads delete: could not remove lead files", storageError);
    }
  }

  const { error } = await admin.from("leads").delete().eq("id", params.id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  return NextResponse.json({ ok: true });
}
