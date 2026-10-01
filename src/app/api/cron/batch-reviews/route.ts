/**
 * The monthly batch review and the shortfall email (§73).
 *
 * The snapshot this reads is written inside reset_monthly_counts (0160), at
 * 00:05 UTC on each customer's anchor day, before the counters are zeroed. This
 * route only SENDS, in three phases:
 *
 *   1. SHORTFALL. On reset day, to anyone delivered less than their allocation:
 *      what arrived, what is owed, what is due next, and why.
 *   2. SURVEY. `batch_review_delay_days` (7) after the cycle ends, to anyone
 *      with at least one lead in the batch: one link to every lead, prefilled.
 *   3. REMINDER. Once, `batch_review_reminder_days` (3) later, if still not
 *      answered. Never more than one.
 *
 * ⚠️ EVERY SEND IS CLAIMED BY A GUARDED UPDATE FIRST, then sent: the
 * credit_invoice discipline. Two overlapping runs race on the update; the loser
 * changes zero rows and sends nothing. A send that fails after its claim is
 * NOT retried. Missing an email is better than sending it twice (§44.4's rule).
 *
 * ⚠️ A FAILED SETTINGS READ IS A 500, never a 200 carrying "skipped" (§18.3).
 * The switch is read by name, so an empty result is `not_configured`, which is
 * the ordinary shape of a database 0160 has not reached, and reads as off.
 */
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { isAdminUser } from "@/lib/auth";
import { resolveSettingsGate } from "@/lib/cron/settingsGate";
import { describeError } from "@/lib/logError";
import { sendBatchReviewEmail, sendBatchShortfallEmail } from "@/lib/emails";
import { productLabel } from "@/lib/topup";
import { APP_URL } from "@/lib/env";
import {
  BATCH_REVIEW_SETTING_KEYS,
  SHORTFALL_FRESH_DAYS,
  addDaysIso,
  batchReviewSettingsFrom,
  cycleLabel,
  longDate,
  reminderDue,
  surveyDue,
} from "@/lib/batchReview/settings";
import {
  isShortfall,
  shortfallCopy,
  shortfallSummaryLine,
  type ShortfallSnapshot,
} from "@/lib/batchReview/shortfall";
import {
  deriveReviewToken,
  hashReviewToken,
  reviewTokenSecret,
} from "@/lib/batchReview/review";
import {
  CUSTOMER_SELECT,
  stillHolds,
  wantsReview,
  type CustomerRow,
} from "@/lib/batchReview/eligibility";
import type { LeadType } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Resend's documented limit is 2/second (§21.3). */
const SEND_GAP_MS = 600;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const REVIEW_SELECT =
  "id, customer_id, lead_type, cycle_start, cycle_end, allocation, delivered, balance_at_reset, next_allocation, pool_debit, filter_status, filter_expected_leads, filter_areas, filter_min_bedrooms, filter_max_bedrooms, filter_min_gross, release_hold_until, shortfall_email_sent_at, survey_sent_at, reminder_sent_at, submitted_at, token_expires_at";

type ReviewRow = ShortfallSnapshot & {
  id: string;
  customer_id: string;
  lead_type: LeadType;
  shortfall_email_sent_at: string | null;
  survey_sent_at: string | null;
  reminder_sent_at: string | null;
  submitted_at: string | null;
  token_expires_at: string | null;
};

export async function GET(request: Request) {
  return run(request);
}
export async function POST(request: Request) {
  return run(request);
}

async function run(request: Request) {
  // The §2 cron auth pattern, verbatim.
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

  const { data: settingRows, error: settingsError } = await admin
    .from("system_settings")
    .select("key, value")
    .in("key", [...BATCH_REVIEW_SETTING_KEYS]);
  const gate = resolveSettingsGate(settingRows, settingsError);
  if (!gate.ok && gate.reason === "read_failed") {
    console.error("[batch-reviews] run aborted — system_settings unreadable", gate.message);
    return NextResponse.json({ ok: false, error: "settings_read_failed" }, { status: 500 });
  }
  const settings = batchReviewSettingsFrom(gate.ok ? gate.config : new Map());

  // A dry run is allowed while switched off: it is how the first captures are
  // checked by hand before anything is sent.
  if (!settings.enabled && !dryRun) {
    return NextResponse.json({ ok: true, skipped: "batch_reviews_disabled" });
  }

  const now = new Date();
  const nowIso = now.toISOString();
  // cycle_end is Postgres `current_date` at 00:05 UTC, so the comparison is in
  // UTC dates too.
  const today = nowIso.slice(0, 10);
  const earliest = addDaysIso(today, -(settings.delayDays * 2 + 7 + settings.reminderDays + 1));

  const { data: reviewData, error: reviewError } = await admin
    .from("lead_batch_reviews")
    .select(REVIEW_SELECT)
    .is("submitted_at", null)
    .gte("cycle_end", earliest)
    .lte("cycle_end", today)
    .order("cycle_end", { ascending: true });
  if (reviewError) {
    console.error("[batch-reviews] review read failed", describeError(reviewError));
    return NextResponse.json({ ok: false, error: "review_read_failed" }, { status: 500 });
  }
  const reviews = (reviewData ?? []) as unknown as ReviewRow[];

  const customerIds = Array.from(new Set(reviews.map((r) => r.customer_id)));
  const customers = new Map<string, CustomerRow>();
  if (customerIds.length > 0) {
    const { data: customerData, error: customerError } = await admin
      .from("customers")
      .select(CUSTOMER_SELECT)
      .in("id", customerIds);
    if (customerError) {
      console.error("[batch-reviews] customer read failed", describeError(customerError));
      return NextResponse.json({ ok: false, error: "customer_read_failed" }, { status: 500 });
    }
    for (const c of (customerData ?? []) as unknown as CustomerRow[]) customers.set(c.id, c);
  }

  const secret = reviewTokenSecret();
  const report = {
    shortfall: [] as { review: string; customer: string; sent: boolean }[],
    survey: [] as { review: string; customer: string; sent: boolean }[],
    reminder: [] as { review: string; customer: string; sent: boolean }[],
    skipped: [] as { review: string; reason: string }[],
  };

  for (const r of reviews) {
    const c = customers.get(r.customer_id);
    if (!c || !c.email) {
      report.skipped.push({ review: r.id, reason: "no_customer" });
      continue;
    }
    const product = productLabel(r.lead_type);
    const holds = stillHolds(c, r.lead_type);

    // ---- 1. shortfall -----------------------------------------------------
    if (
      r.shortfall_email_sent_at == null &&
      isShortfall(r) &&
      addDaysIso(r.cycle_end, SHORTFALL_FRESH_DAYS) > today &&
      holds
    ) {
      const copy = shortfallCopy(r, product, longDate(r.cycle_end));
      if (dryRun) {
        report.shortfall.push({ review: r.id, customer: c.id, sent: false });
      } else {
        const { data: claimed } = await admin
          .from("lead_batch_reviews")
          .update({ shortfall_email_sent_at: nowIso, updated_at: nowIso })
          .eq("id", r.id)
          .is("shortfall_email_sent_at", null)
          .select("id");
        if (claimed && claimed.length > 0) {
          const res = await sendBatchShortfallEmail({
            to: c.email,
            contactName: c.contact_name ?? "",
            subject: copy.subject,
            headline: copy.headline,
            figures: copy.figures,
            causeSentence: copy.causeSentence,
            options: copy.options,
            filteringUrl: copy.cause === "filter" ? `${APP_URL}/dashboard/filtering` : null,
            // The same three conditions the survey phase checks, so the
            // email never promises a review the cron will not send.
            reviewInDays: r.delivered > 0 && wantsReview(c) && secret ? settings.delayDays : null,
          });
          if (res.error) console.error("[batch-reviews] shortfall send failed", r.id, res.error);
          report.shortfall.push({ review: r.id, customer: c.id, sent: !res.error });
          await sleep(SEND_GAP_MS);
        }
      }
    }

    // ---- 2. survey --------------------------------------------------------
    if (surveyDue(r, today, settings)) {
      if (!holds) {
        report.skipped.push({ review: r.id, reason: "no_longer_holds" });
        continue;
      }
      if (!wantsReview(c)) {
        report.skipped.push({ review: r.id, reason: "opted_out" });
        continue;
      }
      if (!secret) {
        report.skipped.push({ review: r.id, reason: "no_token_secret" });
        continue;
      }
      if (dryRun) {
        report.survey.push({ review: r.id, customer: c.id, sent: false });
        continue;
      }
      // The expiry is written in the same claim as the hash, so the token the
      // reminder derives later uses the same input.
      const expiresAt = new Date(now.getTime() + settings.tokenDays * 86_400_000).toISOString();
      const raw = deriveReviewToken(r.id, expiresAt, secret);
      if (!raw) {
        report.skipped.push({ review: r.id, reason: "no_token_secret" });
        continue;
      }
      const { data: claimed } = await admin
        .from("lead_batch_reviews")
        .update({
          survey_sent_at: nowIso,
          token_hash: hashReviewToken(raw),
          token_expires_at: expiresAt,
          updated_at: nowIso,
        })
        .eq("id", r.id)
        .is("survey_sent_at", null)
        .select("id");
      if (!claimed || claimed.length === 0) continue;
      const res = await sendBatchReviewEmail({
        to: c.email,
        contactName: c.contact_name ?? "",
        productLabel: product,
        periodLabel: cycleLabel(r.cycle_start, r.cycle_end),
        delivered: r.delivered,
        reviewUrl: `${APP_URL}/review/${raw}`,
        reminder: false,
        shortfallLine: isShortfall(r) ? shortfallSummaryLine(r) : null,
      });
      if (res.error) console.error("[batch-reviews] survey send failed", r.id, res.error);
      report.survey.push({ review: r.id, customer: c.id, sent: !res.error });
      await sleep(SEND_GAP_MS);
      continue;
    }

    // ---- 3. reminder ------------------------------------------------------
    if (reminderDue(r, now, settings)) {
      if (!holds || !wantsReview(c) || !secret || !r.token_expires_at) {
        report.skipped.push({ review: r.id, reason: "reminder_not_sendable" });
        continue;
      }
      if (dryRun) {
        report.reminder.push({ review: r.id, customer: c.id, sent: false });
        continue;
      }
      const raw = deriveReviewToken(r.id, r.token_expires_at, secret);
      const { data: claimed } = await admin
        .from("lead_batch_reviews")
        .update({ reminder_sent_at: nowIso, updated_at: nowIso })
        .eq("id", r.id)
        .is("reminder_sent_at", null)
        .is("submitted_at", null)
        .select("id");
      if (!raw || !claimed || claimed.length === 0) continue;
      const res = await sendBatchReviewEmail({
        to: c.email,
        contactName: c.contact_name ?? "",
        productLabel: product,
        periodLabel: cycleLabel(r.cycle_start, r.cycle_end),
        delivered: r.delivered,
        reviewUrl: `${APP_URL}/review/${raw}`,
        reminder: true,
        shortfallLine: null,
      });
      if (res.error) console.error("[batch-reviews] reminder send failed", r.id, res.error);
      report.reminder.push({ review: r.id, customer: c.id, sent: !res.error });
      await sleep(SEND_GAP_MS);
    }
  }

  return NextResponse.json({
    ok: true,
    dryRun,
    enabled: settings.enabled,
    considered: reviews.length,
    ...report,
  });
}
