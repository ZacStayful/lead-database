import { createAdminClient } from "@/lib/supabase/admin";
import { sendNewLeadEmail, sendLowCreditsEmail } from "@/lib/emails";
import { maybeSendTopupOffer } from "@/lib/topup";
import { extractCity } from "@/lib/utils";
import { extractPostcode, postcodeArea } from "@/lib/postcode";
import { CRITICALLY_BEHIND_DEFICIT } from "@/lib/pacing";
import { sendNewLeadSms } from "@/lib/sms";
import { leadPriceFor } from "@/lib/plans";
import { incomeReportPatch, resolveIncomeReport } from "@/lib/incomeReport";
import { syncStoredReport } from "@/lib/incomeReportStorage";
import {
  DEFAULT_MAX_ASSIGNMENTS,
  CONTENDED_FILTERED_CUSTOMERS,
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
 *   1. If the lead is CONTENDED — CONTENDED_FILTERED_CUSTOMERS or more filtered
 *      candidates matched it — every slot goes to a filtered customer and the
 *      floor override is suppressed.
 *   2. Otherwise, if the top unfiltered candidate is at/beyond the
 *      critically-behind threshold, give the slot to them (floor override).
 *   3. Otherwise give it to the top filtered candidate.
 *   4. If no filtered candidate remains, fall back to unfiltered order.
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

  // Measured on the pool as fetched, not on what is left mid-loop: the question
  // is how many filtered customers wanted THIS lead, and shifting entries off
  // the front as slots fill would answer a different one and let the override
  // back in halfway through.
  const contended = filtered.length >= CONTENDED_FILTERED_CUSTOMERS;

  while (result.length < max && (f.length > 0 || u.length > 0)) {
    const topUnfiltered = u[0];
    const topFiltered = f[0];

    // Postgres numeric is serialised as a string by PostgREST, so coerce.
    if (
      !contended &&
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

  const leadType = leadTypeOf(payload);

  // Same LANDLORD, different Monday item.
  //
  // The check above is idempotency on monday_item_id, which stops the same item
  // being ingested twice. It has never stopped one landlord arriving as several
  // items, and that is the bigger problem in practice: 31 duplicate groups in
  // production, one landlord ingested six times, and another sold to four
  // customers across two identical copies — two of whom wrote notes saying they
  // had already contacted him.
  //
  // Matching needs all three of name, email and phone, and the key is null if
  // any is missing (0070). The asymmetry is deliberate: under-matching costs a
  // duplicate lead, over-matching silently discards a real enquiry a customer
  // would have been sold. Only the first is recoverable.
  //
  // Reported as a duplicate rather than an error — this is the ordinary,
  // expected outcome for a re-submitted enquiry, and the caller (webhook or
  // sync) already treats "duplicate" as success.
  const { data: duplicateOf, error: dupErr } = await supabase.rpc(
    "find_duplicate_lead",
    {
      p_name: payload.lead_name != null ? String(payload.lead_name) : "",
      p_email: String(payload.email ?? payload.text_mkztseha ?? ""),
      p_phone: String(payload.phone ?? payload.text_mkztq5xb ?? ""),
      p_lead_type: leadType,
    }
  );

  if (dupErr) {
    // Fail OPEN. A failed duplicate check must not drop a real lead — the worst
    // case is one redundant copy, which the report surfaces for cleanup, and
    // that is far better than silently losing an enquiry.
    console.error("find_duplicate_lead check failed", dupErr);
  } else if (duplicateOf) {
    return {
      status: "duplicate",
      lead_id: duplicateOf as string,
      assignments_made: 0,
    };
  }

  // Insert the lead, mapping fields per product type.
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

  await attachIncomeProjection(supabase, typedLead, payload);

  const assignmentsMade = await autoAssignLead(supabase, typedLead);

  return {
    status: "created",
    lead_id: typedLead.id,
    assignments_made: assignmentsMade,
  };
}

/**
 * Read the Stayful analysis PDF for a freshly created lead and stamp its gross
 * income figure (0089).
 *
 * CREATED LEADS ONLY, and management only. ingestLead deliberately never
 * updates an existing row, and that stays true — /api/cron/parse-income-reports
 * is what refreshes leads already in the database, and it is also what picks up
 * anything this skips. Guaranteed Rent has no analysis file on its board, and a
 * 15% management fee is not what a GR operator earns anyway.
 *
 * IT CANNOT FAIL INGEST. Every failure is swallowed and the row is left at
 * `pending` for the sweep. Doing this before autoAssignLead is deliberate — the
 * figure should be there when the delivery email lands — but that puts a
 * network call in front of the money path, so resolveIncomeReport's timeout is
 * load-bearing and the try/catch is a second stop. A landlord nobody rings
 * because ingest threw is a far worse outcome than a lead whose income figure
 * arrives at noon.
 */
async function attachIncomeProjection(
  supabase: ReturnType<typeof createAdminClient>,
  lead: Lead,
  payload: N8nLeadPayload
): Promise<void> {
  if (lead.lead_type !== "management") return;

  const url = payload.income_report_url;
  const assetId = payload.income_report_asset_id;
  // No report on the payload is not the same as no report on the item: the n8n
  // webhook does not send one at all. Leave it pending and let the sweep look.
  if (typeof url !== "string" || !url) return;

  try {
    const outcome = await resolveIncomeReport({
      id: typeof assetId === "string" ? assetId : "",
      public_url: url,
    });
    // The stored PDF and the figures land in ONE write, so a lead can never
    // show a figure with no report behind it or the other way round. A created
    // lead has nothing stored yet, hence currentPath: null.
    const stored = await syncStoredReport({
      admin: supabase,
      leadId: lead.id,
      outcome,
      currentPath: null,
    });
    const { error } = await supabase
      .from("leads")
      .update({ ...incomeReportPatch(outcome), ...stored })
      .eq("id", lead.id);
    if (error) {
      console.error("Income report write failed", lead.id, error);
      return;
    }
    // Keep the in-memory row honest for anything downstream in this request.
    lead.gross_annual_income = outcome.grossAnnualIncome;
    lead.avg_nightly_rate = outcome.avgNightlyRate;
    lead.occupancy_rate = outcome.occupancyRate;
    lead.income_report_status = outcome.status;
  } catch (err) {
    console.error("Income report parse failed", lead.id, err);
  }
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
  // A customer-owned lead belongs to the person who added it and is never
  // routed to anyone. The database enforces this too (0102 —
  // lead_retired_from_allocation, asserted inside assign_lead_to_customer), and
  // such a lead is seeded full at 1/1 so the shortfall below is already zero.
  // Stated explicitly all the same: the contention branch further down can
  // RAISE max_assignments, so "it has no free slots" is a fact about today's
  // code rather than a guarantee.
  if (lead.owner_customer_id) return 0;

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
    // Fail OPEN, on the deployment-order argument rather than the safety one.
    //
    // The instinct here is to fail closed — better to delay a placement than to
    // sell a landlord who has already declined. That is wrong, because of WHEN
    // this call fails. The realistic failure is that the code is deployed before
    // migration 0067 is applied, in which case the function does not exist, this
    // errors for every lead, and failing closed would halt ALL lead assignment
    // across the platform until somebody noticed.
    //
    // And in exactly that scenario there is nothing to protect: if 0067 has not
    // been applied, no lead has ever been closed, so the check has nothing to
    // find. A transient error is the only other case, and it costs one lead one
    // sync cycle.
    console.error("lead_is_closed check failed; proceeding", closedErr);
  } else if (isClosed) {
    return 0;
  }

  const leadType = lead.lead_type;

  // Ask for enough candidates to SEE contention, not merely enough to fill the
  // slots we currently have. A lead with three open slots and five filtered
  // customers wanting it is contended, and asking for three would hide that.
  const probe = Math.max(remaining, CONTENDED_FILTERED_CUSTOMERS);
  const [filteredRes, unfilteredRes] = await Promise.all([
    supabase.rpc("get_filtered_candidates_for_lead", {
      p_lead_id: lead.id,
      p_max: probe,
      p_lead_type: leadType,
    }),
    supabase.rpc("get_unfiltered_candidates_for_lead", {
      p_lead_id: lead.id,
      p_max: probe,
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

  // A contended lead opens its fourth slot NOW rather than after ten days of
  // nobody working it. Escalation raises the cap for a lead going to waste
  // (§18); this raises it for the opposite reason — provable, matching demand
  // already queued — and stops at 4, the same first rung, so a lead can still
  // reach 5 by escalating afterwards but never overshoots by both routes at
  // once. Only ever raises: a lead an admin has already lifted is left alone.
  let slots = remaining;
  if (filtered.length >= CONTENDED_FILTERED_CUSTOMERS) {
    const cap = lead.max_assignments ?? DEFAULT_MAX_ASSIGNMENTS;
    if (cap < CONTENDED_FILTERED_CUSTOMERS) {
      const { error: capErr } = await supabase
        .from("leads")
        .update({ max_assignments: CONTENDED_FILTERED_CUSTOMERS })
        .eq("id", lead.id)
        .lt("max_assignments", CONTENDED_FILTERED_CUSTOMERS);
      if (capErr) {
        // Not fatal: assign into the slots we already have and let the next
        // sweep raise the cap. Losing a slot is better than losing the lead.
        console.error("contended cap raise failed; using existing slots", capErr);
      } else {
        slots = CONTENDED_FILTERED_CUSTOMERS - (lead.assignment_count ?? 0);
      }
    }
  }

  const customerIds = selectCombinedCandidates(filtered, unfiltered, slots);

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
