/**
 * Pull NEW sellable leads off both Monday lead boards, every five minutes
 * (§63.1). The two 09:00 syncs stay as the backstop.
 *
 * ⚠️ maxDuration 60, NOT 300. A five-minute ceiling on a five-minute schedule
 * is one run deep at best and overlapping at worst; the 45-second wall clock
 * inside syncNewMondayLeads is what actually bounds a tick. The two daily
 * syncs use 300 because they are daily (§57's argument for the enquiry sync).
 *
 * Cost, measured while building this: one filtered page read is ~75–100
 * complexity against Monday's per-minute budget of millions; ~8,600 Vercel
 * invocations a month, pennies.
 */

import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { isAdminUser } from "@/lib/auth";
import { resolveSettingsGate, type SettingsRow } from "@/lib/cron/settingsGate";
import { syncNewMondayLeads } from "@/lib/leadSync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const SETTING_KEYS = ["lead_sync_enabled"];

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

  // ⚠️ A FAILED READ IS NOT A SWITCHED-OFF CRON (§18.3). The key is read BY
  // NAME, so `not_configured` is the ordinary shape of a database where 0154
  // has not been applied and "off" is the right answer — but `read_failed` is
  // a 500, because a 200 carrying `skipped` is something nobody looks at again.
  if (!gate.ok && gate.reason === "read_failed") {
    console.error("[lead-sync] aborted — system_settings unreadable");
    return NextResponse.json({ ok: false, error: "settings_read_failed" }, { status: 500 });
  }
  const config = gate.ok ? gate.config : new Map<string, string>();

  // A dry run from an admin is allowed with the switch off: it is how the
  // first run is checked before anything is switched on.
  if (config.get("lead_sync_enabled") !== "true" && !(dryRun && !viaCron)) {
    return NextResponse.json({ ok: true, skipped: "lead_sync_disabled" });
  }

  const result = await syncNewMondayLeads(admin, { dryRun });
  if (!result.ok) {
    console.error("[lead-sync] run failed", { errors: result.errors });
  } else if (result.errors.length > 0) {
    console.error("[lead-sync] a board could not be read", { errors: result.errors });
  }
  return NextResponse.json(result, { status: result.ok ? 200 : 500 });
}

export async function POST(request: NextRequest) {
  return handle(request);
}

// GET supports Vercel Cron, which issues a GET with the CRON_SECRET bearer.
export async function GET(request: NextRequest) {
  return handle(request);
}
