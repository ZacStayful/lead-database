/**
 * The API kill switch.
 *
 * Turns /api/v1 and /api/mcp off for everybody without a deploy — the control
 * that matters when a key has leaked or an integration is looping at 2am.
 * Follows pool_enabled and escalation_enabled: a system_settings row, upserted
 * because an update against an unseeded key matches zero rows and still reports
 * success.
 *
 * It deliberately does NOT disable the customer key-management routes, so a
 * customer can still revoke their own key while the surface is off.
 *
 * Takes up to KILL_SWITCH_CACHE_MS to be observed, because the resolver caches
 * the setting rather than reading it on every request.
 */
import { NextResponse, type NextRequest } from "next/server";
import { getUser, isAdminUser } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const user = await getUser();
  if (!isAdminUser(user)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: { enabled?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (typeof body.enabled !== "boolean") {
    return NextResponse.json({ error: "enabled must be a boolean" }, { status: 400 });
  }

  const admin = createAdminClient();
  const { error } = await admin
    .from("system_settings")
    .upsert(
      { key: "api_enabled", value: body.enabled ? "true" : "false", updated_at: new Date().toISOString() },
      { onConflict: "key" }
    );

  if (error) {
    console.error("[admin] api_enabled upsert failed", error);
    return NextResponse.json({ error: "Could not save that setting" }, { status: 500 });
  }

  return NextResponse.json({ ok: true, enabled: body.enabled });
}
