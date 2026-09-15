/**
 * Pull new Monday enquiries-board items into the lead database (§57).
 *
 * Facebook lead ads write into board 18420649520, group "New enquiries". This
 * reads that group every minute and turns anything new into an enquiry —
 * identical in every respect to a website submission, so the §55 booking chase
 * picks it up and sends the WhatsApp.
 *
 * ⚠️ maxDuration 60, NOT 300. It fires every minute, and a five-minute ceiling
 * on a one-minute schedule is five runs deep. §55 makes the same call for
 * prospect-nudges; the two Monday LEAD syncs use 300 because they are daily.
 *
 * Cost, measured rather than assumed: one filtered board read is 92 complexity
 * against Monday's 20,000,000-per-minute budget.
 */

import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { isAdminUser } from "@/lib/auth";
import { resolveSettingsGate, type SettingsRow } from "@/lib/cron/settingsGate";
import { syncMondayEnquiries } from "@/lib/enquiry/syncMondayEnquiries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const SETTING_KEYS = ["enquiry_sync_enabled", "enquiry_sync_from"];

async function handle(request: NextRequest) {
  const auth = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  // Boolean() matters: it fails closed when the var is unset (§2).
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

  const url = new URL(request.url);
  const dryRun = url.searchParams.get("dryRun") === "true";

  const admin = createAdminClient();

  const { data: rows, error } = await admin
    .from("system_settings")
    .select("key, value")
    .in("key", SETTING_KEYS);

  const gate = resolveSettingsGate(rows as SettingsRow[] | null, error);

  // ⚠️ A FAILED READ IS NOT A SWITCHED-OFF CRON (§18.3). It selects keys BY
  // NAME, so `not_configured` is the ordinary shape of a database where 0151
  // has not been applied and "off" is the right answer — but `read_failed` is
  // a 500, because a 200 carrying `skipped` is something nobody looks at again.
  if (!gate.ok && gate.reason === "read_failed") {
    console.error("[enquiry-sync] aborted — system_settings unreadable");
    return NextResponse.json({ ok: false, error: "settings_read_failed" }, { status: 500 });
  }
  const config = gate.ok ? gate.config : new Map<string, string>();

  if (config.get("enquiry_sync_enabled") !== "true") {
    return NextResponse.json({ ok: true, skipped: "enquiry_sync_disabled" });
  }

  // ⚠️ THE CUTOFF FAILS CLOSED. Absent, blank or unparseable means ingest
  // NOTHING, never "ingest everything" — §42.9's contact_notify_from rule.
  // Refusing loudly rather than running with no cutoff is what stops a bad
  // value enrolling the whole back catalogue.
  const rawCutoff = config.get("enquiry_sync_from") ?? "";
  const parsed = rawCutoff ? new Date(rawCutoff) : null;
  const cutoff = parsed && !Number.isNaN(parsed.getTime()) ? parsed : null;
  if (!cutoff) {
    console.error("[enquiry-sync] aborted — enquiry_sync_from is missing or unparseable");
    return NextResponse.json({ ok: false, error: "cutoff_unreadable" }, { status: 500 });
  }

  // ⚠️ DRY RUN ONLY. The cutoff is seeded at apply time, so every item already
  // on the board is pre-cutoff and a plain dry run can only ever report
  // "nothing to do" — which proves nothing about the classifier. This is what
  // makes a real pre-launch acceptance test possible. It must never widen what
  // an actual run ingests.
  let since: Date | null = null;
  const rawSince = url.searchParams.get("since");
  if (rawSince) {
    if (!dryRun) {
      return NextResponse.json(
        { ok: false, error: "since_requires_dry_run" },
        { status: 400 }
      );
    }
    const candidate = new Date(rawSince);
    if (Number.isNaN(candidate.getTime())) {
      return NextResponse.json({ ok: false, error: "since_unparseable" }, { status: 400 });
    }
    since = candidate;
  }

  try {
    const result = await syncMondayEnquiries(admin, cutoff, { dryRun, since });
    return NextResponse.json(result, { status: result.ok ? 200 : 500 });
  } catch (err) {
    console.error("[enquiry-sync] run failed", err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "sync failed" },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  return handle(request);
}

// Vercel Cron issues a GET.
export async function GET(request: NextRequest) {
  return handle(request);
}
