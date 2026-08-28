/**
 * The conversation on one assignment (§40).
 *
 * Reading is deliberately NOT gated on assignment status: a rejected or closed
 * lead is still one the customer paid for (invariant 4), and the thread is their
 * own record of work they did. Only SENDING is refused on a settled lead — the
 * same shape as /api/leads/[id]/report, where the assignment row is the
 * entitlement and status is not consulted for reading.
 */
import { NextResponse, type NextRequest } from "next/server";
import { getCurrentCustomer } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MESSAGE_COLUMNS =
  "id, channel, direction, status, subject, body_text, created_at, sent_at, " +
  "delivered_at, read_at, first_opened_at, first_clicked_at, replied_at, error_code";

export async function GET(
  request: NextRequest,
  { params }: { params: { assignmentId: string } }
) {
  const { user, customer } = await getCurrentCustomer();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!customer) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const channel = request.nextUrl.searchParams.get("channel");
  if (channel && channel !== "email" && channel !== "whatsapp") {
    return NextResponse.json({ error: "Unknown channel." }, { status: 400 });
  }

  const admin = createAdminClient();

  // Scoped by customer_id: a foreign assignment id reads as nonexistent.
  const { data: owned } = await admin
    .from("lead_assignments")
    .select("id")
    .eq("id", params.assignmentId)
    .eq("customer_id", customer.id)
    .maybeSingle();

  if (!owned) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let query = admin
    .from("lead_messages")
    .select(MESSAGE_COLUMNS)
    .eq("customer_id", customer.id)
    .eq("assignment_id", params.assignmentId)
    .order("created_at", { ascending: true })
    .limit(200);

  if (channel) query = query.eq("channel", channel);

  const { data, error } = await query;

  if (error) {
    console.error("[messaging/thread] load failed", error);
    return NextResponse.json({ error: "Could not load the conversation." }, { status: 500 });
  }

  // Reading the thread clears the unread marker for this assignment's threads.
  if (channel) {
    await admin
      .from("lead_message_threads")
      .update({ unread_inbound_count: 0 })
      .eq("customer_id", customer.id)
      .eq("assignment_id", params.assignmentId)
      .eq("channel", channel);
  }

  return NextResponse.json({ ok: true, messages: data ?? [] });
}
