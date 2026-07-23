import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendProgressReportEmail } from "@/lib/emails";
import type { Customer } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Rolling window for "this week".
const WINDOW_DAYS = 7;
// Early-funnel-forward statuses we celebrate. Only 'contacted' and 'won' are
// ever set by customer action today (the assignments PATCH, which stamps
// last_status_change_at); 'in_discussion' is a legal status with no in-app
// write path, so it reads 0 in practice but is included for completeness.
const PROGRESS_STATUSES = ["contacted", "in_discussion", "won"];

type ReportCustomer = Pick<
  Customer,
  "id" | "email" | "contact_name" | "notification_preferences"
>;

/** Missing / unset key defaults to true — opt-out is only an explicit false. */
function wantsProgressReport(customer: ReportCustomer): boolean {
  return customer.notification_preferences?.progress_report !== false;
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

  const { data: customerRows, error: custErr } = await admin
    .from("customers")
    .select("id, email, contact_name, notification_preferences")
    .eq("is_active", true);

  if (custErr) {
    return NextResponse.json({ error: custErr.message }, { status: 500 });
  }

  const sinceIso = new Date(
    Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();

  let sent = 0;
  let noActivity = 0;
  let optedOut = 0;

  for (const customer of (customerRows ?? []) as ReportCustomer[]) {
    if (!wantsProgressReport(customer)) {
      optedOut += 1;
      continue;
    }

    const { data: rows, error: aErr } = await admin
      .from("lead_assignments")
      .select("status")
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
    for (const row of (rows ?? []) as { status: string }[]) {
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

    sent += 1;
  }

  return NextResponse.json({
    status: "ok",
    sent,
    skipped: { no_activity: noActivity, opted_out: optedOut },
  });
}

export async function GET(request: NextRequest) {
  return handle(request);
}

export async function POST(request: NextRequest) {
  return handle(request);
}
