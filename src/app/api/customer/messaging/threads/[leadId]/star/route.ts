/**
 * Star or unstar a lead's conversation (§56). POST stars, DELETE unstars.
 *
 * Starring is a fact about the operator's attention, kept on every thread of
 * the lead so a row folded from two channels reads consistently. Nothing
 * routes on it.
 */
import { NextResponse } from "next/server";
import { getCurrentCustomer } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function setStar(leadId: string, starred: boolean) {
  const { user, customer } = await getCurrentCustomer();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!customer) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const admin = createAdminClient();
  const { data: owned } = await admin
    .from("lead_assignments")
    .select("id")
    .eq("lead_id", leadId)
    .eq("customer_id", customer.id)
    .maybeSingle();
  if (!owned) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const { error, count } = await admin
    .from("lead_message_threads")
    .update({ starred_at: starred ? new Date().toISOString() : null }, { count: "exact" })
    .eq("customer_id", customer.id)
    .eq("assignment_id", owned.id);
  if (error) return NextResponse.json({ error: "Could not update." }, { status: 500 });
  if (!count) {
    // A lead reached only by clicks has no thread row to star yet. Say so
    // rather than silently succeeding at nothing.
    return NextResponse.json(
      { error: "Nothing has been sent or received on this lead yet, so there is no conversation to star." },
      { status: 409 }
    );
  }
  return NextResponse.json({ ok: true, starred });
}

export async function POST(_req: Request, { params }: { params: { leadId: string } }) {
  return setStar(params.leadId, true);
}

export async function DELETE(_req: Request, { params }: { params: { leadId: string } }) {
  return setStar(params.leadId, false);
}
