import { createAdminClient } from "@/lib/supabase/admin";
import { sendNewLeadEmail, sendLowCreditsEmail } from "@/lib/emails";
import { maybeSendTopupOffer } from "@/lib/topup";
import { extractCity } from "@/lib/utils";
import { extractPostcode, postcodeArea } from "@/lib/postcode";
import { CRITICALLY_BEHIND_DEFICIT } from "@/lib/pacing";
import { sendNewLeadSms } from "@/lib/sms";
import { leadPriceFor } from "@/lib/plans";
import {
  DEFAULT_MAX_ASSIGNMENTS,
  type Customer,
  type Lead,
  type LeadType,
  type N8nLeadPayload,
  type NotificationPreferences,
} from "@/lib/types";

// Warn when the customer has this many lead credits left (the real allocation
// gate is lead_balance, not the monthly counter, and this is plan-agnostic).
const LOW_CREDITS_REMAINING = 2;

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

/**
 * Whether a customer wants a given notification stream.
 *
 * Missing / unset keys default to TRUE — an opt-out is only an explicit
 * `false`. The 0034 migration backfills notification_preferences NOT NULL with
 * every key true, so in practice the object is always fully populated; this
 * `!== false` check is the defensive fallback for a row that somehow lacks a
 * key (or the whole column), so an existing customer never silently goes dark.
 */
function wantsNotification(
  customer: Customer,
  key: keyof NotificationPreferences
): boolean {
  return customer.notification_preferences?.[key] !== false;
}

/**
 * Attach the extracted postcode / postcode_area (from the lead's address) to an
 * insert row. Both are NULL when no postcode can be parsed — such a lead stays
 * available to the unfiltered pool but is invisible to filtered customers.
 */
function withPostcode(row: Record<string, unknown>): Record<string, unknown> {
  const postcode = extractPostcode(
    typeof row.address === "string" ? row.address : null
  );
  row.postcode = postcode;
  row.postcode_area = postcodeArea(postcode);
  return row;
}

/** Build the leads insert row for a management lead. */
function buildManagementInsert(payload: N8nLeadPayload): Record<string, unknown> {
  const row: Record<string, unknown> = { lead_type: "management" };
  for (const field of LEAD_FIELDS) {
    row[field] = payload[field] != null ? String(payload[field]) : "";
  }
  return withPostcode(row);
}

/** GR target columns that are DATE-typed in the DB and must be ISO or null. */
const GR_DATE_TARGETS = new Set(["last_contact"]);

/** Return an ISO (YYYY-MM-DD) date string or null — never an invalid date. */
function toIsoDateOrNull(raw: unknown): string | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
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
    if (GR_DATE_TARGETS.has(target)) {
      // DATE columns reject non-ISO strings, which would fail the whole insert
      // and drop the lead. Coerce anything non-ISO to null instead.
      row[target] = toIsoDateOrNull(raw);
    } else {
      row[target] = raw != null && raw !== "" ? String(raw) : null;
    }
  }
  return withPostcode(row);
}

/**
 * Combine the filtered and unfiltered candidate pools into a final ordered list
 * of customer ids, one per open slot (up to p_max), applying the guarantee-floor
 * override. Both input pools are already ranked best-first (filtered by
 * priority_score desc, unfiltered by deficit desc).
 *
 * Per slot:
 *   1. If the top unfiltered candidate is at/beyond the critically-behind
 *      threshold, give the slot to them (floor override).
 *   2. Otherwise give it to the top filtered candidate.
 *   3. If no filtered candidate remains, fall back to unfiltered order.
 * A customer belongs to exactly one pool (filter is off or active/pending), so
 * consuming from the front of each list keeps assignments unique.
 */
export function selectCombinedCandidates(
  filtered: { customer_id: string; priority_score: number }[],
  unfiltered: { customer_id: string; deficit: number }[],
  max: number
): string[] {
  const f = [...filtered];
  const u = [...unfiltered];
  const result: string[] = [];

  while (result.length < max && (f.length > 0 || u.length > 0)) {
    const topUnfiltered = u[0];
    const topFiltered = f[0];

    // Postgres numeric is serialised as a string by PostgREST, so coerce.
    if (
      topUnfiltered &&
      Number(topUnfiltered.deficit) >= CRITICALLY_BEHIND_DEFICIT
    ) {
      result.push(topUnfiltered.customer_id);
      u.shift();
    } else if (topFiltered) {
      result.push(topFiltered.customer_id);
      f.shift();
    } else if (topUnfiltered) {
      result.push(topUnfiltered.customer_id);
      u.shift();
    } else {
      break;
    }
  }

  return result;
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

  // Idempotency: skip re-inserting an already-ingested Monday item, but still
  // TOP UP its assignments. A lead that ingested when no customer had capacity
  // (or filled only some of its slots) would otherwise stay stranded at e.g.
  // 0/2 or 1/2 forever, because every later sync treats it as a plain
  // duplicate. Re-running assignment here lets each sync clear that backlog.
  const { data: existing } = await supabase
    .from("leads")
    .select("*")
    .eq("monday_item_id", String(payload.monday_item_id))
    .maybeSingle();

  if (existing) {
    const existingLead = existing as Lead;
    const assignmentsMade = await autoAssignLead(supabase, existingLead);
    return {
      status: "duplicate",
      lead_id: existingLead.id,
      assignments_made: assignmentsMade,
    };
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

  const assignmentsMade = await autoAssignLead(supabase, typedLead);

  return {
    status: "created",
    lead_id: typedLead.id,
    assignments_made: assignmentsMade,
  };
}

/**
 * Fill a lead's remaining assignment slots with the next eligible customers,
 * using the same two-pool selection as fresh ingest (filtered by lead match +
 * unfiltered deficit-first, with the guarantee-floor override). Requests only
 * the shortfall (max_assignments − assignment_count); the candidate queries
 * already exclude customers already on the lead and the assignment RPC caps at
 * capacity, so this is safe to call repeatedly and on partly-assigned leads.
 *
 * Returns the number of NEW assignments made. This is the single "assign as
 * many as we can right now" path shared by fresh ingest, the duplicate top-up,
 * and the admin assign-pending sweep.
 */
export async function autoAssignLead(
  supabase: ReturnType<typeof createAdminClient>,
  lead: Lead
): Promise<number> {
  const remaining =
    (lead.max_assignments ?? DEFAULT_MAX_ASSIGNMENTS) - (lead.assignment_count ?? 0);
  if (remaining <= 0) return 0;

  // A landlord an operator has reported as done — not interested, or already
  // sorted with somebody else — is not offered to anyone new.
  //
  // This check belongs here rather than only in the escalation job because THIS
  // is the path that would undo it: the duplicate branch below runs on every
  // daily Monday sync and tops up any lead sitting under its cap, so without
  // this a closed lead would be re-sold within 24 hours by the ordinary sweep.
  // Operators already holding it keep it — one report does not cancel another
  // operator's live conversation — but the lead stops being distributed.
  const { data: isClosed, error: closedErr } = await supabase.rpc(
    "lead_is_closed",
    { p_lead_id: lead.id }
  );
  if (closedErr) {
    // Fail closed. Selling a landlord who has already declined is worse than
    // delaying a placement by a day, and the next sync retries anyway.
    console.error("lead_is_closed check failed", closedErr);
    return 0;
  }
  if (isClosed) return 0;

  const leadType = lead.lead_type;
  const [filteredRes, unfilteredRes] = await Promise.all([
    supabase.rpc("get_filtered_candidates_for_lead", {
      p_lead_id: lead.id,
      p_max: remaining,
      p_lead_type: leadType,
    }),
    supabase.rpc("get_unfiltered_candidates_for_lead", {
      p_lead_id: lead.id,
      p_max: remaining,
      p_lead_type: leadType,
    }),
  ]);

  if (filteredRes.error || unfilteredRes.error) {
    console.error(
      "candidate selection failed",
      filteredRes.error ?? unfilteredRes.error
    );
    return 0;
  }

  const filtered = (filteredRes.data ?? []) as {
    customer_id: string;
    priority_score: number;
  }[];
  const unfiltered = (unfilteredRes.data ?? []) as {
    customer_id: string;
    deficit: number;
  }[];

  const customerIds = selectCombinedCandidates(filtered, unfiltered, remaining);

  const price = leadPriceFor(leadType);

  let assignmentsMade = 0;
  for (const customerId of customerIds) {
    const { data: assignmentId, error: assignError } = await supabase.rpc(
      "assign_lead_to_customer",
      {
        p_lead_id: lead.id,
        p_customer_id: customerId,
        p_price: price,
        p_lead_type: leadType,
      }
    );

    if (assignError || !assignmentId) continue;
    assignmentsMade += 1;

    await completeAssignment(supabase, lead, customerId, assignmentId);
  }

  return assignmentsMade;
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
  assignmentId: string,
  // Admin overrides don't spend a credit when the customer is already at zero,
  // so the low/exhausted-credit warnings would misfire (and spam) — skip them.
  sendThresholdWarnings = true
): Promise<void> {
  const { data: customer } = await supabase
    .from("customers")
    .select("*")
    .eq("id", customerId)
    .single();

  const typedCustomer = customer as Customer | null;
  if (!typedCustomer) return;

  // New-lead alerts (in-portal notification + Resend email) are gated together
  // on the `new_lead` preference. The instant SMS below is a SEPARATE stream
  // with its own toggle (sms_alerts_enabled) and is intentionally independent.
  const wantsNewLead = wantsNotification(typedCustomer, "new_lead");

  let notificationId: string | null = null;
  let emailError: unknown = null;

  if (wantsNewLead) {
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
    notificationId = notification?.id ?? null;

    const emailRes = await sendNewLeadEmail({
      to: typedCustomer.email,
      lead,
    });
    emailError = emailRes.error;
  }

  // Instant SMS alert — wins the speed race to the landlord. Inert unless a
  // Twilio sender is configured; never allowed to break the assignment. Its own
  // opt-out (sms_alerts_enabled) is enforced inside sendNewLeadSms.
  const sms = await sendNewLeadSms({ customer: typedCustomer, lead });
  if (sms.error) {
    console.error("sendNewLeadSms failed", { assignmentId, error: sms.error });
  }

  // Reflect what actually happened: if the customer opted out of new_lead,
  // nothing was sent, so both flags stay false.
  await supabase
    .from("lead_assignments")
    .update({
      notification_sent: wantsNewLead,
      email_sent: wantsNewLead && !emailError,
    })
    .eq("id", assignmentId);

  if (notificationId) {
    await supabase
      .from("notifications")
      .update({ email_sent: !emailError })
      .eq("id", notificationId);
  }

  // Credit-threshold follow-through. Balances are read post-decrement (the
  // assignment RPC already spent the credit), keyed on the real allocation gate
  // (lead_balance / gr_lead_balance) so it works for any plan size. Branch
  // strictly on lead_type — a product's logic must never read or write the
  // other product's columns.
  //
  // At zero balance BOTH products now offer a one-off paid top-up (email + SMS +
  // single-use link); the offer is deduplicated by the live token, so the
  // exact-equality on balance (=== 0) simply gates when it fires. The low-credits
  // warning stays Management-only (GR has no low-credits stream). Email opt-in
  // (credit_warnings) and SMS opt-in (sms_alerts_enabled) are enforced inside
  // maybeSendTopupOffer / sendLowCreditsEmail.
  if (sendThresholdWarnings) {
    if (lead.lead_type === "guaranteed_rent") {
      await maybeSendTopupOffer(supabase, typedCustomer, "guaranteed_rent");
    } else {
      const balance = typedCustomer.lead_balance;
      if (balance === 0) {
        await maybeSendTopupOffer(supabase, typedCustomer, "management");
      } else if (
        balance === LOW_CREDITS_REMAINING &&
        wantsNotification(typedCustomer, "credit_warnings")
      ) {
        await sendLowCreditsEmail({
          to: typedCustomer.email,
          remaining: balance,
        });
      }
    }
  }
}
