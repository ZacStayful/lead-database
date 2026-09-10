import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isAdminUser } from "@/lib/auth";
import { completeAssignment } from "@/lib/ingest";
import { leadPriceFor } from "@/lib/plans";
import type { Lead, LeadType } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Leads to consider per run. Oldest first, so the queue always drains. */
const LEAD_BATCH = 50;

/** Ceiling on assignments per run, so one invocation cannot run long. */
const MAX_ASSIGNMENTS_PER_RUN = 40;

/**
 * GET/POST /api/cron/backfill-assignments
 *
 * Fills lead slots that were never assigned in the first place.
 *
 * A lead arriving when nobody has credit, or when fewer operators are eligible
 * than it has slots, is assigned partially or not at all — and nothing ever
 * retried it. Credit arriving later (a renewal topping up lead_balance, a new
 * customer going active) did not wake that inventory up, so it aged in place.
 * Stale inventory is a direct cause of "the landlord already went with someone
 * else", which is the complaint this whole feature exists to answer.
 *
 * This only ever fills slots that were never used. A slot vacated by a
 * rejection is not reopened — neither apply_quality_claim nor
 * apply_lead_rejection decrements leads.assignment_count — so a lead one
 * operator reported dead can never be resold here.
 *
 * Auth mirrors the other cron routes: Bearer $CRON_SECRET, or an admin session
 * for a manual run. On a Vercel Hobby plan (daily cron limit) drive it from the
 * existing n8n Schedule trigger instead of vercel.json.
 */
async function handle(request: NextRequest) {
  const auth = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  const viaCron = Boolean(cronSecret) && auth === `Bearer ${cronSecret}`;

  if (!viaCron) {
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!isAdminUser(user)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const admin = createAdminClient();

  const { data: openLeads, error: queueError } = await admin.rpc(
    "leads_with_open_slots",
    { p_limit: LEAD_BATCH }
  );
  if (queueError) {
    return NextResponse.json({ error: queueError.message }, { status: 500 });
  }

  const queue = (openLeads ?? []) as {
    lead_id: string;
    lead_type: LeadType;
    open_slots: number;
  }[];

  let assigned = 0;
  let leadsTouched = 0;

  for (const entry of queue) {
    if (assigned >= MAX_ASSIGNMENTS_PER_RUN) break;

    const slots = Math.min(
      entry.open_slots,
      MAX_ASSIGNMENTS_PER_RUN - assigned
    );
    if (slots <= 0) continue;

    // Same selection the ingest path uses: deficit-first pacing, positive
    // balance, and never a customer who already holds this lead.
    const { data: candidates } = await admin.rpc(
      "get_next_customers_for_lead",
      {
        p_lead_id: entry.lead_id,
        p_max: slots,
        p_lead_type: entry.lead_type,
      }
    );

    const customerIds = ((candidates ?? []) as { customer_id: string }[]).map(
      (c) => c.customer_id
    );
    if (customerIds.length === 0) continue;

    const { data: leadRow } = await admin
      .from("leads")
      .select("*")
      .eq("id", entry.lead_id)
      .single();
    const lead = leadRow as Lead | null;
    if (!lead) continue;

    let assignedForLead = 0;
    for (const customerId of customerIds) {
      const { data: assignmentId, error: assignError } = await admin.rpc(
        "assign_lead_to_customer",
        {
          p_lead_id: entry.lead_id,
          p_customer_id: customerId,
          p_price: leadPriceFor(entry.lead_type),
          p_lead_type: entry.lead_type,
        }
      );
      // A customer who spent their last credit between the two calls, or a
      // lead that filled up in the meantime, simply skips.
      if (assignError || !assignmentId) continue;

      await completeAssignment(admin, lead, customerId, assignmentId as string);
      assigned += 1;
      assignedForLead += 1;
    }

    if (assignedForLead > 0) leadsTouched += 1;
  }

  return NextResponse.json({
    ok: true,
    leads_considered: queue.length,
    leads_assigned: leadsTouched,
    assignments_made: assigned,
  });
}

export async function GET(request: NextRequest) {
  return handle(request);
}

export async function POST(request: NextRequest) {
  return handle(request);
}
