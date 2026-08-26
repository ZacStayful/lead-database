import { NextResponse, type NextRequest } from "next/server";
import { randomUUID } from "crypto";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isAdminUser } from "@/lib/auth";
import { getStripe } from "@/lib/stripe";
import {
  processAnalysisRow,
  routeQualifiedLead,
  type ClaimedAnalysisRow,
} from "@/lib/leadAnalysisRun";
import { settleDueRefunds } from "@/lib/leadAnalysisRefund";
import { sendAnalysisReadyEmail } from "@/lib/emails";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * ⚠️ 60, because this Vercel account is on HOBBY.
 *
 * CLAUDE.md §2 says the account is on Pro and /api/cron/parse-income-reports
 * ships maxDuration = 300 on that basis. The Vercel API reports this team as
 * `hobby`, whose function ceiling is 60 seconds — so 300 would be a number that
 * reads like a guarantee and is not one.
 *
 * This is why the worker CHAINS rather than looping: one invocation does one
 * row and hands off, instead of one long invocation doing twenty. See
 * kickSelf below.
 */
export const maxDuration = 60;

/**
 * Stop claiming here and hand off to the next invocation. Under maxDuration
 * with room to spare, so the worker records what it did rather than being
 * killed with a row claimed, an external report already paid for, and nothing
 * written about it.
 */
const WALL_CLOCK_BUDGET_MS = 50_000;

/**
 * Reserved for the row already in flight when the budget runs out.
 *
 * A row is 20-30s typically. With a 45s per-row timeout (below) an invocation
 * that has already spent 5s must not claim another, because it could not
 * finish it — and a row killed mid-flight has still cost us its report.
 */
const RESERVE_MS = 46_000;

/**
 * Rows running at once across EVERY worker, enforced inside the claim function.
 *
 * This is the spend-rate throttle, not a latency knob: each in-flight row is an
 * external report we pay for whether or not we keep the answer. Three is
 * deliberately modest — a 200-lead batch drains in about half an hour, which is
 * what the customer is told.
 */
const MAX_INFLIGHT = Number(process.env.ANALYSIS_MAX_INFLIGHT ?? 3);

/**
 * Must stay comfortably under maxDuration: we need to still be alive to WRITE
 * the row's outcome after giving up on it. A row that times out silently, with
 * the function killed before it records anything, is one that stays 'running'
 * until the stale window reclaims it — ten minutes of an in-flight slot doing
 * nothing.
 */
const ROW_TIMEOUT_MS = Number(process.env.ANALYSIS_ROW_TIMEOUT_MS ?? 45_000);

/**
 * Consecutive dead rows before the run gives up.
 *
 * One quiet property is a quiet property. Three in a row is an upstream outage,
 * and continuing would spend the rest of a paid batch producing nothing —
 * every one of which we would then have to refund.
 */
const CONSECUTIVE_FAILURE_LIMIT = 3;

/**
 * Drain the paid lead-analysis queue.
 *
 * Every five minutes, and after a purchase. It claims rows one at a time,
 * calls the analyser, and writes the figures and the PDF through the same two
 * functions the Monday sweep writes through, so an analysed owned lead is not
 * *like* a parsed lead — it is one.
 *
 * WHY A CRON AND NOT A CHAIN. The analyser's own worker fires its successor
 * before doing the work, using `after()` from next/server. That is a Next 15+
 * API and this app is on 14.2.15, so the equivalent here is a five-minute cron
 * plus a best-effort kick after a purchase plus the progress panel's poll
 * re-arming a dropped chain. Slower to start, but nothing is lost: rows are
 * durable, claims expire, and the queue drains whether or not any kick lands.
 *
 * Auth mirrors /api/cron/parse-income-reports: Bearer $CRON_SECRET, or an admin
 * session so a stuck queue can be drained by hand without waiting for the
 * schedule. `Boolean(cronSecret)` matters — it fails closed when unset.
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
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const dryRun = request.nextUrl.searchParams.get("dryRun") === "true";
  const startedAt = Date.now();
  const admin = createAdminClient();

  if (dryRun) {
    const { count } = await admin
      .from("lead_analysis_rows")
      .select("id", { count: "exact", head: true })
      .eq("status", "pending");
    const { count: jobs } = await admin
      .from("lead_analysis_jobs")
      .select("id", { count: "exact", head: true })
      .eq("status", "running");
    return NextResponse.json({ dryRun: true, pendingRows: count ?? 0, runningJobs: jobs ?? 0 });
  }

  const counts = { claimed: 0, succeeded: 0, failed: 0, retried: 0 };
  const touchedJobs = new Set<string>();
  let consecutiveFailures = 0;
  let stoppedBecause: string | null = null;
  let chainedAhead = false;

  while (Date.now() - startedAt < WALL_CLOCK_BUDGET_MS - RESERVE_MS) {
    const claimToken = randomUUID();
    const { data: claimed, error: claimError } = await admin.rpc("claim_lead_analysis_rows", {
      p_limit: 1,
      p_claim_token: claimToken,
      p_max_inflight: MAX_INFLIGHT,
    });

    if (claimError) {
      console.error("run-lead-analysis: claim failed", claimError);
      stoppedBecause = "claim_failed";
      break;
    }

    const rows = (claimed ?? []) as ClaimedAnalysisRow[];
    if (!rows.length) {
      // Either the queue is empty or the in-flight ceiling is full of somebody
      // else's rows. Both mean: nothing for this invocation to do.
      stoppedBecause = stoppedBecause ?? "nothing_claimable";
      break;
    }

    for (const row of rows) {
      counts.claimed += 1;
      touchedJobs.add(row.job_id);

      // ── Chain ahead, BEFORE doing the work ────────────────────
      //
      // At a 60-second ceiling one invocation is one row, so the queue drains
      // by handing off rather than by looping. Fired immediately after the
      // claim and before the analysis, so the successor is already on its way
      // while this row runs — and so an invocation killed mid-row cannot take
      // the chain down with it.
      //
      // Overlap is harmless: claiming is atomic and the in-flight cap is
      // enforced inside the claim function, so a successor that arrives early
      // simply finds nothing to claim and exits.
      //
      // Once per invocation. The analyser's worker uses after() from
      // next/server for this; that is Next 15+ and this app is 14.2.15, so the
      // request goes out during the handler instead.
      if (!chainedAhead) {
        chainedAhead = true;
        kickSelf(request);
      }

      await admin
        .from("lead_analysis_rows")
        .update({ status: "running", started_at: new Date().toISOString() })
        .eq("id", row.id)
        .eq("claim_token", claimToken);

      const result = await processAnalysisRow(admin, row, { timeoutMs: ROW_TIMEOUT_MS });

      if (result.kind === "blocked") {
        // Never reached the analyser, so the row never had its chance. Hand the
        // attempt back and stop: the rest of this batch would hit the same wall
        // and burn every attempt on a problem that is ours to fix.
        console.error("run-lead-analysis: blocked", result.errorCode, result.message);
        await admin
          .from("lead_analysis_rows")
          .update({
            status: "pending",
            attempts: Math.max(row.attempts - 1, 0),
            claim_token: null,
            claimed_at: null,
            started_at: null,
            error_code: result.errorCode,
            error_message: result.message,
          })
          .eq("id", row.id);
        await admin
          .from("lead_analysis_jobs")
          .update({ paused_reason: `${result.errorCode}: ${result.message}` })
          .eq("id", row.job_id);
        stoppedBecause = result.errorCode;
        break;
      }

      if (result.kind === "succeeded") {
        counts.succeeded += 1;
        consecutiveFailures = 0;
        await admin
          .from("lead_analysis_rows")
          .update({
            status: "succeeded",
            quality_ok: true,
            error_code: null,
            error_message: null,
            finished_at: new Date().toISOString(),
          })
          .eq("id", row.id);

        // Offer a newly qualified owned lead to its one further operator (§32).
        //
        // AFTER the row is recorded, deliberately. Routing runs two candidate
        // RPCs, the assign RPC and an unbounded set of emails and texts, and
        // the budget above was sized for a write-back. Doing it before this
        // update would let a slow tail kill the invocation with a paid row
        // still looking unfinished. Here the worst case is a lead that waits
        // for the admin backstop.
        if (result.routeLeadId) {
          await routeQualifiedLead(admin, result.routeLeadId);
        }
        continue;
      }

      consecutiveFailures += 1;

      if (result.kind === "retry") {
        counts.retried += 1;
        // Back to pending with the attempt already spent, so the next claim
        // picks it up and max_attempts still bounds it.
        await admin
          .from("lead_analysis_rows")
          .update({
            status: "pending",
            claim_token: null,
            claimed_at: null,
            started_at: null,
            error_code: result.errorCode,
            error_message: result.message,
          })
          .eq("id", row.id);
      } else {
        counts.failed += 1;
        await admin
          .from("lead_analysis_rows")
          .update({
            status: "failed",
            quality_ok: result.errorCode === "no_str_data" ? false : null,
            error_code: result.errorCode,
            error_message: result.message,
            finished_at: new Date().toISOString(),
          })
          .eq("id", row.id);
      }

      if (consecutiveFailures >= CONSECUTIVE_FAILURE_LIMIT) {
        console.error("run-lead-analysis: stopping after consecutive failures");
        await admin
          .from("lead_analysis_jobs")
          .update({
            paused_reason: `${consecutiveFailures} rows failed in a row (${result.errorCode})`,
          })
          .eq("id", row.job_id);
        stoppedBecause = "consecutive_failures";
        break;
      }
    }

    if (stoppedBecause) break;
  }

  // Close anything that can no longer move, and work out what is owed back.
  // Idempotent, so calling it for every job this run touched is free.
  const finalised: string[] = [];
  for (const jobId of Array.from(touchedJobs)) {
    const { data, error } = await admin.rpc("finalise_lead_analysis_job", { p_job_id: jobId });
    if (error) {
      console.error("run-lead-analysis: finalise failed", jobId, error);
      continue;
    }
    const row = Array.isArray(data) ? data[0] : data;
    if (row?.finalised) {
      finalised.push(jobId);
      // The customer paid up front and then waited — a 200-lead batch is about
      // half an hour — so telling them it is done is part of what they bought.
      // Never allowed to fail the run: the figures are already written and the
      // refund is already owed whether or not an email lands.
      try {
        await notifyJobFinished(admin, jobId, row);
      } catch (err) {
        console.error("run-lead-analysis: completion email failed", jobId, err);
      }
    }
  }

  // Settle what is owed back. Deliberately NOT limited to the jobs this run
  // touched: anything a previous run left deferred is picked up here too, which
  // is what makes "leave it due and try again" a real recovery rather than a
  // hope. Never throws — a refund problem must not take down a run that has
  // just produced somebody else's figures.
  let refunded = 0;
  let refundsDeferred = 0;
  try {
    for (const r of await settleDueRefunds(admin, getStripe())) {
      if (r.status === "refunded") refunded += r.amountPence ?? 0;
      if (r.status === "deferred") refundsDeferred += 1;
    }
  } catch (err) {
    console.error("run-lead-analysis: refund sweep failed", err);
  }

  // Nothing was claimable this time round, but rows may have been RELEASED for
  // retry during it — so hand off once more rather than leaving them for the
  // daily cron.
  if (counts.retried > 0 && !chainedAhead) kickSelf(request);

  return NextResponse.json({
    ...counts,
    finalisedJobs: finalised.length,
    refundedPence: refunded,
    refundsDeferred,
    chainedAhead,
    stoppedBecause,
    elapsedMs: Date.now() - startedAt,
  });
}

/**
 * Hand the queue to a fresh invocation.
 *
 * Fire-and-forget and never awaited: the rows are durable in Postgres, so a
 * kick that does not land costs latency and nothing else — the daily cron and
 * the progress panel's poll both pick the queue back up.
 */
function kickSelf(request: NextRequest): void {
  const secret = process.env.CRON_SECRET;
  if (!secret) return;
  const base =
    process.env.NEXT_PUBLIC_APP_URL ??
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : request.nextUrl.origin);
  void fetch(`${base}/api/cron/run-lead-analysis`, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}` },
    cache: "no-store",
  }).catch(() => {
    /* durability is the queue, not this request */
  });
}

/**
 * Tell the customer their batch is done.
 *
 * Sent once, from the one place a job is finalised, so it cannot be sent twice
 * for the same job: finalise_lead_analysis_job only returns finalised: true on
 * the transition.
 */
async function notifyJobFinished(
  admin: ReturnType<typeof createAdminClient>,
  jobId: string,
  tally: { succeeded_count?: number; failed_count?: number; refund_pence?: number }
): Promise<void> {
  const { data: job } = await admin
    .from("lead_analysis_jobs")
    .select("customer_id")
    .eq("id", jobId)
    .maybeSingle();
  const customerId = (job as { customer_id: string } | null)?.customer_id;
  if (!customerId) return;

  const { data: customer } = await admin
    .from("customers")
    .select("email")
    .eq("id", customerId)
    .maybeSingle();
  const email = (customer as { email: string } | null)?.email;
  if (!email) return;

  await sendAnalysisReadyEmail({
    to: email,
    succeeded: tally.succeeded_count ?? 0,
    failed: tally.failed_count ?? 0,
    refundPence: tally.refund_pence ?? 0,
  });
}

// Vercel Cron issues a GET; the manual kick and the admin button POST.
export async function GET(request: NextRequest) {
  return handle(request);
}

export async function POST(request: NextRequest) {
  return handle(request);
}
