import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { NotificationPreferences } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The four notification streams a customer can opt in/out of. */
const PREFERENCE_KEYS: (keyof NotificationPreferences)[] = [
  "new_lead",
  "credit_warnings",
  "inactivity_nudge",
  "progress_report",
];

/** Full-true default — used to fill any key missing from a customer's jsonb. */
const DEFAULT_PREFERENCES: NotificationPreferences = {
  new_lead: true,
  credit_warnings: true,
  inactivity_nudge: true,
  progress_report: true,
};

/**
 * Update the authenticated customer's own notification_preferences.
 *
 * Accepts a PARTIAL update to the four boolean keys and merges it onto the
 * current stored value (itself merged onto an all-true default so a missing key
 * reads as true). Writes go through the service role after an auth + ownership
 * check, mirroring /api/customer/settings, so the column stays non-writable via
 * any browser RLS policy. Returns the full updated preferences object.
 */
export async function PATCH(request: NextRequest) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: Partial<Record<keyof NotificationPreferences, unknown>>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Collect only the recognised keys, and require each provided one to be a
  // boolean. Unknown keys are rejected rather than silently persisted.
  const patch: Partial<NotificationPreferences> = {};
  for (const key of Object.keys(body ?? {})) {
    if (!PREFERENCE_KEYS.includes(key as keyof NotificationPreferences)) {
      return NextResponse.json(
        { error: `Unknown preference: ${key}` },
        { status: 400 }
      );
    }
    const value = body[key as keyof NotificationPreferences];
    if (typeof value !== "boolean") {
      return NextResponse.json(
        { error: `${key} must be a boolean` },
        { status: 400 }
      );
    }
    patch[key as keyof NotificationPreferences] = value;
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json(
      { error: "No valid preferences provided" },
      { status: 400 }
    );
  }

  const admin = createAdminClient();

  // Read the current value so a partial update never drops the untouched keys.
  const { data: existing, error: readError } = await admin
    .from("customers")
    .select("notification_preferences")
    .eq("user_id", user.id)
    .maybeSingle();

  if (readError) {
    return NextResponse.json({ error: readError.message }, { status: 400 });
  }
  if (!existing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const merged: NotificationPreferences = {
    ...DEFAULT_PREFERENCES,
    ...(existing.notification_preferences as Partial<NotificationPreferences> | null),
    ...patch,
  };

  const { data, error } = await admin
    .from("customers")
    .update({ notification_preferences: merged })
    .eq("user_id", user.id)
    .select("notification_preferences")
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  if (!data) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({
    ok: true,
    notification_preferences: data.notification_preferences,
  });
}
