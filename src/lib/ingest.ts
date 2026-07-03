import { createAdminClient } from "@/lib/supabase/admin";
import {
  sendNewLeadEmail,
  sendLowCreditsEmail,
  sendCreditsExhaustedEmail,
} from "@/lib/emails";
import { extractCity } from "@/lib/utils";
import type { Customer, Lead, N8nLeadPayload } from "@/lib/types";

const LEAD_PRICE = 15.0;
const LOW_CREDITS_THRESHOLD = 18;

const LEAD_FIELDS: (keyof N8nLeadPayload)[] = [
  "monday_item_id",
  "lead_name",
  "address",
  "phone",
  "email",
  "lead_profile",
  "bedrooms",
  "enquiry_date",
  "estimated_monthly_income",
];

export interface IngestResult {
  status: "created" | "duplicate" | "error";
  lead_id?: string;
  assignments_made: number;
  error?: string;
}

/**
 * Idempotently insert a lead and assign it to eligible customers, sending the
 * in-portal notification, Resend email and threshold warnings.
 *
 * Shared by the n8n webhook and the Monday pull-sync so both paths behave
 * identically. Keyed on monday_item_id, so re-running never double-inserts.
 */
export async function ingestLead(
  payload: N8nLeadPayload
): Promise<IngestResult> {
  const supabase = createAdminClient();

  // Idempotency: skip if this Monday item is already ingested.
  const { data: existing } = await supabase
    .from("leads")
    .select("id")
    .eq("monday_item_id", String(payload.monday_item_id))
    .maybeSingle();

  if (existing) {
    return { status: "duplicate", lead_id: existing.id, assignments_made: 0 };
  }

  // Insert the lead.
  const insertPayload: Record<string, string> = {};
  for (const field of LEAD_FIELDS) {
    insertPayload[field] = payload[field] != null ? String(payload[field]) : "";
  }

  const { data: lead, error: insertError } = await supabase
    .from("leads")
    .insert(insertPayload)
    .select("*")
    .single();

  if (insertError || !lead) {
    // Unique-violation race: another request inserted the same item first.
    if (insertError?.code === "23505") {
      return { status: "duplicate", assignments_made: 0 };
    }
    console.error("Lead insert failed", insertError);
    return {
      status: "error",
      assignments_made: 0,
      error: insertError?.message ?? "Failed to insert lead",
    };
  }

  const typedLead = lead as Lead;

  // Find eligible customers (deficit-first, up to max_assignments).
  const { data: candidates, error: candidateError } = await supabase.rpc(
    "get_next_customers_for_lead",
    { p_lead_id: typedLead.id, p_max: typedLead.max_assignments ?? 2 }
  );

  if (candidateError) {
    console.error("get_next_customers_for_lead failed", candidateError);
    return {
      status: "created",
      lead_id: typedLead.id,
      assignments_made: 0,
      error: candidateError.message,
    };
  }

  const customerIds: string[] = (candidates ?? []).map(
    (c: { customer_id: string }) => c.customer_id
  );

  let assignmentsMade = 0;

  for (const customerId of customerIds) {
    const { data: assignmentId, error: assignError } = await supabase.rpc(
      "assign_lead_to_customer",
      { p_lead_id: typedLead.id, p_customer_id: customerId, p_price: LEAD_PRICE }
    );

    if (assignError || !assignmentId) continue;
    assignmentsMade += 1;

    const { data: customer } = await supabase
      .from("customers")
      .select("*")
      .eq("id", customerId)
      .single();

    const typedCustomer = customer as Customer | null;
    if (!typedCustomer) continue;

    // In-portal notification (feeds the realtime subscription).
    const city = extractCity(typedLead.address);
    const { data: notification } = await supabase
      .from("notifications")
      .insert({
        customer_id: customerId,
        lead_assignment_id: assignmentId,
        notification_type: "new_lead",
        message: `New lead: ${typedLead.lead_name}${city ? ` in ${city}` : ""}`,
      })
      .select("id")
      .single();

    const { error: emailError } = await sendNewLeadEmail({
      to: typedCustomer.email,
      lead: typedLead,
    });

    await supabase
      .from("lead_assignments")
      .update({ notification_sent: true, email_sent: !emailError })
      .eq("id", assignmentId);

    if (notification) {
      await supabase
        .from("notifications")
        .update({ email_sent: !emailError })
        .eq("id", notification.id);
    }

    // Threshold emails (post-increment count; RPC already incremented).
    const newCount = typedCustomer.leads_received_this_month;
    if (newCount === typedCustomer.monthly_allocation) {
      await sendCreditsExhaustedEmail({ to: typedCustomer.email });
    } else if (newCount === LOW_CREDITS_THRESHOLD) {
      await sendLowCreditsEmail({
        to: typedCustomer.email,
        remaining: typedCustomer.monthly_allocation - newCount,
      });
    }
  }

  return {
    status: "created",
    lead_id: typedLead.id,
    assignments_made: assignmentsMade,
  };
}
