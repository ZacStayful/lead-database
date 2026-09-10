import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { isAdminUser } from "@/lib/auth";
import { sendFeedbackEmail } from "@/lib/emails";
import { ticketReference } from "@/lib/supportTickets";
import { retryFailedSynthesis, type ClarifyTicket } from "@/lib/feedback/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * The safety net under §50's compulsory questions.
 *
 * WHY THIS EXISTS. The questions cannot be skipped, so a customer can finish
 * typing, be shown three questions, and simply close the tab. Their ticket is
 * already on file — §46's guarantee is untouched — but the email that tells
 * anybody about it is held back waiting for answers that are never coming.
 * Without this sweep, a request nobody abandoned deliberately would sit unread
 * for ever, which is a worse outcome than the pre-§50 behaviour and would make
 * removing the skip button indefensible.
 *
 * So: anything still awaiting answers after the grace window is emailed
 * unclarified and marked 'abandoned'. It arrives exactly as a pre-§50 request
 * would have — the customer's own words, no brief — which is the floor this
 * whole feature promised never to fall below.
 *
 * ⚠️ THE MARK IS WRITTEN BEFORE THE SEND, and the update is conditional on the
 * row still being 'awaiting_answers'. That is the claim-by-write discipline
 * `credit_invoice` uses against Stripe redelivery: two overlapping runs race on
 * the update, the loser sees zero rows changed and sends nothing. Marking after
 * the send would double-email on any retry.
 *
 * Auth follows every other cron here: Bearer $CRON_SECRET, or an admin session.
 * Boolean(cronSecret) fails closed when the var is unset rather than accepting
 * a literal "Bearer undefined".
 */

/**
 * How long a customer gets to answer before the request is sent on without them.
 *
 * Two hours: long enough to survive a phone call, the school run, or a tab left
 * open over lunch, and short enough that a genuinely abandoned request is not
 * stale by the time anyone reads it.
 */
const GRACE_MS = 2 * 60 * 60 * 1000;

/** One run's ceiling, so a backlog cannot turn into an unbounded mail-out. */
const BATCH = 25;

/**
 * Retries are model calls, not emails, so this is tighter.
 *
 * ⚠️ A ticket that fails synthesis repeatedly will be retried on every run, for
 * ever. That is deliberate and it is why the number is small: the failure modes
 * worth recovering from are transient, and a permanent one costs five calls an
 * hour rather than a backlog that never drains. If that ever becomes a real
 * cost, the fix is an attempt counter, not a bigger batch.
 */
const RETRY_BATCH = 5;

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

  const admin = createAdminClient();
  const cutoff = new Date(Date.now() - GRACE_MS).toISOString();

  const { data, error } = await admin
    .from("support_tickets")
    .select(
      "id, reference, kind, subject, body, page, submitter_name, submitter_email, submitter_business, ai_status, submitted_at"
    )
    .eq("ai_status", "awaiting_answers")
    .lt("submitted_at", cutoff)
    .order("submitted_at", { ascending: true })
    .limit(BATCH);

  if (error) {
    console.error("[ticket-synthesis] could not scan", error);
    return NextResponse.json({ status: "error", error: error.message }, { status: 500 });
  }

  let swept = 0;
  let failed = 0;

  for (const row of (data ?? []) as unknown as (ClarifyTicket & {
    submitter_name: string;
    submitter_email: string;
  })[]) {
    // Claim it first. `.eq("ai_status", "awaiting_answers")` is the guard: a
    // concurrent run that already claimed this row changes nothing here and we
    // skip it rather than sending a second email.
    const { data: claimed, error: claimError } = await admin
      .from("support_tickets")
      .update({ ai_status: "abandoned", updated_at: new Date().toISOString() })
      .eq("id", row.id)
      .eq("ai_status", "awaiting_answers")
      .select("id");

    if (claimError || !claimed?.length) continue;

    const { error: mailError } = await sendFeedbackEmail({
      type: row.kind === "bug" ? "bug" : "feature",
      name: row.submitter_name,
      email: row.submitter_email,
      business: row.submitter_business,
      subject: row.subject,
      details: row.body,
      page: row.page,
      reference: ticketReference(row.reference),
      account: null,
    });

    if (mailError) {
      // The row keeps its 'abandoned' mark. Reverting it would re-queue the
      // send and risk a duplicate the next time Resend recovers, and the
      // request itself is not lost — it is on /admin/support either way.
      console.error("[ticket-synthesis] abandoned ticket, email failed", row.reference);
      failed += 1;
      continue;
    }
    swept += 1;
  }

  // Second job: fill in briefs a transient model outage cost. The customer was
  // already emailed when they finished, so this changes nothing they can see —
  // it recovers the thing on /admin/support that makes the ticket actionable.
  const { data: stale } = await admin
    .from("support_tickets")
    .select("id")
    .eq("ai_status", "failed")
    .order("submitted_at", { ascending: true })
    .limit(RETRY_BATCH);

  let retried = 0;
  let recovered = 0;
  for (const row of (stale ?? []) as { id: string }[]) {
    const status = await retryFailedSynthesis(row.id);
    if (status === "skipped") continue;
    retried += 1;
    if (status === "ready") recovered += 1;
  }

  return NextResponse.json({
    status: "ok",
    scanned: data?.length ?? 0,
    swept,
    failed,
    retried,
    recovered,
  });
}

export const GET = handle;
export const POST = handle;
