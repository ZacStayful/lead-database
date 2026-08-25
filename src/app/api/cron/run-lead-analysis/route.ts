import { NextResponse, type NextRequest } from "next/server";
import { randomUUID } from "crypto";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isAdminUser } from "@/lib/auth";
import { processAnalysisRow, type ClaimedAnalysisRow } from "@/lib/leadAnalysisRun";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Vercel Pro allows 300 (§2), and /api/cron/parse-income-reports already runs
 * at it. A ceiling rather than a reservation: a run with nothing to do finishes
 * in milliseconds.
 */
export const maxDuration = 300;

/**
 * Stop claiming here and leave the rest for the next run. Comfortably under
 * maxDuration so the worker reports what it did rather than being killed with a
 * row claimed, an external report paid for, and nothing written about it.
 */
const WALL_CLOCK_BUDGET_MS = 240_000;

/**
 * Reserved for the row already in flight when the budget runs out — a row can
 * take 70 seconds on its own.
 */
const RESERVE_MS = 80_000;

/**
 * Rows running at once across EVERY worker, enforced inside the claim function.
 *
 * This is the spend-rate throttle, not a latency knob: each in-flight row is an
 * external report we pay for whether or not we keep the answer. Three is
 * deliberately modest — a 200-lead batch drains in about half an hour, which is
 * what the customer is told.
 */
const MAX_INFLIGHT = Number(process.env.ANALYSIS_MAX_INFLIGHT ?? 3);

const ROW_TIMEOUT_MS = Number(process.env.ANALYSIS_ROW_TIMEOUT_MS ?? 90_000);

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
    if (row?.finalised) finalised.push(jobId);
  }

  return NextResponse.json({
    ...counts,
    finalisedJobs: finalised.length,
    stoppedBecause,
    elapsedMs: Date.now() - startedAt,
  });
}

// Vercel Cron issues a GET; the manual kick and the admin button POST.
export async function GET(request: NextRequest) {
  return handle(request);
}

export async function POST(request: NextRequest) {
  return handle(request);
}
