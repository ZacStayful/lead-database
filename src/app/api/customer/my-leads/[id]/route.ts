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

  // Best-effort tidy-up of any files attached to THIS customer's assignment.
  // Storage objects do not cascade with the row, so nothing else will ever
  // remove them.
  //
  // ⚠️ Scoped to the caller, because since §32 this lead may also be held by an
  // operator who bought it. Their files hang off their own assignment and must
  // survive — deleting by lead id alone would take the buyer's attachments with
  // the uploader's.
  const { data: files } = await admin
    .from("lead_files")
    .select("storage_path, lead_assignments!inner(lead_id, customer_id)")
    .eq("lead_assignments.lead_id", params.id)
    .eq("lead_assignments.customer_id", (customer as Customer).id);

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

  // Two modes, chosen under a row lock inside the function (0107).
  //
  // Nobody else holds it → the lead goes, as it always did. Somebody bought it
  // → only the uploader's own copy goes, and the buyer keeps the lead they paid
  // £15 for along with their notes, files and stages. Deleting the `leads` row
  // outright at that point would cascade all of it away.
  //
  // The choice is made in SQL rather than here because reading "does anyone
  // else hold this?" and then deleting leaves a window for a resale to land in
  // between.
  const { data: outcome, error } = await admin.rpc("delete_owner_lead_copy", {
    p_lead_id: params.id,
    p_customer_id: (customer as Customer).id,
  });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  // Same indistinguishable 404 as above. The row could have been deleted, or
  // sold, between the ownership check and the lock.
  if (outcome === "not_found") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({ ok: true, outcome });
}
