import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendProgressReportEmail } from "@/lib/emails";
import type { Customer, LeadType } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Rolling window for "this week".
const WINDOW_DAYS = 7;
// Weekly idempotency: don't re-send within this many days of the last send, so a
// manual re-run mid-week is a no-op while the next Friday (7 days on) still fires.
const REPORT_DEDUP_DAYS = 6;
// Early-funnel-forward statuses we celebrate. Only 'contacted' and 'won' are
// ever set by customer action today (the assignments PATCH, which stamps
// last_status_change_at); 'in_discussion' is a legal status with no in-app
// write path, so it reads 0 in practice but is included for completeness.
const PROGRESS_STATUSES = ["contacted", "in_discussion", "won"];

type ReportCustomer = Pick<
  Customer,
  | "id"
  | "email"
  | "contact_name"
  | "notification_preferences"
  | "last_report_sent_at"
  | "account_status"
  | "subscription_status"
  | "gr_subscription_status"
>;

/** Missing / unset key defaults to true — opt-out is only an explicit false. */
function wantsProgressReport(customer: ReportCustomer): boolean {
  return customer.notification_preferences?.progress_report !== false;
}

/**
 * Whether this customer is live on the product a given lead belongs to.
 *
 * Mirrors the inactivity-nudge cron: eligibility is decided per product, because
 * account_status and subscription_status describe the MANAGEMENT subscription
 * only (CLAUDE.md invariant 6). Requiring them, as this route used to, excluded
 * every Guaranteed-Rent-only customer outright — they never received a weekly
 * report about work they had genuinely done.
 *
 * The management branch deliberately carries no paused_at check, unlike the
 * nudge: this route has never excluded paused customers, and a report is a
 * summary of work already done rather than a prompt to do more, so pausing lead
 * delivery is no reason to withhold it.
 */
function eligibleFor(customer: ReportCustomer, leadType: LeadType): boolean {
  if (leadType === "guaranteed_rent") {
    return customer.gr_subscription_status === "active";
  }
  return (
    customer.account_status === "active" &&
    customer.subscription_status === "active"
  );
}

type RawLead = { lead_type: LeadType | null };
type RawRow = {
  status: string;
  // supabase-js infers an embedded to-one as an array; PostgREST returns a
  // single object at runtime. Accept both and normalise with oneLead().
  leads: RawLead | RawLead[] | null;
};

function oneLead(leads: RawLead | RawLead[] | null): RawLead | null {
  if (!leads) return null;
  return Array.isArray(leads) ? (leads[0] ?? null) : leads;
}

/**
 * Friday progress-report cron. Auth: CRON_SECRET bearer only.
 *
 * For each active, opted-in customer, count the leads whose status last changed
 * (last_status_change_at, 0035) into contacted / in_discussion / won within the
 * last 7 days, and email a positive weekly summary. Customers with no activity
 * in the window are skipped (no empty reports). Email-only — the progress report
 * has no in-portal notification stream.
 *
 * Accuracy: 'contacted' and 'won' counts are accurate — last_status_change_at is
 * stamped on those exact transitions. 'in_discussion' is not produced by any
 * customer action today, so it is effectively always 0. Pre-existing rows were
 * backfilled to their first-contact time by migration 0035, so for roughly the
 * first weekly window after deploy a lead's timestamp reflects its first contact
 * rather than a later transition; every transition made after deploy is exact.
 */
async function handle(request: NextRequest) {
  const auth = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || auth !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();

  // Target only customers who are actually live on the platform — the same
  // population that receives leads.
  //
  // The filter is the union: anyone live on EITHER product. Each assignment is
  // then matched against its own product's eligibility in eligibleFor() before
  // it can be counted, so a customer who cancelled Management but kept GR is
  // reported on their GR work and not their old management leads.
  const { data: customerRows, error: custErr } = await admin
    .from("customers")
    .select(
      "id, email, contact_name, notification_preferences, last_report_sent_at, account_status, subscription_status, gr_subscription_status"
    )
    .eq("is_active", true)
    .or("subscription_status.eq.active,gr_subscription_status.eq.active");

  if (custErr) {
    return NextResponse.json({ error: custErr.message }, { status: 500 });
  }

  const nowMs = Date.now();
  const sinceIso = new Date(
    nowMs - WINDOW_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();
  const dedupMs = REPORT_DEDUP_DAYS * 24 * 60 * 60 * 1000;

  let sent = 0;
  let noActivity = 0;
  let optedOut = 0;
  let alreadySent = 0;

  for (const customer of (customerRows ?? []) as ReportCustomer[]) {
    if (!wantsProgressReport(customer)) {
      optedOut += 1;
      continue;
    }

    // Weekly idempotency: skip anyone already sent a report within the dedup
    // window, so a manual re-run mid-week does not double-send. Parsed via Date
    // (numeric compare) to avoid ISO string-format mismatches.
    if (
      customer.last_report_sent_at &&
      nowMs - new Date(customer.last_report_sent_at).getTime() < dedupMs
    ) {
      alreadySent += 1;
      continue;
    }

    const { data: rows, error: aErr } = await admin
      .from("lead_assignments")
      .select("status, leads(lead_type)")
      .eq("customer_id", customer.id)
      .in("status", PROGRESS_STATUSES)
      .gte("last_status_change_at", sinceIso);

    if (aErr) {
      console.error("[progress-report] assignment query failed", {
        customer: customer.id,
        error: aErr.message,
      });
      continue;
    }

    let contacted = 0;
    let inDiscussion = 0;
    let won = 0;
    for (const row of (rows ?? []) as unknown as RawRow[]) {
      // Count only work on a product this customer is still live on.
      const leadType = oneLead(row.leads)?.lead_type ?? "management";
      if (!eligibleFor(customer, leadType)) continue;
      if (row.status === "contacted") contacted += 1;
      else if (row.status === "in_discussion") inDiscussion += 1;
      else if (row.status === "won") won += 1;
    }

    if (contacted + inDiscussion + won === 0) {
      noActivity += 1;
      continue;
    }

    const { error: emailError } = await sendProgressReportEmail({
      to: customer.email,
      contactName: customer.contact_name,
      contacted,
      inDiscussion,
      won,
    });
    if (emailError) {
      console.error("[progress-report] email failed", {
        customer: customer.id,
        error: emailError,
      });
    }

    // Stamp the send so a same-week re-run skips this customer.
    await admin
      .from("customers")
      .update({ last_report_sent_at: new Date(nowMs).toISOString() })
      .eq("id", customer.id);

    sent += 1;
  }

  return NextResponse.json({
    status: "ok",
    sent,
    skipped: {
      no_activity: noActivity,
      opted_out: optedOut,
      already_sent: alreadySent,
    },
  });
}

export async function GET(request: NextRequest) {
  return handle(request);
}

export async function POST(request: NextRequest) {
  return handle(request);
}
