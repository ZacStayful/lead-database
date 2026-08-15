import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { isAdminUser } from "@/lib/auth";
import { sendMonthlyInsightsEmail } from "@/lib/emails";
import { sendSms } from "@/lib/sms";
import { APP_URL } from "@/lib/env";
import {
  composeInsight,
  selectFocus,
  alreadySentThisMonth,
  wantsInsights,
  type CustomerInsight,
  type CohortFigures,
} from "@/lib/monthlyInsights";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Monthly lead summary — the Leaderboard, sent to each management subscriber.
 *
 * One email with their own four figures beside the two cohorts, plus ONE thing
 * to do next chosen from their own numbers. A short SMS points at the inbox and
 * carries no comparative figure: a stat by text lands very differently from the
 * same stat in an email somebody chose to open.
 *
 * WHAT THIS IS NOT
 * ----------------
 * It is not a performance warning, and nothing it sends says "you are behind".
 * The figures are shown and the reader can draw their own conclusion; the copy
 * only ever names the next step. The reasoning is in lib/monthlyInsights.ts and
 * is worth reading before editing any of the strings.
 *
 * ORDER OF OPERATIONS
 * -------------------
 * Email first, SMS only if the email succeeded. A text pointing at an inbox
 * with nothing in it is worse than no text — and the SMS is a pointer, so it
 * has no value of its own if the thing it points at failed to arrive.
 *
 * Both channels fail soft, per customer. One bad phone number or one Resend
 * error must not cost the other 21 people their summary.
 *
 * Dedup is by last_insights_sent_at (25 days — see INSIGHTS_DEDUP_DAYS), so a
 * manual re-run inside the same month is a no-op while February still fires.
 * Stamped only when the EMAIL sent, because that is the message; an SMS that
 * failed is a missing pointer, not a missing summary.
 *
 * ?dryRun=true reports exactly who would receive what, and sends nothing.
 */
async function handle(request: NextRequest) {
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

  const dryRun = request.nextUrl.searchParams.get("dryRun") === "true";
  const admin = createAdminClient();

  // The cohort the customer is compared against: the latest weekly capture
  // (0081), so the email and the Leaderboard page quote the same numbers. If no
  // snapshot exists the run is abandoned rather than silently comparing against
  // nothing — a summary with an empty right-hand column is not worth sending.
  const { data: snapRows, error: snapErr } = await admin
    .from("operator_proof_snapshots")
    .select("captured_on, group_key, operators, open_rate, contact_rate, meeting_rate")
    .order("captured_on", { ascending: false })
    .limit(20);

  if (snapErr) {
    console.error("[monthly-insights] snapshot read failed", snapErr);
    return NextResponse.json(
      { status: "error", error: snapErr.message },
      { status: 500 }
    );
  }

  type SnapRow = {
    captured_on: string;
    group_key: "winners" | "others";
    operators: number;
    open_rate: number | null;
    contact_rate: number | null;
    meeting_rate: number | null;
  };
  const snaps = (snapRows ?? []) as SnapRow[];
  const asOf = snaps[0]?.captured_on ?? null;
  const latest = snaps.filter((s) => s.captured_on === asOf);
  const winners = latest.find((s) => s.group_key === "winners");
  const others = latest.find((s) => s.group_key === "others");

  if (!asOf || !winners || !others) {
    console.warn("[monthly-insights] no snapshot yet — skipping run");
    return NextResponse.json({
      status: "skipped",
      reason: "no_snapshot",
      message:
        "operator_proof_snapshots is empty. capture-leaderboard must run before insights can be sent.",
    });
  }

  // Same suppression rule as the page: below three signed operators there is no
  // group to describe, only individuals. Sending anyway would put one
  // operator's habits in front of everybody else as "what winners do".
  if (winners.operators < 3) {
    console.warn(
      `[monthly-insights] run skipped — only ${winners.operators} signed operators`
    );
    return NextResponse.json({
      status: "skipped",
      reason: "too_few_signed_operators",
      signed_operators: winners.operators,
    });
  }

  const cohort: CohortFigures = {
    open_rate: winners.open_rate,
    contact_rate: winners.contact_rate,
    meeting_rate: winners.meeting_rate,
    operators: winners.operators,
  };

  const { data: rows, error: rowsErr } = await admin.rpc(
    "get_customer_monthly_insights"
  );
  if (rowsErr) {
    console.error("[monthly-insights] customer read failed", rowsErr);
    return NextResponse.json(
      { status: "error", error: rowsErr.message },
      { status: 500 }
    );
  }

  const customers = (rows ?? []) as CustomerInsight[];
  const asOfLabel = new Date(asOf).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  const pct = (v: number | null) =>
    v === null || v === undefined ? "—" : `${Math.round(Number(v) * 100)}%`;

  const sent: Record<string, unknown>[] = [];
  const skipped: Record<string, unknown>[] = [];

  for (const c of customers) {
    if (!wantsInsights(c)) {
      skipped.push({ customer_id: c.customer_id, reason: "opted_out" });
      continue;
    }
    if (alreadySentThisMonth(c.last_insights_sent_at)) {
      skipped.push({ customer_id: c.customer_id, reason: "already_sent" });
      continue;
    }

    const focus = selectFocus(c);
    const copy = composeInsight(c, cohort, `${APP_URL}/dashboard/leaderboard`);

    // Their figures against both cohorts — the same four rows as the page, in
    // the same order, so the two surfaces cannot tell different stories.
    const tableRows = [
      {
        label: "Leads opened",
        you: pct(c.open_rate),
        signed: pct(winners.open_rate),
        others: pct(others.open_rate),
      },
      {
        label: "Leads called",
        you: pct(c.contact_rate),
        signed: pct(winners.contact_rate),
        others: pct(others.contact_rate),
      },
      {
        label: "Reached a web meeting",
        you: pct(c.meeting_rate),
        signed: pct(winners.meeting_rate),
        others: pct(others.meeting_rate),
      },
    ];

    if (dryRun) {
      sent.push({
        customer_id: c.customer_id,
        focus,
        subject: copy.subject,
        heading: copy.heading,
        ask: copy.ask,
        sms: copy.sms,
        sms_len: copy.sms.length,
        would_sms: Boolean(c.phone && c.sms_alerts_enabled !== false),
        rows: tableRows,
      });
      continue;
    }

    const { error: emailErr } = await sendMonthlyInsightsEmail({
      to: c.email,
      subject: copy.subject,
      heading: copy.heading,
      ask: copy.ask,
      evidence: copy.evidence,
      buttonLabel: copy.buttonLabel,
      rows: tableRows,
      asOf: asOfLabel,
    });

    if (emailErr) {
      console.error("[monthly-insights] email failed", {
        customer_id: c.customer_id,
      });
      skipped.push({ customer_id: c.customer_id, reason: "email_failed" });
      continue;
    }

    // Only now is there something for the SMS to point at.
    let smsResult: string = "not_attempted";
    if (c.phone && c.sms_alerts_enabled !== false) {
      const r = await sendSms(c.phone, copy.sms);
      smsResult = r.ok ? "sent" : `skipped:${r.reason}`;
    } else {
      smsResult = c.phone ? "opted_out" : "no_phone";
    }

    const { error: stampErr } = await admin
      .from("customers")
      .update({ last_insights_sent_at: new Date().toISOString() })
      .eq("id", c.customer_id);
    if (stampErr) {
      // The email is already gone; log loudly rather than fail the run, but do
      // not pretend it did not happen — an unstamped row will be re-sent next
      // month at worst, which is the safe direction to fail in.
      console.error("[monthly-insights] stamp failed", {
        customer_id: c.customer_id,
      });
    }

    sent.push({ customer_id: c.customer_id, focus, sms: smsResult });
  }

  return NextResponse.json({
    status: "ok",
    dry_run: dryRun,
    as_of: asOf,
    signed_operators: winners.operators,
    eligible: customers.length,
    sent_count: sent.length,
    skipped_count: skipped.length,
    sent,
    skipped,
  });
}

export async function POST(request: NextRequest) {
  return handle(request);
}

// GET supports Vercel Cron, which issues a GET with the CRON_SECRET bearer.
export async function GET(request: NextRequest) {
  return handle(request);
}
