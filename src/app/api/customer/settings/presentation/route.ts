import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  DEFAULT_PRESENTATION_SETTINGS,
  validatePresentationSettings,
} from "@/lib/presentationSettings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The authenticated customer's presentation profile (0093) — their fee,
 * contract terms and process, applied to every lead's presentation.
 *
 * Set once. This is the half of the income presentation that is the same on
 * every lead, and the reason the tool's setup screen collapses to a
 * confirmation once a lead has seeded it: the property's figures come from the
 * report and everything else comes from here.
 *
 * WHOLE-OBJECT PUT, not a partial patch like the notification route. That one
 * merges boolean flags where a missing key is meaningful; here a missing
 * `managed` list means "I list nothing", which a merge would quietly refill
 * with ours. The form always sends the complete profile.
 *
 * Auth on the session client, write on the service role — `customers` has a
 * single SELECT policy and no write policy, and this does not add one
 * (invariant 7).
 */
export async function GET() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();
  const { data: customer } = await admin
    .from("customers")
    .select("presentation_settings, presentation_settings_updated_at")
    .eq("user_id", user.id)
    .maybeSingle();

  if (!customer) {
    return NextResponse.json({ error: "Customer not found" }, { status: 404 });
  }

  const row = customer as {
    presentation_settings: unknown;
    presentation_settings_updated_at: string | null;
  };

  return NextResponse.json({
    settings: validatePresentationSettings(row.presentation_settings),
    // NULL means never set, which is what the dashboard and the tool prompt on.
    // Deliberately not derived from the blob being empty: a profile saved as
    // the defaults on purpose IS configured, and testing the contents would
    // nag that customer for ever (§26).
    configured: row.presentation_settings_updated_at != null,
    updatedAt: row.presentation_settings_updated_at,
    defaults: DEFAULT_PRESENTATION_SETTINGS,
  });
}

export async function PUT(request: NextRequest) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Coerced rather than rejected: every field falls back to the default it
  // could not be read as, so a malformed save degrades to generic wording
  // instead of 400-ing at an operator with a landlord waiting.
  const settings = validatePresentationSettings(
    (body as { settings?: unknown })?.settings ?? body
  );

  const admin = createAdminClient();
  const updatedAt = new Date().toISOString();
  const { data, error } = await admin
    .from("customers")
    .update({
      presentation_settings: settings,
      presentation_settings_updated_at: updatedAt,
    })
    .eq("user_id", user.id)
    .select("id")
    .maybeSingle();

  if (error) {
    console.error("presentation settings: write failed", user.id, error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json({ error: "Customer not found" }, { status: 404 });
  }

  return NextResponse.json({ settings, configured: true, updatedAt });
}
