import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendPauseEndingSoonEmail } from "@/lib/emails";
import { resumePausedCustomer } from "@/lib/resumePause";

/** How far ahead of pause_resumes_at the "billing resumes soon" email goes. */
const PAUSE_ENDING_NOTICE_DAYS = 7;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type PausedCustomer = {
  id: string;
  email: string;
  contact_name: string | null;
  stripe_subscription_id: string | null;
};

/**
 * Daily cron: resume management subscriptions whose pause has elapsed. The
 * duration is chosen by the customer (1, 2 or 3 months, 0077), so this reads
 * pause_resumes_at rather than assuming any particular length.
 * Auth: CRON_SECRET bearer only (a pure scheduled job, matching the
 * inactivity-nudge cron — no admin-session path).
 *
 * For each customer with paused_at set and pause_resumes_at <= now: resume
 * Stripe collection, clear the pause columns, and send a "you're back" email.
 * account_status was never changed on pause (the slot was reserved), so nothing
 * needs restoring there; lead_balance was preserved and is ready to spend.
 *
 * Ordering: resume Stripe FIRST, then clear the DB pause. If Stripe fails, the
 * row is left paused so the next daily run retries — we never clear the pause
 * while the customer is still un-billed in Stripe.
 *
 * A PENDING CANCELLATION IS SKIPPED (0101). A customer who cancelled while
 * paused has said they are done: un-pausing them would email "billing has
 * restarted and you are back in line to receive leads" to somebody who asked to
 * leave, and put them back into lead routing for the tail of a period whose
 * invoices were all voided. They stay paused until Stripe deletes the
 * subscription, at which point the webhook's resume-detection block (§21's
 * third case) clears the pause and stamps the episode. Self-healing: choosing
 * "Keep my subscription" clears cancel_at_period_end, and the next daily run
 * resumes them normally.
 *
 * THE PAUSE-ENDING NOTICE (0101) also lives here: ~7 days before
 * pause_resumes_at, one email per pause stating the exact date billing
 * restarts, with resume / change plan / cancel all pointed at Settings. The
 * stamp is claimed by a guarded write BEFORE the send (claim-by-write, the
 * credit_invoice discipline) so a re-run can never double-send; a send that
 * then fails is logged and not retried — a missing notice beats a duplicate.
 * A pause shorter than the window simply gets its notice on the next morning's
 * run. Customers with a pending cancellation are skipped: "billing resumes"
 * would be false, since the block above never resumes them.
 */
async function handle(request: NextRequest) {
  const auth = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || auth !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();
  const nowIso = new Date().toISOString();

  const { data: rows, error } = await admin
    .from("customers")
    .select("id, email, contact_name, stripe_subscription_id")
    .not("paused_at", "is", null)
    .lte("pause_resumes_at", nowIso)
    // A customer who cancelled while paused stays paused — see the header.
    .eq("cancel_at_period_end", false);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  let resumed = 0;
  let alreadyResumed = 0;
  let stripeErrors = 0;
  const errors: string[] = [];

  for (const customer of (rows ?? []) as PausedCustomer[]) {
    // Everything a resume does lives in resumePausedCustomer (Stripe first,
    // then the guarded clear that decides who sends the email, the pacing
    // re-baseline, the episode stamp and the Monday push). The customer-facing
    // resume route calls the same function, so an early resume and a scheduled
    // one cannot behave differently.
    const result = await resumePausedCustomer(admin, customer, {
      source: "resume-paused-subscriptions",
    });

    if (result.outcome === "stripe_failed") {
      stripeErrors += 1;
      errors.push(`${customer.id}: ${result.error ?? "stripe error"}`);
      continue;
    }
    if (result.outcome === "db_failed") {
      errors.push(`${customer.id}: ${result.error ?? "db error"}`);
      continue;
    }
    if (result.outcome === "already_resumed") {
      alreadyResumed += 1;
      continue;
    }

    resumed += 1;
  }

  // -------------------------------------------------------------------------
  // Pause-ending notices (0101). AFTER the resume loop, so a pause resumed this
  // run has paused_at null and can no longer match — a "billing resumes soon"
  // email must never follow the "you're back" email it is warning about.
  // -------------------------------------------------------------------------
  let noticesSent = 0;
  const noticeCutoff = new Date(
    Date.now() + PAUSE_ENDING_NOTICE_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();

  const { data: noticeRows, error: noticeQueryError } = await admin
    .from("customers")
    .select("id, email, contact_name, pause_resumes_at")
    .not("paused_at", "is", null)
    .gt("pause_resumes_at", nowIso)
    .lte("pause_resumes_at", noticeCutoff)
    .is("pause_ending_notice_sent_at", null)
    // A pending cancellation means billing will NOT resume (the loop above
    // skips them), so the notice would be false.
    .eq("cancel_at_period_end", false);

  if (noticeQueryError) {
    errors.push(`notice query: ${noticeQueryError.message}`);
    console.error("[resume-paused-subscriptions] notice query failed", {
      error: noticeQueryError.message,
    });
  }

  for (const row of noticeRows ?? []) {
    if (!row.email || !row.pause_resumes_at) continue;

    // Claim the stamp BEFORE sending (claim-by-write): a concurrent or repeated
    // run collides on the `is null` predicate and skips, so the notice can
    // never double-send. A send that then fails is logged, not retried —
    // missing beats duplicate, and the resume email still lands either way.
    const { data: claimed, error: claimError } = await admin
      .from("customers")
      .update({
        pause_ending_notice_sent_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", row.id)
      .is("pause_ending_notice_sent_at", null)
      .select("id")
      .maybeSingle();

    if (claimError) {
      errors.push(`${row.id}: ${claimError.message}`);
      console.error("[resume-paused-subscriptions] notice claim failed", {
        customer: row.id,
        error: claimError.message,
      });
      continue;
    }
    if (!claimed) continue; // Another run got there first.

    const { error: noticeEmailError } = await sendPauseEndingSoonEmail({
      to: row.email,
      contactName: row.contact_name ?? row.email,
      resumeDateIso: row.pause_resumes_at,
    });
    if (noticeEmailError) {
      console.error("[resume-paused-subscriptions] notice email failed", {
        customer: row.id,
        error: noticeEmailError,
      });
      continue;
    }
    noticesSent += 1;
  }

  return NextResponse.json({
    status: "ok",
    resumed,
    already_resumed: alreadyResumed,
    notices_sent: noticesSent,
    stripe_errors: stripeErrors,
    errors,
  });
}

export async function GET(request: NextRequest) {
  return handle(request);
}

export async function POST(request: NextRequest) {
  return handle(request);
}
