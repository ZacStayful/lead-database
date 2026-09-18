/**
 * Withdraw any lead that turns out to be in Stayful's own sales pipeline,
 * every fifteen minutes (§64).
 *
 * The monday-lead-sync shape: cron-secret OR admin session, a settings gate
 * whose failed read is a 500 ABOVE the kill switch (§18.3), a dry run an
 * admin may run with the switch off, maxDuration 60 — a five-minute-style
 * ceiling on a fifteen-minute schedule, bounded inside by the 45-second wall
 * clock in runStayfulConflictSweep.
 *
 * The "Check Stayful conflicts" button on /admin/leads posts here too; a
 * second admin-only handler would be a copy of this one.
 */

import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { isAdminUser } from "@/lib/auth";
import { resolveSettingsGate, type SettingsRow } from "@/lib/cron/settingsGate";
import { runStayfulConflictSweep } from "@/lib/stayfulConflictSweep";
import { STAYFUL_CONFLICT_SETTING } from "@/lib/stayfulConflictIndex";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const SETTING_KEYS = [STAYFUL_CONFLICT_SETTING];

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
  // NAME, so `not_configured` is the ordinary shape of a database where 0155
  // has not been applied and "off" is the right answer — but `read_failed` is
  // a 500, because a 200 carrying `skipped` is something nobody looks at again.
  if (!gate.ok && gate.reason === "read_failed") {
    console.error("[stayful-conflict] aborted — system_settings unreadable");
    return NextResponse.json({ ok: false, error: "settings_read_failed" }, { status: 500 });
  }
  const config = gate.ok ? gate.config : new Map<string, string>();

  // A dry run from an admin is allowed with the switch off: it is how the
  // first run is checked before anything is switched on.
  if (config.get(STAYFUL_CONFLICT_SETTING) !== "true" && !(dryRun && !viaCron)) {
    return NextResponse.json({ ok: true, skipped: "stayful_conflict_disabled" });
  }

  const result = await runStayfulConflictSweep(admin, { dryRun });
  if (!result.ok) {
    console.error("[stayful-conflict] run had errors", { errors: result.errors });
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
