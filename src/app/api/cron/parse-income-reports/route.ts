import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isAdminUser } from "@/lib/auth";
import { fetchIncomeReportAssets } from "@/lib/monday";
import {
  incomeReportPatch,
  presentationFiguresPatch,
  resolveIncomeReport,
  type IncomeReportStatus,
} from "@/lib/incomeReport";
import { syncStoredReport } from "@/lib/incomeReportStorage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Vercel Pro allows 300 (§2). Raised so a backlog drains in ONE run rather than
// a queue of nights — the wall-clock budget below is still what actually stops
// the loop, and this is a ceiling rather than a reservation, so an ordinary day
// with nothing to do still finishes in seconds.
export const maxDuration = 300;

/**
 * Leads looked at per run. Deliberately larger than one run can finish: the
 * WALL_CLOCK_BUDGET below is the real governor, and a low cap here just turns a
 * backlog into a queue of nights. At 40 the 170-lead launch backlog would have
 * taken five days to clear.
 */
const BATCH_SIZE = 200;

/**
 * Stop here and leave the rest for tomorrow (or the next manual run). Under
 * maxDuration, so the run reports what it did instead of being killed with the
 * work half done and nothing written about it.
 */
const WALL_CLOCK_BUDGET_MS = 240_000;

/** How long a lead stays worth re-checking for a late-attached report. */
const NO_REPORT_RECHECK_DAYS = 30;

type Candidate = {
  id: string;
  monday_item_id: string;
  income_report_status: IncomeReportStatus;
  income_report_asset_id: string | null;
  /** What is stored today, so syncStoredReport knows what to remove (0092). */
  income_report_path: string | null;
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
 * IT ALSO KEEPS THE STORED PDF IN STEP (0092). Monday's public_url is signed
 * for an hour and is still never persisted, but the bytes behind it are: the
 * same download that yields the figures is uploaded to the lead-reports bucket,
 * so the report an operator opens is always the one this lead's figures were
 * read from. syncStoredReport owns that rule, including the one outcome
 * ('failed') where the right move is to touch nothing.
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

  const select =
    "id, monday_item_id, income_report_status, income_report_asset_id, income_report_path";

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

  // A lead parsed before 0092/0093 has its gross and neither the stored PDF nor
  // the presentation figures, and nothing above would ever look at it again —
  // the two queries above are about leads with NO figures. So this third pass
  // drains that gap and then costs nothing, which is why it is a pass here
  // rather than a one-off script: it needs no credentials, it repeats safely,
  // and it also picks up any lead whose upload failed transiently after a
  // successful parse.
  //
  // Newest first: an operator is far more likely to open a lead they were sent
  // this week than one from three months ago.
  const storageBackfill: Candidate[] = [];
  if (candidates.length < BATCH_SIZE) {
    const { data: unstoredRows, error: unstoredError } = await admin
      .from("leads")
      .select(select)
      .eq("lead_type", "management")
      .eq("income_report_status", "parsed")
      .not("income_report_asset_id", "is", null)
      // EITHER gap: no stored file, or none of the 0093 presentation figures.
      // Selecting on the path alone was a trap — a lead backfilled by an older
      // build would get its file, drop out of this query, and never pick the
      // figures up. platform_fee_pct is the sentinel because all 24 live
      // reports sampled state a "Platform Fees (n%)" line; one that genuinely
      // does not would be re-read nightly, which remaining_unbackfilled makes
      // visible rather than hiding.
      .or("income_report_path.is.null,platform_fee_pct.is.null")
      .order("created_at", { ascending: false })
      .limit(BATCH_SIZE - candidates.length);

    if (unstoredError) {
      console.error("parse-income-reports: unstored query failed", unstoredError);
    } else {
      storageBackfill.push(...((unstoredRows ?? []) as Candidate[]));
    }
  }

  if (dryRun) {
    return NextResponse.json({
      status: "ok",
      dryRun: true,
      scanned: candidates.length + storageBackfill.length,
      candidates: candidates.map((c) => ({
        lead_id: c.id,
        monday_item_id: c.monday_item_id,
        status: c.income_report_status,
      })),
      storage_backfill: storageBackfill.map((c) => c.id),
      remaining: await countOutstanding(admin),
      remaining_unstored: await countUnstored(admin),
    });
  }

  if (!candidates.length && !storageBackfill.length) {
    return NextResponse.json({
      status: "ok",
      scanned: 0,
      parsed: 0,
      no_report: 0,
      unparsed: 0,
      failed: 0,
      skipped: 0,
      stored: 0,
      remaining: 0,
      remaining_unstored: 0,
    });
  }

  let assets: Awaited<ReturnType<typeof fetchIncomeReportAssets>>;
  try {
    assets = await fetchIncomeReportAssets(
      [...candidates, ...storageBackfill].map((c) => c.monday_item_id)
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
    // One write for the figures and the stored file together (0092). A
    // 'failed' outcome returns an empty fragment, so a Monday or download
    // blip never deletes a report that is still perfectly good.
    const stored = await syncStoredReport({
      admin,
      leadId: lead.id,
      outcome,
      currentPath: lead.income_report_path,
    });
    const { error: writeError } = await admin
      .from("leads")
      .update({ ...incomeReportPatch(outcome), ...stored })
      .eq("id", lead.id);

    if (writeError) {
      // Leave the row where it was; it is still a candidate tomorrow.
      console.error("parse-income-reports: write failed", lead.id, writeError);
      counts.failed += 1;
      continue;
    }

    counts[outcome.status] += 1;
  }

  // ---------------------------------------------------------------------
  // The backfill pass.
  //
  // IT MAY ONLY ADD, and never writes a column that already has a value. These
  // leads already show a gross figure to customers, so re-running
  // incomeReportPatch over them would let a report that has since been moved or
  // deleted on Monday BLANK a working figure — trading something that works for
  // nothing, which is the one thing §25 says never to do. An outcome other than
  // 'parsed' therefore writes nothing at all and the row is simply looked at
  // again tomorrow.
  // ---------------------------------------------------------------------
  let stored = 0;
  let storageSkipped = 0;
  for (const lead of storageBackfill) {
    if (Date.now() - startedAt > WALL_CLOCK_BUDGET_MS) break;

    const asset = assets.get(lead.monday_item_id) ?? null;
    const outcome = await resolveIncomeReport(asset);
    if (outcome.status !== "parsed") {
      storageSkipped += 1;
      continue;
    }

    // presentationFiguresPatch, NOT incomeReportPatch: the five 0093 columns
    // and nothing else. The gross, rate and occupancy on these rows are already
    // right and customers can see them.
    const figures = presentationFiguresPatch(outcome);
    const storedPatch = await syncStoredReport({
      admin,
      leadId: lead.id,
      outcome,
      currentPath: lead.income_report_path,
    });

    // The two halves are written together but neither depends on the other. A
    // failed upload returns an empty patch, and the figures must not go down
    // with it — they are the more valuable half, and everything else here fails
    // alone. The row keeps a null path, so the upload is retried tomorrow.
    const patch = { ...figures, ...storedPatch };
    if (!Object.keys(patch).length) {
      storageSkipped += 1;
      continue;
    }

    const { error: storeError } = await admin
      .from("leads")
      .update(patch)
      .eq("id", lead.id);
    if (storeError) {
      console.error("parse-income-reports: backfill write failed", lead.id, storeError);
      storageSkipped += 1;
      continue;
    }
    if (storedPatch.income_report_path) stored += 1;
    else storageSkipped += 1;
  }

  return NextResponse.json({
    status: "ok",
    scanned: processed,
    parsed: counts.parsed,
    no_report: counts.no_report,
    unparsed: counts.unparsed,
    failed: counts.failed,
    skipped,
    stored,
    storage_skipped: storageSkipped,
    // Counted after the writes, so a caller can tell "the backlog is draining"
    // from "the backlog is stuck" — which the counts above cannot say on their
    // own, because a run of 40 failures and a run of 40 successes both report
    // scanned: 40. Reported separately per backlog, because they drain at
    // different rates and one being stuck says nothing about the other.
    remaining: await countOutstanding(admin),
    remaining_unstored: await countUnstored(admin),
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

/** Parsed management leads still missing their file or their 0093 figures. */
async function countUnstored(
  admin: ReturnType<typeof createAdminClient>
): Promise<number> {
  const { count } = await admin
    .from("leads")
    .select("id", { count: "exact", head: true })
    .eq("lead_type", "management")
    .eq("income_report_status", "parsed")
    .not("income_report_asset_id", "is", null)
    .or("income_report_path.is.null,platform_fee_pct.is.null");
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
