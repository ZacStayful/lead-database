import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { isAdminUser } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Weekly capture of the operator proof shown on Insights → Leaderboard.
 *
 * WHY A CRON AT ALL — the page was never stale. get_operator_proof reads live
 * state, so it has always been current to the second. What it could not do is
 * say WHEN it was measured, or say whether anything had moved.
 *
 * This writes one reading a week (0081). From that the page gets a date it can
 * show, figures that hold still while somebody is looking at them, and — the
 * part that only accrues with time — a previous week to compare against.
 *
 * CANNOT BE BACKFILLED, which is the real reason it runs on a schedule rather
 * than being computed on demand. capture_operator_proof reads current state, so
 * a week that is not captured is a week that cannot be reconstructed. A missed
 * Monday is a permanent hole in the series.
 *
 * Idempotent by date: the capture upserts on (captured_on, group_key), so a
 * retry, a manual re-run, or two overlapping invocations on the same day
 * overwrite rather than duplicating. Re-running mid-week simply refreshes that
 * week's reading, which is the sane behaviour for a snapshot of live state.
 *
 * Runs Mondays at 07:00, ahead of the inactivity nudge at 10:00: the nudge is
 * the first thing that pushes customers back into the app that week, so
 * capturing first keeps the reading a measure of the week that just ended
 * rather than of the nudge's own effect.
 *
 * Auth follows the pattern every other cron here uses: Bearer $CRON_SECRET, or
 * an admin session. Boolean(cronSecret) matters — it fails closed when the var
 * is unset rather than accepting a literal "Bearer undefined".
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

  const admin = createAdminClient();

  const { data, error } = await admin.rpc("capture_operator_proof");
  if (error) {
    console.error("[capture-leaderboard] capture failed", error);
    return NextResponse.json(
      { status: "error", error: error.message },
      { status: 500 }
    );
  }

  // Report the series alongside the write so a run's output answers "is the
  // trend accumulating?" without a second query. A capture that succeeds while
  // the series stays one row long means something is wrong with the schedule,
  // and that is invisible from the write alone.
  const { data: series } = await admin
    .from("operator_proof_snapshots")
    .select("captured_on")
    .order("captured_on", { ascending: false })
    .limit(60);

  const weeks = Array.from(
    new Set(((series ?? []) as { captured_on: string }[]).map((r) => r.captured_on))
  );

  return NextResponse.json({
    status: "ok",
    rows_written: data as number,
    captured_on: weeks[0] ?? null,
    weeks_in_series: weeks.length,
  });
}

export async function POST(request: NextRequest) {
  return handle(request);
}

// GET supports Vercel Cron, which issues a GET with the CRON_SECRET bearer.
export async function GET(request: NextRequest) {
  return handle(request);
}
