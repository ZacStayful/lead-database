import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isAdminUser } from "@/lib/auth";
import { resolveSettingsGate, type SettingsRow } from "@/lib/cron/settingsGate";
import { funnelEnabledFrom } from "@/lib/funnel/session";
import { issueFunnelDiscounts } from "@/lib/funnel/discount";
import { runFunnelMondayPasses } from "@/lib/funnel/mondayFunnelSync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * GET/POST /api/cron/funnel-discounts — every 15 minutes (batch 02 Phase 5).
 * Gives somebody who previewed in the funnel and has not paid an hour later
 * the 24-hour FOUNDING10 code (src/lib/funnel/discount.ts). The reminders cron
 * then delivers it.
 *
 * Runs only while `funnel_enabled` is on. ⚠️ A FAILED SETTINGS READ IS A 500,
 * never a quiet skip (§18.3). `?dryRun=true` from an admin lists who would get
 * a code, and works with the switch off.
 *
 * Batch 03 Phase 2 (§76): the Monday "Funnel started" and "Funnel finished,
 * not paid" passes run here too, ⚠️ BEFORE THE DISCOUNT PASS (E3). Both read
 * funnel_sessions.updated_at, and linking a code touches it, so the other order
 * would push "finished" back an hour. They also run before the coupon check:
 * they need no coupon, and a missing one must not stop the board updating.
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

  const dryRun = new URL(request.url).searchParams.get("dryRun") === "true";
  const admin = createAdminClient();

  const { data: rows, error } = await admin
    .from("system_settings")
    .select("key, value")
    .in("key", ["funnel_enabled"]);
  const gate = resolveSettingsGate(rows as SettingsRow[] | null, error);
  if (!gate.ok && gate.reason === "read_failed") {
    console.error("[funnel-discounts] aborted — system_settings unreadable");
    return NextResponse.json({ ok: false, error: "settings_read_failed" }, { status: 500 });
  }
  const enabled = gate.ok && funnelEnabledFrom(gate.config.get("funnel_enabled"));
  if (!enabled && !(dryRun && !viaCron)) {
    return NextResponse.json({ ok: true, skipped: "funnel_disabled" });
  }

  const monday = await runFunnelMondayPasses(admin, { dryRun });

  // No coupon, no codes: say so rather than failing every session in turn.
  if (!dryRun && !process.env.STRIPE_POST_CALL_COUPON_ID) {
    console.error("[funnel-discounts] STRIPE_POST_CALL_COUPON_ID is not set");
    return NextResponse.json({ ok: false, error: "coupon_not_configured", monday }, { status: 500 });
  }

  const result = await issueFunnelDiscounts(admin, { dryRun });
  return NextResponse.json({ ...result, monday }, { status: result.ok && monday.ok ? 200 : 500 });
}

export async function GET(request: NextRequest) {
  return handle(request);
}

export async function POST(request: NextRequest) {
  return handle(request);
}
