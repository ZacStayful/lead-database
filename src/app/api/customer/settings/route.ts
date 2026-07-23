import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Update the authenticated customer's own notification preferences.
 * Currently: sms_alerts_enabled (opt in/out of the instant new-lead SMS).
 * Writes go through the service role after an auth + ownership check, so the
 * column stays non-writable via any browser RLS policy.
 */
export async function PATCH(request: NextRequest) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { sms_alerts_enabled?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (typeof body.sms_alerts_enabled !== "boolean") {
    return NextResponse.json(
      { error: "sms_alerts_enabled must be a boolean" },
      { status: 400 }
    );
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("customers")
    .update({ sms_alerts_enabled: body.sms_alerts_enabled })
    .eq("user_id", user.id)
    .select("id, sms_alerts_enabled")
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  if (!data) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({ ok: true, sms_alerts_enabled: data.sms_alerts_enabled });
}
