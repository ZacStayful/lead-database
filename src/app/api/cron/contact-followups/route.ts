/**
 * Today's follow-up prompt, and the falling-behind notice (§42).
 *
 * The half of the contact plan that makes it exist for a customer. Without
 * this, the timeline is a page nobody is told to open — which is exactly what
 * happened between shipping §42 and this route: 357 plans, and nothing anywhere
 * asking a single operator to work one.
 *
 * Two things, one job, because they read the same adherence figures and
 * splitting them would mean two crons disagreeing about who is behind.
 *
 *   1. THE DAILY SUMMARY — what is due today, by channel, and how long it takes.
 *      Email plus SMS. Nothing at all on a day with nothing due.
 *   2. THE WEEKLY NOTICE — sent only to somebody genuinely neglecting the work,
 *      at most once a week, and never on the same day as nothing being due.
 */

import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { isAdminUser } from "@/lib/auth";
import { sendDailyFollowUpsEmail, sendFollowUpAdherenceEmail } from "@/lib/emails";
import { sendSms } from "@/lib/sms";
import { fetchUkBankHolidays, isBankHoliday } from "@/lib/businessTime";
import { contactPlanSettings } from "@/lib/contact/contactPlan";
import { fetchAdherence, noticeLines, shouldNotify } from "@/lib/contact/adherence";
import {
  describeChannels,
  summariseDay,
  summarySms,
  summarySubject,
  worthSending,
  type DueAttempt,
} from "@/lib/contact/followUpSummary";
import {
  BOOKED_MEETING_RATE_PCT,
  channelLabel,
  type ContactChannel,
} from "@/lib/contact/contactStrategy";
import type { Customer, NotificationPreferences } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "https://leads.stayful.co.uk";
const LIST_URL = `${APP_URL}/dashboard/leads`;
/** Named in the email; more than this and the list stops being scannable. */
const MAX_LEADS_LISTED = 8;
/** Resend's documented limit is 2/second (§21.3). */
const SEND_GAP_MS = 600;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface AttemptRow {
  step_number: number;
  channel: string;
  send_after: string;
  message_sequence_runs: {
    customer_id: string;
    assignment_id: string;
    lead_id: string;
    lead_assignments: {
      assigned_at: string;
      lead: { lead_name: string | null } | null;
    } | null;
  } | null;
}

/**
 * Opt-out only — a missing key reads as true (§21.7). Local rather than shared
 * because ingest.ts already keeps its own copy of exactly this two-line rule
 * and a third module for it would be more indirection than the rule is worth.
 */
function wantsNotification(
  customer: Customer,
  key: keyof NotificationPreferences
): boolean {
  return customer.notification_preferences?.[key] !== false;
}

export async function GET(request: Request) {
  return run(request);
}
export async function POST(request: Request) {
  return run(request);
}

async function run(request: Request) {
  // The §2 cron auth pattern, verbatim. Boolean(cronSecret) fails closed when
  // the var is unset.
  const auth = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  const viaCron = Boolean(cronSecret) && auth === `Bearer ${cronSecret}`;
  if (!viaCron) {
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!isAdminUser(user)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  const dryRun = new URL(request.url).searchParams.get("dryRun") === "true";
  const admin = createAdminClient();

  // ⚠️ FAILS CLOSED on the switch, like everything else that puts a prompt in
  // front of a customer about approaching a member of the public.
  const settings = await contactPlanSettings(admin);
  if (!settings.enabled) {
    return NextResponse.json({ ok: true, skipped: "contact_plans_disabled" });
  }

  // Nobody is asked to ring a landlord on a bank holiday. Fail-open, as
  // inactivity-nudge does — an unreachable gov.uk must not stop the day's work.
  try {
    const holidays = await fetchUkBankHolidays();
    if (isBankHoliday(new Date(), holidays)) {
      return NextResponse.json({ ok: true, skipped: "bank_holiday" });
    }
  } catch {
    /* fail open */
  }

  // ⚠️ NEWLY ASSIGNED LEADS ONLY, FROM THE CUTOFF FORWARD.
  //
  // The backfill (2026-09-01) gave every lead in the book a plan so the
  // timeline reads the same everywhere. It must NOT follow that 342 landlords
  // who enquired months ago are now chased: the plan is there to be worked if
  // the operator chooses, and the daily prompt covers leads assigned from the
  // cutoff onward. Without this the first send would be a wall of 326 across
  // 23 customers, which is how a daily email gets filtered to trash on day one.
  //
  // Fails CLOSED: an unreadable cutoff prompts nobody rather than prompting
  // about everything.
  const { data: cutoffRow } = await admin
    .from("system_settings")
    .select("value")
    .eq("key", "contact_notify_from")
    .maybeSingle();
  const cutoff = (cutoffRow as { value: string } | null)?.value;
  if (!cutoff) {
    return NextResponse.json({ ok: true, skipped: "no_notify_cutoff" });
  }

  const { data: rows, error } = await admin
    .from("message_sequence_drafts")
    .select(
      "step_number, channel, send_after, " +
        "message_sequence_runs!inner(customer_id, assignment_id, lead_id, " +
        "lead_assignments!inner(assigned_at, lead:leads(lead_name)))"
    )
    .eq("state", "pending")
    .eq("message_sequence_runs.status", "active")
    .lte("send_after", new Date().toISOString())
    .gte("message_sequence_runs.lead_assignments.assigned_at", cutoff)
    .limit(2000);

  if (error) {
    console.error("[contact-followups] scan failed", error);
    return NextResponse.json({ ok: false, error: "scan_failed" }, { status: 500 });
  }

  const byCustomer = new Map<string, DueAttempt[]>();
  for (const r of (rows ?? []) as unknown as AttemptRow[]) {
    const run = r.message_sequence_runs;
    if (!run) continue;
    const assignedAt = run.lead_assignments?.assigned_at;
    if (!assignedAt) continue;
    const overdueDays = Math.max(
      0,
      Math.floor((Date.now() - new Date(r.send_after).getTime()) / 86_400_000)
    );
    const list = byCustomer.get(run.customer_id) ?? [];
    list.push({
      assignmentId: run.assignment_id,
      leadId: run.lead_id,
      leadName: run.lead_assignments?.lead?.lead_name ?? null,
      channel: r.channel as ContactChannel,
      stepNumber: r.step_number,
      overdueDays,
    });
    byCustomer.set(run.customer_id, list);
  }

  // Adherence for the weekly notice, read once for everybody.
  const adherence = await fetchAdherence(admin);
  const adherenceBy = new Map(adherence.rows.map((r) => [r.customer_id, r]));

  const ids = Array.from(byCustomer.keys());
  const noticeIds = adherence.rows.map((r) => r.customer_id);
  const allIds = Array.from(new Set([...ids, ...noticeIds]));
  if (allIds.length === 0) {
    return NextResponse.json({ ok: true, customers: 0, sent: 0 });
  }

  const { data: customerRows } = await admin
    .from("customers")
    .select("*")
    .in("id", allIds)
    .eq("is_active", true);

  const stats = {
    customers: 0,
    emails: 0,
    texts: 0,
    notices: 0,
    skippedNoWork: 0,
    optedOut: 0,
  };
  const preview: Record<string, unknown>[] = [];

  for (const c of ((customerRows ?? []) as Customer[])) {
    const attempts = byCustomer.get(c.id) ?? [];
    const summary = summariseDay(attempts);
    const adh = adherenceBy.get(c.id);
    const notify = adh ? shouldNotify(adh, settings) : false;

    if (!worthSending(summary) && !notify) {
      stats.skippedNoWork += 1;
      continue;
    }
    stats.customers += 1;

    if (dryRun) {
      preview.push({
        customer: c.business_name,
        due: summary.total,
        channels: describeChannels(summary),
        minutes: summary.minutes,
        overdue: summary.overdue,
        would_send_notice: notify,
      });
      continue;
    }

    // Opt-out, the §21.7 shape: a missing key reads as true.
    if (!wantsNotification(c, "contact_followups")) {
      stats.optedOut += 1;
      continue;
    }

    if (worthSending(summary)) {
      const named = attempts
        .slice()
        .sort((a, b) => b.overdueDays - a.overdueDays || a.stepNumber - b.stepNumber)
        .slice(0, MAX_LEADS_LISTED)
        .map((a) => ({
          name: a.leadName ?? "A landlord",
          what: `${channelLabel(a.channel)} · attempt ${a.stepNumber}${
            a.overdueDays > 0 ? ` · ${a.overdueDays}d overdue` : ""
          }`,
        }));

      const { error: mailErr } = await sendDailyFollowUpsEmail({
        to: c.email,
        contactName: c.contact_name ?? c.business_name ?? "there",
        subject: summarySubject(summary),
        total: summary.total,
        channels: describeChannels(summary),
        minutes: summary.minutes,
        overdue: summary.overdue,
        leads: named,
        url: LIST_URL,
      });
      if (!mailErr) stats.emails += 1;

      // A SEPARATE stream with its own toggle, exactly as completeAssignment
      // treats the new-lead SMS. Only an explicit false opts out (§40.9A).
      if (c.sms_alerts_enabled !== false && c.phone) {
        const sms = await sendSms(c.phone, summarySms(summary, LIST_URL));
        if (sms.ok) stats.texts += 1;
      }
      await sleep(SEND_GAP_MS);
    }

    if (notify && adh) {
      const { error: noticeErr } = await sendFollowUpAdherenceEmail({
        to: c.email,
        contactName: c.contact_name ?? c.business_name ?? "there",
        lines: noticeLines(adh, BOOKED_MEETING_RATE_PCT),
        url: LIST_URL,
      });
      if (!noticeErr) stats.notices += 1;
      await sleep(SEND_GAP_MS);
    }
  }

  return NextResponse.json({ ok: true, dryRun, ...stats, preview: dryRun ? preview : undefined });
}
