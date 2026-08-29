/**
 * The review queue (§40.13): what is about to go out, and to whom.
 *
 * ⚠️ THIS SCREEN IS THE CONSENT. Every message here sends itself unless the
 * operator does something, from their own WhatsApp number, to a member of the
 * public. Requiring approval instead would put the feature back to one lead at
 * a time, which is the problem it exists to solve — but a queue nobody can see
 * would make "drafted ahead, auto-sends unless cancelled" a promise with no
 * second half.
 */
import { NextResponse } from "next/server";
import { getCurrentCustomer } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { viewerScopedLead } from "@/lib/customerLeads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LIMIT = 200;

export async function GET() {
  const { user, customer } = await getCurrentCustomer();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!customer) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const admin = createAdminClient();
  const { data } = await admin
    .from("message_sequence_drafts")
    .select(
      "id, run_id, step_number, body, send_after, state, edited_at, created_at, " +
        "message_sequence_runs!inner(id, status, assignment_id, sequence_id, " +
        "message_sequences(name), " +
        "lead:leads(id, lead_name, address, owner_customer_id, lead_profile))"
    )
    .eq("customer_id", customer.id)
    .eq("state", "pending")
    .order("send_after", { ascending: true })
    .limit(LIMIT);

  const rows = (data ?? []) as unknown as {
    id: string;
    run_id: string;
    step_number: number;
    body: string;
    send_after: string;
    state: string;
    edited_at: string | null;
    message_sequence_runs: {
      id: string;
      status: string;
      assignment_id: string;
      sequence_id: string;
      message_sequences: { name: string } | null;
      lead: Record<string, unknown> | null;
    } | null;
  }[];

  return NextResponse.json({
    drafts: rows.map((r) => {
      // ⚠️ Scoped even here. On a resold imported lead, lead_profile is the
      // UPLOADING operator's private working notes and owner_customer_id is
      // their primary key — neither belongs in the buyer's browser (§32.8).
      const lead = viewerScopedLead(
        r.message_sequence_runs?.lead as never,
        customer.id
      ) as unknown as { lead_name?: string; address?: string } | null;
      return {
        id: r.id,
        run_id: r.run_id,
        assignment_id: r.message_sequence_runs?.assignment_id ?? null,
        sequence_name: r.message_sequence_runs?.message_sequences?.name ?? null,
        step_number: r.step_number,
        body: r.body,
        send_after: r.send_after,
        edited: Boolean(r.edited_at),
        lead_name: lead?.lead_name ?? null,
        address: lead?.address ?? null,
      };
    }),
  });
}
