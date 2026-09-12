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
  type DigestExtras,
} from "@/lib/contact/followUpSummary";
import { fetchDueAttempts } from "@/lib/contact/dueAttempts";
import {
  RELEASE_SETTING_KEYS,
  londonDate,
  releaseSchedule,
  releaseSettingsFrom,
} from "@/lib/pacing";
import { nextLeadLine } from "@/lib/todaySummary";
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

  // ⚠️ AND A FAILED READ IS NOT A SWITCHED-OFF FEATURE. Falling through would
  // answer 200 with "contact_plans_disabled" — a cause that is not the cause,
  // on a job whose entire output is an email that simply never arrives. §18's
  // escalation cron lost a day of both snapshot series to exactly that
  // sentence on 2026-09-12. A 500 marks the run failed instead.
  if (settings.readFailed) {
    console.error("[contact-followups] run aborted — system_settings unreadable");
    return NextResponse.json(
      { ok: false, error: "settings_read_failed" },
      { status: 500 }
    );
  }

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

  // ⚠️ NEWLY ASSIGNED LEADS ONLY, FROM THE CUTOFF FORWARD — and the scan
  // itself lives in src/lib/contact/dueAttempts.ts, shared with the dashboard
  // Today panel so the two cannot disagree about what is due. It fails CLOSED
  // on an unreadable cutoff: nobody is prompted rather than everybody.
  const scan = await fetchDueAttempts(admin);
  if (!scan.cutoff) {
    return NextResponse.json({ ok: true, skipped: "no_notify_cutoff" });
  }
  if (scan.error) {
    console.error("[contact-followups] scan failed", scan.error);
    return NextResponse.json({ ok: false, error: "scan_failed" }, { status: 500 });
  }
  const byCustomer = scan.byCustomer;

  // §54 — what arrived since yesterday's email, and where each customer sits
  // on the daily release. One query for everybody; a lead assigned this
  // morning by the 07:30 release is the reason the email says "your lead for
  // today is in" rather than the customer finding out by accident.
  const dayAgoIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const [releaseSettingRows, recentAssignments] = await Promise.all([
    admin
      .from("system_settings")
      .select("key, value")
      .in("key", [...RELEASE_SETTING_KEYS]),
    admin
      .from("lead_assignments")
      .select("customer_id, assigned_at, lead:leads!inner(lead_type, owner_customer_id)")
      .gte("assigned_at", dayAgoIso),
  ]);
  const releaseSettings = releaseSettingsFrom(
    (releaseSettingRows.data ?? []) as { key: string; value: string }[]
  );
  const todayLondon = londonDate(new Date());
  const newSinceYesterday = new Map<string, number>();
  const todayCounts = new Map<string, number>();
  for (const row of (recentAssignments.data ?? []) as unknown as {
    customer_id: string;
    assigned_at: string;
    lead: { lead_type: string; owner_customer_id: string | null } | null;
  }[]) {
    if (row.lead?.owner_customer_id) continue; // their own upload is not a delivery
    newSinceYesterday.set(row.customer_id, (newSinceYesterday.get(row.customer_id) ?? 0) + 1);
    if (londonDate(new Date(row.assigned_at)) === todayLondon) {
      const key = `${row.customer_id}:${row.lead?.lead_type ?? "management"}`;
      todayCounts.set(key, (todayCounts.get(key) ?? 0) + 1);
    }
  }

  // Adherence for the weekly notice, read once for everybody.
  const adherence = await fetchAdherence(admin);
  const adherenceBy = new Map(adherence.rows.map((r) => [r.customer_id, r]));

  const ids = Array.from(byCustomer.keys());
  const noticeIds = adherence.rows.map((r) => r.customer_id);
  const newLeadIds = Array.from(newSinceYesterday.keys());
  const allIds = Array.from(new Set([...ids, ...noticeIds, ...newLeadIds]));
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

    // §54. The next-lead line goes in the BODY, never the subject, and is
    // never on its own a reason to send (worthSending ignores it).
    const extras: DigestExtras = {
      newLeadsToday: newSinceYesterday.get(c.id) ?? 0,
      nextLead: releaseSettings.enabled
        ? nextLeadLine(
            releaseSchedule(
              c,
              c.subscription_status === "active" ? "management" : "guaranteed_rent",
              todayCounts.get(
                `${c.id}:${c.subscription_status === "active" ? "management" : "guaranteed_rent"}`
              ) ?? 0,
              releaseSettings
            ),
            todayLondon
          )
        : null,
    };

    if (!worthSending(summary, extras) && !notify) {
      stats.skippedNoWork += 1;
      continue;
    }
    stats.customers += 1;

    if (dryRun) {
      preview.push({
        customer: c.business_name,
        new_leads: extras.newLeadsToday,
        next_lead: extras.nextLead,
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

    if (worthSending(summary, extras)) {
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
        subject: summarySubject(summary, extras),
        total: summary.total,
        channels: describeChannels(summary),
        minutes: summary.minutes,
        overdue: summary.overdue,
        leads: named,
        url: LIST_URL,
        newLeadsToday: extras.newLeadsToday,
        nextLead: extras.nextLead,
      });
      if (!mailErr) stats.emails += 1;

      // A SEPARATE stream with its own toggle, exactly as completeAssignment
      // treats the new-lead SMS. Only an explicit false opts out (§40.9A).
      if (c.sms_alerts_enabled !== false && c.phone) {
        const sms = await sendSms(c.phone, summarySms(summary, LIST_URL, extras));
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
