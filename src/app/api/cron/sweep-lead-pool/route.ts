import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isAdminUser } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type EntryCandidate = {
  lead_id: string;
  lead_type: string;
  basis: string;
  last_activity_at: string;
  days_quiet: number;
  assignment_count: number;
};

type ExitCandidate = {
  lead_id: string;
  lead_type: string;
  reason: string;
};

/**
 * Daily: move leads into and out of the expired leads pool.
 *
 * Three transitions, all of them in sweep_lead_pool() (0073) so the ordering
 * argument lives with the SQL rather than being reconstructed here:
 *   enter   — quiet for pool_entry_days with nothing barring it
 *   exit    — engaged with since entry, or (unassigned basis) since allocated
 *   expire  — pool_life_days past its FIRST entry
 *
 * Auth mirrors /api/cron/escalate-leads: Bearer $CRON_SECRET, or an admin
 * session. ?dryRun=true reports what would move and writes nothing.
 *
 * SCHEDULED AT 10:30. Deliberately between the 09:00 Monday syncs and the 11:00
 * escalation run. Ingest first, so a lead arriving today is in the table before
 * anything reasons about it; the pool sweep next, so escalation sees today's
 * pool state and skips leads that have just passed to it (get_escalation_
 * candidates excludes pool_entered_at). Running after escalation would let both
 * ladders act on the same lead on the same day.
 *
 * Unlike the engagement and capacity snapshots (0064/0072), this IS backfillable
 * — every transition is derived from timestamps that are still there tomorrow —
 * so a missed day costs a day of pool latency and nothing else.
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

  // Kill switch. Checked explicitly and reported as "skipped" rather than
  // returning a successful run that happened to do nothing — the distinction
  // 0062 exists to preserve.
  //
  // A DRY RUN IS NOT BLOCKED BY IT. The switch exists so the first sweep can be
  // run under supervision instead of arriving overnight, and the first thing
  // anyone in that position wants is to see what it would do. Refusing the
  // preview while the switch is off would make the switch impossible to turn on
  // with any confidence. A dry run writes nothing, so there is nothing for the
  // kill switch to protect against.
  const { data: settingRow } = await admin
    .from("system_settings")
    .select("value")
    .eq("key", "pool_enabled")
    .maybeSingle();

  const enabled = (settingRow?.value ?? "true").trim() === "true";
  if (!enabled && !dryRun) {
    return NextResponse.json({
      status: "skipped",
      reason: "pool_enabled is not true",
    });
  }

  // Read the pending transitions before acting. On a real run this is the
  // record of what the sweep did — the functions are evaluated against live
  // state, so asking afterwards would return an empty list either way.
  const [entryRes, exitRes] = await Promise.all([
    admin.rpc("get_pool_entry_candidates"),
    admin.rpc("get_pool_exit_candidates"),
  ]);

  if (entryRes.error || exitRes.error) {
    return NextResponse.json(
      { error: (entryRes.error ?? exitRes.error)?.message },
      { status: 500 }
    );
  }

  const entries = (entryRes.data ?? []) as EntryCandidate[];
  const exits = (exitRes.data ?? []) as ExitCandidate[];

  const summarise = (rows: { lead_type: string }[]) => ({
    management: rows.filter((r) => r.lead_type === "management").length,
    guaranteed_rent: rows.filter((r) => r.lead_type === "guaranteed_rent").length,
  });

  if (dryRun) {
    return NextResponse.json({
      status: "dry_run",
      // Surfaced so a preview run cannot be mistaken for proof the job is armed.
      pool_enabled: enabled,
      would_enter: summarise(entries),
      would_enter_by_basis: {
        unassigned: entries.filter((e) => e.basis === "unassigned").length,
        ignored: entries.filter((e) => e.basis === "ignored").length,
      },
      would_exit: summarise(exits),
      would_exit_by_reason: {
        engaged: exits.filter((e) => e.reason === "engaged").length,
        allocated: exits.filter((e) => e.reason === "allocated").length,
        barred: exits.filter((e) => e.reason === "barred").length,
      },
    });
  }

  const { data: swept, error: sweepError } = await admin.rpc("sweep_lead_pool");
  if (sweepError) {
    return NextResponse.json({ error: sweepError.message }, { status: 500 });
  }

  const result = (Array.isArray(swept) ? swept[0] : swept) as
    | { entered: number; exited: number; expired: number }
    | undefined;

  // Public-API housekeeping, riding on the one daily job that already runs.
  //
  // Rate-limit windows are rolled into the per-day usage totals BEFORE they are
  // discarded, so the settings panel and /admin/api keep a month of history
  // without anything having to be counted on the request path. Deliberately
  // after the dry-run and kill-switch branches above: a preview run writes
  // nothing, and a disabled pool should not quietly do database work.
  const apiHousekeeping = await sweepApiTables(admin);

  return NextResponse.json({
    status: "ok",
    entered: result?.entered ?? 0,
    exited: result?.exited ?? 0,
    expired: result?.expired ?? 0,
    entered_by_product: summarise(entries),
    entered_by_basis: {
      unassigned: entries.filter((e) => e.basis === "unassigned").length,
      ignored: entries.filter((e) => e.basis === "ignored").length,
    },
    exited_by_reason: {
      engaged: exits.filter((e) => e.reason === "engaged").length,
      allocated: exits.filter((e) => e.reason === "allocated").length,
      barred: exits.filter((e) => e.reason === "barred").length,
    },
    api_usage_rolled_up: apiHousekeeping.rolledUp,
    api_windows_deleted: apiHousekeeping.windowsDeleted,
    api_log_rows_deleted: apiHousekeeping.logRowsDeleted,
  });
}

/**
 * Fold expiring rate-limit windows into api_usage_daily, then discard them, and
 * drop request-log rows older than 30 days.
 *
 * Best-effort: a failure here is a reporting gap, and must never fail the pool
 * sweep, which is the part of this job that actually moves leads.
 */
async function sweepApiTables(
  admin: ReturnType<typeof createAdminClient>
): Promise<{ rolledUp: number; windowsDeleted: number; logRowsDeleted: number }> {
  const out = { rolledUp: 0, windowsDeleted: 0, logRowsDeleted: 0 };
  const cutoff = new Date(Date.now() - 86_400_000).toISOString();
  const logCutoff = new Date(Date.now() - 30 * 86_400_000).toISOString();

  try {
    const { data: expiring } = await admin
      .from("api_rate_limits")
      .select("subject_id, window_start, request_count")
      .eq("subject_kind", "key")
      .lt("window_start", cutoff);

    const rows = (expiring ?? []) as {
      subject_id: string;
      window_start: string;
      request_count: number;
    }[];

    // Sum per key per day before writing, so one upsert covers a whole day
    // rather than 1,440 of them.
    const totals = new Map<string, number>();
    for (const r of rows) {
      const day = r.window_start.slice(0, 10);
      const k = `${r.subject_id}|${day}`;
      totals.set(k, (totals.get(k) ?? 0) + r.request_count);
    }

    const entries = Array.from(totals.entries());
    for (const [k, count] of entries) {
      const [keyId, day] = k.split("|");
      const { data: existing } = await admin
        .from("api_usage_daily")
        .select("request_count")
        .eq("key_id", keyId)
        .eq("day", day)
        .maybeSingle();

      const { error } = await admin.from("api_usage_daily").upsert(
        {
          key_id: keyId,
          day,
          request_count:
            ((existing as { request_count?: number } | null)?.request_count ?? 0) + count,
        },
        { onConflict: "key_id,day" }
      );
      if (!error) out.rolledUp += 1;
    }

    const { count: deleted } = await admin
      .from("api_rate_limits")
      .delete({ count: "exact" })
      .lt("window_start", cutoff);
    out.windowsDeleted = deleted ?? 0;

    const { count: logDeleted } = await admin
      .from("api_request_log")
      .delete({ count: "exact" })
      .lt("created_at", logCutoff);
    out.logRowsDeleted = logDeleted ?? 0;
  } catch (err) {
    console.error("[sweep] api housekeeping failed", err);
  }

  return out;
}

// Vercel Cron issues a GET; POST is here so the job can be triggered by hand
// from admin exactly as the other crons can.
export async function GET(request: NextRequest) {
  return handle(request);
}

export async function POST(request: NextRequest) {
  return handle(request);
}
