/**
 * The customer's inbox (§56): one row per lead with any contact activity.
 *
 * Read-only, session-authenticated, scoped by customer_id inside
 * fetchInboxRows. Deliberately NOT part of /api/v1 — the public API is
 * read-only by design and an inbox with unread counts and starring is a
 * dashboard surface, not an integration one (§27.1).
 */
import { NextResponse } from "next/server";
import { getCurrentCustomer } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchInboxRows } from "@/lib/messaging/inbox";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const { user, customer } = await getCurrentCustomer();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!customer) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const admin = createAdminClient();
  const { rows, error } = await fetchInboxRows(admin, customer.id);
  if (error) {
    console.error("[messaging/threads] inbox load failed", error);
    return NextResponse.json({ error: "Could not load your conversations." }, { status: 500 });
  }

  // The full assignment (with its viewer-scoped lead) is what the page
  // renders; the API returns the lighter shape.
  return NextResponse.json({
    ok: true,
    threads: rows.map((r) => ({
      lead_id: r.leadId,
      assignment_id: r.assignmentId,
      lead_name: r.assignment.lead?.lead_name ?? null,
      address: r.assignment.lead?.address ?? null,
      channels: r.channels,
      has_messages: r.hasMessages,
      unread: r.unread,
      starred: r.starred,
      last_activity_at: r.lastActivityAt,
      last_inbound_at: r.lastInboundAt,
      preview: r.preview,
    })),
  });
}
