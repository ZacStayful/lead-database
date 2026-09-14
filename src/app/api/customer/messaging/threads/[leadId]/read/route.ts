/**
 * Mark a lead's conversation read or unread (§56).
 *
 * Until this existed the only read-reset in the system was a side effect of
 * loading one channel's thread into the composer. An inbox needs the verb on
 * its own: POST { read: true } zeroes every thread on this lead, POST
 * { read: false } marks the newest thread as carrying one unread reply so the
 * row surfaces again under Unread.
 *
 * Scoped by customer_id on every write (0116's containment guarantee); a lead
 * the customer does not hold reads as nonexistent.
 */
import { NextResponse, type NextRequest } from "next/server";
import { getCurrentCustomer } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  { params }: { params: { leadId: string } }
) {
  const { user, customer } = await getCurrentCustomer();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!customer) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let body: { read?: unknown };
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const read = body.read !== false;

  const admin = createAdminClient();

  const { data: owned } = await admin
    .from("lead_assignments")
    .select("id")
    .eq("lead_id", params.leadId)
    .eq("customer_id", customer.id)
    .maybeSingle();
  if (!owned) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (read) {
    const { error } = await admin
      .from("lead_message_threads")
      .update({ unread_inbound_count: 0 })
      .eq("customer_id", customer.id)
      .eq("assignment_id", owned.id)
      .gt("unread_inbound_count", 0);
    if (error) return NextResponse.json({ error: "Could not update." }, { status: 500 });
    return NextResponse.json({ ok: true, unread: 0 });
  }

  // Mark unread: the newest thread on this lead gets one unread reply.
  const { data: newest } = await admin
    .from("lead_message_threads")
    .select("id, unread_inbound_count")
    .eq("customer_id", customer.id)
    .eq("assignment_id", owned.id)
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();
  if (!newest) {
    return NextResponse.json(
      { error: "Nothing has been sent or received on this lead yet, so there is nothing to mark unread." },
      { status: 409 }
    );
  }
  const { error } = await admin
    .from("lead_message_threads")
    .update({ unread_inbound_count: Math.max(1, newest.unread_inbound_count ?? 0) })
    .eq("id", newest.id)
    .eq("customer_id", customer.id);
  if (error) return NextResponse.json({ error: "Could not update." }, { status: 500 });
  return NextResponse.json({ ok: true, unread: Math.max(1, newest.unread_inbound_count ?? 0) });
}
