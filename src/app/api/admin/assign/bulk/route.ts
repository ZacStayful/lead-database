import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isAdminUser } from "@/lib/auth";
import { completeAssignment } from "@/lib/ingest";
import type { Lead } from "@/lib/types";
import { leadPriceFor } from "@/lib/plans";
import {
  describeLeadQuality,
  passesQualityGate,
  type LeadQualityCode,
} from "@/lib/leadQuality";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Long budget: notifications (email/SMS) are the slow part. Vercel Pro honours
// up to 300s; Hobby clamps to 60s — the batch cap below keeps us well inside it.
export const maxDuration = 300;


// Bound the fan-out so one request can't run away. Notifications are sent in
// parallel (see NOTIFY_CONCURRENCY), so these caps keep a batch fast enough to
// finish well within the function time limit.
const MAX_LEADS = 200;
const MAX_CUSTOMERS = 20;
// Hard ceiling on total (lead × customer) pairs handled in one request, so a
// select-all can't queue thousands of emails and time out.
const MAX_PAIRS = 150;
// How many post-assignment notifications (email + SMS + flag writes) to send at
// once. Sequential sends are the timeout cause; parallelising cuts wall-clock
// roughly by this factor while staying gentle on Resend/Twilio.
const NOTIFY_CONCURRENCY = 8;

/** Run an async fn over items with bounded concurrency. */
async function inChunks<T>(
  items: T[],
  size: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  for (let i = 0; i < items.length; i += size) {
    await Promise.all(items.slice(i, i + size).map(fn));
  }
}

/**
 * Assign a hand-picked SET of leads to a hand-picked SET of customers: every
 * selected customer is placed on every selected lead (capacity permitting). The
 * admin chooses exactly which leads go out, so stale leads are never swept up
 * automatically.
 *
 * override=true routes through admin_assign_lead to bypass the paid-credit gate
 * (still honouring capacity and the paused-customer block); otherwise the
 * credit-gated assign_lead_to_customer is used and any pair the customer can't
 * legitimately receive is reported as a per-pair failure rather than aborting.
 */
export async function POST(request: NextRequest) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!isAdminUser(user)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: {
    lead_ids?: string[];
    customer_ids?: string[];
    override?: boolean;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const leadIds = Array.from(new Set((body.lead_ids ?? []).filter(Boolean)));
  const customerIds = Array.from(
    new Set((body.customer_ids ?? []).filter(Boolean))
  );
  const override = body.override === true;

  if (leadIds.length === 0 || customerIds.length === 0) {
    return NextResponse.json(
      { error: "Select at least one lead and one customer." },
      { status: 400 }
    );
  }
  if (leadIds.length > MAX_LEADS || customerIds.length > MAX_CUSTOMERS) {
    return NextResponse.json(
      {
        error: `Too many at once — max ${MAX_LEADS} leads and ${MAX_CUSTOMERS} customers per batch.`,
      },
      { status: 400 }
    );
  }
  if (leadIds.length * customerIds.length > MAX_PAIRS) {
    return NextResponse.json(
      {
        error: `That's ${leadIds.length * customerIds.length} assignments (${leadIds.length} leads × ${customerIds.length} customers) — the max per batch is ${MAX_PAIRS}. Assign fewer leads at a time.`,
      },
      { status: 400 }
    );
  }

  const admin = createAdminClient();

  const { data: leadsRaw, error: leadsError } = await admin
    .from("leads")
    .select("*")
    .in("id", leadIds);
  if (leadsError) {
    return NextResponse.json({ error: leadsError.message }, { status: 500 });
  }
  const allLeads = (leadsRaw ?? []) as Lead[];

  // ⚠️ THE ADMIN OVERRIDE PATH BYPASSES BOTH ALLOCATION PREDICATES. When
  // `override` is set the RPC is `admin_assign_lead`, which writes its own
  // UPDATE and consults neither `lead_retired_from_allocation` nor
  // `lead_pool_barred` — the same gap 0102 had to close by hand for owned
  // leads. So the contact-quality gate is asserted here, in the route.
  //
  // It is refused rather than silently honoured, and the message names the
  // override so there is ONE verb for "sell it anyway" and one place that
  // records who said so.
  // Here the blocked leads are SKIPPED rather than failing the whole request:
  // a bulk assign over a hundred leads must not be refused outright because one
  // of them has a bad phone number. Each is reported as its own failure so the
  // admin can see exactly which, and why.
  const leads = allLeads.filter((lead) => passesQualityGate(lead));
  const blockedLeads = allLeads.filter((lead) => !passesQualityGate(lead));

  const leadsAffected = new Set<string>();
  const failures: { lead_id: string; customer_id: string; error: string }[] = [];

  for (const lead of blockedLeads) {
    for (const customerId of customerIds) {
      failures.push({
        lead_id: lead.id,
        customer_id: customerId,
        error:
          "Failed the contact-quality check: " +
          describeLeadQuality(lead.lead_quality_codes as LeadQualityCode[]),
      });
    }
  }

  // Phase 1 — do the assignments (fast, DB-only). The RPC locks the lead and
  // customer rows, so keep it sequential to respect capacity/credit order and
  // avoid lock contention. Collect successes for the (slow) notify phase.
  const placed: { lead: Lead; customerId: string; assignmentId: string }[] = [];
  for (const lead of leads) {
    const price = leadPriceFor(lead.lead_type);
    for (const customerId of customerIds) {
      const { data: assignmentId, error: assignError } = await admin.rpc(
        override ? "admin_assign_lead" : "assign_lead_to_customer",
        {
          p_lead_id: lead.id,
          p_customer_id: customerId,
          p_price: price,
          p_lead_type: lead.lead_type,
        }
      );

      if (assignError || !assignmentId) {
        failures.push({
          lead_id: lead.id,
          customer_id: customerId,
          error: assignError?.message ?? "Assignment failed",
        });
        continue;
      }

      placed.push({ lead, customerId, assignmentId: assignmentId as string });
      leadsAffected.add(lead.id);
    }
  }

  // Phase 2 — notifications (in-portal + new-lead email + SMS). These are the
  // slow, network-bound part, so run them in bounded-parallel batches instead of
  // one-at-a-time; sequential sends are what pushed large batches past the
  // function time limit (surfacing as a non-JSON gateway error in the browser).
  // Credit-threshold warnings are suppressed for the whole bulk action: a
  // customer receiving several leads at once would otherwise get duplicate
  // low/exhausted-credit emails (the phase-1/phase-2 split reads the same final
  // balance), and an admin bulk-assign shouldn't spam those anyway.
  await inChunks(placed, NOTIFY_CONCURRENCY, ({ lead, customerId, assignmentId }) =>
    completeAssignment(admin, lead, customerId, assignmentId, false)
  );

  return NextResponse.json({
    status: "ok",
    assignments: placed.length,
    leads_affected: leadsAffected.size,
    requested_leads: leadIds.length,
    requested_customers: customerIds.length,
    failures,
  });
}
