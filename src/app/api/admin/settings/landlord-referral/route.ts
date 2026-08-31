/**
 * The landlord referral kill switch (§41).
 *
 * ⚠️ ITS OWN ROUTE AND ITS OWN KEY, NOT A WIDENING OF THE MESSAGING ALLOW-LIST.
 * The house pattern is a route per feature — api-access carries one key inline,
 * capacity resolves through capacitySettingKey(), escalation has its own
 * EDITABLE map. This is §41, downstream of completeAssignment, not §40
 * messaging: adding it to MESSAGING_SETTINGS would give it an error message
 * reading "That is not a messaging setting" for a key that genuinely is not
 * one, and four literal lists to keep in step.
 *
 * ⚠️ THE KEY IS A CONSTANT HERE, NEVER TAKEN FROM THE BODY. `system_settings`
 * also holds escalation_enabled, pool_enabled and max_active_customers; a route
 * that upserts whatever key it is handed can stop lead allocation for the whole
 * platform. §16 set that rule for the capacity route and it holds for every
 * settings route since.
 */
import { NextResponse, type NextRequest } from "next/server";
import { getUser, isAdminUser } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const KEY = "landlord_referral_enabled";

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

  // Strict. `Number(true)` is 1 and `Number(null)` is 0, so a loose check is
  // how a boolean setting quietly stores something that is not one — the bug
  // §40.14 records finding in the messaging settings route.
  if (typeof body.enabled !== "boolean") {
    return NextResponse.json({ error: "enabled must be a boolean" }, { status: 400 });
  }

  const admin = createAdminClient();
  // Upsert, not update: an update against an unseeded key matches zero rows and
  // still reports success (§16).
  const { error } = await admin
    .from("system_settings")
    .upsert(
      { key: KEY, value: body.enabled ? "true" : "false", updated_at: new Date().toISOString() },
      { onConflict: "key" }
    );

  if (error) {
    console.error("[settings/landlord-referral] save failed", error);
    return NextResponse.json({ error: "Could not save that setting." }, { status: 500 });
  }

  return NextResponse.json({ ok: true, enabled: body.enabled });
}
