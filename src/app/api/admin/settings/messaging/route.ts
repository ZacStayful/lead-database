/**
 * The messaging switches (§40).
 *
 * Every one of these existed from the day its feature shipped and none of them
 * had a control — `messaging_sequences_enabled` in particular ships `false`,
 * which meant the only way to turn follow-up sequences on was to run SQL
 * against production. A kill switch nobody can reach is not a kill switch.
 *
 * Follows `settings/api-access` exactly: admin session, and UPSERT rather than
 * update, because an update against an unseeded key matches zero rows and still
 * reports success — the §16 trap.
 *
 * ⚠️ THE KEY COMES FROM THE ALLOW-LIST, NEVER FROM THE BODY. `system_settings`
 * also holds `escalation_enabled`, `pool_enabled`, `max_active_customers` and
 * the pool clocks; a route that writes whatever it is handed could stop lead
 * allocation for the entire platform from this screen. See adminSettings.ts.
 */
import { NextResponse, type NextRequest } from "next/server";
import { getUser, isAdminUser } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  MESSAGING_SETTINGS,
  coerceMessagingSetting,
  messagingSettingSpec,
  validateQuietWindow,
} from "@/lib/messaging/adminSettings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const user = await getUser();
  if (!isAdminUser(user)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: { settings?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const submitted = body.settings;
  if (!submitted || typeof submitted !== "object" || Array.isArray(submitted)) {
    return NextResponse.json(
      { error: "settings must be an object of key/value pairs" },
      { status: 400 }
    );
  }

  const rows: { key: string; value: string; updated_at: string }[] = [];
  const now = new Date().toISOString();

  for (const [key, raw] of Object.entries(submitted as Record<string, unknown>)) {
    if (!messagingSettingSpec(key)) {
      // Named explicitly rather than ignored. Silently dropping an unknown key
      // would let a typo look like a successful save.
      return NextResponse.json(
        { error: `That is not a messaging setting: ${key}`, code: "unknown_key" },
        { status: 400 }
      );
    }
    const verdict = coerceMessagingSetting(key, raw);
    if (!verdict.ok) {
      return NextResponse.json({ error: verdict.error }, { status: 400 });
    }
    rows.push({ key, value: verdict.value, updated_at: now });
  }

  if (rows.length === 0) {
    return NextResponse.json({ error: "Nothing to save." }, { status: 400 });
  }

  const admin = createAdminClient();

  // ⚠️ The quiet window is judged against what will be STORED, not against
  // what happens to be in this request. An admin moving only the start still
  // has to be checked against the end already in the database — otherwise
  // start=20 lands beside a stored end=20 and the window never opens again.
  const touchesWindow = rows.some(
    (r) =>
      r.key === "messaging_quiet_start_hour" || r.key === "messaging_quiet_end_hour"
  );
  if (touchesWindow) {
    const { data: current } = await admin
      .from("system_settings")
      .select("key, value")
      .in("key", ["messaging_quiet_start_hour", "messaging_quiet_end_hour"]);
    const stored = new Map(
      (current ?? []).map((r) => [(r as { key: string }).key, (r as { value: string }).value])
    );
    const pick = (key: string, fallback: number) => {
      const submittedRow = rows.find((r) => r.key === key);
      const value = submittedRow?.value ?? stored.get(key);
      const n = Number(value);
      return Number.isFinite(n) ? n : fallback;
    };
    const verdict = validateQuietWindow(
      pick("messaging_quiet_start_hour", 9),
      pick("messaging_quiet_end_hour", 20)
    );
    if (!verdict.ok) {
      return NextResponse.json({ error: verdict.error }, { status: 400 });
    }
  }

  const { error } = await admin
    .from("system_settings")
    .upsert(rows, { onConflict: "key" });

  if (error) {
    console.error("[admin] messaging settings upsert failed", error);
    return NextResponse.json({ error: "Could not save that setting" }, { status: 500 });
  }

  return NextResponse.json({ ok: true, saved: rows.map((r) => r.key) });
}

/** The current values, with every unseeded key reported as its fallback. */
export async function GET() {
  const user = await getUser();
  if (!isAdminUser(user)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const admin = createAdminClient();
  const { data } = await admin
    .from("system_settings")
    .select("key, value")
    .in("key", MESSAGING_SETTINGS.map((s) => s.key));

  const stored = new Map(
    (data ?? []).map((r) => [(r as { key: string }).key, (r as { value: string }).value])
  );

  return NextResponse.json({
    settings: Object.fromEntries(
      MESSAGING_SETTINGS.map((s) => [s.key, stored.get(s.key) ?? s.fallback])
    ),
  });
}
