import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isAdminUser } from "@/lib/auth";
import { fetchIncomeReportAssets } from "@/lib/monday";
import {
  incomeReportPatch,
  resolveIncomeReport,
  type IncomeReportStatus,
} from "@/lib/incomeReport";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Leads looked at per run. One Monday query, then one download each. */
const BATCH_SIZE = 40;

/**
 * Stop here and leave the rest for tomorrow (or the next manual run). Under
 * maxDuration, so the run reports what it did instead of being killed with the
 * work half done and nothing written about it.
 */
const WALL_CLOCK_BUDGET_MS = 45_000;

/** How long a lead stays worth re-checking for a late-attached report. */
const NO_REPORT_RECHECK_DAYS = 30;

type Candidate = {
  id: string;
  monday_item_id: string;
  income_report_status: IncomeReportStatus;
  income_report_asset_id: string | null;
};

/**
 * Daily: read the Stayful analysis PDF for management leads and stamp the gross
 * income figure (0089).
 *
 * THIS IS WHAT KEEPS EXISTING LEADS UP TO DATE. ingestLead parses a lead once,
 * when it is created, and deliberately never touches a row again — an already-
 * ingested Monday item returns early without a single column being refreshed.
 * So without this job the ~150 leads that predate the feature would never get a
 * figure, and any lead whose report is replaced would keep the old one forever.
 *
 * THE REPORT IS NEVER STORED OR SURFACED. Monday's public_url is signed for an
 * hour; it is fetched, read for one number and discarded. Nothing in the
 * product links to a PDF.
 *
 * Management only. The GR board has a file column but no item carries a file,
 * and a 15% management fee is not what a GR operator earns anyway.
 *
 * Auth mirrors /api/cron/sweep-lead-pool: Bearer $CRON_SECRET, or an admin
 * session. ?dryRun=true lists the candidates and writes nothing.
 *
 * SCHEDULED AT 12:00 — after the 09:00 syncs, the 10:30 pool sweep and the
 * 11:00 escalation, so it is never competing with a job that moves leads
 * around. It writes no column any of them read, so the ordering is politeness
 * about the Monday API rather than correctness.
 *
 * Backfillable by construction: it derives everything from the board, which is
 * still there tomorrow, so a missed day costs a day of latency on new leads.
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
  const startedAt = Date.now();
  const admin = createAdminClient();

  const select = "id, monday_item_id, income_report_status, income_report_asset_id";

  // Two plain queries rather than one `.or()` carrying a nested `and()`. The
  // backlog is the job; the no_report re-check is a courtesy that only runs on
  // leftover batch capacity, and separating them says so — as well as keeping
  // both filters to PostgREST syntax that is obvious at a glance.
  //
  // Oldest first, so the backlog drains in the order the leads arrived rather
  // than a fresh lead jumping the queue every night.
  const { data: outstandingRows, error } = await admin
    .from("leads")
    .select(select)
    .eq("lead_type", "management")
    .in("income_report_status", ["pending", "failed"])
    .order("created_at", { ascending: true })
    .limit(BATCH_SIZE);

  if (error) {
    console.error("parse-income-reports: candidate query failed", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const candidates = (outstandingRows ?? []) as Candidate[];

  if (candidates.length < BATCH_SIZE) {
    // A report can be attached to an item after the lead was ingested — sales
    // run the analyser when they get round to it — so look again at the young
    // ones. Newest first here: the older a lead gets without a report, the
    // less likely one is coming.
    const recheckFrom = new Date(
      Date.now() - NO_REPORT_RECHECK_DAYS * 24 * 60 * 60 * 1000
    ).toISOString();
    const { data: recheckRows, error: recheckError } = await admin
      .from("leads")
      .select(select)
      .eq("lead_type", "management")
      .eq("income_report_status", "no_report")
      .gte("created_at", recheckFrom)
      .order("created_at", { ascending: false })
      .limit(BATCH_SIZE - candidates.length);

    if (recheckError) {
      // Not fatal: the backlog above is the job, and dropping the courtesy pass
      // must not cost the run.
      console.error("parse-income-reports: no_report re-check query failed", recheckError);
    } else {
      candidates.push(...((recheckRows ?? []) as Candidate[]));
    }
  }

  if (dryRun) {
    return NextResponse.json({
      status: "ok",
      dryRun: true,
      scanned: candidates.length,
      candidates: candidates.map((c) => ({
        lead_id: c.id,
        monday_item_id: c.monday_item_id,
        status: c.income_report_status,
      })),
      remaining: await countOutstanding(admin),
    });
  }

  if (!candidates.length) {
    return NextResponse.json({
      status: "ok",
      scanned: 0,
      parsed: 0,
      no_report: 0,
      unparsed: 0,
      failed: 0,
      skipped: 0,
      remaining: 0,
    });
  }

  let assets: Awaited<ReturnType<typeof fetchIncomeReportAssets>>;
  try {
    assets = await fetchIncomeReportAssets(
      candidates.map((c) => c.monday_item_id)
    );
  } catch (err) {
    // The whole batch is unreadable, not any individual lead — leave the rows
    // as they are so tomorrow retries them, rather than marking 40 leads failed
    // because Monday was down for eight seconds.
    console.error("parse-income-reports: Monday asset fetch failed", err);
    return NextResponse.json(
      {
        error: err instanceof Error ? err.message : "Monday asset fetch failed",
      },
      { status: 502 }
    );
  }

  const counts: Record<IncomeReportStatus, number> = {
    pending: 0,
    parsed: 0,
    no_report: 0,
    unparsed: 0,
    failed: 0,
  };
  let skipped = 0;
  let processed = 0;

  for (const lead of candidates) {
    if (Date.now() - startedAt > WALL_CLOCK_BUDGET_MS) break;
    processed += 1;

    const asset = assets.get(lead.monday_item_id) ?? null;

    // Already read this exact document and it did not yield a figure. Nothing
    // about it will have changed, so do not spend the download.
    if (
      asset &&
      lead.income_report_asset_id === asset.id &&
      lead.income_report_status === "unparsed"
    ) {
      skipped += 1;
      continue;
    }

    const outcome = await resolveIncomeReport(asset);
    const { error: writeError } = await admin
      .from("leads")
      .update(incomeReportPatch(outcome))
      .eq("id", lead.id);

    if (writeError) {
      // Leave the row where it was; it is still a candidate tomorrow.
      console.error("parse-income-reports: write failed", lead.id, writeError);
      counts.failed += 1;
      continue;
    }

    counts[outcome.status] += 1;
  }

  return NextResponse.json({
    status: "ok",
    scanned: processed,
    parsed: counts.parsed,
    no_report: counts.no_report,
    unparsed: counts.unparsed,
    failed: counts.failed,
    skipped,
    // Counted after the writes, so a caller can tell "the backlog is draining"
    // from "the backlog is stuck" — which the counts above cannot say on their
    // own, because a run of 40 failures and a run of 40 successes both report
    // scanned: 40.
    remaining: await countOutstanding(admin),
  });
}

/** Management leads still waiting on, or retrying, a report. */
async function countOutstanding(
  admin: ReturnType<typeof createAdminClient>
): Promise<number> {
  const { count } = await admin
    .from("leads")
    .select("id", { count: "exact", head: true })
    .eq("lead_type", "management")
    .in("income_report_status", ["pending", "failed"]);
  return count ?? 0;
}

// Vercel Cron issues a GET; POST is here so the job can be triggered by hand
// from admin exactly as the other crons can.
export async function GET(request: NextRequest) {
  return handle(request);
}

export async function POST(request: NextRequest) {
  return handle(request);
}
