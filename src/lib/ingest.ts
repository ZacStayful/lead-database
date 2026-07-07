import { createAdminClient } from "@/lib/supabase/admin";
import {
  sendNewLeadEmail,
  sendLowCreditsEmail,
  sendCreditsExhaustedEmail,
} from "@/lib/emails";
import { extractCity } from "@/lib/utils";
import type { Customer, Lead, LeadType, N8nLeadPayload } from "@/lib/types";

const LEAD_PRICE = 15.0;
const GR_LEAD_PRICE = 10.0;
const LOW_CREDITS_THRESHOLD = 18;

const LEAD_FIELDS: string[] = [
  "monday_item_id",
  "lead_name",
  "address",
  "phone",
  "email",
  "lead_profile",
  "bedrooms",
  "enquiry_date",
];

/**
 * GR (Guaranteed Rent) board 18396542480 field mapping: Monday column id →
 * target leads column. The payload from n8n may key GR fields by either the
 * Monday column id or the friendly snake_case name, so ingest reads both.
 *
 * The shared identity/contact fields (Address, Phone, Email, Number of
 * bedrooms, Date) map onto the existing generic leads columns. The two banned
 * columns (text_mkzxkfns "Rent offered", text_mkztftwn "Profit after
 * guaranteed rent") are absent here and additionally stripped at the webhook.
 */
const GR_COLUMN_MAP: Record<string, string> = {
  text_mkzxhyv9: "address",
  text_mkztq5xb: "phone",
  text_mkztseha: "email",
  text_mkzxxzjc: "bedrooms",
  date4: "enquiry_date",
  date_mkztg8w1: "last_contact",
  text_mkztg3z9: "desired_rent",
  file_mkzt6hf1: "pmi_analysis",
  file_mkzttt0h: "tenancy_agreement",
  file_mkzthq5b: "sourcing_agreement",
  formula_mm29p0r0: "formula",
};

/** GR board columns that must never be stored. */
export const GR_BANNED_COLUMNS = ["text_mkzxkfns", "text_mkztftwn"] as const;

function leadTypeOf(payload: N8nLeadPayload): LeadType {
  return payload.lead_type === "guaranteed_rent" ? "guaranteed_rent" : "management";
}

/** Build the leads insert row for a management lead. */
function buildManagementInsert(payload: N8nLeadPayload): Record<string, unknown> {
  const row: Record<string, unknown> = { lead_type: "management" };
  for (const field of LEAD_FIELDS) {
    row[field] = payload[field] != null ? String(payload[field]) : "";
  }
  return row;
}

/** Build the leads insert row for a guaranteed-rent lead. */
function buildGuaranteedRentInsert(
  payload: N8nLeadPayload
): Record<string, unknown> {
  const row: Record<string, unknown> = {
    lead_type: "guaranteed_rent",
    monday_item_id: String(payload.monday_item_id),
    lead_name: String(payload.lead_name),
  };
  for (const [columnId, target] of Object.entries(GR_COLUMN_MAP)) {
    // Prefer the Monday column id key, fall back to the friendly name.
    const raw = payload[columnId] ?? payload[target];
    row[target] = raw != null && raw !== "" ? String(raw) : null;
  }
  return row;
}

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

  // Insert the lead, mapping fields per product type.
  const leadType = leadTypeOf(payload);
  const insertPayload =
    leadType === "guaranteed_rent"
      ? buildGuaranteedRentInsert(payload)
      : buildManagementInsert(payload);

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
    {
      p_lead_id: typedLead.id,
      p_max: typedLead.max_assignments ?? 2,
      p_lead_type: leadType,
    }
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

  const price = leadType === "guaranteed_rent" ? GR_LEAD_PRICE : LEAD_PRICE;

  for (const customerId of customerIds) {
    const { data: assignmentId, error: assignError } = await supabase.rpc(
      "assign_lead_to_customer",
      {
        p_lead_id: typedLead.id,
        p_customer_id: customerId,
        p_price: price,
        p_lead_type: leadType,
      }
    );

    if (assignError || !assignmentId) continue;
    assignmentsMade += 1;

    await completeAssignment(supabase, typedLead, customerId, assignmentId);
  }

  return {
    status: "created",
    lead_id: typedLead.id,
    assignments_made: assignmentsMade,
  };
}

/**
 * Post-assignment follow-through: in-portal notification, new-lead email,
 * delivery flags, and threshold warnings. Shared by the automated ingest path
 * and the admin force-assign route so both behave identically.
 */
export async function completeAssignment(
  supabase: ReturnType<typeof createAdminClient>,
  lead: Lead,
  customerId: string,
  assignmentId: string
): Promise<void> {
  const { data: customer } = await supabase
    .from("customers")
    .select("*")
    .eq("id", customerId)
    .single();

  const typedCustomer = customer as Customer | null;
  if (!typedCustomer) return;

  // In-portal notification (feeds the realtime subscription).
  const city = extractCity(lead.address);
  const { data: notification } = await supabase
    .from("notifications")
    .insert({
      customer_id: customerId,
      lead_assignment_id: assignmentId,
      notification_type: "new_lead",
      message: `New lead: ${lead.lead_name}${city ? ` in ${city}` : ""}`,
    })
    .select("id")
    .single();

  const { error: emailError } = await sendNewLeadEmail({
    to: typedCustomer.email,
    lead,
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

  // Threshold emails apply only to the management allocation (which uses
  // leads_received_this_month / monthly_allocation). GR leads spend the GR
  // balance and must not trigger management credit warnings.
  if (lead.lead_type !== "guaranteed_rent") {
    // Post-increment count; the RPC already incremented.
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
}
