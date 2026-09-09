import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isAdminRequest } from "@/lib/trainingAdmin";
import { validateTicketPatch } from "@/lib/supportTickets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Update one ticket, over a CLOSED ALLOW-LIST of fields (CLAUDE.md §46).
 *
 * ⚠️ THE KEY COMES FROM `TICKET_PATCH_FIELDS`, NEVER FROM THE BODY — the §40.14
 * rule `adminSettings.ts` states for `system_settings`, and it earns itself
 * here for a different reason: `customer_id`, `submitted_at`, `reference`,
 * `source` and `backfill_key` are the columns that say who asked and when, and
 * a route that upserts whatever it is handed could rewrite the history this
 * table exists to keep. `status` is absent too, because it has its own route.
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  if (!(await isAdminRequest(req))) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = validateTicketPatch(body);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data: existing } = await admin
    .from("support_tickets")
    .select("id")
    .eq("id", params.id)
    .maybeSingle();
  if (!existing) {
    return NextResponse.json({ error: "Ticket not found" }, { status: 404 });
  }

  const { error } = await admin
    .from("support_tickets")
    .update({ ...parsed.value, updated_at: new Date().toISOString() })
    .eq("id", params.id);

  if (error) {
    console.error("admin support ticket update failed", error);
    return NextResponse.json(
      { error: "Could not save that change." },
      { status: 500 }
    );
  }

  return NextResponse.json({ ok: true });
}
