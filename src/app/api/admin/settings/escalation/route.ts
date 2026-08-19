import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isAdminUser } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The escalation settings an admin may change, and nothing else.
 *
 * An allowlist rather than "any key in the body" for the same reason
 * /api/admin/settings/capacity resolves its key through a helper: system_settings
 * also holds reclaim_enabled_from and telemetry_from, which are stamped once at
 * migration time and would silently change the meaning of historical data if a
 * request could name them. telemetry_from is now doubly load-bearing — 0089
 * floors the recycled-supply rate on it — so it must stay unreachable from here.
 *
 * The two score thresholds were dropped in 0089: escalation no longer scores
 * anything, it asks whether the lead was opened. Their rows are left in
 * system_settings, but nothing reads them and nothing may write them.
 */
const EDITABLE = {
  escalation_enabled: "boolean",
  escalation_max_lead_age_days: "nullable_int",
} as const;

type Key = keyof typeof EDITABLE;

async function isAdminRequest(req: NextRequest): Promise<boolean> {
  const key = req.headers.get("x-admin-key");
  if (key && process.env.ADMIN_SECRET_KEY && key === process.env.ADMIN_SECRET_KEY) {
    return true;
  }
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return isAdminUser(user);
}

/** Validate and normalise a value for its key, or return an error message. */
function normalise(key: Key, raw: unknown): { value: string } | { error: string } {
  switch (EDITABLE[key]) {
    case "boolean":
      if (typeof raw !== "boolean") return { error: `${key} must be true or false` };
      return { value: raw ? "true" : "false" };

    case "nullable_int": {
      // Empty string is the "not configured" state, and is meaningfully
      // different from zero: unset means the gate does not apply, zero would
      // mean every lead is too old to escalate. The column is NOT NULL, so the
      // absence has to be encoded as a value.
      if (raw === null || raw === "") return { value: "" };
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1) {
        return { error: `${key} must be a whole number of days above zero, or empty` };
      }
      return { value: String(n) };
    }
  }
}

/** Update one or more escalation settings. */
export async function POST(req: NextRequest) {
  if (!(await isAdminRequest(req))) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const rows: { key: string; value: string; updated_at: string }[] = [];
  const now = new Date().toISOString();

  for (const [key, raw] of Object.entries(body)) {
    if (!(key in EDITABLE)) {
      return NextResponse.json({ error: `Unknown setting: ${key}` }, { status: 400 });
    }
    const result = normalise(key as Key, raw);
    if ("error" in result) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }
    rows.push({ key, value: result.value, updated_at: now });
  }

  if (rows.length === 0) {
    return NextResponse.json({ error: "No settings supplied" }, { status: 400 });
  }

  // Upsert, not update: an update against a key the migration has not seeded
  // matches zero rows and still reports success, which is how a setting silently
  // fails to save (see the note on /api/admin/settings/capacity).
  const admin = createAdminClient();
  const { error } = await admin.from("system_settings").upsert(rows, {
    onConflict: "key",
  });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, updated: rows.map((r) => r.key) });
}
