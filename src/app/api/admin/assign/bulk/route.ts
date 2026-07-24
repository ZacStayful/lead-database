import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isAdminUser } from "@/lib/auth";
import { completeAssignment } from "@/lib/ingest";
import type { Lead } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const LEAD_PRICE = 15.0;
const GR_LEAD_PRICE = 10.0;

// Bound the fan-out so one request can't fire an unbounded number of emails.
const MAX_LEADS = 200;
const MAX_CUSTOMERS = 20;

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

  const admin = createAdminClient();

  const { data: leadsRaw, error: leadsError } = await admin
    .from("leads")
    .select("*")
    .in("id", leadIds);
  if (leadsError) {
    return NextResponse.json({ error: leadsError.message }, { status: 500 });
  }
  const leads = (leadsRaw ?? []) as Lead[];

  let assignments = 0;
  const leadsAffected = new Set<string>();
  const failures: { lead_id: string; customer_id: string; error: string }[] = [];

  for (const lead of leads) {
    const price = lead.lead_type === "guaranteed_rent" ? GR_LEAD_PRICE : LEAD_PRICE;
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

      // Notification + new-lead email; skip credit-threshold warnings on an
      // override, where no credit is spent and those emails would misfire.
      await completeAssignment(admin, lead, customerId, assignmentId, !override);
      assignments += 1;
      leadsAffected.add(lead.id);
    }
  }

  return NextResponse.json({
    status: "ok",
    assignments,
    leads_affected: leadsAffected.size,
    requested_leads: leadIds.length,
    requested_customers: customerIds.length,
    failures,
  });
}
